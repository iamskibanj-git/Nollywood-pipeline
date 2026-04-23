/**
 * fix-element-suffix.js — Persist the correct element name suffix to DB settings.
 *
 * Fixes the date-rollover bug where the pipeline generates _0422 names after
 * midnight when the elements were created as _0421.
 *
 * Usage: node scripts/fix-element-suffix.js [suffix]
 *   e.g. node scripts/fix-element-suffix.js towwf_0421
 *
 * If no suffix is provided, it scans portrait assets for existing element_name
 * entries and extracts the suffix from there.
 */
const path = require('path');
const db = require('../src/main/database/db');

// Determine DB path
const userDataPath = process.env.APPDATA
  ? path.join(process.env.APPDATA, 'nollywood-ai-pipeline')
  : path.join(require('os').homedir(), '.config', 'nollywood-ai-pipeline');
const dbPath = path.join(userDataPath, 'nollywood-pipeline.sqlite');

async function main() {
  await db.init(dbPath);
  console.log(`Database: ${dbPath}\n`);

  // Find the active project
  const project = db.getActiveProject();
  if (!project) {
    console.log('No active project found.');
    process.exit(1);
  }
  console.log(`Active project: ${project.id}`);
  console.log(`Title: ${project.title}`);
  console.log(`Stage: ${project.stage}`);

  let settings = project.settings ? (typeof project.settings === 'string' ? JSON.parse(project.settings) : project.settings) : {};
  // Guard against double-encoded JSON from earlier buggy script runs
  if (typeof settings === 'string') { try { settings = JSON.parse(settings); } catch (_) { settings = {}; } }
  console.log(`Current settings.element_name_suffix: ${settings.element_name_suffix || '(not set)'}`);

  // Determine the correct suffix
  let suffix = process.argv[2];

  if (!suffix) {
    // Scan portrait assets for element names to extract suffix
    const portraits = db.getAssets(project.id, { type: 'portrait' }).filter(a => a.element_name);
    if (portraits.length > 0) {
      const sampleName = portraits[0].element_name;
      // Pattern: baseName_suffix  where suffix = acronym_MMDD
      const match = sampleName.match(/_([a-z]+_\d{4})$/);
      if (match) {
        suffix = match[1];
        console.log(`\nExtracted suffix from portrait "${sampleName}": ${suffix}`);
      }
    }

    // Also check location assets
    if (!suffix) {
      const locations = db.getAssets(project.id, { type: 'location_image' }).filter(a => a.element_name);
      if (locations.length > 0) {
        const sampleName = locations[0].element_name;
        const match = sampleName.match(/_([a-z]+_\d{4})$/);
        if (match) {
          suffix = match[1];
          console.log(`\nExtracted suffix from location "${sampleName}": ${suffix}`);
        }
      }
    }
  }

  if (!suffix) {
    console.log('\nNo suffix found in DB and none provided on command line.');
    console.log('Usage: node scripts/fix-element-suffix.js towwf_0421');
    process.exit(1);
  }

  console.log(`\nSetting element_name_suffix = "${suffix}"`);
  settings.element_name_suffix = suffix;
  db.updateProject(project.id, { settings: JSON.stringify(settings) });
  console.log('Done! The pipeline will now use this suffix on next restart.');
}

main().catch(e => { console.error(e); process.exit(1); });
