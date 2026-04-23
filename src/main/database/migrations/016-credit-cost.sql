-- Migration 016: Track credit cost per asset generation
--
-- The GENERATE button displays the credit cost (e.g. "Generate19.25" for Kling,
-- "GENERATE ✦ 2" for Cinema Studio images). We parse this and store it per asset
-- so we can sum total credits spent per project.
--
-- credit_cost is REAL (float) — e.g. 19.25 for a Kling clip, 2.0 for a scene image.
-- NULL means cost was not captured (legacy assets or failed parse).

ALTER TABLE project_assets ADD COLUMN credit_cost REAL;

INSERT OR REPLACE INTO schema_version (version) VALUES (16);
