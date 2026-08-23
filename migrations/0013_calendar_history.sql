PRAGMA foreign_keys = ON;

CREATE TABLE calendar_document_history (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  document_json TEXT NOT NULL,
  revision INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX calendar_document_history_account_revision_idx
  ON calendar_document_history(account_id, revision DESC);

UPDATE system_meta
SET value='4.4.0-calendar-operations', updated_at=CURRENT_TIMESTAMP
WHERE key='schema_version';
