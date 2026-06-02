-- Standalone character spotlight promo posts.
-- Kept separate from Engagement Type 1B rows so Shorts/Reel scheduling cannot regress.

CREATE UNIQUE INDEX IF NOT EXISTS idx_social_unique_standalone_spotlight
ON social_posts(project_id, source_character_id, post_type)
WHERE post_type = 'standalone_character_spotlight';

INSERT OR REPLACE INTO schema_version (version) VALUES (23);
