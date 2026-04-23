-- Migration 005: Per-clip verification metadata (post-MVP Verify Clip stage)
-- Stores Gemini/Whisper verification results so the UI can show them
-- and so human decisions (accept despite low score, reject and redo) persist.

ALTER TABLE project_assets ADD COLUMN verify_tier TEXT;               -- 'accept' | 'review' | 'reject' | null (not yet verified)
ALTER TABLE project_assets ADD COLUMN verify_similarity INTEGER;      -- 0-100 transcript match score
ALTER TABLE project_assets ADD COLUMN verify_transcript TEXT;         -- what was actually spoken
ALTER TABLE project_assets ADD COLUMN verify_mouth_sync TEXT;         -- 'matches' | 'off' | 'partial' | 'silent' | 'unknown'
ALTER TABLE project_assets ADD COLUMN verify_character_count INTEGER; -- visible people count (Gemini backend)
ALTER TABLE project_assets ADD COLUMN verify_artifacts TEXT;          -- JSON array of flags
ALTER TABLE project_assets ADD COLUMN verify_notes TEXT;              -- freeform Gemini observations
ALTER TABLE project_assets ADD COLUMN verify_human_decision TEXT;     -- 'accepted' | 'rejected' | null (override)
ALTER TABLE project_assets ADD COLUMN verified_at TEXT;               -- ISO timestamp

INSERT OR REPLACE INTO schema_version (version) VALUES (5);
