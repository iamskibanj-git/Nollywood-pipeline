#!/usr/bin/env node
/**
 * Redo video clips by resetting them to 'pending'.
 *
 * Usage:
 *   node scripts/redo-videos.js all            — reset ALL video clips
 *   node scripts/redo-videos.js all-failed     — reset only failed video clips
 *   node scripts/redo-videos.js 2,5,14         — reset specific line numbers
 *   node scripts/redo-videos.js 2-5            — reset a range of lines
 *   node scripts/redo-videos.js list           — list all video clip assets and status
 *
 * This script:
 * 1. Opens the SQLite database from the Electron userData path
 * 2. Resets targeted video_clip assets to 'pending'
 * 3. Clears file_path, model_used, source_gen_id, cdn_url
 * 4. Deletes the corresponding .mp4 files from disk
 * 5. Sets the project stage to 'scenes-done' so the pipeline re-enters video gen
 *
 * The app must be CLOSED before running this script.
 * After running, reopen the app and click Resume — it will regenerate only the
 * reset clips and skip all others that are still 'done'.
 */

const path = require('path');
const fs = require('fs');

const ARG = process.argv[2];

if (!ARG) {
  console.log(`
Usage:
  node scripts/redo-videos.js <lines>        Redo specific video clips by line number
  node scripts/redo-videos.js all            Redo ALL video clips
  node scripts/redo-videos.js all-failed     Redo only failed video clips
  node scripts/redo-videos.js list           List all video clip assets

Examples:
  node scripts/redo-videos.js all            Reset all clips, start video gen fresh
  node scripts/redo-videos.js all-failed     Redo only failed clips
  node scripts/redo-videos.js 2,5,14         Lines 2, 5, 14
  node scripts/redo-videos.js 2-5            Lines 2 through 5
`);
  process.exit(0);
}

function parseLineSpec(spec) {
  const lines = new Set();
  for (const part of spec.split(',')) {
    const trimmed = part.trim();
    if (trimmed.includes('-')) {
      const [startStr, endStr] = trimmed.split('-');
      const start = parseInt(startStr, 10);
      const end = parseInt(endStr, 10);
      if (isNaN(start) || isNaN(end) || start > end) {
        console.error(`Invalid range: "${trimmed}"`);
        process.exit(1);
      }
      for (let i = start; i <= end; i++) lines.add(i);
    } else {
      const num = parseInt(trimmed, 10);
      if (isNaN(num)) {
        console.error(`Invalid line number: "${trimmed}"`);
        process.exit(1);
      }
      lines.add(num);
    }
  }
  return Array.from(lines).sort((a, b) => a - b);
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

  // Get all video_clip assets
  const allClips = db.exec(`
    SELECT id, chapter, line, status, file_path, prompt_used, model_used, cdn_url, error_message
    FROM project_assets
    WHERE type = 'video_clip'
    ORDER BY chapter, line
  `);

  if (!allClips[0] || allClips[0].values.length === 0) {
    console.log('No video clip assets found in the database.');
    db.close();
    return;
  }

  const clips = allClips[0].values.map(row => ({
    id: row[0],
    chapter: row[1],
    line: row[2],
    status: row[3],
    file_path: row[4],
    prompt_used: row[5],
    model_used: row[6],
    cdn_url: row[7],
    error_message: row[8],
  }));

  // ── LIST mode ──
  if (ARG === 'list') {
    console.log(`\nVideo clip assets (${clips.length} total):\n`);
    console.log('  Line  Ch  Status      File                      CDN URL');
    console.log('  ────  ──  ──────────  ────────────────────────  ───────');
    for (const c of clips) {
      const file = c.file_path ? path.basename(c.file_path) : '—';
      const cdn = c.cdn_url ? 'yes' : '—';
      const err = c.error_message ? ` (${c.error_message.substring(0, 40)})` : '';
      console.log(`  ${String(c.line).padStart(4)}  ${String(c.chapter).padStart(2)}  ${c.status.padEnd(10)}  ${file.padEnd(24)}  ${cdn}${err}`);
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
  if (ARG === 'all') {
    targetClips = clips;
    console.log(`Resetting ALL ${targetClips.length} video clips...`);
  } else if (ARG === 'all-failed') {
    targetClips = clips.filter(c => c.status === 'failed');
    if (targetClips.length === 0) {
      console.log('No failed video clips to redo.');
      db.close();
      return;
    }
    console.log(`Resetting ${targetClips.length} failed video clips...`);
  } else {
    const targetLines = parseLineSpec(ARG);
    targetClips = clips.filter(c => targetLines.includes(c.line));
    if (targetClips.length === 0) {
      console.log(`No video clips found matching lines: ${targetLines.join(', ')}`);
      db.close();
      return;
    }
    console.log(`Resetting ${targetClips.length} video clips for lines: ${targetLines.join(', ')}...`);
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
    }

    console.log(`  Reset: Ch${clip.chapter} L${clip.line} (id=${clip.id}, was ${clip.status})`);
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

  console.log(`\nDone! ${targetClips.length} clips reset, ${filesDeleted} files deleted.`);
  console.log('Close the app if open, then relaunch — it will resume at video generation.');
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
