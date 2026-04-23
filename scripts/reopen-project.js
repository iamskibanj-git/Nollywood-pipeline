#!/usr/bin/env node
/**
 * Re-open a completed project for re-assembly or further edits.
 *
 * Lists completed projects (those with completed_at NOT NULL), lets you pick
 * one, then resets: completed_at=NULL, stage=videos-done, and deletes any
 * existing final output video so assembly re-runs on next launch.
 *
 * Usage:
 *   node scripts/reopen-project.js                — interactive picker
 *   node scripts/reopen-project.js --latest       — reopen most recent completed
 *   node scripts/reopen-project.js --latest --stage=scenes-done
 *       ↑ reopen at a specific stage (default: videos-done)
 *   node scripts/reopen-project.js --keep-output  — don't delete final output
 *
 * The app must be CLOSED before running this script.
 *
 * Stage options:
 *   portraits-done → reopens at scene approval gate (re-runs video gen too)
 *   scenes-done    → reopens at scene approval gate (re-runs video gen)
 *   videos-done    → reopens at clip approval gate (re-runs assembly only)  [default]
 */

const path = require('path');
const fs = require('fs');
const readline = require('readline');

const LATEST = process.argv.includes('--latest');
const KEEP_OUTPUT = process.argv.includes('--keep-output');
const stageArg = process.argv.find(a => a.startsWith('--stage='));
const TARGET_STAGE = stageArg ? stageArg.split('=')[1] : 'videos-done';

const VALID_STAGES = ['portraits-done', 'scenes-done', 'videos-done'];
if (!VALID_STAGES.includes(TARGET_STAGE)) {
  console.error(`Invalid --stage=${TARGET_STAGE}. Use one of: ${VALID_STAGES.join(', ')}`);
  process.exit(1);
}

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main() {
  const initSqlJs = require('sql.js');
  const appName = 'nollywood-ai-pipeline';
  const appData = process.env.APPDATA || path.join(require('os').homedir(), 'AppData', 'Roaming');
  const dbPath = path.join(appData, appName, 'nollywood-pipeline.sqlite');

  if (!fs.existsSync(dbPath)) {
    console.error(`Database not found at: ${dbPath}`);
    process.exit(1);
  }

  const SQL = await initSqlJs();
  const buffer = fs.readFileSync(dbPath);
  const db = new SQL.Database(buffer);

  // List completed projects
  const res = db.exec(
    `SELECT id, title, stage, project_dir, created_at, completed_at
     FROM projects WHERE completed_at IS NOT NULL
     ORDER BY completed_at DESC`
  );

  if (!res[0] || !res[0].values.length) {
    console.log('No completed projects found.');
    db.close();
    return;
  }

  const projects = res[0].values.map(row => ({
    id: row[0], title: row[1], stage: row[2],
    projectDir: row[3], createdAt: row[4], completedAt: row[5],
  }));

  console.log(`\nCompleted projects:`);
  projects.forEach((p, i) => {
    console.log(`  [${i + 1}] ${p.title}`);
    console.log(`      completed: ${p.completedAt}, stage was: ${p.stage}`);
  });

  let chosen;
  if (LATEST) {
    chosen = projects[0];
    console.log(`\nReopening latest: "${chosen.title}"`);
  } else if (projects.length === 1) {
    chosen = projects[0];
    console.log(`\nOnly one completed project found: "${chosen.title}"`);
  } else {
    const answer = await ask(`\nEnter number to reopen (1-${projects.length}): `);
    const idx = parseInt(answer, 10) - 1;
    if (isNaN(idx) || idx < 0 || idx >= projects.length) {
      console.error('Invalid selection.');
      db.close();
      process.exit(1);
    }
    chosen = projects[idx];
  }

  // Check: is there already an active project? Warn before reopening.
  const activeCheck = db.exec(
    `SELECT id, title FROM projects WHERE completed_at IS NULL ORDER BY created_at DESC LIMIT 1`
  );
  if (activeCheck[0] && activeCheck[0].values.length) {
    const active = activeCheck[0].values[0];
    console.warn(`\n⚠ Warning: there's already an active project "${active[1]}" (${active[0]}).`);
    console.warn(`  The app only shows ONE active project — reopening this one will compete with it.`);
    if (!LATEST) {
      const ans = await ask('  Continue anyway? [y/N]: ');
      if (ans.toLowerCase() !== 'y') {
        console.log('Aborted.');
        db.close();
        return;
      }
    }
  }

  // Reopen: clear completed_at, set target stage
  console.log(`\nReopening project at stage "${TARGET_STAGE}"...`);
  db.run(
    `UPDATE projects SET completed_at = NULL, stage = ?, updated_at = datetime('now')
     WHERE id = ?`,
    [TARGET_STAGE, chosen.id]
  );

  // Delete final output video so assembly re-runs (unless --keep-output)
  if (!KEEP_OUTPUT && chosen.projectDir) {
    const outputDir = path.join(chosen.projectDir, 'output');
    if (fs.existsSync(outputDir)) {
      const files = fs.readdirSync(outputDir);
      const videoFiles = files.filter(f => /\.(mp4|mov|mkv)$/i.test(f));
      for (const f of videoFiles) {
        const fp = path.join(outputDir, f);
        try {
          fs.unlinkSync(fp);
          console.log(`  Deleted old output: ${f}`);
        } catch (e) {
          console.warn(`  Could not delete ${f}: ${e.message}`);
        }
      }
    }
  }

  // Save
  const data = db.export();
  fs.writeFileSync(dbPath, Buffer.from(data));
  db.close();

  console.log(`\n✓ Project "${chosen.title}" reopened at stage "${TARGET_STAGE}".`);
  console.log(`✓ Old output video(s) deleted${KEEP_OUTPUT ? ' (skipped by --keep-output)' : ''}.`);
  console.log(`\nNow open the app. It will resume at the ${TARGET_STAGE === 'videos-done' ? 'clip approval gate' : 'appropriate stage'}.`);
  console.log(`After approval, assembly will re-run with the latest code (audio-drift fix, no branding).`);
}

main().then(() => process.exit(0)).catch(err => {
  console.error('Error:', err.message);
  console.error(err.stack);
  process.exit(1);
});
