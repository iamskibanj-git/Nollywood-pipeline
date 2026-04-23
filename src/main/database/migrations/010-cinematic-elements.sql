-- Migration 010: Asset types for the cinematic workflow (Phase 2)
--
-- Adds tracking for character grids (4-angle reference sheets generated from
-- portraits) and Higgsfield character elements (the @name references Kling 3.0
-- uses for visual + voice identity lock).
--
-- project_assets.type already accepts arbitrary strings (no CHECK constraint),
-- so this migration is primarily documentation + a new column to record the
-- Higgsfield element ID when it's been created.
--
-- See IMPROVEMENT-CINEMATIC-WORKFLOW.md for the full architecture.

-- Stores the Higgsfield element ID for character/location/prop elements.
-- Null for non-element asset types (portraits, scene_image, video_clip, etc.).
-- The element name (e.g. @claire_thp) is stored in file_path placeholder or
-- settings — this column is the canonical linkage when it exists.
ALTER TABLE project_assets ADD COLUMN higgsfield_element_id TEXT;

-- Stores the element name convention used: e.g. "@claire_thp" for
-- "Claire, The Heir's Probation". Makes cross-project queries clean.
ALTER TABLE project_assets ADD COLUMN element_name TEXT;

-- Useful indexes for Phase 3+ queries (which element does this character_grid
-- belong to? which scenes share a location element?)
CREATE INDEX IF NOT EXISTS idx_assets_element_name ON project_assets(element_name);
CREATE INDEX IF NOT EXISTS idx_assets_type_project ON project_assets(type, project_id);

INSERT OR REPLACE INTO schema_version (version) VALUES (10);
