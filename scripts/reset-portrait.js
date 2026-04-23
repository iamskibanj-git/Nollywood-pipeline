#!/usr/bin/env node
/**
 * Reset a portrait asset back to pending and roll the project stage back
 * so the pipeline re-generates it on next start.
 *
 * Usage (from project root):
 *   node scripts/reset-portrait.js <number>
 *
 * The <number> is the portrait number from the filename, e.g.:
 *   node scripts/reset-portrait.js 5
 *   → resets portrait_character_5.png
 *
 * With no argument, lists all portrait assets:
 *   node scripts/reset-portrait.js
 */

const path = require('path');
const fs = require('fs');

const portraitNum = process.argv[2] ? parseInt(process.argv[2], 10) : null;

(async () => {
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();

  // Find DB — same path as main.js uses
  const appData = process.env.APPDATA || path.join(require('os').homedir(), 'AppData', 'Roaming');
  const dbPath = path.join(appData, 'nollywood-ai-pipeline', 'nollywood-pipeline.sqlite');

  if (!fs.existsSync(dbPath)) {
    console.error(`DB not found at: ${dbPath}`);
    process.exit(1);
  }

  const buffer = fs.readFileSync(dbPath);
  const db = new SQL.Database(buffer);

  // Find the active project
  const projects = db.exec("SELECT id, title, stage, project_dir FROM projects WHERE stage NOT IN ('completed','abandoned') ORDER BY created_at DESC LIMIT 1");
  if (!projects.length || !projects[0].values.length) {
    console.error('No active project found');
    db.close();
    process.exit(1);
  }

  const [projectId, title, currentStage, projectDir] = projects[0].values[0];
  console.log(`Project: "${title}" (id=${projectId}, stage=${currentStage})`);

  // Get ALL portrait assets for this project
  const allResult = db.exec(`SELECT id, character_id, status, file_path, cdn_url FROM project_assets WHERE project_id = '${projectId}' AND type = 'portrait' ORDER BY id`);
  if (!allResult.length || !allResult[0].values.length) {
    console.error('No portrait assets found for this project');
    db.close();
    process.exit(1);
  }

  const allAssets = allResult[0].values;
  console.log(`\nPortrait assets (${allAssets.length} total):`);
  for (let i = 0; i < allAssets.length; i++) {
    const [id, charId, status, fp, cdn] = allAssets[i];
    const filename = fp ? path.basename(fp) : '(no file)';
    const marker = (portraitNum !== null && filename.includes(`_${portraitNum}.`)) ? ' ← TARGET' : '';
    console.log(`  [${i + 1}] id=${id} char=${charId} status=${status} file=${filename} cdn=${cdn ? 'yes' : 'no'}${marker}`);
  }

  if (portraitNum === null) {
    console.log('\nTo reset a portrait, run: node scripts/reset-portrait.js <number>');
    db.close();
    process.exit(0);
  }

  // Find the asset by matching filename pattern (portrait_character_N.png)
  const target = allAssets.find(row => {
    const fp = row[3]; // file_path
    if (!fp) return false;
    return path.basename(fp) === `portrait_character_${portraitNum}.png`;
  });

  if (!target) {
    console.error(`\nNo portrait asset with filename portrait_character_${portraitNum}.png found`);
    db.close();
    process.exit(1);
  }

  const [assetId, charId, status, filePath, cdnUrl] = target;
  console.log(`\nResetting: asset id=${assetId}, character_id=${charId}, status=${status}`);

  // Reset asset in DB
  db.run("UPDATE project_assets SET status = 'pending', error_message = NULL, cdn_url = NULL, file_path = NULL, gen_clicked_at = NULL WHERE id = ?", [assetId]);
  console.log(`  ✓ Asset reset to pending (cdn_url cleared)`);

  // Delete file from disk
  if (filePath && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    console.log(`  ✓ Deleted: ${filePath}`);
  } else if (filePath) {
    console.log(`  File already missing: ${filePath}`);
  }

  // Also try project dir path
  if (projectDir) {
    const altPath = path.join(projectDir, 'assets', 'portraits', `portrait_character_${portraitNum}.png`);
    if (altPath !== filePath && fs.existsSync(altPath)) {
      fs.unlinkSync(altPath);
      console.log(`  ✓ Deleted: ${altPath}`);
    }
  }

  // Roll stage back to script-done
  db.run("UPDATE projects SET stage = 'script-done', updated_at = datetime('now') WHERE id = ?", [projectId]);
  console.log(`  ✓ Stage rolled back: ${currentStage} → script-done`);

  // Save DB
  const data = db.export();
  const outBuffer = Buffer.from(data);
  fs.writeFileSync(dbPath, outBuffer);
  console.log(`  ✓ Database saved`);

  db.close();
  console.log(`\nDone! Restart the app — portrait ${portraitNum} will regenerate.`);
})();
