-- Migration 007: Per-project aspect ratio (16:9 vs 9:16)
--
-- Adds an aspect_ratio column to projects so the whole pipeline (scene images,
-- video clips, assembly dims, branding card inclusion, script-prompt framing
-- hints) can be driven by a single project-level setting.
--
-- Locked once Research starts (enforced in db.js setter). 16:9 default preserves
-- existing behavior for projects created before this migration.

ALTER TABLE projects ADD COLUMN aspect_ratio TEXT NOT NULL DEFAULT '16:9';

INSERT OR REPLACE INTO schema_version (version) VALUES (7);
