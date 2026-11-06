# ADR-013: Stage 13 Transactional Outbox Lease/Fencing/DLQ, 09:00 Promise Reminders, 20-Minute Teacher Ping/Escalation, and Idempotent Scheduler (`S13FIX-S`)

- **Status:** Proposed (`IN_REVIEW` under `S13FIX-S`)
- **Date:** 2026-11-05
- **Stage:** `S13` (`13.01`–`13.05`, `S01`–`S08`)

## 1. Context
Stage 13 implements the background worker and scheduler runtime (`apps/worker/src/{database.ts,outbox.worker.ts,reminders.worker.ts,teacher-ping.worker.ts,schedules.worker.ts,main.ts}`) operating under the least-privilege `eduerp_worker_runtime` PostgreSQL role without live external Telegram network calls (`S14` scope).

## 2. Architectural Decisions (`S01`–`S08`)

1. **Automatic Non-Overlapping Timer Poll Loop, Task Failure Isolation & Graceful Drain (`S01`, `13.05`):**
   - `WorkerRuntimeSkeleton.start()` schedules automatic non-overlapping `executePollCycle()` runs on `config.pollIntervalMs` while guarding with `inFlightTick`.
   - Inside `executePollCycle()`, each scheduled task (`PromiseReminderJob`, `TeacherPingAndEscalationJob`, `BillingCycleCutoffAndCatchUpJob`, `UnclosedCashShiftReminderJob`, `TrialNoShowFollowUpJob`, `OutboxTickJob`) executes in an isolated `try / catch` block (`worker_job_isolated_error`) so a policy or transient error in one task never aborts downstream tasks (`WORKER-IT-09`).
   - `stop('SIGTERM')` clears the poll timer, awaits any in-flight tick up to `shutdownTimeoutMs`, closes the PostgreSQL pool, and logs `worker_stopped_gracefully`.

2. **Fail-Closed Default Transport, Versioned Event Registry, Deferred Budget Preservation & Selective Restore (`S02`, `13.01`, `B14`, `BR-17`):**
   - `OutboxWorker` defaults to `UnboundFailClosedNotificationTransportAdapter` (`DEFERRED_TRANSPORT_NOT_BOUND`), which never fabricates `API_ACCEPTED` or fake `telegram_message_id` values in production (`WORKER-IT-10`). `SyntheticNotificationTransportAdapter` is used only when explicitly injected in tests.
   - `CANONICAL_OUTBOX_EVENT_REGISTRY` validates `event_name` and `schema_version`; unregistered event names or unsupported schema versions fail closed via `NonRetryablePoisonEventError` -> `DEAD_LETTER` (`WORKER-IT-10`).
   - Waiting while `BOT_OUTBOUND_ENABLED = false` or while transport is unbound preserves `attempt_count` (`preserveAttemptBudget: true`) so passive waiting across `> 8` polls never sends valid business events to `DEAD_LETTER` (`WORKER-IT-10`).
   - `reconcileRestoredOutbox` selectively marks pre-cutoff outbound notification events as `SUPERSEDED_BY_RESTORE` (and their queued deliveries as `SKIPPED_UNLINKED`) while preserving unapplied internal domain/financial events (`AllocationAdjusted`, `GuardianLinkRevoked`, `PromiseFulfilled`, `LicenseStateChanged`) so their internal DB receipts still execute (`WORKER-IT-16`).

3. **Fenced Delivery Transitions & Durable Pre-Send Attempt Persistence (`S03`, `13.01`, `S2F04`):**
   - Every `notification_deliveries` state mutation (`API_ACCEPTED`, `RETRY_429`, `FAILED_403_BLOCKED`, `SKIPPED_UNLINKED`, transient retry, and pre-send attempt marker) runs inside `runFencedDeliveryMutation`, which locks `outbox_events` `FOR UPDATE` verifying `status = 'LEASED' AND lease_token = :worker_lease_token`. Stale leaseholders throw `StaleLeaseTokenError` and cannot overwrite the active leaseholder's state (`WORKER-IT-11`).
   - Before calling `transportAdapter.sendNotification`, `OutboxWorker` commits `last_lease_token = event.lease_token, attempt_count = attempt_count + 1` in PostgreSQL. If the worker crashes or is killed (`SIGKILL`) after external send without any surviving in-memory error flag, the next leaseholder detects `priorLeaseToken > 0n` on the `QUEUED` row and records `EXTERNAL_DELIVERY_AMBIGUOUS_AFTER_SEND` (`possible_duplicate_delivery: true` — `WORKER-IT-05`, `WORKER-IT-11`).

4. **Explicit Channel Policy & Live Pre-Send Promise/Recipient Authority (`S04`, `13.02`, `CASE-22`, `OPEN_CHANNEL_02`):**
   - `RemindersWorker` verifies confirmed center policy before emitting reminders and stages `notification_deliveries` only for active guardians (`guardian_students.active = TRUE AND guardians.status = 'ACTIVE'`) and linked active Admins (`SKIPPED_UNLINKED` when `telegram_user_id IS NULL`).
   - Right before sending a `PromiseDue` delivery, `OutboxWorker` re-verifies both `invoices.remaining_debt_uzs > 0` AND that the specific `promises_to_pay` row (`payload_json.promise_id`) is still `ACTIVE`/`OVERDUE_NOTIFIED` with `superseded_by_promise_id IS NULL` (`WORKER-IT-12`), and re-verifies live `staff_users` / `guardians` authority (`replayDeadLetterEvent` also verifies live `ACTIVE` `DIRECTOR`/`ADMIN` status in PostgreSQL).

5. **Canonical SQL Billing Scheduler Engine & Live License Enforcement (`S05`, `13.04`, `OWNER-20261104-03`):**
   - `SchedulesWorker` defaults to `CanonicalSqlBillingCycleWorkerPort`, executing `CALENDAR_MONTH` (computing `lastDay` from the target cycle's year/month, including Feb 28 vs leap Feb 29, and supporting `PREVIOUS_AND_CURRENT_CYCLE` catch-up), `ROLLING_MONTH` (`Jan 31 -> Feb 28 -> Mar 28`), and `LESSON_PACKAGE_12` (`PKG:{seq}` with durable `billing_cycle_lesson_allocations` — `WORKER-IT-13`).
   - `WorkerDatabase.resolveLiveCenterLicenseMode` fails closed to `READ_ONLY` when `center_licenses` is `READ_ONLY` or missing, and all three scheduled jobs enforce this check at entry (`WORKER-IT-14`).

6. **Teacher Ping Side-Effect Isolation & Bounded Historical Scan Window (`S06`, `13.03`):**
   - `TeacherPingWorker` updates only `teacher_ping_sent_at` and `teacher_ping_recipient_id` and NEVER mutates `lesson_occurrences.pay_recipient_teacher_id`, scans a bounded window (`lesson_date == centerLocalDate` or `starts_at_utc >= nowUtc - 24h`), and `OutboxWorker` re-verifies live lesson/teacher state immediately before sending `TeacherPingDue` (`WORKER-IT-06`, `WORKER-IT-15`).
