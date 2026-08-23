PRAGMA foreign_keys = ON;

UPDATE accounts
SET display_name = (
  SELECT login_name FROM auth_credentials
  WHERE auth_credentials.account_id = accounts.id
)
WHERE EXISTS (
  SELECT 1 FROM auth_credentials
  WHERE auth_credentials.account_id = accounts.id
);

UPDATE system_meta
SET value = '3.3.0-simplified-accounts', updated_at = CURRENT_TIMESTAMP
WHERE key = 'schema_version';
