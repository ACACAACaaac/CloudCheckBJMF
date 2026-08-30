ALTER TABLE accounts ADD COLUMN ai_diagnostic_opt_in INTEGER NOT NULL DEFAULT 0;

UPDATE system_meta
SET value='4.7.0-ai-memory-controls', updated_at=CURRENT_TIMESTAMP
WHERE key='schema_version';
