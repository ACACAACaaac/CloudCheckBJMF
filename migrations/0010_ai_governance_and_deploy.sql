PRAGMA foreign_keys = ON;

ALTER TABLE accounts ADD COLUMN ai_reputation REAL NOT NULL DEFAULT 100;
ALTER TABLE accounts ADD COLUMN ai_reputation_baseline REAL NOT NULL DEFAULT 100;
ALTER TABLE accounts ADD COLUMN ai_score_reset_at TEXT;
ALTER TABLE accounts ADD COLUMN status_reason TEXT NOT NULL DEFAULT '';

ALTER TABLE ai_messages ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE ai_user_memory ADD COLUMN context_json TEXT NOT NULL DEFAULT '{"college":"","locations":{},"courses":{}}';
ALTER TABLE audit_events ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}';

CREATE TABLE ai_usage_events (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  input_chars INTEGER NOT NULL DEFAULT 0,
  output_chars INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_neurons REAL NOT NULL DEFAULT 0,
  score INTEGER,
  score_reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX ai_usage_account_time_idx
  ON ai_usage_events(account_id, created_at DESC);

CREATE TABLE ai_pending_calendars (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  proposal_id TEXT NOT NULL UNIQUE,
  document_json TEXT NOT NULL,
  summary_json TEXT NOT NULL DEFAULT '[]',
  base_revision INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

UPDATE system_meta
SET value = '4.2.0-ai-governance-deploy', updated_at = CURRENT_TIMESTAMP
WHERE key = 'schema_version';
