#!/usr/bin/env node
/**
 * Swap character positions for a specific scene where Vision misidentified
 * who is who (e.g. assigned the wrong person as driver/passenger).
 *
 * This swaps the position descriptions between two characters while keeping
 * their names/element references correct.
 *
 * Usage:
 *   node scripts/swap-scene-blocking.js --scene 1_5              — dry run (show current positions)
 *   node scripts/swap-scene-blocking.js --scene 1_5 --commit     — swap and persist
 *
 * The app must be CLOSED before running this script.
 */

const path = require('path');
const fs = require('fs');

const DRY_RUN = !process.argv.includes('--commit');
const sceneArg = process.argv.find((a, i) => process.argv[i - 1] === '--scene');

async function main() {
  if (!sceneArg) {
    console.error('Usage: node scripts/swap-scene-blocking.js --scene <ch>_<sc> [--commit]');
    console.error('Example: node scripts/swap-scene-blocking.js --scene 1_5 --commit');
    process.exit(1);
  }

  const initSqlJs = require('sql.js');
  const appName = 'nollywood-ai-pipeline';
  const appData = process.env.APPDATA || path.join(require('os').homedir(), 'AppData', 'Roaming');
  const dbPath = path.join(appData, appName, 'nollywood-pipeline.sqlite');

  if (!fs.existsSync(dbPath)) {
    console.error(`Database not found at: ${dbPath}`);
    process.exit(1);
  }

  const [targetCh, targetSc] = sceneArg.split('_').map(Number);
  console.log(`═══════════════════════════════════════════════════════`);
  console.log(`  SWAP SCENE BLOCKING — Ch${targetCh} Sc${targetSc} — ${DRY_RUN ? 'DRY RUN' : 'COMMIT'}`);
  console.log(`═══════════════════════════════════════════════════════`);

  const SQL = await initSqlJs();
  const buffer = fs.readFileSync(dbPath);
  const db = new SQL.Database(buffer);

  // Find project
  const projects = db.exec(`SELECT id, title FROM projects ORDER BY created_at DESC LIMIT 1`);
  if (!projects[0]) { console.error('No project found.'); process.exit(1); }
  const [projectId, title] = projects[0].values[0];
  console.log(`Project: ${title}`);
  console.log();

  // Find scene asset
  const scenes = db.exec(`
    SELECT id, chapter, scene, prompt_used
    FROM project_assets
    WHERE project_id = '${projectId}' AND type = 'scene_image_cinematic'
      AND chapter = ${targetCh} AND scene = ${targetSc} AND status = 'done'
    LIMIT 1
  `);

  if (!scenes[0] || scenes[0].values.length === 0) {
    console.error(`Scene Ch${targetCh} Sc${targetSc} not found.`);
    db.close();
    process.exit(1);
  }

  const [assetId, ch, sc, promptUsedRaw] = scenes[0].values[0];
  const pu = JSON.parse(promptUsedRaw || '{}');
  const chars = pu.vision_refined_characters || [];

  if (chars.length !== 2) {
    console.error(`Expected 2 characters, found ${chars.length}. Swap only works for 2-character scenes.`);
    db.close();
    process.exit(1);
  }

  console.log('── CURRENT POSITIONS ──');
  for (const c of chars) {
    console.log(`  @${c.name}: ${c.position}`);
  }
  console.log();

  // Split each position into SPATIAL part and VISUAL part.
  // Spatial: location, distance, frame placement (before clothing mention)
  // Visual: clothing, pronouns, body details (from "wearing" onward)
  //
  // We swap the SPATIAL parts but keep each character's own VISUAL description.
  const splitPosition = (pos) => {
    // Common split points: "wearing", "dressed in", clothing color mentions
    const wearingMatch = pos.match(/,?\s*(wearing\b.*)/i);
    if (wearingMatch) {
      const spatialEnd = pos.indexOf(wearingMatch[0]);
      return {
        spatial: pos.slice(0, spatialEnd).replace(/,\s*$/, ''),
        visual: wearingMatch[1],
      };
    }
    // Fallback: try to split at pronoun boundaries
    const pronounMatch = pos.match(/,?\s*(his\b|her\b|their\b)/i);
    if (pronounMatch) {
      const spatialEnd = pos.indexOf(pronounMatch[0]);
      return {
        spatial: pos.slice(0, spatialEnd).replace(/,\s*$/, ''),
        visual: pos.slice(spatialEnd).replace(/^,?\s*/, ''),
      };
    }
    // No clear split — return as all spatial
    return { spatial: pos, visual: '' };
  };

  const parts = chars.map(c => splitPosition(c.position));

  console.log('── SPLIT ANALYSIS ──');
  for (let i = 0; i < chars.length; i++) {
    console.log(`  @${chars[i].name}:`);
    console.log(`    SPATIAL: ${parts[i].spatial}`);
    console.log(`    VISUAL:  ${parts[i].visual}`);
  }
  console.log();

  // Swap spatial parts, keep each character's own visual description
  const swapped = [
    {
      name: chars[0].name,
      baseName: chars[0].baseName,
      position: parts[1].spatial + (parts[0].visual ? ', ' + parts[0].visual : ''),
    },
    {
      name: chars[1].name,
      baseName: chars[1].baseName,
      position: parts[0].spatial + (parts[1].visual ? ', ' + parts[1].visual : ''),
    },
  ];

  console.log('── SWAPPED POSITIONS ──');
  for (const c of swapped) {
    console.log(`  @${c.name}: ${c.position}`);
  }
  console.log();

  if (DRY_RUN) {
    console.log('DRY RUN — no changes made. Add --commit to apply.');
    db.close();
    return;
  }

  // Update DB
  pu.vision_refined_characters = swapped;
  pu.vision_blocking_verified = true;
  pu.blocking_had_corrections = true;
  pu.manually_swapped = true;

  db.run(`UPDATE project_assets SET prompt_used = ? WHERE id = ?`, [JSON.stringify(pu), assetId]);

  const data = db.export();
  const outBuffer = Buffer.from(data);
  fs.writeFileSync(dbPath, outBuffer);
  console.log(`✓ Positions swapped and saved (${(outBuffer.length / 1024).toFixed(0)} KB)`);
  console.log('  Restart the app — corrected positions will be used.');
  db.close();
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
