-- 003-pipeline-events.sql
-- Persistent activity log for pipeline resume context.
-- Records every meaningful action so on resume we know exactly what happened
-- before interruption: what was the last asset attempted, did it succeed or fail,
-- what stage were we in, etc.

CREATE TABLE IF NOT EXISTS pipeline_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  event_type TEXT NOT NULL,          -- stage_start, stage_complete, asset_start, asset_done, asset_failed, asset_dedup, pause, resume, cancel, error, session_start, session_end, verification_fail
  stage TEXT,                        -- research, script, portraits, scenes, video, assembly
  asset_id INTEGER,                  -- FK to project_assets.id (nullable for stage-level events)
  asset_label TEXT,                  -- Human-readable: "portrait 3/5: Adaeze", "scene Ch2 L4", "clip Ch1 L2"
  detail TEXT,                       -- Extra context: error message, dedup source, file path, etc.
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_events_project ON pipeline_events(project_id);
CREATE INDEX IF NOT EXISTS idx_events_project_time ON pipeline_events(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_type ON pipeline_events(event_type);

INSERT OR REPLACE INTO schema_version (version) VALUES (3);
