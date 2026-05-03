/**
 * Inspect & fix shorts data.
 *
 * Run: node fix-shorts-status.js
 *
 * Step 1: Show all shorts with their SEO + file status
 * Step 2: If all look good, flip 'failed' back to 'seo_done'
 */

const path = require('path');
const fs = require('fs');

const dbPath = path.join(
  process.env.APPDATA || path.join(require('os').homedir(), 'AppData', 'Roaming'),
  'nollywood-ai-pipeline',
  'nollywood-pipeline.sqlite'
);

async function main() {
  console.log(`\nDB: ${dbPath}\n`);

  if (!fs.existsSync(dbPath)) {
    console.error('Database file not found!');
    process.exit(1);
  }

  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  const buffer = fs.readFileSync(dbPath);
  const db = new SQL.Database(buffer);

  // ── Step 1: Inspect all shorts ──
  const rows = db.exec(`
    SELECT short_number, scheduled_date, scheduled_time, status,
           file_path, duration_seconds, description, hashtags, title, error_message
    FROM shorts
    ORDER BY short_number ASC
  `);

  if (!rows.length || !rows[0].values.length) {
    console.log('No shorts found in database.');
    db.close();
    return;
  }

  const cols = rows[0].columns;
  const shorts = rows[0].values.map(row => {
    const obj = {};
    cols.forEach((c, i) => obj[c] = row[i]);
    return obj;
  });

  console.log('='.repeat(130));
  console.log('SHORT#  DATE        TIME   STATUS      DURATION  HAS_TITLE  HAS_DESC  HAS_TAGS  FILE_EXISTS  ERROR');
  console.log('='.repeat(130));

  for (const s of shorts) {
    const hasTitle = s.title && s.title.length > 0 ? 'YES' : 'NO';
    const hasDesc = s.description && s.description.length > 0 ? 'YES' : 'NO';
    const hasTags = s.hashtags && s.hashtags !== '[]' && s.hashtags.length > 2 ? 'YES' : 'NO';
    const fileExists = s.file_path && fs.existsSync(s.file_path) ? 'YES' : 'NO';
    const err = s.error_message ? s.error_message.slice(0, 60) : '';

    console.log(
      `${String(s.short_number).padStart(5)}   ` +
      `${s.scheduled_date}  ${s.scheduled_time}  ` +
      `${(s.status || '').padEnd(11)} ` +
      `${(Math.round(s.duration_seconds) + 's').padEnd(9)} ` +
      `${hasTitle.padEnd(10)} ${hasDesc.padEnd(9)} ${hasTags.padEnd(9)} ` +
      `${fileExists.padEnd(12)} ${err}`
    );
  }

  console.log('='.repeat(130));

  // ── Step 2: Count what needs fixing ──
  const failed = shorts.filter(s => s.status === 'failed');
  const failedReady = failed.filter(s => {
    const hasDesc = s.description && s.description.length > 0;
    const fileExists = s.file_path && fs.existsSync(s.file_path);
    return hasDesc && fileExists;
  });

  console.log(`\nTotal shorts: ${shorts.length}`);
  console.log(`Failed: ${failed.length}`);
  console.log(`Failed but ready (have SEO + file): ${failedReady.length}`);

  if (failedReady.length > 0) {
    // Create backup before modifying data
    const backupDir = path.join(path.dirname(dbPath), 'backups');
    if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
    const backupFile = path.join(backupDir, `nollywood-pipeline_${timestamp}_pre-fix.sqlite`);
    fs.copyFileSync(dbPath, backupFile);
    console.log(`\n✓ Backup created: ${path.basename(backupFile)}`);

    console.log(`→ Resetting ${failedReady.length} failed shorts back to 'seo_done'...`);

    db.run(`
      UPDATE shorts SET status = 'seo_done', error_message = NULL, updated_at = datetime('now')
      WHERE status = 'failed'
        AND description IS NOT NULL AND length(description) > 0
        AND file_path IS NOT NULL
    `);

    const changes = db.getRowsModified();
    console.log(`✓ Reset ${changes} shorts to seo_done`);

    // Save back to disk
    const data = db.export();
    const buf = Buffer.from(data);
    fs.writeFileSync(dbPath, buf);
    console.log('✓ Database saved to disk');
  } else if (failed.length > 0) {
    console.log('\n✗ Failed shorts are NOT ready — missing SEO or file. Cannot reset.');
  } else {
    console.log('\n✓ No failed shorts to fix.');
  }

  // ── Verify final state ──
  const finalRows = db.exec(`SELECT status, COUNT(*) as cnt FROM shorts GROUP BY status ORDER BY status`);
  if (finalRows.length) {
    console.log('\nFinal status counts:');
    for (const row of finalRows[0].values) {
      console.log(`  ${row[0]}: ${row[1]}`);
    }
  }

  db.close();
  console.log('\nDone.\n');
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
