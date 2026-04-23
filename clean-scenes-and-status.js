/**
 * One-shot script: clean scene_image_cinematic assets + show project status.
 * Run: node clean-scenes-and-status.js
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

  console.log('═══════════════════════════════════════');
  console.log(`Project: ${proj.title} (${proj.id})`);
  console.log(`Stage:   ${proj.stage}`);
  console.log(`Mode:    ${proj.generator_mode}`);
  const settings = proj.settings ? (typeof proj.settings === 'string' ? JSON.parse(proj.settings) : proj.settings) : {};
  console.log(`Higgsfield project: ${settings.higgsfield_cinema_project_id || 'none'}`);
  console.log('═══════════════════════════════════════');

  // Show all asset counts by type + status
  const allAssets = db.getAssets(proj.id, {});
  const summary = {};
  for (const a of allAssets) {
    const key = `${a.type}`;
    if (!summary[key]) summary[key] = { done: 0, generating: 0, pending: 0, failed: 0, total: 0 };
    summary[key][a.status] = (summary[key][a.status] || 0) + 1;
    summary[key].total++;
  }
  console.log('\nAsset summary:');
  for (const [type, counts] of Object.entries(summary)) {
    console.log(`  ${type}: ${counts.total} total (done=${counts.done}, generating=${counts.generating}, pending=${counts.pending}, failed=${counts.failed})`);
  }

  // Clean scene_image_cinematic
  const scenes = db.getAssets(proj.id, { type: 'scene_image_cinematic' });
  console.log(`\n── Cleaning ${scenes.length} scene_image_cinematic asset(s) ──`);
  for (const s of scenes) {
    console.log(`  id=${s.id} ch=${s.chapter} sc=${s.scene} status=${s.status} path=${s.file_path || 'none'}`);
    // Delete local file if exists
    if (s.file_path && fs.existsSync(s.file_path)) {
      fs.unlinkSync(s.file_path);
      console.log(`  → deleted local file: ${s.file_path}`);
    }
    db.deleteAsset(s.id);
    console.log(`  → deleted from DB`);
  }

  db.save();
  console.log('\n✓ Scenes cleaned. Project stage remains:', proj.stage);
  process.exit(0);
})();
