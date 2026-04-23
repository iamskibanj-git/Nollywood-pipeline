-- 015-publish-stage.sql
-- Publish stage: thumbnail generation + SEO metadata for YouTube/Facebook.
-- Stores per-project thumbnail selection, platform metadata, and publish status.

ALTER TABLE projects ADD COLUMN thumbnail_path TEXT;
ALTER TABLE projects ADD COLUMN thumbnail_key_art_path TEXT;
ALTER TABLE projects ADD COLUMN thumbnail_title_card_path TEXT;
ALTER TABLE projects ADD COLUMN thumbnail_scene_id INTEGER;
ALTER TABLE projects ADD COLUMN youtube_metadata TEXT;
ALTER TABLE projects ADD COLUMN facebook_metadata TEXT;
ALTER TABLE projects ADD COLUMN published_at TEXT;

INSERT OR REPLACE INTO schema_version (version) VALUES (15);
