#!/usr/bin/env node
/**
 * Status check + force-advance utility.
 *
 * Verifies all assets on disk, reconciles DB status with actual files,
 * and optionally advances the project stage to move past a hung pipeline.
 *
 * Usage:
 *   node scripts/status-check.js              — status only (read-only report)
 *   node scripts/status-check.js --fix        — reconcile DB: mark assets done if file exists
 *   node scripts/status-check.js --advance    — --fix + advance stage to videos-done if all clips done
 *   node scripts/status-check.js --advance --force — advance even if some clips are missing
 *
 * The app must be CLOSED before running --fix or --advance.
 */

const path = require('path');
const fs = require('fs');

const FIX = process.argv.includes('--fix') || process.argv.includes('--advance');
const ADVANCE = process.argv.includes('--advance');
const FORCE = process.argv.includes('--force');

async function main() {
  const initSqlJs = require('sql.js');
  const appName = 'nollywood-ai-pipeline';
  const appData = process.env.APPDATA || path.join(require('os').homedir(), 'AppData', 'Roaming');
  const dbPath = path.join(appData, appName, 'nollywood-pipeline.sqlite');

  if (!fs.existsSync(dbPath)) {
    console.error(`Database not found at: ${dbPath}`);
    process.exit(1);
  }

  const SQL = await initSqlJs();
  const buffer = fs.readFileSync(dbPath);
  const db = new SQL.Database(buffer);

  // Active project
  const projRes = db.exec(
    `SELECT id, title, stage, project_dir FROM projects WHERE completed_at IS NULL ORDER BY created_at DESC LIMIT 1`
  );
  if (!projRes[0] || !projRes[0].values.length) {
    console.error('No active project found.');
    db.close();
    process.exit(1);
  }
  const [projectId, title, stage, projectDir] = projRes[0].values[0];

  console.log(`Project: ${title}`);
  console.log(`Stage: ${stage}`);
  console.log(`Folder: ${projectDir}`);
  console.log();

  // Get all assets
  const assetsRes = db.exec(
    `SELECT id, type, chapter, line, character_id, status, file_path, error_message, cdn_url
     FROM project_assets WHERE project_id = '${projectId}' ORDER BY type, chapter, line`
  );

  if (!assetsRes[0] || !assetsRes[0].values.length) {
    console.log('No assets found.');
    db.close();
    return;
  }

  const byType = {};
  for (const row of assetsRes[0].values) {
    const [id, type, chapter, line, charId, status, filePath, errorMsg, cdnUrl] = row;
    if (!byType[type]) byType[type] = [];
    byType[type].push({ id, type, chapter, line, charId, status, filePath, errorMsg, cdnUrl });
  }

  let reconciledCount = 0;
  let missingCount = 0;
  let allClipsOk = true;

  for (const type of Object.keys(byType)) {
    const items = byType[type];
    console.log(`── ${type} (${items.length}) ──`);

    const statusCounts = {};
    for (const item of items) {
      statusCounts[item.status] = (statusCounts[item.status] || 0) + 1;
    }
    console.log(`  Status: ${Object.entries(statusCounts).map(([s, c]) => `${s}=${c}`).join(', ')}`);

    // Check disk for each item
    for (const item of items) {
      const label = item.charId ? `char=${item.charId}` : `Ch${item.chapter} L${item.line}`;
      const expectedFile = item.filePath;

      if (item.status === 'done' && expectedFile && fs.existsSync(expectedFile)) {
        const size = fs.statSync(expectedFile).size;
        if (size < 10000) {
          console.log(`  ⚠ ${label}: marked done but file tiny (${size}B): ${path.basename(expectedFile)}`);
        }
        continue; // done + file exists = OK
      }

      if (item.status === 'done' && (!expectedFile || !fs.existsSync(expectedFile))) {
        console.log(`  ✗ ${label}: marked done but file MISSING (${expectedFile || 'no path'})`);
        missingCount++;
        if (type === 'video_clip') allClipsOk = false;
        continue;
      }

      // Not marked done — check if file actually exists on disk at expected path
      let guessedPath = expectedFile;
      if (!guessedPath) {
        // Reconstruct expected filename
        if (type === 'video_clip') {
          guessedPath = path.join(
            projectDir, 'assets', 'clips',
            `ch${String(item.chapter).padStart(2, '0')}_line${String(item.line).padStart(3, '0')}.mp4`
          );
        } else if (type === 'scene_image') {
          guessedPath = path.join(
            projectDir, 'assets', 'scenes',
            `ch${String(item.chapter).padStart(2, '0')}_line${String(item.line).padStart(3, '0')}.png`
          );
        } else if (type === 'portrait') {
          guessedPath = path.join(
            projectDir, 'assets', 'portraits',
            `portrait_${item.charId}.png`
          );
        }
      }

      if (guessedPath && fs.existsSync(guessedPath) && fs.statSync(guessedPath).size >= 10000) {
        console.log(`  ↻ ${label}: file EXISTS on disk but DB says "${item.status}" — ${path.basename(guessedPath)}`);
        if (FIX) {
          db.run(
            `UPDATE project_assets SET status = 'done', file_path = ?, error_message = NULL
             WHERE id = ?`,
            [guessedPath, item.id]
          );
          reconciledCount++;
        }
      } else {
        console.log(`  ✗ ${label}: status=${item.status}, file not found on disk ${item.errorMsg ? `(${item.errorMsg.slice(0, 80)})` : ''}`);
        missingCount++;
        if (type === 'video_clip') allClipsOk = false;
      }
    }
    console.log();
  }

  console.log(`────────────────────────────`);
  console.log(`Reconciled: ${reconciledCount}, Still missing: ${missingCount}`);

  if (FIX && reconciledCount > 0) {
    console.log(`\nSaving DB with ${reconciledCount} status fix(es)...`);
  }

  if (ADVANCE) {
    // Re-check clip status after fixes
    const clipCheck = db.exec(
      `SELECT status, COUNT(*) FROM project_assets
       WHERE project_id = '${projectId}' AND type = 'video_clip'
       GROUP BY status`
    );
    const clipStatusMap = {};
    if (clipCheck[0]) {
      for (const r of clipCheck[0].values) clipStatusMap[r[0]] = r[1];
    }
    const totalClips = Object.values(clipStatusMap).reduce((a, b) => a + b, 0);
    const doneClips = clipStatusMap['done'] || 0;

    console.log(`\nClip status after reconcile: ${doneClips}/${totalClips} done`);

    if (doneClips === totalClips && totalClips > 0) {
      console.log(`Advancing project stage to 'videos-done'...`);
      db.run(
        `UPDATE projects SET stage = 'videos-done', updated_at = datetime('now')
         WHERE id = ?`,
        [projectId]
      );
      console.log(`✓ Stage set to videos-done. On next app launch, the clip approval gate will open.`);
    } else if (FORCE) {
      console.log(`⚠ Not all clips done but --force flag present — advancing anyway`);
      db.run(
        `UPDATE projects SET stage = 'videos-done', updated_at = datetime('now')
         WHERE id = ?`,
        [projectId]
      );
      console.log(`✓ Stage set to videos-done (forced). On next app launch, approval gate will open.`);
    } else {
      console.log(`✗ Cannot advance — ${totalClips - doneClips} clip(s) still incomplete.`);
      console.log(`  Re-run with --advance --force to skip the missing clips.`);
    }
  }

  if (FIX) {
    const data = db.export();
    fs.writeFileSync(dbPath, Buffer.from(data));
    console.log(`\nDatabase saved.`);
  }

  db.close();

  if (!FIX) {
    console.log(`\nRead-only mode. Add --fix to reconcile DB with disk, or --advance to also move to videos-done.`);
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  console.error(err.stack);
  process.exit(1);
});
