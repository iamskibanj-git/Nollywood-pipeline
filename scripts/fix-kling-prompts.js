#!/usr/bin/env node
/**
 * Fix kling_clips multi_shot_prompts to match scene blocking.
 *
 * Problem: Script generation sometimes creates kling_clips Shot 1 descriptions
 * that contradict the scene.blocking (e.g., blocking says "seated frame-left"
 * but Shot 1 says "stands frame-right"). This script deterministically rewrites
 * the posture verbs and frame positions in Shot 1 to match blocking exactly.
 *
 * Usage:
 *   node scripts/fix-kling-prompts.js                — fix all scenes in latest project
 *   node scripts/fix-kling-prompts.js --dry-run      — preview changes without writing
 *   node scripts/fix-kling-prompts.js --project DIR  — fix a specific project directory
 *
 * No API key required — this is a deterministic regex-based fix.
 * Updates both script.json on disk AND the SQLite database.
 * The app should be CLOSED (or paused) before running.
 */

const fs = require('fs');
const path = require('path');

// ── Parse args ──
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const projectIdx = args.indexOf('--project');
let projectDir = null;

if (projectIdx >= 0 && args[projectIdx + 1]) {
  projectDir = args[projectIdx + 1];
}

// ── Find project directory ──
function findLatestProject() {
  // Look in the workspace folder for date-prefixed project dirs
  const searchDirs = [
    path.join(__dirname, '..', '..'),  // parent of nollywood-ai-pipeline
    path.join(process.env.HOME || process.env.USERPROFILE || '', 'Cowork_Nollywood', 'Mass-produced', 'Mass production - Nollywood'),
  ];

  for (const base of searchDirs) {
    if (!fs.existsSync(base)) continue;
    const entries = fs.readdirSync(base)
      .filter(e => /^\d{4}-\d{2}-\d{2}_/.test(e))
      .sort()
      .reverse();
    for (const entry of entries) {
      const scriptPath = path.join(base, entry, 'script.json');
      if (fs.existsSync(scriptPath)) return path.join(base, entry);
    }
  }
  return null;
}

async function main() {
  const dir = projectDir || findLatestProject();
  if (!dir) {
    console.error('No project found. Use --project DIR to specify one.');
    process.exit(1);
  }

  const scriptPath = path.join(dir, 'script.json');
  if (!fs.existsSync(scriptPath)) {
    console.error(`No script.json found at ${scriptPath}`);
    process.exit(1);
  }

  const script = JSON.parse(fs.readFileSync(scriptPath, 'utf-8'));
  console.log(`Project: ${dir}`);
  console.log(`Title: ${script.title}`);
  console.log(`Chapters: ${(script.chapters || []).length}`);
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE — will overwrite script.json + DB'}\n`);

  let totalFixed = 0;
  let totalScenes = 0;

  // ── Parse blocking to extract character postures ──
  function parseBlockingPostures(blocking) {
    // Returns map: characterBaseName → { posture: 'seated'|'standing'|'leaning', framePos: 'left'|'center'|'right', description }
    const postures = {};
    const positions = ['frame_left', 'frame_center', 'frame_right'];
    const framePosMap = { frame_left: 'left', frame_center: 'center', frame_right: 'right' };

    for (const pos of positions) {
      const text = (blocking[pos] || '').trim();
      if (!text) continue;
      // Extract @character_name or character name at start
      const charMatch = text.match(/@?([a-z0-9_]+)/i);
      if (!charMatch) continue;
      const charName = charMatch[1].toLowerCase();

      // Detect posture from the blocking description
      let posture = 'standing'; // default
      const lower = text.toLowerCase();
      if (/\bseat(?:ed|s)\b|\bsitting\b|\bsits?\b/.test(lower)) posture = 'seated';
      else if (/\bstand(?:s|ing)\b/.test(lower)) posture = 'standing';
      else if (/\blean(?:s|ing)\b/.test(lower)) posture = 'leaning';

      postures[charName] = {
        posture,
        framePos: framePosMap[pos],
        description: text,
      };
    }
    return postures;
  }

  // ── Deterministic posture fix for Shot 1 ──
  function fixShot1Postures(prompt, postures) {
    if (!prompt || Object.keys(postures).length === 0) return prompt;

    // Find Shot 1 text (between "Shot 1" and "Shot 2")
    const shot1Match = prompt.match(/(Shot\s*1\s*\([^)]*\)\s*:\s*)(.*?)(?=Shot\s*2\s*\(|$)/is);
    if (!shot1Match) return prompt;

    let shot1Text = shot1Match[2];
    let fixes = 0;

    for (const [charName, info] of Object.entries(postures)) {
      // Build regex that matches @charName (with possible suffix) followed by a posture verb
      // Match: @charName_suffix stands/sits/seated/leaning
      const namePattern = charName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const postureRegex = new RegExp(
        `(@${namePattern}(?:_[a-z0-9_]*)?)\\s+(stands?|stand|standing|sits?|sitting|seated|leans?|leaning)\\b`,
        'gi'
      );

      shot1Text = shot1Text.replace(postureRegex, (match, nameRef, currentVerb) => {
        const currentLower = currentVerb.toLowerCase();
        const targetPosture = info.posture;

        // Check if current verb matches target posture
        const isCorrect =
          (targetPosture === 'seated' && /^(sits?|sitting|seated)$/i.test(currentVerb)) ||
          (targetPosture === 'standing' && /^(stands?|standing)$/i.test(currentVerb)) ||
          (targetPosture === 'leaning' && /^(leans?|leaning)$/i.test(currentVerb));

        if (isCorrect) return match;

        // Map target posture to the correct verb form
        const verbMap = { seated: 'sits', standing: 'stands', leaning: 'leans' };
        const correctVerb = verbMap[targetPosture] || currentVerb;
        fixes++;
        console.log(`      POSTURE FIX: ${nameRef} "${currentVerb}" → "${correctVerb}" (blocking says ${targetPosture})`);
        return `${nameRef} ${correctVerb}`;
      });

      // Also fix "frame-X" position if it contradicts blocking
      if (info.framePos) {
        const framePosRegex = new RegExp(
          `(@${namePattern}(?:_[a-z0-9_]*)?)\\s+(?:stands?|sits?|seated|leans?)\\s+frame-(left|center|centre|right)`,
          'gi'
        );
        shot1Text = shot1Text.replace(framePosRegex, (match, nameRef, currentPos) => {
          const normalizedCurrent = currentPos === 'centre' ? 'center' : currentPos;
          if (normalizedCurrent === info.framePos) return match;
          fixes++;
          // Extract the verb from the match to preserve it
          const verbMatch = match.match(/\s(stands?|sits?|seated|leans?)\s/i);
          const verb = verbMatch ? verbMatch[1] : 'is';
          console.log(`      FRAME FIX: ${nameRef} "frame-${currentPos}" → "frame-${info.framePos}" (blocking says frame-${info.framePos})`);
          return `${nameRef} ${verb} frame-${info.framePos}`;
        });
      }
    }

    if (fixes === 0) return prompt;

    // Reconstruct prompt with fixed Shot 1
    return prompt.replace(shot1Match[2], shot1Text);
  }

  for (const ch of (script.chapters || [])) {
    for (const sc of (ch.scenes || [])) {
      totalScenes++;
      const clips = sc.kling_clips || [];
      if (clips.length === 0) continue;

      const blocking = sc.blocking || {};
      const postures = parseBlockingPostures(blocking);

      if (Object.keys(postures).length === 0) {
        console.log(`  Ch${ch.chapter_number} Sc${sc.scene_number}: no blocking — skipping`);
        continue;
      }

      console.log(`  Ch${ch.chapter_number} Sc${sc.scene_number}: ${clips.length} clip(s), blocking for ${Object.keys(postures).length} character(s)`);
      for (const [name, info] of Object.entries(postures)) {
        console.log(`    ${name}: ${info.posture}, frame-${info.framePos}`);
      }

      // Fix each clip deterministically
      for (let i = 0; i < clips.length; i++) {
        const clip = clips[i];
        const originalPrompt = clip.multi_shot_prompt;
        if (!originalPrompt) continue;

        const corrected = fixShot1Postures(originalPrompt, postures);

        if (corrected === originalPrompt) {
          console.log(`    Clip ${clip.clip_id}: no posture fixes needed ✓`);
          continue;
        }

        if (dryRun) {
          console.log(`    Clip ${clip.clip_id}: WOULD FIX (${originalPrompt.length} → ${corrected.length} chars)`);
        } else {
          clip.multi_shot_prompt = corrected;
          console.log(`    Clip ${clip.clip_id}: FIXED ✓`);
        }
        totalFixed++;
      }
    }
  }

  console.log(`\n${totalFixed} clip(s) ${dryRun ? 'would be' : ''} fixed across ${totalScenes} scenes.`);

  if (!dryRun && totalFixed > 0) {
    // Backup original
    const backupPath = scriptPath.replace('.json', '.pre-fix-kling.json');
    fs.copyFileSync(scriptPath, backupPath);
    console.log(`Backup saved: ${backupPath}`);

    // Write corrected script to disk
    const scriptJsonStr = JSON.stringify(script, null, 2);
    fs.writeFileSync(scriptPath, scriptJsonStr);
    console.log(`Updated: ${scriptPath}`);

    // ── Also update the SQLite database ──
    // The app loads script from the DB's script_json column, not from disk.
    // If we don't update the DB, the app will still use the old prompts.
    try {
      const dbDir = path.join(process.env.APPDATA || path.join(process.env.HOME || '', '.config'), 'nollywood-ai-pipeline');
      const dbFile = path.join(dbDir, 'nollywood-pipeline.sqlite');

      if (fs.existsSync(dbFile)) {
        const initSqlJs = require('sql.js');
        const SQL = await initSqlJs();
        const buffer = fs.readFileSync(dbFile);
        const sqlDb = new SQL.Database(buffer);

        // Find the project by matching project_dir
        const normalizedDir = dir.replace(/\\/g, '/').replace(/\/$/, '');
        const stmt = sqlDb.prepare('SELECT id, project_dir FROM projects WHERE completed_at IS NULL ORDER BY created_at DESC');
        let matchedProjectId = null;
        while (stmt.step()) {
          const row = stmt.getAsObject();
          const rowDir = (row.project_dir || '').replace(/\\/g, '/').replace(/\/$/, '');
          if (rowDir === normalizedDir) {
            matchedProjectId = row.id;
            break;
          }
        }
        stmt.free();

        if (matchedProjectId) {
          sqlDb.run('UPDATE projects SET script_json = ?, updated_at = datetime(\'now\') WHERE id = ?', [scriptJsonStr, matchedProjectId]);

          // Persist to disk (atomic write like the app does)
          const data = sqlDb.export();
          const dbBuffer = Buffer.from(data);
          const tmpPath = dbFile + '.tmp';
          fs.writeFileSync(tmpPath, dbBuffer);
          fs.renameSync(tmpPath, dbFile);

          console.log(`Updated DB: project ${matchedProjectId}`);
        } else {
          // Fallback: try matching any project whose project_dir contains the directory basename
          const baseName = path.basename(dir);
          const stmt2 = sqlDb.prepare('SELECT id, project_dir FROM projects WHERE project_dir LIKE ? ORDER BY created_at DESC LIMIT 1');
          stmt2.bind([`%${baseName}%`]);
          if (stmt2.step()) {
            const row = stmt2.getAsObject();
            sqlDb.run('UPDATE projects SET script_json = ?, updated_at = datetime(\'now\') WHERE id = ?', [scriptJsonStr, row.id]);
            const data = sqlDb.export();
            const dbBuffer = Buffer.from(data);
            const tmpPath = dbFile + '.tmp';
            fs.writeFileSync(tmpPath, dbBuffer);
            fs.renameSync(tmpPath, dbFile);
            console.log(`Updated DB: project ${row.id} (matched by basename)`);
          } else {
            console.warn('Could not find project in DB — script.json updated on disk only.');
            console.warn('You may need to manually restart and re-import.');
          }
          stmt2.free();
        }

        sqlDb.close();
      } else {
        console.warn(`DB file not found at ${dbFile} — script.json updated on disk only.`);
      }
    } catch (dbErr) {
      console.warn(`DB update failed: ${dbErr.message} — script.json updated on disk only.`);
      console.warn('The app may still show old prompts until the DB is updated.');
    }

    console.log('\nRestart the app and resume the pipeline to use the corrected prompts.');
  }
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
