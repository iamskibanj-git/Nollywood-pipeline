-- 002-asset-gen-metadata.sql
-- Track Higgsfield generation metadata for traceability.
-- model_used: which model generated the asset (e.g., "Nano Banana Pro", "Veo 3.1 Lite")
-- source_gen_id: Higgsfield's internal generation/asset ID for re-download or reference

ALTER TABLE project_assets ADD COLUMN model_used TEXT;
ALTER TABLE project_assets ADD COLUMN source_gen_id TEXT;

INSERT OR REPLACE INTO schema_version (version) VALUES (2);
