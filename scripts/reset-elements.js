#!/usr/bin/env node
/**
 * Check element status and optionally reset the element stage so it re-runs.
 *
 * Usage:
 *   node scripts/reset-elements.js          # show current element status
 *   node scripts/reset-elements.js --reset   # clear element names + roll stage back
 */

const path = require('path');
const fs = require('fs');

const doReset = process.argv.includes('--reset');

(async () => {
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();

  const appData = process.env.APPDATA || path.join(require('os').homedir(), 'AppData', 'Roaming');
  const dbPath = path.join(appData, 'nollywood-ai-pipeline', 'nollywood-pipeline.sqlite');

  if (!fs.existsSync(dbPath)) {
    console.error(`DB not found at: ${dbPath}`);
    process.exit(1);
  }

  const buffer = fs.readFileSync(dbPath);
  const db = new SQL.Database(buffer);

  // Find active project
  const projects = db.exec("SELECT id, title, stage, project_dir FROM projects WHERE stage NOT IN ('completed','abandoned') ORDER BY created_at DESC LIMIT 1");
  if (!projects.length || !projects[0].values.length) {
    console.error('No active project found');
    db.close();
    process.exit(1);
  }

  const [projectId, title, currentStage] = projects[0].values[0];
  console.log(`Project: "${title}" (id=${projectId}, stage=${currentStage})\n`);

  // Show all portrait assets with element names
  const portraits = db.exec(`SELECT id, character_id, status, element_name, higgsfield_element_id FROM project_assets WHERE project_id = '${projectId}' AND type = 'portrait' ORDER BY id`);
  if (portraits.length && portraits[0].values.length) {
    console.log('Portrait elements:');
    for (const row of portraits[0].values) {
      const [id, charId, status, elemName, elemId] = row;
      console.log(`  asset=${id} char=${charId} status=${status} element=${elemName || '(none)'} hf_id=${elemId || '(none)'}`);
    }
  }

  // Show location assets with element names
  const locations = db.exec(`SELECT id, character_id, status, element_name, higgsfield_element_id FROM project_assets WHERE project_id = '${projectId}' AND type = 'location_image' ORDER BY id`);
  if (locations.length && locations[0].values.length) {
    console.log('\nLocation elements:');
    for (const row of locations[0].values) {
      const [id, charId, status, elemName, elemId] = row;
      console.log(`  asset=${id} status=${status} element=${elemName || '(none)'} hf_id=${elemId || '(none)'}`);
    }
  }

  // Check scene image assets
  const scenes = db.exec(`SELECT COUNT(*) as total, SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as done FROM project_assets WHERE project_id = '${projectId}' AND type = 'scene_image_cinematic'`);
  if (scenes.length && scenes[0].values.length) {
    console.log(`\nScene images: ${scenes[0].values[0][1] || 0} done / ${scenes[0].values[0][0]} total`);
  }

  if (doReset) {
    console.log('\n── RESETTING ──');

    // Clear element_name and higgsfield_element_id on all portrait assets
    db.run(`UPDATE project_assets SET element_name = NULL, higgsfield_element_id = NULL WHERE project_id = '${projectId}' AND type = 'portrait'`);
    console.log('✓ Cleared element names on portrait assets');

    // Clear on location assets too
    db.run(`UPDATE project_assets SET element_name = NULL, higgsfield_element_id = NULL WHERE project_id = '${projectId}' AND type = 'location_image'`);
    console.log('✓ Cleared element names on location assets');

    // Reset any scene images that haven't started (so they don't run before elements)
    db.run(`UPDATE project_assets SET status = 'pending' WHERE project_id = '${projectId}' AND type = 'scene_image_cinematic' AND status != 'done'`);
    console.log('✓ Reset incomplete scene images to pending');

    // Roll stage back to portraits-done so elements-setup re-runs
    db.run(`UPDATE projects SET stage = 'portraits-done', updated_at = datetime('now') WHERE id = '${projectId}'`);
    console.log(`✓ Stage rolled back: ${currentStage} → portraits-done`);

    // Save
    const data = db.export();
    fs.writeFileSync(dbPath, Buffer.from(data));
    console.log('✓ Database saved');
    console.log('\nDone! Restart the app — element setup will re-run before scenes.');
  } else {
    console.log('\nTo reset elements and re-run setup: node scripts/reset-elements.js --reset');
  }

  db.close();
})();
