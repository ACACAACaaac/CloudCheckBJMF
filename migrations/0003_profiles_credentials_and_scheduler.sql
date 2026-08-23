PRAGMA foreign_keys = ON;

CREATE TABLE user_documents (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  document_json TEXT NOT NULL DEFAULT '{}',
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE calendar_documents (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  document_json TEXT NOT NULL DEFAULT '{"version":1,"locations":[],"users":[]}',
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE credential_secrets (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  secret_kind TEXT NOT NULL CHECK (secret_kind IN ('bjmf_cookie', 'pushplus_token')),
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  key_version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (account_id, secret_kind)
);

CREATE TABLE login_attempts (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  browser_session_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'complete', 'expired', 'failed', 'cancelled')),
  error_category TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_polled_at TEXT,
  expires_at TEXT NOT NULL
);

CREATE INDEX login_attempts_account_status_idx
  ON login_attempts(account_id, status, created_at DESC);

CREATE TABLE readonly_observations (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  class_id TEXT NOT NULL,
  outcome TEXT NOT NULL
    CHECK (outcome IN ('no_task', 'task_found', 'cookie_invalid', 'upstream_error')),
  task_count INTEGER NOT NULL DEFAULT 0,
  task_ids_json TEXT NOT NULL DEFAULT '[]',
  http_status INTEGER,
  checked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX readonly_observations_account_time_idx
  ON readonly_observations(account_id, checked_at DESC);

CREATE TABLE scheduler_state (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  next_read_at TEXT,
  last_read_at TEXT,
  last_outcome TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO system_meta (key, value, updated_at)
VALUES ('attendance_writes_enabled', 'false', CURRENT_TIMESTAMP);

INSERT INTO system_meta (key, value, updated_at)
VALUES ('credential_key_version', '1', CURRENT_TIMESTAMP);

UPDATE system_meta
SET value = '3.0.0-rc-readonly', updated_at = CURRENT_TIMESTAMP
WHERE key = 'schema_version';
