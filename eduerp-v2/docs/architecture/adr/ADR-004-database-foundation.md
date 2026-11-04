# ADR-004: PostgreSQL 16 & Prisma 7.10.1 Database Foundation, Least-Privilege Role Separation, and Append-Only Immutability

- **Status:** ACCEPTED (Stage 04 — `S04FULL-F`)
- **Date:** 2026-11-04
- **Base Commit:** `a3fdc23a6e6fe1f76b28381e80b844699425d8d8` (Code baseline `bdc229c2e7bacb18714183c3c1d54d7cfbbb886b`)
- **Owner Stage:** Stage 04 (`04.01`–`04.05` / `T04.01`–`T04.05`)
- **Related Decisions & Findings:** `D01` (Per-Center DB Isolation), `D02` (Append-Only Financial Ledger), `C03` / `S2F07` (Integer UZS `BIGINT` Money), `S2F03` (Mutable Request vs Immutable Execution Separation), `S2F04` (Outbox Lease Fencing & Consumer Receipt Dedup), `B14` (Restore Outbound Safety)

---

## 1. Context

EduERP v2.0 requires a production-grade relational database foundation for its per-center data plane (`PostgreSQL 16`) that enforces:
1. Complete 1-to-1 structural fidelity with the 46 canonical entities defined in `docs/architecture/data-model.md` (`25` Mutable entities and `21` Strictly Immutable Append-Only entities).
2. Zero floating-point or IEEE-754 `Number` precision loss for UZS monetary amounts (`scale = 0`, `1 integer = 1 UZS so'm`, stored as signed 64-bit PostgreSQL `BIGINT` and handled in TypeScript as `bigint` / canonical base-10 string).
3. Defense-in-depth enforcement of append-only financial/audit history, closed-period immutability (`CashShift`, `PayrollSnapshot`), and last active Director protection (`StaffUser`).
4. Least-privilege database role separation so the NestJS API and Worker runtime containers never connect as a PostgreSQL superuser or DDL-capable schema owner, and Center A credentials cannot connect to Center B's database.
5. Deterministic transaction retry (`40001` / `40P01` / `P2034`), optimistic concurrency control (`version`), and advisory-locked idempotency (`client_operation_logs`).

---

## 2. Decisions

### 2.1 Prisma 7.10.1 + `@prisma/adapter-pg` + `pg 8.23.1` on Node 24.18.1
- **Generator & Config:** We adopt Prisma `7.10.1` (`provider = "prisma-client"`, `output = "../src/generated/prisma"`, `moduleFormat = "cjs"`) paired with `apps/api/prisma.config.ts` (`defineConfig` reading `MIGRATION_DATABASE_URL ?? DATABASE_URL`).
- **Generated Code Policy:** Generated Prisma client artifacts under `apps/api/src/generated/` are excluded from Git (`.gitignore`) and Docker build context (`.dockerignore`) and are generated via `npm run prisma:generate` in CI and `apps/api/Dockerfile`.
- **Canonical Migration Path Mapping:** Prisma Migrate requires timestamped directory names under `apps/api/prisma/migrations/<timestamp>_<name>/migration.sql`. The planning prompt path `apps/api/prisma/migrations/initial/migration.sql` is canonically mapped to `apps/api/prisma/migrations/20261104000100_initial_foundation/migration.sql` alongside `apps/api/prisma/migrations/migration_lock.toml`.

### 2.2 Least-Privilege PostgreSQL Role Separation & Per-Center `CONNECT` Isolation (`T04.02`)
We separate database identities into five distinct roles (`infra/db/01-init-roles-and-databases.sql`, `infra/db/02-apply-runtime-grants.sql`, and `eduerp_apply_role_grants()` in `migration.sql`):
1. `eduerp_pg_superuser` (`POSTGRES_USER`): Container bootstrap administrator used exclusively during database/role initialization; never used by API or Worker processes.
2. `eduerp_migrator`: `NOSUPERUSER NOCREATEDB NOCREATEROLE` schema owner granted `USAGE, CREATE ON SCHEMA public` to run `prisma migrate deploy`.
3. `eduerp_api_runtime`: `NOSUPERUSER NOCREATEDB NOCREATEROLE` API runtime role granted `SELECT, INSERT, UPDATE` on the 25 mutable tables and `SELECT, INSERT` ONLY on the 21 append-only tables (`DELETE` and DDL are revoked).
4. `eduerp_worker_runtime`: `NOSUPERUSER NOCREATEDB NOCREATEROLE` worker runtime role granted `SELECT, INSERT, UPDATE` only on worker-mutated tables (`outbox_events`, `notification_deliveries`, `promises_to_pay`, `lesson_occurrences`, `invoices`, `enrollments`, `trial_activations`, `guardian_telegram_links`, `center_licenses`), `SELECT, INSERT` on worker-produced append-only tables (`outbox_consumer_receipts`, `audit_logs`, `billing_cycles`, `invoice_lines`, `credit_notes`, `credit_note_applications`, `ledger_entries`), and `SELECT` on remaining tables.
5. `eduerp_readonly`: `NOSUPERUSER` reporting/inspection role granted `SELECT` only across all 46 tables.
6. **Cross-Center `CONNECT` Isolation:** `REVOKE CONNECT ON DATABASE ... FROM PUBLIC` is enforced on every center database (`eduerp_guliston_ilm_dev` vs `eduerp_jizzax_ziyo_dev`), ensuring Center A credentials (`eduerp_api_runtime`) fail with `SQLSTATE 42501` if pointed at Center B's database (`eduerp_center_b_api`).

### 2.3 Two-Layer Immutability Enforcement (Role ACL + Database Triggers)
- **Layer 1 (Privilege Revocation):** Runtime roles (`eduerp_api_runtime`, `eduerp_worker_runtime`, `eduerp_readonly`) have zero `DELETE` privileges on any table and zero `UPDATE` privileges on the 21 append-only tables.
- **Layer 2 (PL/pgSQL Triggers):** Even for table owners or privileged maintenance sessions:
  - `eduerp_forbid_append_only_mutation()` (`trg_immutable_<table_name>` on all 21 append-only tables) blocks `UPDATE` and `DELETE` with `SQLSTATE 42501` (`IMMUTABLE_TABLE_VIOLATION`).
  - `eduerp_guard_closed_state_mutation()` (`trg_cash_shifts_closed_immutable`, `trg_payroll_snapshots_closed_immutable`) blocks `DELETE` and any `UPDATE` once `status = 'CLOSED'` (`SQLSTATE 42501`, `CLOSED_RECORD_IMMUTABLE`).
  - `eduerp_guard_last_active_director()` (`trg_staff_users_last_active_director`) blocks deleting `staff_users` (`42501`) and blocks deactivating or demoting the last `ACTIVE` `DIRECTOR` of a center (`SQLSTATE 23514`, `LAST_DIRECTOR_CANNOT_BE_DEACTIVATED`).

### 2.4 Liveness (`/api/v1/health`) vs Readiness (`/api/v1/ready`) Separation
- `GET /api/v1/health` remains a pure, database-independent process liveness probe returning `200 OK` (`status: 'OK'`).
- `GET /api/v1/ready` (`getDatabaseReadiness`) verifies live PostgreSQL connectivity, confirms the active DB session is NOT a superuser (`rolsuper = false`), and verifies all `46` canonical tables and `24` immutability triggers exist (`200 OK` when ready; `503 Service Unavailable` with credential-redacted `ErrorEnvelope` when unavailable).

---

## 3. Consequences

- **Positive:** Financial records, audit logs, and closed shifts/payroll snapshots cannot be silently mutated or deleted by application bugs or compromised runtime connections. Cross-center database connections are rejected at the PostgreSQL `CONNECT` layer.
- **Trade-offs:** Corrections to payments, allocations, invoices, or closed payroll periods must be recorded via append-only compensating entities (`ReversalOrRefundExecution`, `PaymentAllocationReversal`, `CreditNote`, `PayrollAdjustment`), matching Stage 01/02 business rules.
