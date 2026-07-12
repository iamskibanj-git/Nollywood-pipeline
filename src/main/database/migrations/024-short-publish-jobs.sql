-- Multi-platform publish jobs for Shorts.
-- Additive layer for YouTube and future platforms. Legacy shorts.facebook_post_id
-- and shorts.status remain the source of truth for existing Facebook flows.

CREATE TABLE IF NOT EXISTS short_publish_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  short_id INTEGER NOT NULL REFERENCES shorts(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  status TEXT DEFAULT 'planned',
  scheduled_date TEXT,
  scheduled_time TEXT,
  title TEXT,
  description TEXT,
  hashtags_json TEXT DEFAULT '[]',
  remote_post_id TEXT,
  remote_url TEXT,
  upload_confirmed_at TEXT,
  proof_json TEXT,
  metadata_json TEXT,
  validation_json TEXT,
  error_message TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_short_publish_jobs_short_platform
ON short_publish_jobs(short_id, platform);

CREATE INDEX IF NOT EXISTS idx_short_publish_jobs_platform_status
ON short_publish_jobs(platform, status);

CREATE INDEX IF NOT EXISTS idx_short_publish_jobs_schedule
ON short_publish_jobs(platform, scheduled_date, scheduled_time);

INSERT OR REPLACE INTO schema_version (version) VALUES (24);
