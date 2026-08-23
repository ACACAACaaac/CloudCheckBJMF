PRAGMA foreign_keys = ON;

ALTER TABLE login_attempts ADD COLUMN transport TEXT NOT NULL DEFAULT 'browser';
ALTER TABLE login_attempts ADD COLUMN session_ciphertext TEXT;
ALTER TABLE login_attempts ADD COLUMN session_iv TEXT;

UPDATE system_meta
SET value = '3.2.0-direct-qr-login', updated_at = CURRENT_TIMESTAMP
WHERE key = 'schema_version';
