#!/usr/bin/env node
/**
 * Wipe the active (in-progress) project completely so the app shows
 * the "Start Research" button on next launch.
 *
 * Usage:
 *   node scripts/wipe-project.js              — interactive: shows what will be wiped, asks confirmation
 *   node scripts/wipe-project.js --force      — skip confirmation
 *   node scripts/wipe-project.js --keep-files — wipe DB rows but leave files on disk
 *
 * What it does:
 *   1. Finds the active project (completed_at IS NULL)
 *   2. Deletes all rows in project_assets for that project
 *   3. Deletes all rows in pipeline_events for that project
 *   4. Deletes the project row itself
 *   5. Deletes the project_dir folder on disk (unless --keep-files)
 *   6. Saves the database
 *
 * The app must be CLOSED before running this script.
 *
 * Auth/session cookies (higgsfield-session.json) are PRESERVED so you
 * stay logged into Higgsfield. Research cache, used_videos, and
 * produced_titles are also preserved (those are project-independent).
 */

const path = require('path');
const fs = require('fs');
const readline = require('readline');

const FORCE = process.argv.includes('--force');
const KEEP_FILES = process.argv.includes('--keep-files');

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

function rmrf(target) {
  if (!fs.existsSync(target)) return 0;
  let count = 0;
  const stat = fs.statSync(target);
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(target)) {
      count += rmrf(path.join(target, entry));
    }
    fs.rmdirSync(target);
  } else {
    fs.unlinkSync(target);
    count = 1;
  }
  return count;
}

async function main() {
  const initSqlJs = require('sql.js');

  // Electron userData path — Windows: %APPDATA%/nollywood-ai-pipeline
  const appName = 'nollywood-ai-pipeline';
  const appData = process.env.APPDATA || path.join(require('os').homedir(), 'AppData', 'Roaming');
  const dbPath = path.join(appData, appName, 'nollywood-pipeline.sqlite');

  if (!fs.existsSync(dbPath)) {
    console.error(`Database not found at: ${dbPath}`);
    console.error('Nothing to wipe — the app has never been run on this machine.');
    process.exit(1);
  }

  console.log(`Database: ${dbPath}`);
  console.log();

  const SQL = await initSqlJs();
  const buffer = fs.readFileSync(dbPath);
  const db = new SQL.Database(buffer);

  // ── Find the active project ──
  const activeResult = db.exec(
    `SELECT id, title, stage, project_dir, created_at FROM projects WHERE completed_at IS NULL ORDER BY created_at DESC`
  );

  if (!activeResult[0] || activeResult[0].values.length === 0) {
    console.log('No active project found. The app should already show "Start Research".');
    db.close();
    return;
  }

  console.log(`Found ${activeResult[0].values.length} active project(s):`);
  console.log();

  const projectsToWipe = [];
  for (const row of activeResult[0].values) {
    const [id, title, stage, projectDir, createdAt] = row;

    // Count assets for this project
    const assetCounts = db.exec(
      `SELECT type, status, COUNT(*) FROM project_assets WHERE project_id = '${id}' GROUP BY type, status`
    );

    console.log(`  Project: ${title}`);
    console.log(`    ID: ${id}`);
    console.log(`    Stage: ${stage}`);
    console.log(`    Created: ${createdAt}`);
    console.log(`    Folder: ${projectDir || '(none)'}`);

    let totalAssets = 0;
    if (assetCounts[0]) {
      console.log(`    Assets:`);
      for (const r of assetCounts[0].values) {
        console.log(`      ${r[0]}/${r[1]}: ${r[2]}`);
        totalAssets += r[2];
      }
    } else {
      console.log(`    Assets: (none)`);
    }

    // Folder size if it exists
    let folderExists = false;
    let folderSize = 0;
    if (projectDir && fs.existsSync(projectDir)) {
      folderExists = true;
      try {
        const walk = (p) => {
          const stat = fs.statSync(p);
          if (stat.isDirectory()) {
            for (const e of fs.readdirSync(p)) walk(path.join(p, e));
          } else {
            folderSize += stat.size;
          }
        };
        walk(projectDir);
      } catch (_) {}
      console.log(`    Folder size: ${(folderSize / (1024 * 1024)).toFixed(1)} MB`);
    }

    projectsToWipe.push({ id, title, projectDir, totalAssets, folderExists, folderSize });
    console.log();
  }

  // ── Confirmation ──
  if (!FORCE) {
    console.log(`This will PERMANENTLY DELETE:`);
    console.log(`  - ${projectsToWipe.length} project row(s)`);
    console.log(`  - ${projectsToWipe.reduce((s, p) => s + p.totalAssets, 0)} asset row(s)`);
    console.log(`  - All pipeline_events for these projects`);
    if (!KEEP_FILES) {
      const totalMB = projectsToWipe.reduce((s, p) => s + p.folderSize, 0) / (1024 * 1024);
      console.log(`  - Project folders on disk (${totalMB.toFixed(1)} MB total)`);
    } else {
      console.log(`  - (Files on disk will be KEPT — --keep-files flag)`);
    }
    console.log();
    console.log(`PRESERVED:`);
    console.log(`  - Higgsfield session cookies (you stay logged in)`);
    console.log(`  - Research cache, used_videos, produced_titles`);
    console.log();

    const answer = await ask('Type "wipe" to confirm: ');
    if (answer !== 'wipe') {
      console.log('Aborted.');
      db.close();
      return;
    }
  }

  // ── Perform the wipe ──
  console.log();
  let totalDeletedRows = 0;
  let totalDeletedFiles = 0;

  for (const proj of projectsToWipe) {
    console.log(`Wiping project: ${proj.title}`);

    // Delete pipeline_events (if table exists)
    try {
      db.run(`DELETE FROM pipeline_events WHERE project_id = '${proj.id}'`);
      const events = db.exec(`SELECT changes()`);
      const eventCount = events[0]?.values[0][0] || 0;
      if (eventCount > 0) {
        console.log(`  ✓ Deleted ${eventCount} pipeline event(s)`);
        totalDeletedRows += eventCount;
      }
    } catch (e) {
      // pipeline_events table may not exist if migration 003 hasn't run
      console.log(`  (pipeline_events table not present, skipping)`);
    }

    // Delete assets
    db.run(`DELETE FROM project_assets WHERE project_id = '${proj.id}'`);
    const assetsResult = db.exec(`SELECT changes()`);
    const assetCount = assetsResult[0]?.values[0][0] || 0;
    console.log(`  ✓ Deleted ${assetCount} asset row(s)`);
    totalDeletedRows += assetCount;

    // Delete project row
    db.run(`DELETE FROM projects WHERE id = '${proj.id}'`);
    console.log(`  ✓ Deleted project row`);
    totalDeletedRows += 1;

    // Delete files on disk
    if (!KEEP_FILES && proj.folderExists) {
      try {
        const fileCount = rmrf(proj.projectDir);
        console.log(`  ✓ Deleted ${fileCount} file(s) from ${proj.projectDir}`);
        totalDeletedFiles += fileCount;
      } catch (e) {
        console.warn(`  ⚠ Could not delete folder: ${e.message}`);
      }
    }
    console.log();
  }

  // ── Save database ──
  const data = db.export();
  fs.writeFileSync(dbPath, Buffer.from(data));
  db.close();

  console.log(`──────────────────────────────────────`);
  console.log(`✓ Wipe complete:`);
  console.log(`  - ${totalDeletedRows} DB rows deleted`);
  console.log(`  - ${totalDeletedFiles} files deleted`);
  console.log(`  - Database saved`);
  console.log();
  console.log(`Open the app — you should see the Start Research button.`);
}

main().catch(err => {
  console.error('Error:', err.message);
  console.error(err.stack);
  process.exit(1);
});
