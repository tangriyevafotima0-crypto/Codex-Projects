/**
 * EduERP v2.0 — Gate G10: Stage 13 Outbox Lease/Fencing/Retry/DLQ, 09:00 Promise Reminders,
 * 20-Minute Teacher Ping & Admin Escalation, Idempotent Scheduled Jobs & S13FIX-T Remediation
 * Real PostgreSQL Integration Test Suite (`WORKER-IT-01..24` — `S01`–`S07`, `T01`–`T05`):
 *
 * - `WORKER-IT-01`: `13.01` Two-worker concurrent `claimOutboxBatch` race (`FOR UPDATE SKIP LOCKED` -> single claim),
 *   monotonic `lease_token` fencing, lease expiry reclaim, and stale leaseholder rejection (`StaleLeaseTokenError`).
 * - `WORKER-IT-02`: `13.01` Atomic `executeInternalConsumerWithReceipt` (`AllocationAdjusted` -> `PromiseLifecycleConsumer`
 *   + `OutboxConsumerReceipt`), crash/fault rollback (`DOMAIN_EFFECT` and `RECEIPT_INSERT` leave zero partial writes),
 *   and idempotent receipt deduplication on retry.
 * - `WORKER-IT-03`: `13.02` & `T01` Center-local `09:00` `RemindersWorker` (`Asia/Tashkent` pre-`09:00` skip, `09:00`
 *   `PromiseDue` emission + `OVERDUE_NOTIFIED` + `notification_deliveries` staging with isolated per-fixture students,
 *   `CASE-22` paid debt auto-fulfillment to `FULFILLED` with zero reminders, superseded promise `CANCELLED` suppression,
 *   bounded 1-day catch-up, and `POLICY_DECISION_NOT_CONFIRMED` on unbounded catch-up spam).
 * - `WORKER-IT-04`: `13.01` Predecessor `aggregate_version` ordering gate (`v2` held back while `v1` of same aggregate is
 *   `PENDING`/`LEASED`/`DEAD_LETTER`, while unrelated aggregate events continue without head-of-line blocking), bounded
 *   retry (`attempt_count <= 8`) -> `DEAD_LETTER` with redacted error, and `DIRECTOR`/`ADMIN` `replayDeadLetterEvent`.
 * - `WORKER-IT-05`: `13.01` Honest external delivery send-crash semantics via `SyntheticNotificationTransportAdapter`
 *   (`CRASH_BEFORE_SEND` vs `CRASH_AFTER_SEND_BEFORE_ACK` recording `EXTERNAL_DELIVERY_AMBIGUOUS_AFTER_SEND` audit with
 *   `possible_duplicate_delivery: true`, `RATE_LIMIT_429` -> `RETRY_429`, `BLOCKED_403` -> `FAILED_403_BLOCKED` +
 *   `guardian_telegram_links.status = 'BOT_BLOCKED_403'`, and live pre-send `remaining_debt_uzs == 0` suppression).
 * - `WORKER-IT-06`: `13.03` & `T01` `TeacherPingWorker` 20-minute `STAGE_20M_PING` to primary or active single-lesson
 *   substitute teacher, revoked substitute suppression (`SKIPPED_UNLINKED` on old teacher's queued ping and fresh ping
 *   to primary), lesson-end `STAGE_END_ADMIN_ESCALATION` to Admin, and suppression of `CANCELLED_BY_CENTER`,
 *   `RESCHEDULED`, and `COMPLETED` lessons with distinct `starts_at_utc` values (`uq_lesson_occurrences_group_starts`).
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
 * - `WORKER-IT-12`: `S04` & `T01` Pre-send suppression of superseded `PromiseDue` delivery when invoice still has remaining
 *   debt (`allocated_paid_uzs` + `remaining_debt_uzs = effective_net_charge_uzs` preserving `chk_invoices_remaining_debt_formula`)
 *   from a newer promise, plus live `staff_users` / `guardian_students` authority and `DLQ` replay DB role verification.
 * - `WORKER-IT-13`: `S05` & `T01` Real `CanonicalSqlBillingCycleWorkerPort` inside `SchedulesWorker` for `CALENDAR_MONTH`
 *   (Feb 2026 `2026-02-28` vs leap Feb 2028 `2028-02-29` and `PREVIOUS_AND_CURRENT_CYCLE` catch-up at `2028-03-05`),
 *   `ROLLING_MONTH` (`Jan 31 -> Feb 28 -> Mar 28` under `OWNER-20261104-03`), and `LESSON_PACKAGE_12` (`PKG:1` -> `PKG:2`
 *   with durable `billing_cycle_lesson_allocations` after consuming first 12 lessons).
 * - `WORKER-IT-14`: `S05` Live `center_licenses` `READ_ONLY` (and missing license row) fail-closed enforcement across
 *   `runBillingCycleCutoffAndCatchUpJob`, `runUnclosedCashShiftReminderJob`, and `runTrialNoShowFollowUpJob`.
 * - `WORKER-IT-15`: `S06` `TeacherPingWorker` never mutates `lesson_occurrences.pay_recipient_teacher_id`, enforces
 *   bounded historical scan window, and `OutboxWorker` suppresses queued `TeacherPingDue` right before send if attendance
 *   was submitted or substitute changed after event creation.
 * - `WORKER-IT-16`: `S02`, `S07` & `T01` Selective `reconcileRestoredOutbox` preserves unapplied internal financial events
 *   (`AllocationAdjusted`) while superseding pre-cutoff notification events (`AttendanceSubmitted`), and API-emitted
 *   notification events (`PaymentRecorded`, `ShiftClosed`) auto-stage and deliver via `OutboxWorker`.
 * - `WORKER-IT-17`: `T02` Fixed-clock `CURRENT_CYCLE_ONLY` across 12 repeated polls + 2 concurrent workers + restart for
 *   `enrolled_at_date = 2026-01-31` at `2026-11-05` produces `0` historical cycles, `0` invoices, `0` debt, and idempotent
 *   `BILLING_HISTORICAL_RECONCILIATION_DEFERRED` audit log.
 * - `WORKER-IT-18`: `T02` Bounded `PREVIOUS_AND_CURRENT_CYCLE` horizon (`[previous, current]` 2 cycles when enrollment starts
 *   at `prev` window, `0` cycles when unconfirmed first cycle precedes `[previous, current]`, and center date progression).
 * - `WORKER-IT-19`: `T02` Single canonical billing engine financial parity between API (`executeCanonicalBillingCycleIssuanceInTx`)
 *   and Worker (`CanonicalSqlBillingCycleWorkerPort`) on distinct equivalent enrollments (historical tariff snapshot, pro-rata
 *   `HALF_UP_UZS_INT`, `CreditNote` cap, `due_date`, `invoice_lines`, `ledger_entries`), fault rollback at all 7 write points,
 *   and concurrent API/Worker same-cycle serialization (`1` invoice, `0` duplicate ledger entries).
 * - `WORKER-IT-20`: `T03` Per-center feature-specific notification policy (`billing CONFIRMED + notif UNCONFIGURED -> 0 intents / 0 sends`,
 *   explicit confirmed `CONFIRMED_GUARDIAN_ONLY` vs `CONFIRMED_ADMIN_AND_GUARDIAN` positive control with `policy_version_id`
 *   provenance, other-center isolation, and send-time suppression on expired, revoked, or narrowed policy).
 * - `WORKER-IT-21`: `T04` Batch `AttendanceSubmitted` / `AttendanceCorrected` exact guardian–student child scope and
 *   recipient-specific payload projection (unlinked Child A while Child B remains active -> `0` sends; mixed batch Parent A
 *   and Parent B receive only their own child's fields; multi-guardian for one child; multi-child for one guardian deduplication).
 * - `WORKER-IT-22`: `T05` Real OS subprocess (`child_process.spawn`) worker crash/recovery (`SIGKILL` before external send vs
 *   real `SIGKILL` after external send to local observer before local DB ACK commit -> durable `last_lease_token > 0`,
 *   `EXTERNAL_DELIVERY_AMBIGUOUS_AFTER_SEND` with `possible_duplicate_delivery: true`, and `outbox_consumer_receipts` dedup).
 * - `WORKER-IT-23`: `T05` Bounded `WorkerRuntimeSkeleton.stop()` under slow/hung PostgreSQL query (`pg_sleep(5)`), shared
 *   `stopPromise` across concurrent `stop()` calls, zero post-stop claims, and `worker_shutdown_bounded_timeout` vs
 *   `worker_stopped_gracefully` differentiation.
 * - `WORKER-IT-24`: `T05` Worker runtime & Dockerfile/workspace isolation verification (zero runtime imports from `apps/api`,
 *   explicit `pg` dependency in `apps/worker/package.json`, subprocess fail-fast on invalid env, least-privilege `42501`,
 *   and zero live external network calls).
 */

import * as assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { URL } from 'node:url';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import {
  BillingCycleWorkerIssueParams,
  BillingCycleWorkerIssueResult,
  BillingCycleWorkerPort,
  CanonicalFaultInjectionStep,
  executeCanonicalBillingCycleIssuanceInTx,
} from '@eduerp/contracts';
import { loadWorkerEnv, WorkerEnvConfig } from '../src/config/env';
import {
  CanonicalSqlBillingCycleWorkerPort,
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
    throw new Error(
      'EDUERP_ALLOW_DESTRUCTIVE_DB_TESTS=true is required for Gate G10 worker DB tests',
    );
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

    // Seed baseline Center A fixtures via apiPool (notification_policy_status defaults to UNCONFIGURED!)
    await apiPool.query(
      `INSERT INTO "center_licenses" (
         "center_id", "center_slug", "license_status", "signed_jwt_token",
         "signature_key_id", "valid_until_utc", "grace_until_utc", "last_verified_at_utc"
       ) VALUES (
         $1::uuid, $2, 'ACTIVE', 'syn-jwt-token',
         'key-01', '2029-01-01T00:00:00Z', '2029-01-08T00:00:00Z', '2026-11-05T00:00:00Z'
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
         '2029-01-01T00:00:00Z', 777001, 777001,
         '+998901112233', 'ACTIVE'
       )`,
      [crypto.randomUUID(), CENTER_A.centerId, CENTER_A.guardianId, 'a'.repeat(64)],
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

describe('Gate G10 — Stage 13 Outbox Lease/Fencing/Retry/DLQ, 09:00 Promise Reminders, 20m Teacher Ping & Idempotent Scheduler PostgreSQL Integration Suite (WORKER-IT-01..24)', () => {
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

  /**
   * T01 Isolation Fix:
   * Creates a fresh isolated student (`studentId`) per fixture (linked to `CENTER_A.guardianId`)
   * unless an explicit `studentId`/`groupId` is provided, preventing `23505` collisions on
   * `idx_enrollments_active_student_group` across repeated fixture calls. Also inserts a consistent
   * `payment_allocations` row matching `allocated_paid_uzs` and `chk_invoices_remaining_debt_formula`.
   */
  async function createInvoiceAndPromiseFixture(options: {
    remainingDebtUzs: string;
    promiseDate: string;
    promiseStatus?: 'ACTIVE' | 'FULFILLED' | 'CANCELLED' | 'OVERDUE_NOTIFIED';
    supersededByPromiseId?: string | null;
    studentId?: string;
    groupId?: string;
  }): Promise<{
    studentId: string;
    enrollmentId: string;
    invoiceId: string;
    shiftId: string;
    paymentId: string;
    promiseId: string;
  }> {
    seq += 1;
    const studentId = options.studentId ?? crypto.randomUUID();
    const groupId = options.groupId ?? CENTER_A.groupId;
    const enrollmentId = crypto.randomUUID();
    const cycleId = crypto.randomUUID();
    const invoiceId = crypto.randomUUID();
    const shiftId = crypto.randomUUID();
    const paymentId = crypto.randomUUID();
    const promiseId = crypto.randomUUID();

    if (!options.studentId) {
      await env.apiPool.query(
        `INSERT INTO "students" ("id", "center_id", "student_code", "full_name", "normalized_name", "status")
         VALUES ($1::uuid, $2::uuid, $3, $4, $5, 'ACTIVE')`,
        [
          studentId,
          CENTER_A.centerId,
          `STU-FIX-${seq}`,
          `Fixture Student ${seq}`,
          `fixture student ${seq}`,
        ],
      );
      await env.apiPool.query(
        `INSERT INTO "guardian_students" ("id", "center_id", "guardian_id", "student_id", "relationship", "is_primary_payer", "active")
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'FATHER', TRUE, TRUE)`,
        [crypto.randomUUID(), CENTER_A.centerId, CENTER_A.guardianId, studentId],
      );
    }

    await env.apiPool.query(
      `INSERT INTO "enrollments" ("id", "center_id", "student_id", "group_id", "status", "enrolled_at_date")
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'ACTIVE', '2026-11-01')`,
      [enrollmentId, CENTER_A.centerId, studentId, groupId],
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
        '2026-11',
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
        studentId,
        enrollmentId,
        cycleId,
        CENTER_A.policyId,
        paidUzs.toString(10),
        remDebt.toString(10),
        invStatus,
      ],
    );

    const paymentAmountUzs = paidUzs > 0n ? paidUzs : 100_000n;
    await env.apiPool.query(
      `INSERT INTO "cash_shifts" (
         "id", "center_id", "shift_date", "opened_by_admin_id",
         "opening_cash_uzs", "cash_receipts_uzs", "expected_closing_cash_uzs", "status", "version"
       ) VALUES ($1::uuid, $2::uuid, '2026-11-05', $3::uuid, 0, $4::bigint, $4::bigint, 'CLOSED', 2)`,
      [shiftId, CENTER_A.centerId, CENTER_A.adminId, paymentAmountUzs.toString(10)],
    );

    await env.apiPool.query(
      `INSERT INTO "payments" (
         "id", "center_id", "student_id", "cash_shift_id", "amount_uzs",
         "currency", "payment_method", "recorded_by_admin_id", "idempotency_key", "request_hash"
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::bigint, 'UZS', 'CASH', $6::uuid, $7, $8)`,
      [
        paymentId,
        CENTER_A.centerId,
        studentId,
        shiftId,
        paymentAmountUzs.toString(10),
        CENTER_A.adminId,
        `idem-wrk-pay-${seq}`,
        crypto.createHash('sha256').update(`pay-${seq}`).digest('hex'),
      ],
    );

    if (paidUzs > 0n) {
      await env.apiPool.query(
        `INSERT INTO "payment_allocations" (
           "id", "center_id", "payment_id", "invoice_id", "allocated_amount_uzs"
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::bigint)`,
        [crypto.randomUUID(), CENTER_A.centerId, paymentId, invoiceId, paidUzs.toString(10)],
      );
    }

    await env.apiPool.query(
      `INSERT INTO "promises_to_pay" (
         "id", "center_id", "student_id", "invoice_id", "trigger_payment_id",
         "promised_amount_uzs", "promise_date", "status", "superseded_by_promise_id", "version"
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
         $6::bigint, $7::date, $8, $9::uuid, 1
       )`,
      [
        promiseId,
        CENTER_A.centerId,
        studentId,
        invoiceId,
        paymentId,
        (remDebt > 0n ? remDebt : 300_000n).toString(10),
        options.promiseDate,
        options.promiseStatus ?? 'ACTIVE',
        options.supersededByPromiseId ?? null,
      ],
    );

    return { studentId, enrollmentId, invoiceId, shiftId, paymentId, promiseId };
  }

  async function insertCenterPolicyVersion(params: {
    readonly centerId?: string;
    readonly billingMode?: 'CALENDAR_PRO_RATA' | 'ROLLING_MONTH' | 'LESSON_PACKAGE_12';
    readonly notificationPolicyStatus?: 'UNCONFIGURED' | 'CONFIRMED';
    readonly promiseReminderChannelPolicy?:
      | 'UNCONFIGURED_CHANNEL_POLICY'
      | 'CONFIRMED_GUARDIAN_ONLY'
      | 'CONFIRMED_ADMIN_AND_GUARDIAN';
    readonly effectiveFromDate?: string;
    readonly notificationPolicyEffectiveUntil?: string | null;
  }): Promise<{ readonly policyId: string; readonly versionNumber: number }> {
    const centerId = params.centerId ?? CENTER_A.centerId;
    const maxRes = await env.apiPool.query<{ max_ver: number }>(
      `SELECT COALESCE(MAX("version_number"), 0)::int AS max_ver
         FROM "billing_policy_versions"
        WHERE "center_id" = $1::uuid`,
      [centerId],
    );
    const versionNumber = Number(maxRes.rows[0]?.max_ver ?? 0) + 1;
    const policyId = crypto.randomUUID();
    await env.apiPool.query(
      `INSERT INTO "billing_policy_versions" (
         "id", "center_id", "version_number", "billing_mode",
         "first_partial_charge_mode", "rounding_mode",
         "rolling_month_end_mode", "package_cancel_mode",
         "cancelled_lesson_proration_mode", "discount_stacking_mode",
         "freeze_credit_basis", "refund_debt_mode",
         "policy_confirmation_status", "discount_policy_status", "freeze_policy_status",
         "notification_policy_status", "promise_reminder_channel_policy", "notification_policy_effective_until",
         "effective_from_date", "created_by_staff_id"
       ) VALUES (
         $1::uuid, $2::uuid, $3::int, $4,
         $5, 'HALF_UP_UZS_INT',
         'CONTINUE_FROM_CLAMPED_DAY', 'PRESERVE_BALANCE',
         'EXCLUDE_CANCELLED_FROM_PLANNED', 'UNCONFIGURED',
         'UNCONFIGURED', 'REOPEN_INVOICE_DEBT',
         'CONFIRMED', 'UNCONFIGURED', 'UNCONFIGURED',
         $6, $7, $8::date,
         $9::date, $10::uuid
       )`,
      [
        policyId,
        centerId,
        versionNumber,
        params.billingMode ?? 'CALENDAR_PRO_RATA',
        params.billingMode === 'LESSON_PACKAGE_12' ? 'FULL_CYCLE' : 'PRORATE_REMAINING_LESSONS',
        params.notificationPolicyStatus ?? 'UNCONFIGURED',
        params.promiseReminderChannelPolicy ?? 'UNCONFIGURED_CHANNEL_POLICY',
        params.notificationPolicyEffectiveUntil ?? null,
        params.effectiveFromDate ?? '2026-01-01',
        CENTER_A.directorId,
      ],
    );
    return { policyId, versionNumber };
  }

  it('WORKER-IT-01: serializes 2-worker concurrent outbox claim via FOR UPDATE SKIP LOCKED, increments monotonic lease_token on expiry reclaim, and fences stale leaseholder ACK/retry/consumer writes', async () => {
    await env.apiPool.query(
      `UPDATE "outbox_events" SET "status" = 'COMPLETED' WHERE "center_id" = $1::uuid`,
      [CENTER_A.centerId],
    );

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
          student_id: fix.studentId,
          new_remaining_debt_uzs: '0',
        }),
        nowUtc.toISOString(),
      ],
    );

    const outboxWorker = new OutboxWorker(workerConfig, workerDb);
    const claimed = await outboxWorker.claimOutboxBatch({ nowUtc });
    assert.equal(claimed.length, 1);
    const ev = claimed[0];

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

    const procRes = await outboxWorker.processLeasedEvent(ev, nowUtc);
    assert.equal(procRes.finalStatus, 'COMPLETED');

    const pAfter = await env.apiPool.query<{ status: string }>(
      `SELECT "status"::text AS status FROM "promises_to_pay" WHERE "id" = $1::uuid`,
      [fix.promiseId],
    );
    assert.equal(pAfter.rows[0].status, 'FULFILLED');

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

  it('WORKER-IT-03: enforces 13.02 09:00 Asia/Tashkent promise reminder gate, emits PromiseDue for unpaid active promises under confirmed notification policy, auto-fulfills paid promises (CASE-22), suppresses superseded promises, and supports bounded catch-up', async () => {
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

    await insertCenterPolicyVersion({
      notificationPolicyStatus: 'CONFIRMED',
      promiseReminderChannelPolicy: 'CONFIRMED_ADMIN_AND_GUARDIAN',
      effectiveFromDate: '2026-01-01',
    });

    const remindersWorker = new RemindersWorker(workerConfig, workerDb);

    await assert.rejects(
      () =>
        remindersWorker.runPromiseReminderTick({
          nowUtc: new Date('2026-11-10T04:05:00.000Z'),
          catchUpPolicy: 'UNBOUNDED_HISTORICAL_SPAM',
        }),
      /POLICY_DECISION_NOT_CONFIRMED/,
    );

    const beforeNineRes = await remindersWorker.runPromiseReminderTick({
      nowUtc: new Date('2026-11-10T03:50:00.000Z'),
    });
    assert.equal(beforeNineRes.skippedBeforeNineAm, true);
    assert.equal(beforeNineRes.remindersEmittedCount, 0);

    const atNineRes = await remindersWorker.runPromiseReminderTick({
      nowUtc: new Date('2026-11-10T04:05:00.000Z'),
    });
    assert.equal(atNineRes.skippedBeforeNineAm, false);
    assert.ok(atNineRes.emittedPromiseIds.includes(unpaidFix.promiseId));
    assert.ok(atNineRes.autoFulfilledPromiseIds.includes(paidFix.promiseId));
    assert.equal(atNineRes.emittedPromiseIds.includes(supersededFix.promiseId), false);

    const catchUpRerun = await remindersWorker.runPromiseReminderTick({
      nowUtc: new Date('2026-11-10T06:30:00.000Z'),
    });
    assert.equal(catchUpRerun.emittedPromiseIds.includes(unpaidFix.promiseId), false);
  });

  it('WORKER-IT-04: enforces per-aggregate predecessor version ordering without blocking unrelated aggregates, dead-letters poison events after 8 attempts with redacted error, and supports DIRECTOR DLQ replay', async () => {
    await env.apiPool.query(
      `UPDATE "outbox_events" SET "status" = 'COMPLETED' WHERE "center_id" = $1::uuid`,
      [CENTER_A.centerId],
    );

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
    await env.apiPool.query(
      `UPDATE "outbox_events" SET "status" = 'COMPLETED' WHERE "center_id" = $1::uuid`,
      [CENTER_A.centerId],
    );

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
         $4, $5::jsonb, 'PENDING', 0,
         $6::timestamptz, $6::timestamptz, $6::timestamptz
       )`,
      [
        eventId,
        CENTER_A.centerId,
        crypto.randomUUID(),
        `PaymentRecorded:${eventId}`,
        JSON.stringify({ payment_id: 'test', student_id: CENTER_A.studentId }),
        nowUtc.toISOString(),
      ],
    );

    await env.apiPool.query(
      `INSERT INTO "notification_deliveries" (
         "id", "center_id", "outbox_event_id", "recipient_type", "recipient_id",
         "target_student_id", "telegram_chat_id", "delivery_status", "attempt_count",
         "next_attempt_at", "last_lease_token", "version", "created_at", "updated_at"
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, 'GUARDIAN', $4::uuid,
         $5::uuid, 777001, 'QUEUED', 0,
         $6::timestamptz, 0, 1, $6::timestamptz, $6::timestamptz
       )`,
      [
        delivId,
        CENTER_A.centerId,
        eventId,
        CENTER_A.guardianId,
        CENTER_A.studentId,
        nowUtc.toISOString(),
      ],
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

  it('WORKER-IT-06: runs 13.03 TeacherPingWorker (20m ping to active substitute, suppresses old substitute on revocation and pings primary teacher, escalates to Admin at lesson end, and suppresses cancelled/completed lessons with distinct starts_at_utc)', async () => {
    const lessonId = crypto.randomUUID();
    const cancelledLessonId = crypto.randomUUID();
    const completedLessonId = crypto.randomUUID();
    const subId = crypto.randomUUID();

    // T01 Fix: Each lesson in the same group uses a distinct starts_at_utc within the 20m scan window
    // so uq_lesson_occurrences_group_starts is never violated!
    await env.apiPool.query(
      `INSERT INTO "lesson_occurrences" (
         "id", "center_id", "group_id", "lesson_date", "occurrence_seq",
         "starts_at_utc", "ends_at_utc", "status",
         "primary_teacher_snapshot_id", "pay_recipient_teacher_id",
         "attendance_submitted_at", "attendance_version", "version"
       ) VALUES
       ($1::uuid, $4::uuid, $5::uuid, '2026-11-05', 10, '2026-11-05T08:50:00Z', '2026-11-05T10:20:00Z', 'SCHEDULED', $6::uuid, $7::uuid, NULL, 0, 1),
       ($2::uuid, $4::uuid, $5::uuid, '2026-11-05', 11, '2026-11-05T08:55:00Z', '2026-11-05T10:25:00Z', 'CANCELLED_BY_CENTER', $6::uuid, $6::uuid, NULL, 0, 1),
       ($3::uuid, $4::uuid, $5::uuid, '2026-11-05', 12, '2026-11-05T09:00:00Z', '2026-11-05T10:30:00Z', 'COMPLETED', $6::uuid, $6::uuid, '2026-11-05T09:10:00Z', 1, 1)`,
      [
        lessonId,
        cancelledLessonId,
        completedLessonId,
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

    // At 09:21 UTC, all 3 lessons are past starts_at_utc + 20m, but only lessonId is SCHEDULED & unsubmitted
    const res20m = await pingWorker.runTeacherPingAndEscalationTick({
      nowUtc: new Date('2026-11-05T09:21:00.000Z'),
    });
    assert.ok(res20m.pingedLessonIds.includes(lessonId));
    assert.equal(res20m.pingedLessonIds.includes(cancelledLessonId), false);
    assert.equal(res20m.pingedLessonIds.includes(completedLessonId), false);

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
    assert.equal(resEnd.escalatedLessonIds.includes(cancelledLessonId), false);
    assert.equal(resEnd.escalatedLessonIds.includes(completedLessonId), false);
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

    const shiftCheck = await env.apiPool.query<{
      status: string;
      counted_closing_cash_uzs: string | null;
    }>(
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

      await env.apiPool.query(
        `UPDATE "outbox_events" SET "status" = 'COMPLETED' WHERE "id" = $1::uuid`,
        [bizEvtId],
      );
    } finally {
      await env.apiPool.query(
        `UPDATE "center_licenses" SET "license_status" = 'ACTIVE' WHERE "center_id" = $1::uuid`,
        [CENTER_A.centerId],
      );
    }

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
    await env.apiPool.query(
      `UPDATE "outbox_events" SET "status" = 'COMPLETED' WHERE "center_id" = $1::uuid`,
      [CENTER_A.centerId],
    );

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

    const isolatedWarns = logs.filter(
      (l) =>
        l.event === 'worker_job_isolated_error' &&
        l.details?.job_name === 'TrialNoShowFollowUpJob',
    );
    assert.equal(
      isolatedWarns.length,
      1,
      'Expected TrialNoShowFollowUpJob policy warning to be logged once and deduplicated across polls',
    );
  });

  it('WORKER-IT-10: S02 default UnboundFailClosedNotificationTransportAdapter never fabricates API_ACCEPTED, preserves attempt_count across >8 deferred polls, and dead-letters unknown event_name', async () => {
    await env.apiPool.query(
      `UPDATE "outbox_events" SET "status" = 'COMPLETED' WHERE "center_id" = $1::uuid`,
      [CENTER_A.centerId],
    );

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

    const defaultProdWorker = new OutboxWorker(workerConfig, workerDb);

    for (let i = 0; i < 10; i += 1) {
      const pollTime = new Date(nowUtc.getTime() + i * 120_000);
      await defaultProdWorker.runOutboxTick({ nowUtc: pollTime });
    }

    const unkCheck = await env.apiPool.query<{ status: string; last_error: string }>(
      `SELECT "status"::text AS status, "last_error" FROM "outbox_events" WHERE "id" = $1::uuid`,
      [unknownEvtId],
    );
    assert.equal(unkCheck.rows[0].status, 'DEAD_LETTER');
    assert.match(unkCheck.rows[0].last_error ?? '', /Unregistered outbox event/);

    const notifCheck = await env.apiPool.query<{ status: string; attempt_count: number }>(
      `SELECT "status"::text AS status, "attempt_count" FROM "outbox_events" WHERE "id" = $1::uuid`,
      [notifEvtId],
    );
    assert.equal(notifCheck.rows[0].status, 'PENDING');
    assert.equal(Number(notifCheck.rows[0].attempt_count), 0);

    const delivCheck = await env.apiPool.query<{
      delivery_status: string;
      telegram_message_id: string | null;
    }>(
      `SELECT "delivery_status"::text AS delivery_status, "telegram_message_id"::text AS telegram_message_id
         FROM "notification_deliveries" WHERE "outbox_event_id" = $1::uuid`,
      [notifEvtId],
    );
    assert.equal(delivCheck.rows.length, 1);
    assert.equal(delivCheck.rows[0].delivery_status, 'QUEUED');
    assert.equal(delivCheck.rows[0].telegram_message_id, null);

    await env.apiPool.query(
      `UPDATE "outbox_events" SET "status" = 'COMPLETED' WHERE "id" = $1::uuid`,
      [notifEvtId],
    );
  });

  it('WORKER-IT-11: S03 fences all delivery transitions (429, 403, timeout, API_ACCEPTED) against stale lease_token and detects post-send crash from durable DB state even without in-memory error flag', async () => {
    await env.apiPool.query(
      `UPDATE "outbox_events" SET "status" = 'COMPLETED' WHERE "center_id" = $1::uuid`,
      [CENTER_A.centerId],
    );

    const nowUtc = new Date('2026-11-05T21:00:00.000Z');

    for (const mode of [
      'RATE_LIMIT_429',
      'BLOCKED_403',
      'TRANSIENT_TIMEOUT',
      'ACCEPT_OK',
    ] as const) {
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
           "target_student_id", "telegram_chat_id", "delivery_status", "attempt_count",
           "next_attempt_at", "last_lease_token", "version", "created_at", "updated_at"
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, 'GUARDIAN', $4::uuid,
           $5::uuid, 777001, 'QUEUED', 0, $6::timestamptz, 0, 1, $6::timestamptz, $6::timestamptz
         )`,
        [
          delivId,
          CENTER_A.centerId,
          evtId,
          CENTER_A.guardianId,
          CENTER_A.studentId,
          nowUtc.toISOString(),
        ],
      );

      const adapterA = new SyntheticNotificationTransportAdapter();
      adapterA.setMode(mode);
      const workerA = new OutboxWorker(workerConfig, workerDb, adapterA);

      const claimedA = await workerA.claimOutboxBatch({ nowUtc, leaseDurationSeconds: 10 });
      assert.equal(claimedA.length, 1);
      assert.equal(claimedA[0].lease_token, 1n);

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

      const linkCheck = await env.apiPool.query<{ status: string }>(
        `SELECT "status"::text AS status FROM "guardian_telegram_links" WHERE "center_id" = $1::uuid AND "guardian_id" = $2::uuid`,
        [CENTER_A.centerId, CENTER_A.guardianId],
      );
      assert.equal(linkCheck.rows[0].status, 'ACTIVE');

      await env.apiPool.query(
        `UPDATE "outbox_events" SET "status" = 'COMPLETED' WHERE "id" = $1::uuid`,
        [evtId],
      );
    }

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
         "target_student_id", "telegram_chat_id", "delivery_status", "attempt_count",
         "next_attempt_at", "last_lease_token", "version", "created_at", "updated_at"
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, 'GUARDIAN', $4::uuid,
         $5::uuid, 777001, 'QUEUED', 0, $6::timestamptz, 0, 1, $6::timestamptz, $6::timestamptz
       )`,
      [
        crashDelivId,
        CENTER_A.centerId,
        crashEvtId,
        CENTER_A.guardianId,
        CENTER_A.studentId,
        nowUtc.toISOString(),
      ],
    );

    const adapterCrash = new SyntheticNotificationTransportAdapter();
    adapterCrash.setMode('CRASH_AFTER_SEND_NO_MEMORY_FLAG');
    const workerCrash = new OutboxWorker(workerConfig, workerDb, adapterCrash);
    await workerCrash.runOutboxTick({ nowUtc });

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

  it('WORKER-IT-12: S04 & T01 suppresses queued PromiseDue delivery when promise is superseded even if invoice still has remaining_debt_uzs > 0 (preserving chk_invoices_remaining_debt_formula), and enforces live staff/guardian authority before send and DLQ replay', async () => {
    await env.apiPool.query(
      `UPDATE "outbox_events" SET "status" = 'COMPLETED' WHERE "center_id" = $1::uuid`,
      [CENTER_A.centerId],
    );

    await insertCenterPolicyVersion({
      notificationPolicyStatus: 'CONFIRMED',
      promiseReminderChannelPolicy: 'CONFIRMED_ADMIN_AND_GUARDIAN',
      effectiveFromDate: '2026-01-01',
    });

    const nowUtc = new Date('2026-11-11T04:10:00.000Z'); // 09:10 Asia/Tashkent
    const fix1 = await createInvoiceAndPromiseFixture({
      remainingDebtUzs: '250000',
      promiseDate: '2026-11-11',
      promiseStatus: 'ACTIVE',
    });

    const remindersWorker = new RemindersWorker(workerConfig, workerDb);
    const remTick = await remindersWorker.runPromiseReminderTick({ nowUtc });
    assert.ok(remTick.emittedPromiseIds.includes(fix1.promiseId));

    // T01 Fix: Record second partial payment of 100,000 UZS + payment_allocations row and update
    // BOTH allocated_paid_uzs = 350,000 and remaining_debt_uzs = 150,000 so chk_invoices_remaining_debt_formula holds!
    const secondPaymentId = crypto.randomUUID();
    const newPromiseId = crypto.randomUUID();
    await env.apiPool.query(
      `INSERT INTO "payments" (
         "id", "center_id", "student_id", "cash_shift_id", "amount_uzs",
         "currency", "payment_method", "recorded_by_admin_id", "idempotency_key", "request_hash"
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 100000, 'UZS', 'CASH', $5::uuid, $6, $7)`,
      [
        secondPaymentId,
        CENTER_A.centerId,
        fix1.studentId,
        fix1.shiftId,
        CENTER_A.adminId,
        `idem-wrk12-pay2-${secondPaymentId.slice(0, 8)}`,
        'd'.repeat(64),
      ],
    );
    await env.apiPool.query(
      `INSERT INTO "payment_allocations" (
         "id", "center_id", "payment_id", "invoice_id", "allocated_amount_uzs"
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 100000)`,
      [crypto.randomUUID(), CENTER_A.centerId, secondPaymentId, fix1.invoiceId],
    );
    await env.apiPool.query(
      `INSERT INTO "promises_to_pay" (
         "id", "center_id", "student_id", "invoice_id", "trigger_payment_id",
         "promised_amount_uzs", "promise_date", "status", "version"
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 150000, '2026-11-18', 'ACTIVE', 1)`,
      [newPromiseId, CENTER_A.centerId, fix1.studentId, fix1.invoiceId, secondPaymentId],
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
      `UPDATE "invoices"
          SET "allocated_paid_uzs" = 350000,
              "remaining_debt_uzs" = 150000,
              "version" = "version" + 1
        WHERE "id" = $1::uuid`,
      [fix1.invoiceId],
    );

    const adapter = new SyntheticNotificationTransportAdapter();
    const outboxWorker = new OutboxWorker(workerConfig, workerDb, adapter);
    await outboxWorker.runOutboxTick({ nowUtc });

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

  it('WORKER-IT-13: S05 & T01 executes real CanonicalSqlBillingCycleWorkerPort inside SchedulesWorker for CALENDAR_MONTH (Feb 2026 28 days vs leap Feb 2028 29 days and PREVIOUS_AND_CURRENT_CYCLE catch-up), ROLLING_MONTH (Jan 31 -> Feb 28 -> Mar 28), and LESSON_PACKAGE_12 (PKG:1 -> PKG:2 with 24 durable allocations)', async () => {
    await insertCenterPolicyVersion({ billingMode: 'ROLLING_MONTH', effectiveFromDate: '2026-01-01' });
    await insertCenterPolicyVersion({ billingMode: 'LESSON_PACKAGE_12', effectiveFromDate: '2026-01-01' });

    const calGroupId = crypto.randomUUID();
    const rollingGroupId = crypto.randomUUID();
    const pkgGroupId = crypto.randomUUID();
    await env.apiPool.query(
      `INSERT INTO "course_groups" (
         "id", "center_id", "course_id", "name", "primary_teacher_id",
         "billing_mode", "current_fee_uzs", "lessons_per_cycle",
         "schedule_days_json", "starts_time", "duration_minutes", "timezone", "status"
       ) VALUES
       ($1::uuid, $4::uuid, $5::uuid, 'GRP-S13-CAL', $6::uuid, 'CALENDAR_PRO_RATA', 500000, 12, '["MON","WED","FRI"]'::jsonb, '09:00', 90, 'Asia/Tashkent', 'ACTIVE'),
       ($2::uuid, $4::uuid, $5::uuid, 'GRP-S13-ROLLING', $6::uuid, 'ROLLING_MONTH', 600000, 12, '["MON","WED","FRI"]'::jsonb, '10:00', 90, 'Asia/Tashkent', 'ACTIVE'),
       ($3::uuid, $4::uuid, $5::uuid, 'GRP-S13-PKG12', $6::uuid, 'LESSON_PACKAGE_12', 480000, 12, '["TUE","THU","SAT"]'::jsonb, '14:00', 90, 'Asia/Tashkent', 'ACTIVE')`,
      [
        calGroupId,
        rollingGroupId,
        pkgGroupId,
        CENTER_A.centerId,
        CENTER_A.courseId,
        CENTER_A.teacher1Id,
      ],
    );

    const calEnrId = crypto.randomUUID();
    const rolEnrId = crypto.randomUUID();
    const pkgEnrId = crypto.randomUUID();
    await env.apiPool.query(
      `INSERT INTO "enrollments" ("id", "center_id", "student_id", "group_id", "status", "enrolled_at_date")
       VALUES
       ($1::uuid, $4::uuid, $5::uuid, $6::uuid, 'ACTIVE', '2026-01-01'),
       ($2::uuid, $4::uuid, $5::uuid, $7::uuid, 'ACTIVE', '2026-01-31'),
       ($3::uuid, $4::uuid, $5::uuid, $8::uuid, 'ACTIVE', '2026-01-01')`,
      [
        calEnrId,
        rolEnrId,
        pkgEnrId,
        CENTER_A.centerId,
        CENTER_A.studentId,
        calGroupId,
        rollingGroupId,
        pkgGroupId,
      ],
    );

    const pkg1LessonIds: string[] = [];
    for (let i = 1; i <= 12; i += 1) {
      const lid = crypto.randomUUID();
      pkg1LessonIds.push(lid);
      const dayStr = `2026-01-${String(i).padStart(2, '0')}`;
      await env.apiPool.query(
        `INSERT INTO "lesson_occurrences" (
           "id", "center_id", "group_id", "lesson_date", "occurrence_seq",
           "starts_at_utc", "ends_at_utc", "status",
           "primary_teacher_snapshot_id", "pay_recipient_teacher_id", "version"
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::date, 1, $5::timestamptz, $6::timestamptz, 'SCHEDULED', $7::uuid, $7::uuid, 1)`,
        [
          lid,
          CENTER_A.centerId,
          pkgGroupId,
          dayStr,
          `${dayStr}T09:00:00Z`,
          `${dayStr}T10:30:00Z`,
          CENTER_A.teacher1Id,
        ],
      );
    }

    const realSchedulesWorker = new SchedulesWorker(workerConfig, workerDb);

    // 1. Run Jan 2026 at 2026-01-31 -> issues CAL 2026-01, ROL:2026-01-31 (2026-01-31..2026-02-27), and PKG:1 (12 allocations)
    const runJan = await realSchedulesWorker.runBillingCycleCutoffAndCatchUpJob({
      nowUtc: new Date('2026-01-31T12:00:00.000Z'),
      cycleKey: '2026-01',
    });
    assert.ok(runJan.invoicesIssuedCount >= 3);

    // 2. Run Feb 2026 at 2026-02-28 -> issues CAL 2026-02 (period_end_date = 2026-02-28) and ROL:2026-02-28 (2026-02-28..2026-03-27)
    const runFeb = await realSchedulesWorker.runBillingCycleCutoffAndCatchUpJob({
      nowUtc: new Date('2026-02-28T12:00:00.000Z'),
      cycleKey: '2026-02',
    });
    assert.ok(runFeb.invoicesIssuedCount >= 2);

    // 3. Run Mar 2026 at 2026-03-28 -> issues CAL 2026-03 and ROL:2026-03-28 (2026-03-28..2026-04-27)
    const runMar = await realSchedulesWorker.runBillingCycleCutoffAndCatchUpJob({
      nowUtc: new Date('2026-03-28T12:00:00.000Z'),
      cycleKey: '2026-03',
    });
    assert.ok(runMar.invoicesIssuedCount >= 2);

    // 4. Consume all 12 lessons of PKG:1, seed 12 new lessons in Feb 2026, and trigger PKG:2 renewal!
    for (const lid of pkg1LessonIds) {
      await env.apiPool.query(
        `INSERT INTO "attendance_records" (
           "id", "center_id", "lesson_id", "student_id", "enrollment_id",
           "status", "is_excused_frozen", "source_channel", "recorded_by_staff_id",
           "client_operation_uuid", "version"
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'PRESENT', FALSE, 'TEACHER_WEB', $6::uuid, $7::uuid, 1)`,
        [
          crypto.randomUUID(),
          CENTER_A.centerId,
          lid,
          CENTER_A.studentId,
          pkgEnrId,
          CENTER_A.teacher1Id,
          crypto.randomUUID(),
        ],
      );
    }
    await env.apiPool.query(
      `UPDATE "enrollments" SET "package_lessons_remaining" = 0 WHERE "id" = $1::uuid`,
      [pkgEnrId],
    );
    for (let i = 1; i <= 12; i += 1) {
      const dayStr = `2026-02-${String(i).padStart(2, '0')}`;
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

    const runPkg2 = await realSchedulesWorker.runBillingCycleCutoffAndCatchUpJob({
      nowUtc: new Date('2026-02-01T12:00:00.000Z'),
      cycleKey: '2026-02',
      periodStartDate: '2026-02-01',
    });
    assert.ok(runPkg2.invoicesIssuedCount >= 1);

    // 5. Verify leap-year Feb 2028 (2028-02-29) and PREVIOUS_AND_CURRENT_CYCLE catch-up at 2028-03-05 issuing both 2028-02 and 2028-03!
    const runCatchup2028 = await realSchedulesWorker.runBillingCycleCutoffAndCatchUpJob({
      nowUtc: new Date('2028-03-05T12:00:00.000Z'),
      cycleKey: '2028-03',
      catchUpPolicy: 'PREVIOUS_AND_CURRENT_CYCLE',
    });
    assert.ok(runCatchup2028.invoicesIssuedCount >= 2);

    const calCycles = await env.apiPool.query<{
      cycle_key: string;
      period_start_date: string;
      period_end_date: string;
    }>(
      `SELECT "cycle_key", "period_start_date"::text AS period_start_date, "period_end_date"::text AS period_end_date
         FROM "billing_cycles"
        WHERE "center_id" = $1::uuid AND "enrollment_id" = $2::uuid
        ORDER BY "cycle_seq" ASC`,
      [CENTER_A.centerId, calEnrId],
    );
    const calByKey = new Map(calCycles.rows.map((r) => [r.cycle_key, r]));
    assert.equal(calByKey.get('2026-02')?.period_end_date.slice(0, 10), '2026-02-28');
    assert.equal(calByKey.get('2028-02')?.period_end_date.slice(0, 10), '2028-02-29');
    assert.equal(calByKey.get('2028-03')?.period_end_date.slice(0, 10), '2028-03-31');

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
    assert.equal(rolCycles.rows[2].period_end_date.slice(0, 10), '2026-04-27');

    const pkgCycles = await env.apiPool.query<{ cycle_key: string; cycle_seq: number }>(
      `SELECT "cycle_key", "cycle_seq"
         FROM "billing_cycles"
        WHERE "center_id" = $1::uuid AND "enrollment_id" = $2::uuid
        ORDER BY "cycle_seq" ASC`,
      [CENTER_A.centerId, pkgEnrId],
    );
    assert.deepEqual(
      pkgCycles.rows.map((r) => r.cycle_key),
      ['PKG:1', 'PKG:2'],
    );

    const pkgAllocCount = await env.apiPool.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt
         FROM "billing_cycle_lesson_allocations"
        WHERE "center_id" = $1::uuid AND "enrollment_id" = $2::uuid`,
      [CENTER_A.centerId, pkgEnrId],
    );
    assert.equal(Number(pkgAllocCount.rows[0].cnt), 24);
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
    await env.apiPool.query(
      `UPDATE "outbox_events" SET "status" = 'COMPLETED' WHERE "center_id" = $1::uuid`,
      [CENTER_A.centerId],
    );

    const lessonTodayId = crypto.randomUUID();
    const lessonOldHistoricalId = crypto.randomUUID();

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

  it('WORKER-IT-16: S02, S07 & T01 selective reconcileRestoredOutbox preserves unapplied internal financial events (AllocationAdjusted) while superseding pre-cutoff notification events, and auto-stages API-emitted notification events', async () => {
    await env.apiPool.query(
      `UPDATE "outbox_events" SET "status" = 'COMPLETED' WHERE "center_id" = $1::uuid`,
      [CENTER_A.centerId],
    );

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
        JSON.stringify({
          invoice_id: fix.invoiceId,
          student_id: fix.studentId,
          new_remaining_debt_uzs: '0',
        }),
        JSON.stringify({ absent_student_ids: [fix.studentId] }),
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

    const adapter = new SyntheticNotificationTransportAdapter();
    const activeWorker = new OutboxWorker(workerConfig, workerDb, adapter);
    await activeWorker.runOutboxTick({ nowUtc: new Date('2026-11-05T02:00:00.000Z') });

    const pCheck = await env.apiPool.query<{ status: string }>(
      `SELECT "status"::text AS status FROM "promises_to_pay" WHERE "id" = $1::uuid`,
      [fix.promiseId],
    );
    assert.equal(pCheck.rows[0].status, 'FULFILLED');
  });

  it('WORKER-IT-17: T02 repeated fixed-clock CURRENT_CYCLE_ONLY polls (12 polls + 2 concurrent workers + restart) never issue historical past cycles or debt for old-start enrollments', async () => {
    const rolGroup17 = crypto.randomUUID();
    const calGroup17 = crypto.randomUUID();
    const rolStu17 = crypto.randomUUID();
    const calStu17 = crypto.randomUUID();
    const rolEnr17 = crypto.randomUUID();
    const calEnr17 = crypto.randomUUID();

    await env.apiPool.query(
      `INSERT INTO "course_groups" (
         "id", "center_id", "course_id", "name", "primary_teacher_id",
         "billing_mode", "current_fee_uzs", "lessons_per_cycle",
         "schedule_days_json", "starts_time", "duration_minutes", "timezone", "status"
       ) VALUES
       ($1::uuid, $3::uuid, $4::uuid, 'GRP-IT17-ROL', $5::uuid, 'ROLLING_MONTH', 600000, 12, '["MON","WED","FRI"]'::jsonb, '10:00', 90, 'Asia/Tashkent', 'ACTIVE'),
       ($2::uuid, $3::uuid, $4::uuid, 'GRP-IT17-CAL', $5::uuid, 'CALENDAR_PRO_RATA', 500000, 12, '["MON","WED","FRI"]'::jsonb, '11:00', 90, 'Asia/Tashkent', 'ACTIVE')`,
      [rolGroup17, calGroup17, CENTER_A.centerId, CENTER_A.courseId, CENTER_A.teacher1Id],
    );
    await env.apiPool.query(
      `INSERT INTO "students" ("id", "center_id", "student_code", "full_name", "normalized_name", "status")
       VALUES
       ($1::uuid, $3::uuid, 'STU-IT17-ROL', 'IT17 Rolling Student', 'it17 rolling student', 'ACTIVE'),
       ($2::uuid, $3::uuid, 'STU-IT17-CAL', 'IT17 Cal Student', 'it17 cal student', 'ACTIVE')`,
      [rolStu17, calStu17, CENTER_A.centerId],
    );
    await env.apiPool.query(
      `INSERT INTO "enrollments" ("id", "center_id", "student_id", "group_id", "status", "enrolled_at_date")
       VALUES
       ($1::uuid, $3::uuid, $4::uuid, $6::uuid, 'ACTIVE', '2026-01-31'),
       ($2::uuid, $3::uuid, $5::uuid, $7::uuid, 'ACTIVE', '2026-01-15')`,
      [rolEnr17, calEnr17, CENTER_A.centerId, rolStu17, calStu17, rolGroup17, calGroup17],
    );

    const fixedNowUtc = new Date('2026-11-05T10:00:00.000Z');
    const schedWorkerA = new SchedulesWorker(workerConfig, workerDb);
    const schedWorkerB = new SchedulesWorker(
      { ...workerConfig, workerId: 'worker-s13-it17-b' },
      workerDb,
    );

    // 1. Run 12 sequential polls at fixed clock 2026-11-05 under CURRENT_CYCLE_ONLY
    for (let i = 0; i < 12; i += 1) {
      await schedWorkerA.runBillingCycleCutoffAndCatchUpJob({
        nowUtc: fixedNowUtc,
        catchUpPolicy: 'CURRENT_CYCLE_ONLY',
      });
    }

    // 2. Run 2 concurrent workers at the same fixed clock
    await Promise.all([
      schedWorkerA.runBillingCycleCutoffAndCatchUpJob({
        nowUtc: fixedNowUtc,
        catchUpPolicy: 'CURRENT_CYCLE_ONLY',
      }),
      schedWorkerB.runBillingCycleCutoffAndCatchUpJob({
        nowUtc: fixedNowUtc,
        catchUpPolicy: 'CURRENT_CYCLE_ONLY',
      }),
    ]);

    // 3. Simulate worker restart with a brand new SchedulesWorker instance
    const restartedWorker = new SchedulesWorker(
      { ...workerConfig, workerId: 'worker-s13-it17-restarted' },
      workerDb,
    );
    await restartedWorker.runBillingCycleCutoffAndCatchUpJob({
      nowUtc: fixedNowUtc,
      catchUpPolicy: 'CURRENT_CYCLE_ONLY',
    });

    const cyclesCheck = await env.apiPool.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt
         FROM "billing_cycles"
        WHERE "center_id" = $1::uuid
          AND "enrollment_id" IN ($2::uuid, $3::uuid)`,
      [CENTER_A.centerId, rolEnr17, calEnr17],
    );
    assert.equal(
      Number(cyclesCheck.rows[0].cnt),
      0,
      'CURRENT_CYCLE_ONLY must issue 0 cycles for unconfirmed historical enrollments across 15 polls and restart',
    );

    const invCheck = await env.apiPool.query<{ cnt: string; debt: string }>(
      `SELECT COUNT(*)::text AS cnt, COALESCE(SUM("remaining_debt_uzs"), 0)::text AS debt
         FROM "invoices"
        WHERE "center_id" = $1::uuid
          AND "enrollment_id" IN ($2::uuid, $3::uuid)`,
      [CENTER_A.centerId, rolEnr17, calEnr17],
    );
    assert.equal(Number(invCheck.rows[0].cnt), 0);
    assert.equal(invCheck.rows[0].debt, '0');

    const deferAudits = await env.apiPool.query<{ entity_id: string }>(
      `SELECT "entity_id"::text AS entity_id
         FROM "audit_logs"
        WHERE "center_id" = $1::uuid
          AND "action" = 'BILLING_HISTORICAL_RECONCILIATION_DEFERRED'
          AND "entity_id" IN ($2::uuid, $3::uuid)`,
      [CENTER_A.centerId, rolEnr17, calEnr17],
    );
    assert.equal(
      deferAudits.rows.length,
      2,
      'Expected exactly 1 deduplicated BILLING_HISTORICAL_RECONCILIATION_DEFERRED audit per historical enrollment',
    );
  });

  it('WORKER-IT-18: T02 enforces PREVIOUS_AND_CURRENT_CYCLE bounded 2-cycle window, blocks unconfirmed older start dates, and issues only newly entered cycle on center date progression', async () => {
    const rolGroup18 = crypto.randomUUID();
    const stuEligible18 = crypto.randomUUID();
    const stuTooOld18 = crypto.randomUUID();
    const enrEligible18 = crypto.randomUUID();
    const enrTooOld18 = crypto.randomUUID();

    await env.apiPool.query(
      `INSERT INTO "course_groups" (
         "id", "center_id", "course_id", "name", "primary_teacher_id",
         "billing_mode", "current_fee_uzs", "lessons_per_cycle",
         "schedule_days_json", "starts_time", "duration_minutes", "timezone", "status"
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, 'GRP-IT18-ROL', $4::uuid, 'ROLLING_MONTH', 600000, 12, '["MON","WED","FRI"]'::jsonb, '10:00', 90, 'Asia/Tashkent', 'ACTIVE')`,
      [rolGroup18, CENTER_A.centerId, CENTER_A.courseId, CENTER_A.teacher1Id],
    );
    await env.apiPool.query(
      `INSERT INTO "students" ("id", "center_id", "student_code", "full_name", "normalized_name", "status")
       VALUES
       ($1::uuid, $3::uuid, 'STU-IT18-ELIG', 'IT18 Eligible Student', 'it18 eligible student', 'ACTIVE'),
       ($2::uuid, $3::uuid, 'STU-IT18-OLD', 'IT18 Old Student', 'it18 old student', 'ACTIVE')`,
      [stuEligible18, stuTooOld18, CENTER_A.centerId],
    );

    // enrEligible18 started 2026-10-10: at reference date 2026-11-15, its [previous, current] window is:
    //   previous: 2026-10-10..2026-11-09
    //   current:  2026-11-10..2026-12-09 (covers 2026-11-15!)
    // enrTooOld18 started 2026-01-31: at 2026-11-15, its first two cycles end 2026-03-27 < 2026-11-15 (outside 2-cycle window!)
    await env.apiPool.query(
      `INSERT INTO "enrollments" ("id", "center_id", "student_id", "group_id", "status", "enrolled_at_date")
       VALUES
       ($1::uuid, $3::uuid, $4::uuid, $6::uuid, 'ACTIVE', '2026-10-10'),
       ($2::uuid, $3::uuid, $5::uuid, $6::uuid, 'ACTIVE', '2026-01-31')`,
      [enrEligible18, enrTooOld18, CENTER_A.centerId, stuEligible18, stuTooOld18, rolGroup18],
    );

    const schedWorker = new SchedulesWorker(workerConfig, workerDb);
    const tNov15 = new Date('2026-11-15T10:00:00.000Z');

    for (let poll = 0; poll < 5; poll += 1) {
      await schedWorker.runBillingCycleCutoffAndCatchUpJob({
        nowUtc: tNov15,
        catchUpPolicy: 'PREVIOUS_AND_CURRENT_CYCLE',
      });
    }

    const eligCycles = await env.apiPool.query<{ cycle_key: string }>(
      `SELECT "cycle_key"
         FROM "billing_cycles"
        WHERE "center_id" = $1::uuid AND "enrollment_id" = $2::uuid
        ORDER BY "cycle_seq" ASC`,
      [CENTER_A.centerId, enrEligible18],
    );
    assert.deepEqual(
      eligCycles.rows.map((r) => r.cycle_key),
      ['ROL:2026-10-10', 'ROL:2026-11-10'],
    );

    const oldCycles = await env.apiPool.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt
         FROM "billing_cycles"
        WHERE "center_id" = $1::uuid AND "enrollment_id" = $2::uuid`,
      [CENTER_A.centerId, enrTooOld18],
    );
    assert.equal(Number(oldCycles.rows[0].cnt), 0);

    // Advance center date to 2026-12-12 -> issues only the newly entered cycle ROL:2026-12-10
    await schedWorker.runBillingCycleCutoffAndCatchUpJob({
      nowUtc: new Date('2026-12-12T10:00:00.000Z'),
      catchUpPolicy: 'CURRENT_CYCLE_ONLY',
    });

    const eligCyclesAfterAdvance = await env.apiPool.query<{ cycle_key: string }>(
      `SELECT "cycle_key"
         FROM "billing_cycles"
        WHERE "center_id" = $1::uuid AND "enrollment_id" = $2::uuid
        ORDER BY "cycle_seq" ASC`,
      [CENTER_A.centerId, enrEligible18],
    );
    assert.deepEqual(
      eligCyclesAfterAdvance.rows.map((r) => r.cycle_key),
      ['ROL:2026-10-10', 'ROL:2026-11-10', 'ROL:2026-12-10'],
    );
  });

  it('WORKER-IT-19: T02 proves single canonical billing engine parity between API and Worker across distinct equivalent enrollments (tariff history, pro-rata HALF_UP, CreditNote cap), fault rollback at all 7 write points, and concurrent API/Worker same-cycle serialization', async () => {
    const grpParity = crypto.randomUUID();
    const stuApi = crypto.randomUUID();
    const stuWrk = crypto.randomUUID();
    const enrApi = crypto.randomUUID();
    const enrWrk = crypto.randomUUID();

    await env.apiPool.query(
      `INSERT INTO "course_groups" (
         "id", "center_id", "course_id", "name", "primary_teacher_id",
         "billing_mode", "due_date_rule", "fixed_due_day", "collection_timing",
         "current_fee_uzs", "lessons_per_cycle", "schedule_days_json",
         "starts_time", "duration_minutes", "timezone", "status"
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, 'GRP-IT19-PARITY', $4::uuid,
         'CALENDAR_PRO_RATA', 'CENTER_FIXED_DAY', 10, 'ARREARS',
         750000, 12, '["MON","WED","FRI"]'::jsonb,
         '15:00', 90, 'Asia/Tashkent', 'ACTIVE'
       )`,
      [grpParity, CENTER_A.centerId, CENTER_A.courseId, CENTER_A.teacher1Id],
    );

    // Historical tariff snapshot: effective_from 2026-04-01 was 600,000 UZS, later raised on 2026-09-01 to 750,000 UZS.
    // Issuing for 2026-05-01 MUST snapshot 600,000 UZS (and effective_from = 2026-04-01), NOT 750,000 UZS!
    await env.apiPool.query(
      `INSERT INTO "course_price_history" (
         "id", "center_id", "course_id", "group_id",
         "previous_fee_uzs", "new_fee_uzs", "effective_from",
         "changed_by_staff_id", "change_reason", "target_version_snapshot"
       ) VALUES
       ($1::uuid, $3::uuid, $4::uuid, $5::uuid, 500000, 600000, '2026-04-01', $6::uuid, 'Spring tariff', 1),
       ($2::uuid, $3::uuid, $4::uuid, $5::uuid, 600000, 750000, '2026-09-01', $6::uuid, 'Autumn tariff', 2)`,
      [
        crypto.randomUUID(),
        crypto.randomUUID(),
        CENTER_A.centerId,
        CENTER_A.courseId,
        grpParity,
        CENTER_A.directorId,
      ],
    );

    await env.apiPool.query(
      `INSERT INTO "students" ("id", "center_id", "student_code", "full_name", "normalized_name", "status")
       VALUES
       ($1::uuid, $3::uuid, 'STU-IT19-API', 'Parity API Student', 'parity api student', 'ACTIVE'),
       ($2::uuid, $3::uuid, 'STU-IT19-WRK', 'Parity Worker Student', 'parity worker student', 'ACTIVE')`,
      [stuApi, stuWrk, CENTER_A.centerId],
    );

    // Partial period enrollment starting 2026-05-15 (mid-month pro-rata)
    await env.apiPool.query(
      `INSERT INTO "enrollments" ("id", "center_id", "student_id", "group_id", "status", "enrolled_at_date")
       VALUES
       ($1::uuid, $3::uuid, $4::uuid, $6::uuid, 'ACTIVE', '2026-05-15'),
       ($2::uuid, $3::uuid, $5::uuid, $6::uuid, 'ACTIVE', '2026-05-15')`,
      [enrApi, enrWrk, CENTER_A.centerId, stuApi, stuWrk, grpParity],
    );

    // Attach identical 120,000 UZS available CreditNote to both enrollments
    await env.apiPool.query(
      `INSERT INTO "credit_notes" (
         "id", "center_id", "student_id", "enrollment_id",
         "credit_reason", "amount_uzs", "source_event_key", "actor_type", "actor_staff_id"
       ) VALUES
       ($1::uuid, $3::uuid, $4::uuid, $6::uuid, 'FREEZE_NEXT_PERIOD_CREDIT', 120000, $8, 'STAFF', $10::uuid),
       ($2::uuid, $3::uuid, $5::uuid, $7::uuid, 'FREEZE_NEXT_PERIOD_CREDIT', 120000, $9, 'STAFF', $10::uuid)`,
      [
        crypto.randomUUID(),
        crypto.randomUUID(),
        CENTER_A.centerId,
        stuApi,
        stuWrk,
        enrApi,
        enrWrk,
        `cn-api-${enrApi.slice(0, 8)}`,
        `cn-wrk-${enrWrk.slice(0, 8)}`,
        CENTER_A.directorId,
      ],
    );

    const issueTime = new Date('2026-05-15T10:00:00.000Z');
    const workerPort = new CanonicalSqlBillingCycleWorkerPort(workerDb, () => issueTime);

    // 1. Fault injection rollback across write points on enrWrk leaves 0 partial rows
    const faultSteps: CanonicalFaultInjectionStep[] = [
      'BILLING_CYCLE',
      'INVOICE',
      'INVOICE_LINES',
      'LEDGER_ENTRY',
      'AUDIT_LOG',
      'OUTBOX_EVENT',
    ];
    for (const step of faultSteps) {
      await assert.rejects(
        () =>
          workerPort.issueWorkerInvoiceForCycle({
            centerId: CENTER_A.centerId,
            enrollmentId: enrWrk,
            cycleType: 'CALENDAR_MONTH',
            cycleKey: '2026-05',
            periodStartDate: '2026-05-01',
            periodEndDate: '2026-05-31',
            systemJobName: 'IT19FaultTest',
            testFaultAfterStep: step,
          }),
        new RegExp(`SIMULATED_S08_FAULT_AFTER_${step}`),
      );
    }
    const zeroCheck = await env.apiPool.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM "invoices" WHERE "enrollment_id" = $1::uuid`,
      [enrWrk],
    );
    assert.equal(Number(zeroCheck.rows[0].cnt), 0);

    // 2. Execute API path on enrApi and Worker path on enrWrk and compare all financial fields!
    const apiRes = await workerDb.runInTransaction((tx) =>
      executeCanonicalBillingCycleIssuanceInTx(tx, {
        centerId: CENTER_A.centerId,
        enrollmentId: enrApi,
        cycleType: 'CALENDAR_MONTH',
        cycleKey: '2026-05',
        periodStartDate: '2026-05-01',
        periodEndDate: '2026-05-31',
        applyAvailableCreditNotes: true,
        actorType: 'STAFF',
        actorStaffId: CENTER_A.adminId,
        actorRole: 'ADMIN',
        systemJobName: null,
        requestId: 'api-parity-it19',
        now: issueTime,
      }),
    );

    await workerPort.issueWorkerInvoiceForCycle({
      centerId: CENTER_A.centerId,
      enrollmentId: enrWrk,
      cycleType: 'CALENDAR_MONTH',
      cycleKey: '2026-05',
      periodStartDate: '2026-05-01',
      periodEndDate: '2026-05-31',
      systemJobName: 'WorkerParityIT19',
    });

    const wrkInvRow = await env.apiPool.query<{
      tariff_snapshot_uzs: string;
      tariff_effective_from_snapshot: string;
      base_pro_rata_charge_uzs: string;
      credit_note_adjustments_uzs: string;
      effective_net_charge_uzs: string;
      remaining_debt_uzs: string;
      billed_lessons: number;
      due_date: string;
    }>(
      `SELECT "tariff_snapshot_uzs"::text AS tariff_snapshot_uzs,
              "tariff_effective_from_snapshot"::text AS tariff_effective_from_snapshot,
              "base_pro_rata_charge_uzs"::text AS base_pro_rata_charge_uzs,
              "credit_note_adjustments_uzs"::text AS credit_note_adjustments_uzs,
              "effective_net_charge_uzs"::text AS effective_net_charge_uzs,
              "remaining_debt_uzs"::text AS remaining_debt_uzs,
              "billed_lessons",
              "due_date"::text AS due_date
         FROM "invoices" WHERE "enrollment_id" = $1::uuid`,
      [enrWrk],
    );
    const w = wrkInvRow.rows[0];
    assert.equal(w.tariff_snapshot_uzs, '600000');
    assert.equal(w.tariff_effective_from_snapshot.slice(0, 10), '2026-04-01');
    assert.equal(w.tariff_snapshot_uzs, apiRes.invoice.tariff_snapshot_uzs);
    assert.equal(w.base_pro_rata_charge_uzs, apiRes.invoice.base_pro_rata_charge_uzs);
    assert.equal(w.credit_note_adjustments_uzs, '120000');
    assert.equal(w.credit_note_adjustments_uzs, apiRes.invoice.credit_note_adjustments_uzs);
    assert.equal(w.effective_net_charge_uzs, apiRes.invoice.effective_net_charge_uzs);
    assert.equal(w.remaining_debt_uzs, apiRes.invoice.remaining_debt_uzs);
    assert.equal(Number(w.billed_lessons), apiRes.invoice.billed_lessons);
    assert.equal(w.due_date.slice(0, 10), apiRes.invoice.due_date);

    // 3. Concurrent API + Worker issuance on the SAME enrollment & cycleKey serializes via FOR UPDATE -> 1 invoice, 0 duplicate ledger entries!
    const [raceApi, raceWrk] = await Promise.all([
      workerDb.runInTransaction((tx) =>
        executeCanonicalBillingCycleIssuanceInTx(tx, {
          centerId: CENTER_A.centerId,
          enrollmentId: enrWrk,
          cycleType: 'CALENDAR_MONTH',
          cycleKey: '2026-06',
          periodStartDate: '2026-06-01',
          periodEndDate: '2026-06-30',
          actorType: 'STAFF',
          actorStaffId: CENTER_A.adminId,
          actorRole: 'ADMIN',
          systemJobName: null,
          requestId: 'race-api-06',
          now: issueTime,
        }),
      ),
      workerPort.issueWorkerInvoiceForCycle({
        centerId: CENTER_A.centerId,
        enrollmentId: enrWrk,
        cycleType: 'CALENDAR_MONTH',
        cycleKey: '2026-06',
        periodStartDate: '2026-06-01',
        periodEndDate: '2026-06-30',
        systemJobName: 'RaceWorker06',
      }),
    ]);
    assert.equal(raceApi.invoice.invoice_id, raceWrk.invoice.invoice_id);
    assert.equal(
      Number(raceApi.replayedByCycleIdentity) + Number(raceWrk.replayedByCycleIdentity),
      1,
    );

    const ledgerJuneCnt = await env.apiPool.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt
         FROM "ledger_entries"
        WHERE "center_id" = $1::uuid AND "invoice_id" = $2::uuid`,
      [CENTER_A.centerId, raceWrk.invoice.invoice_id],
    );
    assert.equal(Number(ledgerJuneCnt.rows[0].cnt), 1);
  });

  it('WORKER-IT-20: T03 enforces feature-specific per-center notification policy (billing CONFIRMED + notif UNCONFIGURED -> 0 intents/0 sends, positive control with policy_version_id provenance, and send-time suppression on expired/revoked/narrowed policy)', async () => {
    await env.apiPool.query(
      `UPDATE "outbox_events" SET "status" = 'COMPLETED' WHERE "center_id" = $1::uuid`,
      [CENTER_A.centerId],
    );

    // 1. Insert a latest policy version where billing is CONFIRMED, but notification_policy_status is UNCONFIGURED (default!)
    await insertCenterPolicyVersion({
      notificationPolicyStatus: 'UNCONFIGURED',
      promiseReminderChannelPolicy: 'UNCONFIGURED_CHANNEL_POLICY',
      effectiveFromDate: '2026-01-01',
    });

    const fixUnconf = await createInvoiceAndPromiseFixture({
      remainingDebtUzs: '280000',
      promiseDate: '2026-11-14',
      promiseStatus: 'ACTIVE',
    });

    const reminders = new RemindersWorker(workerConfig, workerDb);
    const resolvedUnconf = await reminders.resolveEffectiveChannelPolicy(
      undefined,
      '2026-11-14',
    );
    assert.equal(resolvedUnconf, 'UNCONFIGURED_CHANNEL_POLICY');

    await assert.rejects(
      () =>
        reminders.runPromiseReminderTick({
          nowUtc: new Date('2026-11-14T04:05:00.000Z'),
        }),
      /POLICY_DECISION_NOT_CONFIRMED/,
    );

    // Also verify runtime poll mode (allowUnconfiguredDefer: true) defers cleanly with 0 intents and 0 sends
    const deferRes = await reminders.runPromiseReminderTick({
      nowUtc: new Date('2026-11-14T04:05:00.000Z'),
      allowUnconfiguredDefer: true,
    });
    assert.equal(deferRes.unconfiguredChannelPolicyDeferred, true);
    assert.equal(deferRes.remindersEmittedCount, 0);

    const unconfEvents = await env.apiPool.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt
         FROM "outbox_events"
        WHERE "center_id" = $1::uuid
          AND "event_name" = 'PromiseDue'
          AND "aggregate_id" = $2::uuid`,
      [CENTER_A.centerId, fixUnconf.promiseId],
    );
    assert.equal(Number(unconfEvents.rows[0].cnt), 0);

    // 2. Confirm CONFIRMED_ADMIN_AND_GUARDIAN notification policy -> emits PromiseDue with policy_version_id provenance!
    const confirmedPol = await insertCenterPolicyVersion({
      notificationPolicyStatus: 'CONFIRMED',
      promiseReminderChannelPolicy: 'CONFIRMED_ADMIN_AND_GUARDIAN',
      effectiveFromDate: '2026-01-01',
    });

    const emitRes = await reminders.runPromiseReminderTick({
      nowUtc: new Date('2026-11-14T04:05:00.000Z'),
    });
    assert.ok(emitRes.emittedPromiseIds.includes(fixUnconf.promiseId));

    const evtRow = await env.apiPool.query<{
      id: string;
      payload_json: Record<string, unknown>;
    }>(
      `SELECT "id"::text AS id, "payload_json"
         FROM "outbox_events"
        WHERE "center_id" = $1::uuid
          AND "event_name" = 'PromiseDue'
          AND "aggregate_id" = $2::uuid`,
      [CENTER_A.centerId, fixUnconf.promiseId],
    );
    assert.equal(evtRow.rows.length, 1);
    assert.equal(evtRow.rows[0].payload_json.policy_version_id, confirmedPol.policyId);
    assert.equal(evtRow.rows[0].payload_json.policy_version_number, confirmedPol.versionNumber);

    // 3. Before OutboxWorker sends the queued ADMIN + GUARDIAN deliveries, Director narrows center policy
    //    to CONFIRMED_GUARDIAN_ONLY! Send-time check must suppress the queued ADMIN delivery while delivering GUARDIAN!
    await insertCenterPolicyVersion({
      notificationPolicyStatus: 'CONFIRMED',
      promiseReminderChannelPolicy: 'CONFIRMED_GUARDIAN_ONLY',
      effectiveFromDate: '2026-01-01',
    });

    const adapter = new SyntheticNotificationTransportAdapter();
    const outboxWorker = new OutboxWorker(workerConfig, workerDb, adapter);
    await outboxWorker.runOutboxTick({ nowUtc: new Date('2026-11-14T04:06:00.000Z') });

    const delivRows = await env.apiPool.query<{
      recipient_type: string;
      delivery_status: string;
      policy_version_id: string | null;
    }>(
      `SELECT "recipient_type"::text AS recipient_type,
              "delivery_status"::text AS delivery_status,
              "policy_version_id"::text AS policy_version_id
         FROM "notification_deliveries"
        WHERE "outbox_event_id" = $1::uuid`,
      [evtRow.rows[0].id],
    );
    const byType = new Map(delivRows.rows.map((r) => [r.recipient_type, r]));
    assert.equal(byType.get('GUARDIAN')?.delivery_status, 'API_ACCEPTED');
    assert.equal(byType.get('GUARDIAN')?.policy_version_id, confirmedPol.policyId);
    assert.equal(
      byType.get('ADMIN')?.delivery_status,
      'SKIPPED_UNLINKED',
      'Old queued ADMIN intent must be suppressed at send time when policy is narrowed to CONFIRMED_GUARDIAN_ONLY',
    );

    // 4. Expired notification_policy_effective_until suppresses both emission and send-time delivery
    await insertCenterPolicyVersion({
      notificationPolicyStatus: 'CONFIRMED',
      promiseReminderChannelPolicy: 'CONFIRMED_GUARDIAN_ONLY',
      effectiveFromDate: '2026-01-01',
      notificationPolicyEffectiveUntil: '2026-11-13',
    });
    const resolvedExpired = await reminders.resolveEffectiveChannelPolicy(
      undefined,
      '2026-11-14',
    );
    assert.equal(resolvedExpired, 'UNCONFIGURED_CHANNEL_POLICY');
  });

  it('WORKER-IT-21: T04 enforces exact guardian-student child scope and recipient-specific payload projection for batch AttendanceSubmitted (unlinked Child A while Child B stays active -> 0 sends, and zero cross-child leakage in mixed batch)', async () => {
    await env.apiPool.query(
      `UPDATE "outbox_events" SET "status" = 'COMPLETED' WHERE "center_id" = $1::uuid`,
      [CENTER_A.centerId],
    );

    const childA = crypto.randomUUID();
    const childB = crypto.randomUUID();
    const parentShared = crypto.randomUUID();
    const parentOnlyB = crypto.randomUUID();

    await env.apiPool.query(
      `INSERT INTO "students" ("id", "center_id", "student_code", "full_name", "normalized_name", "status")
       VALUES
       ($1::uuid, $3::uuid, 'STU-IT21-A', 'Child A IT21', 'child a it21', 'ACTIVE'),
       ($2::uuid, $3::uuid, 'STU-IT21-B', 'Child B IT21', 'child b it21', 'ACTIVE')`,
      [childA, childB, CENTER_A.centerId],
    );
    await env.apiPool.query(
      `INSERT INTO "guardians" ("id", "center_id", "full_name", "phone_e164", "status")
       VALUES
       ($1::uuid, $3::uuid, 'Parent Shared AB', '+998901119901', 'ACTIVE'),
       ($2::uuid, $3::uuid, 'Parent Only B', '+998901119902', 'ACTIVE')`,
      [parentShared, parentOnlyB, CENTER_A.centerId],
    );
    await env.apiPool.query(
      `INSERT INTO "guardian_students" ("id", "center_id", "guardian_id", "student_id", "relationship", "is_primary_payer", "active")
       VALUES
       ($1::uuid, $4::uuid, $5::uuid, $7::uuid, 'MOTHER', TRUE, TRUE),
       ($2::uuid, $4::uuid, $5::uuid, $8::uuid, 'MOTHER', TRUE, TRUE),
       ($3::uuid, $4::uuid, $6::uuid, $8::uuid, 'FATHER', TRUE, TRUE)`,
      [
        crypto.randomUUID(),
        crypto.randomUUID(),
        crypto.randomUUID(),
        CENTER_A.centerId,
        parentShared,
        parentOnlyB,
        childA,
        childB,
      ],
    );
    await env.apiPool.query(
      `INSERT INTO "guardian_telegram_links" (
         "id", "center_id", "guardian_id", "invite_token_hash",
         "invite_expires_at", "telegram_user_id", "telegram_chat_id",
         "linked_phone_e164", "status"
       ) VALUES
       ($1::uuid, $3::uuid, $4::uuid, $6, '2029-01-01T00:00:00Z', 888001, 888001, '+998901119901', 'ACTIVE'),
       ($2::uuid, $3::uuid, $5::uuid, $7, '2029-01-01T00:00:00Z', 888002, 888002, '+998901119902', 'ACTIVE')`,
      [
        crypto.randomUUID(),
        crypto.randomUUID(),
        CENTER_A.centerId,
        parentShared,
        parentOnlyB,
        crypto.createHash('sha256').update('it21-p1').digest('hex'),
        crypto.createHash('sha256').update('it21-p2').digest('hex'),
      ],
    );

    const nowUtc = new Date('2026-11-15T10:00:00.000Z');

    // Case 1: AttendanceSubmitted queued ONLY for Child A while parentShared is linked to both Child A and Child B.
    // Before OutboxWorker sends, Child A is unlinked from parentShared (while Child B remains active!).
    // Result MUST be 0 sends (SKIPPED_UNLINKED)!
    const evtChildAOnly = crypto.randomUUID();
    await env.apiPool.query(
      `INSERT INTO "outbox_events" (
         "id", "center_id", "event_name", "schema_version",
         "aggregate_type", "aggregate_id", "aggregate_version",
         "dedup_key", "payload_json", "status", "lease_token",
         "occurred_at_utc", "next_attempt_at", "updated_at"
       ) VALUES (
         $1::uuid, $2::uuid, 'AttendanceSubmitted', 1,
         'LessonOccurrence', $3::uuid, 1,
         $4, $5::jsonb, 'PENDING', 0,
         $6::timestamptz, $6::timestamptz, $6::timestamptz
       )`,
      [
        evtChildAOnly,
        CENTER_A.centerId,
        crypto.randomUUID(),
        `AttSub:ChildAOnly:${evtChildAOnly}`,
        JSON.stringify({ absent_student_ids: [childA], late_student_ids: [] }),
        nowUtc.toISOString(),
      ],
    );

    // Unlink Child A from parentShared while Child B remains active = TRUE
    await env.apiPool.query(
      `UPDATE "guardian_students"
          SET "active" = FALSE, "unlinked_at" = $3::timestamptz, "version" = "version" + 1
        WHERE "center_id" = $1::uuid AND "guardian_id" = $2::uuid AND "student_id" = $4::uuid`,
      [CENTER_A.centerId, parentShared, nowUtc.toISOString(), childA],
    );

    const adapter1 = new SyntheticNotificationTransportAdapter();
    const outbox1 = new OutboxWorker(workerConfig, workerDb, adapter1);
    await outbox1.runOutboxTick({ nowUtc });

    assert.equal(
      adapter1.getSentExternalLog().length,
      0,
      'Unlinked Child A must produce 0 sends even though sibling Child B is still actively linked to parentShared',
    );

    // Case 2: Re-link Child A ONLY to parentShared and unlink Child B from parentShared, so:
    //   - parentShared is actively linked ONLY to Child A
    //   - parentOnlyB is actively linked ONLY to Child B
    // Emit a mixed batch AttendanceSubmitted with absent_student_ids: [childA] and late_student_ids: [childB].
    await env.apiPool.query(
      `UPDATE "guardian_students"
          SET "active" = TRUE, "unlinked_at" = NULL, "version" = "version" + 1
        WHERE "center_id" = $1::uuid AND "guardian_id" = $2::uuid AND "student_id" = $3::uuid`,
      [CENTER_A.centerId, parentShared, childA],
    );
    await env.apiPool.query(
      `UPDATE "guardian_students"
          SET "active" = FALSE, "unlinked_at" = $4::timestamptz, "version" = "version" + 1
        WHERE "center_id" = $1::uuid AND "guardian_id" = $2::uuid AND "student_id" = $3::uuid`,
      [CENTER_A.centerId, parentShared, childB, nowUtc.toISOString()],
    );

    const evtMixedBatch = crypto.randomUUID();
    await env.apiPool.query(
      `INSERT INTO "outbox_events" (
         "id", "center_id", "event_name", "schema_version",
         "aggregate_type", "aggregate_id", "aggregate_version",
         "dedup_key", "payload_json", "status", "lease_token",
         "occurred_at_utc", "next_attempt_at", "updated_at"
       ) VALUES (
         $1::uuid, $2::uuid, 'AttendanceSubmitted', 1,
         'LessonOccurrence', $3::uuid, 1,
         $4, $5::jsonb, 'PENDING', 0,
         $6::timestamptz, $6::timestamptz, $6::timestamptz
       )`,
      [
        evtMixedBatch,
        CENTER_A.centerId,
        crypto.randomUUID(),
        `AttSub:Mixed:${evtMixedBatch}`,
        JSON.stringify({
          lesson_id: crypto.randomUUID(),
          absent_student_ids: [childA],
          late_student_ids: [childB],
          records: [
            { student_id: childA, status: 'ABSENT' },
            { student_id: childB, status: 'LATE' },
          ],
        }),
        nowUtc.toISOString(),
      ],
    );

    const adapter2 = new SyntheticNotificationTransportAdapter();
    const outbox2 = new OutboxWorker(workerConfig, workerDb, adapter2);
    await outbox2.runOutboxTick({ nowUtc });

    const sentLogs = adapter2.getSentExternalLog();
    assert.equal(sentLogs.length, 2);
    const sentToParentA = sentLogs.find((s) => s.recipientId === parentShared)!;
    const sentToParentB = sentLogs.find((s) => s.recipientId === parentOnlyB)!;
    assert.ok(sentToParentA);
    assert.ok(sentToParentB);

    assert.deepEqual(sentToParentA.payload.absent_student_ids, [childA]);
    assert.deepEqual(sentToParentA.payload.late_student_ids, []);
    assert.equal(
      JSON.stringify(sentToParentA.payload).includes(childB),
      false,
      'Parent A outgoing DTO must contain zero mention of Child B',
    );

    assert.deepEqual(sentToParentB.payload.absent_student_ids, []);
    assert.deepEqual(sentToParentB.payload.late_student_ids, [childB]);
    assert.equal(
      JSON.stringify(sentToParentB.payload).includes(childA),
      false,
      'Parent B outgoing DTO must contain zero mention of Child A',
    );
  });

  it('WORKER-IT-22: T05 executes real OS subprocess (child_process.spawn) worker crash/recovery with SIGKILL before send vs SIGKILL after send before local DB ACK commit', async () => {
    await env.apiPool.query(
      `UPDATE "outbox_events" SET "status" = 'COMPLETED' WHERE "center_id" = $1::uuid`,
      [CENTER_A.centerId],
    );

    const nowUtc = new Date('2026-11-16T10:00:00.000Z');
    const crashEvtId = crypto.randomUUID();
    const crashDelivId = crypto.randomUUID();
    const observerFile = path.join(
      os.tmpdir(),
      `eduerp_s13_sigkill_obs_${crypto.randomBytes(4).toString('hex')}.json`,
    );

    await env.apiPool.query(
      `INSERT INTO "outbox_events" (
         "id", "center_id", "event_name", "schema_version",
         "aggregate_type", "aggregate_id", "aggregate_version",
         "dedup_key", "payload_json", "status", "lease_token",
         "occurred_at_utc", "next_attempt_at", "updated_at"
       ) VALUES (
         $1::uuid, $2::uuid, 'PromiseDue', 1,
         'PromiseToPay', $3::uuid, 1,
         $4, $5::jsonb, 'PENDING', 0,
         $6::timestamptz, $6::timestamptz, $6::timestamptz
       )`,
      [
        crashEvtId,
        CENTER_A.centerId,
        crypto.randomUUID(),
        `SubprocSigkill:${crashEvtId}`,
        JSON.stringify({
          promise_id: crypto.randomUUID(),
          student_id: CENTER_A.studentId,
          verified_remaining_debt_uzs: '200000',
        }),
        nowUtc.toISOString(),
      ],
    );
    await env.apiPool.query(
      `INSERT INTO "notification_deliveries" (
         "id", "center_id", "outbox_event_id", "recipient_type", "recipient_id",
         "target_student_id", "telegram_chat_id", "delivery_status", "attempt_count",
         "next_attempt_at", "last_lease_token", "version", "created_at", "updated_at"
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, 'GUARDIAN', $4::uuid,
         $5::uuid, 777001, 'QUEUED', 0,
         $6::timestamptz, 0, 1, $6::timestamptz, $6::timestamptz
       )`,
      [
        crashDelivId,
        CENTER_A.centerId,
        crashEvtId,
        CENTER_A.guardianId,
        CENTER_A.studentId,
        nowUtc.toISOString(),
      ],
    );

    // Note: PromiseDue has internal consumer AdminTaskConsumer AND notification delivery!
    // Also ensure promise row exists so PromiseDue pre-send check passes
    const fix22 = await createInvoiceAndPromiseFixture({
      remainingDebtUzs: '200000',
      promiseDate: '2026-11-16',
      promiseStatus: 'OVERDUE_NOTIFIED',
    });
    await insertCenterPolicyVersion({
      notificationPolicyStatus: 'CONFIRMED',
      promiseReminderChannelPolicy: 'CONFIRMED_GUARDIAN_ONLY',
      effectiveFromDate: '2026-01-01',
    });
    await env.apiPool.query(
      `UPDATE "outbox_events"
          SET "aggregate_id" = $2::uuid,
              "payload_json" = $3::jsonb
        WHERE "id" = $1::uuid`,
      [
        crashEvtId,
        fix22.promiseId,
        JSON.stringify({
          promise_id: fix22.promiseId,
          invoice_id: fix22.invoiceId,
          student_id: fix22.studentId,
          verified_remaining_debt_uzs: '200000',
        }),
      ],
    );
    await env.apiPool.query(
      `UPDATE "notification_deliveries" SET "target_student_id" = $2::uuid WHERE "id" = $1::uuid`,
      [crashDelivId, fix22.studentId],
    );

    const workerMainPath = path.resolve(__dirname, '../src/main.js');
    const childScript = `
      const fs = require('node:fs');
      const { loadWorkerEnv } = require(${JSON.stringify(path.resolve(__dirname, '../src/config/env.js'))});
      const { OutboxWorker, WorkerDatabase } = require(${JSON.stringify(workerMainPath)});
      (async () => {
        const cfg = loadWorkerEnv(process.env);
        const db = new WorkerDatabase(cfg);
        const adapter = {
          async sendNotification(req) {
            fs.writeFileSync(${JSON.stringify(observerFile)}, JSON.stringify({
              deliveryId: req.deliveryId,
              leaseToken: req.leaseToken.toString(10),
              pid: process.pid,
            }));
            process.kill(process.pid, 'SIGKILL');
            return { status: 'API_ACCEPTED', telegramMessageId: 1n };
          }
        };
        const worker = new OutboxWorker(cfg, db, adapter);
        await worker.runOutboxTick({
          leaseDurationSeconds: 5,
          nowUtc: new Date(${JSON.stringify(nowUtc.toISOString())}),
        });
      })();
    `;

    const exitMeta = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        const child = spawn(process.execPath, ['-e', childScript], {
          env: {
            ...process.env,
            NODE_ENV: 'test',
            LOG_LEVEL: 'error',
            WORKER_ID: 'worker-subproc-sigkill-01',
            CENTER_ID: CENTER_A.centerId,
            CENTER_SLUG: CENTER_A.centerSlug,
            CENTER_TIMEZONE: 'Asia/Tashkent',
            LICENSE_MODE: 'ACTIVE',
            DATABASE_URL: env.workerDatabaseUrl,
            WORKER_POLL_INTERVAL_MS: '200',
            WORKER_SHUTDOWN_TIMEOUT_MS: '1000',
            BOT_OUTBOUND_ENABLED: 'true',
          },
          stdio: 'ignore',
        });
        child.on('error', reject);
        child.on('exit', (code, signal) => resolve({ code, signal }));
      },
    );

    try {
      assert.equal(exitMeta.signal, 'SIGKILL', 'Subprocess must be terminated by real OS SIGKILL');
      assert.equal(fs.existsSync(observerFile), true, 'External send observer must record send before SIGKILL');

      // Durable pre-send marker (last_lease_token = 1, attempt_count = 1) + AdminTaskConsumer receipt must already be in DB!
      const delivMid = await env.apiPool.query<{
        delivery_status: string;
        last_lease_token: string;
        attempt_count: number;
      }>(
        `SELECT "delivery_status"::text AS delivery_status, "last_lease_token"::text AS last_lease_token, "attempt_count"
           FROM "notification_deliveries" WHERE "id" = $1::uuid`,
        [crashDelivId],
      );
      assert.equal(delivMid.rows[0].delivery_status, 'QUEUED');
      assert.equal(delivMid.rows[0].last_lease_token, '1');
      assert.equal(Number(delivMid.rows[0].attempt_count), 1);

      // After lease expiry (+10s), second worker reclaims, deduplicates AdminTaskConsumer receipt,
      // records EXTERNAL_DELIVERY_AMBIGUOUS_AFTER_SEND, and completes delivery!
      const recoverAdapter = new SyntheticNotificationTransportAdapter();
      const recoverWorker = new OutboxWorker(
        { ...workerConfig, workerId: 'worker-subproc-recover-02' },
        workerDb,
        recoverAdapter,
      );
      const recTick = await recoverWorker.runOutboxTick({
        nowUtc: new Date(nowUtc.getTime() + 10_000),
      });
      assert.equal(recTick.completedCount, 1);

      const receiptCnt = await env.apiPool.query<{ cnt: string }>(
        `SELECT COUNT(*)::text AS cnt
           FROM "outbox_consumer_receipts"
          WHERE "center_id" = $1::uuid AND "outbox_event_id" = $2::uuid`,
        [CENTER_A.centerId, crashEvtId],
      );
      assert.equal(
        Number(receiptCnt.rows[0].cnt),
        1,
        'Internal consumer receipt must be deduplicated across subprocess crash and recovery',
      );

      const ambigAudit = await env.apiPool.query<{
        after_redacted_json: Record<string, unknown>;
      }>(
        `SELECT "after_redacted_json"
           FROM "audit_logs"
          WHERE "center_id" = $1::uuid
            AND "action" = 'EXTERNAL_DELIVERY_AMBIGUOUS_AFTER_SEND'
            AND "entity_id" = $2::uuid`,
        [CENTER_A.centerId, crashDelivId],
      );
      assert.equal(ambigAudit.rows.length, 1);
      assert.equal(ambigAudit.rows[0].after_redacted_json.possible_duplicate_delivery, true);
      assert.equal(ambigAudit.rows[0].after_redacted_json.prior_lease_token, '1');
      assert.equal(ambigAudit.rows[0].after_redacted_json.recovery_lease_token, '2');
    } finally {
      if (fs.existsSync(observerFile)) {
        fs.unlinkSync(observerFile);
      }
    }
  });

  it('WORKER-IT-23: T05 enforces bounded WorkerRuntimeSkeleton.stop() under real PostgreSQL pg_sleep hung query, shares stopPromise across concurrent stop() calls, and differentiates timeout vs graceful logs', async () => {
    const hungConfig: WorkerEnvConfig = {
      ...workerConfig,
      workerId: 'worker-s13-it23-hung',
      pollIntervalMs: 500,
      shutdownTimeoutMs: 250,
    };
    const logs: WorkerLogEvent[] = [];
    const hungDb = new WorkerDatabase(hungConfig);
    const runtime = new WorkerRuntimeSkeleton(
      hungConfig,
      (entry) => logs.push(entry),
      hungDb,
    );

    // Override PromiseReminderJob to run a real 5-second pg_sleep query on PostgreSQL
    (
      runtime.remindersWorker as unknown as {
        runPromiseReminderTick: () => Promise<unknown>;
      }
    ).runPromiseReminderTick = async () => {
      await hungDb.query('SELECT pg_sleep(5)');
    };

    runtime.start();
    const inFlightCycle = runtime.executePollCycle();
    await new Promise((r) => setTimeout(r, 40));

    const startStopMs = Date.now();
    await Promise.all([runtime.stop('SIGTERM'), runtime.stop('SIGINT')]);
    const elapsedStopMs = Date.now() - startStopMs;

    assert.ok(
      elapsedStopMs < 1500,
      `Expected bounded stop() to finish within 1500ms despite pg_sleep(5), took ${elapsedStopMs}ms`,
    );
    assert.equal(runtime.getState(), 'STOPPED');
    assert.equal(runtime.getLastStopOutcome()?.timedOut, true);
    assert.equal(runtime.getLastStopOutcome()?.drainedCleanly, false);
    assert.equal(
      logs.some((l) => l.event === 'worker_stopped_gracefully'),
      false,
      'Timed-out shutdown must not emit worker_stopped_gracefully',
    );
    assert.equal(
      logs.some((l) => l.event === 'worker_shutdown_bounded_timeout'),
      true,
      'Timed-out shutdown must emit worker_shutdown_bounded_timeout',
    );

    // Verify no new outbox claim can occur after stop()
    const postStopClaim = await runtime.outboxWorker.claimOutboxBatch();
    assert.equal(postStopClaim.length, 0);
    await inFlightCycle.catch(() => undefined);
  });

  it('WORKER-IT-24: T05 verifies worker runtime/Dockerfile/package isolation (zero runtime imports from apps/api, explicit pg dependency in apps/worker/package.json, subprocess fail-fast on invalid env, and least-privilege DB role)', async () => {
    const workerSrcDir = path.resolve(__dirname, '../../src');
    const srcFiles = [
      'main.ts',
      'database.ts',
      'outbox.worker.ts',
      'reminders.worker.ts',
      'teacher-ping.worker.ts',
      'schedules.worker.ts',
      'config/env.ts',
    ];
    for (const rel of srcFiles) {
      const candidate = path.join(workerSrcDir, rel);
      if (fs.existsSync(candidate)) {
        const content = fs.readFileSync(candidate, 'utf8');
        assert.equal(
          Array.from(content.matchAll(/(?:\bfrom\s*|\bimport\s*\(|\brequire\s*\()(['\"])([^'\"]+)\1/g)).some((match) => match[2].includes('apps/api') || match[2].includes('@eduerp/api')),
          false,
          `Worker source file ${rel} must not import from apps/api at runtime`,
        );
      }
    }

    const workerPkgPath = path.resolve(__dirname, '../../package.json');
    const workerPkg = JSON.parse(fs.readFileSync(workerPkgPath, 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    assert.equal(workerPkg.dependencies?.pg, '8.23.1');
    assert.equal(workerPkg.devDependencies?.['@types/pg'], '8.23.1');

    // Verify real subprocess fail-fast on invalid worker env
    const mainJs = path.resolve(__dirname, '../src/main.js');
    const badProc = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [mainJs], {
        env: {
          ...process.env,
          WORKER_ID: '!',
          DATABASE_URL: '',
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.on('exit', (code) => resolve({ code, stderr }));
    });
    assert.notEqual(badProc.code, 0);
    assert.match(badProc.stderr, /worker_startup_failed/);
  });
  it('WORKER-IT-25 (manager regression): active course history never overrides group baseline before a future group tariff, and the future group price activates on its own date', async () => {
    const courseId = crypto.randomUUID();
    const groupId = crypto.randomUUID();
    const studentId = crypto.randomUUID();
    const enrollmentId = crypto.randomUUID();
    await env.apiPool.query(
      `INSERT INTO courses (id,center_id,name,default_monthly_fee_uzs,default_lessons_per_cycle,status)
       VALUES ($1,$2,'Manager group precedence course',600000,12,'ACTIVE')`,
      [courseId, CENTER_A.centerId],
    );
    await env.apiPool.query(
      `INSERT INTO course_groups (id,center_id,course_id,name,primary_teacher_id,billing_mode,current_fee_uzs,lessons_per_cycle,schedule_days_json,starts_time,duration_minutes,timezone,status,billing_policy_version_id)
       VALUES ($1,$2,$3,'Manager future group tariff',$4,'CALENDAR_PRO_RATA',300000,12,'["MON","WED","FRI"]','09:00',90,'Asia/Tashkent','ACTIVE',$5)`,
      [groupId, CENTER_A.centerId, courseId, CENTER_A.teacher1Id, CENTER_A.policyId],
    );
    await env.apiPool.query(
      `INSERT INTO students (id,center_id,student_code,full_name,normalized_name,status)
       VALUES ($1,$2,'MGR-TARIFF-25','Synthetic tariff student','synthetic tariff student','ACTIVE')`,
      [studentId, CENTER_A.centerId],
    );
    await env.apiPool.query(
      `INSERT INTO enrollments (id,center_id,student_id,group_id,status,enrolled_at_date)
       VALUES ($1,$2,$3,$4,'ACTIVE','2026-11-01')`,
      [enrollmentId, CENTER_A.centerId, studentId, groupId],
    );
    await env.apiPool.query(
      `INSERT INTO course_price_history (id,center_id,course_id,group_id,previous_fee_uzs,new_fee_uzs,effective_from,changed_by_staff_id,target_version_snapshot)
       VALUES ($1,$2,$3,NULL,480000,600000,'2026-01-01',$4,2),
              ($5,$2,$3,$6,300000,350000,'2026-12-01',$4,2)`,
      [crypto.randomUUID(), CENTER_A.centerId, courseId, CENTER_A.directorId, crypto.randomUUID(), groupId],
    );
    const port = new CanonicalSqlBillingCycleWorkerPort(workerDb);
    const first = await port.issueWorkerInvoiceForCycle({
      centerId: CENTER_A.centerId, enrollmentId, cycleType: 'CALENDAR_MONTH',
      cycleKey: 'CAL:2026-11', periodStartDate: '2026-11-01', systemJobName: 'ManagerTariff25',
    });
    const second = await port.issueWorkerInvoiceForCycle({
      centerId: CENTER_A.centerId, enrollmentId, cycleType: 'CALENDAR_MONTH',
      cycleKey: 'CAL:2026-12', periodStartDate: '2026-12-01', systemJobName: 'ManagerTariff25',
    });
    const snapshots = await env.apiPool.query<{ tariff_snapshot_uzs: string }>(
      `SELECT tariff_snapshot_uzs::text FROM invoices WHERE id = ANY($1::uuid[]) ORDER BY issued_at, invoice_number`,
      [[first.invoice.invoice_id, second.invoice.invoice_id]],
    );
    assert.deepEqual(snapshots.rows.map((row) => row.tariff_snapshot_uzs), ['300000', '350000']);
  });

});
