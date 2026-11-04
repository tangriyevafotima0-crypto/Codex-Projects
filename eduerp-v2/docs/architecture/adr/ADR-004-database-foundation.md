# ADR-004: PostgreSQL 16 & Prisma 7 Database Foundation, Relational Lineage, and Separated Runtime Roles (`S04` + `F01`–`F10`)

- **Status:** `ACCEPTED (Candidate IN_REVIEW — S04FIX-S05FULL-G)`
- **Stage / Steps:** `S04` (`04.01`–`04.05`, remediated for `F01`–`F10`)
- **Related Requirements:** `R02.04`, `R05.01`–`R05.05`, `R08.01`–`R12.04`, `R16.01`–`R16.05`, `R22.01`–`R22.04`

---

## 1. Context & Problem Statement

EduERP v2.0 operates an isolated Per-Center Data Plane where every center has its own dedicated PostgreSQL 16 database, financial amounts in UZS must be stored and calculated losslessly as `BIGINT`, audit/ledger/receipt/payment histories must be strictly append-only at the database layer, and cross-student/cross-center relational lineage must be enforced by PostgreSQL constraints and triggers rather than trusting application code alone.

---

## 2. Key Architectural Decisions (`04.01`–`04.05` & `F01`–`F10`)

1. **Prisma 7 (`7.10.1`) Driver Adapter & Zero `P1012` Composite 1-to-1 Relations (`04.01`, `F01`, `F02`, `F03`):**
   - `apps/api/prisma/schema.prisma` uses `provider = "prisma-client"` outputting to `../src/generated/prisma`, instantiated inside `DatabaseService` via `new PrismaClient({ adapter: new PrismaPg(this.pool) })` (`F02`).
   - All 5 composite 1-to-1 foreign-key relations (`Invoice`->`BillingCycle`, `DiscountApproval`->`DiscountRequest`, `CreditNote`->`Payment`, `ReversalOrRefundExecution`->`ReversalOrRefundRequest`, `Receipt`->`Payment`) are backed by explicit `@@unique([..., centerId])` constraints so `prisma generate` succeeds with zero `P1012` validation errors (`F01`).
   - `DatabaseModule.register()` provides the single canonical `DatabaseService` instance across `AppModule`, `HealthModule`, and `AuthModule` (`F03`).
2. **Separated Least-Privilege Database Roles & Dedicated Migrator Boundary (`04.02`, `F05`, `F06`):**
   - Runtime connections (`eduerp_api_runtime`, `eduerp_worker_runtime`, `eduerp_readonly`) are `NOSUPERUSER NOCREATEDB NOCREATEROLE` and do not own `SCHEMA public`.
   - `MIGRATION_DATABASE_URL` (`eduerp_migrator`) is consumed exclusively by the Prisma CLI (`prisma.config.ts`) and the one-shot `migrator` Docker Compose service; `ApiEnvConfig` and the `api` container do not accept or expose `MIGRATION_DATABASE_URL` (`F06`).
   - `GET /api/v1/ready` verifies `rolsuper = false`, `schema_owner = false`, `has_table_privilege` ACLs (`staff_users` DELETE=false, `audit_logs` UPDATE=false), all `46` canonical tables, and all `24` enabled (`tgenabled != 'D'`) immutability triggers, returning a static safe `503` message when any check fails (`F06`).
3. **Append-Only Immutability Triggers, Race-Safe Last-Director Guard & Relational Lineage (`04.02`, `F08`, `F09`, `F10`):**
   - `21` append-only tables reject `UPDATE` and `DELETE` via `eduerp_forbid_append_only_mutation()`; closed `payroll_snapshots` and `cash_shifts` reject post-close mutation.
   - `eduerp_guard_last_active_director()` acquires `SELECT "id" FROM "staff_users" WHERE "center_id" = OLD.center_id AND "role" = 'DIRECTOR' AND "status" = 'ACTIVE' ORDER BY "id" FOR UPDATE` (with `lock_timeout = '1500ms'` on runtime roles) so concurrent two-connection attempts to deactivate or demote two remaining Directors cannot leave a center with zero active Directors (`F08`).
   - Composite foreign keys and `eduerp_enforce_relational_lineage()` triggers across `11` tables prevent cross-student/cross-group/cross-invoice/cross-payment data corruption (`F09`).
   - `client_operation_logs` uses composite primary key `(center_id, actor_id, operation_type, client_operation_uuid)` so reusing a UUID across distinct operations or actors never causes a global `23505` collision (`F10`).
