/**
 * One-time data fix: rename status 'failed' → 'upload_failed' for shorts.
 *
 * Run: node fix-failed-to-upload-failed.js
 *
 * The old code used generic 'failed' for upload failures. The new code uses
 * 'upload_failed' so the Upload All button can auto-retry them.
 * This script migrates existing data to the new status.
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

  // Check current state
  const before = db.exec(`SELECT status, COUNT(*) as cnt FROM shorts GROUP BY status ORDER BY status`);
  console.log('Before:');
  if (before.length) {
    for (const row of before[0].values) console.log(`  ${row[0]}: ${row[1]}`);
  }

  // Count affected rows
  const countResult = db.exec(`SELECT COUNT(*) FROM shorts WHERE status = 'failed'`);
  const failedCount = countResult.length ? countResult[0].values[0][0] : 0;

  if (failedCount === 0) {
    console.log('\nNo shorts with status "failed" found. Nothing to fix.');
    db.close();
    return;
  }

  // Backup before modifying
  const backupDir = path.join(path.dirname(dbPath), 'backups');
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  const backupFile = path.join(backupDir, `nollywood-pipeline_${timestamp}_pre-status-rename.sqlite`);
  fs.copyFileSync(dbPath, backupFile);
  console.log(`\n✓ Backup: ${path.basename(backupFile)}`);

  // Rename failed → upload_failed
  db.run(`UPDATE shorts SET status = 'upload_failed' WHERE status = 'failed'`);
  const changes = db.getRowsModified();
  console.log(`✓ Renamed ${changes} shorts: 'failed' → 'upload_failed'`);

  // Save
  const data = db.export();
  fs.writeFileSync(dbPath, Buffer.from(data));
  console.log('✓ Database saved');

  // Verify
  const after = db.exec(`SELECT status, COUNT(*) as cnt FROM shorts GROUP BY status ORDER BY status`);
  console.log('\nAfter:');
  if (after.length) {
    for (const row of after[0].values) console.log(`  ${row[0]}: ${row[1]}`);
  }

  db.close();
  console.log('\nDone.\n');
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
