# ADR-013: Stage 13 Transactional Outbox Lease/Fencing/DLQ, 09:00 Promise Reminders, 20-Minute Teacher Ping/Escalation, and Idempotent Scheduler

- **Status:** Proposed (`IN_REVIEW` under `S12FIX-S13FULL-R`)
- **Date:** 2026-11-05
- **Stage:** `S13` (`13.01`–`13.05`)

## 1. Context
Stage 13 implements the background worker and scheduler runtime (`apps/worker/src/{database.ts,outbox.worker.ts,reminders.worker.ts,teacher-ping.worker.ts,schedules.worker.ts,main.ts}`) operating under the least-privilege `eduerp_worker_runtime` PostgreSQL role without live external Telegram network calls (`S14` scope).

## 2. Architectural Decisions

1. **Predecessor-Gated Lease Acquisition & Monotonic `lease_token` Fencing (`13.01`, `S2F04`):**
   - `OutboxWorker.claimOutboxBatch` claims `PENDING` or lease-expired `LEASED` rows using `FOR UPDATE SKIP LOCKED`, increments `lease_token = lease_token + 1` and `attempt_count = attempt_count + 1`, and enforces a `NOT EXISTS` predecessor gate on `(center_id, aggregate_type, aggregate_id, aggregate_version < candidate.aggregate_version)` so `v2` of an aggregate never runs while `v1` is `PENDING`, `LEASED`, or `DEAD_LETTER`, while unrelated aggregates proceed without head-of-line blocking (`WORKER-IT-01`, `WORKER-IT-04`).
   - Every internal DB consumer (`executeInternalConsumerWithReceipt`) locks `outbox_events` `FOR UPDATE` checking `status = 'LEASED' AND lease_token = :worker_lease_token`, inserts `outbox_consumer_receipts` (`ON CONFLICT DO NOTHING`), and executes its domain mutation in a single PostgreSQL transaction (`WORKER-IT-02`).

2. **Honest External Delivery Crash Window & `BOT_OUTBOUND_ENABLED=false` Restore Guard (`13.01`, `B14`, `BR-17`):**
   - External network delivery cannot participate in local PostgreSQL ACID transactions. If a worker crashes after calling the external transport adapter (`ExternalNotificationTransportAdapter`) but before committing `notification_deliveries.delivery_status = 'API_ACCEPTED'`, `OutboxWorker` records an explicit `WARN` audit log (`EXTERNAL_DELIVERY_AMBIGUOUS_AFTER_SEND` with `possible_duplicate_delivery: true`) rather than claiming impossible network-level `exactly-once` delivery (`WORKER-IT-05`).
   - When `BOT_OUTBOUND_ENABLED = false`, external transport calls are blocked and `reconcileRestoredOutbox` transitions pre-restore `PENDING`/`LEASED` events to `SUPERSEDED_BY_RESTORE` (`WORKER-IT-08`).

3. **09:00 Center-Local Promise Reminder & `CASE-22` Settlement Suppression (`13.02`):**
   - `RemindersWorker.runPromiseReminderTick` evaluates current center local time in `config.centerTimezone` (`Asia/Tashkent`). Before `09:00` local time, no reminders are emitted. At/after `09:00`, each candidate `promises_to_pay` row and its `invoices` row are locked `FOR UPDATE`: if `remaining_debt_uzs == 0`, the promise is auto-fulfilled (`status = 'FULFILLED'`) with zero reminders (`CASE-22`); if `status == 'ACTIVE'` and `superseded_by_promise_id IS NULL` and `reminder_sent_at IS NULL`, `PromiseDue` (`v1`) is emitted once with `dedup_key = "PromiseDue:${promise_id}:${promise_date}"` (`WORKER-IT-03`).

4. **20-Minute Teacher Ping & Lesson-End Admin Escalation (`13.03`):**
   - `TeacherPingWorker.runTeacherPingAndEscalationTick` resolves the live effective teacher (`ACTIVE` single-lesson `substitute_assignments` row, else `course_groups.primary_teacher_id`) under row lock. If an old substitute was revoked/reassigned, any queued ping to the old teacher is suppressed (`SKIPPED_UNLINKED`) before pinging the current effective teacher (`WORKER-IT-06`).

5. **Idempotent Scheduled Jobs & `BillingCycleWorkerPort` Seam (`13.04`):**
   - `SchedulesWorker` consumes `@eduerp/contracts` `BillingCycleWorkerPort` (implemented by `InvoiceGeneratorService.issueWorkerInvoiceForCycle`) so invoice proration, tariff resolution, and package lesson ownership are never duplicated in `apps/worker`.
   - `runUnclosedCashShiftReminderJob` flags open shifts in `audit_logs` (`CASH_SHIFT_UNCLOSED_REMINDER`) without ever fabricating `counted_closing_cash_uzs` or auto-closing a shift (`WORKER-IT-07`).
