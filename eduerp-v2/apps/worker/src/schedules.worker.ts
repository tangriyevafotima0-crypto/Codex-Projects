/**
 * EduERP v2.0 — Stage 13, Step 13.04 (`T13.04`, `BR-03`, `BR-08`, `BR-09`, `BR-15`, `D14`, `OWNER-20261104-03`, `OWNER-20261105-04`, `S05`):
 * Idempotent Scheduled Jobs Runner & Canonical SQL Billing Cycle Engine (`CanonicalSqlBillingCycleWorkerPort`):
 * 1. `runBillingCycleCutoffAndCatchUpJob`: Uses canonical `BillingCycleWorkerPort` (defaulting to
 *    `CanonicalSqlBillingCycleWorkerPort`) to execute `CALENDAR_MONTH`, `ROLLING_MONTH` (per-enrollment
 *    anniversary/clamped-day progression `Jan 31 -> Feb 28 -> Mar 28` under `OWNER-20261104-03`), and
 *    `LESSON_PACKAGE_12` (`PKG:{seq}` with durable `billing_cycle_lesson_allocations`), supporting both
 *    `CURRENT_CYCLE_ONLY` and `PREVIOUS_AND_CURRENT_CYCLE` bounded catch-up, computing `lastDay` from the
 *    target cycle's year/month (including leap-year Feb 29), and enforcing `ACTIVE` center license and
 *    `ACTIVE` enrollment eligibility (never auto-charging `TRIAL`, `FROZEN`, or `LEFT` enrollments).
 * 2. `runUnclosedCashShiftReminderJob`: Enforces live `center_licenses` (`READ_ONLY` blocked) and flags `OPEN`
 *    cash shifts without ever fabricating `counted_closing_cash_uzs` or auto-closing a shift (`BR-09`, `13.04`).
 * 3. `runTrialNoShowFollowUpJob`: Enforces live `center_licenses` (`READ_ONLY` blocked) and explicit confirmed
 *    center policy (`CONFIRMED_SECOND_ABSENCE_ADMIN_FOLLOWUP`); creates idempotent Admin follow-up alerts
 *    without converting `TRIAL` to `ACTIVE`, creating invoices, or mutating attendance.
 */

import * as crypto from 'node:crypto';
import {
  BillingCycleType,
  BillingCycleWorkerIssueParams,
  BillingCycleWorkerIssueResult,
  BillingCycleWorkerPort,
  BillingMode,
  CancelledLessonProrationMode,
  CollectionTiming,
  DueDateRule,
  FirstPartialChargeMode,
  InvoiceStatus,
  PackageCancelMode,
  RollingMonthEndMode,
  RoundingMode,
} from '@eduerp/contracts';
import { WorkerEnvConfig } from './config/env';
import {
  formatCenterLocalDateParts,
  WorkerDatabase,
  WorkerQueryExecutor,
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

const BILLING_CALCULATION_VERSION = 's08-v2';

type ScheduleDayCode = 'MON' | 'TUE' | 'WED' | 'THU' | 'FRI' | 'SAT' | 'SUN';
const UTC_DAY_TO_SCHEDULE_CODE: readonly ScheduleDayCode[] = [
  'SUN',
  'MON',
  'TUE',
  'WED',
  'THU',
  'FRI',
  'SAT',
];

function formatPgDate(val: unknown): string | null {
  if (val === null || val === undefined || val === '') return null;
  if (val instanceof Date) return val.toISOString().slice(0, 10);
  const s = String(val).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

export function parseIsoDateParts(isoDate: string): {
  readonly year: number;
  readonly month: number;
  readonly day: number;
} {
  const clean = String(isoDate).trim().slice(0, 10);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(clean);
  if (!match) {
    throw new Error(`VALIDATION_ERROR: Invalid ISO date '${isoDate}'`);
  }
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
}

export function formatIsoDateParts(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function isGregorianLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInGregorianMonth(year: number, month: number): number {
  switch (month) {
    case 1:
    case 3:
    case 5:
    case 7:
    case 8:
    case 10:
    case 12:
      return 31;
    case 4:
    case 6:
    case 9:
    case 11:
      return 30;
    case 2:
      return isGregorianLeapYear(year) ? 29 : 28;
    default:
      throw new Error(`VALIDATION_ERROR: Invalid Gregorian month ${month}`);
  }
}

export function addCalendarDaysToIsoDate(isoDate: string, deltaDays: number): string {
  const { year, month, day } = parseIsoDateParts(isoDate);
  const utcMs = Date.UTC(year, month - 1, day) + deltaDays * 86_400_000;
  return new Date(utcMs).toISOString().slice(0, 10);
}

export function computeNextRollingRenewalDate(
  currentBoundaryDate: string,
  rollingMonthEndMode: RollingMonthEndMode = 'CONTINUE_FROM_CLAMPED_DAY',
): {
  readonly nextRenewalDate: string;
  readonly inclusivePeriodEndDate: string;
  readonly resultingDayOfMonth: number;
} {
  if (
    rollingMonthEndMode !== 'CLAMP_LAST_DAY' &&
    rollingMonthEndMode !== 'CONTINUE_FROM_CLAMPED_DAY'
  ) {
    throw new Error(
      `POLICY_DECISION_NOT_CONFIRMED: rolling_month_end_mode '${rollingMonthEndMode}' is not confirmed under OWNER-20261104-03`,
    );
  }
  const { year, month, day } = parseIsoDateParts(currentBoundaryDate);
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const maxDay = daysInGregorianMonth(nextYear, nextMonth);
  const clampedDay = Math.min(day, maxDay);
  const nextRenewalDate = formatIsoDateParts(nextYear, nextMonth, clampedDay);
  const inclusivePeriodEndDate = addCalendarDaysToIsoDate(nextRenewalDate, -1);
  return {
    nextRenewalDate,
    inclusivePeriodEndDate,
    resultingDayOfMonth: clampedDay,
  };
}

function enumerateCalendarDatesInclusive(startDate: string, endDate: string): string[] {
  const start = parseIsoDateParts(startDate);
  const end = parseIsoDateParts(endDate);
  const startMs = Date.UTC(start.year, start.month - 1, start.day);
  const endMs = Date.UTC(end.year, end.month - 1, end.day);
  const result: string[] = [];
  for (let ms = startMs; ms <= endMs; ms += 86_400_000) {
    result.push(new Date(ms).toISOString().slice(0, 10));
  }
  return result;
}

function getIsoDateWeekday(isoDate: string): ScheduleDayCode {
  const { year, month, day } = parseIsoDateParts(isoDate);
  const dayIdx = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return UTC_DAY_TO_SCHEDULE_CODE[dayIdx];
}

function roundRationalHalfUpUzs(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) {
    throw new Error('INVALID_SCHEDULE_ZERO_LESSONS: denominator must be > 0');
  }
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  return remainder * 2n >= denominator ? quotient + 1n : quotient;
}

function resolveCycleDueDateForWorker(params: {
  readonly cycleType: BillingCycleType;
  readonly periodStartDate: string;
  readonly periodEndDate: string | null;
  readonly dueDateRule: DueDateRule;
  readonly fixedDueDay: number | null;
  readonly collectionTiming: CollectionTiming;
  readonly isInitialPartialCycle: boolean;
}): {
  readonly dueDate: string;
  readonly dueDateRule: DueDateRule;
  readonly fixedDueDay: number | null;
  readonly collectionTiming: CollectionTiming;
} {
  if (params.dueDateRule === 'ENROLLMENT_ANNIVERSARY') {
    if (params.collectionTiming === 'ADVANCE') {
      return {
        dueDate: params.periodStartDate,
        dueDateRule: params.dueDateRule,
        fixedDueDay: null,
        collectionTiming: params.collectionTiming,
      };
    }
    const dueDate = params.periodEndDate
      ? addCalendarDaysToIsoDate(params.periodEndDate, 1)
      : computeNextRollingRenewalDate(params.periodStartDate, 'CONTINUE_FROM_CLAMPED_DAY')
          .nextRenewalDate;
    return {
      dueDate,
      dueDateRule: params.dueDateRule,
      fixedDueDay: null,
      collectionTiming: params.collectionTiming,
    };
  }

  const fixedDay = params.fixedDueDay;
  if (fixedDay === null || fixedDay === undefined || fixedDay < 1 || fixedDay > 31) {
    throw new Error(
      'VALIDATION_ERROR: fixed_due_day (1..31) is required when due_date_rule is CENTER_FIXED_DAY',
    );
  }
  const startParts = parseIsoDateParts(params.periodStartDate);
  let targetYear = startParts.year;
  let targetMonth = startParts.month;

  if (params.collectionTiming === 'ARREARS') {
    if (params.cycleType === 'ROLLING_MONTH' || startParts.day > fixedDay) {
      targetYear = startParts.month === 12 ? startParts.year + 1 : startParts.year;
      targetMonth = startParts.month === 12 ? 1 : startParts.month + 1;
    }
  } else if (params.isInitialPartialCycle && startParts.day > fixedDay) {
    throw new Error(
      `POLICY_DECISION_NOT_CONFIRMED: Ambiguous initial prepaid boundary for CENTER_FIXED_DAY=${fixedDay} with ADVANCE timing when period_start_date=${params.periodStartDate} is after day ${fixedDay}`,
    );
  }

  const maxDayInTargetMonth = daysInGregorianMonth(targetYear, targetMonth);
  if (fixedDay > maxDayInTargetMonth) {
    throw new Error(
      `POLICY_DECISION_NOT_CONFIRMED: CENTER_FIXED_DAY=${fixedDay} does not exist in target month ${targetYear}-${String(targetMonth).padStart(2, '0')} (max=${maxDayInTargetMonth})`,
    );
  }
  return {
    dueDate: formatIsoDateParts(targetYear, targetMonth, fixedDay),
    dueDateRule: params.dueDateRule,
    fixedDueDay: fixedDay,
    collectionTiming: params.collectionTiming,
  };
}

/**
 * S05 Canonical SQL BillingCycleWorkerPort:
 * Executes the exact Stage 08 canonical billing cycle & invoice creation transaction against PostgreSQL
 * (`billing_cycles`, `billing_cycle_lesson_allocations`, `invoices`, `invoice_lines`, `credit_note_applications`,
 * `ledger_entries`, `audit_logs`, `outbox_events`) without needing the NestJS DI container or a test mock Map.
 */
export class CanonicalSqlBillingCycleWorkerPort implements BillingCycleWorkerPort {
  constructor(
    private readonly db: WorkerDatabase,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  private async allocateNextInvoiceNumber(
    tx: WorkerQueryExecutor,
    centerId: string,
    periodStartDate: string,
  ): Promise<string> {
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [
      'INVOICE_NUMBER_SEQ',
      centerId,
    ]);
    const ym = periodStartDate.slice(0, 7).replace('-', '');
    const prefix = `INV-${ym}-`;
    const maxRes = await tx.query<{ max_seq: number }>(
      `SELECT COALESCE(
                MAX(
                  CASE
                    WHEN "invoice_number" ~ '^INV-[0-9]{6}-[0-9]{6}$'
                    THEN CAST(SUBSTRING("invoice_number" FROM 12 FOR 6) AS INTEGER)
                    ELSE 0
                  END
                ),
                0
              )::int AS max_seq
         FROM "invoices"
        WHERE "center_id" = $1::uuid
          AND "invoice_number" LIKE $2`,
      [centerId, `${prefix}%`],
    );
    const nextSeq = Number(maxRes.rows[0]?.max_seq ?? 0) + 1;
    return `${prefix}${String(nextSeq).padStart(6, '0')}`;
  }

  private async resolveGroupTariffAsOf(
    tx: WorkerQueryExecutor,
    params: {
      readonly centerId: string;
      readonly courseId: string;
      readonly groupId: string;
      readonly storedCurrentFeeUzs: string;
      readonly asOfDate: string;
    },
  ): Promise<{ readonly effectiveFeeUzs: bigint; readonly effectiveFromSnapshot: string | null }> {
    const histRes = await tx.query<{
      id: string;
      previous_fee_uzs: string;
      new_fee_uzs: string;
      effective_from: unknown;
      target_version_snapshot: number;
      created_at: Date;
    }>(
      `SELECT "id"::text AS id,
              "previous_fee_uzs"::text AS previous_fee_uzs,
              "new_fee_uzs"::text AS new_fee_uzs,
              "effective_from",
              "target_version_snapshot",
              "created_at"
         FROM "course_price_history"
        WHERE "center_id" = $1::uuid
          AND "course_id" = $2::uuid
          AND "group_id" = $3::uuid
        ORDER BY "effective_from" DESC, "target_version_snapshot" DESC, "created_at" DESC, "id" DESC`,
      [params.centerId, params.courseId, params.groupId],
    );

    const rows = histRes.rows.map((r) => ({
      id: r.id,
      previous_fee_uzs: BigInt(r.previous_fee_uzs),
      new_fee_uzs: BigInt(r.new_fee_uzs),
      effective_from: formatPgDate(r.effective_from) ?? params.asOfDate,
    }));

    const activeEntry = rows.find((h) => h.effective_from <= params.asOfDate);
    if (activeEntry) {
      return {
        effectiveFeeUzs: activeEntry.new_fee_uzs,
        effectiveFromSnapshot: activeEntry.effective_from,
      };
    }
    const earliestEntry = rows.length > 0 ? rows[rows.length - 1] : undefined;
    if (earliestEntry) {
      return {
        effectiveFeeUzs: earliestEntry.previous_fee_uzs,
        effectiveFromSnapshot: null,
      };
    }
    return {
      effectiveFeeUzs: BigInt(params.storedCurrentFeeUzs),
      effectiveFromSnapshot: null,
    };
  }

  public async issueWorkerInvoiceForCycle(
    params: BillingCycleWorkerIssueParams,
  ): Promise<BillingCycleWorkerIssueResult> {
    const nowUtc = this.clock();

    return this.db.runInTransaction(async (tx) => {
      // 1. Lock enrollment FOR UPDATE
      const enrRes = await tx.query<{
        id: string;
        center_id: string;
        student_id: string;
        group_id: string;
        status: string;
        enrolled_at_date: unknown;
        first_trial_date: unknown;
        left_at_date: unknown;
      }>(
        `SELECT "id"::text AS id,
                "center_id"::text AS center_id,
                "student_id"::text AS student_id,
                "group_id"::text AS group_id,
                "status"::text AS status,
                "enrolled_at_date"::text AS enrolled_at_date,
                "first_trial_date"::text AS first_trial_date,
                "left_at_date"::text AS left_at_date
           FROM "enrollments"
          WHERE "id" = $1::uuid
            AND "center_id" = $2::uuid
          FOR UPDATE`,
        [params.enrollmentId, params.centerId],
      );
      const enrollment = enrRes.rows[0];
      if (!enrollment) {
        throw new Error(`NOT_FOUND: Enrollment ${params.enrollmentId} not found in center scope`);
      }
      if (enrollment.status !== 'ACTIVE') {
        throw new Error(
          `VALIDATION_ERROR: Cannot issue scheduled billing invoice for non-ACTIVE enrollment status=${enrollment.status}`,
        );
      }
      const effectiveExitDate = formatPgDate(enrollment.left_at_date);
      if (effectiveExitDate && params.periodStartDate > effectiveExitDate) {
        throw new Error(
          `VALIDATION_ERROR: Cannot bill service period starting ${params.periodStartDate} after left_at_date (${effectiveExitDate})`,
        );
      }

      // 2. Check existing cycle by (center_id, enrollment_id, cycle_type, cycle_key)
      const existingRes = await tx.query<{
        cycle_id: string;
        period_start_date: unknown;
        period_end_date: unknown;
        invoice_id: string | null;
        invoice_number: string | null;
        student_id: string | null;
        effective_net_charge_uzs: string | null;
        remaining_debt_uzs: string | null;
        status: string | null;
      }>(
        `SELECT bc."id"::text AS cycle_id,
                bc."period_start_date"::text AS period_start_date,
                bc."period_end_date"::text AS period_end_date,
                i."id"::text AS invoice_id,
                i."invoice_number",
                i."student_id"::text AS student_id,
                i."effective_net_charge_uzs"::text AS effective_net_charge_uzs,
                i."remaining_debt_uzs"::text AS remaining_debt_uzs,
                i."status"::text AS status
           FROM "billing_cycles" bc
           LEFT JOIN "invoices" i
             ON i."billing_cycle_id" = bc."id"
            AND i."center_id" = bc."center_id"
          WHERE bc."center_id" = $1::uuid
            AND bc."enrollment_id" = $2::uuid
            AND bc."cycle_type" = $3
            AND bc."cycle_key" = $4
          LIMIT 1`,
        [params.centerId, params.enrollmentId, params.cycleType, params.cycleKey],
      );
      const existing = existingRes.rows[0];
      if (existing && existing.invoice_id) {
        return {
          invoice: {
            invoice_id: existing.invoice_id,
            invoice_number: existing.invoice_number ?? '',
            student_id: existing.student_id ?? enrollment.student_id,
            enrollment_id: params.enrollmentId,
            billing_cycle_id: existing.cycle_id,
            effective_net_charge_uzs: existing.effective_net_charge_uzs ?? '0',
            remaining_debt_uzs: existing.remaining_debt_uzs ?? '0',
            status: existing.status ?? 'ISSUED_OPEN',
          },
          replayedByCycleIdentity: true,
        };
      }

      // 3. Load group metadata
      const groupRes = await tx.query<{
        id: string;
        course_id: string;
        billing_mode: BillingMode;
        due_date_rule: DueDateRule;
        fixed_due_day: number | null;
        collection_timing: CollectionTiming;
        billing_policy_version_id: string | null;
        current_fee_uzs: string;
        lessons_per_cycle: number;
        schedule_days_json: ScheduleDayCode[];
      }>(
        `SELECT "id"::text AS id,
                "course_id"::text AS course_id,
                "billing_mode"::text AS billing_mode,
                "due_date_rule"::text AS due_date_rule,
                "fixed_due_day",
                "collection_timing"::text AS collection_timing,
                "billing_policy_version_id"::text AS billing_policy_version_id,
                "current_fee_uzs"::text AS current_fee_uzs,
                "lessons_per_cycle",
                "schedule_days_json"
           FROM "course_groups"
          WHERE "id" = $1::uuid AND "center_id" = $2::uuid
          LIMIT 1`,
        [enrollment.group_id, params.centerId],
      );
      const group = groupRes.rows[0];
      if (!group) {
        throw new Error('NOT_FOUND: Course group not found in center scope');
      }

      // 4. Resolve active BillingPolicyVersion for group & periodStartDate
      const policyRes = await tx.query<{
        id: string;
        version_number: number;
        billing_mode: BillingMode;
        first_partial_charge_mode: FirstPartialChargeMode;
        rounding_mode: RoundingMode;
        rolling_month_end_mode: RollingMonthEndMode;
        package_cancel_mode: PackageCancelMode;
        cancelled_lesson_proration_mode: CancelledLessonProrationMode;
        policy_confirmation_status: string;
        effective_from_date: unknown;
      }>(
        group.billing_policy_version_id
          ? `SELECT "id"::text AS id, "version_number", "billing_mode"::text AS billing_mode,
                    "first_partial_charge_mode"::text AS first_partial_charge_mode,
                    "rounding_mode"::text AS rounding_mode,
                    "rolling_month_end_mode"::text AS rolling_month_end_mode,
                    "package_cancel_mode"::text AS package_cancel_mode,
                    "cancelled_lesson_proration_mode"::text AS cancelled_lesson_proration_mode,
                    "policy_confirmation_status"::text AS policy_confirmation_status,
                    "effective_from_date"::text AS effective_from_date
               FROM "billing_policy_versions"
              WHERE "center_id" = $1::uuid AND "id" = $2::uuid
              LIMIT 1`
          : `SELECT "id"::text AS id, "version_number", "billing_mode"::text AS billing_mode,
                    "first_partial_charge_mode"::text AS first_partial_charge_mode,
                    "rounding_mode"::text AS rounding_mode,
                    "rolling_month_end_mode"::text AS rolling_month_end_mode,
                    "package_cancel_mode"::text AS package_cancel_mode,
                    "cancelled_lesson_proration_mode"::text AS cancelled_lesson_proration_mode,
                    "policy_confirmation_status"::text AS policy_confirmation_status,
                    "effective_from_date"::text AS effective_from_date
               FROM "billing_policy_versions"
              WHERE "center_id" = $1::uuid
                AND ("billing_mode" = $2 OR "billing_mode" = 'CALENDAR_PRO_RATA')
                AND "effective_from_date" IS NOT NULL
                AND "effective_from_date" <= $3::date
              ORDER BY CASE WHEN "billing_mode" = $2 THEN 0 ELSE 1 END,
                       "effective_from_date" DESC,
                       "version_number" DESC
              LIMIT 1`,
        group.billing_policy_version_id
          ? [params.centerId, group.billing_policy_version_id]
          : [params.centerId, group.billing_mode, params.periodStartDate],
      );
      const policy = policyRes.rows[0];
      const policyEffectiveFrom = policy ? formatPgDate(policy.effective_from_date) : null;
      if (
        !policy ||
        policy.policy_confirmation_status !== 'CONFIRMED' ||
        !policyEffectiveFrom ||
        policyEffectiveFrom > params.periodStartDate ||
        policy.rounding_mode !== 'HALF_UP_UZS_INT'
      ) {
        throw new Error(
          `POLICY_DECISION_NOT_CONFIRMED: No confirmed billing policy version effective on or before ${params.periodStartDate}`,
        );
      }

      // 5. Inspect previous cycles for this enrollment
      const prevCyclesRes = await tx.query<{
        id: string;
        cycle_key: string;
        cycle_seq: number;
        period_start_date: unknown;
        period_end_date: unknown;
        allocated_lesson_ids_json: unknown;
      }>(
        `SELECT "id"::text AS id,
                "cycle_key",
                "cycle_seq",
                "period_start_date"::text AS period_start_date,
                "period_end_date"::text AS period_end_date,
                "allocated_lesson_ids_json"
           FROM "billing_cycles"
          WHERE "center_id" = $1::uuid
            AND "enrollment_id" = $2::uuid
            AND "cycle_type" = $3
          ORDER BY "cycle_seq" DESC`,
        [params.centerId, params.enrollmentId, params.cycleType],
      );
      const latestPrevCycle = prevCyclesRes.rows[0] ?? null;
      const nextCycleSeq = latestPrevCycle ? Number(latestPrevCycle.cycle_seq) + 1 : 1;

      const enrollmentBillingStartDate =
        formatPgDate(enrollment.first_trial_date) ??
        formatPgDate(enrollment.enrolled_at_date) ??
        params.periodStartDate;

      let resolvedPeriodStart = params.periodStartDate;
      let resolvedPeriodEnd: string | null = params.periodEndDate ?? null;
      let effectiveEnrollmentStart = enrollmentBillingStartDate;
      let isFirstPartialPeriod = false;

      if (params.cycleType === 'CALENDAR_MONTH') {
        const startParts = parseIsoDateParts(params.periodStartDate);
        if (startParts.day !== 1) {
          throw new Error(
            `VALIDATION_ERROR: CALENDAR_MONTH period_start_date (${params.periodStartDate}) must be YYYY-MM-01`,
          );
        }
        const lastDay = daysInGregorianMonth(startParts.year, startParts.month);
        const canonicalEnd = formatIsoDateParts(startParts.year, startParts.month, lastDay);
        resolvedPeriodEnd = params.periodEndDate ?? canonicalEnd;
        if (resolvedPeriodEnd < enrollmentBillingStartDate) {
          throw new Error(
            `VALIDATION_ERROR: Service period ${resolvedPeriodStart}..${resolvedPeriodEnd} ends before service begin date (${enrollmentBillingStartDate})`,
          );
        }
        isFirstPartialPeriod =
          enrollmentBillingStartDate > resolvedPeriodStart &&
          enrollmentBillingStartDate <= resolvedPeriodEnd;
        effectiveEnrollmentStart = isFirstPartialPeriod
          ? enrollmentBillingStartDate
          : resolvedPeriodStart;
      } else if (params.cycleType === 'ROLLING_MONTH') {
        if (
          policy.rolling_month_end_mode !== 'CLAMP_LAST_DAY' &&
          policy.rolling_month_end_mode !== 'CONTINUE_FROM_CLAMPED_DAY'
        ) {
          throw new Error(
            `POLICY_DECISION_NOT_CONFIRMED: rolling_month_end_mode '${policy.rolling_month_end_mode}' is not confirmed`,
          );
        }
        if (latestPrevCycle) {
          const prevEnd = formatPgDate(latestPrevCycle.period_end_date);
          if (prevEnd) {
            const expectedNextStart = addCalendarDaysToIsoDate(prevEnd, 1);
            if (resolvedPeriodStart !== expectedNextStart) {
              throw new Error(
                `VALIDATION_ERROR: ROLLING_MONTH period_start_date (${resolvedPeriodStart}) must chain directly from previous period_end_date (${prevEnd} -> ${expectedNextStart})`,
              );
            }
          }
        }
        const { inclusivePeriodEndDate } = computeNextRollingRenewalDate(
          resolvedPeriodStart,
          policy.rolling_month_end_mode,
        );
        resolvedPeriodEnd = params.periodEndDate ?? inclusivePeriodEndDate;
        if (resolvedPeriodStart < enrollmentBillingStartDate) {
          throw new Error(
            `VALIDATION_ERROR: ROLLING_MONTH period_start_date (${resolvedPeriodStart}) cannot precede service begin date (${enrollmentBillingStartDate})`,
          );
        }
        isFirstPartialPeriod =
          enrollmentBillingStartDate > resolvedPeriodStart &&
          enrollmentBillingStartDate <= resolvedPeriodEnd;
        effectiveEnrollmentStart = isFirstPartialPeriod
          ? enrollmentBillingStartDate
          : resolvedPeriodStart;
      } else {
        if (resolvedPeriodStart < enrollmentBillingStartDate) {
          throw new Error(
            `VALIDATION_ERROR: LESSON_PACKAGE_12 period_start_date (${resolvedPeriodStart}) cannot precede service begin date (${enrollmentBillingStartDate})`,
          );
        }
      }

      // Check overlapping date-bounded cycles
      if (resolvedPeriodEnd !== null) {
        for (const prev of prevCyclesRes.rows) {
          const pStart = formatPgDate(prev.period_start_date);
          const pEnd = formatPgDate(prev.period_end_date);
          if (pStart && pEnd && resolvedPeriodStart <= pEnd && resolvedPeriodEnd >= pStart) {
            throw new Error(
              `VERSION_CONFLICT: Service period ${resolvedPeriodStart}..${resolvedPeriodEnd} overlaps existing cycle '${prev.cycle_key}' (${pStart}..${pEnd})`,
            );
          }
        }
      }

      // Load lesson occurrences in service window
      const lessonWindowEnd = resolvedPeriodEnd ?? '9999-12-31';
      const lessonsRes = await tx.query<{
        id: string;
        lesson_date: unknown;
        occurrence_seq: number;
        status: string;
        rescheduled_from_lesson_id: string | null;
      }>(
        `SELECT "id"::text AS id,
                "lesson_date"::text AS lesson_date,
                "occurrence_seq",
                "status"::text AS status,
                "rescheduled_from_lesson_id"::text AS rescheduled_from_lesson_id
           FROM "lesson_occurrences"
          WHERE "center_id" = $1::uuid
            AND "group_id" = $2::uuid
            AND "lesson_date" >= $3::date
            AND "lesson_date" <= $4::date
          ORDER BY "lesson_date" ASC, "occurrence_seq" ASC, "id" ASC`,
        [params.centerId, group.id, resolvedPeriodStart, lessonWindowEnd],
      );
      const candidateLessons = lessonsRes.rows.map((r) => ({
        id: r.id,
        lesson_date: formatPgDate(r.lesson_date) ?? resolvedPeriodStart,
        occurrence_seq: Number(r.occurrence_seq),
        status: r.status,
        rescheduled_from_lesson_id: r.rescheduled_from_lesson_id,
      }));

      const dueDateResolved = resolveCycleDueDateForWorker({
        cycleType: params.cycleType,
        periodStartDate: resolvedPeriodStart,
        periodEndDate: resolvedPeriodEnd,
        dueDateRule: group.due_date_rule,
        fixedDueDay: group.fixed_due_day !== null ? Number(group.fixed_due_day) : null,
        collectionTiming: group.collection_timing,
        isInitialPartialCycle: nextCycleSeq === 1 && isFirstPartialPeriod,
      });

      const tariffResolved = await this.resolveGroupTariffAsOf(tx, {
        centerId: params.centerId,
        courseId: group.course_id,
        groupId: group.id,
        storedCurrentFeeUzs: group.current_fee_uzs,
        asOfDate: resolvedPeriodStart,
      });

      let plannedLessons = 0;
      let billableLessons = 0;
      let billedLessons = 0;
      let baseChargeUzs = 0n;
      let lineType: 'BASE_TARIFF' | 'PRO_RATA_CALC' = 'BASE_TARIFF';
      let formulaSnapshot = '';
      let packageRemainingToPersist: number | null = null;
      let packageAllocatedLessonIdsToPersist: readonly string[] | null = null;
      let packageConsumedLessonIdsToPersist: readonly string[] | null = null;

      if (params.cycleType === 'LESSON_PACKAGE_12') {
        if (policy.package_cancel_mode === 'UNCONFIGURED') {
          throw new Error(
            'POLICY_DECISION_NOT_CONFIRMED: package_cancel_mode is UNCONFIGURED for LESSON_PACKAGE_12',
          );
        }
        const priorAllocRes = await tx.query<{
          billing_cycle_id: string;
          lesson_id: string;
        }>(
          `SELECT "billing_cycle_id"::text AS billing_cycle_id,
                  "lesson_id"::text AS lesson_id
             FROM "billing_cycle_lesson_allocations"
            WHERE "center_id" = $1::uuid
              AND "enrollment_id" = $2::uuid
            ORDER BY "cycle_seq" ASC, "slot_index" ASC`,
          [params.centerId, params.enrollmentId],
        );
        const persistedByCycle = new Map<string, string[]>();
        for (const r of priorAllocRes.rows) {
          const list = persistedByCycle.get(r.billing_cycle_id) ?? [];
          list.push(r.lesson_id);
          persistedByCycle.set(r.billing_cycle_id, list);
        }
        const excludedPriorLessonIds = new Set<string>();
        for (const prevCycle of [...prevCyclesRes.rows].reverse()) {
          const tableIds = persistedByCycle.get(prevCycle.id) ?? [];
          const jsonIds = Array.isArray(prevCycle.allocated_lesson_ids_json)
            ? (prevCycle.allocated_lesson_ids_json as string[])
            : null;
          if (tableIds.length === 0 && jsonIds === null) {
            throw new Error(
              `POLICY_DECISION_NOT_CONFIRMED: Prior LESSON_PACKAGE_12 cycle '${prevCycle.cycle_key}' has no durable lesson ownership snapshot (L02)`,
            );
          }
          for (const id of tableIds) excludedPriorLessonIds.add(id);
          if (jsonIds) {
            for (const id of jsonIds) excludedPriorLessonIds.add(id);
          }
        }

        let expanded = true;
        while (expanded) {
          expanded = false;
          for (const occ of candidateLessons) {
            if (
              occ.rescheduled_from_lesson_id &&
              excludedPriorLessonIds.has(occ.rescheduled_from_lesson_id) &&
              !excludedPriorLessonIds.has(occ.id)
            ) {
              excludedPriorLessonIds.add(occ.id);
              expanded = true;
            }
          }
        }

        const lpc = Number(group.lessons_per_cycle);
        const eligibleIds: string[] = [];
        for (const occ of candidateLessons) {
          if (excludedPriorLessonIds.has(occ.id) || occ.status === 'RESCHEDULED') continue;
          if (occ.status === 'CANCELLED_BY_CENTER') {
            if (policy.package_cancel_mode === 'CREDIT_NEXT_CYCLE') {
              throw new Error(
                'POLICY_DECISION_NOT_CONFIRMED: LESSON_PACKAGE_12 CREDIT_NEXT_CYCLE is not confirmed (D21)',
              );
            }
            continue;
          }
          if (eligibleIds.length < lpc) {
            eligibleIds.push(occ.id);
          }
        }

        const attendedRes = await tx.query<{ lesson_id: string }>(
          `SELECT DISTINCT ar."lesson_id"::text AS lesson_id
             FROM "attendance_records" ar
             JOIN "lesson_occurrences" lo
               ON lo."id" = ar."lesson_id"
              AND lo."center_id" = ar."center_id"
            WHERE ar."center_id" = $1::uuid
              AND ar."enrollment_id" = $2::uuid
              AND ar."status" IN ('PRESENT', 'LATE')
              AND lo."status" IN ('SCHEDULED', 'COMPLETED')
              AND lo."lesson_date" >= $3::date
              AND lo."lesson_date" <= $4::date`,
          [params.centerId, params.enrollmentId, resolvedPeriodStart, lessonWindowEnd],
        );
        const eligibleSet = new Set(eligibleIds);
        const consumedIds = attendedRes.rows
          .map((r) => r.lesson_id)
          .filter((id) => eligibleSet.has(id))
          .slice(0, lpc);

        plannedLessons = lpc;
        billableLessons = lpc;
        billedLessons = lpc;
        baseChargeUzs = tariffResolved.effectiveFeeUzs;
        lineType = 'BASE_TARIFF';
        formulaSnapshot = `FULL_PERIOD: ${baseChargeUzs.toString(10)} * ${lpc}/${lpc} = ${baseChargeUzs.toString(10)} (HALF_UP_UZS_INT)`;
        packageRemainingToPersist = Math.max(0, lpc - consumedIds.length);
        packageAllocatedLessonIdsToPersist = eligibleIds;
        packageConsumedLessonIdsToPersist = consumedIds;
      } else {
        if (policy.first_partial_charge_mode === 'UNCONFIGURED') {
          throw new Error(
            'POLICY_DECISION_NOT_CONFIRMED: first_partial_charge_mode is UNCONFIGURED',
          );
        }
        const billableFloor =
          effectiveEnrollmentStart > resolvedPeriodStart
            ? effectiveEnrollmentStart
            : resolvedPeriodStart;
        const periodEndStr = resolvedPeriodEnd ?? resolvedPeriodStart;

        if (candidateLessons.length > 0) {
          const eligible = candidateLessons.filter((l) => {
            if (l.status === 'RESCHEDULED') return false;
            if (l.status === 'CANCELLED_BY_CENTER') {
              if (policy.cancelled_lesson_proration_mode === 'UNCONFIGURED') {
                throw new Error(
                  'POLICY_DECISION_NOT_CONFIRMED: cancelled_lesson_proration_mode is UNCONFIGURED',
                );
              }
              if (policy.cancelled_lesson_proration_mode === 'EXCLUDE_CANCELLED_FROM_PLANNED') {
                return false;
              }
            }
            return true;
          });
          if (eligible.length === 0) {
            throw new Error(
              `INVALID_SCHEDULE_ZERO_LESSONS: Zero eligible planned lessons in ${resolvedPeriodStart}..${periodEndStr}`,
            );
          }
          plannedLessons = eligible.length;
          billableLessons = eligible.filter((l) => l.lesson_date >= billableFloor).length;
        } else {
          const schedDays: ScheduleDayCode[] = Array.isArray(group.schedule_days_json)
            ? group.schedule_days_json
            : ['MON', 'WED', 'FRI'];
          const schedSet = new Set<ScheduleDayCode>(schedDays);
          const allDates = enumerateCalendarDatesInclusive(resolvedPeriodStart, periodEndStr);
          const plannedDates = allDates.filter((d) => schedSet.has(getIsoDateWeekday(d)));
          if (plannedDates.length === 0) {
            throw new Error(
              `INVALID_SCHEDULE_ZERO_LESSONS: Zero scheduled lessons in ${resolvedPeriodStart}..${periodEndStr}`,
            );
          }
          plannedLessons = plannedDates.length;
          billableLessons = plannedDates.filter((d) => d >= billableFloor).length;
        }

        const isPartial = isFirstPartialPeriod || billableLessons < plannedLessons;
        if (!isPartial && billableLessons === plannedLessons) {
          billedLessons = plannedLessons;
          baseChargeUzs = tariffResolved.effectiveFeeUzs;
          lineType = 'BASE_TARIFF';
          formulaSnapshot = `FULL_PERIOD: ${baseChargeUzs.toString(10)} * ${plannedLessons}/${plannedLessons} = ${baseChargeUzs.toString(10)} (HALF_UP_UZS_INT)`;
        } else if (policy.first_partial_charge_mode === 'FULL_CYCLE') {
          if (billableLessons === 0) {
            throw new Error(
              'POLICY_DECISION_NOT_CONFIRMED: FULL_CYCLE cannot bill a zero-lesson partial period',
            );
          }
          billedLessons = plannedLessons;
          baseChargeUzs = tariffResolved.effectiveFeeUzs;
          lineType = 'BASE_TARIFF';
          formulaSnapshot = `FULL_CYCLE: ${baseChargeUzs.toString(10)} (remaining_lessons=${billableLessons}/${plannedLessons}, HALF_UP_UZS_INT)`;
        } else {
          billedLessons = billableLessons;
          baseChargeUzs =
            billableLessons === 0
              ? 0n
              : roundRationalHalfUpUzs(
                  tariffResolved.effectiveFeeUzs * BigInt(billableLessons),
                  BigInt(plannedLessons),
                );
          lineType = 'PRO_RATA_CALC';
          formulaSnapshot = `PRO_RATA: ${tariffResolved.effectiveFeeUzs.toString(10)} * ${billableLessons}/${plannedLessons} = ${baseChargeUzs.toString(10)} (HALF_UP_UZS_INT)`;
        }
      }

      // Apply available credit notes up to baseChargeUzs cap
      let totalCreditAppliedUzs = 0n;
      const creditNoteApps: Array<{
        readonly creditNoteId: string;
        readonly appliedAmountUzs: bigint;
        readonly creditReason: string;
      }> = [];

      if (baseChargeUzs > 0n) {
        const cnRes = await tx.query<{
          id: string;
          amount_uzs: string;
          credit_reason: string;
          already_applied_uzs: string;
        }>(
          `SELECT cn."id"::text AS id,
                  cn."amount_uzs"::text AS amount_uzs,
                  cn."credit_reason"::text AS credit_reason,
                  COALESCE(
                    (SELECT SUM(cna."applied_amount_uzs")
                       FROM "credit_note_applications" cna
                      WHERE cna."center_id" = cn."center_id"
                        AND cna."credit_note_id" = cn."id"),
                    0
                  )::text AS already_applied_uzs
             FROM "credit_notes" cn
            WHERE cn."center_id" = $1::uuid
              AND cn."enrollment_id" = $2::uuid
            ORDER BY cn."created_at" ASC, cn."id" ASC`,
          [params.centerId, params.enrollmentId],
        );
        let remCap = baseChargeUzs;
        for (const cn of cnRes.rows) {
          if (remCap <= 0n) break;
          const avail = BigInt(cn.amount_uzs) - BigInt(cn.already_applied_uzs);
          if (avail <= 0n) continue;
          const toApply = avail <= remCap ? avail : remCap;
          totalCreditAppliedUzs += toApply;
          remCap -= toApply;
          creditNoteApps.push({
            creditNoteId: cn.id,
            appliedAmountUzs: toApply,
            creditReason: cn.credit_reason,
          });
        }
      }

      const effectiveNetChargeUzs =
        baseChargeUzs > totalCreditAppliedUzs ? baseChargeUzs - totalCreditAppliedUzs : 0n;
      const remainingDebtUzs = effectiveNetChargeUzs;
      const invoiceStatus: InvoiceStatus = effectiveNetChargeUzs === 0n ? 'PAID' : 'ISSUED_OPEN';

      const billingCycleId = crypto.randomUUID();
      const firstChargeSnapshot =
        policy.first_partial_charge_mode === 'UNCONFIGURED'
          ? 'PRORATE_REMAINING_LESSONS'
          : policy.first_partial_charge_mode;

      await tx.query(
        `INSERT INTO "billing_cycles" (
           "id", "center_id", "enrollment_id", "cycle_type", "cycle_key", "cycle_seq",
           "period_start_date", "period_end_date", "planned_lessons", "billable_lessons",
           "policy_version_id", "due_date_rule_snapshot", "fixed_due_day_snapshot",
           "collection_timing_snapshot", "first_partial_charge_mode_snapshot",
           "allocated_lesson_ids_json", "consumed_lesson_ids_json",
           "calculation_version", "created_at"
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4, $5, $6::int,
           $7::date, $8::date, $9::int, $10::int,
           $11::uuid, $12, $13::smallint,
           $14, $15,
           $16::jsonb, $17::jsonb,
           $18, $19::timestamptz
         )`,
        [
          billingCycleId,
          params.centerId,
          params.enrollmentId,
          params.cycleType,
          params.cycleKey,
          nextCycleSeq,
          resolvedPeriodStart,
          resolvedPeriodEnd,
          plannedLessons,
          billableLessons,
          policy.id,
          dueDateResolved.dueDateRule,
          dueDateResolved.fixedDueDay,
          dueDateResolved.collectionTiming,
          firstChargeSnapshot,
          packageAllocatedLessonIdsToPersist !== null
            ? JSON.stringify(packageAllocatedLessonIdsToPersist)
            : null,
          packageConsumedLessonIdsToPersist !== null
            ? JSON.stringify(packageConsumedLessonIdsToPersist)
            : null,
          BILLING_CALCULATION_VERSION,
          nowUtc.toISOString(),
        ],
      );

      if (
        params.cycleType === 'LESSON_PACKAGE_12' &&
        packageAllocatedLessonIdsToPersist !== null &&
        packageConsumedLessonIdsToPersist !== null
      ) {
        const consumedSet = new Set(packageConsumedLessonIdsToPersist);
        for (let idx = 0; idx < packageAllocatedLessonIdsToPersist.length; idx += 1) {
          const allocLessonId = packageAllocatedLessonIdsToPersist[idx];
          await tx.query(
            `INSERT INTO "billing_cycle_lesson_allocations" (
               "id", "center_id", "billing_cycle_id", "enrollment_id",
               "lesson_id", "cycle_seq", "slot_index", "consumed_by_attendance", "created_at"
             ) VALUES (
               $1::uuid, $2::uuid, $3::uuid, $4::uuid,
               $5::uuid, $6::int, $7::int, $8::boolean, $9::timestamptz
             )`,
            [
              crypto.randomUUID(),
              params.centerId,
              billingCycleId,
              params.enrollmentId,
              allocLessonId,
              nextCycleSeq,
              idx + 1,
              consumedSet.has(allocLessonId),
              nowUtc.toISOString(),
            ],
          );
        }
      }

      const invoiceId = crypto.randomUUID();
      const invoiceNumber = await this.allocateNextInvoiceNumber(
        tx,
        params.centerId,
        resolvedPeriodStart,
      );

      await tx.query(
        `INSERT INTO "invoices" (
           "id", "center_id", "invoice_number", "student_id", "enrollment_id",
           "billing_cycle_id", "policy_version_id", "currency",
           "tariff_snapshot_uzs", "tariff_effective_from_snapshot",
           "base_pro_rata_charge_uzs", "approved_discount_uzs",
           "credit_note_adjustments_uzs", "effective_net_charge_uzs",
           "allocated_paid_uzs", "remaining_debt_uzs",
           "billed_lessons", "frozen_credited_lessons",
           "status", "due_date", "collection_timing_snapshot",
           "calculation_version", "version", "issued_at", "updated_at"
         ) VALUES (
           $1::uuid, $2::uuid, $3, $4::uuid, $5::uuid,
           $6::uuid, $7::uuid, 'UZS',
           $8::bigint, $9::date,
           $10::bigint, 0,
           $11::bigint, $12::bigint,
           0, $13::bigint,
           $14::int, 0,
           $15, $16::date, $17,
           $18, 1, $19::timestamptz, $19::timestamptz
         )`,
        [
          invoiceId,
          params.centerId,
          invoiceNumber,
          enrollment.student_id,
          params.enrollmentId,
          billingCycleId,
          policy.id,
          tariffResolved.effectiveFeeUzs.toString(10),
          tariffResolved.effectiveFromSnapshot,
          baseChargeUzs.toString(10),
          totalCreditAppliedUzs.toString(10),
          effectiveNetChargeUzs.toString(10),
          remainingDebtUzs.toString(10),
          billedLessons,
          invoiceStatus,
          dueDateResolved.dueDate,
          dueDateResolved.collectionTiming,
          BILLING_CALCULATION_VERSION,
          nowUtc.toISOString(),
        ],
      );

      if (params.cycleType === 'ROLLING_MONTH') {
        const anchorDay = Number(resolvedPeriodStart.slice(8, 10));
        await tx.query(
          `UPDATE "enrollments"
              SET "billing_anchor_day" = $1::smallint,
                  "updated_at" = $2::timestamptz
            WHERE "id" = $3::uuid AND "center_id" = $4::uuid`,
          [anchorDay, nowUtc.toISOString(), params.enrollmentId, params.centerId],
        );
      } else if (params.cycleType === 'LESSON_PACKAGE_12' && packageRemainingToPersist !== null) {
        await tx.query(
          `UPDATE "enrollments"
              SET "package_lessons_remaining" = $1::int,
                  "updated_at" = $2::timestamptz
            WHERE "id" = $3::uuid AND "center_id" = $4::uuid`,
          [packageRemainingToPersist, nowUtc.toISOString(), params.enrollmentId, params.centerId],
        );
      }

      await tx.query(
        `INSERT INTO "invoice_lines" (
           "id", "center_id", "invoice_id", "line_type",
           "description", "amount_uzs", "formula_snapshot", "created_at"
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4,
           $5, $6::bigint, $7, $8::timestamptz
         )`,
        [
          crypto.randomUUID(),
          params.centerId,
          invoiceId,
          lineType,
          `${params.cycleType} (${params.cycleKey}) charge (${billedLessons}/${plannedLessons} lessons)`,
          baseChargeUzs.toString(10),
          formulaSnapshot,
          nowUtc.toISOString(),
        ],
      );

      for (const cna of creditNoteApps) {
        await tx.query(
          `INSERT INTO "credit_note_applications" (
             "id", "center_id", "credit_note_id", "unapplied_credit_id",
             "target_invoice_id", "applied_amount_uzs",
             "actor_type", "actor_staff_id", "system_job_name", "created_at"
           ) VALUES (
             $1::uuid, $2::uuid, $3::uuid, NULL,
             $4::uuid, $5::bigint,
             'SYSTEM_WORKER', NULL, $6, $7::timestamptz
           )`,
          [
            crypto.randomUUID(),
            params.centerId,
            cna.creditNoteId,
            invoiceId,
            cna.appliedAmountUzs.toString(10),
            params.systemJobName.slice(0, 64),
            nowUtc.toISOString(),
          ],
        );
        await tx.query(
          `INSERT INTO "invoice_lines" (
             "id", "center_id", "invoice_id", "line_type",
             "description", "amount_uzs", "formula_snapshot", "created_at"
           ) VALUES (
             $1::uuid, $2::uuid, $3::uuid, 'PRIOR_FREEZE_CREDIT',
             $4, $5::bigint, $6, $7::timestamptz
           )`,
          [
            crypto.randomUUID(),
            params.centerId,
            invoiceId,
            `Applied prior credit note ${cna.creditNoteId} (${cna.creditReason})`,
            `-${cna.appliedAmountUzs.toString(10)}`,
            `CREDIT_NOTE_CAP: min(available, remaining_charge) = ${cna.appliedAmountUzs.toString(10)}`,
            nowUtc.toISOString(),
          ],
        );
      }

      await tx.query(
        `INSERT INTO "ledger_entries" (
           "id", "center_id", "entry_type", "student_id", "invoice_id",
           "direction", "amount_uzs", "actor_type", "actor_staff_id",
           "system_job_name", "created_at"
         ) VALUES (
           $1::uuid, $2::uuid, 'INVOICE_ISSUED', $3::uuid, $4::uuid,
           'DEBIT', $5::bigint, 'SYSTEM_WORKER', NULL,
           $6, $7::timestamptz
         )`,
        [
          crypto.randomUUID(),
          params.centerId,
          enrollment.student_id,
          invoiceId,
          baseChargeUzs.toString(10),
          params.systemJobName.slice(0, 64),
          nowUtc.toISOString(),
        ],
      );

      for (const cna of creditNoteApps) {
        await tx.query(
          `INSERT INTO "ledger_entries" (
             "id", "center_id", "entry_type", "student_id", "invoice_id",
             "credit_note_id", "direction", "amount_uzs",
             "actor_type", "actor_staff_id", "system_job_name", "created_at"
           ) VALUES (
             $1::uuid, $2::uuid, 'CREDIT_NOTE_APPLIED', $3::uuid, $4::uuid,
             $5::uuid, 'CREDIT', $6::bigint,
             'SYSTEM_WORKER', NULL, $7, $8::timestamptz
           )`,
          [
            crypto.randomUUID(),
            params.centerId,
            enrollment.student_id,
            invoiceId,
            cna.creditNoteId,
            cna.appliedAmountUzs.toString(10),
            params.systemJobName.slice(0, 64),
            nowUtc.toISOString(),
          ],
        );
      }

      await tx.query(
        `INSERT INTO "audit_logs" (
           "id", "center_id", "actor_type", "actor_id", "actor_role",
           "action", "entity_type", "entity_id", "severity",
           "after_redacted_json", "request_id", "created_at"
         ) VALUES (
           $1::uuid, $2::uuid, 'SYSTEM_WORKER', NULL, NULL,
           'BILLING_CYCLE_INVOICE_ISSUED', 'Invoice', $3::uuid, 'INFO',
           $4::jsonb, $5, $6::timestamptz
         )`,
        [
          crypto.randomUUID(),
          params.centerId,
          invoiceId,
          JSON.stringify({
            invoice_id: invoiceId,
            invoice_number: invoiceNumber,
            enrollment_id: params.enrollmentId,
            billing_cycle_id: billingCycleId,
            cycle_type: params.cycleType,
            cycle_key: params.cycleKey,
            tariff_snapshot_uzs: tariffResolved.effectiveFeeUzs.toString(10),
            base_pro_rata_charge_uzs: baseChargeUzs.toString(10),
            credit_note_adjustments_uzs: totalCreditAppliedUzs.toString(10),
            effective_net_charge_uzs: effectiveNetChargeUzs.toString(10),
            remaining_debt_uzs: remainingDebtUzs.toString(10),
            due_date: dueDateResolved.dueDate,
            policy_version_id: policy.id,
          }),
          `wrk-bill-${invoiceId.slice(0, 8)}`,
          nowUtc.toISOString(),
        ],
      );

      await tx.query(
        `INSERT INTO "outbox_events" (
           "id", "center_id", "event_name", "schema_version",
           "aggregate_type", "aggregate_id", "aggregate_version",
           "dedup_key", "payload_json", "status",
           "next_attempt_at", "occurred_at_utc", "updated_at"
         ) VALUES (
           $1::uuid, $2::uuid, 'AllocationAdjusted', 1,
           'Invoice', $3::uuid, 1,
           $4, $5::jsonb, 'PENDING',
           $6::timestamptz, $6::timestamptz, $6::timestamptz
         )`,
        [
          crypto.randomUUID(),
          params.centerId,
          invoiceId,
          `AllocationAdjusted:${invoiceId}:v1`,
          JSON.stringify({
            invoice_id: invoiceId,
            enrollment_id: params.enrollmentId,
            student_id: enrollment.student_id,
            allocation_id: null,
            allocation_reversal_id: null,
            delta_allocated_uzs: '0',
            new_remaining_debt_uzs: remainingDebtUzs.toString(10),
            invoice_status: invoiceStatus,
          }),
          nowUtc.toISOString(),
        ],
      );

      return {
        invoice: {
          invoice_id: invoiceId,
          invoice_number: invoiceNumber,
          student_id: enrollment.student_id,
          enrollment_id: params.enrollmentId,
          billing_cycle_id: billingCycleId,
          effective_net_charge_uzs: effectiveNetChargeUzs.toString(10),
          remaining_debt_uzs: remainingDebtUzs.toString(10),
          status: invoiceStatus,
        },
        replayedByCycleIdentity: false,
      };
    });
  }
}

export class SchedulesWorker {
  private readonly billingCyclePort: BillingCycleWorkerPort;

  constructor(
    private readonly config: WorkerEnvConfig,
    private readonly db: WorkerDatabase,
    billingCyclePort?: BillingCycleWorkerPort,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.billingCyclePort =
      billingCyclePort ?? new CanonicalSqlBillingCycleWorkerPort(this.db, this.clock);
  }

  /**
   * Resolves the calendar month window (`YYYY-MM`, `YYYY-MM-01`, `YYYY-MM-<lastDay>`) from `cycleKey`
   * or `periodStartDate`, computing `lastDay` from the target cycle's year and month (including leap-year Feb 29)
   * rather than `nowUtc`'s month (`S05`).
   */
  private resolveCalendarMonthWindow(params: {
    readonly cycleKey?: string;
    readonly periodStartDate?: string;
    readonly periodEndDate?: string;
    readonly defaultYear: number;
    readonly defaultMonth: number;
  }): {
    readonly cycleKey: string;
    readonly periodStartDate: string;
    readonly periodEndDate: string;
    readonly year: number;
    readonly month: number;
  } {
    let year = params.defaultYear;
    let month = params.defaultMonth;
    let rawKey = params.cycleKey?.trim();

    if (params.periodStartDate) {
      const p = parseIsoDateParts(params.periodStartDate);
      year = p.year;
      month = p.month;
    } else if (rawKey) {
      const m = /^(?:CAL:)?(\d{4})-(\d{2})$/.exec(rawKey);
      if (m) {
        year = Number(m[1]);
        month = Number(m[2]);
      }
    }

    const ym = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`;
    const cycleKey = rawKey ?? ym;
    const periodStartDate = params.periodStartDate ?? `${ym}-01`;
    const lastDay = daysInGregorianMonth(year, month);
    const periodEndDate = params.periodEndDate ?? formatIsoDateParts(year, month, lastDay);

    return { cycleKey, periodStartDate, periodEndDate, year, month };
  }

  /**
   * 13.04 Billing Cycle Cutoff & Bounded Catch-Up Job (`S05`):
   * - Serializes via `pg_advisory_xact_lock` on `(center_id, jobIdentityKey)` so two concurrent workers
   *   never duplicate cycle generation.
   * - Rejects `READ_ONLY` (or missing) center licenses and unconfirmed `UNCONFIRMED_ALL_HISTORICAL_PERIODS` catch-up policies.
   * - Supports `CALENDAR_MONTH`, `ROLLING_MONTH` (per-enrollment anniversary/clamped-day progression `Jan 31 -> Feb 28 -> Mar 28`),
   *   and `LESSON_PACKAGE_12` (`PKG:{seq}` renewal when prior package is exhausted or no package exists yet).
   * - Supports both `CURRENT_CYCLE_ONLY` and `PREVIOUS_AND_CURRENT_CYCLE` bounded catch-up.
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

    const localParts = formatCenterLocalDateParts(nowUtc, this.config.centerTimezone);
    const currentCalWindow = this.resolveCalendarMonthWindow({
      cycleKey: options.cycleKey,
      periodStartDate: options.periodStartDate,
      periodEndDate: options.periodEndDate,
      defaultYear: localParts.year,
      defaultMonth: localParts.month,
    });

    const calendarWindowsToRun: Array<{
      readonly cycleKey: string;
      readonly periodStartDate: string;
      readonly periodEndDate: string;
    }> = [];

    if (catchUpPolicy === 'PREVIOUS_AND_CURRENT_CYCLE') {
      const prevYear =
        currentCalWindow.month === 1 ? currentCalWindow.year - 1 : currentCalWindow.year;
      const prevMonth = currentCalWindow.month === 1 ? 12 : currentCalWindow.month - 1;
      const prevWindow = this.resolveCalendarMonthWindow({
        defaultYear: prevYear,
        defaultMonth: prevMonth,
      });
      calendarWindowsToRun.push(prevWindow);
    }
    calendarWindowsToRun.push(currentCalWindow);

    const jobIdentityKey = `ScheduledJob:${this.config.centerId}:BILLING_CUTOFF:${currentCalWindow.cycleKey}`;

    // Verify confirmed billing policy exists for center before scanning enrollments
    const policyRes = await this.db.query<{
      id: string;
      policy_confirmation_status: string;
      first_partial_charge_mode: string;
      rolling_month_end_mode: RollingMonthEndMode;
      effective_from_date: string | null;
    }>(
      `SELECT "id"::text AS id,
              "policy_confirmation_status"::text AS policy_confirmation_status,
              "first_partial_charge_mode"::text AS first_partial_charge_mode,
              "rolling_month_end_mode"::text AS rolling_month_end_mode,
              "effective_from_date"::text AS effective_from_date
         FROM "billing_policy_versions"
        WHERE "center_id" = $1::uuid
          AND "policy_confirmation_status" = 'CONFIRMED'
          AND "effective_from_date" IS NOT NULL
          AND "effective_from_date" <= $2::date
        ORDER BY "version_number" DESC
        LIMIT 1`,
      [this.config.centerId, currentCalWindow.periodStartDate],
    );
    const activePolicy = policyRes.rows[0];
    if (!activePolicy) {
      throw new Error(
        'POLICY_DECISION_NOT_CONFIRMED: Center billing policy is not CONFIRMED or effective for the requested billing cycle window (13.04)',
      );
    }

    const enrollmentsRes = await this.db.query<{
      enrollment_id: string;
      enrollment_status: string;
      enrolled_at_date: string;
      first_trial_date: string | null;
      left_at_date: string | null;
      package_lessons_remaining: number | null;
      billing_mode: string;
    }>(
      `SELECT e."id"::text AS enrollment_id,
              e."status"::text AS enrollment_status,
              e."enrolled_at_date"::text AS enrolled_at_date,
              e."first_trial_date"::text AS first_trial_date,
              e."left_at_date"::text AS left_at_date,
              e."package_lessons_remaining",
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
      const enrolledAtStr = String(enr.first_trial_date ?? enr.enrolled_at_date).slice(0, 10);
      const leftAtStr = formatPgDate(enr.left_at_date);

      if (enr.enrollment_status !== 'ACTIVE') {
        skippedTrialOrIneligibleCount += 1;
        continue;
      }

      if (enr.billing_mode === 'ROLLING_MONTH') {
        // S05: Per-enrollment rolling anniversary / clamped-day chain (Jan 31 -> Feb 28 -> Mar 28)
        const prevRolRes = await this.db.query<{
          cycle_key: string;
          cycle_seq: number;
          period_start_date: unknown;
          period_end_date: unknown;
        }>(
          `SELECT "cycle_key", "cycle_seq", "period_start_date", "period_end_date"
             FROM "billing_cycles"
            WHERE "center_id" = $1::uuid
              AND "enrollment_id" = $2::uuid
              AND "cycle_type" = 'ROLLING_MONTH'
            ORDER BY "cycle_seq" DESC`,
          [this.config.centerId, enr.enrollment_id],
        );

        const cutoffHorizonDate = options.periodStartDate ?? localParts.localDate;
        if (enrolledAtStr > cutoffHorizonDate) {
          skippedTrialOrIneligibleCount += 1;
          continue;
        }

        const maxCyclesToEvaluate = catchUpPolicy === 'PREVIOUS_AND_CURRENT_CYCLE' ? 2 : 1;
        let latestEnd = prevRolRes.rows[0]
          ? formatPgDate(prevRolRes.rows[0].period_end_date)
          : null;

        if (!latestEnd) {
          // First rolling cycle starts at enrollment service begin date
          let cursorStart = enrolledAtStr;
          for (let step = 0; step < maxCyclesToEvaluate; step += 1) {
            if (cursorStart > cutoffHorizonDate) break;
            if (leftAtStr && cursorStart > leftAtStr) break;
            const { inclusivePeriodEndDate, nextRenewalDate } = computeNextRollingRenewalDate(
              cursorStart,
              activePolicy.rolling_month_end_mode,
            );
            const rolKey = `ROL:${cursorStart}`;
            const issueRes = await this.billingCyclePort.issueWorkerInvoiceForCycle({
              centerId: this.config.centerId,
              enrollmentId: enr.enrollment_id,
              cycleType: 'ROLLING_MONTH',
              cycleKey: rolKey,
              periodStartDate: cursorStart,
              periodEndDate: inclusivePeriodEndDate,
              systemJobName: `SchedulesWorker:${jobIdentityKey}`.slice(0, 64),
            });
            if (issueRes.replayedByCycleIdentity) {
              invoicesReplayedCount += 1;
            } else {
              invoicesIssuedCount += 1;
              issuedInvoiceIds.push(issueRes.invoice.invoice_id);
            }
            cursorStart = nextRenewalDate;
          }
        } else {
          const nextStart = addCalendarDaysToIsoDate(latestEnd, 1);
          if (nextStart <= cutoffHorizonDate && (!leftAtStr || nextStart <= leftAtStr)) {
            const { inclusivePeriodEndDate } = computeNextRollingRenewalDate(
              nextStart,
              activePolicy.rolling_month_end_mode,
            );
            const rolKey = `ROL:${nextStart}`;
            const issueRes = await this.billingCyclePort.issueWorkerInvoiceForCycle({
              centerId: this.config.centerId,
              enrollmentId: enr.enrollment_id,
              cycleType: 'ROLLING_MONTH',
              cycleKey: rolKey,
              periodStartDate: nextStart,
              periodEndDate: inclusivePeriodEndDate,
              systemJobName: `SchedulesWorker:${jobIdentityKey}`.slice(0, 64),
            });
            if (issueRes.replayedByCycleIdentity) {
              invoicesReplayedCount += 1;
            } else {
              invoicesIssuedCount += 1;
              issuedInvoiceIds.push(issueRes.invoice.invoice_id);
            }
          } else {
            // Replay latest cycle if its start matches the requested horizon so rerun deduplication is observable
            const latestRow = prevRolRes.rows[0];
            const latestStart = formatPgDate(latestRow.period_start_date) ?? enrolledAtStr;
            const latestEndStr = formatPgDate(latestRow.period_end_date);
            const issueRes = await this.billingCyclePort.issueWorkerInvoiceForCycle({
              centerId: this.config.centerId,
              enrollmentId: enr.enrollment_id,
              cycleType: 'ROLLING_MONTH',
              cycleKey: latestRow.cycle_key,
              periodStartDate: latestStart,
              periodEndDate: latestEndStr,
              systemJobName: `SchedulesWorker:${jobIdentityKey}`.slice(0, 64),
            });
            if (issueRes.replayedByCycleIdentity) {
              invoicesReplayedCount += 1;
            }
          }
        }
        continue;
      }

      if (enr.billing_mode === 'LESSON_PACKAGE_12') {
        // S05: Per-enrollment package cycle (PKG:1, PKG:2, ...)
        const prevPkgRes = await this.db.query<{
          cycle_key: string;
          cycle_seq: number;
          period_start_date: unknown;
        }>(
          `SELECT "cycle_key", "cycle_seq", "period_start_date"
             FROM "billing_cycles"
            WHERE "center_id" = $1::uuid
              AND "enrollment_id" = $2::uuid
              AND "cycle_type" = 'LESSON_PACKAGE_12'
            ORDER BY "cycle_seq" DESC`,
          [this.config.centerId, enr.enrollment_id],
        );
        const latestPkg = prevPkgRes.rows[0] ?? null;
        const pkgRem =
          enr.package_lessons_remaining !== null ? Number(enr.package_lessons_remaining) : null;
        const targetSeq =
          !latestPkg ? 1 : pkgRem !== null && pkgRem <= 0 ? Number(latestPkg.cycle_seq) + 1 : Number(latestPkg.cycle_seq);
        const pkgKey = `PKG:${targetSeq}`;
        const pkgStart =
          targetSeq === 1
            ? enrolledAtStr
            : !latestPkg || targetSeq > Number(latestPkg.cycle_seq)
              ? (options.periodStartDate ?? localParts.localDate)
              : (formatPgDate(latestPkg.period_start_date) ?? enrolledAtStr);

        if (leftAtStr && pkgStart > leftAtStr) {
          skippedTrialOrIneligibleCount += 1;
          continue;
        }

        const issueRes = await this.billingCyclePort.issueWorkerInvoiceForCycle({
          centerId: this.config.centerId,
          enrollmentId: enr.enrollment_id,
          cycleType: 'LESSON_PACKAGE_12',
          cycleKey: pkgKey,
          periodStartDate: pkgStart,
          periodEndDate: null,
          systemJobName: `SchedulesWorker:${jobIdentityKey}`.slice(0, 64),
        });
        if (issueRes.replayedByCycleIdentity) {
          invoicesReplayedCount += 1;
        } else {
          invoicesIssuedCount += 1;
          issuedInvoiceIds.push(issueRes.invoice.invoice_id);
        }
        continue;
      }

      // CALENDAR_PRO_RATA -> CALENDAR_MONTH across calendarWindowsToRun
      let eligibleInAnyWindow = false;
      for (const calWin of calendarWindowsToRun) {
        if (enrolledAtStr > calWin.periodEndDate) {
          continue;
        }
        if (leftAtStr && calWin.periodStartDate > leftAtStr) {
          continue;
        }
        eligibleInAnyWindow = true;
        const issueRes: BillingCycleWorkerIssueResult =
          await this.billingCyclePort.issueWorkerInvoiceForCycle({
            centerId: this.config.centerId,
            enrollmentId: enr.enrollment_id,
            cycleType: 'CALENDAR_MONTH',
            cycleKey: calWin.cycleKey,
            periodStartDate: calWin.periodStartDate,
            periodEndDate: calWin.periodEndDate,
            systemJobName: `SchedulesWorker:${jobIdentityKey}`.slice(0, 64),
          });

        if (issueRes.replayedByCycleIdentity) {
          invoicesReplayedCount += 1;
        } else {
          invoicesIssuedCount += 1;
          issuedInvoiceIds.push(issueRes.invoice.invoice_id);
        }
      }
      if (!eligibleInAnyWindow) {
        skippedTrialOrIneligibleCount += 1;
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
   * 13.04 Unclosed Cash Shift Reminder Job (`S05`):
   * - Enforces live `center_licenses` check (`READ_ONLY` or missing license row returns 0 flagged shifts without writing).
   * - Flags `OPEN` cash shifts for Admin/Director review without EVER fabricating `counted_closing_cash_uzs`
   *   or auto-closing the shift (`shiftsAutoClosedCount: 0`).
   */
  public async runUnclosedCashShiftReminderJob(options: {
    readonly nowUtc?: Date;
  } = {}): Promise<UnclosedShiftReminderRunResult> {
    const nowUtc = options.nowUtc ?? this.clock();
    const localParts = formatCenterLocalDateParts(nowUtc, this.config.centerTimezone);
    const jobIdentityKey = `ScheduledJob:${this.config.centerId}:UNCLOSED_SHIFT_REMINDER:${localParts.localDate}`;

    const liveLicenseMode = await this.db.resolveLiveCenterLicenseMode();
    if (liveLicenseMode === 'READ_ONLY') {
      return {
        jobIdentityKey,
        flaggedShiftIds: [],
        shiftsAutoClosedCount: 0,
      };
    }

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
   * 13.04 Trial No-Show Follow-Up Job (`S05`):
   * - Requires explicit `CONFIRMED_SECOND_ABSENCE_ADMIN_FOLLOWUP` policy (fails closed on `UNCONFIGURED`).
   * - Enforces live `center_licenses` check (`READ_ONLY` or missing license row fails closed).
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

    const liveLicenseMode = await this.db.resolveLiveCenterLicenseMode();
    if (liveLicenseMode === 'READ_ONLY') {
      throw new Error(
        'LICENSE_READ_ONLY_MODE: Scheduled trial no-show follow-up mutations are blocked while center license is in READ_ONLY mode (BR-15, 13.04)',
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
