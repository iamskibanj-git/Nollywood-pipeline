-- 014-project-logs.sql
-- Persistent per-project activity logs.
-- Every this.log() call in the orchestrator is stored here for post-run review,
-- debugging, and the in-app log viewer. Also written to disk as .log files.

CREATE TABLE IF NOT EXISTS project_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'info',    -- info, warn, error
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_project_logs_project ON project_logs(project_id);
CREATE INDEX IF NOT EXISTS idx_project_logs_project_time ON project_logs(project_id, created_at DESC);

INSERT OR REPLACE INTO schema_version (version) VALUES (14);
