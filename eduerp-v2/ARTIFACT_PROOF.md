# ARTIFACT_PROOF.md — `S13FIX-T` Delta & Submission Archive Verification Proof

- **Task ID:** `S13FIX-T`
- **Base Commit:** `cca475dd3bfc1cb7d323d57035ed158d53a72a63`
- **Candidate Input Commit:** `7103887c0f687c66aa81fadb0011586a7a088eab`
- **Accepted Stage 12 Commit Preserved:** `0b7ea62efe10503908e3176bf608d55c62ddf819`
- **Archive Path:** `/Users/selfish/Documents/Codex/2026-11-03/bun/work/gemini-eduerp-s13t/S13FIX_T_SUBMISSION.zip`
- **Status:** `IN_REVIEW`

## 1. Required Output Files & Declared Test Scenarios Verified (`T01`–`T06`)
- `apps/worker/src/main.ts`
- `apps/worker/src/schedules.worker.ts`
- `apps/worker/src/reminders.worker.ts`
- `apps/worker/src/outbox.worker.ts`
- `apps/worker/test/worker-integration.test.ts` (`WORKER-IT-01` .. `WORKER-IT-24`, including `WORKER-IT-17` .. `WORKER-IT-24`)
- `docs/verification/S13-T.md`
- `ARTIFACT_PROOF.md`

## 2. Additional Modified / Created Delta Files Included in `S13FIX_T_SUBMISSION.zip`
- `packages/contracts/src/billing-engine.ts` (New — single canonical Stage 08 billing calculation & transactional SQL issuance engine)
- `packages/contracts/src/index.ts` (Exports `billing-engine` and `PromiseReminderChannelPolicy`)
- `apps/api/src/billing/invoice-generator.ts` (Delegates `issueCycleInvoiceWithinTransaction` and `loadInvoiceResponseInTx` to `@eduerp/contracts`)
- `apps/api/src/billing/policy.ts` (Supports `notification_policy_status`, `promise_reminder_channel_policy`, `notification_policy_effective_until` defaulting to `UNCONFIGURED` / `UNCONFIGURED_CHANNEL_POLICY`)
- `apps/api/prisma/schema.prisma` (Maps `notificationPolicyStatus`, `promiseReminderChannelPolicy`, `notificationPolicyEffectiveUntil` on `BillingPolicyVersion` and `targetStudentId`, `payloadProjectionJson`, `policyVersionId` on `NotificationDelivery`)
- `apps/api/prisma/migrations/20261106000900_s13_notification_policy_and_delivery_scope/migration.sql` (Additive Migration 09)
- `apps/api/test/database/migrations-and-drift.integration.test.ts` (Updated migration count to 9 for additive Migration 09)
- `apps/worker/package.json` (Explicitly pins `"pg": "8.23.1"` in `dependencies` and `"@types/pg": "8.23.1"` in `devDependencies`; `needs_manager_dependency_refresh: true`)
- `apps/worker/src/database.ts` (Tracks active `PoolClient` instances and implements bounded `close(timeoutMs, forceAbortActive)`)
- `apps/worker/test/worker.test.ts` (Unit tests for bounded `stop()`, shared `stopPromise`, recipient-scoped payload projection, and leap/rolling dates)
- `tools/verify_s04.py` (Verifies Migration 09, worker `pg` dependency, and `WORKER-IT-01..24`)
- `docs/verification/S13.md`
- `docs/architecture/adr/ADR-013-outbox-worker-lease-fencing-reminders-and-scheduler.md`
- `planning/state/handoffs/S13.md`
- `planning/state/steps/13.01.md` .. `13.05.md`

## 3. Verifier Execution Proof
- `python3 -B VERIFY_INPUT.py` (pre-edit baseline) -> `PASS: input paths and SHA256; files=555` (`exit_code: 0`)
- `python3 -B eduerp-v2/tools/verify_s01_s02.py` -> `PASS` (`exit_code: 0`)
- `python3 -B eduerp-v2/tools/verify_s04.py` -> `PASS` (`migrations_verified: 9`, `worker_integration_scenarios_verified: 24`, `ts_sql_insert_statements_verified: 349`, `exit_code: 0`)
- `python3 -B eduerp-v2/planning/tools/check_plan.py` -> `PASS` (`exit_code: 0`)
- `python3 -B eduerp-v2/planning/tools/test_plan.py` -> `PASS` (`exit_code: 0`)
- `python3 -B manager_reference/audit_submission.py --source . --zip S13FIX_T_SUBMISSION.zip` -> `PACKAGING PASS` (`exit_code: 0`)
- Live PostgreSQL / `node_modules` / Docker checks (`npm run lint`, `npm run typecheck`, `npm test`, `npm run test:db`, `docker build`): `NOT_RUN` in this sandbox because local `node_modules`, PostgreSQL daemon, and Docker daemon are not installed (`needs_manager_dependency_refresh: true`).
