PRAGMA foreign_keys = ON;

CREATE TABLE calendar_rule_documents (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  rules_text TEXT NOT NULL DEFAULT 'RULES_V1',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE ai_turns (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_message_id TEXT NOT NULL REFERENCES ai_messages(id) ON DELETE CASCADE,
  assistant_message_id TEXT REFERENCES ai_messages(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running','waiting_confirmation','complete','failed','stopped')),
  phase TEXT NOT NULL DEFAULT '准备请求',
  error_text TEXT NOT NULL DEFAULT '',
  raw_protocol TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX ai_turns_account_time_idx ON ai_turns(account_id, created_at DESC);

UPDATE accounts
SET status='suspended', status_reason='ai_reputation', updated_at=CURRENT_TIMESTAMP
WHERE role<>'admin' AND ai_reputation<0;

DELETE FROM sessions
WHERE account_id IN (SELECT id FROM accounts WHERE role<>'admin' AND ai_reputation<0);

UPDATE system_meta
SET value='4.3.0-ai-rules-turns', updated_at=CURRENT_TIMESTAMP
WHERE key='schema_version';
