/**
 * One-shot script: roll project stage back to 'portraits-done' so cinematic
 * scene image generation reruns. Also cleans scene_image_cinematic + video_clip assets.
 * Run: node reset-to-scenes.js
 */
const path = require('path');
const os = require('os');
const fs = require('fs');

(async () => {
  const db = require('./src/main/database/db');
  const dbPath = path.join(os.homedir(), 'AppData', 'Roaming', 'nollywood-ai-pipeline', 'nollywood-pipeline.sqlite');
  await db.init(dbPath);

  const proj = db.getActiveProject();
  if (!proj) { console.log('No active project'); process.exit(1); }

  console.log(`Project: ${proj.title}`);
  console.log(`Current stage: ${proj.stage}`);

  // Clean scene_image_cinematic assets
  const scenes = db.getAssets(proj.id, { type: 'scene_image_cinematic' });
  console.log(`\nCleaning ${scenes.length} scene_image_cinematic asset(s)...`);
  for (const s of scenes) {
    if (s.file_path && fs.existsSync(s.file_path)) {
      fs.unlinkSync(s.file_path);
      console.log(`  Deleted file: ${s.file_path}`);
    }
    db.deleteAsset(s.id);
  }

  // Clean video_clip assets (they depend on scenes)
  const videos = db.getAssets(proj.id, { type: 'video_clip' });
  console.log(`Cleaning ${videos.length} video_clip asset(s)...`);
  for (const v of videos) {
    if (v.file_path && fs.existsSync(v.file_path)) {
      fs.unlinkSync(v.file_path);
      console.log(`  Deleted file: ${v.file_path}`);
    }
    db.deleteAsset(v.id);
  }

  // Roll stage back to portraits-done
  db.updateProjectStage(proj.id, 'portraits-done');
  db.save();

  console.log(`\n✓ Stage rolled back: ${proj.stage} → portraits-done`);
  console.log('Restart the pipeline to rerun cinematic scene generation.');
  process.exit(0);
})();
