#!/usr/bin/env node
/**
 * Redo scene images by resetting them to 'pending'.
 * Works for both STAGED (scene_image) and CINEMATIC (scene_image_cinematic) modes.
 *
 * Usage:
 *   node scripts/redo-scenes.js all              — redo ALL scene images
 *   node scripts/redo-scenes.js 2,5,14           — redo scene lines 2, 5, and 14 (staged)
 *   node scripts/redo-scenes.js 2-5              — redo scene lines 2 through 5 (staged)
 *   node scripts/redo-scenes.js 2,5-8,14         — mix of individual and ranges (staged)
 *   node scripts/redo-scenes.js all-failed        — redo all scenes that have status 'failed'
 *   node scripts/redo-scenes.js list              — list all scene assets and their status
 *
 * For cinematic mode, "all" is the primary use case since scenes are addressed by
 * chapter+scene, not line numbers. The line-based selectors work for staged mode.
 *
 * This script:
 * 1. Opens the SQLite database from the Electron userData path
 * 2. Detects whether the active project uses staged or cinematic mode
 * 3. Resets the specified scene assets to 'pending'
 * 4. Clears file_path, model_used, source_gen_id, prompt_used
 * 5. Sets the project stage to 'portraits-done' so the pipeline re-enters scenes
 * 6. Optionally clears stashed vision_refined_characters from prompt_used
 *    so fresh vision-refined blocking is generated with latest code fixes
 *
 * The app must be CLOSED before running this script.
 * After running, reopen the app and click Resume — it will regenerate only the
 * reset scenes and skip all others that are still 'done'.
 *
 * NOTE: You should also delete the scene image files from the local assets folder.
 * The pipeline checks fs.existsSync() and will skip any scene whose file still exists.
 */

const path = require('path');
const fs = require('fs');

const ARG = process.argv[2];

if (!ARG) {
  console.log(`
Usage:
  node scripts/redo-scenes.js <target>

Targets:
  all              Redo ALL scene images (staged + cinematic)
  all-failed       Redo only failed scenes
  list             List all scene assets and their status
  2,5,14           Redo specific lines (staged mode only)
  2-5              Redo a range of lines (staged mode only)
  2,5-8,14         Mix of individual + range (staged mode only)

Examples:
  node scripts/redo-scenes.js all          ← most common for cinematic redo
  node scripts/redo-scenes.js all-failed
  node scripts/redo-scenes.js list
  node scripts/redo-scenes.js 2,5-8,14
`);
  process.exit(0);
}

/**
 * Parse a line spec like "2,5-8,14" into an array of line numbers [2,5,6,7,8,14]
 */
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

  // Find the active (most recent incomplete) project, or fall back to most recent
  const projResult = db.exec(`
    SELECT id, title FROM projects
    WHERE completed_at IS NULL
    ORDER BY updated_at DESC LIMIT 1
  `);
  let projectId, projectTitle;
  if (projResult[0] && projResult[0].values.length > 0) {
    projectId = projResult[0].values[0][0];
    projectTitle = projResult[0].values[0][1];
  } else {
    const fallback = db.exec(`SELECT id, title FROM projects ORDER BY updated_at DESC LIMIT 1`);
    if (!fallback[0] || fallback[0].values.length === 0) {
      console.error('No projects found in the database.');
      db.close();
      process.exit(1);
    }
    projectId = fallback[0].values[0][0];
    projectTitle = fallback[0].values[0][1];
  }
  console.log(`Active project: "${projectTitle}" (id: ${projectId})\n`);

  // Detect both staged and cinematic scene assets for this project
  const stagedResult = db.exec(`
    SELECT id, chapter, line, scene, status, file_path, prompt_used, model_used, error_message
    FROM project_assets
    WHERE type = 'scene_image' AND project_id = '${projectId}'
    ORDER BY chapter, line
  `);
  const cinematicResult = db.exec(`
    SELECT id, chapter, line, scene, status, file_path, prompt_used, model_used, error_message
    FROM project_assets
    WHERE type = 'scene_image_cinematic' AND project_id = '${projectId}'
    ORDER BY chapter, scene
  `);

  const parseRows = (result, mode) => {
    if (!result[0]) return [];
    return result[0].values.map(row => ({
      id: row[0],
      chapter: row[1],
      line: row[2],
      scene: row[3],
      status: row[4],
      file_path: row[5],
      prompt_used: row[6],
      model_used: row[7],
      error_message: row[8],
      mode,
    }));
  };

  const stagedScenes = parseRows(stagedResult, 'staged');
  const cinematicScenes = parseRows(cinematicResult, 'cinematic');
  const allScenes = [...stagedScenes, ...cinematicScenes];

  if (allScenes.length === 0) {
    console.log('No scene assets found in the database.');
    db.close();
    return;
  }

  const isCinematic = cinematicScenes.length > 0;
  console.log(`\nDetected mode: ${isCinematic ? 'CINEMATIC' : 'STAGED'} (${stagedScenes.length} staged, ${cinematicScenes.length} cinematic)`);

  // ── LIST mode ──
  if (ARG === 'list') {
    console.log(`\nScene assets (${allScenes.length} total):\n`);
    if (cinematicScenes.length > 0) {
      console.log('  CINEMATIC scenes:');
      console.log('  Ch  Sc  Status    File');
      console.log('  ──  ──  ────────  ────');
      for (const s of cinematicScenes) {
        const file = s.file_path ? path.basename(s.file_path) : '—';
        const exists = s.file_path && fs.existsSync(s.file_path) ? '' : ' [MISSING]';
        const err = s.error_message ? ` (${s.error_message.substring(0, 50)})` : '';
        console.log(`  ${String(s.chapter).padStart(2)}  ${String(s.scene).padStart(2)}  ${s.status.padEnd(8)}  ${file}${exists}${err}`);
      }
    }
    if (stagedScenes.length > 0) {
      console.log('  STAGED scenes:');
      console.log('  Line  Ch  Status    File');
      console.log('  ────  ──  ────────  ────');
      for (const s of stagedScenes) {
        const file = s.file_path ? path.basename(s.file_path) : '—';
        const exists = s.file_path && fs.existsSync(s.file_path) ? '' : ' [MISSING]';
        const err = s.error_message ? ` (${s.error_message.substring(0, 50)})` : '';
        console.log(`  ${String(s.line).padStart(4)}  ${String(s.chapter).padStart(2)}  ${s.status.padEnd(8)}  ${file}${exists}${err}`);
      }
    }
    const doneCount = allScenes.filter(s => s.status === 'done').length;
    const failedCount = allScenes.filter(s => s.status === 'failed').length;
    const pendingCount = allScenes.filter(s => s.status === 'pending').length;
    console.log(`\n  Summary: ${doneCount} done, ${failedCount} failed, ${pendingCount} pending\n`);
    db.close();
    return;
  }

  // ── Determine which scenes to redo ──
  let targetScenes;

  if (ARG === 'all') {
    targetScenes = allScenes;
    console.log(`Redoing ALL ${targetScenes.length} scene(s)`);
  } else if (ARG === 'all-failed') {
    targetScenes = allScenes.filter(s => s.status === 'failed');
    if (targetScenes.length === 0) {
      console.log('No failed scenes to redo.');
      db.close();
      return;
    }
    console.log(`Redoing ${targetScenes.length} failed scene(s)`);
  } else {
    // Line-based selection (staged mode)
    const targetLines = parseLineSpec(ARG);
    const allLineNums = new Set(stagedScenes.map(s => s.line));
    const invalid = targetLines.filter(l => !allLineNums.has(l));
    if (invalid.length > 0) {
      console.error(`Lines not found in database: ${invalid.join(', ')}`);
      console.error(`Valid lines: ${Array.from(allLineNums).sort((a, b) => a - b).join(', ')}`);
      process.exit(1);
    }
    targetScenes = stagedScenes.filter(s => targetLines.includes(s.line));
    console.log(`Redoing ${targetScenes.length} scene(s): lines ${targetLines.join(', ')}`);
  }

  // ── Reset the targeted scenes ──
  let resetCount = 0;
  let deletedCount = 0;

  for (const scene of targetScenes) {
    const label = scene.mode === 'cinematic'
      ? `Ch${scene.chapter} Sc${scene.scene}`
      : `Ch${scene.chapter} Line ${scene.line}`;
    const prevStatus = scene.status;

    // Delete file from disk
    if (scene.file_path && fs.existsSync(scene.file_path)) {
      try {
        fs.unlinkSync(scene.file_path);
        deletedCount++;
        console.log(`  Deleted: ${path.basename(scene.file_path)} (${label})`);
      } catch (e) {
        console.log(`  WARN: Could not delete ${path.basename(scene.file_path)}: ${e.message}`);
      }
    }

    // Reset in DB
    db.run(`
      UPDATE project_assets
      SET status = 'pending',
          file_path = NULL,
          model_used = NULL,
          source_gen_id = NULL,
          completed_at = NULL,
          prompt_used = NULL,
          error_message = NULL
      WHERE id = '${scene.id}'
    `);
    resetCount++;
    console.log(`  Reset: ${label} (was: ${prevStatus}) → pending`);
  }

  // Set project stage to portraits-done so pipeline re-enters scene generation
  db.run(`
    UPDATE projects
    SET stage = 'portraits-done', updated_at = datetime('now')
    WHERE id = '${projectId}'
  `);
  console.log(`\nProject stage set to: portraits-done`);

  // Save
  const data = db.export();
  const buf = Buffer.from(data);
  fs.writeFileSync(dbPath, buf);
  console.log(`\nDone. ${resetCount} scene(s) reset, ${deletedCount} file(s) deleted from disk.`);
  console.log('\nNext steps:');
  console.log('  1. Delete any remaining scene image files from your local assets folder');
  console.log('     (the script deletes what it can, but some may be locked on Windows)');
  console.log('  2. Close and reopen the app');
  console.log('  3. Click Resume — it will regenerate only the reset scenes');
  console.log('     with the latest prompt fixes (base name → suffixed @element names)');

  db.close();
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
