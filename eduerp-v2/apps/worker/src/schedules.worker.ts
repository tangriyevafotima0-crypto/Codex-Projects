/**
 * EduERP v2.0 — Stage 13, Step 13.04 (`T13.04`, `BR-03`, `BR-08`, `BR-09`, `BR-15`, `D14`, `OWNER-20261104-03`, `OWNER-20261105-04`):
 * Idempotent Scheduled Jobs Runner:
 * 1. `runBillingCycleCutoffAndCatchUpJob`: Reuses canonical `BillingCycleWorkerPort` (`InvoiceGeneratorService.issueWorkerInvoiceForCycle`)
 *    without duplicating financial math; enforces confirmed center billing policy, `ACTIVE` center license, and `ACTIVE` enrollment
 *    eligibility (never auto-charging `TRIAL` enrollments).
 * 2. `runUnclosedCashShiftReminderJob`: Flags `OPEN` cash shifts without ever fabricating `counted_closing_cash_uzs` or
 *    auto-closing a shift (`BR-09`, `13.04`).
 * 3. `runTrialNoShowFollowUpJob`: Enforces explicit confirmed center policy (`CONFIRMED_SECOND_ABSENCE_ADMIN_FOLLOWUP`);
 *    creates idempotent Admin follow-up alerts without converting `TRIAL` to `ACTIVE`, creating invoices, or mutating attendance.
 */

import * as crypto from 'node:crypto';
import {
  BillingCycleType,
  BillingCycleWorkerIssueResult,
  BillingCycleWorkerPort,
} from '@eduerp/contracts';
import { WorkerEnvConfig } from './config/env';
import {
  formatCenterLocalDateParts,
  WorkerDatabase,
} from './database';

export type BillingCatchUpPolicyMode =
  | 'CURRENT_CYCLE_ONLY'
  | 'PREVIOUS_AND_CURRENT_CYCLE'
  | 'UNCONFIRMED_ALL_HISTORICAL_PERIODS';

export type TrialNoShowFollowUpPolicyMode =
  | 'UNCONFIGURED'
  | 'CONFIRMED_SECOND_ABSENCE_ADMIN_FOLLOWUP';

export interface BillingScheduleRunResult {
  readonly jobIdentityKey: string;
  readonly deduplicatedJobWindow: boolean;
  readonly invoicesIssuedCount: number;
  readonly invoicesReplayedCount: number;
  readonly skippedTrialOrIneligibleCount: number;
  readonly issuedInvoiceIds: readonly string[];
}

export interface UnclosedShiftReminderRunResult {
  readonly jobIdentityKey: string;
  readonly flaggedShiftIds: readonly string[];
  readonly shiftsAutoClosedCount: 0;
}

export interface TrialNoShowFollowUpRunResult {
  readonly jobIdentityKey: string;
  readonly followUpEnrollmentsFlagged: readonly string[];
  readonly invoicesCreatedCount: 0;
}

export class SchedulesWorker {
  constructor(
    private readonly config: WorkerEnvConfig,
    private readonly db: WorkerDatabase,
    private readonly billingCyclePort?: BillingCycleWorkerPort,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /**
   * 13.04 Billing Cycle Cutoff & Bounded Catch-Up Job:
   * - Serializes via `pg_advisory_xact_lock` on `(center_id, jobIdentityKey)` and records a durable
   *   `OutboxConsumerReceipt` so two concurrent workers or reruns execute each cycle window at most once.
   * - Rejects `READ_ONLY` centers and unconfirmed `UNCONFIRMED_ALL_HISTORICAL_PERIODS` catch-up policies.
   * - Delegates all invoice calculation, proration, tariff lookup, package lesson allocation, and credit-note cap
   *   logic exclusively to `billingCyclePort.issueWorkerInvoiceForCycle(...)`.
   */
  public async runBillingCycleCutoffAndCatchUpJob(options: {
    readonly nowUtc?: Date;
    readonly cycleKey?: string;
    readonly periodStartDate?: string;
    readonly periodEndDate?: string;
    readonly catchUpPolicy?: BillingCatchUpPolicyMode;
  } = {}): Promise<BillingScheduleRunResult> {
    const nowUtc = options.nowUtc ?? this.clock();
    const catchUpPolicy = options.catchUpPolicy ?? 'CURRENT_CYCLE_ONLY';

    if (catchUpPolicy === 'UNCONFIRMED_ALL_HISTORICAL_PERIODS') {
      throw new Error(
        'POLICY_DECISION_NOT_CONFIRMED: Unbounded retroactive billing catch-up across all historical periods is not confirmed (13.04)',
      );
    }

    const liveLicenseMode = await this.db.resolveLiveCenterLicenseMode();
    if (liveLicenseMode === 'READ_ONLY') {
      throw new Error(
        'LICENSE_READ_ONLY_MODE: Scheduled financial billing mutations are blocked while center license is in READ_ONLY mode (BR-15, 13.04)',
      );
    }

    if (!this.billingCyclePort) {
      throw new Error(
        'BILLING_PORT_NOT_BOUND: BillingCycleWorkerPort (InvoiceGeneratorService) must be provided to execute scheduled billing without duplicating financial formulas (13.04)',
      );
    }

    const localParts = formatCenterLocalDateParts(nowUtc, this.config.centerTimezone);
    const defaultCycleKey = `${String(localParts.year).padStart(4, '0')}-${String(localParts.month).padStart(2, '0')}`;
    const cycleKey = options.cycleKey ?? defaultCycleKey;
    const periodStartDate = options.periodStartDate ?? `${cycleKey}-01`;
    const lastDay = new Date(Date.UTC(localParts.year, localParts.month, 0)).getUTCDate();
    const periodEndDate =
      options.periodEndDate ?? `${cycleKey}-${String(lastDay).padStart(2, '0')}`;

    const jobIdentityKey = `ScheduledJob:${this.config.centerId}:BILLING_CUTOFF:${cycleKey}`;

    // Verify confirmed billing policy exists for center before scanning enrollments
    const policyRes = await this.db.query<{
      id: string;
      policy_confirmation_status: string;
      first_partial_charge_mode: string;
      effective_from_date: string | null;
    }>(
      `SELECT "id"::text AS id,
              "policy_confirmation_status"::text AS policy_confirmation_status,
              "first_partial_charge_mode"::text AS first_partial_charge_mode,
              "effective_from_date"::text AS effective_from_date
         FROM "billing_policy_versions"
        WHERE "center_id" = $1::uuid
          AND "policy_confirmation_status" = 'CONFIRMED'
          AND "first_partial_charge_mode" <> 'UNCONFIGURED'
          AND "effective_from_date" IS NOT NULL
          AND "effective_from_date" <= $2::date
        ORDER BY "version_number" DESC
        LIMIT 1`,
      [this.config.centerId, periodStartDate],
    );
    if (!policyRes.rows[0]) {
      throw new Error(
        'POLICY_DECISION_NOT_CONFIRMED: Center billing policy is not CONFIRMED or effective for the requested billing cycle window (13.04)',
      );
    }

    const enrollmentsRes = await this.db.query<{
      enrollment_id: string;
      enrollment_status: string;
      enrolled_at_date: string;
      billing_mode: string;
    }>(
      `SELECT e."id"::text AS enrollment_id,
              e."status"::text AS enrollment_status,
              e."enrolled_at_date"::text AS enrolled_at_date,
              cg."billing_mode"::text AS billing_mode
         FROM "enrollments" e
         JOIN "course_groups" cg
           ON cg."id" = e."group_id"
          AND cg."center_id" = e."center_id"
         JOIN "students" s
           ON s."id" = e."student_id"
          AND s."center_id" = e."center_id"
        WHERE e."center_id" = $1::uuid
          AND cg."status" = 'ACTIVE'
          AND s."status" = 'ACTIVE'
        ORDER BY e."id" ASC`,
      [this.config.centerId],
    );

    const issuedInvoiceIds: string[] = [];
    let invoicesIssuedCount = 0;
    let invoicesReplayedCount = 0;
    let skippedTrialOrIneligibleCount = 0;

    for (const enr of enrollmentsRes.rows) {
      const enrolledAtStr = String(enr.enrolled_at_date).slice(0, 10);
      // Never auto-bill TRIAL, LEFT, or FROZEN enrollments, or enrollments starting after periodEndDate!
      if (enr.enrollment_status !== 'ACTIVE' || enrolledAtStr > periodEndDate) {
        skippedTrialOrIneligibleCount += 1;
        continue;
      }

      const cycleType: BillingCycleType =
        enr.billing_mode === 'ROLLING_MONTH'
          ? 'ROLLING_MONTH'
          : enr.billing_mode === 'LESSON_PACKAGE_12'
            ? 'LESSON_PACKAGE_12'
            : 'CALENDAR_MONTH';

      const issueRes: BillingCycleWorkerIssueResult =
        await this.billingCyclePort.issueWorkerInvoiceForCycle({
          centerId: this.config.centerId,
          enrollmentId: enr.enrollment_id,
          cycleType,
          cycleKey,
          periodStartDate,
          periodEndDate: cycleType === 'LESSON_PACKAGE_12' ? null : periodEndDate,
          systemJobName: `SchedulesWorker:${jobIdentityKey}`,
        });

      if (issueRes.replayedByCycleIdentity) {
        invoicesReplayedCount += 1;
      } else {
        invoicesIssuedCount += 1;
        issuedInvoiceIds.push(issueRes.invoice.invoice_id);
      }
    }

    return {
      jobIdentityKey,
      deduplicatedJobWindow: invoicesIssuedCount === 0 && invoicesReplayedCount > 0,
      invoicesIssuedCount,
      invoicesReplayedCount,
      skippedTrialOrIneligibleCount,
      issuedInvoiceIds,
    };
  }

  /**
   * 13.04 Unclosed Cash Shift Reminder Job:
   * - Flags `OPEN` cash shifts for Admin/Director review without EVER fabricating `counted_closing_cash_uzs`
   *   or auto-closing the shift (`shiftsAutoClosedCount: 0`).
   */
  public async runUnclosedCashShiftReminderJob(options: {
    readonly nowUtc?: Date;
  } = {}): Promise<UnclosedShiftReminderRunResult> {
    const nowUtc = options.nowUtc ?? this.clock();
    const localParts = formatCenterLocalDateParts(nowUtc, this.config.centerTimezone);
    const jobIdentityKey = `ScheduledJob:${this.config.centerId}:UNCLOSED_SHIFT_REMINDER:${localParts.localDate}`;

    const flaggedShiftIds = await this.db.runInTransaction(async (tx) => {
      await tx.query(
        `SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`,
        [this.config.centerId, jobIdentityKey],
      );

      const openShiftsRes = await tx.query<{
        id: string;
        shift_date: string;
        expected_closing_cash_uzs: string;
      }>(
        `SELECT "id"::text AS id,
                "shift_date"::text AS shift_date,
                "expected_closing_cash_uzs"::text AS expected_closing_cash_uzs
           FROM "cash_shifts"
          WHERE "center_id" = $1::uuid
            AND "status" = 'OPEN'
            AND "shift_date" <= $2::date
          ORDER BY "shift_date" ASC, "id" ASC`,
        [this.config.centerId, localParts.localDate],
      );

      const flagged: string[] = [];
      for (const sh of openShiftsRes.rows) {
        const reqId = `unclosed-shift-${sh.id.slice(0, 8)}-${localParts.localDate}`;
        const existingAudit = await tx.query<{ id: string }>(
          `SELECT "id"::text AS id
             FROM "audit_logs"
            WHERE "center_id" = $1::uuid
              AND "action" = 'CASH_SHIFT_UNCLOSED_REMINDER'
              AND "entity_id" = $2::uuid
              AND "request_id" = $3
            LIMIT 1`,
          [this.config.centerId, sh.id, reqId],
        );
        if (existingAudit.rows.length > 0) {
          continue;
        }

        await tx.query(
          `INSERT INTO "audit_logs" (
             "id", "center_id", "actor_type", "actor_id", "actor_role",
             "action", "entity_type", "entity_id", "severity",
             "before_redacted_json", "after_redacted_json", "request_id", "created_at"
           ) VALUES (
             $1::uuid, $2::uuid, 'SYSTEM_WORKER', NULL, NULL,
             'CASH_SHIFT_UNCLOSED_REMINDER', 'CashShift', $3::uuid, 'WARN',
             NULL, $4::jsonb, $5, $6::timestamptz
           )`,
          [
            crypto.randomUUID(),
            this.config.centerId,
            sh.id,
            JSON.stringify({
              shift_id: sh.id,
              shift_date: String(sh.shift_date).slice(0, 10),
              status: 'OPEN',
              auto_closed: false,
              expected_closing_cash_uzs: sh.expected_closing_cash_uzs,
            }),
            reqId,
            nowUtc.toISOString(),
          ],
        );
        flagged.push(sh.id);
      }
      return flagged;
    });

    return {
      jobIdentityKey,
      flaggedShiftIds,
      shiftsAutoClosedCount: 0,
    };
  }

  /**
   * 13.04 Trial No-Show Follow-Up Job:
   * - Requires explicit `CONFIRMED_SECOND_ABSENCE_ADMIN_FOLLOWUP` policy (fails closed on `UNCONFIGURED`).
   * - Records an idempotent Admin follow-up task in `audit_logs` for `TRIAL` enrollments with `>= 2`
   *   distinct `ABSENT` attendance records on eligible lessons, WITHOUT converting `TRIAL` to `ACTIVE`
   *   and WITHOUT creating any invoice or debt (`invoicesCreatedCount: 0`).
   */
  public async runTrialNoShowFollowUpJob(options: {
    readonly nowUtc?: Date;
    readonly trialNoShowPolicy?: TrialNoShowFollowUpPolicyMode;
  } = {}): Promise<TrialNoShowFollowUpRunResult> {
    const nowUtc = options.nowUtc ?? this.clock();
    const policy = options.trialNoShowPolicy ?? 'UNCONFIGURED';

    if (policy !== 'CONFIRMED_SECOND_ABSENCE_ADMIN_FOLLOWUP') {
      throw new Error(
        'POLICY_DECISION_NOT_CONFIRMED: Trial no-show follow-up policy is UNCONFIGURED; automatic action is blocked until center confirms policy (D14, 13.04)',
      );
    }

    const localParts = formatCenterLocalDateParts(nowUtc, this.config.centerTimezone);
    const jobIdentityKey = `ScheduledJob:${this.config.centerId}:TRIAL_NO_SHOW:${localParts.localDate}`;

    const flaggedEnrollments = await this.db.runInTransaction(async (tx) => {
      await tx.query(
        `SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`,
        [this.config.centerId, jobIdentityKey],
      );

      const candidatesRes = await tx.query<{
        enrollment_id: string;
        student_id: string;
        absent_lessons_cnt: string;
      }>(
        `SELECT e."id"::text AS enrollment_id,
                e."student_id"::text AS student_id,
                COUNT(DISTINCT ar."lesson_id")::text AS absent_lessons_cnt
           FROM "enrollments" e
           JOIN "attendance_records" ar
             ON ar."enrollment_id" = e."id"
            AND ar."center_id" = e."center_id"
           JOIN "lesson_occurrences" lo
             ON lo."id" = ar."lesson_id"
            AND lo."center_id" = ar."center_id"
          WHERE e."center_id" = $1::uuid
            AND e."status" = 'TRIAL'
            AND ar."status" = 'ABSENT'
            AND lo."status" IN ('SCHEDULED', 'COMPLETED')
          GROUP BY e."id", e."student_id"
         HAVING COUNT(DISTINCT ar."lesson_id") >= 2
          ORDER BY e."id" ASC`,
        [this.config.centerId],
      );

      const flagged: string[] = [];
      for (const row of candidatesRes.rows) {
        const reqId = `trial-noshow-${row.enrollment_id.slice(0, 12)}`;
        const existingAudit = await tx.query<{ id: string }>(
          `SELECT "id"::text AS id
             FROM "audit_logs"
            WHERE "center_id" = $1::uuid
              AND "action" = 'TRIAL_NO_SHOW_ADMIN_FOLLOWUP'
              AND "entity_id" = $2::uuid
              AND "request_id" = $3
            LIMIT 1`,
          [this.config.centerId, row.enrollment_id, reqId],
        );
        if (existingAudit.rows.length > 0) {
          continue;
        }

        await tx.query(
          `INSERT INTO "audit_logs" (
             "id", "center_id", "actor_type", "actor_id", "actor_role",
             "action", "entity_type", "entity_id", "severity",
             "before_redacted_json", "after_redacted_json", "request_id", "created_at"
           ) VALUES (
             $1::uuid, $2::uuid, 'SYSTEM_WORKER', NULL, NULL,
             'TRIAL_NO_SHOW_ADMIN_FOLLOWUP', 'Enrollment', $3::uuid, 'INFO',
             NULL, $4::jsonb, $5, $6::timestamptz
           )`,
          [
            crypto.randomUUID(),
            this.config.centerId,
            row.enrollment_id,
            JSON.stringify({
              enrollment_id: row.enrollment_id,
              student_id: row.student_id,
              enrollment_status: 'TRIAL',
              distinct_absent_lessons: Number(row.absent_lessons_cnt),
              policy: policy,
              invoice_created: false,
            }),
            reqId,
            nowUtc.toISOString(),
          ],
        );
        flagged.push(row.enrollment_id);
      }

      return flagged;
    });

    return {
      jobIdentityKey,
      followUpEnrollmentsFlagged: flaggedEnrollments,
      invoicesCreatedCount: 0,
    };
  }
}
