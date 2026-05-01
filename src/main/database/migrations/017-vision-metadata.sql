-- Migration 017: Vision verification metadata for crash-resilient resume
--
-- Stores vision verification results (score, verdict, retry count) directly on
-- the asset row so the pipeline can resume without re-running expensive vision
-- API calls. The retry_count column already exists (auto-incremented by
-- markAssetFailed) but vision retries are a separate concept — an image can be
-- generated successfully but FAIL vision check, triggering a vision-specific retry.
--
-- vision_score: 0-100 weighted score from ImageVerifier
-- vision_verdict: 'pass' | 'fail' | NULL (not yet verified)
-- vision_retries: number of vision-specific retry attempts (separate from gen retries)
-- vision_issues: JSON array of issue strings from last verification
-- vision_verified_at: timestamp of last verification attempt

ALTER TABLE project_assets ADD COLUMN vision_score INTEGER;
ALTER TABLE project_assets ADD COLUMN vision_verdict TEXT;
ALTER TABLE project_assets ADD COLUMN vision_retries INTEGER DEFAULT 0;
ALTER TABLE project_assets ADD COLUMN vision_issues TEXT;
ALTER TABLE project_assets ADD COLUMN vision_verified_at TEXT;

INSERT OR REPLACE INTO schema_version (version) VALUES (17);
