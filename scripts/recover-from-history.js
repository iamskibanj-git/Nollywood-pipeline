#!/usr/bin/env node
/**
 * Recover orphaned video clips from Higgsfield's Asset History.
 *
 * Use case: pipeline crashed mid-generation; some clips were generated server-side
 * but the local download/CDN-URL-capture failed. This tool scrapes Higgsfield's
 * /asset/all page, fuzzy-matches scraped videos against pending DB clips by prompt
 * + timestamp, and downloads matched orphans into the project — saving credits.
 *
 * Usage:
 *   node scripts/recover-from-history.js                     — interactive (default)
 *   node scripts/recover-from-history.js --auto              — auto-apply HIGH confidence only
 *   node scripts/recover-from-history.js --dry-run           — scan + match, no downloads
 *   node scripts/recover-from-history.js --max-age-hours=48  — broader scrape window
 *   node scripts/recover-from-history.js --project-dir=<path>  — target a specific project
 *
 * The app must be CLOSED before running this script (it spins up its own Playwright
 * instance and uses the saved Higgsfield session cookies).
 */

const path = require('path');
const fs = require('fs');
const readline = require('readline');

const args = {};
for (const a of process.argv.slice(2)) {
  if (a.startsWith('--')) {
    const [k, ...rest] = a.slice(2).split('=');
    args[k] = rest.length ? rest.join('=') : true;
  }
}

const DRY_RUN = args['dry-run'] === true;
const AUTO_ONLY = args.auto === true;
const MAX_AGE_HOURS = Number(args['max-age-hours']) || 24;
const PROJECT_DIR_ARG = args['project-dir'] || null;

function ask(q) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(q, ans => { rl.close(); resolve(ans); });
  });
}

const colors = {
  reset: '\x1b[0m', dim: '\x1b[2m',
  green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m',
};
const c = (color, s) => `${colors[color]}${s}${colors.reset}`;

async function main() {
  const initSqlJs = require('sql.js');
  const appName = 'nollywood-ai-pipeline';
  const appData = process.env.APPDATA || path.join(require('os').homedir(), 'AppData', 'Roaming');
  const dbPath = path.join(appData, appName, 'nollywood-pipeline.sqlite');

  if (!fs.existsSync(dbPath)) {
    console.error(`Database not found: ${dbPath}`);
    process.exit(1);
  }

  const SQL = await initSqlJs();
  const db = new SQL.Database(fs.readFileSync(dbPath));

  // Find target project
  let projRes;
  if (PROJECT_DIR_ARG) {
    projRes = db.exec(
      `SELECT id, title, project_dir FROM projects WHERE project_dir = ? OR project_dir LIKE ?`,
      [PROJECT_DIR_ARG, `%${path.basename(PROJECT_DIR_ARG)}%`]
    );
  } else {
    projRes = db.exec(
      `SELECT id, title, project_dir FROM projects
       WHERE completed_at IS NULL ORDER BY created_at DESC LIMIT 1`
    );
  }

  if (!projRes[0] || !projRes[0].values.length) {
    console.error('No matching project found.');
    db.close();
    process.exit(1);
  }
  const [projectId, title, projectDir] = projRes[0].values[0];
  console.log(`\nProject: ${c('cyan', title)}`);
  console.log(`Folder:  ${projectDir}\n`);

  // Load pending clips that are recovery candidates
  const candRes = db.exec(
    `SELECT id, chapter, line, status, prompt_used, file_path, created_at FROM project_assets
     WHERE project_id = '${projectId}' AND type = 'video_clip'
       AND status IN ('pending', 'failed')
       AND (cdn_url IS NULL OR cdn_url = '')
       AND prompt_used IS NOT NULL
     ORDER BY chapter, line`
  );

  if (!candRes[0] || !candRes[0].values.length) {
    console.log(c('green', 'No pending clips to recover. Either everything is done, or all pending clips lack a recorded prompt.'));
    db.close();
    return;
  }

  const candidates = candRes[0].values.map(([id, chapter, line, status, prompt_used, file_path, created_at]) => ({
    id, chapter, line, status, prompt_used, file_path, created_at,
  }));
  console.log(`Found ${c('yellow', candidates.length)} clip(s) needing recovery:`);
  for (const c2 of candidates) {
    console.log(`  Ch${c2.chapter} L${c2.line}  [${c2.status}]  "${(c2.prompt_used || '').slice(0, 80)}..."`);
  }
  console.log();

  // Spin up Playwright via existing automation
  const { HiggsFieldAutomation } = require('../src/main/automation/higgsfield');
  const { HiggsfieldHistory } = require('../src/main/automation/higgsfield-history');
  const { matchAll } = require('../src/main/recovery/clipMatcher');

  console.log(c('dim', '[1/4] Launching Playwright...'));
  const automation = new HiggsFieldAutomation(null, projectDir);
  await automation.ensureBrowser();

  const history = new HiggsfieldHistory({
    automation,
    logger: (msg) => console.log(c('dim', `      ${msg}`)),
  });

  console.log(c('dim', `[2/4] Scraping Higgsfield assets (last ${MAX_AGE_HOURS}h)...`));
  let videos;
  try {
    videos = await history.scrapeRecentVideos({ maxAgeHours: MAX_AGE_HOURS });
  } catch (e) {
    console.error(c('red', `Scrape failed: ${e.message}`));
    await automation.close();
    db.close();
    process.exit(1);
  }
  console.log(`      Found ${c('cyan', videos.length)} video(s) in history`);

  // Hydrate prompts for each scraped video (the grid scrape might not include them)
  console.log(c('dim', '[3/4] Loading asset details for matching...'));
  let hydrated = 0;
  for (const v of videos) {
    if (!v.prompt) {
      try {
        const details = await history.getAssetDetails(v.uuid);
        if (details) {
          Object.assign(v, details);
          hydrated++;
        }
      } catch (e) {
        // continue — partial data still useful
      }
    }
  }
  console.log(`      Hydrated ${hydrated} asset detail(s)`);

  // Match
  console.log(c('dim', '[4/4] Matching candidates to history items...'));
  const matches = matchAll(candidates, videos);

  // Print result table
  console.log(`\n${'─'.repeat(80)}`);
  console.log(`Recovery plan:\n`);
  const tierColor = (t) => t === 'high' ? 'green' : t === 'medium' ? 'yellow' : t === 'low' ? 'red' : 'dim';
  for (const cand of candidates) {
    const m = matches.find(x => x.asset.id === cand.id);
    if (!m) {
      console.log(`  Ch${cand.chapter} L${cand.line}  ${c('dim', 'no match — will need regeneration')}`);
    } else {
      console.log(`  Ch${cand.chapter} L${cand.line}  ${c(tierColor(m.confidence), m.confidence.toUpperCase().padEnd(7))} score=${m.score}%  → ${m.video.uuid.slice(0, 8)}...`);
      console.log(`    expected:    "${(cand.prompt_used || '').slice(0, 70)}..."`);
      console.log(`    matched to:  "${(m.video.prompt || '(empty)').slice(0, 70)}..."`);
    }
  }
  console.log();

  if (DRY_RUN) {
    console.log(c('cyan', 'DRY RUN — no downloads performed. Re-run without --dry-run to apply.'));
    await automation.close();
    db.close();
    return;
  }

  // Apply: download high-confidence (auto), prompt user for medium, skip low
  console.log(`${'─'.repeat(80)}`);
  let downloaded = 0, skipped = 0, failed = 0;

  for (const m of matches) {
    const label = `Ch${m.asset.chapter} L${m.asset.line}`;

    if (m.confidence === 'low') {
      console.log(`${c('red', '✗')} ${label}: low confidence (${m.score}%) — skipped`);
      skipped++;
      continue;
    }

    if (m.confidence === 'medium' && !AUTO_ONLY) {
      console.log(`\n${label} (${m.confidence}, ${m.score}%):`);
      console.log(`  expected: "${(m.asset.prompt_used || '').slice(0, 80)}..."`);
      console.log(`  match:    "${(m.video.prompt || '').slice(0, 80)}..."`);
      const ans = await ask(`  Apply? [y/N]: `);
      if (ans.toLowerCase() !== 'y') {
        skipped++;
        continue;
      }
    } else if (m.confidence === 'medium' && AUTO_ONLY) {
      console.log(`${c('yellow', '~')} ${label}: medium confidence — skipped (--auto only applies HIGH)`);
      skipped++;
      continue;
    }

    // Download
    const filename = `ch${String(m.asset.chapter).padStart(2, '0')}_line${String(m.asset.line).padStart(3, '0')}.mp4`;
    const destPath = path.join(projectDir, 'assets', 'clips', filename);

    try {
      console.log(`${c('cyan', '↓')} ${label}: downloading ${m.video.uuid.slice(0, 8)}...`);
      const result = await history.downloadAsset(m.video.uuid, destPath, m.video.cdnUrl);

      // Update DB
      db.run(
        `UPDATE project_assets SET
           status = 'done',
           file_path = ?,
           cdn_url = ?,
           higgsfield_asset_id = ?,
           recovered_from_history = 1,
           error_message = NULL,
           completed_at = datetime('now')
         WHERE id = ?`,
        [destPath, m.video.cdnUrl || null, m.video.uuid, m.asset.id]
      );

      console.log(`${c('green', '✓')} ${label}: recovered (${(result.sizeBytes / 1024).toFixed(0)} KB)`);
      downloaded++;
    } catch (e) {
      console.log(`${c('red', '✗')} ${label}: download failed — ${e.message}`);
      failed++;
    }
  }

  // Save DB
  if (downloaded > 0) {
    fs.writeFileSync(dbPath, Buffer.from(db.export()));
  }

  console.log(`\n${'─'.repeat(80)}`);
  console.log(`Summary:`);
  console.log(`  ${c('green', downloaded)} clip(s) recovered (no credits spent)`);
  console.log(`  ${c('yellow', skipped)} skipped`);
  console.log(`  ${c('red', failed)} failed download`);

  const stillPending = candidates.length - downloaded;
  if (stillPending > 0) {
    console.log(`\n  ${c('yellow', stillPending)} clip(s) still need regeneration. Restart the app and resume.`);
  } else {
    console.log(`\n  ${c('green', 'All clips recovered — restart the app to proceed to next stage.')}`);
  }

  await automation.close();
  db.close();
}

main().then(() => process.exit(0)).catch(err => {
  console.error('Error:', err.message);
  console.error(err.stack);
  process.exit(1);
});
