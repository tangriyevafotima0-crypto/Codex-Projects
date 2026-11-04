# ADR-005: Staff Authentication, Session Rotation/Replay Detection, Dual Transport (Cookie+CSRF vs Bearer), and RBAC (`Stage 05` + `G01`–`G07`)

- **Status:** `ACCEPTED (Candidate IN_REVIEW — S04S05FIX-S06FULL-H)`
- **Stage / Steps:** `S05` (`05.01`–`05.05`, remediated for `G01`–`G07`)
- **Confirmed Owner Decision:** `OWNER-20261104-01` (Director creates all staff roles; Admin creates `TEACHER` only; Teacher creates none)

---

## 1. Key Architectural Decisions (`05.01`–`05.05` & `G01`–`G07`)

1. **No Generic Replay Caching of Authentication Credentials (`G01`):**
   - `POST /api/v1/auth/login` and `POST /api/v1/auth/refresh` NEVER store or replay responses from `client_operation_logs`. Every login call verifies live credentials (`verifyPasswordConstantTime`) and live `staff_users` status.
   - `executeIdempotentOperation` explicitly forbids `LOGIN_STAFF` / `REFRESH_STAFF_SESSION` and scans response payloads to reject any payload containing `"access_token"`, `"refresh_token"`, `"csrf_token"`, or `"$scrypt$"`.
2. **Single-Transaction Failure Commit & Shared PostgreSQL IP Rate Limiter (`G02`):**
   - Failed login attempts update `failed_login_count`, `last_failed_login_at`, `locked_until`, and `STAFF_LOGIN_LOCKED` `audit_logs` inside the single login transaction and **COMMIT** before throwing HTTP `401`/`429` (eliminating the outer `FOR UPDATE` vs autonomous connection self-deadlock).
   - Network rate limiting is persisted in PostgreSQL (`auth_rate_limit_buckets`, keyed by `HMAC-SHA256(internalBotHmacSecret, centerId + ':' + clientIp)`) so unique-username floods from one IP are blocked across multiple API instances and process restarts without storing raw IP addresses.
3. **Production Scrypt Dummy Cost Parity & Configurable Bounded Queue (`G06`):**
   - `apps/api/src/auth/password.ts` has zero imports from test/seed modules and defines `DUMMY_SCRYPT_HASH` at the exact production cost (`N=131072, r=8, p=1`).
   - `configurePasswordHasher` binds `PASSWORD_HASH_MAX_CONCURRENCY` and `PASSWORD_HASH_MAX_QUEUE` from `ApiEnvConfig` and returns `429 RATE_LIMITED` (`ApiHttpException`) when saturated.
4. **Absolute Session Family Expiry, Keyed Idempotency Fingerprints & Time-Scoped Substitute Roster (`G04`, `G05`, `G07`):**
   - `staff_sessions.family_expires_at` records the original session family deadline; refresh rotation clamps `expires_at <= family_expires_at` so rotation never extends a session family indefinitely (`G05`).
   - Non-auth idempotency (`createStaffUser`, `changeStaffPassword`) hashes sensitive fields via `computeKeyedFieldDigest` (`HMAC-SHA256` with server secret) so changing `phone_e164` or `initial_password` returns `409 IDEMPOTENCY_PAYLOAD_MISMATCH` without storing raw secrets (`G05`).
   - Teacher substitute roster access (`GET /api/v1/groups/:group_id/roster`) enforces `lesson_occurrences.lesson_date == today_in_center_timezone` via `formatCenterLocalDate(clock.now(), effectiveTimezone)`, denying past and future substitute assignments (`G04`).
   - `PermissionsGuard` is registered globally as `APP_GUARD` (default-deny), with explicit `@PublicBootstrap()` on the 4 public endpoints and `@RequireRoutePolicy(...)` on all 18 protected endpoints (`G07`).
