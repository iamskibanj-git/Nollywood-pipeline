-- Migration 018: Asset locking — vision certification = permanent lock
-- Once an asset passes vision verification, it is permanently locked.
-- Locked assets are never reset/invalidated by reconciliation or regen flows.
-- video_clip_cinematic is exempt (always eligible for redo at verify stage).

ALTER TABLE project_assets ADD COLUMN locked_at TEXT DEFAULT NULL;
