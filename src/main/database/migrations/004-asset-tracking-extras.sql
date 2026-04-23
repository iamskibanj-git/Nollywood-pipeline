-- Migration 004: Add CDN URL and references tracking to project_assets
-- CDN URL allows re-downloading if local file corrupted
-- references_used stores JSON array of portrait paths used for each scene gen
-- NOTE: Each ALTER is a separate statement — requires db.exec() (not db.run()) to run all three

ALTER TABLE project_assets ADD COLUMN cdn_url TEXT;
ALTER TABLE project_assets ADD COLUMN references_used TEXT;
ALTER TABLE project_assets ADD COLUMN generation_duration_ms INTEGER;

INSERT OR REPLACE INTO schema_version (version) VALUES (4);
