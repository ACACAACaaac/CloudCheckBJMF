# Security Model

Cookie values, PushPlus tokens, precise coordinates, student identifiers, and attendance history are sensitive data.

## Required boundaries

- The public web worker must never receive a plaintext credential from storage.
- Only a dedicated executor may decrypt a credential, and only for one bounded operation.
- Each account owns all child records; every query must include and verify `account_id`.
- Credentials use per-profile AES-GCM data keys with a versioned master key in Worker Secrets.
- Logs contain event identifiers and error categories, never cookies, tokens, response bodies, or precise coordinates.
- Browser sessions and recordings must be closed and discarded after credential acquisition.
- All k8n.cn traffic must use HTTPS.
- Repeated upstream failures trigger a global circuit breaker rather than retries from every account.
- Registration, login, credential changes, and account deletion require anti-automation and recent-authentication checks.

## Public launch gates

- Tenant-isolation tests pass.
- Credential redaction tests pass.
- Key rotation and account deletion are tested from backup to completion.
- Read-only upstream stability is acceptable for at least seven days.
- Terms, privacy notice, authorization statement, and incident contact are published.
