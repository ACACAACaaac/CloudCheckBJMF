PRAGMA foreign_keys = ON;

CREATE TABLE access_identities (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  email TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (issuer, subject)
);

CREATE INDEX access_identities_account_id_idx
  ON access_identities(account_id);

CREATE INDEX access_identities_email_idx
  ON access_identities(email);

UPDATE system_meta
SET value = '2.1.0', updated_at = CURRENT_TIMESTAMP
WHERE key = 'schema_version';
