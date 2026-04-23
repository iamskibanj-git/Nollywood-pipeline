#!/usr/bin/env node
/**
 * reset-to-dialogue-triage.js
 *
 * Sets the active project's pending_approval_gate back to 'dialogue-triage'.
 * On next app launch, the resume handler will re-emit triage data and wait
 * for approval. After approval, the video gen loop starts fresh — rebuilding
 * every prompt through _injectVisionBlocking() (which now strips duplicate
 * CHARACTER POSITIONS).
 *
 * Usage:  node scripts/reset-to-dialogue-triage.js [--dry-run]
 */

const path = require('path');
const initSqlJs = require('sql.js');
const fs = require('fs');

const DRY_RUN = process.argv.includes('--dry-run');

// Find the DB
const dbPath = path.join(
  process.env.APPDATA || path.join(require('os').homedir(), '.config'),
  'nollywood-ai-pipeline', 'nollywood-pipeline.sqlite'
);

if (!fs.existsSync(dbPath)) {
  console.error(`DB not found at ${dbPath}`);
  process.exit(1);
}

(async () => {
  const SQL = await initSqlJs();
  const buf = fs.readFileSync(dbPath);
  const db = new SQL.Database(buf);

  // Find active project
  const rows = db.exec(`SELECT id, title, stage, settings FROM projects WHERE completed_at IS NULL ORDER BY created_at DESC LIMIT 1`);
  if (!rows.length || !rows[0].values.length) {
    console.error('No active project found.');
    db.close();
    process.exit(1);
  }

  const [projectId, title, stage, rawSettings] = rows[0].values[0];
  const settings = rawSettings ? JSON.parse(rawSettings) : {};

  console.log(`\nProject: ${title}`);
  console.log(`ID:      ${projectId}`);
  console.log(`Stage:   ${stage}`);
  console.log(`Current gate: ${settings.pending_approval_gate || '(none)'}`);

  // Check for any video clips already generated
  const clipRows = db.exec(`SELECT status, COUNT(*) as cnt FROM project_assets WHERE project_id = '${projectId}' AND type IN ('video_clip', 'video_clip_cinematic') GROUP BY status`);
  if (clipRows.length && clipRows[0].values.length) {
    console.log(`\nVideo clip status:`);
    for (const [status, cnt] of clipRows[0].values) {
      console.log(`  ${status}: ${cnt}`);
    }
  } else {
    console.log(`\nNo video clip assets in DB.`);
  }

  // Set the gate
  console.log(`\n--- ${DRY_RUN ? 'DRY RUN' : 'APPLYING'} ---`);
  console.log(`Setting pending_approval_gate = 'dialogue-triage'`);

  if (!DRY_RUN) {
    settings.pending_approval_gate = 'dialogue-triage';
    db.run(`UPDATE projects SET settings = ? WHERE id = ?`, [JSON.stringify(settings), projectId]);

    // Save
    const data = db.export();
    fs.writeFileSync(dbPath, Buffer.from(data));
    console.log(`✓ DB saved. On next launch, dialogue triage gate will fire.`);
  } else {
    console.log(`(no changes — remove --dry-run to apply)`);
  }

  db.close();
})();
