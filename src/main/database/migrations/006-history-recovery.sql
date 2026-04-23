-- Migration 006: Higgsfield asset history recovery
-- When inline auto-recovery (or the CLI tool) successfully fishes a clip from
-- Higgsfield's Assets page after a local generation/download failure, we record
-- the source asset's UUID for cross-run dedup + audit + future cleanup tools.

ALTER TABLE project_assets ADD COLUMN higgsfield_asset_id TEXT;       -- UUID from /asset/all/<uuid>
ALTER TABLE project_assets ADD COLUMN recovered_from_history INTEGER DEFAULT 0;  -- bool: 1 if asset was recovered (not freshly generated)

INSERT OR REPLACE INTO schema_version (version) VALUES (6);
