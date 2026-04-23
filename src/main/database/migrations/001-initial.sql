-- 001-initial.sql
-- Core schema for project state tracking, asset management, and research caching.
-- Replaces electron-store for all stateful data (API keys and UI prefs stay in electron-store).

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  title TEXT,
  source_video_ids TEXT DEFAULT '[]',       -- JSON array of YouTube video IDs
  duration_preset TEXT DEFAULT '10min',      -- '1min' | '2min' | '5min' | '10min'
  stage TEXT DEFAULT 'research-done',        -- Pipeline stage marker
  script_json TEXT,                          -- Full script blob (character bible + chapters)
  settings TEXT DEFAULT '{}',               -- JSON: accent, tone, nationality, setting, etc.
  project_dir TEXT,                          -- Absolute path to project assets directory
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  completed_at TEXT                          -- NULL until assembly finishes
);

CREATE TABLE IF NOT EXISTS project_assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type TEXT NOT NULL,                        -- 'portrait' | 'scene_image' | 'video_clip' | 'branding_clip' | 'final_video'
  chapter INTEGER,                           -- NULL for portraits
  scene INTEGER,                             -- NULL for portraits
  line INTEGER,                              -- NULL for portraits
  character_id TEXT,                         -- NULL for non-portrait assets
  file_path TEXT,                            -- Absolute path to generated file
  status TEXT DEFAULT 'pending',             -- 'pending' | 'generating' | 'done' | 'failed'
  retry_count INTEGER DEFAULT 0,
  error_message TEXT,
  prompt_used TEXT,                          -- The prompt that was sent to Higgsfield
  created_at TEXT DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_assets_project ON project_assets(project_id);
CREATE INDEX IF NOT EXISTS idx_assets_status ON project_assets(project_id, status);
CREATE INDEX IF NOT EXISTS idx_assets_type ON project_assets(project_id, type);

CREATE TABLE IF NOT EXISTS research_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fetched_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  youtube_data TEXT NOT NULL,                -- JSON: { aiOriginals, remakeCandidates, all }
  analysis_data TEXT,                        -- JSON: Gemini patterns, themes, etc.
  is_active INTEGER DEFAULT 1               -- Only one active cache at a time
);

CREATE TABLE IF NOT EXISTS used_videos (
  video_id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id),
  used_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS produced_titles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT REFERENCES projects(id),
  title TEXT NOT NULL,
  themes TEXT DEFAULT '[]',                  -- JSON array of theme strings
  similarity_score REAL,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Schema version tracking
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TEXT DEFAULT (datetime('now'))
);

INSERT INTO schema_version (version) VALUES (1);
