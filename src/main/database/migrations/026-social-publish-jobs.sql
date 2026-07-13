-- Additive platform publish jobs for engagement/community posts.
-- Legacy social_posts.facebook_post_id remains the source of truth for existing Facebook flows.

CREATE TABLE IF NOT EXISTS social_publish_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  social_post_id INTEGER NOT NULL,
  platform TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'planned',
  scheduled_date TEXT,
  scheduled_time TEXT,
  title TEXT,
  body TEXT,
  hashtags_json TEXT,
  media_path TEXT,
  remote_post_id TEXT,
  remote_url TEXT,
  upload_confirmed_at TEXT,
  proof_json TEXT,
  metadata_json TEXT,
  validation_json TEXT,
  error_message TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (social_post_id) REFERENCES social_posts(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_social_publish_jobs_post_platform
ON social_publish_jobs(social_post_id, platform);

CREATE INDEX IF NOT EXISTS idx_social_publish_jobs_platform_status
ON social_publish_jobs(platform, status);

CREATE INDEX IF NOT EXISTS idx_social_publish_jobs_schedule
ON social_publish_jobs(platform, scheduled_date, scheduled_time);
