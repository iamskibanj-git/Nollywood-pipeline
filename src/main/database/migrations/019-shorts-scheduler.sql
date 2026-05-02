-- Migration 019: Shorts scheduler — repurpose clips into scheduled Facebook Reels
-- Standalone tab that processes completed projects into 30-day reel calendars.

CREATE TABLE IF NOT EXISTS shorts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  short_number INTEGER NOT NULL,              -- 1-30+ sequential within project
  title TEXT,                                 -- Generated hook/title for the reel
  description TEXT,                           -- SEO description with hashtags + CTA
  hashtags TEXT DEFAULT '[]',                 -- JSON array of hashtag strings
  source_clips TEXT NOT NULL,                 -- JSON array of clip asset IDs used
  file_path TEXT,                             -- Absolute path to assembled short video
  duration_seconds REAL,                      -- Final duration after FFmpeg assembly
  scheduled_date TEXT,                        -- ISO date for scheduled publish (YYYY-MM-DD)
  scheduled_time TEXT DEFAULT '18:00',        -- Time of day for publish (HH:MM)
  status TEXT DEFAULT 'pending',             -- 'pending' | 'assembled' | 'seo_done' | 'uploaded' | 'scheduled' | 'failed'
  upload_confirmed_at TEXT,                   -- Timestamp when FB upload confirmed
  facebook_post_id TEXT,                      -- FB post ID if available after scheduling
  error_message TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_shorts_project ON shorts(project_id);
CREATE INDEX IF NOT EXISTS idx_shorts_status ON shorts(project_id, status);
CREATE INDEX IF NOT EXISTS idx_shorts_schedule ON shorts(scheduled_date);

-- Track project repurpose status
ALTER TABLE projects ADD COLUMN repurposed_at TEXT DEFAULT NULL;

INSERT INTO schema_version (version) VALUES (19);
