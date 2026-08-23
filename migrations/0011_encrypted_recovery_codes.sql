PRAGMA foreign_keys = ON;

ALTER TABLE recovery_codes ADD COLUMN ciphertext TEXT;
ALTER TABLE recovery_codes ADD COLUMN iv TEXT;
ALTER TABLE recovery_codes ADD COLUMN key_version INTEGER NOT NULL DEFAULT 1;

UPDATE system_meta
SET value = '4.2.1-encrypted-recovery-codes', updated_at = CURRENT_TIMESTAMP
WHERE key = 'schema_version';
