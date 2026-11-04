# ADR-006: Auth/Deploy Remediation (`G01`–`G07`) and Stage 06 Student, Guardian, Phone Revocation, Enrollment & Duplicate Warning Architecture

- **Status:** `ACCEPTED (Candidate IN_REVIEW — S04S05FIX-S06FULL-H)`
- **Stage / Steps:** `S04/S05` Remediation (`G01`–`G07`) + `S06` (`06.01`–`06.05`)
- **Related Requirements:** `R03.01`–`R03.05`, `R05.01`–`R05.05`, `R06.01`–`R06.05`, `R09.04`, `R14.01`, `R14.02`, `R18.01`

---

## 1. Context & Problem Statement

Following the `S04-S05-G` manager review, seven auth/deployment issues (`G01`–`G07`) required closure before expanding the Center Data Plane API with Stage 06 (`06.01`–`06.05`): Student onboarding/search/archive, Guardian multi-child/multi-guardian relationships and E.164 phone normalization with atomic Telegram bot link revocation (`D18`), Enrollment lifecycle (`TRIAL`, `ACTIVE`, `FROZEN`, `LEFT`) with group transfers and debt-preserving withdrawal (`BR-08`), and sibling-safe duplicate student warnings.

---

## 2. Architectural Decisions

1. **Additive Migration `20261104000300_s06_auth_fixes_and_student_foundation` & Non-Domain Technical Helper Table (`G02`, `G05`, `06.03`):**
   - Preserves the `46` canonical domain entities in `schema.prisma` and `20261104000100_initial_foundation`.
   - Adds `family_expires_at TIMESTAMPTZ` to `staff_sessions` (`G05`) and `transferred_from_enrollment_id UUID` (with composite lineage FK `(id, center_id, student_id)`) to `enrollments` (`06.03`).
   - Adds `"auth_rate_limit_buckets"` as an explicit non-domain technical helper table (granted `SELECT, INSERT, UPDATE, DELETE` only to `eduerp_api_runtime`) so IP/center login rate limiting is shared across multiple API processes and survives restarts without storing raw IP addresses (`G02`).
2. **Dedicated Multi-Stage Docker `migrator` Target & Canonical Config Parity (`G03`):**
   - `apps/api/Dockerfile` defines `AS migrator` (containing Prisma 7 CLI, `prisma.config.ts`, `schema.prisma`, and `migrations/`) and `AS runner` (pruned minimal production API image without Prisma CLI or migration files).
   - `API_CANONICAL_ENV_KEYS` in `apps/api/src/config/env.ts`, `.env.example`, and `infra/compose.dev.yml` are enforced 1-for-1 by `apps/api/test/config.test.ts`, and `loadApiEnv()` rejects legacy/mismatched alias names fail-fast.
3. **Unicode NFKC / Uzbek Apostrophe Name Normalization & Explicit E.164 (`+998`) Phone Normalization (`06.01`, `06.02`, `06.04`):**
   - `normalizePersonName` preserves the display `full_name` while normalizing all Uzbek apostrophe variants (`'`, `‘`, `’`, `` ` ``, `ʻ`, `ʼ`, `´`) to ASCII `'` in lowercase `normalized_name`. Name is never treated as unique (`T06.01`).
   - `normalizePhoneE164` normalizes `+998XXXXXXXXX` and 12-digit `998XXXXXXXXX` to canonical `+998XXXXXXXXX`, accepts valid international `+[1-9][0-9]{7,14}`, and rejects ambiguous local numbers without country prefix (`400 VALIDATION_ERROR`).
4. **Atomic Guardian Phone Update & Telegram Link Revocation (`06.02`, `D18`):**
   - `PATCH /api/v1/guardians/:guardian_id/phone` atomically updates `guardians.phone_e164` (`expected_version`), transitions all non-revoked `guardian_telegram_links` to `UNLINKED_REVOKED` (`revoke_reason = 'GUARDIAN_PHONE_CHANGED'`), queues canonical `GuardianLinkRevoked` (`v1`) events in `outbox_events` with **zero raw phone numbers** in `payload_json`, creates a new `INVITED` link row, and records a redacted `audit_logs` entry.
   - `POST /api/v1/students/:student_id/guardians/:guardian_id/unlink` soft-unlinks one child (`active = FALSE, unlinked_at = NOW()`) while keeping the guardian's active links to other siblings and the student's financial history intact.
5. **Enrollment Lifecycle, Atomic Group Transfer, Debt-Preserving Withdrawal & Policy Gates (`06.03`):**
   - Enforces partial unique active enrollment per `(student_id, group_id)` while allowing `LEFT -> new enrollment` re-enrollment (`T06.03`).
   - `POST /api/v1/enrollments/:enrollment_id/transfer` atomically closes the source enrollment (`status = 'LEFT', churn_reason_code = 3`) and creates a linked target enrollment (`transferred_from_enrollment_id = source.id`) while keeping all historical `invoices` and `ledger_entries` bound to the source enrollment.
   - `POST /api/v1/enrollments/:enrollment_id/withdraw` requires `churn_reason_code` in `1..5` and snapshots lossless `BigInt` remaining debt (`preserved_debt_snapshot_uzs`) without forgiving debt. Any request to auto-issue pro-rata invoices or apply retroactive fee/debt adjustments before Stage 08 / `D01`–`D04`/`D21`/`D22` confirmation fails closed with `403 POLICY_DECISION_NOT_CONFIRMED`.

## Manager correction after live H review
PostgreSQL DATE values are read as calendar strings at the API pool boundary (OID1082), independent of host TZ. S06 phone changes revoke old identities and return relink_required=true with single_use_invite_deeplink=null. Real single-use invite issuance/verification belongs to S14; no fake bot username or unmatched bearer-token hash is presented as functional. This supersedes the executor draft's INVITED URL claim.
