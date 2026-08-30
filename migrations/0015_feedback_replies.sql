ALTER TABLE feedback ADD COLUMN admin_reply TEXT;
ALTER TABLE feedback ADD COLUMN admin_reply_at TEXT;

UPDATE system_meta
SET value='4.6.0-feedback-replies', updated_at=CURRENT_TIMESTAMP
WHERE key='schema_version';
