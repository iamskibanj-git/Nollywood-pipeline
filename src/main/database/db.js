/**
 * Database module — SQLite via sql.js (pure JS, no native deps).
 *
 * Handles init, migrations, and all project/asset/cache queries.
 * Replaces electron-store for stateful data. electron-store still holds
 * API keys, UI prefs, and Higgsfield session cookies.
 *
 * sql.js runs SQLite compiled to WASM — no C++ toolchain needed.
 * The DB is held in memory and flushed to disk after each write operation.
 */

const path = require('path');
const fs = require('fs');

let db = null;
let dbPath = null;

// ── Init & Migrations ──

/**
 * Initialize the database. Call once at app startup.
 * ASYNC — sql.js needs to load its WASM binary first.
 * @param {string} filepath — absolute path to the .sqlite file
 */
async function init(filepath) {
  if (db) return db;

  const initSqlJs = require('sql.js');
  dbPath = filepath;

  // Ensure parent directory exists
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  // Load existing DB file or create empty
  const SQL = await initSqlJs();
  if (fs.existsSync(dbPath)) {
    try {
      const buffer = fs.readFileSync(dbPath);
      if (buffer.length === 0) throw new Error('Empty file');
      db = new SQL.Database(buffer);
      console.log(`[DB] Loaded existing database from ${dbPath}`);
    } catch (loadErr) {
      console.error(`[DB] Failed to load database: ${loadErr.message}`);
      // Back up the corrupt file so user can investigate
      const backupPath = dbPath + '.corrupt.' + Date.now();
      try {
        fs.renameSync(dbPath, backupPath);
        console.log(`[DB] Corrupt file backed up to ${backupPath}`);
      } catch (e) { /* ignore backup failure */ }
      db = new SQL.Database();
      console.log('[DB] Created fresh database (previous data lost — see .corrupt backup)');
    }
  } else {
    db = new SQL.Database();
    console.log(`[DB] Created new database at ${dbPath}`);
  }

  // Performance pragmas
  db.run('PRAGMA journal_mode = WAL');
  db.run('PRAGMA foreign_keys = ON');

  // Backup before any migrations or recovery changes
  backup('startup');

  runMigrations();
  recoverOnStartup(); // Reset stuck assets, clean temp files
  save(); // Persist any migration/recovery changes

  // Start periodic auto-backups
  startAutoBackup();

  return db;
}

/**
 * Persist the in-memory DB to disk.
 * Uses atomic write (write to temp file, then rename) to prevent
 * corruption if the process dies mid-write.
 */
function save() {
  if (!db || !dbPath) return;
  const data = db.export();
  const buffer = Buffer.from(data);

  // Atomic write: write to .tmp, then rename over the real file.
  // rename() is atomic on all major OS filesystems (NTFS, ext4, APFS).
  const tmpPath = dbPath + '.tmp';
  fs.writeFileSync(tmpPath, buffer);
  fs.renameSync(tmpPath, dbPath);
}

// ── Backup System ──

const BACKUP_MAX_AUTO = 5;       // Rolling window for automatic backups
const BACKUP_MAX_MANUAL = 10;    // Keep more manual/pre-operation backups
const BACKUP_INTERVAL = 30 * 60 * 1000; // 30 minutes
let backupTimer = null;

/**
 * Create a backup of the current database file.
 *
 * @param {string} tag - Label for the backup (e.g. 'startup', 'pre-upload', 'auto')
 * @returns {string|null} Path to the backup file, or null if backup failed
 */
function backup(tag = 'manual') {
  if (!dbPath) return null;

  // Ensure current in-memory state is on disk first
  save();

  if (!fs.existsSync(dbPath)) return null;

  const dir = path.join(path.dirname(dbPath), 'backups');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const now = new Date();
  const timestamp = now.toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  const filename = `nollywood-pipeline_${timestamp}_${tag}.sqlite`;
  const backupPath = path.join(dir, filename);

  try {
    fs.copyFileSync(dbPath, backupPath);
    console.log(`[DB] Backup created: ${filename}`);

    // Prune old backups of the same tag category
    _pruneBackups(dir, tag);

    return backupPath;
  } catch (err) {
    console.error(`[DB] Backup failed: ${err.message}`);
    return null;
  }
}

/**
 * Start automatic periodic backups (every BACKUP_INTERVAL ms).
 * Call once after init. Safe to call multiple times — only one timer runs.
 */
function startAutoBackup() {
  if (backupTimer) return;
  backupTimer = setInterval(() => {
    backup('auto');
  }, BACKUP_INTERVAL);
  // Don't let the timer prevent process exit
  if (backupTimer.unref) backupTimer.unref();
  console.log(`[DB] Auto-backup enabled (every ${BACKUP_INTERVAL / 60000} min)`);
}

/**
 * Stop automatic periodic backups.
 */
function stopAutoBackup() {
  if (backupTimer) {
    clearInterval(backupTimer);
    backupTimer = null;
  }
}

/**
 * List existing backups sorted by date (newest first).
 * @returns {Array<{filename, tag, date, size}>}
 */
function listBackups() {
  if (!dbPath) return [];
  const dir = path.join(path.dirname(dbPath), 'backups');
  if (!fs.existsSync(dir)) return [];

  return fs.readdirSync(dir)
    .filter(f => f.startsWith('nollywood-pipeline_') && f.endsWith('.sqlite'))
    .map(f => {
      const stat = fs.statSync(path.join(dir, f));
      // Parse tag from filename: nollywood-pipeline_2026-05-02_18-30-00_startup.sqlite
      const parts = f.replace('.sqlite', '').split('_');
      const tag = parts[parts.length - 1] || 'unknown';
      return { filename: f, tag, date: stat.mtime, size: stat.size };
    })
    .sort((a, b) => b.date - a.date);
}

/**
 * Restore from a backup file. Creates a safety backup of current state first.
 * @param {string} backupFilename - Filename (not full path) of the backup to restore
 * @returns {boolean} true if restore succeeded
 */
function restoreBackup(backupFilename) {
  if (!dbPath) return false;
  const dir = path.join(path.dirname(dbPath), 'backups');
  const backupPath = path.join(dir, backupFilename);

  if (!fs.existsSync(backupPath)) {
    console.error(`[DB] Backup not found: ${backupFilename}`);
    return false;
  }

  // Safety backup of current state before restoring
  backup('pre-restore');

  try {
    // Close current DB
    if (db) {
      db.close();
      db = null;
    }

    // Copy backup over the main DB file
    fs.copyFileSync(backupPath, dbPath);
    console.log(`[DB] Restored from backup: ${backupFilename}`);

    // Note: caller must re-init the DB after restore
    return true;
  } catch (err) {
    console.error(`[DB] Restore failed: ${err.message}`);
    return false;
  }
}

/**
 * Prune old backups, keeping the most recent N per tag category.
 * 'auto' backups keep BACKUP_MAX_AUTO, others keep BACKUP_MAX_MANUAL.
 */
function _pruneBackups(dir, currentTag) {
  const maxKeep = currentTag === 'auto' ? BACKUP_MAX_AUTO : BACKUP_MAX_MANUAL;

  const allFiles = fs.readdirSync(dir)
    .filter(f => f.startsWith('nollywood-pipeline_') && f.endsWith('.sqlite'))
    .sort()
    .reverse(); // Newest first (ISO timestamps sort lexicographically)

  // Group by tag
  const byTag = {};
  for (const f of allFiles) {
    const parts = f.replace('.sqlite', '').split('_');
    const tag = parts[parts.length - 1] || 'unknown';
    if (!byTag[tag]) byTag[tag] = [];
    byTag[tag].push(f);
  }

  // Prune each tag category
  for (const [tag, files] of Object.entries(byTag)) {
    const limit = tag === 'auto' ? BACKUP_MAX_AUTO : BACKUP_MAX_MANUAL;
    if (files.length > limit) {
      const toDelete = files.slice(limit);
      for (const f of toDelete) {
        try {
          fs.unlinkSync(path.join(dir, f));
          console.log(`[DB] Pruned old backup: ${f}`);
        } catch (_) {}
      }
    }
  }
}

/**
 * Run any unapplied migrations in order.
 */
function runMigrations() {
  // Check if schema_version table exists
  const result = db.exec(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'`
  );
  const hasVersionTable = result.length > 0 && result[0].values.length > 0;

  let currentVersion = 0;
  if (hasVersionTable) {
    const vResult = db.exec('SELECT MAX(version) as v FROM schema_version');
    if (vResult.length > 0 && vResult[0].values.length > 0) {
      currentVersion = vResult[0].values[0][0] || 0;
    }
  }

  // Read migration files
  const migrationsDir = path.join(__dirname, 'migrations');
  if (!fs.existsSync(migrationsDir)) return;

  const files = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const version = parseInt(file.split('-')[0], 10);
    if (isNaN(version) || version <= currentVersion) continue;

    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
    console.log(`[DB] Running migration ${file}...`);

    // Split migration into individual statements and run each one.
    // This handles partial re-runs gracefully: if an ALTER TABLE fails because
    // the column already exists (from a previous partial run when db.run() was
    // used instead of db.exec()), we skip that statement and continue.
    const statements = sql
      .split(';')
      .map(s => s.replace(/--[^\n]*/g, '').trim())  // Strip SQL comments
      .filter(s => s.length > 0);

    let allOk = true;
    for (const stmt of statements) {
      try {
        db.run(stmt);
      } catch (e) {
        if (e.message && e.message.includes('duplicate column')) {
          console.warn(`[DB] Skipping (column already exists): ${stmt.slice(0, 60)}...`);
        } else if (e.message && e.message.includes('UNIQUE constraint failed')) {
          // schema_version row already exists from a previous partial run
          console.warn(`[DB] Skipping (version already recorded): ${stmt.slice(0, 60)}...`);
        } else if (e.message && e.message.includes('already exists')) {
          console.warn(`[DB] Skipping (already exists): ${stmt.slice(0, 60)}...`);
        } else {
          console.error(`[DB] Migration ${file} statement FAILED: ${e.message}`);
          console.error(`[DB] Statement: ${stmt.slice(0, 120)}`);
          allOk = false;
          throw e;
        }
      }
    }

    // Ensure version is recorded even if some statements were skipped
    if (allOk) {
      try {
        db.run(`INSERT OR REPLACE INTO schema_version (version) VALUES (${version})`);
      } catch (_) { /* already recorded */ }
    }

    console.log(`[DB] Migration ${file} applied (version ${version})`);
  }
}

/**
 * Get the raw database instance for advanced queries.
 */
function getDb() {
  if (!db) throw new Error('Database not initialized. Call db.init() first.');
  return db;
}

/**
 * Close the database connection and persist to disk.
 */
function close() {
  if (db) {
    stopAutoBackup();
    backup('shutdown');
    save();
    db.close();
    db = null;
  }
}

// ── Helper: run a query and return rows as objects ──

function queryAll(sql, params = []) {
  const stmt = db.prepare(sql);
  if (params.length) stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

function queryOne(sql, params = []) {
  const rows = queryAll(sql, params);
  return rows.length > 0 ? rows[0] : undefined;
}

function runSql(sql, params = []) {
  if (params.length) {
    db.run(sql, params);
  } else {
    db.run(sql);
  }
  save();
}

/**
 * Set element_name + (optional) higgsfield_element_id on a project_assets row.
 * Used by the cinematic Phase 2/3 stages to record which Higgsfield element
 * each asset (portrait, location_image, prop) corresponds to.
 */
function setAssetElementName(assetId, elementName, higgsfieldElementId) {
  if (!assetId || !elementName) return;
  const sets = ['element_name = ?'];
  const vals = [elementName];
  if (higgsfieldElementId) {
    sets.push('higgsfield_element_id = ?');
    vals.push(higgsfieldElementId);
  }
  vals.push(assetId);
  runSql(`UPDATE project_assets SET ${sets.join(', ')} WHERE id = ?`, vals);
}

/**
 * Set kling_clip_id + line_refs on a video_clip_cinematic asset row.
 * Used by Phase 4 cinematic video stage to make resume idempotent — the
 * stage walks scene.kling_clips and looks up existing rows by clip_id.
 */
function _setKlingClipMeta(assetId, klingClipId, lineRefsJson) {
  if (!assetId || !klingClipId) return;
  runSql(
    `UPDATE project_assets SET kling_clip_id = ?, line_refs = ? WHERE id = ?`,
    [klingClipId, lineRefsJson || '[]', assetId]
  );
}


// ── Project Queries ──

function getProject(projectId) {
  return queryOne(`SELECT * FROM projects WHERE id = ?`, [projectId]);
}

function getActiveProject() {
  return queryOne(
    `SELECT * FROM projects WHERE completed_at IS NULL ORDER BY created_at DESC LIMIT 1`
  );
}

function createProject({ id, title, sourceVideoIds, durationPreset, aspectRatio, generatorMode, stage, settings, projectDir, scriptJson, researchCacheId }) {
  const normalizedAspect = (aspectRatio === '9:16' || aspectRatio === '16:9') ? aspectRatio : '16:9';
  const normalizedMode = (generatorMode === 'cinematic' || generatorMode === 'staged') ? generatorMode : 'staged';
  runSql(`
    INSERT INTO projects (id, title, source_video_ids, duration_preset, aspect_ratio, generator_mode, stage, settings, project_dir, script_json, research_cache_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    id,
    title || null,
    JSON.stringify(sourceVideoIds || []),
    durationPreset || '10min',
    normalizedAspect,
    normalizedMode,
    stage || 'research-done',
    JSON.stringify(settings || {}),
    projectDir || null,
    scriptJson || null,
    researchCacheId || null,
  ]);
}

/**
 * Set a project's aspect ratio. Locked once generation has begun —
 * if any project_assets rows exist, throws. Used only at Start Research time.
 */
function setProjectAspectRatio(projectId, aspectRatio) {
  if (aspectRatio !== '16:9' && aspectRatio !== '9:16') {
    throw new Error(`Invalid aspect_ratio: ${aspectRatio} (must be '16:9' or '9:16')`);
  }
  const assetCount = queryAll(
    `SELECT COUNT(*) AS c FROM project_assets WHERE project_id = ?`,
    [projectId]
  )[0]?.c || 0;
  if (assetCount > 0) {
    throw new Error(`Cannot change aspect_ratio: project ${projectId} already has ${assetCount} asset(s). Aspect is locked once generation starts.`);
  }
  runSql(
    `UPDATE projects SET aspect_ratio = ?, updated_at = datetime('now') WHERE id = ?`,
    [aspectRatio, projectId]
  );
}

/**
 * Set a project's generator mode. Locked once generation has begun — same
 * lock semantics as aspect_ratio, enforced via project_assets row count.
 * Used only at Start Research time.
 *
 * Mode values:
 *   - 'staged'    — Veo 3.1 Lite, one clip per dialogue line (default)
 *   - 'cinematic' — Cinema Studio 2.0 + Kling 3.0 multi-shot pipeline
 *                   (see IMPROVEMENT-CINEMATIC-WORKFLOW.md)
 */
function setProjectGeneratorMode(projectId, generatorMode) {
  if (generatorMode !== 'staged' && generatorMode !== 'cinematic') {
    throw new Error(`Invalid generator_mode: ${generatorMode} (must be 'staged' or 'cinematic')`);
  }
  const assetCount = queryAll(
    `SELECT COUNT(*) AS c FROM project_assets WHERE project_id = ?`,
    [projectId]
  )[0]?.c || 0;
  if (assetCount > 0) {
    throw new Error(`Cannot change generator_mode: project ${projectId} already has ${assetCount} asset(s). Mode is locked once generation starts.`);
  }
  runSql(
    `UPDATE projects SET generator_mode = ?, updated_at = datetime('now') WHERE id = ?`,
    [generatorMode, projectId]
  );
}

function updateProjectStage(projectId, stage) {
  runSql(
    `UPDATE projects SET stage = ?, updated_at = datetime('now') WHERE id = ?`,
    [stage, projectId]
  );
}

function updateProject(projectId, fields) {
  const allowed = ['title', 'source_video_ids', 'stage', 'script_json', 'settings', 'project_dir', 'completed_at', 'research_cache_id', 'duration_preset', 'thumbnail_path', 'thumbnail_key_art_path', 'thumbnail_title_card_path', 'thumbnail_scene_id', 'youtube_metadata', 'facebook_metadata', 'published_at'];
  const updates = [];
  const values = [];

  for (const [key, value] of Object.entries(fields)) {
    if (!allowed.includes(key)) continue;
    updates.push(`${key} = ?`);
    values.push(typeof value === 'object' && value !== null ? JSON.stringify(value) : value);
  }

  if (updates.length === 0) return;
  updates.push(`updated_at = datetime('now')`);
  values.push(projectId);

  runSql(`UPDATE projects SET ${updates.join(', ')} WHERE id = ?`, values);
}

function completeProject(projectId) {
  runSql(
    `UPDATE projects SET completed_at = datetime('now'), stage = 'published', updated_at = datetime('now') WHERE id = ?`,
    [projectId]
  );
}

/**
 * Mark a project as abandoned. Sets completed_at so the active-project query
 * (WHERE completed_at IS NULL) no longer returns it, and stamps the stage as
 * 'abandoned' for audit. The project's assets and files on disk are preserved
 * — use `scripts/wipe-project.js` if you need a hard delete.
 *
 * Called from the UI when the user clicks "Start a different story instead"
 * on the resume card, so they can start a new project with a different
 * generator mode / aspect / duration.
 */
function abandonProject(projectId) {
  runSql(
    `UPDATE projects SET completed_at = datetime('now'), stage = 'abandoned', updated_at = datetime('now') WHERE id = ?`,
    [projectId]
  );
}

function getCompletedProjects() {
  return queryAll(
    `SELECT * FROM projects WHERE completed_at IS NOT NULL ORDER BY completed_at DESC`
  );
}

/**
 * Get all projects that have at least one completed scene image.
 * Used by the standalone Publish tab — any project with scenes is eligible
 * for thumbnail generation, regardless of pipeline completion status.
 */
/**
 * Get all projects eligible for publish.
 * Returns all non-abandoned projects that have a project directory.
 * The caller (orchestrator) verifies scene images exist on disk —
 * DB asset status alone isn't reliable because pipelines can crash
 * after generating images but before marking assets as 'done'.
 */
function getPublishableProjects() {
  return queryAll(`
    SELECT p.id, p.title, p.stage, p.project_dir, p.thumbnail_path,
           p.youtube_metadata, p.facebook_metadata, p.published_at, p.created_at
    FROM projects p
    WHERE p.project_dir IS NOT NULL
      AND p.stage NOT IN ('abandoned')
    ORDER BY p.created_at DESC
  `);
}

/**
 * Get total Higgsfield credits used by a project, broken down by asset type.
 * Returns { total, byType: { portrait, scene_image, scene_image_cinematic, video_clip_cinematic, ... } }
 */
function getProjectCreditUsage(projectId) {
  const rows = queryAll(
    `SELECT type, SUM(credit_cost) as total_credits, COUNT(*) as count
     FROM project_assets
     WHERE project_id = ? AND credit_cost IS NOT NULL
     GROUP BY type`,
    [projectId]
  );
  const byType = {};
  let total = 0;
  for (const row of rows) {
    byType[row.type] = { credits: row.total_credits, count: row.count };
    total += row.total_credits;
  }
  return { total, byType };
}


// ── Asset Queries ──

function insertExpectedAssets(projectId, assets) {
  const stmt = db.prepare(`
    INSERT INTO project_assets (project_id, type, chapter, scene, line, character_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  for (const a of assets) {
    stmt.run([projectId, a.type, a.chapter || null, a.scene || null, a.line || null, a.character_id || null]);
  }
  stmt.free();
  save();
}

function markAssetGenerating(assetId, promptUsed) {
  runSql(
    `UPDATE project_assets SET status = 'generating', prompt_used = ? WHERE id = ?`,
    [promptUsed || null, assetId]
  );
}

/**
 * Record that Generate was clicked (credits burned). This timestamp
 * survives resetStuckAssets() so on restart the pipeline knows to attempt
 * recovery from the Asset library instead of re-generating.
 */
function markAssetGenClicked(assetId, creditCost = null) {
  runSql(
    `UPDATE project_assets SET gen_clicked_at = datetime('now'), credit_cost = COALESCE(?, credit_cost) WHERE id = ?`,
    [creditCost, assetId]
  );
}

function markAssetDone(assetId, filePath, genMeta = {}) {
  // Serialize references array to JSON for storage
  const refsJson = genMeta.referencesUsed && genMeta.referencesUsed.length > 0
    ? JSON.stringify(genMeta.referencesUsed)
    : null;

  runSql(
    `UPDATE project_assets SET status = 'done', file_path = ?, completed_at = datetime('now'), model_used = ?, source_gen_id = ?, cdn_url = ?, references_used = ?, generation_duration_ms = ? WHERE id = ?`,
    [
      filePath,
      genMeta.model || null,
      genMeta.sourceGenId || null,
      genMeta.cdnUrl || null,
      refsJson,
      genMeta.generationDurationMs || null,
      assetId
    ]
  );
}

/**
 * Delete an asset row entirely (used for stale/duplicate cleanup).
 */
function deleteAsset(assetId) {
  runSql(`DELETE FROM project_assets WHERE id = ?`, [assetId]);
}

/**
 * Mark a video clip as 'skipped' — excluded from video gen, verify, and assembly.
 * Used by the Dialogue Triage gate for no-dialogue clips that would produce
 * gibberish speech in Kling.
 * @param {number} assetId — the clip asset row to skip
 * @param {string} [reason] — why it was skipped (stored in error_message for audit)
 */
function markAssetSkipped(assetId, reason = 'no-dialogue') {
  runSql(
    `UPDATE project_assets SET status = 'skipped', error_message = ? WHERE id = ?`,
    [`triage:${reason}`, assetId]
  );
}

/**
 * Un-skip a clip — reset back to 'pending' so it can be generated.
 * Used when the user approves a no-dialogue clip as b-roll.
 * @param {number} assetId — the clip asset row to un-skip
 */
function markAssetUnskipped(assetId) {
  runSql(
    `UPDATE project_assets SET status = 'pending', error_message = NULL WHERE id = ?`,
    [assetId]
  );
}

/**
 * Soft-delete: mark an asset as 'archived' instead of deleting.
 * Preserves all metadata (prompt_used, model_used, credit_cost, timestamps)
 * for audit trail and rollback. The file_path is updated to the archive
 * location so the original path is freed for the replacement asset.
 *
 * @param {number} assetId — the asset row to archive
 * @param {string} archivePath — new file path in .archive/ subdirectory
 * @param {string} [versionTag] — version label, e.g. 'v1', 'v2' (stored in error_message for traceability)
 */
function markAssetArchived(assetId, archivePath, versionTag = 'v1') {
  runSql(
    `UPDATE project_assets SET status = 'archived', file_path = ?, error_message = ? WHERE id = ?`,
    [archivePath, `regen:${versionTag}`, assetId]
  );
}

/**
 * Save the CDN URL for an asset as soon as generation completes (before download).
 * This allows re-downloading on restart if the download fails.
 */
function markAssetCdnUrl(assetId, cdnUrl) {
  if (!cdnUrl) return;
  runSql(
    `UPDATE project_assets SET cdn_url = ? WHERE id = ?`,
    [cdnUrl, assetId]
  );
}

/**
 * Mark an asset as successfully recovered from Higgsfield's asset history (vs
 * freshly generated). Called by inline auto-recovery + the CLI tool.
 *
 * Sets status=done, file_path, cdn_url, AND records the source UUID for
 * cross-run dedup + audit. The recovered_from_history flag (added in migration
 * 006) lets reports distinguish recovered clips from generated ones.
 */
function markAssetRecoveredFromHistory(assetId, filePath, { cdnUrl, higgsfieldAssetId, model, sourceGenId }) {
  runSql(
    `UPDATE project_assets SET
       status = 'done',
       file_path = ?,
       cdn_url = ?,
       higgsfield_asset_id = ?,
       recovered_from_history = 1,
       error_message = NULL,
       completed_at = datetime('now'),
       model_used = COALESCE(?, model_used),
       source_gen_id = COALESCE(?, source_gen_id)
     WHERE id = ?`,
    [filePath, cdnUrl || null, higgsfieldAssetId || null, model || null, sourceGenId || null, assetId]
  );
}

/**
 * List clips that are candidates for history recovery. Used by the CLI script.
 * Returns assets that are pending or failed AND don't have a CDN URL captured
 * (because the existing CDN-URL recovery already handles those).
 */
function getHistoryRecoveryCandidates(projectId) {
  return queryAll(
    `SELECT * FROM project_assets
     WHERE project_id = ? AND type = 'video_clip'
       AND status IN ('pending', 'failed')
       AND (cdn_url IS NULL OR cdn_url = '')
       AND prompt_used IS NOT NULL
     ORDER BY chapter, line`,
    [projectId]
  );
}

function markAssetFailed(assetId, errorMessage) {
  runSql(
    `UPDATE project_assets SET status = 'failed', error_message = ?, retry_count = retry_count + 1 WHERE id = ?`,
    [errorMessage, assetId]
  );
}

/**
 * Persist a Verify Clip result (post-MVP verify stage).
 * Saves transcript, similarity, tier, and secondary signals.
 * Resets human_decision to null so a fresh verification requires a fresh human decision.
 */
function saveClipVerification(assetId, verifyResult) {
  if (!verifyResult) return;
  // Cinematic results carry a linesVerified array — fold that into the notes
  // field as a structured suffix the UI can parse + display per-line tiers.
  // Schema-wise we don't add a new column for it (keeps Phase 5 schema-stable);
  // the suffix is JSON-tagged so consumers can detect + parse without grep.
  let notesText = verifyResult.notes || '';
  if (Array.isArray(verifyResult.linesVerified) && verifyResult.linesVerified.length > 0) {
    const linesPayload = JSON.stringify({
      _cinematic: true,
      shotCutsObserved: verifyResult.shotCutsObserved,
      linesVerified: verifyResult.linesVerified,
    });
    notesText = `${notesText}\n\n[CINEMATIC_VERIFY]${linesPayload}[/CINEMATIC_VERIFY]`.trim();
  }

  const artifactsJson = verifyResult.artifacts
    ? JSON.stringify(verifyResult.artifacts)
    : null;
  runSql(
    `UPDATE project_assets SET
       verify_tier = ?,
       verify_similarity = ?,
       verify_transcript = ?,
       verify_mouth_sync = ?,
       verify_character_count = ?,
       verify_artifacts = ?,
       verify_notes = ?,
       verify_human_decision = NULL,
       verified_at = datetime('now')
     WHERE id = ?`,
    [
      verifyResult.tier || null,
      typeof verifyResult.similarity === 'number' ? Math.round(verifyResult.similarity) : null,
      verifyResult.transcript || null,
      verifyResult.mouthSync || null,
      typeof verifyResult.characterCount === 'number' ? verifyResult.characterCount : null,
      artifactsJson,
      notesText || null,
      assetId,
    ]
  );
}

/**
 * Record a user override on a verified clip:
 *   'accepted' → user says the clip is good despite non-accept tier
 *   'rejected' → user wants this clip redone
 * Rejected clips are also reset to pending so the normal video loop regenerates them.
 */
function setVerifyHumanDecision(assetId, decision) {
  if (!['accepted', 'rejected'].includes(decision)) {
    throw new Error(`Invalid verify decision "${decision}" — must be accepted or rejected`);
  }
  runSql(
    `UPDATE project_assets SET verify_human_decision = ? WHERE id = ?`,
    [decision, assetId]
  );
  if (decision === 'rejected') {
    // Delete the old clip file from disk so the video stage can't short-circuit
    // with "found existing file on disk — marking done". Without this, rejected
    // clips get re-adopted instead of regenerated.
    const fs = require('fs');
    const path = require('path');
    const asset = queryOne(`SELECT file_path FROM project_assets WHERE id = ?`, [assetId]);
    if (asset?.file_path && fs.existsSync(asset.file_path)) {
      try {
        // Soft delete: rename to .redo_backup so the video stage can't re-adopt
        // the old file, but it's still recoverable if needed.
        const dir = path.dirname(asset.file_path);
        const ext = path.extname(asset.file_path);
        const base = path.basename(asset.file_path, ext);
        const backupPath = path.join(dir, `${base}_redo_backup_${Date.now()}${ext}`);
        fs.renameSync(asset.file_path, backupPath);
        console.log(`[VERIFY] Soft-deleted old clip for redo: ${asset.file_path} → ${path.basename(backupPath)}`);
      } catch (e) {
        console.warn(`[VERIFY] Could not soft-delete old clip file: ${e.message}`);
      }
    }
    // Reset the asset so the video loop regenerates it FRESH — not recovered.
    // Clear gen_clicked_at so the video stage doesn't try to recover the old
    // generation from Higgsfield's asset library instead of submitting a new one.
    // Clear prompt_used so the rules engine builds a fresh prompt.
    runSql(
      `UPDATE project_assets SET status = 'pending', file_path = NULL, error_message = NULL,
       gen_clicked_at = NULL, prompt_used = NULL, cdn_url = NULL
       WHERE id = ?`,
      [assetId]
    );
  }
}

/**
 * Returns verification data for all video clips in a project,
 * parsed + ready for renderer display. Each row includes:
 *   id, chapter, line, status, file_path, verify_tier, verify_similarity,
 *   verify_transcript, verify_mouth_sync, verify_character_count,
 *   verify_artifacts (parsed array), verify_notes, verify_human_decision, verified_at
 */
function getClipVerifications(projectId) {
  // Returns BOTH staged (video_clip) and cinematic (video_clip_cinematic) rows.
  // Each row keeps its `type` field so consumers can render appropriate UI.
  // Cinematic rows have verify_notes containing a [CINEMATIC_VERIFY]...[/CINEMATIC_VERIFY]
  // tag with per-line scores; we extract that here for convenience.
  const staged = getAssets(projectId, { type: 'video_clip' });
  const cinematic = getAssets(projectId, { type: 'video_clip_cinematic' });
  const all = [...staged, ...cinematic];
  return all.map(r => {
    const out = {
      ...r,
      verify_artifacts: r.verify_artifacts ? safeJsonParse(r.verify_artifacts, []) : [],
    };
    if (r.verify_notes) {
      const m = r.verify_notes.match(/\[CINEMATIC_VERIFY\]([\s\S]*?)\[\/CINEMATIC_VERIFY\]/);
      if (m) {
        try {
          const parsed = JSON.parse(m[1]);
          out.cinematic_verify = parsed;
          // Strip the tag from the visible notes so UI doesn't show the JSON
          out.verify_notes = r.verify_notes.replace(m[0], '').trim();
        } catch (_) {}
      }
    }
    return out;
  });
}

function safeJsonParse(s, fallback) {
  try { return JSON.parse(s); } catch (_) { return fallback; }
}

function resetAsset(assetId) {
  runSql(
    `UPDATE project_assets SET status = 'pending', error_message = NULL WHERE id = ?`,
    [assetId]
  );
}

/**
 * Clear generation metadata on a pending asset so the video stage generates
 * fresh instead of trying to recover from Higgsfield/Kling history.
 * Used by pre-stage redo recovery on resume.
 */
function clearAssetGenerationMeta(assetId) {
  runSql(
    `UPDATE project_assets SET gen_clicked_at = NULL, prompt_used = NULL, cdn_url = NULL WHERE id = ?`,
    [assetId]
  );
}

/**
 * Update the prompt_used field on a scene asset (e.g. to persist vision-verified
 * blocking so it doesn't need to be re-verified on subsequent runs).
 */
function updateAssetPromptUsed(assetId, promptUsed) {
  runSql(
    `UPDATE project_assets SET prompt_used = ? WHERE id = ?`,
    [typeof promptUsed === 'string' ? promptUsed : JSON.stringify(promptUsed), assetId]
  );
  save();
}

function getAssets(projectId, { type, status } = {}) {
  let sql = 'SELECT * FROM project_assets WHERE project_id = ?';
  const params = [projectId];

  if (type) { sql += ' AND type = ?'; params.push(type); }
  if (status) { sql += ' AND status = ?'; params.push(status); }

  sql += ' ORDER BY type, chapter, scene, line';
  return queryAll(sql, params);
}

function getIncompleteAssets(projectId, type) {
  let sql = `SELECT * FROM project_assets WHERE project_id = ? AND status NOT IN ('done', 'skipped', 'archived')`;
  const params = [projectId];
  if (type) { sql += ' AND type = ?'; params.push(type); }
  sql += ' ORDER BY type, chapter, scene, line';
  return queryAll(sql, params);
}

function getAssetCounts(projectId, type) {
  const rows = queryAll(`
    SELECT status, COUNT(*) as count
    FROM project_assets
    WHERE project_id = ? AND type = ?
    GROUP BY status
  `, [projectId, type]);

  const counts = { pending: 0, generating: 0, done: 0, failed: 0 };
  for (const r of rows) counts[r.status] = r.count;
  counts.total = counts.pending + counts.generating + counts.done + counts.failed;
  return counts;
}


// ── Deduplication ──

/**
 * Check if an identical generation already exists (same prompt text, completed,
 * with a valid file on disk). Searches across ALL projects — avoids re-generating
 * the same image/video if it was already produced in a previous run.
 *
 * Cost: single SQLite index scan — effectively free.
 *
 * @param {string} promptText - The full prompt to match
 * @param {string} type - Asset type ('portrait', 'scene_image', 'video_clip')
 * @returns {{ found: boolean, filePath: string|null, model: string|null, sourceGenId: string|null }}
 */
function findExistingGeneration(promptText, type, aspectRatio = null) {
  if (!promptText || !type) return { found: false, filePath: null, model: null, sourceGenId: null, cdnUrl: null };

  // When aspectRatio is provided, only match assets from projects with the same
  // aspect — a 16:9 scene must never dedup against a 9:16 scene with the same prompt.
  // Portraits (1:1 on every project) don't need this scope — all projects generate them square.
  let sql, params;
  if (aspectRatio && (aspectRatio === '16:9' || aspectRatio === '9:16')) {
    sql = `SELECT pa.file_path, pa.model_used, pa.source_gen_id, pa.cdn_url, pa.references_used
           FROM project_assets pa
           JOIN projects p ON p.id = pa.project_id
           WHERE pa.prompt_used = ? AND pa.type = ? AND pa.status = 'done' AND pa.file_path IS NOT NULL
             AND p.aspect_ratio = ?
           ORDER BY pa.completed_at DESC
           LIMIT 1`;
    params = [promptText, type, aspectRatio];
  } else {
    sql = `SELECT file_path, model_used, source_gen_id, cdn_url, references_used
           FROM project_assets
           WHERE prompt_used = ? AND type = ? AND status = 'done' AND file_path IS NOT NULL
           ORDER BY completed_at DESC
           LIMIT 1`;
    params = [promptText, type];
  }
  const row = queryAll(sql, params)[0];

  if (!row || !row.file_path) return { found: false, filePath: null, model: null, sourceGenId: null, cdnUrl: null };

  // Verify the file still exists on disk
  const fs = require('fs');
  if (!fs.existsSync(row.file_path)) {
    console.log(`[DEDUP] Found DB match but file missing: ${row.file_path}`);
    return { found: false, filePath: null, model: null, sourceGenId: null, cdnUrl: null };
  }

  return {
    found: true,
    filePath: row.file_path,
    model: row.model_used || null,
    sourceGenId: row.source_gen_id || null,
    cdnUrl: row.cdn_url || null,
    referencesUsed: row.references_used ? JSON.parse(row.references_used) : null,
  };
}

// ── Crash Recovery ──

/**
 * Reset any assets stuck in 'generating' state back to 'pending'.
 * Called on shutdown and startup — if the app crashed mid-generation,
 * those assets need to be retried.
 */
function resetStuckAssets() {
  if (!db) return 0;
  const stuck = queryAll(
    `SELECT id FROM project_assets WHERE status = 'generating'`
  );
  if (stuck.length === 0) return 0;

  db.run(`UPDATE project_assets SET status = 'pending', error_message = 'Reset after app shutdown/crash' WHERE status = 'generating'`);
  save();
  console.log(`[DB] Reset ${stuck.length} stuck 'generating' assets to 'pending'`);
  return stuck.length;
}

/**
 * Filesystem reconciliation — the local file is the source of truth.
 * If an asset has file_path set and the file EXISTS on disk, mark it 'done'
 * regardless of DB status. If file_path is set but file is MISSING, reset to
 * 'pending' (needs regeneration). This handles crash scenarios where:
 * - Generation completed but markAssetDone() never ran (crash after write)
 * - File was manually deleted (user action)
 * - DB says 'failed' but file actually exists (retry succeeded post-crash)
 */
function reconcileWithFilesystem(projectId) {
  if (!db) return { recovered: 0, invalidated: 0 };

  const allAssets = queryAll(
    `SELECT id, file_path, status, type, locked_at FROM project_assets WHERE project_id = ?`,
    [projectId]
  );

  let recovered = 0;
  let invalidated = 0;

  // Minimum file sizes to detect corrupt/incomplete downloads
  const MIN_FILE_SIZES = {
    portrait: 1024,             // images > 1KB
    character_grid: 1024,
    location_image: 1024,
    scene_image_cinematic: 1024,
    video_clip_cinematic: 10240, // videos > 10KB
  };

  for (const asset of allAssets) {
    if (!asset.file_path) continue;

    // Locked assets are NEVER reset (except video clips which are always redo-eligible)
    if (asset.locked_at && asset.type !== 'video_clip_cinematic') {
      const fileExists = fs.existsSync(asset.file_path);
      if (!fileExists) {
        console.error(`[DB] CRITICAL: Locked asset ${asset.id} (${asset.type}) file missing: ${asset.file_path} — requires manual intervention`);
      }
      continue; // skip all reconciliation for locked assets
    }

    const fileExists = fs.existsSync(asset.file_path);

    // File integrity check: exists but too small → treat as corrupt
    if (fileExists) {
      const minSize = MIN_FILE_SIZES[asset.type] || 0;
      if (minSize > 0) {
        try {
          const stat = fs.statSync(asset.file_path);
          if (stat.size < minSize) {
            // Corrupt/incomplete file — remove and invalidate
            try { fs.unlinkSync(asset.file_path); } catch (_) {}
            runSql(
              `UPDATE project_assets SET status = 'pending', error_message = ? WHERE id = ?`,
              [`Corrupt file (${stat.size} bytes < ${minSize} min) — removed for regeneration`, asset.id]
            );
            invalidated++;
            continue;
          }
        } catch (_) { /* stat failed — let normal logic handle */ }
      }
    }

    if (fileExists && asset.status !== 'done' && asset.status !== 'archived' && asset.status !== 'skipped') {
      // File exists on disk but DB doesn't say done → recover
      runSql(
        `UPDATE project_assets SET status = 'done', completed_at = COALESCE(completed_at, datetime('now')), error_message = COALESCE(error_message, 'recovered-from-disk') WHERE id = ?`,
        [asset.id]
      );
      recovered++;
    } else if (!fileExists && asset.status === 'done') {
      // DB says done but file is missing → invalidate back to pending
      runSql(
        `UPDATE project_assets SET status = 'pending', error_message = 'File missing on disk — needs regeneration' WHERE id = ?`,
        [asset.id]
      );
      invalidated++;
    }
  }

  if (recovered > 0 || invalidated > 0) {
    save();
    console.log(`[DB] Filesystem reconciliation: ${recovered} recovered from disk, ${invalidated} invalidated (file missing)`);
  }
  return { recovered, invalidated };
}

/**
 * Lock an asset permanently. Locked assets are never reset by reconciliation.
 * Called when vision verification passes threshold.
 */
function lockAsset(assetId) {
  if (!db) return;
  runSql(`UPDATE project_assets SET locked_at = datetime('now') WHERE id = ? AND locked_at IS NULL`, [assetId]);
}

/**
 * Check if an asset is locked.
 */
function isAssetLocked(assetId) {
  if (!db) return false;
  const row = queryOne(`SELECT locked_at FROM project_assets WHERE id = ?`, [assetId]);
  return !!(row && row.locked_at);
}

/**
 * Lock all upstream dependencies of a certified asset.
 * Propagates lock based on asset type and matching keys (character_id, chapter/scene).
 *
 * Lock rules:
 *   grid certified → lock its portrait (same character_id)
 *   scene_image certified → lock its location_image + all character grids + portraits used
 *
 * video_clip_cinematic is NEVER locked (always eligible for verify redo).
 */
function lockUpstream(assetId, projectId) {
  if (!db) return;
  const asset = queryOne(`SELECT * FROM project_assets WHERE id = ?`, [assetId]);
  if (!asset) return;

  // Lock self first
  lockAsset(assetId);

  if (asset.type === 'character_grid') {
    // Lock the portrait for this character
    const portraits = queryAll(
      `SELECT id FROM project_assets WHERE project_id = ? AND type = 'portrait' AND character_id = ? AND locked_at IS NULL`,
      [projectId, asset.character_id]
    );
    for (const p of portraits) lockAsset(p.id);

  } else if (asset.type === 'scene_image_cinematic') {
    // Lock the location_image used by this scene
    // We need to find which location this scene uses — stored in prompt_used JSON
    let locHint = null;
    try {
      const meta = asset.prompt_used ? JSON.parse(asset.prompt_used) : {};
      locHint = meta.location_hint || null;
    } catch (_) {}

    if (locHint) {
      // element_name on location_image rows is "{hint}_{initials}" or the cleaned hint.
      // Match by LIKE prefix since the raw hint may not include the title initials suffix.
      const cleanHint = locHint.toLowerCase().replace(/[^a-z0-9_]/g, '_');
      const locAssets = queryAll(
        `SELECT id FROM project_assets WHERE project_id = ? AND type = 'location_image' AND (element_name = ? OR element_name LIKE ? OR element_name = ?) AND locked_at IS NULL`,
        [projectId, locHint, `${cleanHint}%`, cleanHint]
      );
      for (const la of locAssets) lockAsset(la.id);
    }

    // Lock all character grids + portraits for this project
    // (scene certification means all character elements that composed it are valid)
    const grids = queryAll(
      `SELECT id, character_id FROM project_assets WHERE project_id = ? AND type = 'character_grid' AND locked_at IS NULL`,
      [projectId]
    );
    for (const g of grids) {
      lockAsset(g.id);
      // Lock portraits for this character
      const portraits = queryAll(
        `SELECT id FROM project_assets WHERE project_id = ? AND type = 'portrait' AND character_id = ? AND locked_at IS NULL`,
        [projectId, g.character_id]
      );
      for (const p of portraits) lockAsset(p.id);
    }
  }
}

/**
 * Save vision verification result immediately after API call.
 * Persists score/verdict/retries so resume doesn't re-run expensive verification.
 */
function saveVisionResult(assetId, { score, verdict, issues, retries }) {
  runSql(
    `UPDATE project_assets SET
       vision_score = ?,
       vision_verdict = ?,
       vision_retries = ?,
       vision_issues = ?,
       vision_verified_at = datetime('now')
     WHERE id = ?`,
    [
      typeof score === 'number' ? score : null,
      verdict || null,
      typeof retries === 'number' ? retries : 0,
      Array.isArray(issues) ? JSON.stringify(issues) : null,
      assetId,
    ]
  );
}

/**
 * Increment vision retry count for an asset (called on each vision-fail-triggered retry).
 * Returns the new count so caller can check against cap.
 */
function incrementVisionRetries(assetId) {
  runSql(
    `UPDATE project_assets SET vision_retries = COALESCE(vision_retries, 0) + 1 WHERE id = ?`,
    [assetId]
  );
  const row = queryOne(`SELECT vision_retries FROM project_assets WHERE id = ?`, [assetId]);
  return row ? row.vision_retries : 1;
}

/**
 * Get vision retry count for an asset (used on resume to know how many attempts already made).
 */
function getVisionRetries(assetId) {
  const row = queryOne(`SELECT vision_retries FROM project_assets WHERE id = ?`, [assetId]);
  return row ? (row.vision_retries || 0) : 0;
}

/**
 * Run on startup after migrations. Handles any state inconsistencies
 * left over from a crash or unclean shutdown.
 */
function recoverOnStartup() {
  const resetCount = resetStuckAssets();
  if (resetCount > 0) {
    console.log(`[DB] Startup recovery: ${resetCount} assets were mid-generation and have been queued for retry`);
  }

  // Filesystem reconciliation for all active projects
  const activeProject = getActiveProject();
  if (activeProject) {
    reconcileWithFilesystem(activeProject.id);
  }

  // Clean up any stale .tmp file from an interrupted atomic write
  const tmpPath = dbPath + '.tmp';
  if (fs.existsSync(tmpPath)) {
    try {
      fs.unlinkSync(tmpPath);
      console.log('[DB] Cleaned up stale .tmp write file');
    } catch (e) {
      console.warn('[DB] Could not clean .tmp file:', e.message);
    }
  }
}


// ── Research Cache Queries ──

// Cap on concurrent research pools. When a fresh research run completes and the
// user already has MAX_RESEARCH_POOLS active (non-expired) pools, the oldest is
// hard-deleted to make room. Picked 5 as a reasonable balance between "keep
// a week's worth of research angles around" and "don't let the DB accumulate
// forever if the user does nothing but spam fresh research".
const MAX_RESEARCH_POOLS = 5;

/**
 * Return the most-recent non-expired pool. Back-compat path for code paths
 * that don't care which pool they get — the orchestrator now prefers
 * getResearchPoolById() when it has a specific pool in mind.
 */
function getResearchCache() {
  const row = queryOne(
    `SELECT * FROM research_cache WHERE expires_at > datetime('now') ORDER BY fetched_at DESC LIMIT 1`
  );

  if (!row) return null;
  return {
    id: row.id,
    fetchedAt: row.fetched_at,
    expiresAt: row.expires_at,
    youtube: JSON.parse(row.youtube_data),
    analysis: row.analysis_data ? JSON.parse(row.analysis_data) : null,
  };
}

/**
 * Return a specific pool by id. Returns null if expired or not found.
 */
function getResearchPoolById(poolId) {
  if (!poolId) return null;
  const row = queryOne(
    `SELECT * FROM research_cache WHERE id = ? AND expires_at > datetime('now')`,
    [poolId]
  );
  if (!row) return null;
  return {
    id: row.id,
    fetchedAt: row.fetched_at,
    expiresAt: row.expires_at,
    youtube: JSON.parse(row.youtube_data),
    analysis: row.analysis_data ? JSON.parse(row.analysis_data) : null,
  };
}

/**
 * List all non-expired pools, newest first. Used by the launcher to render
 * per-pool cards.
 */
function listActiveResearchPools() {
  return queryAll(
    `SELECT id, fetched_at, expires_at, youtube_data, analysis_data
     FROM research_cache
     WHERE expires_at > datetime('now')
     ORDER BY fetched_at DESC`
  ).map(row => ({
    id: row.id,
    fetchedAt: row.fetched_at,
    expiresAt: row.expires_at,
    youtube: JSON.parse(row.youtube_data),
    analysis: row.analysis_data ? JSON.parse(row.analysis_data) : null,
  }));
}

/**
 * Insert a new pool row without deactivating the others. Enforces the
 * MAX_RESEARCH_POOLS cap by hard-deleting the oldest non-expired pool (by
 * fetched_at) if the cap would be exceeded. Returns the new pool's id.
 *
 * NOTE: pruning a pool cascades conceptually — projects.research_cache_id
 * becomes a dangling reference for any project created from the pruned pool.
 * That's fine: those projects can no longer compute "X of Y unused" for their
 * original pool, but their own stage/asset state is untouched.
 */
function saveResearchCache(youtubeData, analysisData) {
  // Prune oldest pools if we're already at the cap — enforce cap BEFORE insert
  // so the new pool always fits within MAX_RESEARCH_POOLS.
  const active = queryAll(
    `SELECT id, fetched_at FROM research_cache
     WHERE expires_at > datetime('now')
     ORDER BY fetched_at ASC`
  );
  const overflow = active.length - (MAX_RESEARCH_POOLS - 1);
  if (overflow > 0) {
    for (let i = 0; i < overflow; i++) {
      runSql(`DELETE FROM research_cache WHERE id = ?`, [active[i].id]);
    }
    console.log(`[DB] Pruned ${overflow} oldest research pool(s) to make room (cap=${MAX_RESEARCH_POOLS})`);
  }

  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  runSql(`
    INSERT INTO research_cache (fetched_at, expires_at, youtube_data, analysis_data, is_active)
    VALUES (datetime('now'), ?, ?, ?, 1)
  `, [expiresAt, JSON.stringify(youtubeData), JSON.stringify(analysisData)]);

  // Get the id we just inserted so the caller can link projects to it
  const row = queryOne(`SELECT last_insert_rowid() AS id`);
  return row?.id || null;
}

/**
 * Delete a specific pool. Used when the user explicitly removes one from the UI.
 */
function deleteResearchPool(poolId) {
  if (!poolId) return;
  runSql(`DELETE FROM research_cache WHERE id = ?`, [poolId]);
}

/**
 * Back-compat: clear ALL pools. Kept because main.js still exposes a
 * 'clear-research-cache' IPC for developer testing.
 */
function clearResearchCache() {
  runSql(`DELETE FROM research_cache`);
}


// ── Used Videos Queries ──

function markVideosUsed(videoIds, projectId) {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO used_videos (video_id, project_id) VALUES (?, ?)
  `);

  for (const id of videoIds) {
    stmt.run([id, projectId || null]);
  }
  stmt.free();
  save();
}

function getUsedVideoIds() {
  const rows = queryAll('SELECT video_id FROM used_videos');
  return new Set(rows.map(r => r.video_id));
}

/**
 * Return only the video_ids used by projects linked to a specific pool. When
 * poolId is null/undefined, falls back to the global set (back-compat).
 * Used so each pool's "X of Y unused" count isn't polluted by consumption
 * from other pools.
 */
function getUsedVideoIdsForPool(poolId) {
  if (!poolId) return getUsedVideoIds();
  const rows = queryAll(
    `SELECT uv.video_id FROM used_videos uv
     JOIN projects p ON p.id = uv.project_id
     WHERE p.research_cache_id = ?`,
    [poolId]
  );
  return new Set(rows.map(r => r.video_id));
}

/**
 * Back-compat: unused videos from the most-recent pool. The orchestrator now
 * prefers getUnusedVideosForPool(poolId) when a project is bound to a pool.
 */
function getUnusedVideos(poolId = null) {
  const cache = poolId ? getResearchPoolById(poolId) : getResearchCache();
  if (!cache) return { unusedVideos: [], totalVideos: 0, allUsed: true };

  const usedSet = getUsedVideoIdsForPool(cache.id);
  const allVideos = cache.youtube.all || [];
  const unused = allVideos.filter(v => !usedSet.has(v.videoId));

  return {
    unusedVideos: unused,
    totalVideos: allVideos.length,
    allUsed: unused.length === 0,
    poolId: cache.id,
  };
}

/**
 * Per-pool status summary. If poolId omitted, returns most-recent pool status
 * (back-compat). If a poolId is passed, returns status for that specific pool.
 */
function getResearchCacheStatus(poolId = null) {
  const cache = poolId ? getResearchPoolById(poolId) : getResearchCache();
  if (!cache) return { hasCache: false };

  const total = (cache.youtube.all || []).length;
  const expiresIn = Math.max(0, new Date(cache.expiresAt).getTime() - Date.now());
  const storiesProduced = getProducedTitlesForPool(cache.id).length;
  const usedSet = getUsedVideoIdsForPool(cache.id);
  const videosUsed = (cache.youtube.all || []).filter(v => usedSet.has(v.videoId)).length;

  return {
    hasCache: true,
    poolId: cache.id,
    fetchedAt: cache.fetchedAt,
    expiresAt: cache.expiresAt,
    totalVideos: total,
    videosUsed,
    videosUnused: total - videosUsed,
    expiresInHours: Math.round(expiresIn / (1000 * 60 * 60)),
    storiesProduced,
  };
}

/**
 * Summary for every active pool — one row per pool with its counts. Used by
 * the launcher to render the pool list.
 */
function listResearchPoolSummaries() {
  const pools = listActiveResearchPools();
  return pools.map(cache => {
    const total = (cache.youtube.all || []).length;
    const expiresIn = Math.max(0, new Date(cache.expiresAt).getTime() - Date.now());
    const storiesProduced = getProducedTitlesForPool(cache.id).length;
    const usedSet = getUsedVideoIdsForPool(cache.id);
    const videosUsed = (cache.youtube.all || []).filter(v => usedSet.has(v.videoId)).length;
    // Cheap label from first couple AI-original titles — gives the user a
    // glance-able hint about what's in the pool without a rename step.
    const aiTitles = (cache.youtube.aiOriginals || []).slice(0, 2).map(v => v.title).filter(Boolean);
    const label = aiTitles.length ? aiTitles.join(' · ').slice(0, 70) : `Pool ${cache.id}`;
    return {
      poolId: cache.id,
      fetchedAt: cache.fetchedAt,
      expiresAt: cache.expiresAt,
      totalVideos: total,
      videosUsed,
      videosUnused: total - videosUsed,
      expiresInHours: Math.round(expiresIn / (1000 * 60 * 60)),
      storiesProduced,
      label,
    };
  });
}


// ── Produced Titles Queries ──

function recordProducedTitle(projectId, title, themes, similarityScore) {
  // Guard against duplicate insertion on resume (assembly done but project not yet completed)
  if (projectId) {
    const existing = queryOne(
      `SELECT id FROM produced_titles WHERE project_id = ? AND title = ?`,
      [projectId, title]
    );
    if (existing) return; // already recorded for this project
  }
  runSql(`
    INSERT INTO produced_titles (project_id, title, themes, similarity_score)
    VALUES (?, ?, ?, ?)
  `, [projectId, title, JSON.stringify(themes || []), similarityScore || null]);
}

function getProducedTitles() {
  return queryAll('SELECT * FROM produced_titles ORDER BY created_at DESC');
}

/**
 * Produced titles scoped to one pool — returns only titles of projects whose
 * research_cache_id = poolId. Used for per-pool "stories produced" counts
 * and per-pool title-dedup during script generation.
 */
function getProducedTitlesForPool(poolId) {
  if (!poolId) return [];
  return queryAll(
    `SELECT pt.* FROM produced_titles pt
     JOIN projects p ON p.id = pt.project_id
     WHERE p.research_cache_id = ?
     ORDER BY pt.created_at DESC`,
    [poolId]
  );
}

function isTitleProduced(title) {
  const normalized = title.toLowerCase().trim();
  const row = queryOne(
    `SELECT id FROM produced_titles WHERE LOWER(TRIM(title)) = ?`,
    [normalized]
  );
  return !!row;
}


// ── Migration from electron-store ──

function migrateFromStore(store) {
  const migrated = queryOne(
    `SELECT version FROM schema_version WHERE version = -1`
  );
  if (migrated) return; // Already migrated

  let didMigrate = false;

  // Migrate research cache
  const oldCache = store.get('researchCache', null);
  if (oldCache && oldCache.fetchedAt) {
    const age = Date.now() - new Date(oldCache.fetchedAt).getTime();
    const ttl = 7 * 24 * 60 * 60 * 1000;
    if (age < ttl) {
      saveResearchCache(oldCache.youtube, oldCache.analysis);
      console.log('[DB] Migrated researchCache from electron-store');

      if (oldCache.usedVideoIds?.length) {
        markVideosUsed(oldCache.usedVideoIds, null);
        console.log(`[DB] Migrated ${oldCache.usedVideoIds.length} used video IDs`);
      }
    }
    store.delete('researchCache');
    didMigrate = true;
  }

  // Migrate produced stories
  const oldStories = store.get('producedStories', []);
  if (oldStories.length > 0) {
    for (const story of oldStories) {
      recordProducedTitle(story.projectId || null, story.title, story.themes, null);
      if (story.sourceVideoIds?.length) {
        markVideosUsed(story.sourceVideoIds, story.projectId || null);
      }
    }
    store.delete('producedStories');
    console.log(`[DB] Migrated ${oldStories.length} produced stories`);
    didMigrate = true;
  }

  // Mark migration as done
  if (didMigrate) {
    runSql('INSERT OR IGNORE INTO schema_version (version) VALUES (-1)');
    console.log('[DB] electron-store migration complete');
  }
}


// ── Pipeline Events (Activity Log) ──

/**
 * Log a pipeline event for resume context and debugging.
 * @param {string} projectId
 * @param {string} eventType - stage_start, stage_complete, asset_start, asset_done, asset_failed, asset_dedup, pause, resume, cancel, error, session_start, session_end, verification_fail
 * @param {object} [opts] - { stage, assetId, assetLabel, detail }
 */
function logEvent(projectId, eventType, opts = {}) {
  if (!db) return;
  try {
    runSql(`
      INSERT INTO pipeline_events (project_id, event_type, stage, asset_id, asset_label, detail)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [
      projectId,
      eventType,
      opts.stage || null,
      opts.assetId || null,
      opts.assetLabel || null,
      opts.detail || null,
    ]);
  } catch (e) {
    // Non-critical — don't let logging break the pipeline
    console.warn('[DB] Event log write failed:', e.message);
  }
}

/**
 * Get the most recent events for a project, newest first.
 * @param {string} projectId
 * @param {number} [limit=20]
 * @returns {Array} events
 */
function getRecentEvents(projectId, limit = 20) {
  return queryAll(
    `SELECT * FROM pipeline_events WHERE project_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
    [projectId, limit]
  );
}

/**
 * Get the last event of a specific type for a project.
 * @param {string} projectId
 * @param {string} eventType
 * @returns {object|null}
 */
function getLastEvent(projectId, eventType) {
  return queryOne(
    `SELECT * FROM pipeline_events WHERE project_id = ? AND event_type = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
    [projectId, eventType]
  );
}

/**
 * Build a resume context summary: what was happening before the interruption.
 * Returns a structured object the orchestrator can log and the UI can display.
 * @param {string} projectId
 * @returns {object} { lastAction, lastStage, interruptedAsset, recentHistory, sessionDuration }
 */
function getResumeContext(projectId) {
  const events = getRecentEvents(projectId, 30);
  if (events.length === 0) return null;

  const lastEvent = events[0];

  // Find last session_start to calculate how long the previous session ran
  const lastSessionStart = events.find(e => e.event_type === 'session_start');
  const lastSessionEnd = events.find(e => e.event_type === 'session_end' || e.event_type === 'pause' || e.event_type === 'cancel');

  // Find what was interrupted — last asset_start without a matching asset_done/asset_failed
  const lastAssetStart = events.find(e => e.event_type === 'asset_start');
  let interruptedAsset = null;
  if (lastAssetStart) {
    // Check if there's a done/failed for this same asset after the start
    const completion = events.find(e =>
      (e.event_type === 'asset_done' || e.event_type === 'asset_failed' || e.event_type === 'asset_dedup') &&
      e.asset_id === lastAssetStart.asset_id &&
      e.created_at >= lastAssetStart.created_at
    );
    if (!completion) {
      interruptedAsset = {
        assetId: lastAssetStart.asset_id,
        label: lastAssetStart.asset_label,
        stage: lastAssetStart.stage,
        startedAt: lastAssetStart.created_at,
      };
    }
  }

  // Find the last stage that was active
  const lastStageEvent = events.find(e => e.event_type === 'stage_start');

  // Count completions in the last session
  const sessionStartTime = lastSessionStart?.created_at || '1970-01-01';
  const completedInSession = events.filter(e =>
    e.event_type === 'asset_done' && e.created_at >= sessionStartTime
  ).length;
  const failedInSession = events.filter(e =>
    e.event_type === 'asset_failed' && e.created_at >= sessionStartTime
  ).length;
  const dedupedInSession = events.filter(e =>
    e.event_type === 'asset_dedup' && e.created_at >= sessionStartTime
  ).length;

  return {
    lastEvent: {
      type: lastEvent.event_type,
      label: lastEvent.asset_label,
      stage: lastEvent.stage,
      detail: lastEvent.detail,
      at: lastEvent.created_at,
    },
    lastStage: lastStageEvent?.stage || null,
    interruptedAsset,
    sessionStats: {
      completed: completedInSession,
      failed: failedInSession,
      deduped: dedupedInSession,
      startedAt: lastSessionStart?.created_at || null,
      endedAt: lastSessionEnd?.created_at || null,
    },
    recentHistory: events.slice(0, 10).map(e => ({
      type: e.event_type,
      label: e.asset_label || e.stage || '',
      detail: e.detail || '',
      at: e.created_at,
    })),
  };
}

// ── Project Logs (persistent activity log per project) ──

let _logInsertCount = 0;

function insertLog(projectId, level, message) {
  if (!db || !projectId) return;
  db.run(
    `INSERT INTO project_logs (project_id, level, message, created_at) VALUES (?, ?, ?, datetime('now'))`,
    [projectId, level, message]
  );
  // Batch save: flush to disk every 50 log entries to avoid excessive I/O
  // while still keeping logs reasonably durable. Also flushes on level=error.
  _logInsertCount++;
  if (_logInsertCount >= 50 || level === 'error') {
    _logInsertCount = 0;
    save();
  }
}

function getProjectLogs(projectId, { limit = 500, offset = 0, level = null } = {}) {
  let sql = 'SELECT id, level, message, created_at FROM project_logs WHERE project_id = ?';
  const params = [projectId];
  if (level) {
    sql += ' AND level = ?';
    params.push(level);
  }
  sql += ' ORDER BY created_at ASC, id ASC';
  if (limit) {
    sql += ` LIMIT ${parseInt(limit, 10)}`;
  }
  if (offset) {
    sql += ` OFFSET ${parseInt(offset, 10)}`;
  }
  return queryAll(sql, params);
}

function getProjectLogCount(projectId) {
  const row = queryOne('SELECT COUNT(*) as cnt FROM project_logs WHERE project_id = ?', [projectId]);
  return row ? row.cnt : 0;
}

module.exports = {
  init,
  getDb,
  close,
  save,
  // Projects
  getProject,
  getActiveProject,
  createProject,
  setProjectAspectRatio,
  setProjectGeneratorMode,
  setAssetElementName,
  _setKlingClipMeta,
  updateProjectStage,
  updateProject,
  completeProject,
  abandonProject,
  getCompletedProjects,
  getPublishableProjects,
  // Assets
  insertExpectedAssets,
  deleteAsset,
  markAssetArchived,
  markAssetSkipped,
  markAssetUnskipped,
  markAssetGenerating,
  markAssetGenClicked,
  markAssetDone,
  markAssetCdnUrl,
  markAssetFailed,
  resetAsset,
  clearAssetGenerationMeta,
  updateAssetPromptUsed,
  getAssets,
  getIncompleteAssets,
  getAssetCounts,
  // Clip verification (post-MVP verify stage)
  saveClipVerification,
  setVerifyHumanDecision,
  getClipVerifications,
  // History recovery
  markAssetRecoveredFromHistory,
  getHistoryRecoveryCandidates,
  // Research cache
  getResearchCache,
  getResearchPoolById,
  listActiveResearchPools,
  listResearchPoolSummaries,
  saveResearchCache,
  deleteResearchPool,
  clearResearchCache,
  // Used videos
  markVideosUsed,
  getUsedVideoIds,
  getUnusedVideos,
  getResearchCacheStatus,
  // Produced titles
  recordProducedTitle,
  getProducedTitles,
  getProducedTitlesForPool,
  isTitleProduced,
  // Deduplication
  findExistingGeneration,
  // Backup & restore
  backup,
  startAutoBackup,
  stopAutoBackup,
  listBackups,
  restoreBackup,
  // Crash recovery & filesystem reconciliation
  resetStuckAssets,
  recoverOnStartup,
  reconcileWithFilesystem,
  // Vision verification persistence
  saveVisionResult,
  incrementVisionRetries,
  getVisionRetries,
  // Asset locking (vision certification)
  lockAsset,
  isAssetLocked,
  lockUpstream,
  // Pipeline events
  logEvent,
  getRecentEvents,
  getLastEvent,
  getResumeContext,
  // Project logs
  insertLog,
  getProjectLogs,
  getProjectLogCount,
  // Credit tracking
  getProjectCreditUsage,
  // Migration
  migrateFromStore,
  // Low-level query helpers (for modules that need custom SQL)
  queryAll,
  queryOne,
  runSql,
};
