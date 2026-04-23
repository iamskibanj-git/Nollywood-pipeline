#!/usr/bin/env node
/**
 * Edit a specific line in the active project's script_json, and reset the
 * corresponding failed video clip so the pipeline regenerates it with the new
 * text on next run.
 *
 * Use case: Veo NSFW-rejected a clip, user wants to rewrite the line (e.g.
 * "You sold me, Mama" → "You gave me away, Mama") without restarting the
 * whole pipeline.
 *
 * Usage:
 *   node scripts/edit-line.js --chapter=1 --line=7              — interactive edit
 *   node scripts/edit-line.js --chapter=1 --line=7 --text="new dialogue text"
 *       ↑ non-interactive, replaces line text directly
 *   node scripts/edit-line.js --list                            — list all lines
 *
 * Optional:
 *   --animation="new animation text"    — also edit the animation/stage directions
 *   --no-reset                          — edit script_json but DON'T reset the asset
 *   --field=line|dialogue|text          — which script field to edit (default: auto-detect)
 *
 * The app must be CLOSED before running.
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

function ask(q) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(q, ans => { rl.close(); resolve(ans); });
  });
}

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

  // Find active project
  const projRes = db.exec(
    `SELECT id, title, project_dir, script_json FROM projects
     WHERE completed_at IS NULL ORDER BY created_at DESC LIMIT 1`
  );
  if (!projRes[0] || !projRes[0].values.length) {
    console.error('No active project found.');
    db.close();
    process.exit(1);
  }
  const [projectId, title, projectDir, scriptJsonRaw] = projRes[0].values[0];
  if (!scriptJsonRaw) {
    console.error('Active project has no script_json — nothing to edit.');
    db.close();
    process.exit(1);
  }
  const script = JSON.parse(scriptJsonRaw);

  console.log(`\nProject: ${title}`);
  console.log(`ID: ${projectId}\n`);

  // --list: show all lines with their text
  if (args.list) {
    for (const ch of script.chapters || []) {
      for (const sc of ch.scenes || []) {
        for (const ln of sc.lines || []) {
          const text = ln.line || ln.dialogue || ln.text || '(no text)';
          const speaker = ln.speaker_id || ln.character_id || ln.speaker || '?';
          console.log(`  Ch${ch.chapter_number} L${ln.line_number}  [${speaker}]  "${String(text).slice(0, 100)}"`);
        }
      }
    }
    db.close();
    return;
  }

  const chapter = Number(args.chapter);
  const line = Number(args.line);
  if (!chapter || !line) {
    console.error('Missing --chapter=N --line=M');
    console.error('Run with --list to see all lines first.');
    db.close();
    process.exit(1);
  }

  // Find the line in script_json
  let foundLine = null;
  let foundScene = null;
  let foundChapter = null;
  for (const ch of script.chapters || []) {
    if (ch.chapter_number !== chapter) continue;
    foundChapter = ch;
    for (const sc of ch.scenes || []) {
      for (const ln of sc.lines || []) {
        if (ln.line_number === line) {
          foundLine = ln;
          foundScene = sc;
          break;
        }
      }
      if (foundLine) break;
    }
    if (foundLine) break;
  }

  if (!foundLine) {
    console.error(`Ch${chapter} L${line} not found in script_json.`);
    console.error('Run with --list to see available lines.');
    db.close();
    process.exit(1);
  }

  // Determine which field holds the dialogue
  const dialogueField = args.field || (foundLine.line !== undefined ? 'line'
    : foundLine.dialogue !== undefined ? 'dialogue'
    : foundLine.text !== undefined ? 'text'
    : 'line');
  const currentDialogue = foundLine[dialogueField] || '';

  console.log(`── Current line ──`);
  console.log(`  Ch${chapter} L${line}`);
  console.log(`  Speaker: ${foundLine.speaker_id || foundLine.character_id || '?'}`);
  console.log(`  Dialogue (${dialogueField}):`);
  console.log(`    "${currentDialogue}"`);
  if (foundLine.animation) {
    console.log(`  Animation:`);
    console.log(`    "${String(foundLine.animation).slice(0, 200)}${foundLine.animation.length > 200 ? '...' : ''}"`);
  }
  console.log();

  // Get new dialogue
  let newDialogue = args.text;
  if (newDialogue === undefined) {
    newDialogue = await ask('New dialogue (empty to skip): ');
  }
  let newAnimation = args.animation;
  if (newAnimation === undefined && !args.text) {
    const ans = await ask('New animation text (empty to skip, "-" to skip prompt): ');
    if (ans && ans !== '-') newAnimation = ans;
  }

  if (!newDialogue && !newAnimation) {
    console.log('No changes requested. Aborting.');
    db.close();
    return;
  }

  // Apply changes
  if (newDialogue) foundLine[dialogueField] = newDialogue;
  if (newAnimation) foundLine.animation = newAnimation;

  // Write script_json back
  const updatedJson = JSON.stringify(script);
  db.run(
    `UPDATE projects SET script_json = ?, updated_at = datetime('now') WHERE id = ?`,
    [updatedJson, projectId]
  );
  console.log(`✓ Updated script_json for Ch${chapter} L${line}`);

  // Reset the failed/done asset so the pipeline regenerates with the new text
  if (!args['no-reset']) {
    const assetRes = db.exec(
      `SELECT id, status, file_path FROM project_assets
       WHERE project_id = '${projectId}' AND type = 'video_clip' AND chapter = ${chapter} AND line = ${line}`
    );
    if (assetRes[0] && assetRes[0].values.length) {
      const [assetId, assetStatus, filePath] = assetRes[0].values[0];
      console.log(`✓ Found asset id=${assetId} status=${assetStatus}`);

      // Reset status, clear file_path, clear error, clear verification data
      db.run(
        `UPDATE project_assets SET
           status = 'pending',
           file_path = NULL,
           error_message = NULL,
           cdn_url = NULL,
           verify_tier = NULL,
           verify_similarity = NULL,
           verify_transcript = NULL,
           verify_mouth_sync = NULL,
           verify_character_count = NULL,
           verify_artifacts = NULL,
           verify_notes = NULL,
           verify_human_decision = NULL,
           verified_at = NULL
         WHERE id = ?`,
        [assetId]
      );
      console.log(`✓ Reset asset to pending — pipeline will regenerate on next run`);

      // Delete the old clip file if it exists (so the retry doesn't collide)
      if (filePath && fs.existsSync(filePath)) {
        try {
          fs.unlinkSync(filePath);
          console.log(`✓ Deleted old clip file: ${path.basename(filePath)}`);
        } catch (e) {
          console.warn(`  Could not delete old file: ${e.message}`);
        }
      }
    } else {
      console.warn(`  No asset found for Ch${chapter} L${line} — nothing to reset`);
    }
  }

  // If the project had already reached verified/videos-done stage, roll it back
  // to videos-done so the video stage re-runs with the pending clip.
  const stageRes = db.exec(`SELECT stage FROM projects WHERE id = '${projectId}'`);
  const currentStage = stageRes[0]?.values[0]?.[0];
  if (['verified', 'assembled'].includes(currentStage)) {
    db.run(
      `UPDATE projects SET stage = 'scenes-done', updated_at = datetime('now') WHERE id = ?`,
      [projectId]
    );
    console.log(`✓ Rolled back project stage from '${currentStage}' → 'scenes-done' (so video stage re-runs)`);
  }

  // Save
  fs.writeFileSync(dbPath, Buffer.from(db.export()));
  db.close();

  console.log(`\nDone. Reopen the app and click Resume — the pipeline will regenerate Ch${chapter} L${line} with the new text.`);
}

main().then(() => process.exit(0)).catch(err => {
  console.error('Error:', err.message);
  console.error(err.stack);
  process.exit(1);
});
