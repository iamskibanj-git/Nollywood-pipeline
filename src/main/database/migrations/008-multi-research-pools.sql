-- Migration 008: Multiple coexisting research pools
--
-- Before this migration, the pipeline kept ONE active research_cache row at a time.
-- Saving new research flipped the old row's is_active=0, so users lost access to
-- prior pools even though the data was still in the DB.
--
-- This migration enables multiple pools to coexist (capped at 5 on save — oldest
-- auto-pruned). Projects now track which pool they were created from via
-- projects.research_cache_id, which enables:
--   - Per-pool "X of Y unused" counts (a pool isn't polluted by used_videos from
--     projects that came from a DIFFERENT pool)
--   - Per-pool "stories produced" lists
-- is_active is retained for back-compat but the save path no longer flips it.

ALTER TABLE projects ADD COLUMN research_cache_id INTEGER REFERENCES research_cache(id);

CREATE INDEX IF NOT EXISTS idx_projects_research_cache ON projects(research_cache_id);
CREATE INDEX IF NOT EXISTS idx_research_cache_expires ON research_cache(expires_at);

INSERT OR REPLACE INTO schema_version (version) VALUES (8);
