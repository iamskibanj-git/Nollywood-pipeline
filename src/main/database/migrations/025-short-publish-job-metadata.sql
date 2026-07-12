-- Metadata and validation details for multi-platform short publish jobs.
-- Safe to run after 024; duplicate-column skips are handled by the migration runner.

ALTER TABLE short_publish_jobs ADD COLUMN metadata_json TEXT;
ALTER TABLE short_publish_jobs ADD COLUMN validation_json TEXT;

INSERT OR REPLACE INTO schema_version (version) VALUES (25);
