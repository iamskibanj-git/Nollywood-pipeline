/**
 * One-shot script: delete all scene_image_cinematic assets from the DB.
 * Run: node clean-scenes.js
 */
const path = require('path');
const os = require('os');

(async () => {
  const db = require('./src/main/database/db');
  const dbPath = path.join(os.homedir(), 'AppData', 'Roaming', 'nollywood-ai-pipeline', 'nollywood-pipeline.sqlite');
  await db.init(dbPath);

  const proj = db.getActiveProject();
  if (!proj) { console.log('No active project'); process.exit(1); }
  console.log(`Project: ${proj.title} (${proj.id})`);

  const scenes = db.getAssets(proj.id, { type: 'scene_image_cinematic' });
  console.log(`Found ${scenes.length} scene_image_cinematic asset(s):`);
  for (const s of scenes) {
    console.log(`  id=${s.id} ch=${s.chapter} sc=${s.scene} status=${s.status}`);
    db.deleteAsset(s.id);
    console.log(`  → deleted`);
  }

  db.save();
  console.log('Done — scenes cleared from DB.');
  process.exit(0);
})();
