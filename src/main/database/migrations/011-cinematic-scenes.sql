-- Migration 011: Asset types for cinematic Phase 3 (locations + scene images)
--
-- project_assets.type is an untyped string column — no constraint change
-- needed. This migration is documentation-only + indexes to keep cinematic
-- queries fast as the asset table grows.
--
-- New asset types introduced in Phase 3:
--   - location_image            : empty location generated via Nano Banana (no characters)
--   - scene_image_cinematic     : blocked scene image via Cinema Studio 2.0 (location + chars + blocking)
--
-- Existing asset types (staged mode — unchanged):
--   - portrait                  : character portrait (Nano Banana)
--   - character_grid            : 4-column ref sheet (Phase 2)
--   - scene_image               : wide-group scene image (staged Veo pipeline)
--   - video_clip                : 8s Veo 3.1 Lite clip
--   - final_video               : concatenated + upscaled output
--
-- Phase 4 will add video_clip_cinematic (10-12s Kling 3.0 clip with multi-shot).
--
-- See IMPROVEMENT-CINEMATIC-WORKFLOW.md for the full architecture.

-- Index to speed up "give me all scene images for project X" queries which
-- now need to filter by type to distinguish staged scene_image vs cinematic
-- scene_image_cinematic.
CREATE INDEX IF NOT EXISTS idx_assets_project_type_chapter ON project_assets(project_id, type, chapter);

-- Index to speed up location-lookup queries: "is there already a location_image
-- for location hint X in project Y?"
CREATE INDEX IF NOT EXISTS idx_assets_project_element_name ON project_assets(project_id, element_name);

INSERT OR REPLACE INTO schema_version (version) VALUES (11);
