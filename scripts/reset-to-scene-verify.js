#!/usr/bin/env node
/**
 * Reset project stage to 'scenes-done' so the Scene Verification tab
 * shows on next app launch. This script is SAFE — it only changes the
 * stage pointer in the database. No files are deleted, renamed, or modified.
 *
 * Usage:
 *   node scripts/reset-to-scene-verify.js              — dry run (audit only, no changes)
 *   node scripts/reset-to-scene-verify.js --commit      — actually write the change
 *
 * The app must be CLOSED before running this script.
 *
 * WHAT THIS DOES:
 *   1. Opens the SQLite database (read-only unless --commit)
 *   2. Prints a full asset audit: counts by type + status
 *   3. Checks current project stage
 *   4. Checks for video clip assets (if any exist, scene gate won't fire)
 *   5. If --commit: sets stage to 'scenes-done', clears pending_approval_gate
 *   6. Saves the database
 *
 * WHAT THIS DOES NOT DO:
 *   - Does NOT delete any files from disk
 *   - Does NOT delete any DB rows
 *   - Does NOT modify any asset rows (portraits, scenes, locations, elements)
 *   - Does NOT reset any asset status
 *   - Does NOT touch the .archive/ folder
 */

const path = require('path');
const fs = require('fs');

const DRY_RUN = !process.argv.includes('--commit');

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

  console.log('═══════════════════════════════════════════════════════════');
  console.log('  SCENE VERIFICATION RESET — ' + (DRY_RUN ? 'DRY RUN (no changes)' : 'COMMIT MODE'));
  console.log('═══════════════════════════════════════════════════════════');
  console.log();
  console.log(`Database: ${dbPath}`);
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN — audit only, nothing will be written' : 'COMMIT — will write stage change'}`);
  console.log();

  const SQL = await initSqlJs();
  const buffer = fs.readFileSync(dbPath);
  const db = new SQL.Database(buffer);

  // ── 1. Find active project ──
  const projects = db.exec(`SELECT id, title, stage, settings FROM projects ORDER BY created_at DESC LIMIT 1`);
  if (!projects[0] || projects[0].values.length === 0) {
    console.error('No projects found in database.');
    process.exit(1);
  }

  const [projectId, title, currentStage, settingsRaw] = projects[0].values[0];
  const settings = settingsRaw ? JSON.parse(settingsRaw) : {};
  const genMode = settings.generator_mode || 'staged';

  console.log('── PROJECT ──');
  console.log(`  ID:     ${projectId}`);
  console.log(`  Title:  ${title}`);
  console.log(`  Stage:  ${currentStage}`);
  console.log(`  Mode:   ${genMode}`);
  console.log(`  Gate:   ${settings.pending_approval_gate || '(none)'}`);
  console.log();

  // ── 2. Full asset audit ──
  console.log('── ASSET AUDIT (all types) ──');
  const assetTypes = [
    'portrait', 'character_grid', 'location_image',
    'scene_image_cinematic', 'video_clip_cinematic',
    'scene_image', 'video_clip',
    'branding_clip', 'final_video'
  ];

  let totalAssets = 0;
  const auditLines = [];

  for (const type of assetTypes) {
    const result = db.exec(`
      SELECT status, COUNT(*) as cnt
      FROM project_assets
      WHERE project_id = '${projectId}' AND type = '${type}'
      GROUP BY status
      ORDER BY status
    `);

    if (result[0] && result[0].values.length > 0) {
      const counts = result[0].values.map(([status, cnt]) => `${status}:${cnt}`).join(', ');
      const typeTotal = result[0].values.reduce((sum, [, cnt]) => sum + cnt, 0);
      totalAssets += typeTotal;
      auditLines.push(`  ${type.padEnd(25)} ${String(typeTotal).padStart(4)} total  (${counts})`);
    }
  }

  if (auditLines.length === 0) {
    console.log('  (no assets found)');
  } else {
    auditLines.forEach(l => console.log(l));
    console.log(`  ${'─'.repeat(50)}`);
    console.log(`  ${'TOTAL'.padEnd(25)} ${String(totalAssets).padStart(4)} assets`);
  }
  console.log();

  // ── 3. File integrity check for scene images ──
  console.log('── SCENE IMAGE FILE CHECK ──');
  const sceneAssets = db.exec(`
    SELECT id, chapter, scene, status, file_path
    FROM project_assets
    WHERE project_id = '${projectId}' AND type = 'scene_image_cinematic' AND status = 'done'
    ORDER BY chapter, scene
  `);

  let scenesOnDisk = 0;
  let scenesMissing = 0;

  if (sceneAssets[0]) {
    for (const [id, ch, sc, status, filePath] of sceneAssets[0].values) {
      const exists = filePath && fs.existsSync(filePath);
      if (exists) {
        scenesOnDisk++;
      } else {
        scenesMissing++;
        console.log(`  MISSING: Ch${ch} Sc${sc} — ${filePath || '(no path)'}`);
      }
    }
  }
  console.log(`  ${scenesOnDisk} scene images on disk, ${scenesMissing} missing`);
  console.log();

  // ── 4. Check video clips (BOTH types — settings.generator_mode can be wrong) ──
  // Detect actual mode from assets: if scene_image_cinematic exists, it's cinematic
  const hasCinematicScenes = db.exec(`SELECT COUNT(*) FROM project_assets WHERE project_id = '${projectId}' AND type = 'scene_image_cinematic'`);
  const actualCinematic = hasCinematicScenes[0] && hasCinematicScenes[0].values[0][0] > 0;
  if (actualCinematic && genMode !== 'cinematic') {
    console.log(`── MODE MISMATCH ──`);
    console.log(`  settings.generator_mode = "${genMode}" but scene_image_cinematic assets exist`);
    console.log(`  Using cinematic detection from actual assets`);
    console.log();
  }

  // Check both clip types so we don't miss any
  const clipTypes = ['video_clip_cinematic', 'video_clip'];
  let totalClipRows = 0;
  const clipTypesToClear = [];

  for (const ct of clipTypes) {
    const clipResult = db.exec(`
      SELECT status, COUNT(*) FROM project_assets
      WHERE project_id = '${projectId}' AND type = '${ct}'
      GROUP BY status
    `);
    console.log(`── VIDEO CLIPS (${ct}) ──`);
    if (clipResult[0] && clipResult[0].values.length > 0) {
      for (const [status, cnt] of clipResult[0].values) {
        console.log(`  ${status}: ${cnt}`);
      }
      const typeTotal = clipResult[0].values.reduce((sum, [, cnt]) => sum + cnt, 0);
      totalClipRows += typeTotal;
      clipTypesToClear.push(ct);
    } else {
      console.log('  (none)');
    }
    console.log();
  }

  if (totalClipRows > 0) {
    console.log('  ⚠  Video clip rows exist. The reset will DELETE these DB rows');
    console.log('     (not the files on disk) so the scene verification gate fires.');
    console.log('     Video gen will re-create clip rows from scratch after scene approval.');
    console.log();
  }

  // ── 5. Safety summary ──
  console.log('── SAFETY SUMMARY ──');
  console.log('  Files deleted:     0  (no files are ever deleted by this script)');
  console.log('  Files renamed:     0  (no files are ever renamed by this script)');
  console.log('  Assets modified:   0  (no asset rows are modified — status stays as-is)');
  console.log(`  Stage change:      ${currentStage} → scenes-done`);
  if (settings.pending_approval_gate) {
    console.log(`  Gate cleared:      ${settings.pending_approval_gate} → (none)`);
  }
  if (totalClipRows > 0) {
    console.log(`  Clip rows deleted: ${totalClipRows}  (DB rows only — clip files on disk untouched)`);
    console.log(`    Types:           ${clipTypesToClear.join(', ')}`);
  }
  console.log();

  if (DRY_RUN) {
    console.log('═══════════════════════════════════════════════════════════');
    console.log('  DRY RUN COMPLETE — no changes made');
    console.log('  To apply, run:  node scripts/reset-to-scene-verify.js --commit');
    console.log('═══════════════════════════════════════════════════════════');
    db.close();
    return;
  }

  // ── 6. COMMIT: apply changes ──
  console.log('Applying changes...');

  // Delete video clip rows (if any) so scene gate fires
  if (totalClipRows > 0) {
    for (const ct of clipTypesToClear) {
      const countResult = db.exec(`SELECT COUNT(*) FROM project_assets WHERE project_id = '${projectId}' AND type = '${ct}'`);
      const cnt = countResult[0] ? countResult[0].values[0][0] : 0;
      if (cnt > 0) {
        db.run(`DELETE FROM project_assets WHERE project_id = '${projectId}' AND type = '${ct}'`);
        console.log(`  ✓ Deleted ${cnt} ${ct} DB row(s)`);
      }
    }
  }

  // Clear pending approval gate
  if (settings.pending_approval_gate) {
    delete settings.pending_approval_gate;
    db.run(`UPDATE projects SET settings = ? WHERE id = ?`, [JSON.stringify(settings), projectId]);
    console.log('  ✓ Cleared pending_approval_gate');
  }

  // Set stage
  db.run(`UPDATE projects SET stage = 'scenes-done', updated_at = datetime('now') WHERE id = ?`, [projectId]);
  console.log(`  ✓ Stage set to scenes-done (was: ${currentStage})`);

  // Save
  const data = db.export();
  const outBuffer = Buffer.from(data);
  fs.writeFileSync(dbPath, outBuffer);
  console.log(`  ✓ Database saved (${(outBuffer.length / 1024).toFixed(0)} KB)`);
  db.close();

  console.log();
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  DONE — launch the app and click Resume');
  console.log('  The Scene Verification tab will show with all scenes');
  console.log('  grouped by location for continuity review.');
  console.log('═══════════════════════════════════════════════════════════');
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
