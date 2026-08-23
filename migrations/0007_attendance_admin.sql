PRAGMA foreign_keys = ON;

ALTER TABLE accounts ADD COLUMN role TEXT NOT NULL DEFAULT 'user'
  CHECK (role IN ('user', 'admin'));

-- Bootstrap the project owner's existing account without exposing an admin signup path.
UPDATE accounts SET role = 'admin'
WHERE id = (SELECT account_id FROM auth_credentials WHERE login_name = 'david');

CREATE TABLE attendance_logs (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  class_id TEXT NOT NULL,
  task_id TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'failure', 'no_task')),
  result_text TEXT NOT NULL,
  location_group TEXT,
  latitude REAL,
  longitude REAL,
  accuracy INTEGER,
  source TEXT NOT NULL DEFAULT 'manual',
  http_status INTEGER,
  attempted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX attendance_logs_account_outcome_time_idx
  ON attendance_logs(account_id, outcome, attempted_at DESC);

CREATE UNIQUE INDEX attendance_logs_success_task_idx
  ON attendance_logs(account_id, class_id, task_id)
  WHERE outcome = 'success' AND task_id IS NOT NULL;

UPDATE system_meta
SET value = '4.0.0-attendance-admin', updated_at = CURRENT_TIMESTAMP
WHERE key = 'schema_version';
