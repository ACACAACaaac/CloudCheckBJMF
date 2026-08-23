PRAGMA foreign_keys = ON;

CREATE TABLE feedback (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK (category IN ('bug','suggestion','question','other')),
  subject TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX feedback_created_at_idx ON feedback(created_at DESC);

UPDATE system_meta
SET value='4.5.0-feedback', updated_at=CURRENT_TIMESTAMP
WHERE key='schema_version';
