# ADR-005: Staff Authentication, Session Rotation/Replay Detection, Dual Transport (Cookie+CSRF vs Bearer), and RBAC (`Stage 05`)

- **Status:** `ACCEPTED (Candidate IN_REVIEW — S04FIX-S05FULL-G)`
- **Stage / Steps:** `S05` (`05.01`–`05.05`)
- **Confirmed Owner Decision:** `OWNER-20261104-01` (Director creates all staff roles; Admin creates `TEACHER` only; Teacher creates none)

---

## 1. Context & Security Requirements

EduERP v2.0 restricts web and mobile authentication strictly to Center Staff (`DIRECTOR`, `ADMIN`, `TEACHER`); Parents and Students interact only via Telegram Bot (`R01.03`, `T05.01`). Staff credentials, sessions, and role/object permissions must prevent timing oracle enumeration, brute-force password guessing, refresh token replay, CSRF attacks on browser sessions, stale privilege retention after deactivation/demotion, and unauthorized Teacher access to guardian phone numbers or financial records.

---

## 2. Key Architectural Decisions (`05.01`–`05.05`)

1. **Memory-Hard `crypto.scrypt` Password Hashing & Timing-Oracle Mitigation (`05.01`):**
   - Passwords are hashed asynchronously via Node's native `crypto.scrypt` with `N=131072, r=8, p=1, keylen=64` and a 16-byte CSPRNG salt (`scrypt$v1$N=131072,r=8,p=1$<salt_b64url>$<hash_b64url>`), guarded by a bounded concurrency semaphore (`PASSWORD_HASH_MAX_CONCURRENCY = 4`) and explicit parameter upper/lower bounds validation.
   - When a login targets a non-existent username or a `DEACTIVATED` account, `AuthService.login()` still executes `verifyStaffPassword(password, DUMMY_SCRYPT_HASH)` so unknown-user and wrong-password paths perform identical cryptographic work and return an identical `401 UNAUTHORIZED` `ErrorEnvelope`.
2. **Dual Token Transport: Browser `HttpOnly` Cookie + Session-Bound CSRF vs Mobile Bearer (`05.01`, `AUTH-IT-14`, `AUTH-IT-15`):**
   - **Mobile / API (`X-Auth-Transport: bearer`):** Returns `access_token` (`jose` HS256 JWT with `sub`, `center_id`, `center_slug`, `role`, `session_id`, `jti`, `iss`, `aud`, `iat`, `nbf`, `exp`) and opaque `refresh_token` in JSON; requires `Authorization: Bearer <access_token>`.
   - **Browser Web (`X-Auth-Transport: cookie`):** Sets `eduerp_access_token` (`HttpOnly; SameSite=Strict; Path=/api/v1`), `eduerp_refresh_token` (`HttpOnly; SameSite=Strict; Path=/api/v1/auth`), and `eduerp_csrf_token` (`SameSite=Strict; Path=/`), omits raw tokens from the JSON response body, and enforces both trusted `Origin`/`Referer` validation and constant-time comparison of `X-CSRF-Token` against `staff_sessions.csrf_token_hash` on all state-changing requests (`POST`, `PUT`, `PATCH`, `DELETE`). Supplying an `Authorization: Bearer` header alongside cookies does not bypass CSRF enforcement.
3. **Single-Use Refresh Token Rotation & Session-Family Replay Revocation (`05.01`, `AUTH-IT-05`, `AUTH-IT-06`):**
   - `staff_sessions` stores only `SHA-256` hashes (`refresh_token_hash`, `previous_refresh_token_hash`, `csrf_token_hash`) and `token_family_id`.
   - `POST /api/v1/auth/refresh` locks the session row `FOR UPDATE`. If a caller replays `previous_refresh_token_hash` (or presents a revoked token from that family), `AuthService` immediately revokes all active sessions sharing `(center_id, token_family_id)` with `revoke_reason = 'FAMILY_REPLAY_DETECTED'`, writes a redacted `audit_logs` record (`AUTH_REFRESH_REPLAY_DETECTED`), and returns `401 UNAUTHORIZED`.
4. **Live Database Session & RBAC Guard (`05.02`, `05.03`, `OWNER-20261104-01`):**
   - `PermissionsGuard` verifies both JWT signature/claims and live PostgreSQL state (`staff_sessions.revoked_at IS NULL`, `expires_at > NOW()`, `staff_users.status == 'ACTIVE'`, `staff_users.role == jwt.role`), enforces the first-login `must_change_password` gate (`403 PASSWORD_CHANGE_REQUIRED` on all routes except `/api/v1/auth/password` and `/api/v1/auth/logout`), and blocks write endpoints in `READ_ONLY` license mode (`403 LICENSE_READ_ONLY_MODE`).
   - Per confirmed decision `OWNER-20261104-01`, `POST /api/v1/staff` allows `DIRECTOR` to create `DIRECTOR | ADMIN | TEACHER`, allows `ADMIN` to create `TEACHER` only (`403 FORBIDDEN_ROLE` on `DIRECTOR`/`ADMIN`), and denies `TEACHER` (`403 FORBIDDEN_ROLE`). Unconfirmed Admin staff-management endpoints (`GET /api/v1/staff`, `PATCH /api/v1/staff/:staff_id/status`, `POST /api/v1/staff/:staff_id/sessions/revoke`) remain fail-closed (`403 POLICY_DECISION_NOT_CONFIRMED`).
   - `GET /api/v1/groups/:group_id/roster` enforces Teacher object ownership (`course_groups.primary_teacher_id == staff_id` OR active `substitute_assignments.substitute_teacher_id == staff_id` for today's lesson in center timezone; else `403 FORBIDDEN_OBJECT_SCOPE`) and returns `TeacherStudentView` with zero guardian/student phone or financial fields (`T02.03`, `T05.04`).
