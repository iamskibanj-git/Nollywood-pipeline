#!/usr/bin/env node
/**
 * Reset project assets back to 'pending' status for re-generation.
 *
 * Usage:
 *   node scripts/reset-assets.js scenes          — reset scene images only
 *   node scripts/reset-assets.js all              — reset portraits + scenes + clips (full reset)
 *   node scripts/reset-assets.js portraits        — reset portraits only
 *   node scripts/reset-assets.js clips            — reset video clips only
 *
 * This script:
 * 1. Opens the SQLite database from the Electron userData path
 * 2. Resets the specified asset types to 'pending'
 * 3. Clears file_path, model_used, source_gen_id, prompt_used
 * 4. Optionally deletes the image/video files from disk
 * 5. Sets the project stage back appropriately
 * 6. Saves the database
 *
 * The app must be CLOSED before running this script.
 */

const path = require('path');
const fs = require('fs');

const MODE = process.argv[2] || 'scenes';
const VALID_MODES = ['scenes', 'portraits', 'clips', 'all'];

if (!VALID_MODES.includes(MODE)) {
  console.error(`Invalid mode: "${MODE}". Use one of: ${VALID_MODES.join(', ')}`);
  process.exit(1);
}

// Which asset types to reset for each mode
const TYPE_MAP = {
  scenes: ['scene_image'],
  portraits: ['portrait'],
  clips: ['video_clip'],
  all: ['portrait', 'scene_image', 'video_clip'],
};

// What stage to revert to after reset
const STAGE_MAP = {
  scenes: 'portraits-done',
  portraits: 'script-done',
  clips: 'scenes-done',
  all: 'script-done',
};

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
  console.log(`Mode: ${MODE} — resetting: ${TYPE_MAP[MODE].join(', ')}`);
  console.log();

  const SQL = await initSqlJs();
  const buffer = fs.readFileSync(dbPath);
  const db = new SQL.Database(buffer);

  const types = TYPE_MAP[MODE];
  let totalReset = 0;
  let totalDeleted = 0;

  for (const type of types) {
    // Show current state
    const before = db.exec(`
      SELECT status, COUNT(*) as count
      FROM project_assets
      WHERE type = '${type}'
      GROUP BY status
    `);
    console.log(`── ${type} ──`);
    console.log('  Before:');
    if (before[0]) {
      for (const row of before[0].values) {
        console.log(`    ${row[0]}: ${row[1]}`);
      }
    } else {
      console.log('    (no assets)');
    }

    // Get files to delete
    const doneAssets = db.exec(`
      SELECT id, chapter, line, character_id, file_path
      FROM project_assets
      WHERE type = '${type}' AND file_path IS NOT NULL
    `);

    if (doneAssets[0]) {
      for (const row of doneAssets[0].values) {
        const [id, chapter, line, charId, filePath] = row;
        const label = charId ? `char=${charId}` : `Ch${chapter} L${line}`;
        if (filePath && fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
          totalDeleted++;
          console.log(`  Deleted: ${path.basename(filePath)} (${label})`);
        }
      }
    }

    // Reset all assets of this type
    db.run(`
      UPDATE project_assets
      SET status = 'pending',
          file_path = NULL,
          model_used = NULL,
          source_gen_id = NULL,
          completed_at = NULL,
          prompt_used = NULL,
          error_message = NULL
      WHERE type = '${type}'
    `);

    const countResult = db.exec(`SELECT changes()`);
    const count = countResult[0]?.values[0][0] || 0;
    totalReset += count;
    console.log(`  Reset: ${count} assets → pending`);
    console.log();
  }

  // Set project stage
  const targetStage = STAGE_MAP[MODE];
  db.run(`
    UPDATE projects
    SET stage = '${targetStage}', updated_at = datetime('now')
    WHERE completed_at IS NULL
  `);
  console.log(`Project stage set to: ${targetStage}`);

  // Save
  const data = db.export();
  const buf = Buffer.from(data);
  fs.writeFileSync(dbPath, buf);
  console.log(`\nDatabase saved. ${totalReset} assets reset, ${totalDeleted} files deleted.`);
  console.log('Close and reopen the app, then resume the project.');

  db.close();
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
