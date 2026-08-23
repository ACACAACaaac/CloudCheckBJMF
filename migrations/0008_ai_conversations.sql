PRAGMA foreign_keys = ON;

CREATE TABLE ai_messages (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX ai_messages_account_time_idx
  ON ai_messages(account_id, created_at DESC);

CREATE TABLE ai_user_memory (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  content TEXT NOT NULL DEFAULT '# 用户记忆\n',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

UPDATE system_meta
SET value = '4.1.0-ai-chat', updated_at = CURRENT_TIMESTAMP
WHERE key = 'schema_version';
