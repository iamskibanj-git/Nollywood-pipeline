-- Migration 012: Asset tracking for cinematic Phase 4 (Kling 3.0 video clips)
--
-- Cinematic video generation produces ONE asset row per kling_clips entry in
-- the script (NOT one per dialogue line as the staged Veo pipeline does).
-- Asset type: 'video_clip_cinematic'.
--
-- We need a stable way to look up a clip by its script-authored clip_id
-- (e.g. "ch3_sc3_c1") so the resume path can skip already-generated clips
-- without re-doing them.
--
-- See IMPROVEMENT-CINEMATIC-WORKFLOW.md for the full architecture.

-- Stores the script-authored clip_id (e.g. "ch3_sc3_c1") on the asset row.
-- Null for non-kling assets. Indexed for fast resume lookups.
ALTER TABLE project_assets ADD COLUMN kling_clip_id TEXT;

-- Stores the count of dialogue line_refs covered by this clip (for verify
-- adaptation in Phase 5 — grader needs to know which lines this clip should
-- contain audio for).
ALTER TABLE project_assets ADD COLUMN line_refs TEXT;  -- JSON array, e.g. "[1,2,3]"

CREATE INDEX IF NOT EXISTS idx_assets_kling_clip_id ON project_assets(project_id, kling_clip_id);

INSERT OR REPLACE INTO schema_version (version) VALUES (12);
