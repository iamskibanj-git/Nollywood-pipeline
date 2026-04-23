#!/usr/bin/env node
/**
 * Redo location images by resetting them to 'pending' in the DB.
 *
 * Usage:
 *   node scripts/redo-locations.js list           — list all location assets and status
 *   node scripts/redo-locations.js all            — redo ALL location images
 *   node scripts/redo-locations.js all-failed     — redo only failed locations
 *   node scripts/redo-locations.js boardroom,corridor  — redo by element_name substring match
 *
 * This script:
 * 1. Opens the SQLite database from the Electron userData path
 * 2. Finds all location_image assets
 * 3. Resets the specified ones to 'pending' (clears file_path, model_used, etc.)
 * 4. Sets the project stage to 'portraits-done' so the pipeline re-enters
 *    elements-setup → _runCinematicLocationSetup which will regenerate them
 *
 * The _runCinematicLocationSetup method is idempotent:
 *   - Checks each location: if status === 'done' AND file exists on disk → skip
 *   - So resetting status + deleting file guarantees regeneration
 *   - Character element creation (also in elements-setup) is likewise idempotent
 *     and won't re-run if elements already exist in Cinema Studio
 *
 * IMPORTANT: Delete the local location image files BEFORE running this script,
 * or the script will attempt to delete them (may fail on Windows FUSE mounts).
 *
 * After running:
 *   1. Close and reopen the app
 *   2. Click Resume — pipeline re-enters elements-setup, skips char elements,
 *      regenerates only the reset location images (with fixed prompts — no more
 *      "9:16 aspect ratio" text in the prompt thanks to sanitizeAspectRatio)
 */

const path = require('path');
const fs = require('fs');

const ARG = process.argv[2];

if (!ARG) {
  console.log(`
Usage:
  node scripts/redo-locations.js <target>

Targets:
  list             List all location_image assets and their status
  all              Redo ALL location images
  all-failed       Redo only failed locations
  <names>          Comma-separated element_name substrings (e.g. boardroom,corridor)

Examples:
  node scripts/redo-locations.js list
  node scripts/redo-locations.js all
  node scripts/redo-locations.js all-failed
  node scripts/redo-locations.js boardroom,corridor
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
    // No incomplete project — use most recent
    const fallback = db.exec(`SELECT id, title FROM projects ORDER BY updated_at DESC LIMIT 1`);
    if (!fallback[0] || fallback[0].values.length === 0) {
      console.error('No projects found in the database.');
      db.close();
      process.exit(1);
    }
    projectId = fallback[0].values[0][0];
    projectTitle = fallback[0].values[0][1];
  }
  console.log(`Active project: "${projectTitle}" (id: ${projectId})`);

  // Fetch location_image assets for this project only
  const result = db.exec(`
    SELECT id, element_name, status, file_path, prompt_used, model_used, error_message, completed_at
    FROM project_assets
    WHERE type = 'location_image' AND project_id = '${projectId}'
    ORDER BY element_name
  `);

  const locations = result[0]
    ? result[0].values.map(row => ({
        id: row[0],
        element_name: row[1],
        status: row[2],
        file_path: row[3],
        prompt_used: row[4],
        model_used: row[5],
        error_message: row[6],
        completed_at: row[7],
      }))
    : [];

  if (locations.length === 0) {
    console.log('No location_image assets found in the database.');
    db.close();
    return;
  }

  console.log(`\nFound ${locations.length} location_image asset(s)\n`);

  // ── LIST mode ──
  if (ARG === 'list') {
    console.log('  Name                          Status    File                              On disk?');
    console.log('  ────                          ──────    ────                              ────────');
    for (const loc of locations) {
      const name = (loc.element_name || '(unnamed)').padEnd(30);
      const status = loc.status.padEnd(8);
      const file = loc.file_path ? path.basename(loc.file_path).padEnd(34) : '—'.padEnd(34);
      const onDisk = loc.file_path && fs.existsSync(loc.file_path) ? 'YES' : 'NO';
      const err = loc.error_message ? ` err: ${loc.error_message.substring(0, 40)}` : '';
      console.log(`  ${name}${status}  ${file}${onDisk}${err}`);
    }
    const doneCount = locations.filter(l => l.status === 'done').length;
    const failedCount = locations.filter(l => l.status === 'failed').length;
    const pendingCount = locations.filter(l => l.status === 'pending').length;
    console.log(`\n  Summary: ${doneCount} done, ${failedCount} failed, ${pendingCount} pending\n`);
    db.close();
    return;
  }

  // ── Determine which locations to redo ──
  let targets;

  if (ARG === 'all') {
    targets = locations;
    console.log(`Redoing ALL ${targets.length} location(s)`);
  } else if (ARG === 'all-failed') {
    targets = locations.filter(l => l.status === 'failed');
    if (targets.length === 0) {
      console.log('No failed locations to redo.');
      db.close();
      return;
    }
    console.log(`Redoing ${targets.length} failed location(s)`);
  } else {
    // Name-based selection — comma-separated substrings
    const nameFilters = ARG.split(',').map(s => s.trim().toLowerCase());
    targets = locations.filter(l =>
      nameFilters.some(f => (l.element_name || '').toLowerCase().includes(f))
    );
    if (targets.length === 0) {
      console.error(`No locations match: ${ARG}`);
      console.error(`Available: ${locations.map(l => l.element_name || l.id).join(', ')}`);
      process.exit(1);
    }
    console.log(`Redoing ${targets.length} location(s) matching: ${ARG}`);
  }

  // ── Reset the targeted locations ──
  let resetCount = 0;
  let deletedCount = 0;

  for (const loc of targets) {
    const name = loc.element_name || `id:${loc.id}`;
    const prevStatus = loc.status;

    // Try to delete file from disk
    if (loc.file_path && fs.existsSync(loc.file_path)) {
      try {
        fs.unlinkSync(loc.file_path);
        deletedCount++;
        console.log(`  Deleted: ${path.basename(loc.file_path)} (${name})`);
      } catch (e) {
        console.log(`  WARN: Could not delete ${path.basename(loc.file_path)}: ${e.message}`);
        console.log(`        → Delete it manually before resuming the pipeline`);
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
      WHERE id = '${loc.id}'
    `);
    resetCount++;
    console.log(`  Reset: ${name} (was: ${prevStatus}) → pending`);
  }

  // Set project stage back to portraits-done so pipeline re-enters elements-setup
  // which includes _runCinematicLocationSetup
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
  console.log(`\nDone. ${resetCount} location(s) reset, ${deletedCount} file(s) deleted from disk.`);
  console.log('\nNext steps:');
  console.log('  1. Make sure local location image files are deleted');
  console.log('     (check assets/locations/ in your project folder)');
  console.log('  2. Close and reopen the app');
  console.log('  3. Click Resume — pipeline re-enters elements-setup:');
  console.log('     • Character elements already exist → skipped');
  console.log('     • Location images reset to pending → regenerated');
  console.log('     • Prompts now go through sanitizeAspectRatio() — no more');
  console.log('       rotated images from "9:16 aspect ratio" text in prompt');

  db.close();
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
