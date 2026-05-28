/**
 * Regression check for research pool id persistence.
 *
 * Run: node test/test-research-cache-id.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const db = require('../src/main/database/db');

async function main() {
  const tmpDir = path.join(__dirname, '.tmp-research-cache-id');
  fs.mkdirSync(tmpDir, { recursive: true });
  const dbPath = path.join(tmpDir, 'research-cache-id.sqlite');
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

  await db.init(dbPath);
  const id = db.saveResearchCache(
    { all: [{ id: 'video-1', title: 'Test Video' }] },
    { videosAnalyzed: 1, analyses: [], patterns: { recurring_themes: ['betrayal'] } }
  );

  assert.strictEqual(typeof id, 'number');
  assert.ok(id > 0, `Expected a positive research_cache id, got ${id}`);

  const row = db.queryOne('SELECT id FROM research_cache WHERE id = ?', [id]);
  assert.ok(row, 'Inserted research_cache row should be queryable by returned id');

  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });

  console.log('research cache id regression checks passed');
}

main().catch(err => {
  try { db.close(); } catch (_) {}
  console.error(err);
  process.exit(1);
});
