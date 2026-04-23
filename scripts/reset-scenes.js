#!/usr/bin/env node
/**
 * Reset all scene_image assets back to 'pending' status.
 * Run this when scenes need to be re-generated (e.g., after a staging fix).
 *
 * Usage: node scripts/reset-scenes.js
 *
 * This script:
 * 1. Opens the SQLite database from the Electron userData path
 * 2. Resets all scene_image assets to 'pending'
 * 3. Clears their file_path, model_used, source_gen_id
 * 4. Saves the database
 *
 * The app must be CLOSED before running this script.
 */

const path = require('path');
const fs = require('fs');

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

  console.log(`Opening database: ${dbPath}`);
  const SQL = await initSqlJs();
  const buffer = fs.readFileSync(dbPath);
  const db = new SQL.Database(buffer);

  // Show current state
  const before = db.exec(`
    SELECT status, COUNT(*) as count
    FROM project_assets
    WHERE type = 'scene_image'
    GROUP BY status
  `);
  console.log('\nCurrent scene_image status:');
  if (before[0]) {
    for (const row of before[0].values) {
      console.log(`  ${row[0]}: ${row[1]}`);
    }
  }

  // Count what we're about to reset
  const doneScenes = db.exec(`
    SELECT id, chapter, line, file_path
    FROM project_assets
    WHERE type = 'scene_image' AND status = 'done'
  `);

  if (!doneScenes[0] || doneScenes[0].values.length === 0) {
    console.log('\nNo completed scene images to reset.');
    db.close();
    return;
  }

  console.log(`\nResetting ${doneScenes[0].values.length} completed scene images:`);
  for (const row of doneScenes[0].values) {
    const [id, chapter, line, filePath] = row;
    console.log(`  id=${id} Ch${chapter} L${line} — ${filePath || '(no file)'}`);

    // Delete the image file if it exists
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log(`    Deleted: ${filePath}`);
    }
  }

  // Reset all scene_image assets to pending
  db.run(`
    UPDATE project_assets
    SET status = 'pending',
        file_path = NULL,
        model_used = NULL,
        source_gen_id = NULL,
        completed_at = NULL,
        prompt_used = NULL,
        error_message = NULL
    WHERE type = 'scene_image'
  `);

  // Also reset any 'generating' or 'failed' scene assets
  const resetCount = db.exec(`SELECT changes()`);
  console.log(`\nReset ${resetCount[0].values[0][0]} scene_image assets to 'pending'`);

  // Update project stage back to 'portraits-done' so scenes run again
  db.run(`
    UPDATE projects
    SET stage = 'portraits-done', updated_at = datetime('now')
    WHERE stage IN ('scenes-done', 'videos-done', 'assembled')
       OR stage = 'scenes'
  `);
  console.log('Project stage set to: portraits-done');

  // Save
  const data = db.export();
  const buf = Buffer.from(data);
  fs.writeFileSync(dbPath, buf);
  console.log(`\nDatabase saved to: ${dbPath}`);

  // Verify
  const after = db.exec(`
    SELECT status, COUNT(*) as count
    FROM project_assets
    WHERE type = 'scene_image'
    GROUP BY status
  `);
  console.log('\nAfter reset:');
  if (after[0]) {
    for (const row of after[0].values) {
      console.log(`  ${row[0]}: ${row[1]}`);
    }
  }

  db.close();
  console.log('\nDone. Close and reopen the app, then resume the project.');
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
