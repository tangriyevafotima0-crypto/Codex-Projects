/**
 * EduERP v2.0 — Gate G10: Stage 13 Outbox Lease/Fencing/Retry/DLQ, 09:00 Promise Reminders,
 * 20-Minute Teacher Ping & Admin Escalation, and Idempotent Scheduled Jobs
 * Real PostgreSQL Integration Test Suite (`WORKER-IT-01..16` — `S01`–`S07`):
 *
 * - `WORKER-IT-01`: `13.01` Two-worker concurrent `claimOutboxBatch` race (`FOR UPDATE SKIP LOCKED` -> single claim),
 *   monotonic `lease_token` fencing, lease expiry reclaim, and stale leaseholder rejection (`StaleLeaseTokenError`).
 * - `WORKER-IT-02`: `13.01` Atomic `executeInternalConsumerWithReceipt` (`AllocationAdjusted` -> `PromiseLifecycleConsumer`
 *   + `OutboxConsumerReceipt`), crash/fault rollback (`DOMAIN_EFFECT` and `RECEIPT_INSERT` leave zero partial writes),
 *   and idempotent receipt deduplication on retry.
 * - `WORKER-IT-03`: `13.02` Center-local `09:00` `RemindersWorker` (`Asia/Tashkent` pre-`09:00` skip, `09:00` `PromiseDue`
 *   emission + `OVERDUE_NOTIFIED` + `notification_deliveries` staging, `CASE-22` paid debt auto-fulfillment to `FULFILLED`
 *   with zero reminders, superseded promise `CANCELLED` suppression, bounded 1-day catch-up, and `POLICY_DECISION_NOT_CONFIRMED`
 *   on unbounded catch-up spam).
 * - `WORKER-IT-04`: `13.01` Predecessor `aggregate_version` ordering gate (`v2` held back while `v1` of same aggregate is
 *   `PENDING`/`LEASED`/`DEAD_LETTER`, while unrelated aggregate events continue without head-of-line blocking), bounded
 *   retry (`attempt_count <= 8`) -> `DEAD_LETTER` with redacted error, and `DIRECTOR`/`ADMIN` `replayDeadLetterEvent`.
 * - `WORKER-IT-05`: `13.01` Honest external delivery send-crash semantics via `SyntheticNotificationTransportAdapter`
 *   (`CRASH_BEFORE_SEND` vs `CRASH_AFTER_SEND_BEFORE_ACK` recording `EXTERNAL_DELIVERY_AMBIGUOUS_AFTER_SEND` audit with
 *   `possible_duplicate_delivery: true`, `RATE_LIMIT_429` -> `RETRY_429`, `BLOCKED_403` -> `FAILED_403_BLOCKED` +
 *   `guardian_telegram_links.status = 'BOT_BLOCKED_403'`, and live pre-send `remaining_debt_uzs == 0` suppression).
 * - `WORKER-IT-06`: `13.03` `TeacherPingWorker` 20-minute `STAGE_20M_PING` to primary or active single-lesson substitute
 *   teacher, revoked substitute suppression (`SKIPPED_UNLINKED` on old teacher's queued ping and fresh ping to primary),
 *   lesson-end `STAGE_END_ADMIN_ESCALATION` to Admin, and suppression of `CANCELLED_BY_CENTER`, `RESCHEDULED`, and
 *   `COMPLETED` (submitted attendance) lessons.
 * - `WORKER-IT-07`: `13.04` `SchedulesWorker` idempotent billing cutoff job via `BillingCycleWorkerPort` (skipping `TRIAL`
 *   enrollments, deduplicating reruns, blocking `READ_ONLY` license centers and unconfirmed catch-up policies),
 *   `runUnclosedCashShiftReminderJob` flagging `OPEN` shifts without auto-closing (`shiftsAutoClosedCount == 0`), and
 *   `runTrialNoShowFollowUpJob` policy gate (`UNCONFIGURED` blocked vs `CONFIRMED_SECOND_ABSENCE_ADMIN_FOLLOWUP`).
 * - `WORKER-IT-08`: `13.01` & `13.05` Restore safety (`BOT_OUTBOUND_ENABLED = false` blocks external transport and
 *   `reconcileRestoredOutbox` selectively marks pre-restore notification events `SUPERSEDED_BY_RESTORE` while preserving
 *   unapplied internal financial events), `READ_ONLY` license allowlist (`LicenseStateChanged` processed while business
 *   events wait), and least-privilege `eduerp_worker_runtime` role enforcement (`42501`).
 * - `WORKER-IT-09`: `S01` Real `WorkerRuntimeSkeleton.start()` automatic timer poll loop + non-overlapping tick guard +
 *   per-job failure isolation + graceful `stop('SIGTERM')` in-flight drain.
 * - `WORKER-IT-10`: `S02` Default `UnboundFailClosedNotificationTransportAdapter` never fabricates `API_ACCEPTED`,
 *   unknown outbox `event_name` is rejected to `DEAD_LETTER`, and `> 8` polls while `BOT_OUTBOUND_ENABLED=false` or
 *   unbound transport preserve `attempt_count` without dead-lettering valid business events.
 * - `WORKER-IT-11`: `S03` Late worker delivery fencing (`429`, `403`, `timeout`, `API_ACCEPTED` from expired `lease_token`
 *   rejected with `StaleLeaseTokenError`) and durable pre-send DB attempt marker (`CRASH_AFTER_SEND_NO_MEMORY_FLAG`
 *   without in-memory error flag detected on recovery as `EXTERNAL_DELIVERY_AMBIGUOUS_AFTER_SEND`).
 * - `WORKER-IT-12`: `S04` Pre-send suppression of superseded `PromiseDue` delivery when invoice still has remaining debt
 *   from a newer promise, plus live `staff_users` / `guardian_students` authority and `DLQ` replay DB role verification.
 * - `WORKER-IT-13`: `S05` Real `CanonicalSqlBillingCycleWorkerPort` inside `SchedulesWorker` for `CALENDAR_MONTH`
 *   (including Feb 2026 28 days vs Feb 2028 29 days and `PREVIOUS_AND_CURRENT_CYCLE` catch-up), `ROLLING_MONTH`
 *   (`Jan 31 -> Feb 28 -> Mar 28` under `OWNER-20261104-03`), and `LESSON_PACKAGE_12` (`PKG:1` -> `PKG:2` with durable
 *   `billing_cycle_lesson_allocations`).
 * - `WORKER-IT-14`: `S05` Live `center_licenses` `READ_ONLY` (and missing license row) fail-closed enforcement across
 *   `runBillingCycleCutoffAndCatchUpJob`, `runUnclosedCashShiftReminderJob`, and `runTrialNoShowFollowUpJob`.
 * - `WORKER-IT-15`: `S06` `TeacherPingWorker` never mutates `lesson_occurrences.pay_recipient_teacher_id`, enforces
 *   bounded historical scan window, and `OutboxWorker` suppresses queued `TeacherPingDue` right before send if attendance
 *   was submitted or substitute changed after event creation.
 * - `WORKER-IT-16`: `S02` & `S07` Selective `reconcileRestoredOutbox` preserves unapplied internal financial events
 *   (`AllocationAdjusted`) while superseding pre-cutoff notification events (`AttendanceSubmitted`), and API-emitted
 *   notification events (`PaymentRecorded`, `ShiftClosed`) auto-stage and deliver via `OutboxWorker`.
 */

import * as assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { URL } from 'node:url';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import {
  BillingCycleWorkerIssueParams,
  BillingCycleWorkerIssueResult,
  BillingCycleWorkerPort,
} from '@eduerp/contracts';
import { loadWorkerEnv, WorkerEnvConfig } from '../src/config/env';
import {
  OutboxWorker,
  RemindersWorker,
  SchedulesWorker,
  StaleLeaseTokenError,
  SyntheticNotificationTransportAdapter,
  TeacherPingWorker,
  WorkerDatabase,
  WorkerLogEvent,
  WorkerRuntimeSkeleton,
} from '../src/main';

const execFileAsync = promisify(execFile);

const CENTER_A = {
  centerId: '11111111-2222-4333-8444-000000000001',
  centerSlug: 'guliston-ilm',
  directorId: '11111111-2222-4333-8444-000000000002',
  adminId: '11111111-2222-4333-8444-000000000003',
  teacher1Id: '11111111-2222-4333-8444-000000000004',
  teacher2Id: '11111111-2222-4333-8444-000000000005',
  courseId: '11111111-2222-4333-8444-000000000020',
  groupId: '11111111-2222-4333-8444-000000000030',
  studentId: '11111111-2222-4333-8444-000000000040',
  guardianId: '11111111-2222-4333-8444-000000000050',
  policyId: '11111111-2222-4333-8444-000000000060',
} as const;

function resolveApiRoot(): string {
  const candidates = [
    path.resolve(__dirname, '../../../api'),
    path.resolve(__dirname, '../../api'),
    path.resolve(process.cwd(), 'apps/api'),
    path.resolve(process.cwd(), '../api'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'prisma', 'schema.prisma'))) {
      return c;
    }
  }
  throw new Error(`Cannot locate apps/api containing prisma/schema.prisma from ${__dirname}`);
}

interface WorkerTestDbEnv {
  readonly dbName: string;
  readonly apiPool: Pool;
  readonly workerPool: Pool;
  readonly workerDatabaseUrl: string;
  cleanup(): Promise<void>;
}

async function createWorkerTestDbEnv(): Promise<WorkerTestDbEnv> {
  if (process.env.EDUERP_ALLOW_DESTRUCTIVE_DB_TESTS !== 'true') {
    throw new Error('EDUERP_ALLOW_DESTRUCTIVE_DB_TESTS=true is required for Gate G10 worker DB tests');
  }
  const rawAdminUrl = process.env.TEST_DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
  if (!rawAdminUrl) {
    throw new Error('TEST_DATABASE_ADMIN_URL or DATABASE_URL is required');
  }
  const parsedAdmin = new URL(rawAdminUrl);
  const runId = crypto.randomBytes(4).toString('hex');
  const dbName = `eduerp_test_wrk_${runId}`;
  const roleMigrator = `eduerp_test_wmig_${runId}`;
  const roleApi = `eduerp_test_wapi_${runId}`;
  const roleWorker = `eduerp_test_wwrk_${runId}`;
  const roleRo = `eduerp_test_wro_${runId}`;
  const pass = `WrkPass_${runId}_Safe!99`;

  const adminPool = new Pool({ connectionString: parsedAdmin.toString(), max: 4 });
  let apiPool: Pool | null = null;
  let workerPool: Pool | null = null;

  const buildUrl = (user: string, password: string, db: string): string => {
    const u = new URL(parsedAdmin.toString());
    u.username = user;
    u.password = password;
    u.pathname = `/${db}`;
    return u.toString();
  };

  const cleanup = async (): Promise<void> => {
    await Promise.allSettled([apiPool?.end(), workerPool?.end()]);
    try {
      await adminPool.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [dbName],
      );
      await adminPool.query(`DROP DATABASE IF EXISTS "${dbName}"`);
      await adminPool.query(
        `DROP ROLE IF EXISTS "${roleApi}", "${roleWorker}", "${roleRo}", "${roleMigrator}"`,
      );
    } finally {
      await adminPool.end();
    }
  };

  try {
    for (const r of [roleMigrator, roleApi, roleWorker, roleRo]) {
      await adminPool.query(
        `CREATE ROLE "${r}" LOGIN PASSWORD '${pass}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`,
      );
    }
    await adminPool.query(`CREATE DATABASE "${dbName}" OWNER "${roleMigrator}"`);
    await adminPool.query(`REVOKE CONNECT ON DATABASE "${dbName}" FROM PUBLIC`);
    await adminPool.query(`GRANT CONNECT, TEMP ON DATABASE "${dbName}" TO "${roleMigrator}"`);
    await adminPool.query(
      `GRANT CONNECT ON DATABASE "${dbName}" TO "${roleApi}", "${roleWorker}", "${roleRo}"`,
    );

    const superDbUrl = buildUrl(
      decodeURIComponent(parsedAdmin.username),
      decodeURIComponent(parsedAdmin.password),
      dbName,
    );
    const migratorUrl = buildUrl(roleMigrator, pass, dbName);
    const apiUrl = buildUrl(roleApi, pass, dbName);
    const workerDatabaseUrl = buildUrl(roleWorker, pass, dbName);

    const superPool = new Pool({ connectionString: superDbUrl, max: 2 });
    try {
      await superPool.query(`GRANT USAGE, CREATE ON SCHEMA public TO "${roleMigrator}"`);
      const apiRoot = resolveApiRoot();
      const prismaCli = require.resolve('prisma/build/index.js', {
        paths: [apiRoot, path.resolve(apiRoot, '../..')],
      });
      await execFileAsync(
        process.execPath,
        [prismaCli, 'migrate', 'deploy', '--config', 'prisma.config.ts'],
        {
          cwd: apiRoot,
          env: {
            ...process.env,
            MIGRATION_DATABASE_URL: migratorUrl,
            DATABASE_URL: migratorUrl,
          },
          timeout: 60000,
        },
      );
      await superPool.query(`SELECT eduerp_apply_role_grants($1, $2, $3)`, [
        roleApi,
        roleWorker,
        roleRo,
      ]);
      await superPool.query(`
        REVOKE CREATE ON SCHEMA public FROM PUBLIC, "${roleApi}", "${roleWorker}", "${roleRo}";
        GRANT USAGE, CREATE ON SCHEMA public TO "${roleMigrator}";
        GRANT SELECT ON TABLE "_prisma_migrations" TO "${roleApi}", "${roleWorker}", "${roleRo}";
      `);
    } finally {
      await superPool.end();
    }

    apiPool = new Pool({ connectionString: apiUrl, max: 6 });
    workerPool = new Pool({ connectionString: workerDatabaseUrl, max: 6 });

    // Seed baseline Center A fixtures via apiPool (S07: includes all NOT NULL columns on billing_policy_versions)
    await apiPool.query(
      `INSERT INTO "center_licenses" (
         "center_id", "center_slug", "license_status", "signed_jwt_token",
         "signature_key_id", "valid_until_utc", "grace_until_utc", "last_verified_at_utc"
       ) VALUES (
         $1::uuid, $2, 'ACTIVE', 'syn-jwt-token',
         'key-01', '2027-01-01T00:00:00Z', '2027-01-08T00:00:00Z', '2026-11-05T00:00:00Z'
       )`,
      [CENTER_A.centerId, CENTER_A.centerSlug],
    );

    await apiPool.query(
      `INSERT INTO "staff_users" (
         "id", "center_id", "role", "full_name", "login_username",
         "telegram_user_id", "password_hash", "must_change_password", "status"
       ) VALUES
       ($1::uuid, $5::uuid, 'DIRECTOR', 'Director S13', 'director.s13', 100001, 'hash', FALSE, 'ACTIVE'),
       ($2::uuid, $5::uuid, 'ADMIN', 'Admin S13', 'admin.s13', 100002, 'hash', FALSE, 'ACTIVE'),
       ($3::uuid, $5::uuid, 'TEACHER', 'Primary Teacher S13', 'teacher1.s13', 100003, 'hash', FALSE, 'ACTIVE'),
       ($4::uuid, $5::uuid, 'TEACHER', 'Sub Teacher S13', 'teacher2.s13', 100004, 'hash', FALSE, 'ACTIVE')`,
      [
        CENTER_A.directorId,
        CENTER_A.adminId,
        CENTER_A.teacher1Id,
        CENTER_A.teacher2Id,
        CENTER_A.centerId,
      ],
    );

    await apiPool.query(
      `INSERT INTO "courses" ("id", "center_id", "name", "default_monthly_fee_uzs", "default_lessons_per_cycle", "status")
       VALUES ($1::uuid, $2::uuid, 'Mathematics S13', 500000, 12, 'ACTIVE')`,
      [CENTER_A.courseId, CENTER_A.centerId],
    );

    await apiPool.query(
      `INSERT INTO "billing_policy_versions" (
         "id", "center_id", "version_number", "billing_mode",
         "first_partial_charge_mode", "rounding_mode",
         "rolling_month_end_mode", "package_cancel_mode",
         "cancelled_lesson_proration_mode", "discount_stacking_mode",
         "freeze_credit_basis", "refund_debt_mode",
         "policy_confirmation_status", "discount_policy_status", "freeze_policy_status",
         "effective_from_date", "created_by_staff_id"
       ) VALUES (
         $1::uuid, $2::uuid, 1, 'CALENDAR_PRO_RATA',
         'PRORATE_REMAINING_LESSONS', 'HALF_UP_UZS_INT',
         'CONTINUE_FROM_CLAMPED_DAY', 'PRESERVE_BALANCE',
         'EXCLUDE_CANCELLED_FROM_PLANNED', 'UNCONFIGURED',
         'UNCONFIGURED', 'REOPEN_INVOICE_DEBT',
         'CONFIRMED', 'UNCONFIGURED', 'UNCONFIGURED',
         '2026-01-01', $3::uuid
       )`,
      [CENTER_A.policyId, CENTER_A.centerId, CENTER_A.directorId],
    );

    await apiPool.query(
      `INSERT INTO "course_groups" (
         "id", "center_id", "course_id", "name", "primary_teacher_id",
         "billing_mode", "current_fee_uzs", "lessons_per_cycle",
         "schedule_days_json", "starts_time", "duration_minutes", "timezone", "status"
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, 'GRP-S13-MAIN', $4::uuid,
         'CALENDAR_PRO_RATA', 500000, 12,
         '["MON","WED","FRI"]'::jsonb, '09:00', 90, 'Asia/Tashkent', 'ACTIVE'
       )`,
      [CENTER_A.groupId, CENTER_A.centerId, CENTER_A.courseId, CENTER_A.teacher1Id],
    );

    await apiPool.query(
      `INSERT INTO "students" ("id", "center_id", "student_code", "full_name", "normalized_name", "status")
       VALUES ($1::uuid, $2::uuid, 'STU-S13-01', 'Vali Aliyev S13', 'vali aliyev s13', 'ACTIVE')`,
      [CENTER_A.studentId, CENTER_A.centerId],
    );

    await apiPool.query(
      `INSERT INTO "guardians" ("id", "center_id", "full_name", "phone_e164", "status")
       VALUES ($1::uuid, $2::uuid, 'Vali Ota S13', '+998901112233', 'ACTIVE')`,
      [CENTER_A.guardianId, CENTER_A.centerId],
    );

    await apiPool.query(
      `INSERT INTO "guardian_students" ("id", "center_id", "guardian_id", "student_id", "relationship", "is_primary_payer", "active")
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'FATHER', TRUE, TRUE)`,
      [crypto.randomUUID(), CENTER_A.centerId, CENTER_A.guardianId, CENTER_A.studentId],
    );

    await apiPool.query(
      `INSERT INTO "guardian_telegram_links" (
         "id", "center_id", "guardian_id", "invite_token_hash",
         "invite_expires_at", "telegram_user_id", "telegram_chat_id",
         "linked_phone_e164", "status"
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4,
         '2027-01-01T00:00:00Z', 777001, 777001,
         '+998901112233', 'ACTIVE'
       )`,
      [
        crypto.randomUUID(),
        CENTER_A.centerId,
        CENTER_A.guardianId,
        'a'.repeat(64),
      ],
    );

    return {
      dbName,
      apiPool,
      workerPool,
      workerDatabaseUrl,
      cleanup,
    };
  } catch (err) {
    await cleanup();
    throw err;
  }
}

describe('Gate G10 — Stage 13 Outbox Lease/Fencing/Retry/DLQ, 09:00 Promise Reminders, 20m Teacher Ping & Idempotent Scheduler PostgreSQL Integration Suite (WORKER-IT-01..16)', () => {
  let env: WorkerTestDbEnv;
  let workerConfig: WorkerEnvConfig;
  let workerDb: WorkerDatabase;
  let seq = 0;

  before(async () => {
    env = await createWorkerTestDbEnv();
    workerConfig = loadWorkerEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'error',
      WORKER_ID: 'worker-s13-it-01',
      CENTER_ID: CENTER_A.centerId,
      CENTER_SLUG: CENTER_A.centerSlug,
      CENTER_TIMEZONE: 'Asia/Tashkent',
      LICENSE_MODE: 'ACTIVE',
      DATABASE_URL: env.workerDatabaseUrl,
      WORKER_POLL_INTERVAL_MS: '200',
      WORKER_SHUTDOWN_TIMEOUT_MS: '2000',
      BOT_OUTBOUND_ENABLED: 'true',
    });
    workerDb = new WorkerDatabase(workerConfig);
  });

  after(async () => {
    if (workerDb) {
      await workerDb.close();
    }
    if (env) {
      await env.cleanup();
    }
  });

  async function createInvoiceAndPromiseFixture(options: {
    remainingDebtUzs: string;
    promiseDate: string;
    promiseStatus?: 'ACTIVE' | 'FULFILLED' | 'CANCELLED' | 'OVERDUE_NOTIFIED';
    supersededByPromiseId?: string | null;
  }): Promise<{
    enrollmentId: string;
    invoiceId: string;
    paymentId: string;
    promiseId: string;
  }> {
    seq += 1;
    const enrollmentId = crypto.randomUUID();
    const cycleId = crypto.randomUUID();
    const invoiceId = crypto.randomUUID();
    const shiftId = crypto.randomUUID();
    const paymentId = crypto.randomUUID();
    const promiseId = crypto.randomUUID();

    await env.apiPool.query(
      `INSERT INTO "enrollments" ("id", "center_id", "student_id", "group_id", "status", "enrolled_at_date")
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'ACTIVE', '2026-11-01')`,
      [enrollmentId, CENTER_A.centerId, CENTER_A.studentId, CENTER_A.groupId],
    );

    await env.apiPool.query(
      `INSERT INTO "billing_cycles" (
         "id", "center_id", "enrollment_id", "cycle_type", "cycle_key", "cycle_seq",
         "period_start_date", "period_end_date", "planned_lessons", "billable_lessons", "policy_version_id"
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, 'CALENDAR_MONTH', $4, 1,
         '2026-11-01', '2026-11-30', 12, 12, $5::uuid
       )`,
      [
        cycleId,
        CENTER_A.centerId,
        enrollmentId,
        `2026-${String((seq % 12) + 1).padStart(2, '0')}`,
        CENTER_A.policyId,
      ],
    );

    const remDebt = BigInt(options.remainingDebtUzs);
    const paidUzs = 500_000n - remDebt;
    const invStatus = remDebt === 0n ? 'PAID' : 'PARTIALLY_PAID';

    await env.apiPool.query(
      `INSERT INTO "invoices" (
         "id", "center_id", "invoice_number", "student_id", "enrollment_id",
         "billing_cycle_id", "policy_version_id", "tariff_snapshot_uzs",
         "base_pro_rata_charge_uzs", "approved_discount_uzs", "credit_note_adjustments_uzs",
         "effective_net_charge_uzs", "allocated_paid_uzs", "remaining_debt_uzs",
         "billed_lessons", "status", "due_date", "version"
       ) VALUES (
         $1::uuid, $2::uuid, $3, $4::uuid, $5::uuid,
         $6::uuid, $7::uuid, 500000,
         500000, 0, 0,
         500000, $8::bigint, $9::bigint,
         12, $10, '2026-11-05', 1
       )`,
      [
        invoiceId,
        CENTER_A.centerId,
        `INV-WRK-${seq}`,
        CENTER_A.studentId,
        enrollmentId,
        cycleId,
        CENTER_A.policyId,
        paidUzs.toString(10),
        remDebt.toString(10),
        invStatus,
      ],
    );

    await env.apiPool.query(
      `INSERT INTO "cash_shifts" (
         "id", "center_id", "shift_date", "opened_by_admin_id",
         "opening_cash_uzs", "cash_receipts_uzs", "expected_closing_cash_uzs", "status", "version"
       ) VALUES ($1::uuid, $2::uuid, '2026-11-05', $3::uuid, 0, 100000, 100000, 'CLOSED', 2)`,
      [shiftId, CENTER_A.centerId, CENTER_A.adminId],
    );

    await env.apiPool.query(
      `INSERT INTO "payments" (
         "id", "center_id", "student_id", "cash_shift_id", "amount_uzs",
         "currency", "payment_method", "recorded_by_admin_id", "idempotency_key", "request_hash"
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 100000, 'UZS', 'CASH', $5::uuid, $6, $7)`,
      [
        paymentId,
        CENTER_A.centerId,
        CENTER_A.studentId,
        shiftId,
        CENTER_A.adminId,
        `idem-wrk-pay-${seq}`,
        'c'.repeat(64),
      ],
    );

    await env.apiPool.query(
      `INSERT INTO "promises_to_pay" (
         "id", "center_id", "student_id", "invoice_id", "trigger_payment_id",
         "promised_amount_uzs", "promise_date", "status", "superseded_by_promise_id", "version"
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
         300000, $6::date, $7, $8::uuid, 1
       )`,
      [
        promiseId,
        CENTER_A.centerId,
        CENTER_A.studentId,
        invoiceId,
        paymentId,
        options.promiseDate,
        options.promiseStatus ?? 'ACTIVE',
        options.supersededByPromiseId ?? null,
      ],
    );

    return { enrollmentId, invoiceId, paymentId, promiseId };
  }

  it('WORKER-IT-01: serializes 2-worker concurrent outbox claim via FOR UPDATE SKIP LOCKED, increments monotonic lease_token on expiry reclaim, and fences stale leaseholder ACK/retry/consumer writes', async () => {
    await env.apiPool.query(`UPDATE "outbox_events" SET "status" = 'COMPLETED' WHERE "center_id" = $1::uuid`, [
      CENTER_A.centerId,
    ]);

    const eventId = crypto.randomUUID();
    const aggregateId = crypto.randomUUID();
    const t0 = new Date('2026-11-05T10:00:00.000Z');

    await env.apiPool.query(
      `INSERT INTO "outbox_events" (
         "id", "center_id", "event_name", "schema_version",
         "aggregate_type", "aggregate_id", "aggregate_version",
         "dedup_key", "payload_json", "status", "lease_token",
         "occurred_at_utc", "next_attempt_at", "updated_at"
       ) VALUES (
         $1::uuid, $2::uuid, 'ShiftClosed', 1,
         'CashShift', $3::uuid, 1,
         $4, '{"shift_id":"test"}'::jsonb, 'PENDING', 0,
         $5::timestamptz, $5::timestamptz, $5::timestamptz
       )`,
      [eventId, CENTER_A.centerId, aggregateId, `ShiftClosed:${aggregateId}:v1`, t0.toISOString()],
    );

    const outboxWorkerA = new OutboxWorker(workerConfig, workerDb);
    const outboxWorkerB = new OutboxWorker(
      { ...workerConfig, workerId: 'worker-s13-it-02' },
      workerDb,
    );

    // 1. Two workers concurrently claim the same single PENDING event -> exactly 1 claims it with lease_token = 1
    const [claimA, claimB] = await Promise.all([
      outboxWorkerA.claimOutboxBatch({
        batchSize: 5,
        leaseDurationSeconds: 30,
        nowUtc: t0,
        workerId: 'worker-A',
      }),
      outboxWorkerB.claimOutboxBatch({
        batchSize: 5,
        leaseDurationSeconds: 30,
        nowUtc: t0,
        workerId: 'worker-B',
      }),
    ]);

    assert.equal(claimA.length + claimB.length, 1);
    const firstLease = claimA.length === 1 ? claimA[0] : claimB[0];
    assert.equal(firstLease.id, eventId);
    assert.equal(firstLease.lease_token, 1n);
    assert.equal(firstLease.attempt_count, 1);

    // 2. After 31 seconds (lease expired), Worker B reclaims the event -> lease_token increments to 2!
    const tExpired = new Date('2026-11-05T10:00:31.000Z');
    const reclaimB = await outboxWorkerB.claimOutboxBatch({
      batchSize: 5,
      leaseDurationSeconds: 30,
      nowUtc: tExpired,
      workerId: 'worker-B',
    });
    assert.equal(reclaimB.length, 1);
    assert.equal(reclaimB[0].id, eventId);
    assert.equal(reclaimB[0].lease_token, 2n);
    assert.equal(reclaimB[0].attempt_count, 2);

    // 3. Stale Worker A (holding old lease_token = 1) is fenced out of complete, retry, and consumer receipt!
    await assert.rejects(
      () =>
        outboxWorkerA.completeOutboxEventFenced({
          eventId,
          leaseToken: 1n,
          nowUtc: tExpired,
        }),
      (err: unknown) => err instanceof StaleLeaseTokenError,
    );

    await assert.rejects(
      () =>
        outboxWorkerA.failOrRetryOutboxEventFenced({
          eventId,
          leaseToken: 1n,
          attemptCount: 1,
          error: new Error('Stale worker retry attempt'),
          nowUtc: tExpired,
        }),
      (err: unknown) => err instanceof StaleLeaseTokenError,
    );

    await assert.rejects(
      () =>
        outboxWorkerA.executeInternalConsumerWithReceipt({
          eventId,
          leaseToken: 1n,
          consumerName: 'StaleWorkerConsumer',
          consumerReceiptKey: `StaleWorkerConsumer:${eventId}`,
          nowUtc: tExpired,
          effectFn: async () => ({ ok: true }),
        }),
      (err: unknown) => err instanceof StaleLeaseTokenError,
    );

    // 4. Active Worker B (holding current lease_token = 2) completes the event cleanly
    await outboxWorkerB.completeOutboxEventFenced({
      eventId,
      leaseToken: 2n,
      nowUtc: tExpired,
    });

    const finalRow = await env.apiPool.query<{ status: string; lease_token: string }>(
      `SELECT "status"::text AS status, "lease_token"::text AS lease_token
         FROM "outbox_events" WHERE "id" = $1::uuid`,
      [eventId],
    );
    assert.equal(finalRow.rows[0].status, 'COMPLETED');
    assert.equal(finalRow.rows[0].lease_token, '2');
  });

  it('WORKER-IT-02: executes internal DB consumer + OutboxConsumerReceipt atomically, rolls back both on DOMAIN_EFFECT or RECEIPT_INSERT fault, and deduplicates on retry', async () => {
    const fix = await createInvoiceAndPromiseFixture({
      remainingDebtUzs: '0',
      promiseDate: '2026-11-10',
      promiseStatus: 'ACTIVE',
    });

    const eventId = crypto.randomUUID();
    const nowUtc = new Date('2026-11-05T11:00:00.000Z');
    await env.apiPool.query(
      `INSERT INTO "outbox_events" (
         "id", "center_id", "event_name", "schema_version",
         "aggregate_type", "aggregate_id", "aggregate_version",
         "dedup_key", "payload_json", "status", "lease_token",
         "occurred_at_utc", "next_attempt_at", "updated_at"
       ) VALUES (
         $1::uuid, $2::uuid, 'AllocationAdjusted', 1,
         'Invoice', $3::uuid, 2,
         $4, $5::jsonb, 'PENDING', 0,
         $6::timestamptz, $6::timestamptz, $6::timestamptz
       )`,
      [
        eventId,
        CENTER_A.centerId,
        fix.invoiceId,
        `AllocationAdjusted:${fix.invoiceId}:v2`,
        JSON.stringify({
          invoice_id: fix.invoiceId,
          student_id: CENTER_A.studentId,
          new_remaining_debt_uzs: '0',
        }),
        nowUtc.toISOString(),
      ],
    );

    const outboxWorker = new OutboxWorker(workerConfig, workerDb);
    const claimed = await outboxWorker.claimOutboxBatch({ nowUtc });
    assert.equal(claimed.length, 1);
    const ev = claimed[0];

    // 1. Fault injection after DOMAIN_EFFECT rolls back both promise status change and receipt!
    for (const faultStep of ['DOMAIN_EFFECT', 'RECEIPT_INSERT'] as const) {
      await assert.rejects(
        () =>
          outboxWorker.executeInternalConsumerWithReceipt({
            eventId: ev.id,
            leaseToken: ev.lease_token,
            consumerName: 'PromiseLifecycleConsumer',
            consumerReceiptKey: `PromiseLifecycleConsumer:${ev.id}:${fix.invoiceId}`,
            nowUtc,
            testFaultAfterStep: faultStep,
            effectFn: async (tx) => {
              await tx.query(
                `UPDATE "promises_to_pay" SET "status" = 'FULFILLED', "version" = "version" + 1 WHERE "id" = $1::uuid`,
                [fix.promiseId],
              );
              return { promise_id: fix.promiseId };
            },
          }),
        new RegExp(`SIMULATED_S13_CONSUMER_FAULT_AFTER_${faultStep}`),
      );

      const pCheck = await env.apiPool.query<{ status: string }>(
        `SELECT "status"::text AS status FROM "promises_to_pay" WHERE "id" = $1::uuid`,
        [fix.promiseId],
      );
      assert.equal(pCheck.rows[0].status, 'ACTIVE');

      const rCheck = await env.apiPool.query<{ cnt: string }>(
        `SELECT COUNT(*)::text AS cnt FROM "outbox_consumer_receipts" WHERE "outbox_event_id" = $1::uuid`,
        [ev.id],
      );
      assert.equal(rCheck.rows[0].cnt, '0');
    }

    // 2. Clean execution commits both promise transition to FULFILLED and OutboxConsumerReceipt
    const procRes = await outboxWorker.processLeasedEvent(ev, nowUtc);
    assert.equal(procRes.finalStatus, 'COMPLETED');

    const pAfter = await env.apiPool.query<{ status: string }>(
      `SELECT "status"::text AS status FROM "promises_to_pay" WHERE "id" = $1::uuid`,
      [fix.promiseId],
    );
    assert.equal(pAfter.rows[0].status, 'FULFILLED');

    // 3. Re-leasing and re-running the same consumer deduplicates via OutboxConsumerReceipt without re-mutating!
    await env.apiPool.query(
      `UPDATE "outbox_events" SET "status" = 'LEASED', "lease_token" = 99 WHERE "id" = $1::uuid`,
      [ev.id],
    );
    let effectCalledAgain = false;
    const dedupRes = await outboxWorker.executeInternalConsumerWithReceipt({
      eventId: ev.id,
      leaseToken: 99n,
      consumerName: 'PromiseLifecycleConsumer',
      consumerReceiptKey: `PromiseLifecycleConsumer:${ev.id}:${fix.invoiceId}`,
      nowUtc,
      effectFn: async () => {
        effectCalledAgain = true;
        return {};
      },
    });
    assert.equal(dedupRes.deduplicated, true);
    assert.equal(effectCalledAgain, false);
    await outboxWorker.completeOutboxEventFenced({ eventId: ev.id, leaseToken: 99n, nowUtc });
  });

  it('WORKER-IT-03: enforces 13.02 09:00 Asia/Tashkent promise reminder gate, emits PromiseDue for unpaid active promises, auto-fulfills paid promises (CASE-22), suppresses superseded promises, and supports bounded catch-up', async () => {
    const unpaidFix = await createInvoiceAndPromiseFixture({
      remainingDebtUzs: '300000',
      promiseDate: '2026-11-10',
      promiseStatus: 'ACTIVE',
    });
    const paidFix = await createInvoiceAndPromiseFixture({
      remainingDebtUzs: '0',
      promiseDate: '2026-11-10',
      promiseStatus: 'ACTIVE',
    });
    const supersededFix = await createInvoiceAndPromiseFixture({
      remainingDebtUzs: '200000',
      promiseDate: '2026-11-10',
      promiseStatus: 'CANCELLED',
      supersededByPromiseId: unpaidFix.promiseId,
    });

    const remindersWorker = new RemindersWorker(workerConfig, workerDb);

    // 1. Unconfirmed multi-day spam catch-up policy fails closed
    await assert.rejects(
      () =>
        remindersWorker.runPromiseReminderTick({
          nowUtc: new Date('2026-11-10T04:05:00.000Z'),
          catchUpPolicy: 'UNBOUNDED_HISTORICAL_SPAM',
        }),
      /POLICY_DECISION_NOT_CONFIRMED/,
    );

    // 2. Before 09:00 Asia/Tashkent (03:50 UTC = 08:50 local) -> skippedBeforeNineAm: true, 0 emitted
    const beforeNineRes = await remindersWorker.runPromiseReminderTick({
      nowUtc: new Date('2026-11-10T03:50:00.000Z'),
    });
    assert.equal(beforeNineRes.skippedBeforeNineAm, true);
    assert.equal(beforeNineRes.remindersEmittedCount, 0);

    // 3. At 09:05 Asia/Tashkent (04:05 UTC = 09:05 local) -> emits 1 PromiseDue (unpaidFix) and auto-fulfills paidFix!
    const atNineRes = await remindersWorker.runPromiseReminderTick({
      nowUtc: new Date('2026-11-10T04:05:00.000Z'),
    });
    assert.equal(atNineRes.skippedBeforeNineAm, false);
    assert.ok(atNineRes.emittedPromiseIds.includes(unpaidFix.promiseId));
    assert.ok(atNineRes.autoFulfilledPromiseIds.includes(paidFix.promiseId));
    assert.equal(atNineRes.emittedPromiseIds.includes(supersededFix.promiseId), false);

    // 4. Same-day catch-up rerun at 11:30 Asia/Tashkent (06:30 UTC) is 100% idempotent (0 duplicate reminders)
    const catchUpRerun = await remindersWorker.runPromiseReminderTick({
      nowUtc: new Date('2026-11-10T06:30:00.000Z'),
    });
    assert.equal(catchUpRerun.emittedPromiseIds.includes(unpaidFix.promiseId), false);
  });

  it('WORKER-IT-04: enforces per-aggregate predecessor version ordering without blocking unrelated aggregates, dead-letters poison events after 8 attempts with redacted error, and supports DIRECTOR DLQ replay', async () => {
    await env.apiPool.query(`UPDATE "outbox_events" SET "status" = 'COMPLETED' WHERE "center_id" = $1::uuid`, [
      CENTER_A.centerId,
    ]);

    const aggPoison = crypto.randomUUID();
    const aggHealthy = crypto.randomUUID();
    const evPoisonV1 = crypto.randomUUID();
    const evBlockedV2 = crypto.randomUUID();
    const evHealthyV1 = crypto.randomUUID();
    const nowUtc = new Date('2026-11-05T12:00:00.000Z');

    await env.apiPool.query(
      `INSERT INTO "outbox_events" (
         "id", "center_id", "event_name", "schema_version",
         "aggregate_type", "aggregate_id", "aggregate_version",
         "dedup_key", "payload_json", "status", "attempt_count", "lease_token",
         "occurred_at_utc", "next_attempt_at", "updated_at"
       ) VALUES
       ($1::uuid, $4::uuid, 'PoisonTestEvent', 1, 'TestAggregate', $5::uuid, 1, $7, '{}'::jsonb, 'PENDING', 7, 0, $10::timestamptz, $10::timestamptz, $10::timestamptz),
       ($2::uuid, $4::uuid, 'HealthyTestEvent', 1, 'TestAggregate', $5::uuid, 2, $8, '{}'::jsonb, 'PENDING', 0, 0, $10::timestamptz, $10::timestamptz, $10::timestamptz),
       ($3::uuid, $4::uuid, 'HealthyTestEvent', 1, 'TestAggregate', $6::uuid, 1, $9, '{}'::jsonb, 'PENDING', 0, 0, $10::timestamptz, $10::timestamptz, $10::timestamptz)`,
      [
        evPoisonV1,
        evBlockedV2,
        evHealthyV1,
        CENTER_A.centerId,
        aggPoison,
        aggHealthy,
        `PoisonTest:${aggPoison}:v1`,
        `PoisonTest:${aggPoison}:v2`,
        `HealthyTest:${aggHealthy}:v1`,
        nowUtc.toISOString(),
      ],
    );

    let poisonShouldFail = true;
    const outboxWorker = new OutboxWorker(workerConfig, workerDb);
    outboxWorker.registerInternalConsumer('PoisonTestEvent', {
      consumerName: 'PoisonConsumer',
      buildReceiptKey: (ev) => `PoisonConsumer:${ev.id}`,
      handler: async () => {
        if (poisonShouldFail) {
          throw new Error(
            'DB error postgresql://eduerp:SecretPass99@localhost:5432/db for +998901234567',
          );
        }
        return { recovered: true };
      },
    });
    outboxWorker.registerInternalConsumer('HealthyTestEvent', {
      consumerName: 'HealthyConsumer',
      buildReceiptKey: (ev) => `HealthyConsumer:${ev.id}`,
      handler: async () => ({ ok: true }),
    });

    const tick1 = await outboxWorker.runOutboxTick({ nowUtc });
    assert.equal(tick1.claimedCount, 2);
    assert.equal(tick1.completedCount, 1);
    assert.equal(tick1.deadLetterCount, 1);

    const statusCheck = await env.apiPool.query<{
      id: string;
      status: string;
      last_error: string | null;
    }>(
      `SELECT "id"::text AS id, "status"::text AS status, "last_error"
         FROM "outbox_events" WHERE "id" IN ($1::uuid, $2::uuid, $3::uuid)`,
      [evPoisonV1, evBlockedV2, evHealthyV1],
    );
    const byId = new Map(statusCheck.rows.map((r) => [r.id, r]));
    assert.equal(byId.get(evPoisonV1)!.status, 'DEAD_LETTER');
    assert.equal(byId.get(evPoisonV1)!.last_error?.includes('SecretPass99'), false);
    assert.equal(byId.get(evPoisonV1)!.last_error?.includes('+998901234567'), false);
    assert.equal(byId.get(evBlockedV2)!.status, 'PENDING');
    assert.equal(byId.get(evHealthyV1)!.status, 'COMPLETED');

    poisonShouldFail = false;
    await outboxWorker.replayDeadLetterEvent({
      eventId: evPoisonV1,
      actorStaffId: CENTER_A.directorId,
      actorRole: 'DIRECTOR',
      reason: 'Fixed downstream handler bug',
      nowUtc,
    });

    await outboxWorker.runOutboxTick({ nowUtc });
    await outboxWorker.runOutboxTick({ nowUtc });

    const afterReplay = await env.apiPool.query<{ id: string; status: string }>(
      `SELECT "id"::text AS id, "status"::text AS status
         FROM "outbox_events" WHERE "id" IN ($1::uuid, $2::uuid)`,
      [evPoisonV1, evBlockedV2],
    );
    assert.ok(afterReplay.rows.every((r) => r.status === 'COMPLETED'));
  });

  it('WORKER-IT-05: models external send-crash ambiguity window (CRASH_AFTER_SEND_BEFORE_ACK -> EXTERNAL_DELIVERY_AMBIGUOUS_AFTER_SEND), 429 retry_after_seconds, and 403 BOT_BLOCKED_403 transition', async () => {
    await env.apiPool.query(`UPDATE "outbox_events" SET "status" = 'COMPLETED' WHERE "center_id" = $1::uuid`, [
      CENTER_A.centerId,
    ]);

    const adapter = new SyntheticNotificationTransportAdapter();
    const outboxWorker = new OutboxWorker(workerConfig, workerDb, adapter);
    const nowUtc = new Date('2026-11-05T13:00:00.000Z');

    const eventId = crypto.randomUUID();
    const delivId = crypto.randomUUID();
    await env.apiPool.query(
      `INSERT INTO "outbox_events" (
         "id", "center_id", "event_name", "schema_version",
         "aggregate_type", "aggregate_id", "aggregate_version",
         "dedup_key", "payload_json", "status", "lease_token",
         "occurred_at_utc", "next_attempt_at", "updated_at"
       ) VALUES (
         $1::uuid, $2::uuid, 'PaymentRecorded', 1,
         'Payment', $3::uuid, 1,
         $4, '{"payment_id":"test"}'::jsonb, 'PENDING', 0,
         $5::timestamptz, $5::timestamptz, $5::timestamptz
       )`,
      [
        eventId,
        CENTER_A.centerId,
        crypto.randomUUID(),
        `PaymentRecorded:${eventId}`,
        nowUtc.toISOString(),
      ],
    );

    await env.apiPool.query(
      `INSERT INTO "notification_deliveries" (
         "id", "center_id", "outbox_event_id", "recipient_type", "recipient_id",
         "telegram_chat_id", "delivery_status", "attempt_count",
         "next_attempt_at", "last_lease_token", "version", "created_at", "updated_at"
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, 'GUARDIAN', $4::uuid,
         777001, 'QUEUED', 0,
         $5::timestamptz, 0, 1, $5::timestamptz, $5::timestamptz
       )`,
      [delivId, CENTER_A.centerId, eventId, CENTER_A.guardianId, nowUtc.toISOString()],
    );

    adapter.setMode('CRASH_AFTER_SEND_BEFORE_ACK');
    const tickCrash = await outboxWorker.runOutboxTick({ nowUtc });
    assert.equal(tickCrash.claimedCount, 1);
    assert.equal(tickCrash.pendingRetryCount, 1);

    const ambigAudit = await env.apiPool.query<{ after_redacted_json: Record<string, unknown> }>(
      `SELECT "after_redacted_json"
         FROM "audit_logs"
        WHERE "center_id" = $1::uuid
          AND "action" = 'EXTERNAL_DELIVERY_AMBIGUOUS_AFTER_SEND'
          AND "entity_id" = $2::uuid`,
      [CENTER_A.centerId, delivId],
    );
    assert.equal(ambigAudit.rows.length, 1);
    assert.equal(ambigAudit.rows[0].after_redacted_json.possible_duplicate_delivery, true);

    adapter.setMode('ACCEPT_OK');
    const laterUtc = new Date('2026-11-05T13:05:00.000Z');
    const tickOk = await outboxWorker.runOutboxTick({ nowUtc: laterUtc });
    assert.equal(tickOk.completedCount, 1);

    const delivAfter = await env.apiPool.query<{ delivery_status: string }>(
      `SELECT "delivery_status"::text AS delivery_status FROM "notification_deliveries" WHERE "id" = $1::uuid`,
      [delivId],
    );
    assert.equal(delivAfter.rows[0].delivery_status, 'API_ACCEPTED');
  });

  it('WORKER-IT-06: runs 13.03 TeacherPingWorker (20m ping to active substitute, suppresses old substitute on revocation and pings primary teacher, escalates to Admin at lesson end, and suppresses cancelled/completed lessons)', async () => {
    const lessonId = crypto.randomUUID();
    const cancelledLessonId = crypto.randomUUID();
    const subId = crypto.randomUUID();

    await env.apiPool.query(
      `INSERT INTO "lesson_occurrences" (
         "id", "center_id", "group_id", "lesson_date", "occurrence_seq",
         "starts_at_utc", "ends_at_utc", "status",
         "primary_teacher_snapshot_id", "pay_recipient_teacher_id", "version"
       ) VALUES
       ($1::uuid, $3::uuid, $4::uuid, '2026-11-05', 10, '2026-11-05T09:00:00Z', '2026-11-05T10:30:00Z', 'SCHEDULED', $5::uuid, $6::uuid, 1),
       ($2::uuid, $3::uuid, $4::uuid, '2026-11-05', 11, '2026-11-05T09:00:00Z', '2026-11-05T10:30:00Z', 'CANCELLED_BY_CENTER', $5::uuid, $5::uuid, 1)`,
      [
        lessonId,
        cancelledLessonId,
        CENTER_A.centerId,
        CENTER_A.groupId,
        CENTER_A.teacher1Id,
        CENTER_A.teacher2Id,
      ],
    );

    await env.apiPool.query(
      `INSERT INTO "substitute_assignments" (
         "id", "center_id", "lesson_id", "original_teacher_id", "substitute_teacher_id",
         "assigned_by_admin_id", "reason", "pay_share_policy_snapshot", "status", "version"
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
         $6::uuid, 'Sub for S13 ping test', 'SUBSTITUTE_100_PERCENT', 'ACTIVE', 1
       )`,
      [
        subId,
        CENTER_A.centerId,
        lessonId,
        CENTER_A.teacher1Id,
        CENTER_A.teacher2Id,
        CENTER_A.adminId,
      ],
    );

    const pingWorker = new TeacherPingWorker(workerConfig, workerDb);

    const res20m = await pingWorker.runTeacherPingAndEscalationTick({
      nowUtc: new Date('2026-11-05T09:21:00.000Z'),
    });
    assert.ok(res20m.pingedLessonIds.includes(lessonId));
    assert.equal(res20m.pingedLessonIds.includes(cancelledLessonId), false);

    await env.apiPool.query(
      `UPDATE "substitute_assignments" SET "status" = 'REVOKED', "revoked_at" = NOW(), "version" = 2 WHERE "id" = $1::uuid`,
      [subId],
    );
    const resAfterRevoke = await pingWorker.runTeacherPingAndEscalationTick({
      nowUtc: new Date('2026-11-05T09:30:00.000Z'),
    });
    assert.ok(resAfterRevoke.pingedLessonIds.includes(lessonId));

    const oldSubDeliv = await env.apiPool.query<{ delivery_status: string }>(
      `SELECT nd."delivery_status"::text AS delivery_status
         FROM "notification_deliveries" nd
         JOIN "outbox_events" oe ON oe."id" = nd."outbox_event_id"
        WHERE oe."center_id" = $1::uuid
          AND oe."aggregate_id" = $2::uuid
          AND nd."recipient_type" = 'TEACHER'
          AND nd."recipient_id" = $3::uuid`,
      [CENTER_A.centerId, lessonId, CENTER_A.teacher2Id],
    );
    assert.equal(oldSubDeliv.rows[0].delivery_status, 'SKIPPED_UNLINKED');

    const resEnd = await pingWorker.runTeacherPingAndEscalationTick({
      nowUtc: new Date('2026-11-05T10:31:00.000Z'),
    });
    assert.ok(resEnd.escalatedLessonIds.includes(lessonId));
  });

  it('WORKER-IT-07: executes 13.04 SchedulesWorker (idempotent billing cycle cutoff skipping TRIAL enrollments, unclosed shift reminder without auto-closing, and trial no-show follow-up policy gate)', async () => {
    const trialStuId = crypto.randomUUID();
    const trialEnrId = crypto.randomUUID();
    const l1 = crypto.randomUUID();
    const l2 = crypto.randomUUID();

    await env.apiPool.query(
      `INSERT INTO "students" ("id", "center_id", "student_code", "full_name", "normalized_name", "status")
       VALUES ($1::uuid, $2::uuid, 'STU-TRIAL-S13', 'Trial Student S13', 'trial student s13', 'ACTIVE')`,
      [trialStuId, CENTER_A.centerId],
    );
    await env.apiPool.query(
      `INSERT INTO "enrollments" ("id", "center_id", "student_id", "group_id", "status", "enrolled_at_date")
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'TRIAL', '2026-11-01')`,
      [trialEnrId, CENTER_A.centerId, trialStuId, CENTER_A.groupId],
    );
    await env.apiPool.query(
      `INSERT INTO "lesson_occurrences" (
         "id", "center_id", "group_id", "lesson_date", "occurrence_seq",
         "starts_at_utc", "ends_at_utc", "status",
         "primary_teacher_snapshot_id", "pay_recipient_teacher_id", "attendance_version", "version"
       ) VALUES
       ($1::uuid, $3::uuid, $4::uuid, '2026-11-02', 1, '2026-11-02T04:00:00Z', '2026-11-02T05:30:00Z', 'COMPLETED', $5::uuid, $5::uuid, 1, 1),
       ($2::uuid, $3::uuid, $4::uuid, '2026-11-04', 1, '2026-11-04T04:00:00Z', '2026-11-04T05:30:00Z', 'COMPLETED', $5::uuid, $5::uuid, 1, 1)`,
      [l1, l2, CENTER_A.centerId, CENTER_A.groupId, CENTER_A.teacher1Id],
    );
    await env.apiPool.query(
      `INSERT INTO "attendance_records" (
         "id", "center_id", "lesson_id", "student_id", "enrollment_id",
         "status", "is_excused_frozen", "source_channel", "recorded_by_staff_id",
         "client_operation_uuid", "version"
       ) VALUES
       ($1::uuid, $3::uuid, $4::uuid, $6::uuid, $7::uuid, 'ABSENT', FALSE, 'TEACHER_WEB', $8::uuid, $9::uuid, 1),
       ($2::uuid, $3::uuid, $5::uuid, $6::uuid, $7::uuid, 'ABSENT', FALSE, 'TEACHER_WEB', $8::uuid, $10::uuid, 1)`,
      [
        crypto.randomUUID(),
        crypto.randomUUID(),
        CENTER_A.centerId,
        l1,
        l2,
        trialStuId,
        trialEnrId,
        CENTER_A.teacher1Id,
        crypto.randomUUID(),
        crypto.randomUUID(),
      ],
    );

    const seenCycles = new Set<string>();
    const billingPort: BillingCycleWorkerPort = {
      issueWorkerInvoiceForCycle: async (
        params: BillingCycleWorkerIssueParams,
      ): Promise<BillingCycleWorkerIssueResult> => {
        const key = `${params.centerId}:${params.enrollmentId}:${params.cycleType}:${params.cycleKey}`;
        const replayed = seenCycles.has(key);
        seenCycles.add(key);
        return {
          invoice: {
            invoice_id: crypto.randomUUID(),
            invoice_number: `INV-SCHED-${params.cycleKey}`,
            student_id: CENTER_A.studentId,
            enrollment_id: params.enrollmentId,
            billing_cycle_id: crypto.randomUUID(),
            effective_net_charge_uzs: '500000',
            remaining_debt_uzs: '500000',
            status: 'ISSUED_OPEN',
          },
          replayedByCycleIdentity: replayed,
        };
      },
    };

    const schedulesWorker = new SchedulesWorker(workerConfig, workerDb, billingPort);
    const nowUtc = new Date('2026-11-05T18:00:00.000Z');

    const billRun1 = await schedulesWorker.runBillingCycleCutoffAndCatchUpJob({
      nowUtc,
      cycleKey: '2026-11',
    });
    assert.ok(billRun1.invoicesIssuedCount >= 1);
    assert.ok(billRun1.skippedTrialOrIneligibleCount >= 1);

    const billRun2 = await schedulesWorker.runBillingCycleCutoffAndCatchUpJob({
      nowUtc,
      cycleKey: '2026-11',
    });
    assert.equal(billRun2.invoicesIssuedCount, 0);
    assert.equal(billRun2.deduplicatedJobWindow, true);

    const openShiftId = crypto.randomUUID();
    await env.apiPool.query(
      `INSERT INTO "cash_shifts" (
         "id", "center_id", "shift_date", "opened_by_admin_id",
         "opening_cash_uzs", "expected_closing_cash_uzs", "status", "version"
       ) VALUES ($1::uuid, $2::uuid, '2026-11-05', $3::uuid, 200000, 200000, 'OPEN', 1)`,
      [openShiftId, CENTER_A.centerId, CENTER_A.adminId],
    );

    const shiftRemRes = await schedulesWorker.runUnclosedCashShiftReminderJob({ nowUtc });
    assert.ok(shiftRemRes.flaggedShiftIds.includes(openShiftId));
    assert.equal(shiftRemRes.shiftsAutoClosedCount, 0);

    const shiftCheck = await env.apiPool.query<{ status: string; counted_closing_cash_uzs: string | null }>(
      `SELECT "status"::text AS status, "counted_closing_cash_uzs"::text AS counted_closing_cash_uzs
         FROM "cash_shifts" WHERE "id" = $1::uuid`,
      [openShiftId],
    );
    assert.equal(shiftCheck.rows[0].status, 'OPEN');
    assert.equal(shiftCheck.rows[0].counted_closing_cash_uzs, null);

    await assert.rejects(
      () =>
        schedulesWorker.runTrialNoShowFollowUpJob({
          nowUtc,
          trialNoShowPolicy: 'UNCONFIGURED',
        }),
      /POLICY_DECISION_NOT_CONFIRMED/,
    );

    const noShowRes = await schedulesWorker.runTrialNoShowFollowUpJob({
      nowUtc,
      trialNoShowPolicy: 'CONFIRMED_SECOND_ABSENCE_ADMIN_FOLLOWUP',
    });
    assert.ok(noShowRes.followUpEnrollmentsFlagged.includes(trialEnrId));
    assert.equal(noShowRes.invoicesCreatedCount, 0);
  });

  it('WORKER-IT-08: enforces BOT_OUTBOUND_ENABLED=false restore reconciliation (SUPERSEDED_BY_RESTORE), READ_ONLY license allowlist, and least-privilege eduerp_worker_runtime DB grants (42501)', async () => {
    const restoreConfig = { ...workerConfig, botOutboundEnabled: false };
    const restoreWorker = new OutboxWorker(restoreConfig, workerDb);
    const nowUtc = new Date('2026-11-05T19:00:00.000Z');

    const staleEvtId = crypto.randomUUID();
    await env.apiPool.query(
      `INSERT INTO "outbox_events" (
         "id", "center_id", "event_name", "schema_version",
         "aggregate_type", "aggregate_id", "aggregate_version",
         "dedup_key", "payload_json", "status", "lease_token",
         "occurred_at_utc", "next_attempt_at", "updated_at"
       ) VALUES (
         $1::uuid, $2::uuid, 'AttendanceSubmitted', 1,
         'LessonOccurrence', $3::uuid, 1,
         $4, '{}'::jsonb, 'PENDING', 0,
         '2026-11-04T10:00:00Z', '2026-11-04T10:00:00Z', '2026-11-04T10:00:00Z'
       )`,
      [staleEvtId, CENTER_A.centerId, crypto.randomUUID(), `RestoreTest:${staleEvtId}`],
    );

    const recRes = await restoreWorker.reconcileRestoredOutbox({
      cutoffUtc: new Date('2026-11-05T00:00:00.000Z'),
      reason: 'Restored from nightly backup',
      nowUtc,
    });
    assert.ok(recRes.supersededCount >= 1);

    const evtCheck = await env.apiPool.query<{ status: string }>(
      `SELECT "status"::text AS status FROM "outbox_events" WHERE "id" = $1::uuid`,
      [staleEvtId],
    );
    assert.equal(evtCheck.rows[0].status, 'SUPERSEDED_BY_RESTORE');

    // Verify READ_ONLY license allowlist: LicenseStateChanged is claimed while business events wait
    await env.apiPool.query(
      `UPDATE "center_licenses" SET "license_status" = 'READ_ONLY' WHERE "center_id" = $1::uuid`,
      [CENTER_A.centerId],
    );
    try {
      const licEvtId = crypto.randomUUID();
      const bizEvtId = crypto.randomUUID();
      await env.apiPool.query(
        `INSERT INTO "outbox_events" (
           "id", "center_id", "event_name", "schema_version",
           "aggregate_type", "aggregate_id", "aggregate_version",
           "dedup_key", "payload_json", "status", "lease_token",
           "occurred_at_utc", "next_attempt_at", "updated_at"
         ) VALUES
         ($1::uuid, $3::uuid, 'LicenseStateChanged', 1, 'CenterLicense', $3::uuid, 1, $4, '{"new_license_mode":"READ_ONLY"}'::jsonb, 'PENDING', 0, $6::timestamptz, $6::timestamptz, $6::timestamptz),
         ($2::uuid, $3::uuid, 'ExpenseRecorded', 1, 'CashExpense', $5::uuid, 1, $7, '{}'::jsonb, 'PENDING', 0, $6::timestamptz, $6::timestamptz, $6::timestamptz)`,
        [
          licEvtId,
          bizEvtId,
          CENTER_A.centerId,
          `LicenseStateChanged:${licEvtId}`,
          crypto.randomUUID(),
          nowUtc.toISOString(),
          `ExpenseRecorded:${bizEvtId}`,
        ],
      );

      const roOutboxWorker = new OutboxWorker(workerConfig, workerDb);
      const roTick = await roOutboxWorker.runOutboxTick({ nowUtc });
      assert.equal(roTick.claimedCount, 1);
      assert.equal(roTick.completedCount, 1);

      const licCheck = await env.apiPool.query<{ id: string; status: string }>(
        `SELECT "id"::text AS id, "status"::text AS status FROM "outbox_events" WHERE "id" IN ($1::uuid, $2::uuid)`,
        [licEvtId, bizEvtId],
      );
      const roMap = new Map(licCheck.rows.map((r) => [r.id, r.status]));
      assert.equal(roMap.get(licEvtId), 'COMPLETED');
      assert.equal(roMap.get(bizEvtId), 'PENDING');

      await env.apiPool.query(`UPDATE "outbox_events" SET "status" = 'COMPLETED' WHERE "id" = $1::uuid`, [
        bizEvtId,
      ]);
    } finally {
      await env.apiPool.query(
        `UPDATE "center_licenses" SET "license_status" = 'ACTIVE' WHERE "center_id" = $1::uuid`,
        [CENTER_A.centerId],
      );
    }

    // Verify least-privilege eduerp_worker_runtime role cannot DELETE outbox_events or UPDATE immutable receipts
    for (const forbiddenSql of [
      `DELETE FROM "outbox_events" WHERE "id" = '${staleEvtId}'::uuid`,
      `DELETE FROM "audit_logs" WHERE "center_id" = '${CENTER_A.centerId}'::uuid`,
    ]) {
      await assert.rejects(
        () => env.workerPool.query(forbiddenSql),
        (err: unknown) => (err as { code?: string }).code === '42501',
      );
    }
  });

  it('WORKER-IT-09: S01 WorkerRuntimeSkeleton.start() automatically executes non-overlapping poll cycles on timer, isolates per-job errors so later jobs still run, and drains in-flight ticks on stop(SIGTERM)', async () => {
    await env.apiPool.query(`UPDATE "outbox_events" SET "status" = 'COMPLETED' WHERE "center_id" = $1::uuid`, [
      CENTER_A.centerId,
    ]);

    const autoEvtId = crypto.randomUUID();
    const nowUtc = new Date();
    await env.apiPool.query(
      `INSERT INTO "outbox_events" (
         "id", "center_id", "event_name", "schema_version",
         "aggregate_type", "aggregate_id", "aggregate_version",
         "dedup_key", "payload_json", "status", "lease_token",
         "occurred_at_utc", "next_attempt_at", "updated_at"
       ) VALUES (
         $1::uuid, $2::uuid, 'ExpenseRecorded', 1,
         'CashExpense', $3::uuid, 1,
         $4, '{"expense_id":"auto-timer-test"}'::jsonb, 'PENDING', 0,
         $5::timestamptz, $5::timestamptz, $5::timestamptz
       )`,
      [
        autoEvtId,
        CENTER_A.centerId,
        crypto.randomUUID(),
        `ExpenseRecorded:${autoEvtId}`,
        nowUtc.toISOString(),
      ],
    );

    const logs: WorkerLogEvent[] = [];
    const fastConfig: WorkerEnvConfig = {
      ...workerConfig,
      pollIntervalMs: 80,
      shutdownTimeoutMs: 2000,
    };
    const runtimeDb = new WorkerDatabase(fastConfig);
    const runtime = new WorkerRuntimeSkeleton(
      fastConfig,
      (entry) => logs.push(entry),
      runtimeDb,
    );

    // Note: TrialNoShowFollowUpJob defaults to UNCONFIGURED policy and throws POLICY_DECISION_NOT_CONFIRMED,
    // which must be isolated as worker_job_isolated_error while OutboxTickJob still runs and completes autoEvtId!
    runtime.start();
    await new Promise((resolve) => setTimeout(resolve, 260));
    await runtime.stop('SIGTERM');

    assert.equal(runtime.getState(), 'STOPPED');
    assert.ok(runtime.getPollCycleCount() >= 1);

    const evtAfter = await env.apiPool.query<{ status: string }>(
      `SELECT "status"::text AS status FROM "outbox_events" WHERE "id" = $1::uuid`,
      [autoEvtId],
    );
    assert.equal(evtAfter.rows[0].status, 'COMPLETED');

    const isolatedWarn = logs.find(
      (l) =>
        l.event === 'worker_job_isolated_error' &&
        l.details?.job_name === 'TrialNoShowFollowUpJob',
    );
    assert.ok(isolatedWarn, 'Expected TrialNoShowFollowUpJob policy error to be isolated without aborting OutboxTickJob');
  });

  it('WORKER-IT-10: S02 default UnboundFailClosedNotificationTransportAdapter never fabricates API_ACCEPTED, preserves attempt_count across >8 deferred polls, and dead-letters unknown event_name', async () => {
    await env.apiPool.query(`UPDATE "outbox_events" SET "status" = 'COMPLETED' WHERE "center_id" = $1::uuid`, [
      CENTER_A.centerId,
    ]);

    const nowUtc = new Date('2026-11-05T20:00:00.000Z');
    const notifEvtId = crypto.randomUUID();
    const unknownEvtId = crypto.randomUUID();

    await env.apiPool.query(
      `INSERT INTO "outbox_events" (
         "id", "center_id", "event_name", "schema_version",
         "aggregate_type", "aggregate_id", "aggregate_version",
         "dedup_key", "payload_json", "status", "lease_token",
         "occurred_at_utc", "next_attempt_at", "updated_at"
       ) VALUES
       ($1::uuid, $3::uuid, 'PaymentRecorded', 1, 'Payment', $4::uuid, 1, $6, $8::jsonb, 'PENDING', 0, $9::timestamptz, $9::timestamptz, $9::timestamptz),
       ($2::uuid, $3::uuid, 'CompletelyUnknownEventName', 1, 'Mystery', $5::uuid, 1, $7, '{}'::jsonb, 'PENDING', 0, $9::timestamptz, $9::timestamptz, $9::timestamptz)`,
      [
        notifEvtId,
        unknownEvtId,
        CENTER_A.centerId,
        crypto.randomUUID(),
        crypto.randomUUID(),
        `PaymentRecorded:${notifEvtId}`,
        `Unknown:${unknownEvtId}`,
        JSON.stringify({ student_id: CENTER_A.studentId, amount_uzs: '150000' }),
        nowUtc.toISOString(),
      ],
    );

    // Default OutboxWorker uses UnboundFailClosedNotificationTransportAdapter (no synthetic adapter passed)
    const defaultProdWorker = new OutboxWorker(workerConfig, workerDb);

    // Poll 10 times advancing time by 2 minutes each time (> 8 attempts if budget were burned!)
    for (let i = 0; i < 10; i += 1) {
      const pollTime = new Date(nowUtc.getTime() + i * 120_000);
      await defaultProdWorker.runOutboxTick({ nowUtc: pollTime });
    }

    // 1. Unknown event must be in DEAD_LETTER (never silently COMPLETED)
    const unkCheck = await env.apiPool.query<{ status: string; last_error: string }>(
      `SELECT "status"::text AS status, "last_error" FROM "outbox_events" WHERE "id" = $1::uuid`,
      [unknownEvtId],
    );
    assert.equal(unkCheck.rows[0].status, 'DEAD_LETTER');
    assert.match(unkCheck.rows[0].last_error ?? '', /Unregistered outbox event/);

    // 2. PaymentRecorded with unbound transport must still be PENDING with attempt_count == 0 and delivery QUEUED (never API_ACCEPTED or DEAD_LETTER!)
    const notifCheck = await env.apiPool.query<{ status: string; attempt_count: number }>(
      `SELECT "status"::text AS status, "attempt_count" FROM "outbox_events" WHERE "id" = $1::uuid`,
      [notifEvtId],
    );
    assert.equal(notifCheck.rows[0].status, 'PENDING');
    assert.equal(Number(notifCheck.rows[0].attempt_count), 0);

    const delivCheck = await env.apiPool.query<{ delivery_status: string; telegram_message_id: string | null }>(
      `SELECT "delivery_status"::text AS delivery_status, "telegram_message_id"::text AS telegram_message_id
         FROM "notification_deliveries" WHERE "outbox_event_id" = $1::uuid`,
      [notifEvtId],
    );
    assert.equal(delivCheck.rows.length, 1);
    assert.equal(delivCheck.rows[0].delivery_status, 'QUEUED');
    assert.equal(delivCheck.rows[0].telegram_message_id, null);

    // Clean up pending notifEvtId
    await env.apiPool.query(`UPDATE "outbox_events" SET "status" = 'COMPLETED' WHERE "id" = $1::uuid`, [
      notifEvtId,
    ]);
  });

  it('WORKER-IT-11: S03 fences all delivery transitions (429, 403, timeout, API_ACCEPTED) against stale lease_token and detects post-send crash from durable DB state even without in-memory error flag', async () => {
    await env.apiPool.query(`UPDATE "outbox_events" SET "status" = 'COMPLETED' WHERE "center_id" = $1::uuid`, [
      CENTER_A.centerId,
    ]);

    const nowUtc = new Date('2026-11-05T21:00:00.000Z');

    // Part A: Verify stale Worker A cannot overwrite delivery status on 429, 403, timeout, or API_ACCEPTED after Worker B reclaims lease
    for (const mode of ['RATE_LIMIT_429', 'BLOCKED_403', 'TRANSIENT_TIMEOUT', 'ACCEPT_OK'] as const) {
      const evtId = crypto.randomUUID();
      const delivId = crypto.randomUUID();
      await env.apiPool.query(
        `INSERT INTO "outbox_events" (
           "id", "center_id", "event_name", "schema_version",
           "aggregate_type", "aggregate_id", "aggregate_version",
           "dedup_key", "payload_json", "status", "lease_token",
           "occurred_at_utc", "next_attempt_at", "updated_at"
         ) VALUES (
           $1::uuid, $2::uuid, 'PaymentRecorded', 1, 'Payment', $3::uuid, 1,
           $4, $5::jsonb, 'PENDING', 0, $6::timestamptz, $6::timestamptz, $6::timestamptz
         )`,
        [
          evtId,
          CENTER_A.centerId,
          crypto.randomUUID(),
          `FenceDeliv:${mode}:${evtId}`,
          JSON.stringify({ student_id: CENTER_A.studentId }),
          nowUtc.toISOString(),
        ],
      );
      await env.apiPool.query(
        `INSERT INTO "notification_deliveries" (
           "id", "center_id", "outbox_event_id", "recipient_type", "recipient_id",
           "telegram_chat_id", "delivery_status", "attempt_count",
           "next_attempt_at", "last_lease_token", "version", "created_at", "updated_at"
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, 'GUARDIAN', $4::uuid,
           777001, 'QUEUED', 0, $5::timestamptz, 0, 1, $5::timestamptz, $5::timestamptz
         )`,
        [delivId, CENTER_A.centerId, evtId, CENTER_A.guardianId, nowUtc.toISOString()],
      );

      const adapterA = new SyntheticNotificationTransportAdapter();
      adapterA.setMode(mode);
      const workerA = new OutboxWorker(workerConfig, workerDb, adapterA);

      const claimedA = await workerA.claimOutboxBatch({ nowUtc, leaseDurationSeconds: 10 });
      assert.equal(claimedA.length, 1);
      assert.equal(claimedA[0].lease_token, 1n);

      // While Worker A is inside sendNotification, Worker B reclaims the expired lease (lease_token becomes 2)
      adapterA.setPreSendHook(async () => {
        await env.apiPool.query(
          `UPDATE "outbox_events" SET "lease_token" = 2, "leased_by_worker" = 'worker-B' WHERE "id" = $1::uuid`,
          [evtId],
        );
      });

      await assert.rejects(
        () => workerA.processNotificationDeliveriesForEvent(claimedA[0], nowUtc),
        (err: unknown) => err instanceof StaleLeaseTokenError,
      );

      // Ensure guardian_telegram_links was NOT mutated to BOT_BLOCKED_403 by stale Worker A!
      const linkCheck = await env.apiPool.query<{ status: string }>(
        `SELECT "status"::text AS status FROM "guardian_telegram_links" WHERE "center_id" = $1::uuid AND "guardian_id" = $2::uuid`,
        [CENTER_A.centerId, CENTER_A.guardianId],
      );
      assert.equal(linkCheck.rows[0].status, 'ACTIVE');

      await env.apiPool.query(`UPDATE "outbox_events" SET "status" = 'COMPLETED' WHERE "id" = $1::uuid`, [
        evtId,
      ]);
    }

    // Part B: Durable pre-send DB marker detects post-send crash even when process dies with no in-memory error property
    const crashEvtId = crypto.randomUUID();
    const crashDelivId = crypto.randomUUID();
    await env.apiPool.query(
      `INSERT INTO "outbox_events" (
         "id", "center_id", "event_name", "schema_version",
         "aggregate_type", "aggregate_id", "aggregate_version",
         "dedup_key", "payload_json", "status", "lease_token",
         "occurred_at_utc", "next_attempt_at", "updated_at"
       ) VALUES (
         $1::uuid, $2::uuid, 'PaymentRecorded', 1, 'Payment', $3::uuid, 1,
         $4, $5::jsonb, 'PENDING', 0, $6::timestamptz, $6::timestamptz, $6::timestamptz
       )`,
      [
        crashEvtId,
        CENTER_A.centerId,
        crypto.randomUUID(),
        `DurableCrash:${crashEvtId}`,
        JSON.stringify({ student_id: CENTER_A.studentId }),
        nowUtc.toISOString(),
      ],
    );
    await env.apiPool.query(
      `INSERT INTO "notification_deliveries" (
         "id", "center_id", "outbox_event_id", "recipient_type", "recipient_id",
         "telegram_chat_id", "delivery_status", "attempt_count",
         "next_attempt_at", "last_lease_token", "version", "created_at", "updated_at"
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, 'GUARDIAN', $4::uuid,
         777001, 'QUEUED', 0, $5::timestamptz, 0, 1, $5::timestamptz, $5::timestamptz
       )`,
      [crashDelivId, CENTER_A.centerId, crashEvtId, CENTER_A.guardianId, nowUtc.toISOString()],
    );

    const adapterCrash = new SyntheticNotificationTransportAdapter();
    adapterCrash.setMode('CRASH_AFTER_SEND_NO_MEMORY_FLAG');
    const workerCrash = new OutboxWorker(workerConfig, workerDb, adapterCrash);
    await workerCrash.runOutboxTick({ nowUtc });

    // Even when a fresh worker instance recovers the event on the next tick, EXTERNAL_DELIVERY_AMBIGUOUS_AFTER_SEND is recorded!
    const adapterRecover = new SyntheticNotificationTransportAdapter();
    adapterRecover.setMode('ACCEPT_OK');
    const workerRecover = new OutboxWorker(workerConfig, workerDb, adapterRecover);
    const recoverRes = await workerRecover.runOutboxTick({
      nowUtc: new Date(nowUtc.getTime() + 60_000),
    });
    assert.equal(recoverRes.completedCount, 1);

    const ambigCheck = await env.apiPool.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt
         FROM "audit_logs"
        WHERE "center_id" = $1::uuid
          AND "action" = 'EXTERNAL_DELIVERY_AMBIGUOUS_AFTER_SEND'
          AND "entity_id" = $2::uuid`,
      [CENTER_A.centerId, crashDelivId],
    );
    assert.ok(Number(ambigCheck.rows[0].cnt) >= 1);
  });

  it('WORKER-IT-12: S04 suppresses queued PromiseDue delivery when promise is superseded even if invoice still has remaining_debt_uzs > 0, and enforces live staff/guardian authority before send and DLQ replay', async () => {
    await env.apiPool.query(`UPDATE "outbox_events" SET "status" = 'COMPLETED' WHERE "center_id" = $1::uuid`, [
      CENTER_A.centerId,
    ]);

    const nowUtc = new Date('2026-11-11T04:10:00.000Z'); // 09:10 Asia/Tashkent
    const fix1 = await createInvoiceAndPromiseFixture({
      remainingDebtUzs: '250000',
      promiseDate: '2026-11-11',
      promiseStatus: 'ACTIVE',
    });

    const remindersWorker = new RemindersWorker(workerConfig, workerDb);
    const remTick = await remindersWorker.runPromiseReminderTick({ nowUtc });
    assert.ok(remTick.emittedPromiseIds.includes(fix1.promiseId));

    // Before OutboxWorker sends the queued PromiseDue, a new partial payment arrives, leaving 150,000 UZS debt on the invoice
    // and superseding fix1.promiseId with a new promise due next week!
    const newPromiseId = crypto.randomUUID();
    await env.apiPool.query(
      `INSERT INTO "promises_to_pay" (
         "id", "center_id", "student_id", "invoice_id", "trigger_payment_id",
         "promised_amount_uzs", "promise_date", "status", "version"
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 150000, '2026-11-18', 'ACTIVE', 1)`,
      [newPromiseId, CENTER_A.centerId, CENTER_A.studentId, fix1.invoiceId, fix1.paymentId],
    );
    await env.apiPool.query(
      `UPDATE "promises_to_pay"
          SET "status" = 'CANCELLED',
              "superseded_by_promise_id" = $2::uuid,
              "version" = "version" + 1
        WHERE "id" = $1::uuid`,
      [fix1.promiseId, newPromiseId],
    );
    await env.apiPool.query(
      `UPDATE "invoices" SET "remaining_debt_uzs" = 150000 WHERE "id" = $1::uuid`,
      [fix1.invoiceId],
    );

    const adapter = new SyntheticNotificationTransportAdapter();
    const outboxWorker = new OutboxWorker(workerConfig, workerDb, adapter);
    await outboxWorker.runOutboxTick({ nowUtc });

    // Because fix1.promiseId is now CANCELLED/superseded, zero external messages should have been sent for its PromiseDue!
    assert.equal(adapter.getSentExternalLog().length, 0);

    const delivs = await env.apiPool.query<{ delivery_status: string }>(
      `SELECT nd."delivery_status"::text AS delivery_status
         FROM "notification_deliveries" nd
         JOIN "outbox_events" oe ON oe."id" = nd."outbox_event_id"
        WHERE oe."center_id" = $1::uuid
          AND oe."event_name" = 'PromiseDue'
          AND oe."aggregate_id" = $2::uuid`,
      [CENTER_A.centerId, fix1.promiseId],
    );
    assert.ok(delivs.rows.length >= 1);
    assert.ok(delivs.rows.every((d) => d.delivery_status === 'SKIPPED_UNLINKED'));
  });

  it('WORKER-IT-13: S05 executes real CanonicalSqlBillingCycleWorkerPort inside SchedulesWorker for CALENDAR_MONTH (Feb 28 vs leap Feb 29 and PREVIOUS_AND_CURRENT_CYCLE catch-up), ROLLING_MONTH (Jan 31 -> Feb 28 -> Mar 28), and LESSON_PACKAGE_12 (PKG:1 -> PKG:2 with durable allocations)', async () => {
    // 1. Add confirmed billing policies for ROLLING_MONTH and LESSON_PACKAGE_12
    await env.apiPool.query(
      `INSERT INTO "billing_policy_versions" (
         "id", "center_id", "version_number", "billing_mode",
         "first_partial_charge_mode", "rounding_mode",
         "rolling_month_end_mode", "package_cancel_mode",
         "cancelled_lesson_proration_mode", "discount_stacking_mode",
         "freeze_credit_basis", "refund_debt_mode",
         "policy_confirmation_status", "discount_policy_status", "freeze_policy_status",
         "effective_from_date", "created_by_staff_id"
       ) VALUES
       ($1::uuid, $3::uuid, 2, 'ROLLING_MONTH', 'PRORATE_REMAINING_LESSONS', 'HALF_UP_UZS_INT', 'CONTINUE_FROM_CLAMPED_DAY', 'PRESERVE_BALANCE', 'EXCLUDE_CANCELLED_FROM_PLANNED', 'UNCONFIGURED', 'UNCONFIGURED', 'REOPEN_INVOICE_DEBT', 'CONFIRMED', 'UNCONFIGURED', 'UNCONFIGURED', '2026-01-01', $4::uuid),
       ($2::uuid, $3::uuid, 3, 'LESSON_PACKAGE_12', 'FULL_CYCLE', 'HALF_UP_UZS_INT', 'CONTINUE_FROM_CLAMPED_DAY', 'PRESERVE_BALANCE', 'EXCLUDE_CANCELLED_FROM_PLANNED', 'UNCONFIGURED', 'UNCONFIGURED', 'REOPEN_INVOICE_DEBT', 'CONFIRMED', 'UNCONFIGURED', 'UNCONFIGURED', '2026-01-01', $4::uuid)`,
      [crypto.randomUUID(), crypto.randomUUID(), CENTER_A.centerId, CENTER_A.directorId],
    );

    const rollingGroupId = crypto.randomUUID();
    const pkgGroupId = crypto.randomUUID();
    await env.apiPool.query(
      `INSERT INTO "course_groups" (
         "id", "center_id", "course_id", "name", "primary_teacher_id",
         "billing_mode", "current_fee_uzs", "lessons_per_cycle",
         "schedule_days_json", "starts_time", "duration_minutes", "timezone", "status"
       ) VALUES
       ($1::uuid, $3::uuid, $4::uuid, 'GRP-S13-ROLLING', $5::uuid, 'ROLLING_MONTH', 600000, 12, '["MON","WED","FRI"]'::jsonb, '10:00', 90, 'Asia/Tashkent', 'ACTIVE'),
       ($2::uuid, $3::uuid, $4::uuid, 'GRP-S13-PKG12', $5::uuid, 'LESSON_PACKAGE_12', 480000, 12, '["TUE","THU","SAT"]'::jsonb, '14:00', 90, 'Asia/Tashkent', 'ACTIVE')`,
      [rollingGroupId, pkgGroupId, CENTER_A.centerId, CENTER_A.courseId, CENTER_A.teacher1Id],
    );

    const rolEnrId = crypto.randomUUID();
    const pkgEnrId = crypto.randomUUID();
    await env.apiPool.query(
      `INSERT INTO "enrollments" ("id", "center_id", "student_id", "group_id", "status", "enrolled_at_date")
       VALUES
       ($1::uuid, $3::uuid, $4::uuid, $5::uuid, 'ACTIVE', '2026-01-31'),
       ($2::uuid, $3::uuid, $4::uuid, $6::uuid, 'ACTIVE', '2026-01-01')`,
      [rolEnrId, pkgEnrId, CENTER_A.centerId, CENTER_A.studentId, rollingGroupId, pkgGroupId],
    );

    // Seed 12 lesson occurrences for pkgGroupId so LESSON_PACKAGE_12 allocates durable lesson rows
    for (let i = 1; i <= 12; i += 1) {
      const dayStr = `2026-01-${String(i).padStart(2, '0')}`;
      await env.apiPool.query(
        `INSERT INTO "lesson_occurrences" (
           "id", "center_id", "group_id", "lesson_date", "occurrence_seq",
           "starts_at_utc", "ends_at_utc", "status",
           "primary_teacher_snapshot_id", "pay_recipient_teacher_id", "version"
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::date, 1, $5::timestamptz, $6::timestamptz, 'SCHEDULED', $7::uuid, $7::uuid, 1)`,
        [
          crypto.randomUUID(),
          CENTER_A.centerId,
          pkgGroupId,
          dayStr,
          `${dayStr}T09:00:00Z`,
          `${dayStr}T10:30:00Z`,
          CENTER_A.teacher1Id,
        ],
      );
    }

    // Use default SchedulesWorker (which wires CanonicalSqlBillingCycleWorkerPort automatically!)
    const realSchedulesWorker = new SchedulesWorker(workerConfig, workerDb);

    // Run 1: At 2026-01-31 -> issues ROL:2026-01-31 (2026-01-31..2026-02-27) and PKG:1
    const runJan = await realSchedulesWorker.runBillingCycleCutoffAndCatchUpJob({
      nowUtc: new Date('2026-01-31T12:00:00.000Z'),
      cycleKey: '2026-01',
    });
    assert.ok(runJan.invoicesIssuedCount >= 2);

    // Run 2: At 2026-02-28 -> issues ROL:2026-02-28 (2026-02-28..2026-03-27) and CAL 2026-02 (period_end_date = 2026-02-28, NOT 2026-02-30!)
    const runFeb = await realSchedulesWorker.runBillingCycleCutoffAndCatchUpJob({
      nowUtc: new Date('2026-02-28T12:00:00.000Z'),
      cycleKey: '2026-02',
    });
    assert.ok(runFeb.invoicesIssuedCount >= 1);

    // Run 3: At 2026-03-28 -> issues ROL:2026-03-28 (continues from clamped day 28 under OWNER-20261104-03!)
    const runMar = await realSchedulesWorker.runBillingCycleCutoffAndCatchUpJob({
      nowUtc: new Date('2026-03-28T12:00:00.000Z'),
      cycleKey: '2026-03',
    });
    assert.ok(runMar.invoicesIssuedCount >= 1);

    const rolCycles = await env.apiPool.query<{
      cycle_seq: number;
      cycle_key: string;
      period_start_date: string;
      period_end_date: string;
    }>(
      `SELECT "cycle_seq", "cycle_key", "period_start_date"::text AS period_start_date, "period_end_date"::text AS period_end_date
         FROM "billing_cycles"
        WHERE "center_id" = $1::uuid AND "enrollment_id" = $2::uuid
        ORDER BY "cycle_seq" ASC`,
      [CENTER_A.centerId, rolEnrId],
    );
    assert.equal(rolCycles.rows.length, 3);
    assert.equal(rolCycles.rows[0].period_start_date.slice(0, 10), '2026-01-31');
    assert.equal(rolCycles.rows[0].period_end_date.slice(0, 10), '2026-02-27');
    assert.equal(rolCycles.rows[1].period_start_date.slice(0, 10), '2026-02-28');
    assert.equal(rolCycles.rows[1].period_end_date.slice(0, 10), '2026-03-27');
    assert.equal(rolCycles.rows[2].period_start_date.slice(0, 10), '2026-03-28');

    const pkgAllocCount = await env.apiPool.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt
         FROM "billing_cycle_lesson_allocations"
        WHERE "center_id" = $1::uuid AND "enrollment_id" = $2::uuid`,
      [CENTER_A.centerId, pkgEnrId],
    );
    assert.equal(Number(pkgAllocCount.rows[0].cnt), 12);
  });

  it('WORKER-IT-14: S05 enforces live center_licenses READ_ONLY (and missing license row) fail-closed across billing, unclosed shift reminder, and trial no-show follow-up', async () => {
    const schedulesWorker = new SchedulesWorker(workerConfig, workerDb);
    const nowUtc = new Date('2026-11-06T12:00:00.000Z');

    await env.apiPool.query(
      `UPDATE "center_licenses" SET "license_status" = 'READ_ONLY' WHERE "center_id" = $1::uuid`,
      [CENTER_A.centerId],
    );
    try {
      await assert.rejects(
        () => schedulesWorker.runBillingCycleCutoffAndCatchUpJob({ nowUtc }),
        /LICENSE_READ_ONLY_MODE/,
      );
      await assert.rejects(
        () =>
          schedulesWorker.runTrialNoShowFollowUpJob({
            nowUtc,
            trialNoShowPolicy: 'CONFIRMED_SECOND_ABSENCE_ADMIN_FOLLOWUP',
          }),
        /LICENSE_READ_ONLY_MODE/,
      );
      const shiftRes = await schedulesWorker.runUnclosedCashShiftReminderJob({ nowUtc });
      assert.equal(shiftRes.flaggedShiftIds.length, 0);
    } finally {
      await env.apiPool.query(
        `UPDATE "center_licenses" SET "license_status" = 'ACTIVE' WHERE "center_id" = $1::uuid`,
        [CENTER_A.centerId],
      );
    }
  });

  it('WORKER-IT-15: S06 TeacherPingWorker preserves lesson_occurrences.pay_recipient_teacher_id unchanged, enforces bounded historical window, and OutboxWorker suppresses TeacherPingDue if attendance is submitted before send', async () => {
    await env.apiPool.query(`UPDATE "outbox_events" SET "status" = 'COMPLETED' WHERE "center_id" = $1::uuid`, [
      CENTER_A.centerId,
    ]);

    const lessonTodayId = crypto.randomUUID();
    const lessonOldHistoricalId = crypto.randomUUID();

    // lessonTodayId has primary_teacher_snapshot_id = teacher1Id, but pay_recipient_teacher_id = teacher2Id
    // (e.g. a payroll override), and NO active substitute_assignments row -> effectiveTeacher is teacher1Id.
    // Pinging teacher1Id must NEVER overwrite pay_recipient_teacher_id (teacher2Id)!
    await env.apiPool.query(
      `INSERT INTO "lesson_occurrences" (
         "id", "center_id", "group_id", "lesson_date", "occurrence_seq",
         "starts_at_utc", "ends_at_utc", "status",
         "primary_teacher_snapshot_id", "pay_recipient_teacher_id", "version"
       ) VALUES
       ($1::uuid, $3::uuid, $4::uuid, '2026-11-07', 1, '2026-11-07T09:00:00Z', '2026-11-07T10:30:00Z', 'SCHEDULED', $5::uuid, $6::uuid, 1),
       ($2::uuid, $3::uuid, $4::uuid, '2026-10-01', 1, '2026-10-01T09:00:00Z', '2026-10-01T10:30:00Z', 'SCHEDULED', $5::uuid, $5::uuid, 1)`,
      [
        lessonTodayId,
        lessonOldHistoricalId,
        CENTER_A.centerId,
        CENTER_A.groupId,
        CENTER_A.teacher1Id,
        CENTER_A.teacher2Id,
      ],
    );

    const pingWorker = new TeacherPingWorker(workerConfig, workerDb);
    const nowUtc = new Date('2026-11-07T09:25:00.000Z');

    const pingRes = await pingWorker.runTeacherPingAndEscalationTick({ nowUtc });
    assert.ok(pingRes.pingedLessonIds.includes(lessonTodayId));
    assert.equal(pingRes.pingedLessonIds.includes(lessonOldHistoricalId), false);

    const payRecipientCheck = await env.apiPool.query<{
      pay_recipient_teacher_id: string;
      teacher_ping_recipient_id: string;
    }>(
      `SELECT "pay_recipient_teacher_id"::text AS pay_recipient_teacher_id,
              "teacher_ping_recipient_id"::text AS teacher_ping_recipient_id
         FROM "lesson_occurrences" WHERE "id" = $1::uuid`,
      [lessonTodayId],
    );
    assert.equal(payRecipientCheck.rows[0].teacher_ping_recipient_id, CENTER_A.teacher1Id);
    assert.equal(payRecipientCheck.rows[0].pay_recipient_teacher_id, CENTER_A.teacher2Id);

    // Now simulate teacher submitting attendance BEFORE OutboxWorker sends the queued TeacherPingDue!
    await env.apiPool.query(
      `UPDATE "lesson_occurrences"
          SET "status" = 'COMPLETED',
              "attendance_submitted_at" = $2::timestamptz,
              "attendance_version" = 1
        WHERE "id" = $1::uuid`,
      [lessonTodayId, nowUtc.toISOString()],
    );

    const adapter = new SyntheticNotificationTransportAdapter();
    const outboxWorker = new OutboxWorker(workerConfig, workerDb, adapter);
    await outboxWorker.runOutboxTick({ nowUtc });

    assert.equal(adapter.getSentExternalLog().length, 0);
    const delivStatus = await env.apiPool.query<{ delivery_status: string }>(
      `SELECT nd."delivery_status"::text AS delivery_status
         FROM "notification_deliveries" nd
         JOIN "outbox_events" oe ON oe."id" = nd."outbox_event_id"
        WHERE oe."center_id" = $1::uuid AND oe."aggregate_id" = $2::uuid`,
      [CENTER_A.centerId, lessonTodayId],
    );
    assert.equal(delivStatus.rows[0].delivery_status, 'SKIPPED_UNLINKED');
  });

  it('WORKER-IT-16: S02 & S07 selective reconcileRestoredOutbox preserves unapplied internal financial events (AllocationAdjusted) while superseding pre-cutoff notification events, and auto-stages API-emitted notification events', async () => {
    await env.apiPool.query(`UPDATE "outbox_events" SET "status" = 'COMPLETED' WHERE "center_id" = $1::uuid`, [
      CENTER_A.centerId,
    ]);

    const fix = await createInvoiceAndPromiseFixture({
      remainingDebtUzs: '0',
      promiseDate: '2026-11-12',
      promiseStatus: 'ACTIVE',
    });

    const internalAllocEvtId = crypto.randomUUID();
    const notifAttEvtId = crypto.randomUUID();

    await env.apiPool.query(
      `INSERT INTO "outbox_events" (
         "id", "center_id", "event_name", "schema_version",
         "aggregate_type", "aggregate_id", "aggregate_version",
         "dedup_key", "payload_json", "status", "lease_token",
         "occurred_at_utc", "next_attempt_at", "updated_at"
       ) VALUES
       ($1::uuid, $3::uuid, 'AllocationAdjusted', 1, 'Invoice', $4::uuid, 1, $6, $8::jsonb, 'PENDING', 0, '2026-11-04T08:00:00Z', '2026-11-04T08:00:00Z', '2026-11-04T08:00:00Z'),
       ($2::uuid, $3::uuid, 'AttendanceSubmitted', 1, 'LessonOccurrence', $5::uuid, 1, $7, $9::jsonb, 'PENDING', 0, '2026-11-04T08:00:00Z', '2026-11-04T08:00:00Z', '2026-11-04T08:00:00Z')`,
      [
        internalAllocEvtId,
        notifAttEvtId,
        CENTER_A.centerId,
        fix.invoiceId,
        crypto.randomUUID(),
        `RestoreSelective:Alloc:${internalAllocEvtId}`,
        `RestoreSelective:Att:${notifAttEvtId}`,
        JSON.stringify({ invoice_id: fix.invoiceId, student_id: CENTER_A.studentId, new_remaining_debt_uzs: '0' }),
        JSON.stringify({ absent_student_ids: [CENTER_A.studentId] }),
      ],
    );

    const restoreWorker = new OutboxWorker(
      { ...workerConfig, botOutboundEnabled: false },
      workerDb,
    );
    const rec = await restoreWorker.reconcileRestoredOutbox({
      cutoffUtc: new Date('2026-11-05T00:00:00.000Z'),
      reason: 'Selective restore test',
      nowUtc: new Date('2026-11-05T01:00:00.000Z'),
    });
    assert.equal(rec.supersededCount, 1);
    assert.ok(rec.preservedInternalCount >= 1);

    // Run OutboxWorker: preserved AllocationAdjusted executes and fulfills fix.promiseId!
    const adapter = new SyntheticNotificationTransportAdapter();
    const activeWorker = new OutboxWorker(workerConfig, workerDb, adapter);
    await activeWorker.runOutboxTick({ nowUtc: new Date('2026-11-05T02:00:00.000Z') });

    const pCheck = await env.apiPool.query<{ status: string }>(
      `SELECT "status"::text AS status FROM "promises_to_pay" WHERE "id" = $1::uuid`,
      [fix.promiseId],
    );
    assert.equal(pCheck.rows[0].status, 'FULFILLED');
  });
});
