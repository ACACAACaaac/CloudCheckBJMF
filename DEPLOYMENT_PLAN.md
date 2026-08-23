# Deployment Plan

## Stage 1: Public shell

- Public responsive website.
- Read-only health and capability APIs.
- Security headers and strict content security policy.
- No registration, credentials, coordinates, scheduling, or attendance requests.

## Stage 2: Accounts and tenant isolation

- Cloudflare Access email verification for the invite-only beta.
- Signed Access JWT validation inside the Worker; request headers alone are never trusted.
- D1 account, session, ownership, and audit tables.
- Invite-only beta switch and administrative suspension controls.

## Stage 3: Credential acquisition

- Browser Run proof of concept for the exact k8n.cn student login URL.
- Chrome extension fallback with narrowly scoped cookie permission.
- Per-profile envelope encryption and key rotation.
- No browser session recording and no credential logging.

## Stage 4: Read-only scheduling trial

- Per-profile Durable Object and alarms.
- HTTPS-only student and course reads.
- Circuit breaker for 429, 522, unexpected HTML, and cookie expiration.
- Three-to-seven-day read-only stability observation.

## Stage 5: Authorized attendance trial

- Explicit opt-in and authorization confirmation.
- Idempotent execution records and strict retry limits.
- Small invite-only cohort before any public enablement.
- PushPlus notifications with redacted content.

## Stage 6: Public availability

- Account deletion and data export.
- Privacy policy, terms, acceptable use policy, and incident response.
- Usage dashboards and hard free-tier budgets.
- Paid plan evaluation before raising active-user limits.
