#!/usr/bin/env node
/**
 * Standalone test for ClipVerifier.
 *
 * Runs Gemini verification against ALL video clips of the active or most
 * recently completed project, prints a colored table of results, and writes
 * full details to a JSON report. Does NOT touch the pipeline or modify the DB.
 *
 * This is for dev iteration on ClipVerifier before it's wired into the pipeline.
 *
 * Usage:
 *   node scripts/test-verify.js                        — latest project, all clips
 *   node scripts/test-verify.js --clip=ch01_line001    — just one clip
 *   node scripts/test-verify.js --concurrency=5        — parallel verification cap
 *   node scripts/test-verify.js --output=results.json  — write full results here
 *
 * Requires GEMINI_API_KEY in the config/settings (same as gemini-analyzer).
 */

const path = require('path');
const fs = require('fs');

const clipFilter   = (process.argv.find(a => a.startsWith('--clip='))       || '').split('=')[1];
const concurrency  = Number((process.argv.find(a => a.startsWith('--concurrency=')) || '').split('=')[1]) || 3;
const outputPath   = (process.argv.find(a => a.startsWith('--output='))     || '').split('=')[1];
const projectDirArg = (process.argv.find(a => a.startsWith('--project-dir=')) || '').split('=')[1];
const latestCompleted = process.argv.includes('--latest-completed');
const listProjects = process.argv.includes('--list');
const backendArg   = (process.argv.find(a => a.startsWith('--backend='))    || '').split('=')[1] || 'gemini';

if (!['whisper', 'gemini'].includes(backendArg)) {
  console.error(`Invalid --backend="${backendArg}" — use "whisper" or "gemini"`);
  process.exit(1);
}

function loadApiKey(backend) {
  const appName = 'nollywood-ai-pipeline';
  const appData = process.env.APPDATA || path.join(require('os').homedir(), 'AppData', 'Roaming');
  const envVarName  = backend === 'whisper' ? 'OPENAI_API_KEY' : 'GEMINI_API_KEY';
  const configField = backend === 'whisper' ? 'openaiApiKey'    : 'geminiApiKey';

  let apiKey = process.env[envVarName];
  const candidateFiles = [
    path.join(appData, appName, 'config.json'),
    path.join(appData, appName, 'settings.json'),
  ];
  if (!apiKey) {
    for (const p of candidateFiles) {
      if (fs.existsSync(p)) {
        try {
          const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
          if (cfg[configField]) {
            apiKey = cfg[configField];
            console.log(`[VERIFY] Loaded ${backend} API key from ${p}`);
            break;
          }
        } catch (_) {}
      }
    }
  }
  if (!apiKey) {
    console.error(`No ${backend} API key found.`);
    console.error(`  Set env var ${envVarName} or add "${configField}": "..." to config.json`);
    if (backend === 'whisper') console.error(`  Get a key: https://platform.openai.com/api-keys`);
    else console.error(`  Get a key: https://aistudio.google.com/app/apikey`);
    return null;
  }
  return apiKey;
}

async function main() {
  const backends = [backendArg];

  // Load API key for the selected backend
  const keys = {};
  for (const b of backends) {
    const k = loadApiKey(b);
    if (!k) process.exit(1);
    keys[b] = k;
  }
  console.log(`[VERIFY] Backend: ${backendArg}`);

  // Open DB and find project
  const appName = 'nollywood-ai-pipeline';
  const appData = process.env.APPDATA || path.join(require('os').homedir(), 'AppData', 'Roaming');
  const initSqlJs = require('sql.js');
  const dbPath = path.join(appData, appName, 'nollywood-pipeline.sqlite');
  if (!fs.existsSync(dbPath)) {
    console.error(`Database not found at: ${dbPath}`);
    process.exit(1);
  }
  const SQL = await initSqlJs();
  const db = new SQL.Database(fs.readFileSync(dbPath));

  // ── Project selection ──
  // --list                    : show all projects and their clip counts, exit
  // --project-dir=<path>      : verify clips from the given project folder
  // --latest-completed        : most recent project where completed_at IS NOT NULL
  // (default)                 : first project that has >0 done video clips
  if (listProjects) {
    const allProjects = db.exec(
      `SELECT p.id, p.title, p.stage, p.project_dir, p.completed_at,
              (SELECT COUNT(*) FROM project_assets
               WHERE project_id = p.id AND type = 'video_clip' AND status = 'done') AS done_clips,
              (SELECT COUNT(*) FROM project_assets
               WHERE project_id = p.id AND type = 'video_clip') AS total_clips
       FROM projects p ORDER BY created_at DESC`
    );
    if (!allProjects[0]) { console.log('No projects.'); db.close(); return; }
    console.log('\nAll projects:');
    for (const r of allProjects[0].values) {
      const [id, t, stage, dir, completedAt, done, total] = r;
      const mark = completedAt ? '✓' : '·';
      console.log(`  ${mark} [${done}/${total} clips done] ${t}`);
      console.log(`      id=${id} stage=${stage}`);
      console.log(`      dir=${dir}`);
    }
    console.log('\nUse --project-dir="<path>" to target a specific one.');
    db.close();
    return;
  }

  let projRes;
  if (projectDirArg) {
    // Normalize path (Windows backslash tolerance)
    const targetDir = projectDirArg.replace(/\\/g, '\\').trim();
    projRes = db.exec(
      `SELECT id, title, project_dir, script_json FROM projects
       WHERE project_dir = ? ORDER BY created_at DESC LIMIT 1`,
      [targetDir]
    );
    if (!projRes[0] || !projRes[0].values.length) {
      // Try partial match on the folder name (the trailing 2026-04-14_xxxx segment)
      const folderName = path.basename(targetDir);
      projRes = db.exec(
        `SELECT id, title, project_dir, script_json FROM projects
         WHERE project_dir LIKE ? ORDER BY created_at DESC LIMIT 1`,
        [`%${folderName}%`]
      );
    }
  } else if (latestCompleted) {
    projRes = db.exec(
      `SELECT id, title, project_dir, script_json FROM projects
       WHERE completed_at IS NOT NULL ORDER BY completed_at DESC LIMIT 1`
    );
  } else {
    // Default: pick the first project that actually has done clips
    projRes = db.exec(
      `SELECT p.id, p.title, p.project_dir, p.script_json FROM projects p
       WHERE (SELECT COUNT(*) FROM project_assets
              WHERE project_id = p.id AND type = 'video_clip' AND status = 'done') > 0
       ORDER BY p.created_at DESC LIMIT 1`
    );
  }
  if (!projRes[0] || !projRes[0].values.length) {
    console.error('No matching project found.');
    console.error('Try: node scripts/test-verify.js --list');
    db.close();
    process.exit(1);
  }
  const [projectId, title, projectDir, scriptJsonRaw] = projRes[0].values[0];
  const script = scriptJsonRaw ? JSON.parse(scriptJsonRaw) : null;

  console.log(`\nProject: ${title}`);
  console.log(`Folder:  ${projectDir}\n`);

  // Get video clips
  const clipsRes = db.exec(
    `SELECT id, chapter, line, status, file_path FROM project_assets
     WHERE project_id = '${projectId}' AND type = 'video_clip'
     ORDER BY chapter, line`
  );
  if (!clipsRes[0] || !clipsRes[0].values.length) {
    console.error('No video clips found for this project.');
    db.close();
    process.exit(1);
  }

  // Build verification items with expected dialogue from the script
  const items = [];
  for (const row of clipsRes[0].values) {
    const [id, chapter, line, status, filePath] = row;
    if (status !== 'done') {
      console.log(`Skipping Ch${chapter} L${line} (status=${status})`);
      continue;
    }
    if (!filePath || !fs.existsSync(filePath)) {
      console.log(`Skipping Ch${chapter} L${line} (file missing: ${filePath})`);
      continue;
    }
    const clipLabel = `Ch${chapter} L${line}`;
    if (clipFilter && !path.basename(filePath).includes(clipFilter)) continue;

    const expected = findExpectedDialogue(script, chapter, line);
    items.push({
      clipPath: filePath,
      expectedDialogue: expected,
      clipLabel,
      assetId: id,
      chapter, line,
    });
  }

  db.close();

  if (items.length === 0) {
    console.log('No matching clips to verify.');
    return;
  }

  console.log(`Verifying ${items.length} clip(s) at concurrency=${concurrency}...\n`);

  const { ClipVerifier } = require(path.join(__dirname, '..', 'src', 'main', 'verify', 'clipVerifier'));
  // Single backend only (compare mode was added but user opted for isolated tests)
  const activeBackend = backends[0];
  const verifier = new ClipVerifier({ apiKey: keys[activeBackend], backend: activeBackend });

  const startedAt = Date.now();
  const results = await verifier.verifyBatch(items, {
    concurrency,
    onProgress: ({ current, total }) => {
      process.stdout.write(`\r[${current}/${total}] verified...`);
    },
  });
  console.log('\n');

  // Print summary table
  const colors = {
    reset: '\x1b[0m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    red:    '\x1b[31m',
    dim:    '\x1b[2m',
  };
  const tierColor = t => t === 'accept' ? colors.green : t === 'review' ? colors.yellow : colors.red;

  console.log('┌────────┬──────┬─────────┬──────────┬──────┬─────────────────────────────────────────────┐');
  console.log('│ Clip   │ Sim% │ Tier    │ Mouth    │ Chars│ Notes                                       │');
  console.log('├────────┼──────┼─────────┼──────────┼──────┼─────────────────────────────────────────────┤');
  for (const r of results) {
    const tier = `${tierColor(r.tier)}${r.tier.padEnd(7)}${colors.reset}`;
    const sim = String(Math.round(r.similarity || 0)).padStart(3);
    const mouth = (r.mouthSync || '').padEnd(8);
    const chars = r.characterCount != null ? String(r.characterCount).padStart(4) : '    ';
    const notes = (r.notes || r.error || '').slice(0, 43).padEnd(43);
    console.log(`│ ${r.clipLabel.padEnd(6)} │ ${sim}% │ ${tier} │ ${mouth} │${chars}  │ ${notes} │`);
  }
  console.log('└────────┴──────┴─────────┴──────────┴──────┴─────────────────────────────────────────────┘');

  const accepts = results.filter(r => r.tier === 'accept').length;
  const reviews = results.filter(r => r.tier === 'review').length;
  const rejects = results.filter(r => r.tier === 'reject').length;
  const elapsed = Math.round((Date.now() - startedAt) / 1000);

  console.log(`\nTotals: ${colors.green}${accepts} accept${colors.reset} | ${colors.yellow}${reviews} review${colors.reset} | ${colors.red}${rejects} reject${colors.reset}`);
  console.log(`Elapsed: ${elapsed}s (${(elapsed / results.length).toFixed(1)}s/clip avg)\n`);

  // Full detail dump
  if (outputPath) {
    fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
    console.log(`Full results written to: ${outputPath}`);
  }

  // Print problematic clips in full
  const problems = results.filter(r => r.tier !== 'accept' || r.error);
  if (problems.length) {
    console.log(`\n── Problem clips (detailed) ──`);
    for (const p of problems) {
      console.log(`\n${p.clipLabel}  [${p.tier}]  similarity=${Math.round(p.similarity)}%  mouth=${p.mouthSync}`);
      console.log(`  Expected:    ${(p.expectedDialogue || '(none)').slice(0, 120)}`);
      console.log(`  Transcribed: ${(p.transcript || '(none)').slice(0, 120)}`);
      if (p.artifacts.length) console.log(`  Artifacts:   ${p.artifacts.join(', ')}`);
      if (p.notes) console.log(`  Notes:       ${p.notes}`);
      if (p.error) console.log(`  ERROR:       ${p.error}`);
    }
  }
}

/**
 * Dig into the script JSON to find the dialogue line for a given chapter + line.
 * Script shape: { chapters: [{ chapter_number, scenes: [{ lines: [{ line_number, line, ... }] }] }] }
 */
function findExpectedDialogue(script, chapterNum, lineNum) {
  if (!script || !script.chapters) return '';
  for (const ch of script.chapters) {
    if (ch.chapter_number !== chapterNum) continue;
    for (const sc of ch.scenes || []) {
      for (const ln of sc.lines || []) {
        if (ln.line_number === lineNum) {
          // Common field names depending on script generator version
          return ln.line || ln.dialogue || ln.text || ln.spoken || '';
        }
      }
    }
  }
  return '';
}

main().then(() => process.exit(0)).catch(err => {
  console.error('Error:', err.message);
  console.error(err.stack);
  process.exit(1);
});
