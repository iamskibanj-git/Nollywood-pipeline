-- Social engagement posts around scheduled Shorts.
-- Version 022 exists because some live DBs already recorded version 020/021
-- before this feature branch. All statements are idempotent.

CREATE TABLE IF NOT EXISTS social_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  short_id INTEGER REFERENCES shorts(id) ON DELETE CASCADE,
  post_type TEXT NOT NULL,
  sequence INTEGER DEFAULT 1,
  title TEXT,
  body TEXT,
  hashtags TEXT DEFAULT '[]',
  caption_json TEXT,
  media_path TEXT,
  scheduled_date TEXT,
  scheduled_time TEXT,
  status TEXT DEFAULT 'planned',
  facebook_post_id TEXT,
  error_message TEXT,
  source_character_id TEXT,
  source_character_element_name TEXT,
  source_scene_asset_id INTEGER,
  generated_at TEXT,
  upload_confirmed_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_social_posts_project ON social_posts(project_id);
CREATE INDEX IF NOT EXISTS idx_social_posts_short ON social_posts(short_id);
CREATE INDEX IF NOT EXISTS idx_social_posts_status ON social_posts(project_id, status);
CREATE INDEX IF NOT EXISTS idx_social_posts_schedule ON social_posts(scheduled_date, scheduled_time);

DROP INDEX IF EXISTS idx_social_unique_intro;
DROP INDEX IF EXISTS idx_social_unique_short_type;

CREATE UNIQUE INDEX IF NOT EXISTS idx_social_unique_intro
ON social_posts(project_id, source_character_id, post_type)
WHERE post_type = 'character_intro' AND short_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_social_unique_short_type
ON social_posts(short_id, post_type)
WHERE post_type IN ('character_intro', 'pre_short_teaser', 'post_short_recap') AND short_id IS NOT NULL;

INSERT OR REPLACE INTO schema_version (version) VALUES (22);
