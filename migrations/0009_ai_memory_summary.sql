PRAGMA foreign_keys = ON;

ALTER TABLE ai_user_memory ADD COLUMN summary_content TEXT NOT NULL DEFAULT '';

UPDATE system_meta
SET value = '4.1.1-ai-memory-split', updated_at = CURRENT_TIMESTAMP
WHERE key = 'schema_version';
