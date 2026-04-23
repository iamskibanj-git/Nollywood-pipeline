#!/usr/bin/env node
/**
 * Clear vision_blocking_verified flag for specific scene(s) so the 2nd Vision
 * pass re-runs on next app launch. This is needed when the 2nd Vision pass
 * misidentified characters (e.g. swapped driver/passenger) and the stale
 * blocking was persisted to DB.
 *
 * Usage:
 *   node scripts/clear-vision-verified.js                      — dry run (audit all verified scenes)
 *   node scripts/clear-vision-verified.js --scene 1_5 --commit — clear Ch1 Sc5
 *   node scripts/clear-vision-verified.js --all --commit        — clear ALL verified scenes
 *
 * The app must be CLOSED before running this script.
 */

const path = require('path');
const fs = require('fs');

const DRY_RUN = !process.argv.includes('--commit');
const CLEAR_ALL = process.argv.includes('--all');
const sceneArg = process.argv.find((a, i) => process.argv[i - 1] === '--scene');

async function main() {
  const initSqlJs = require('sql.js');

  const appName = 'nollywood-ai-pipeline';
  const appData = process.env.APPDATA || path.join(require('os').homedir(), 'AppData', 'Roaming');
  const dbPath = path.join(appData, appName, 'nollywood-pipeline.sqlite');

  if (!fs.existsSync(dbPath)) {
    console.error(`Database not found at: ${dbPath}`);
    process.exit(1);
  }

  console.log('═══════════════════════════════════════════════════════');
  console.log('  CLEAR VISION BLOCKING VERIFIED — ' + (DRY_RUN ? 'DRY RUN' : 'COMMIT'));
  console.log('═══════════════════════════════════════════════════════');
  console.log(`Database: ${dbPath}`);
  console.log();

  const SQL = await initSqlJs();
  const buffer = fs.readFileSync(dbPath);
  const db = new SQL.Database(buffer);

  // Find active project
  const projects = db.exec(`SELECT id, title FROM projects ORDER BY created_at DESC LIMIT 1`);
  if (!projects[0] || projects[0].values.length === 0) {
    console.error('No projects found.');
    process.exit(1);
  }
  const [projectId, title] = projects[0].values[0];
  console.log(`Project: ${title}`);
  console.log();

  // Get all cinematic scene assets with prompt_used
  const scenes = db.exec(`
    SELECT id, chapter, scene, prompt_used
    FROM project_assets
    WHERE project_id = '${projectId}' AND type = 'scene_image_cinematic' AND status = 'done'
    ORDER BY chapter, scene
  `);

  if (!scenes[0]) {
    console.log('No scene assets found.');
    db.close();
    return;
  }

  const verifiedScenes = [];
  for (const [id, ch, sc, promptUsedRaw] of scenes[0].values) {
    if (!promptUsedRaw) continue;
    try {
      const pu = JSON.parse(promptUsedRaw);
      if (pu.vision_blocking_verified === true) {
        verifiedScenes.push({ id, ch, sc, pu, key: `${ch}_${sc}` });
      }
    } catch (_) {}
  }

  console.log(`── VERIFIED SCENES (${verifiedScenes.length} total) ──`);
  for (const s of verifiedScenes) {
    const hadCorr = s.pu.blocking_had_corrections === true ? ' [had corrections]' : '';
    const chars = (s.pu.vision_refined_characters || []).map(c => c.name || c.baseName).join(', ');
    console.log(`  Ch${s.ch} Sc${s.sc} (${s.key})${hadCorr} — ${chars}`);
  }
  console.log();

  // Determine which scenes to clear
  let targetScenes = [];
  if (CLEAR_ALL) {
    targetScenes = verifiedScenes;
    console.log('Target: ALL verified scenes');
  } else if (sceneArg) {
    targetScenes = verifiedScenes.filter(s => s.key === sceneArg);
    if (targetScenes.length === 0) {
      console.log(`Scene ${sceneArg} not found or not verified. Available: ${verifiedScenes.map(s => s.key).join(', ')}`);
      db.close();
      return;
    }
    console.log(`Target: Ch${targetScenes[0].ch} Sc${targetScenes[0].sc}`);
  } else {
    console.log('No target specified. Use --scene <ch>_<sc> or --all');
    console.log(`Available: ${verifiedScenes.map(s => s.key).join(', ')}`);
    console.log();
    console.log('Example: node scripts/clear-vision-verified.js --scene 1_5 --commit');
    db.close();
    return;
  }
  console.log();

  if (DRY_RUN) {
    console.log('DRY RUN — no changes made. Add --commit to apply.');
    db.close();
    return;
  }

  // Clear the flags
  for (const s of targetScenes) {
    delete s.pu.vision_blocking_verified;
    delete s.pu.blocking_had_corrections;
    // Keep vision_refined_characters — the 2nd pass will overwrite them
    db.run(`UPDATE project_assets SET prompt_used = ? WHERE id = ?`, [JSON.stringify(s.pu), s.id]);
    console.log(`  ✓ Cleared Ch${s.ch} Sc${s.sc} (asset ${s.id})`);
  }

  // Save
  const data = db.export();
  const outBuffer = Buffer.from(data);
  fs.writeFileSync(dbPath, outBuffer);
  console.log();
  console.log(`✓ Database saved (${(outBuffer.length / 1024).toFixed(0)} KB)`);
  console.log('  Restart the app — 2nd Vision pass will re-run for cleared scenes.');
  db.close();
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
