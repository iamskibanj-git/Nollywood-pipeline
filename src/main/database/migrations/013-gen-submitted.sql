-- Migration 013: Track when Generate was clicked (credits burned)
--
-- When Kling's Generate button is clicked, credits are burned regardless of
-- whether the app stays open long enough to download the result. On restart,
-- the app must know that generation was already submitted so it can go
-- straight to Asset library recovery instead of re-generating (burning
-- credits again).
--
-- gen_clicked_at stores the ISO timestamp of when Generate was clicked.
-- This column survives the resetStuckAssets() call on startup (which only
-- resets status from 'generating' → 'pending', not this timestamp).

ALTER TABLE project_assets ADD COLUMN gen_clicked_at TEXT;

INSERT OR REPLACE INTO schema_version (version) VALUES (13);
