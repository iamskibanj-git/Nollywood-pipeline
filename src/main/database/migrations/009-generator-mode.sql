-- Migration 009: Per-project generator mode (staged vs cinematic)
--
-- Adds a generator_mode column to projects. Staged is the proven default
-- (Veo 3.1 Lite, one clip per dialogue line, wide-group framing enforced by
-- script-prompt's Conversation Lock rule). Cinematic is an opt-in parallel
-- pipeline (Cinema Studio 2.0 scene images + Kling 3.0 multi-shot video with
-- native lip-synced audio) for prestige long-form output.
--
-- Locked once Research starts (same lock semantics as aspect_ratio, enforced
-- in db.js setter). 'staged' default preserves existing behavior for projects
-- created before this migration.
--
-- See IMPROVEMENT-CINEMATIC-WORKFLOW.md for the full architecture and the
-- 6-phase implementation plan. This migration is Phase 1.

ALTER TABLE projects ADD COLUMN generator_mode TEXT NOT NULL DEFAULT 'staged';

-- Unfortunately SQLite's ALTER TABLE doesn't support adding a CHECK constraint
-- to an existing table post-creation. Validation is enforced in db.js
-- (setProjectGeneratorMode throws on invalid values).

INSERT OR REPLACE INTO schema_version (version) VALUES (9);
