#!/usr/bin/env node
/**
 * Redo cinematic video clips by resetting them to 'pending'.
 *
 * Usage:
 *   node scripts/redo-cinematic-clips.js ch6_sc6_c1           — reset a single clip
 *   node scripts/redo-cinematic-clips.js ch6_sc6_c1,ch5_sc3_c3 — reset multiple clips
 *   node scripts/redo-cinematic-clips.js all-failed            — reset only failed clips
 *   node scripts/redo-cinematic-clips.js list                  — list all cinematic clips
 *
 * This script:
 * 1. Opens the SQLite database from the Electron userData path
 * 2. Resets targeted video_clip_cinematic assets to 'pending'
 * 3. Clears file_path, model_used, source_gen_id, cdn_url
 * 4. Deletes the corresponding .mp4 files from disk
 * 5. Sets the project stage to 'scenes-done' so the pipeline re-enters video gen
 *
 * The app must be CLOSED before running this script.
 * After running, reopen the app and click Resume — it will regenerate only the
 * reset clips and skip all others that are still 'done'.
 *
 * SAFETY: Only operates on assets with type='video_clip_cinematic'.
 * Does NOT touch scene images, portraits, grids, or non-cinematic clips.
 */

const path = require('path');
const fs = require('fs');

const ARG = process.argv[2];

if (!ARG) {
  console.log(`
Usage:
  node scripts/redo-cinematic-clips.js <clip_ids>   Reset specific clips by kling_clip_id
  node scripts/redo-cinematic-clips.js all-failed   Reset only failed cinematic clips
  node scripts/redo-cinematic-clips.js list          List all cinematic clip assets

Examples:
  node scripts/redo-cinematic-clips.js ch6_sc6_c1
  node scripts/redo-cinematic-clips.js ch6_sc6_c1,ch5_sc3_c3
  node scripts/redo-cinematic-clips.js all-failed
`);
  process.exit(0);
}

async function main() {
  const initSqlJs = require('sql.js');

  // Electron userData path — Windows: %APPDATA%/nollywood-ai-pipeline
  const appName = 'nollywood-ai-pipeline';
  const appData = process.env.APPDATA || path.join(require('os').homedir(), 'AppData', 'Roaming');
  const dbPath = path.join(appData, appName, 'nollywood-pipeline.sqlite');

  if (!fs.existsSync(dbPath)) {
    console.error(`Database not found at: ${dbPath}`);
    console.error('Make sure the app has been run at least once.');
    process.exit(1);
  }

  const SQL = await initSqlJs();
  const buffer = fs.readFileSync(dbPath);
  const db = new SQL.Database(buffer);

  // Get all cinematic video clip assets
  const allClips = db.exec(`
    SELECT id, kling_clip_id, status, file_path, model_used, cdn_url, error_message
    FROM project_assets
    WHERE type = 'video_clip_cinematic'
    ORDER BY kling_clip_id
  `);

  if (!allClips[0] || allClips[0].values.length === 0) {
    console.log('No cinematic video clip assets found in the database.');
    db.close();
    return;
  }

  const clips = allClips[0].values.map(row => ({
    id: row[0],
    kling_clip_id: row[1],
    status: row[2],
    file_path: row[3],
    model_used: row[4],
    cdn_url: row[5],
    error_message: row[6],
  }));

  // ── LIST mode ──
  if (ARG === 'list') {
    console.log(`\nCinematic video clips (${clips.length} total):\n`);
    console.log('  Clip ID            Status      File                              CDN');
    console.log('  ─────────────────  ──────────  ────────────────────────────────  ───');
    for (const c of clips) {
      const file = c.file_path ? path.basename(c.file_path) : '—';
      const cdn = c.cdn_url ? 'yes' : '—';
      const err = c.error_message ? ` (${c.error_message.substring(0, 30)})` : '';
      console.log(`  ${(c.kling_clip_id || '?').padEnd(17)}  ${c.status.padEnd(10)}  ${file.padEnd(32)}  ${cdn}${err}`);
    }
    const doneCount = clips.filter(c => c.status === 'done').length;
    const failedCount = clips.filter(c => c.status === 'failed').length;
    const pendingCount = clips.filter(c => c.status === 'pending').length;
    const genCount = clips.filter(c => c.status === 'generating').length;
    console.log(`\n  Summary: ${doneCount} done, ${failedCount} failed, ${pendingCount} pending, ${genCount} generating\n`);
    db.close();
    return;
  }

  // ── Determine which clips to redo ──
  let targetClips;
  if (ARG === 'all-failed') {
    targetClips = clips.filter(c => c.status === 'failed');
    if (targetClips.length === 0) {
      console.log('No failed cinematic clips to redo.');
      db.close();
      return;
    }
    console.log(`Resetting ${targetClips.length} failed cinematic clips...`);
  } else {
    // Parse comma-separated clip IDs
    const targetIds = ARG.split(',').map(s => s.trim().toLowerCase());
    targetClips = clips.filter(c => targetIds.includes((c.kling_clip_id || '').toLowerCase()));

    // Warn about any IDs not found
    const foundIds = new Set(targetClips.map(c => (c.kling_clip_id || '').toLowerCase()));
    const missing = targetIds.filter(id => !foundIds.has(id));
    if (missing.length > 0) {
      console.warn(`WARNING: clip(s) not found in DB: ${missing.join(', ')}`);
    }

    if (targetClips.length === 0) {
      console.log(`No cinematic clips found matching: ${ARG}`);
      console.log('Use "list" to see available clip IDs.');
      db.close();
      return;
    }

    // Safety confirmation for >1 clip
    console.log(`\nAbout to reset ${targetClips.length} cinematic clip(s):`);
    for (const c of targetClips) {
      console.log(`  ${c.kling_clip_id} (status: ${c.status}, file: ${c.file_path ? path.basename(c.file_path) : 'none'})`);
    }
    console.log('');
  }

  // ── Reset each clip ──
  let filesDeleted = 0;
  for (const clip of targetClips) {
    // Reset DB row
    db.run(`
      UPDATE project_assets
      SET status = 'pending',
          file_path = NULL,
          model_used = NULL,
          source_gen_id = NULL,
          cdn_url = NULL,
          completed_at = NULL,
          error_message = NULL,
          retry_count = 0
      WHERE id = ?
    `, [clip.id]);

    // Delete file from disk
    if (clip.file_path && fs.existsSync(clip.file_path)) {
      fs.unlinkSync(clip.file_path);
      filesDeleted++;
      console.log(`  ✓ Reset + deleted: ${clip.kling_clip_id} (${path.basename(clip.file_path)})`);
    } else {
      console.log(`  ✓ Reset: ${clip.kling_clip_id} (no file on disk)`);
    }
  }

  // ── Set project stage back to scenes-done ──
  const projectRow = db.exec('SELECT id FROM projects WHERE completed_at IS NULL ORDER BY created_at DESC LIMIT 1');
  if (projectRow[0] && projectRow[0].values[0]) {
    const projectId = projectRow[0].values[0][0];
    db.run(`UPDATE projects SET stage = 'scenes-done', updated_at = datetime('now') WHERE id = ?`, [projectId]);
    console.log(`\nProject stage set to 'scenes-done' (project: ${projectId})`);
  }

  // Save
  const data = db.export();
  const dbBuffer = Buffer.from(data);
  fs.writeFileSync(dbPath, dbBuffer);
  db.close();

  console.log(`\nDone! ${targetClips.length} clip(s) reset, ${filesDeleted} file(s) deleted.`);
  console.log('Close the app if open, then relaunch — it will regenerate only the reset clips.');
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
