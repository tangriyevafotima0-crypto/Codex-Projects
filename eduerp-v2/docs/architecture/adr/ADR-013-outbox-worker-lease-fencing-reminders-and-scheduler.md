# ADR-013: Stage 13 Transactional Outbox Lease/Fencing/DLQ, 09:00 Promise Reminders, 20-Minute Teacher Ping/Escalation, and Idempotent Scheduler (`S13FIX-T`)

- **Status:** Proposed (`IN_REVIEW` under `S13FIX-T`)
- **Date:** 2026-11-05
- **Stage:** `S13` (`13.01`–`13.05`, `S01`–`S08`, `T01`–`T06`)

## 1. Context
Stage 13 implements the background worker and scheduler runtime (`apps/worker/src/{database.ts,outbox.worker.ts,reminders.worker.ts,teacher-ping.worker.ts,schedules.worker.ts,main.ts}`) and shared canonical billing engine (`packages/contracts/src/billing-engine.ts`) operating under the least-privilege `eduerp_worker_runtime` PostgreSQL role without live external Telegram network calls (`S14` scope).

## 2. Architectural Decisions (`S01`–`S08` & `T01`–`T05`)

1. **Automatic Non-Overlapping Timer Poll Loop, Task Failure Isolation & Bounded Graceful Drain (`S01`, `T05`, `13.05`):**
   - `WorkerRuntimeSkeleton.start()` schedules automatic non-overlapping `executePollCycle()` runs on `config.pollIntervalMs` while guarding with `inFlightTick`.
   - Inside `executePollCycle()`, each scheduled task (`PromiseReminderJob`, `TeacherPingAndEscalationJob`, `BillingCycleCutoffAndCatchUpJob`, `UnclosedCashShiftReminderJob`, `TrialNoShowFollowUpJob`, `OutboxTickJob`) executes in an isolated `try / catch` block (`worker_job_isolated_error`), deduplicating unconfigured policy warnings across polls so a policy or transient error in one task never floods logs or aborts downstream tasks (`WORKER-IT-09`).
   - `stop(signal)` shares a single `stopPromise` across concurrent callers, clears the poll timer, awaits any in-flight tick up to a bounded slice of `shutdownTimeoutMs`, and calls `WorkerDatabase.close(timeoutMs, timedOut)`, which tracks active checked-out `PoolClient` sockets and aborts/destroys hung active queries if the tick timed out (`WORKER-IT-23`).
   - `worker_stopped_gracefully` is emitted only when `inFlightTick` drained cleanly within budget; timed-out drains emit `worker_shutdown_bounded_timeout` (`drained_cleanly: false`) and exit non-zero in `bootstrapWorker`.

2. **Fail-Closed Default Transport, Versioned Event Registry, Deferred Budget Preservation & Selective Restore (`S02`, `13.01`, `B14`, `BR-17`):**
   - `OutboxWorker` defaults to `UnboundFailClosedNotificationTransportAdapter` (`DEFERRED_TRANSPORT_NOT_BOUND`), which never fabricates `API_ACCEPTED` or fake `telegram_message_id` values in production (`WORKER-IT-10`). `SyntheticNotificationTransportAdapter` is used only when explicitly injected in tests.
   - `CANONICAL_OUTBOX_EVENT_REGISTRY` validates `event_name` and `schema_version`; unregistered event names or unsupported schema versions fail closed via `NonRetryablePoisonEventError` -> `DEAD_LETTER` (`WORKER-IT-10`).
   - Waiting while `BOT_OUTBOUND_ENABLED = false` or while transport is unbound preserves `attempt_count` (`preserveAttemptBudget: true`) so passive waiting across `> 8` polls never sends valid business events to `DEAD_LETTER` (`WORKER-IT-10`).
   - `reconcileRestoredOutbox` selectively marks pre-cutoff outbound notification events as `SUPERSEDED_BY_RESTORE` (and their queued deliveries as `SKIPPED_UNLINKED`) while preserving unapplied internal domain/financial events (`AllocationAdjusted`, `GuardianLinkRevoked`, `PromiseFulfilled`, `LicenseStateChanged`) so their internal DB receipts still execute (`WORKER-IT-16`).

3. **Fenced Delivery Transitions, Durable Pre-Send Attempt Persistence & Real Subprocess Crash Recovery (`S03`, `T05`, `13.01`, `S2F04`):**
   - Every `notification_deliveries` state mutation (`API_ACCEPTED`, `RETRY_429`, `FAILED_403_BLOCKED`, `SKIPPED_UNLINKED`, transient retry, and pre-send attempt marker) runs inside `runFencedDeliveryMutation`, which locks `outbox_events` `FOR UPDATE` verifying `status = 'LEASED' AND lease_token = :worker_lease_token`. Stale leaseholders throw `StaleLeaseTokenError` and cannot overwrite the active leaseholder's state (`WORKER-IT-11`).
   - Before calling `transportAdapter.sendNotification`, `OutboxWorker` commits `last_lease_token = event.lease_token, attempt_count = attempt_count + 1` in PostgreSQL. When a worker subprocess is terminated with a real OS `SIGKILL` after external send before local DB ACK commit (`WORKER-IT-22`), the next leaseholder detects `priorLeaseToken > 0n` on the `QUEUED` row, records `EXTERNAL_DELIVERY_AMBIGUOUS_AFTER_SEND` (`possible_duplicate_delivery: true`, never claiming external `exactly_once`), and deduplicates internal domain effects via `outbox_consumer_receipts`.

4. **Feature-Specific Per-Center Notification Policy & Exact Guardian–Student Child Scope (`S04`, `T03`, `T04`, `13.02`, `CASE-22`, `OPEN_CHANNEL_02`, `OWNER-20261105-04`):**
   - Additive migration `20261106000900_s13_notification_policy_and_delivery_scope` adds `notification_policy_status` (`DEFAULT 'UNCONFIGURED'`), `promise_reminder_channel_policy` (`DEFAULT 'UNCONFIGURED_CHANNEL_POLICY'`), and `notification_policy_effective_until` on `billing_policy_versions`, plus `target_student_id`, `payload_projection_json`, and `policy_version_id` on `notification_deliveries`.
   - General S08 billing `policy_confirmation_status = 'CONFIRMED'` NEVER implicitly confirms `PromiseDue` reminder channels; `RemindersWorker.resolveEffectiveChannelPolicy` returns `'UNCONFIGURED_CHANNEL_POLICY'` unless `notification_policy_status = 'CONFIRMED'` and effective (`WORKER-IT-20`).
   - Right before sending any `PromiseDue` delivery, `OutboxWorker` re-verifies live center notification policy (suppressing deliveries if revoked, expired, or narrowed from `CONFIRMED_ADMIN_AND_GUARDIAN` to `CONFIRMED_GUARDIAN_ONLY`) as well as live `promises_to_pay` status + `superseded_by_promise_id IS NULL` and `invoices.remaining_debt_uzs > 0` (`WORKER-IT-12`, `WORKER-IT-20`).
   - For batch `AttendanceSubmitted` / `AttendanceCorrected` (and single-student events), `OutboxWorker` never uses a `NULL -> any active child` fallback; it verifies live `guardian_students.active = TRUE` for the exact target student IDs of the event and projects only the guardian's permitted child(ren) into `request.payload` (`WORKER-IT-21`).

5. **Single Canonical Billing Engine & Durable Bounded Catch-Up Horizon (`S05`, `T02`, `13.04`, `OWNER-20261104-03`):**
   - Both `apps/api/src/billing/invoice-generator.ts` and `apps/worker/src/schedules.worker.ts` (`CanonicalSqlBillingCycleWorkerPort`) delegate to the single shared canonical engine `executeCanonicalBillingCycleIssuanceInTx` in `@eduerp/contracts` (`WORKER-IT-19`).
   - `SchedulesWorker.runBillingCycleCutoffAndCatchUpJob` enforces durable DB-backed bounded catch-up eligibility (`CURRENT_CYCLE_ONLY` issues only the cycle covering `referenceDate` and never drains historical past cycles across repeated polls or restarts; `PREVIOUS_AND_CURRENT_CYCLE` issues at most `[previous, current]`; unconfirmed old first-cycle enrollments are deferred via `BILLING_HISTORICAL_RECONCILIATION_DEFERRED` — `WORKER-IT-13`, `WORKER-IT-17`, `WORKER-IT-18`).

6. **Teacher Ping Side-Effect Isolation & Bounded Historical Scan Window (`S06`, `T01`, `13.03`):**
   - `TeacherPingWorker` updates only `teacher_ping_sent_at` and `teacher_ping_recipient_id` and NEVER mutates `lesson_occurrences.pay_recipient_teacher_id`, scans a bounded window (`lesson_date == centerLocalDate` or `starts_at_utc >= nowUtc - 24h`), and `OutboxWorker` re-verifies live lesson/teacher state immediately before sending `TeacherPingDue` (`WORKER-IT-06`, `WORKER-IT-15`).
