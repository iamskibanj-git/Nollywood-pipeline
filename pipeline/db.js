import fs from 'node:fs';
import path from 'node:path';
import initSqlJs from 'sql.js';
import { pipelineConfig } from './config.js';

const SCHEMA_VERSION = 11;
const RECOVERY_STALE_SECONDS = 2 * 60 * 60;

export async function openPipelineDb({ config = pipelineConfig, logger = console } = {}) {
  const dbPath = path.resolve(config.files.database || 'howto-content.sqlite');
  const backupsDir = path.resolve(config.files.backupsDir || 'backups');
  const SQL = await initSqlJs();
  const db = loadDatabase(SQL, dbPath, logger);
  const store = new PipelineDb({ db, dbPath, backupsDir, logger });
  store.migrate();
  store.recoverInterruptedWork();
  store.save();
  return store;
}

class PipelineDb {
  constructor({ db, dbPath, backupsDir, logger }) {
    this.db = db;
    this.dbPath = dbPath;
    this.backupsDir = backupsDir;
    this.logger = logger;
  }

  migrate() {
    this.run(`
      CREATE TABLE IF NOT EXISTS schema_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
    this.run(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'created',
        stage TEXT,
        options_json TEXT DEFAULT '{}',
        error_message TEXT,
        started_at TEXT DEFAULT (datetime('now')),
        completed_at TEXT,
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);
    this.run(`
      CREATE TABLE IF NOT EXISTS source_pulls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        niche_id TEXT NOT NULL,
        niche_name TEXT,
        source TEXT NOT NULL,
        target_type TEXT DEFAULT 'source',
        target TEXT DEFAULT 'all',
        url TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        item_count INTEGER DEFAULT 0,
        error_message TEXT,
        meta_json TEXT DEFAULT '{}',
        started_at TEXT,
        completed_at TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        UNIQUE(run_id, niche_id, source, target_type, target)
      )
    `);
    this.run(`
      CREATE TABLE IF NOT EXISTS raw_topics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        niche_id TEXT NOT NULL,
        niche_name TEXT,
        facebook_page_name TEXT,
        title TEXT NOT NULL,
        topic_key TEXT NOT NULL,
        source TEXT,
        sources_json TEXT DEFAULT '[]',
        source_count INTEGER DEFAULT 0,
        signal_count INTEGER DEFAULT 0,
        engagement REAL DEFAULT 0,
        engagement_detail_json TEXT,
        signals_json TEXT DEFAULT '[]',
        created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(run_id, niche_id, topic_key)
      )
    `);
    this.run(`
      CREATE TABLE IF NOT EXISTS topic_signals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        raw_topic_id INTEGER NOT NULL REFERENCES raw_topics(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        niche_id TEXT NOT NULL,
        source TEXT NOT NULL,
        engagement REAL DEFAULT 0,
        engagement_detail_json TEXT,
        signal_json TEXT DEFAULT '{}',
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
    this.run(`
      CREATE TABLE IF NOT EXISTS scored_topics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        niche_id TEXT NOT NULL,
        niche_name TEXT,
        facebook_page_name TEXT,
        rank INTEGER NOT NULL,
        topic TEXT NOT NULL,
        hook TEXT NOT NULL,
        image_prompt TEXT NOT NULL,
        sources_json TEXT DEFAULT '[]',
        score_reason TEXT,
        status TEXT NOT NULL DEFAULT 'scored',
        error_message TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        UNIQUE(run_id, niche_id, rank)
      )
    `);
    this.run(`
      CREATE TABLE IF NOT EXISTS posts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        scored_topic_id INTEGER REFERENCES scored_topics(id) ON DELETE SET NULL,
        niche_id TEXT NOT NULL,
        niche_name TEXT,
        facebook_page_name TEXT,
        rank INTEGER NOT NULL,
        topic TEXT NOT NULL,
        topic_key TEXT,
        hook TEXT NOT NULL,
        image_prompt TEXT NOT NULL,
        sources_json TEXT DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'queued',
        content_fingerprint TEXT,
        duplicate_of_post_id INTEGER REFERENCES posts(id) ON DELETE SET NULL,
        duplicate_reason TEXT,
        dedupe_checked_at TEXT,
        visual_fingerprint TEXT,
        visual_dedupe_reason TEXT,
        visual_dedupe_checked_at TEXT,
        image_path TEXT,
        caption TEXT,
        scheduled_date TEXT,
        scheduled_time TEXT,
        facebook_post_id TEXT,
        error_message TEXT,
        review_note TEXT,
        reviewed_at TEXT,
        quality_verdict TEXT,
        quality_checked_at TEXT,
        generated_at TEXT,
        scheduled_at TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        UNIQUE(run_id, niche_id, rank)
      )
    `);
    this.run(`
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
        event_type TEXT NOT NULL,
        stage TEXT,
        niche_id TEXT,
        source TEXT,
        message TEXT,
        data_json TEXT DEFAULT '{}',
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
    this.run(`
      CREATE TABLE IF NOT EXISTS image_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
        niche_id TEXT NOT NULL,
        provider TEXT NOT NULL DEFAULT 'higgsfield',
        model TEXT NOT NULL DEFAULT 'nano-banana',
        mode TEXT NOT NULL DEFAULT 'single-image',
        status TEXT NOT NULL DEFAULT 'pending',
        dry_run INTEGER NOT NULL DEFAULT 0,
        prompt TEXT NOT NULL,
        prompt_payload_json TEXT DEFAULT '{}',
        visual_fingerprint TEXT,
        visual_dedupe_json TEXT,
        manifest_path TEXT,
        output_path TEXT,
        gen_clicked_at TEXT,
        credit_cost REAL,
        source_gen_id TEXT,
        cdn_url TEXT,
        generation_duration_ms INTEGER,
        error_message TEXT,
        started_at TEXT,
        completed_at TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        UNIQUE(run_id, post_id, provider, mode)
      )
    `);
    this.run(`
      CREATE TABLE IF NOT EXISTS content_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
        niche_id TEXT NOT NULL,
        model TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        dry_run INTEGER NOT NULL DEFAULT 0,
        prompt TEXT NOT NULL,
        response_json TEXT,
        caption TEXT,
        validation_json TEXT DEFAULT '{}',
        error_message TEXT,
        started_at TEXT,
        completed_at TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        UNIQUE(run_id, post_id, model)
      )
    `);
    this.run(`
      CREATE TABLE IF NOT EXISTS post_quality_checks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
        niche_id TEXT NOT NULL,
        model TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        dry_run INTEGER NOT NULL DEFAULT 0,
        image_path TEXT,
        caption_hash TEXT,
        prompt TEXT,
        local_checks_json TEXT DEFAULT '{}',
        response_json TEXT,
        verdict TEXT,
        score INTEGER,
        reasons_json TEXT DEFAULT '[]',
        image_findings_json TEXT DEFAULT '{}',
        caption_findings_json TEXT DEFAULT '{}',
        safety_findings_json TEXT DEFAULT '{}',
        recommended_fix TEXT,
        error_message TEXT,
        started_at TEXT,
        completed_at TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        UNIQUE(run_id, post_id)
      )
    `);
    this.run(`
      CREATE TABLE IF NOT EXISTS facebook_page_context_checks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
        niche_id TEXT,
        target_page_name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        active_profile_name TEXT,
        dashboard_url TEXT,
        content_library_url TEXT,
        screenshot_path TEXT,
        error_message TEXT,
        diagnostics_json TEXT DEFAULT '{}',
        started_at TEXT DEFAULT (datetime('now')),
        completed_at TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);
    this.run(`
      CREATE TABLE IF NOT EXISTS facebook_schedule_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
        niche_id TEXT NOT NULL,
        target_page_name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        dry_run INTEGER NOT NULL DEFAULT 1,
        image_path TEXT,
        caption TEXT,
        scheduled_date TEXT,
        scheduled_time TEXT,
        context_check_id INTEGER REFERENCES facebook_page_context_checks(id) ON DELETE SET NULL,
        facebook_post_id TEXT,
        screenshot_path TEXT,
        error_message TEXT,
        started_at TEXT,
        completed_at TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        UNIQUE(run_id, post_id)
      )
    `);
    this.run(`
      CREATE TABLE IF NOT EXISTS batch_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        mode TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running',
        plan_path TEXT,
        filters_json TEXT DEFAULT '{}',
        selected_count INTEGER DEFAULT 0,
        prepared_count INTEGER DEFAULT 0,
        scheduled_count INTEGER DEFAULT 0,
        skipped_count INTEGER DEFAULT 0,
        failed_count INTEGER DEFAULT 0,
        duration_ms INTEGER,
        results_json TEXT DEFAULT '[]',
        error_message TEXT,
        started_at TEXT DEFAULT (datetime('now')),
        completed_at TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);

    this.run(`CREATE INDEX IF NOT EXISTS idx_source_pulls_status ON source_pulls(run_id, status)`);
    this.run(`CREATE INDEX IF NOT EXISTS idx_raw_topics_niche ON raw_topics(run_id, niche_id)`);
    this.run(`CREATE INDEX IF NOT EXISTS idx_scored_topics_niche ON scored_topics(run_id, niche_id, rank)`);
    this.run(`CREATE INDEX IF NOT EXISTS idx_posts_status ON posts(run_id, status)`);
    this.run(`CREATE INDEX IF NOT EXISTS idx_image_jobs_status ON image_jobs(run_id, status)`);
    this.run(`CREATE INDEX IF NOT EXISTS idx_image_jobs_post ON image_jobs(post_id)`);
    this.run(`CREATE INDEX IF NOT EXISTS idx_content_jobs_status ON content_jobs(run_id, status)`);
    this.run(`CREATE INDEX IF NOT EXISTS idx_content_jobs_post ON content_jobs(post_id)`);
    this.run(`CREATE INDEX IF NOT EXISTS idx_quality_checks_status ON post_quality_checks(run_id, status)`);
    this.run(`CREATE INDEX IF NOT EXISTS idx_quality_checks_post ON post_quality_checks(post_id)`);
    this.run(`CREATE INDEX IF NOT EXISTS idx_fb_context_checks_status ON facebook_page_context_checks(run_id, status)`);
    this.run(`CREATE INDEX IF NOT EXISTS idx_fb_context_checks_page ON facebook_page_context_checks(target_page_name, created_at)`);
    this.run(`CREATE INDEX IF NOT EXISTS idx_fb_schedule_jobs_status ON facebook_schedule_jobs(run_id, status)`);
    this.run(`CREATE INDEX IF NOT EXISTS idx_fb_schedule_jobs_post ON facebook_schedule_jobs(post_id)`);
    this.run(`CREATE INDEX IF NOT EXISTS idx_batch_runs_run ON batch_runs(run_id, started_at)`);
    this.run(`CREATE INDEX IF NOT EXISTS idx_batch_runs_status ON batch_runs(status, started_at)`);
    this.run(`CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id, created_at)`);
    this.ensureColumn('posts', 'review_note', 'TEXT');
    this.ensureColumn('posts', 'reviewed_at', 'TEXT');
    this.ensureColumn('posts', 'quality_verdict', 'TEXT');
    this.ensureColumn('posts', 'quality_checked_at', 'TEXT');
    this.ensureColumn('posts', 'content_generated_at', 'TEXT');
    this.ensureColumn('posts', 'topic_key', 'TEXT');
    this.ensureColumn('posts', 'content_fingerprint', 'TEXT');
    this.ensureColumn('posts', 'duplicate_of_post_id', 'INTEGER');
    this.ensureColumn('posts', 'duplicate_reason', 'TEXT');
    this.ensureColumn('posts', 'dedupe_checked_at', 'TEXT');
    this.ensureColumn('posts', 'visual_fingerprint', 'TEXT');
    this.ensureColumn('posts', 'visual_dedupe_reason', 'TEXT');
    this.ensureColumn('posts', 'visual_dedupe_checked_at', 'TEXT');
    this.run(`CREATE INDEX IF NOT EXISTS idx_posts_dedup ON posts(niche_id, content_fingerprint, status)`);
    this.run(`CREATE INDEX IF NOT EXISTS idx_posts_duplicate_of ON posts(duplicate_of_post_id)`);
    this.ensureColumn('image_jobs', 'gen_clicked_at', 'TEXT');
    this.ensureColumn('image_jobs', 'credit_cost', 'REAL');
    this.ensureColumn('image_jobs', 'source_gen_id', 'TEXT');
    this.ensureColumn('image_jobs', 'cdn_url', 'TEXT');
    this.ensureColumn('image_jobs', 'generation_duration_ms', 'INTEGER');
    this.ensureColumn('image_jobs', 'visual_fingerprint', 'TEXT');
    this.ensureColumn('image_jobs', 'visual_dedupe_json', 'TEXT');
    this.ensureColumn('batch_runs', 'results_json', 'TEXT DEFAULT \'[]\'');
    this.run(`INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('schema_version', ?)`, [String(SCHEMA_VERSION)]);
  }

  ensureColumn(tableName, columnName, definition) {
    const columns = this.queryAll(`PRAGMA table_info(${tableName})`);
    if (columns.some(column => column.name === columnName)) return;
    this.run(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }

  recoverInterruptedWork() {
    const now = isoNow();
    this.run(
      `UPDATE source_pulls
       SET status = 'pending', error_message = COALESCE(error_message, 'Reset after interrupted run'), updated_at = ?
       WHERE status = 'running'
         AND (strftime('%s', ?) - strftime('%s', COALESCE(updated_at, started_at, created_at))) > ?`,
      [now, now, RECOVERY_STALE_SECONDS]
    );
    this.run(
      `UPDATE posts
       SET status = 'approved', error_message = COALESCE(error_message, 'Reset after interrupted image generation'), updated_at = ?
       WHERE status = 'image_generating'
         AND (strftime('%s', ?) - strftime('%s', COALESCE(updated_at, generated_at, created_at))) > ?`,
      [now, now, RECOVERY_STALE_SECONDS]
    );
    this.run(
      `UPDATE posts
       SET status = 'content_done', error_message = COALESCE(error_message, 'Reset after interrupted scheduling'), updated_at = ?
       WHERE status = 'scheduling'
         AND (strftime('%s', ?) - strftime('%s', COALESCE(updated_at, quality_checked_at, created_at))) > ?`,
      [now, now, RECOVERY_STALE_SECONDS]
    );
    this.run(
      `UPDATE posts
       SET status = 'image_done', error_message = COALESCE(error_message, 'Reset after interrupted content generation'), updated_at = ?
       WHERE status = 'content_generating'
         AND (strftime('%s', ?) - strftime('%s', COALESCE(updated_at, generated_at, created_at))) > ?`,
      [now, now, RECOVERY_STALE_SECONDS]
    );
    this.run(
      `UPDATE posts
       SET status = 'content_done', error_message = COALESCE(error_message, 'Reset after interrupted quality check'), updated_at = ?
       WHERE status = 'qa_generating'
         AND (strftime('%s', ?) - strftime('%s', COALESCE(updated_at, content_generated_at, created_at))) > ?`,
      [now, now, RECOVERY_STALE_SECONDS]
    );
    this.run(
      `UPDATE image_jobs
       SET status = 'pending', error_message = COALESCE(error_message, 'Reset after interrupted image generation'), updated_at = ?
       WHERE status = 'generating'
         AND (strftime('%s', ?) - strftime('%s', COALESCE(updated_at, started_at, created_at))) > ?`,
      [now, now, RECOVERY_STALE_SECONDS]
    );
    this.run(
      `UPDATE content_jobs
       SET status = 'pending', error_message = COALESCE(error_message, 'Reset after interrupted content generation'), updated_at = ?
       WHERE status = 'generating'
         AND (strftime('%s', ?) - strftime('%s', COALESCE(updated_at, started_at, created_at))) > ?`,
      [now, now, RECOVERY_STALE_SECONDS]
    );
    this.run(
      `UPDATE post_quality_checks
       SET status = 'failed',
           error_message = COALESCE(error_message, 'Interrupted before quality check completion'),
           completed_at = COALESCE(completed_at, ?),
           updated_at = ?
       WHERE status = 'running'
         AND (strftime('%s', ?) - strftime('%s', COALESCE(updated_at, started_at, created_at))) > ?`,
      [now, now, now, RECOVERY_STALE_SECONDS]
    );
    this.run(
      `UPDATE facebook_page_context_checks
       SET status = 'failed',
           error_message = COALESCE(error_message, 'Interrupted before context check completion'),
           completed_at = COALESCE(completed_at, ?),
           updated_at = ?
       WHERE status IN ('pending', 'running')
         AND (strftime('%s', ?) - strftime('%s', COALESCE(updated_at, started_at, created_at))) > ?`,
      [now, now, now, RECOVERY_STALE_SECONDS]
    );
    this.run(
      `UPDATE facebook_schedule_jobs
       SET status = 'failed',
           error_message = COALESCE(error_message, 'Interrupted before Facebook schedule completion'),
           completed_at = COALESCE(completed_at, ?),
           updated_at = ?
       WHERE status IN ('pending', 'running') AND dry_run = 0
         AND (strftime('%s', ?) - strftime('%s', COALESCE(updated_at, started_at, created_at))) > ?`,
      [now, now, now, RECOVERY_STALE_SECONDS]
    );
    this.run(
      `UPDATE batch_runs
       SET status = 'failed',
           error_message = COALESCE(error_message, 'Interrupted before batch completion'),
           completed_at = COALESCE(completed_at, ?),
           duration_ms = COALESCE(duration_ms, CAST((julianday(?) - julianday(started_at)) * 86400000 AS INTEGER)),
           updated_at = ?
       WHERE status = 'running'
         AND started_at IS NOT NULL
         AND (strftime('%s', ?) - strftime('%s', started_at)) > ?`,
      [now, now, now, now, RECOVERY_STALE_SECONDS]
    );
    this.run(
      `UPDATE runs
       SET status = 'failed',
           error_message = COALESCE(error_message, 'Interrupted before completion'),
           completed_at = COALESCE(completed_at, ?),
           updated_at = ?
       WHERE status IN ('created', 'scraping', 'scoring', 'queueing', 'generating_images', 'generating_content', 'scheduling')
         AND (strftime('%s', ?) - strftime('%s', COALESCE(updated_at, started_at))) > ?`,
      [now, now, now, RECOVERY_STALE_SECONDS]
    );
  }

  backup(tag = 'manual') {
    this.save();
    if (!fs.existsSync(this.dbPath)) return null;
    fs.mkdirSync(this.backupsDir, { recursive: true });
    const safeTag = safeName(tag);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(this.backupsDir, `howto-content_${stamp}_${safeTag}.sqlite`);
    fs.copyFileSync(this.dbPath, backupPath);
    this.logger?.info?.('[DB] Backup created', backupPath);
    return backupPath;
  }

  createRun({ options = {} } = {}) {
    const id = makeRunId();
    this.run(
      `INSERT INTO runs (id, status, options_json, started_at, updated_at)
       VALUES (?, 'created', ?, ?, ?)`,
      [id, stringifyJson(options, {}), isoNow(), isoNow()]
    );
    this.logEvent(id, 'run_created', { data: options });
    this.save();
    return id;
  }

  updateRun(runId, fields = {}) {
    const allowed = ['status', 'stage', 'error_message', 'completed_at'];
    const sets = [];
    const values = [];
    for (const key of allowed) {
      if (Object.prototype.hasOwnProperty.call(fields, key)) {
        sets.push(`${key} = ?`);
        values.push(fields[key]);
      }
    }
    if (sets.length === 0) return;
    sets.push('updated_at = ?');
    values.push(isoNow(), runId);
    this.run(`UPDATE runs SET ${sets.join(', ')} WHERE id = ?`, values);
    this.save();
  }

  stageStart(runId, stage) {
    const status = stageToRunStatus(stage);
    this.updateRun(runId, { status, stage, error_message: null });
    this.logEvent(runId, 'stage_start', { stage });
  }

  stageEnd(runId, stage, data = {}) {
    this.logEvent(runId, 'stage_complete', { stage, data });
  }

  stageFailed(runId, stage, error) {
    const message = error?.message || String(error || 'Unknown error');
    this.updateRun(runId, { status: 'failed', stage, error_message: message, completed_at: isoNow() });
    this.logEvent(runId, 'stage_failed', { stage, message, data: { stack: error?.stack || null } });
  }

  finishRun(runId, { ok = true } = {}) {
    this.updateRun(runId, {
      status: ok ? 'done' : 'failed',
      completed_at: isoNow(),
    });
    this.logEvent(runId, ok ? 'run_complete' : 'run_failed');
  }

  markSourcePullStart(runId, niche, source, meta = {}) {
    this.upsertSourcePull(runId, niche, source, {
      status: 'running',
      started_at: isoNow(),
      completed_at: null,
      item_count: 0,
      error_message: null,
      meta_json: stringifyJson(meta, {}),
    });
    this.logEvent(runId, 'source_start', { nicheId: niche.id, source, data: meta });
  }

  markSourcePullDone(runId, niche, source, itemCount = 0, meta = {}) {
    this.upsertSourcePull(runId, niche, source, {
      status: 'done',
      completed_at: isoNow(),
      item_count: itemCount,
      error_message: null,
      meta_json: stringifyJson(meta, {}),
    });
    this.logEvent(runId, 'source_done', { nicheId: niche.id, source, data: { ...meta, itemCount } });
  }

  markSourcePullFailed(runId, niche, source, error, meta = {}) {
    this.upsertSourcePull(runId, niche, source, {
      status: 'failed',
      completed_at: isoNow(),
      error_message: error?.message || String(error || 'Unknown error'),
      meta_json: stringifyJson(meta, {}),
    });
    this.logEvent(runId, 'source_failed', {
      nicheId: niche.id,
      source,
      message: error?.message || String(error || 'Unknown error'),
      data: meta,
    });
  }

  upsertSourcePull(runId, niche, source, fields = {}) {
    const existing = this.queryOne(
      `SELECT id FROM source_pulls
       WHERE run_id = ? AND niche_id = ? AND source = ? AND target_type = 'source' AND target = 'all'`,
      [runId, niche.id, source]
    );
    if (!existing) {
      this.run(
        `INSERT INTO source_pulls
         (run_id, niche_id, niche_name, source, target_type, target, status, item_count, error_message, meta_json, started_at, completed_at, updated_at)
         VALUES (?, ?, ?, ?, 'source', 'all', ?, ?, ?, ?, ?, ?, ?)`,
        [
          runId,
          niche.id,
          niche.name,
          source,
          fields.status || 'pending',
          fields.item_count ?? 0,
          fields.error_message || null,
          fields.meta_json || '{}',
          fields.started_at || null,
          fields.completed_at || null,
          isoNow(),
        ]
      );
    } else {
      const sets = [];
      const values = [];
      for (const key of ['status', 'item_count', 'error_message', 'meta_json', 'started_at', 'completed_at']) {
        if (Object.prototype.hasOwnProperty.call(fields, key)) {
          sets.push(`${key} = ?`);
          values.push(fields[key]);
        }
      }
      sets.push('updated_at = ?');
      values.push(isoNow(), existing.id);
      this.run(`UPDATE source_pulls SET ${sets.join(', ')} WHERE id = ?`, values);
    }
    this.save();
  }

  saveRawTopics(runId, raw) {
    this.backup(`pre-raw-${runId}`);
    this.run(`DELETE FROM topic_signals WHERE run_id = ?`, [runId]);
    this.run(`DELETE FROM raw_topics WHERE run_id = ?`, [runId]);
    for (const pageInfo of raw.pages || []) {
      for (const item of pageInfo.items || []) {
        const topicKeyValue = topicKey(item.title);
        if (!topicKeyValue) continue;
        this.run(
          `INSERT OR REPLACE INTO raw_topics
           (run_id, niche_id, niche_name, facebook_page_name, title, topic_key, source, sources_json,
            source_count, signal_count, engagement, engagement_detail_json, signals_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            runId,
            pageInfo.niche_id,
            pageInfo.niche_name,
            pageInfo.facebook_page_name || pageInfo.niche_name,
            item.title,
            topicKeyValue,
            item.source || first(item.sources) || null,
            stringifyJson(item.sources || [], []),
            item.source_count ?? (Array.isArray(item.sources) ? item.sources.length : item.source ? 1 : 0),
            item.signal_count ?? (Array.isArray(item.signals) ? item.signals.length : 1),
            Number.isFinite(Number(item.engagement)) ? Number(item.engagement) : 0,
            item.engagement_detail ? stringifyJson(item.engagement_detail, null) : null,
            stringifyJson(item.signals || [], []),
          ]
        );
        const row = this.queryOne(
          `SELECT id FROM raw_topics WHERE run_id = ? AND niche_id = ? AND topic_key = ?`,
          [runId, pageInfo.niche_id, topicKeyValue]
        );
        for (const signal of item.signals || []) {
          this.run(
            `INSERT INTO topic_signals
             (raw_topic_id, run_id, niche_id, source, engagement, engagement_detail_json, signal_json)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
              row.id,
              runId,
              pageInfo.niche_id,
              signal.source || item.source || 'unknown',
              Number.isFinite(Number(signal.engagement)) ? Number(signal.engagement) : 0,
              signal.engagement_detail ? stringifyJson(signal.engagement_detail, null) : null,
              stringifyJson(signal, {}),
            ]
          );
        }
      }
    }
    this.logEvent(runId, 'raw_topics_saved', { data: raw.totals || {} });
    this.save();
  }

  exportRawTopics(runId) {
    const pages = this.queryAll(
      `SELECT niche_id, niche_name, facebook_page_name, COUNT(*) AS item_count
       FROM raw_topics
       WHERE run_id = ?
       GROUP BY niche_id, niche_name, facebook_page_name
       ORDER BY niche_id`,
      [runId]
    ).map(page => {
      const rows = this.queryAll(
        `SELECT * FROM raw_topics WHERE run_id = ? AND niche_id = ? ORDER BY source_count DESC, engagement DESC, id ASC`,
        [runId, page.niche_id]
      );
      return {
        niche_id: page.niche_id,
        niche_name: page.niche_name,
        facebook_page_name: page.facebook_page_name,
        generated_at: isoNow(),
        items: rows.map(row => ({
          title: row.title,
          source: row.source,
          sources: parseJson(row.sources_json, []),
          source_count: row.source_count,
          signal_count: row.signal_count,
          engagement: row.engagement,
          engagement_detail: parseJson(row.engagement_detail_json, undefined),
          signals: parseJson(row.signals_json, []),
          niche_id: row.niche_id,
        })),
      };
    });
    return {
      generated_at: isoNow(),
      run_id: runId,
      pages,
      totals: {
        niches: pages.length,
        items: pages.reduce((sum, page) => sum + page.items.length, 0),
      },
    };
  }

  hasRawTopics(runId) {
    const row = this.queryOne(`SELECT COUNT(*) AS count FROM raw_topics WHERE run_id = ?`, [runId]);
    return Number(row?.count || 0) > 0;
  }

  saveScoredTopics(runId, scored) {
    this.backup(`pre-scored-${runId}`);
    for (const pageInfo of scored.pages || []) {
      for (const topic of pageInfo.topics || []) {
        const existing = this.queryOne(
          `SELECT id FROM scored_topics WHERE run_id = ? AND niche_id = ? AND rank = ?`,
          [runId, pageInfo.niche_id, topic.rank]
        );
        const values = [
          pageInfo.niche_name,
          pageInfo.facebook_page_name || pageInfo.niche_name,
          topic.topic,
          topic.hook,
          topic.image_prompt,
          stringifyJson(topic.sources || [], []),
          topic.score_reason || null,
          isoNow(),
        ];
        if (existing) {
          this.run(
            `UPDATE scored_topics
             SET niche_name = ?, facebook_page_name = ?, topic = ?, hook = ?, image_prompt = ?,
                 sources_json = ?, score_reason = ?, updated_at = ?
             WHERE id = ?`,
            [...values, existing.id]
          );
        } else {
          this.run(
            `INSERT INTO scored_topics
             (run_id, niche_id, niche_name, facebook_page_name, rank, topic, hook, image_prompt, sources_json, score_reason, status, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scored', ?)`,
            [
              runId,
              pageInfo.niche_id,
              pageInfo.niche_name,
              pageInfo.facebook_page_name || pageInfo.niche_name,
              topic.rank,
              topic.topic,
              topic.hook,
              topic.image_prompt,
              stringifyJson(topic.sources || [], []),
              topic.score_reason || null,
              isoNow(),
            ]
          );
        }
      }
    }
    this.logEvent(runId, 'scored_topics_saved', { data: { pages: scored.pages?.length || 0 } });
    this.save();
  }

  exportScoredTopics(runId) {
    const pages = this.queryAll(
      `SELECT niche_id, niche_name, facebook_page_name
       FROM scored_topics
       WHERE run_id = ?
       GROUP BY niche_id, niche_name, facebook_page_name
       ORDER BY niche_id`,
      [runId]
    ).map(page => ({
      niche_id: page.niche_id,
      niche_name: page.niche_name,
      facebook_page_name: page.facebook_page_name,
      topics: this.queryAll(
        `SELECT * FROM scored_topics WHERE run_id = ? AND niche_id = ? ORDER BY rank ASC`,
        [runId, page.niche_id]
      ).map(row => ({
        rank: row.rank,
        topic: row.topic,
        hook: row.hook,
        image_prompt: row.image_prompt,
        sources: parseJson(row.sources_json, []),
        score_reason: row.score_reason || '',
      })),
    }));
    return { generated_at: isoNow(), run_id: runId, pages };
  }

  hasScoredTopics(runId) {
    const row = this.queryOne(`SELECT COUNT(*) AS count FROM scored_topics WHERE run_id = ?`, [runId]);
    return Number(row?.count || 0) > 0;
  }

  savePosts(runId, posts) {
    this.backup(`pre-posts-${runId}`);
    for (const post of posts || []) {
      const scored = this.queryOne(
        `SELECT id FROM scored_topics WHERE run_id = ? AND niche_id = ? AND rank = ?`,
        [runId, post.niche_id, post.rank]
      );
      const existing = this.queryOne(
        `SELECT id, status FROM posts WHERE run_id = ? AND niche_id = ? AND rank = ?`,
        [runId, post.niche_id, post.rank]
      );
      const nextStatus = existing && existing.status !== 'queued' ? existing.status : post.status || 'queued';
      const values = [
        scored?.id || null,
        post.niche_name,
        post.facebook_page_name,
        post.topic,
        post.topic_key || null,
        post.hook,
        post.image_prompt,
        stringifyJson(post.sources || [], []),
        nextStatus,
        post.content_fingerprint || null,
        post.duplicate_of_post_id || null,
        post.duplicate_reason || null,
        post.dedupe_checked_at || null,
        post.error_message || null,
        isoNow(),
      ];
      if (existing) {
        this.run(
          `UPDATE posts
           SET scored_topic_id = ?, niche_name = ?, facebook_page_name = ?, topic = ?, topic_key = ?, hook = ?,
               image_prompt = ?, sources_json = ?, status = ?, content_fingerprint = ?,
               duplicate_of_post_id = ?, duplicate_reason = ?, dedupe_checked_at = ?,
               error_message = ?, updated_at = ?
           WHERE id = ?`,
          [...values, existing.id]
        );
      } else {
        this.run(
          `INSERT INTO posts
           (run_id, scored_topic_id, niche_id, niche_name, facebook_page_name, rank, topic, topic_key,
            hook, image_prompt, sources_json, status, content_fingerprint, duplicate_of_post_id,
            duplicate_reason, dedupe_checked_at, error_message, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            runId,
            scored?.id || null,
            post.niche_id,
            post.niche_name,
            post.facebook_page_name,
            post.rank,
            ...values.slice(3),
          ]
        );
      }
    }
    this.logEvent(runId, 'posts_saved', { data: { posts: posts?.length || 0 } });
    this.save();
  }

  exportPosts(runId) {
    return this.queryAll(
      `SELECT * FROM posts WHERE run_id = ? ORDER BY niche_id, rank ASC`,
      [runId]
    ).map(row => ({
      id: row.id,
      run_id: row.run_id,
      niche_id: row.niche_id,
      niche_name: row.niche_name,
      facebook_page_name: row.facebook_page_name,
      rank: row.rank,
      topic: row.topic,
      topic_key: row.topic_key || undefined,
      hook: row.hook,
      image_prompt: row.image_prompt,
      sources: parseJson(row.sources_json, []),
      status: row.status,
      content_fingerprint: row.content_fingerprint || undefined,
      duplicate_of_post_id: row.duplicate_of_post_id || undefined,
      duplicate_reason: row.duplicate_reason || undefined,
      dedupe_checked_at: row.dedupe_checked_at || undefined,
      visual_fingerprint: row.visual_fingerprint ? parseJson(row.visual_fingerprint, undefined) : undefined,
      visual_dedupe_reason: row.visual_dedupe_reason || undefined,
      visual_dedupe_checked_at: row.visual_dedupe_checked_at || undefined,
      image_path: row.image_path || undefined,
      caption: row.caption || undefined,
      scheduled_date: row.scheduled_date || undefined,
      scheduled_time: row.scheduled_time || undefined,
      facebook_post_id: row.facebook_post_id || undefined,
      error_message: row.error_message || undefined,
      review_note: row.review_note || undefined,
      reviewed_at: row.reviewed_at || undefined,
      quality_verdict: row.quality_verdict || undefined,
      quality_checked_at: row.quality_checked_at || undefined,
      generated_at: row.generated_at || undefined,
      content_generated_at: row.content_generated_at || undefined,
      scheduled_at: row.scheduled_at || undefined,
    }));
  }

  logEvent(runId, eventType, { stage = null, nicheId = null, source = null, message = null, data = {} } = {}) {
    this.run(
      `INSERT INTO events (run_id, event_type, stage, niche_id, source, message, data_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [runId || null, eventType, stage, nicheId, source, message, stringifyJson(data, {})]
    );
    this.save();
  }

  queryAll(sql, params = []) {
    const stmt = this.db.prepare(sql);
    try {
      stmt.bind(params);
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      return rows;
    } finally {
      stmt.free();
    }
  }

  queryOne(sql, params = []) {
    return this.queryAll(sql, params)[0] || null;
  }

  run(sql, params = []) {
    this.db.run(sql, params);
  }

  save() {
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    const data = this.db.export();
    const tmpPath = `${this.dbPath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmpPath, Buffer.from(data));
    renameWithRetry(tmpPath, this.dbPath);
  }

  close() {
    this.save();
    this.db.close();
  }
}

function loadDatabase(SQL, dbPath, logger) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  if (!fs.existsSync(dbPath)) {
    logger?.info?.('[DB] Created new how-to database', dbPath);
    return new SQL.Database();
  }
  try {
    const buffer = fs.readFileSync(dbPath);
    if (buffer.length === 0) throw new Error('Empty database file');
    logger?.info?.('[DB] Loaded how-to database', dbPath);
    return new SQL.Database(buffer);
  } catch (error) {
    const corruptPath = `${dbPath}.corrupt.${Date.now()}`;
    fs.renameSync(dbPath, corruptPath);
    logger?.warn?.('[DB] Corrupt how-to database moved aside', corruptPath);
    return new SQL.Database();
  }
}

function renameWithRetry(tmpPath, finalPath) {
  let lastError = null;
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      fs.renameSync(tmpPath, finalPath);
      return;
    } catch (error) {
      lastError = error;
      if (!['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY'].includes(error.code) || !fs.existsSync(tmpPath)) {
        break;
      }
      sleepSync(Math.min(250, 25 * attempt));
    }
  }
  throw lastError;
}

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch (_) {
    const end = Date.now() + ms;
    while (Date.now() < end) {}
  }
}

function stageToRunStatus(stage) {
  return {
    scraper: 'scraping',
    scorer: 'scoring',
    queue: 'queueing',
    content: 'generating_content',
  }[stage] || stage || 'running';
}

function makeRunId() {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `${stamp}_${Math.random().toString(16).slice(2, 10)}`;
}

function stringifyJson(value, fallback) {
  try {
    return JSON.stringify(value ?? fallback);
  } catch (_) {
    return JSON.stringify(fallback);
  }
}

function parseJson(value, fallback) {
  if (value == null) return fallback;
  try {
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
}

function topicKey(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function safeName(value) {
  return String(value || 'manual').replace(/[^a-z0-9_-]+/gi, '_').slice(0, 80);
}

function first(value) {
  return Array.isArray(value) ? value[0] : null;
}

function isoNow() {
  return new Date().toISOString();
}
