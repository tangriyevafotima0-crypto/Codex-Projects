/**
 * EduERP v2.0 — Canonical Shared Billing Calculation & Transactional Issuance Engine (`S08`, `S13FIX-T` / `T02`):
 * Single authoritative implementation used by BOTH `apps/api/src/billing/invoice-generator.ts`
 * and `apps/worker/src/schedules.worker.ts` (`CanonicalSqlBillingCycleWorkerPort`).
 *
 * Enforces:
 * - `K02`, `OWNER-20261104-02`, `OWNER-20261104-03`: Policy confirmation gate, `HALF_UP_UZS_INT` rational integer
 *   arithmetic, per-center `first_partial_charge_mode` (`PRORATE_REMAINING_LESSONS` vs `FULL_CYCLE`),
 *   `rolling_month_end_mode` (`CLAMP_LAST_DAY` / `CONTINUE_FROM_CLAMPED_DAY`), `package_cancel_mode` (`PRESERVE_BALANCE`),
 *   and `cancelled_lesson_proration_mode`.
 * - `K04` & `09.04`: Service-begin (`first_trial_date ?? enrolled_at_date`) and withdrawal (`left_at_date`) boundaries.
 * - `L02`: Durable `LESSON_PACKAGE_12` lesson ownership (`billing_cycle_lesson_allocations` + JSON snapshots;
 *   forbids live calendar recomputation if prior cycle lacks durable ownership snapshot).
 * - Stage 07 authoritative historical tariff lookup as of `resolvedPeriodStart` (`course_price_history`).
 * - Append-only `credit_notes` cap (`min(available, remaining_charge)`) under enrollment `FOR UPDATE` lock.
 * - Atomic execution of `billing_cycles`, `billing_cycle_lesson_allocations`, `invoices`, `invoice_lines`,
 *   `credit_note_applications`, `ledger_entries`, `audit_logs`, and `outbox_events` (`AllocationAdjusted`).
 */

import * as crypto from 'node:crypto';
import type {
  BillingCycleType,
  BillingMode,
  CancelledLessonProrationMode,
  CollectionTiming,
  DueDateRule,
  ErrorCodeContract,
  FirstPartialChargeMode,
  InvoiceStatus,
  PackageCancelMode,
  PolicyConfirmationStatus,
  RollingMonthEndMode,
  RoundingMode,
} from './index';

export const CANONICAL_BILLING_CALCULATION_VERSION = 's08-v2';
export const CANONICAL_MAX_PG_BIGINT = 9223372036854775807n;

export type CanonicalScheduleDayCode = 'MON' | 'TUE' | 'WED' | 'THU' | 'FRI' | 'SAT' | 'SUN';

const UTC_DAY_TO_SCHEDULE_CODE: readonly CanonicalScheduleDayCode[] = [
  'SUN',
  'MON',
  'TUE',
  'WED',
  'THU',
  'FRI',
  'SAT',
];

export type CanonicalFaultInjectionStep =
  | 'BILLING_CYCLE'
  | 'PACKAGE_ALLOCATIONS'
  | 'INVOICE'
  | 'INVOICE_LINES'
  | 'LEDGER_ENTRY'
  | 'AUDIT_LOG'
  | 'OUTBOX_EVENT';

export interface CanonicalSqlQueryExecutor {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ readonly rows: readonly T[]; readonly rowCount?: number | null }>;
}

export interface CanonicalBillingErrorSpec {
  readonly statusCode: number;
  readonly errorCode: ErrorCodeContract;
  readonly message: string;
}

export class CanonicalBillingEngineError extends Error {
  public readonly statusCode: number;
  public readonly errorCode: ErrorCodeContract;

  constructor(spec: CanonicalBillingErrorSpec) {
    super(`${spec.errorCode}: ${spec.message}`);
    this.name = 'CanonicalBillingEngineError';
    this.statusCode = spec.statusCode;
    this.errorCode = spec.errorCode;
  }
}

export type CanonicalErrorFactory = (spec: CanonicalBillingErrorSpec) => Error;

const defaultCreateError: CanonicalErrorFactory = (spec) => new CanonicalBillingEngineError(spec);

export interface CanonicalInvoiceLineDto {
  readonly id: string;
  readonly line_type:
    | 'BASE_TARIFF'
    | 'PRO_RATA_CALC'
    | 'APPROVED_DISCOUNT'
    | 'PRIOR_FREEZE_CREDIT'
    | 'TRIAL_COMPENSATION_CREDIT';
  readonly description: string;
  readonly amount_uzs: string;
  readonly formula_snapshot: string;
  readonly created_at_utc: string;
}

export interface CanonicalInvoiceResponseDto {
  readonly invoice_id: string;
  readonly invoice_number: string;
  readonly student_id: string;
  readonly enrollment_id: string;
  readonly billing_cycle_id: string;
  readonly cycle_type: BillingCycleType;
  readonly cycle_key: string;
  readonly cycle_seq: number;
  readonly period_start_date: string;
  readonly period_end_date: string | null;
  readonly planned_lessons: number;
  readonly billable_lessons: number;
  readonly billed_lessons: number;
  readonly frozen_credited_lessons: number;
  readonly currency: 'UZS';
  readonly tariff_snapshot_uzs: string;
  readonly tariff_effective_from_snapshot: string | null;
  readonly base_pro_rata_charge_uzs: string;
  readonly approved_discount_uzs: string;
  readonly credit_note_adjustments_uzs: string;
  readonly effective_net_charge_uzs: string;
  readonly allocated_paid_uzs: string;
  readonly remaining_debt_uzs: string;
  readonly status: InvoiceStatus;
  readonly due_date: string;
  readonly due_date_rule: DueDateRule;
  readonly fixed_due_day: number | null;
  readonly collection_timing: CollectionTiming;
  readonly policy_version_id: string;
  readonly calculation_version: string;
  readonly version: number;
  readonly issued_at_utc: string;
  readonly lines: readonly CanonicalInvoiceLineDto[];
}

export interface CanonicalIssueInvoiceParams {
  readonly centerId: string;
  readonly enrollmentId: string;
  readonly cycleType: BillingCycleType;
  readonly cycleKey: string;
  readonly periodStartDate: string;
  readonly periodEndDate?: string | null;
  readonly applyAvailableCreditNotes?: boolean;
  readonly actorType: 'STAFF' | 'SYSTEM_WORKER';
  readonly actorStaffId: string | null;
  readonly actorRole: string | null;
  readonly systemJobName: string | null;
  readonly requestId: string;
  readonly now: Date;
  readonly overrideBillingStartDate?: string;
  readonly requireActiveEnrollment?: boolean;
  readonly enableTestFaultInjection?: boolean;
  readonly testFaultAfterStep?: CanonicalFaultInjectionStep;
  readonly createError?: CanonicalErrorFactory;
}

export function formatCanonicalPgDate(val: unknown): string | null {
  if (val === null || val === undefined || val === '') return null;
  if (val instanceof Date) return val.toISOString().slice(0, 10);
  const s = String(val).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

export function parseCanonicalIsoDateParts(
  isoDate: string,
  createError: CanonicalErrorFactory = defaultCreateError,
): {
  readonly year: number;
  readonly month: number;
  readonly day: number;
} {
  const clean = typeof isoDate === 'string' ? isoDate.trim() : '';
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(clean);
  if (!match) {
    throw createError({
      statusCode: 400,
      errorCode: 'VALIDATION_ERROR',
      message: `Invalid ISO date '${String(isoDate)}' (expected YYYY-MM-DD)`,
    });
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const maxDay =
    month >= 1 && month <= 12 ? daysInCanonicalGregorianMonth(year, month) : 0;
  if (month < 1 || month > 12 || day < 1 || day > maxDay) {
    throw createError({
      statusCode: 400,
      errorCode: 'VALIDATION_ERROR',
      message: `Invalid calendar date '${clean}'`,
    });
  }
  return { year, month, day };
}

export function formatCanonicalIsoDateParts(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function isCanonicalGregorianLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInCanonicalGregorianMonth(year: number, month: number): number {
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
      return isCanonicalGregorianLeapYear(year) ? 29 : 28;
    default:
      throw new Error(`VALIDATION_ERROR: Invalid Gregorian month ${month}`);
  }
}

export function addCanonicalCalendarDaysToIsoDate(isoDate: string, deltaDays: number): string {
  const { year, month, day } = parseCanonicalIsoDateParts(isoDate);
  const utcMs = Date.UTC(year, month - 1, day) + deltaDays * 86_400_000;
  return new Date(utcMs).toISOString().slice(0, 10);
}

export function computeCanonicalNextRollingRenewalDate(
  currentBoundaryDate: string,
  rollingMonthEndMode: RollingMonthEndMode = 'CONTINUE_FROM_CLAMPED_DAY',
  createError: CanonicalErrorFactory = defaultCreateError,
): {
  readonly nextRenewalDate: string;
  readonly inclusivePeriodEndDate: string;
  readonly resultingDayOfMonth: number;
} {
  if (
    rollingMonthEndMode !== 'CLAMP_LAST_DAY' &&
    rollingMonthEndMode !== 'CONTINUE_FROM_CLAMPED_DAY'
  ) {
    throw createError({
      statusCode: 403,
      errorCode: 'POLICY_DECISION_NOT_CONFIRMED',
      message: `rolling_month_end_mode '${rollingMonthEndMode}' is not confirmed under OWNER-20261104-03`,
    });
  }

  const { year, month, day } = parseCanonicalIsoDateParts(currentBoundaryDate, createError);
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const maxDay = daysInCanonicalGregorianMonth(nextYear, nextMonth);
  const clampedDay = Math.min(day, maxDay);
  const nextRenewalDate = formatCanonicalIsoDateParts(nextYear, nextMonth, clampedDay);
  const inclusivePeriodEndDate = addCanonicalCalendarDaysToIsoDate(nextRenewalDate, -1);

  return Object.freeze({
    nextRenewalDate,
    inclusivePeriodEndDate,
    resultingDayOfMonth: clampedDay,
  });
}

function enumerateCanonicalCalendarDatesInclusive(startDate: string, endDate: string): string[] {
  const start = parseCanonicalIsoDateParts(startDate);
  const end = parseCanonicalIsoDateParts(endDate);
  const startMs = Date.UTC(start.year, start.month - 1, start.day);
  const endMs = Date.UTC(end.year, end.month - 1, end.day);
  const result: string[] = [];
  for (let ms = startMs; ms <= endMs; ms += 86_400_000) {
    result.push(new Date(ms).toISOString().slice(0, 10));
  }
  return result;
}

function getCanonicalIsoDateWeekday(isoDate: string): CanonicalScheduleDayCode {
  const { year, month, day } = parseCanonicalIsoDateParts(isoDate);
  const dayIdx = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return UTC_DAY_TO_SCHEDULE_CODE[dayIdx];
}

export function roundCanonicalRationalHalfUpUzs(
  numerator: bigint,
  denominator: bigint,
  createError: CanonicalErrorFactory = defaultCreateError,
  fieldName = 'base_pro_rata_charge_uzs',
): bigint {
  if (numerator < 0n) {
    throw createError({
      statusCode: 422,
      errorCode: 'VALIDATION_ERROR',
      message: `${fieldName}: negative rational numerator is not allowed for non-negative HALF_UP charge`,
    });
  }
  if (denominator <= 0n) {
    throw createError({
      statusCode: 422,
      errorCode: 'INVALID_SCHEDULE_ZERO_LESSONS',
      message: `${fieldName}: denominator must be > 0`,
    });
  }
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  const rounded = remainder * 2n >= denominator ? quotient + 1n : quotient;
  if (rounded > CANONICAL_MAX_PG_BIGINT) {
    throw createError({
      statusCode: 422,
      errorCode: 'VALIDATION_ERROR',
      message: `${fieldName}: calculated UZS amount overflows PostgreSQL 64-bit BIGINT maximum`,
    });
  }
  return rounded;
}

function parseCanonicalNonNegativeMoneyUzs(
  value: bigint | string,
  fieldName: string,
  createError: CanonicalErrorFactory,
): bigint {
  let parsed: bigint;
  if (typeof value === 'bigint') {
    parsed = value;
  } else if (typeof value === 'string' && /^\d{1,19}$/.test(value.trim())) {
    parsed = BigInt(value.trim());
  } else {
    throw createError({
      statusCode: 422,
      errorCode: 'VALIDATION_ERROR',
      message: `${fieldName} must be a non-negative integer UZS value`,
    });
  }
  if (parsed < 0n || parsed > CANONICAL_MAX_PG_BIGINT) {
    throw createError({
      statusCode: 422,
      errorCode: 'VALIDATION_ERROR',
      message: `${fieldName} out of valid PostgreSQL BIGINT range`,
    });
  }
  return parsed;
}

async function allocateCanonicalNextInvoiceNumber(
  tx: CanonicalSqlQueryExecutor,
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

async function resolveCanonicalGroupTariffAsOf(
  tx: CanonicalSqlQueryExecutor,
  params: {
    readonly centerId: string;
    readonly courseId: string;
    readonly groupId: string;
    readonly storedCurrentFeeUzs: string;
    readonly asOfDate: string;
    readonly createError: CanonicalErrorFactory;
  },
): Promise<{
  readonly effectiveFeeAsOfUzs: bigint;
  readonly tariffEffectiveFromSnapshot: string | null;
}> {
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
            "effective_from"::text AS effective_from,
            "target_version_snapshot",
            "created_at"
       FROM "course_price_history"
      WHERE "center_id" = $1::uuid
        AND "course_id" = $2::uuid
        AND ("group_id" = $3::uuid OR "group_id" IS NULL)
      ORDER BY CASE WHEN "group_id" = $3::uuid THEN 0 ELSE 1 END ASC,
               "effective_from" DESC,
               "target_version_snapshot" DESC,
               "created_at" DESC,
               "id" DESC`,
    [params.centerId, params.courseId, params.groupId],
  );

  const history = histRes.rows.map((r) => ({
    id: r.id,
    previous_fee_uzs: parseCanonicalNonNegativeMoneyUzs(
      r.previous_fee_uzs,
      'previous_fee_uzs',
      params.createError,
    ),
    new_fee_uzs: parseCanonicalNonNegativeMoneyUzs(
      r.new_fee_uzs,
      'new_fee_uzs',
      params.createError,
    ),
    effective_from: formatCanonicalPgDate(r.effective_from) ?? params.asOfDate,
  }));

  const activeEntry = history.find((h) => h.effective_from <= params.asOfDate);
  if (activeEntry) {
    return {
      effectiveFeeAsOfUzs: activeEntry.new_fee_uzs,
      tariffEffectiveFromSnapshot: activeEntry.effective_from,
    };
  }
  const earliestEntry = history.length > 0 ? history[history.length - 1] : undefined;
  if (earliestEntry) {
    return {
      effectiveFeeAsOfUzs: earliestEntry.previous_fee_uzs,
      tariffEffectiveFromSnapshot: null,
    };
  }
  return {
    effectiveFeeAsOfUzs: parseCanonicalNonNegativeMoneyUzs(
      params.storedCurrentFeeUzs,
      'current_fee_uzs',
      params.createError,
    ),
    tariffEffectiveFromSnapshot: null,
  };
}

export async function loadCanonicalInvoiceResponseInTx(
  tx: CanonicalSqlQueryExecutor,
  centerId: string,
  invoiceId: string,
  createError: CanonicalErrorFactory = defaultCreateError,
): Promise<CanonicalInvoiceResponseDto> {
  const invRes = await tx.query<{
    id: string;
    invoice_number: string;
    student_id: string;
    enrollment_id: string;
    billing_cycle_id: string;
    cycle_type: BillingCycleType;
    cycle_key: string;
    cycle_seq: number;
    period_start_date: unknown;
    period_end_date: unknown;
    planned_lessons: number;
    billable_lessons: number;
    billed_lessons: number;
    frozen_credited_lessons: number;
    currency: string;
    tariff_snapshot_uzs: string;
    tariff_effective_from_snapshot: unknown;
    base_pro_rata_charge_uzs: string;
    approved_discount_uzs: string;
    credit_note_adjustments_uzs: string;
    effective_net_charge_uzs: string;
    allocated_paid_uzs: string;
    remaining_debt_uzs: string;
    status: InvoiceStatus;
    due_date: unknown;
    due_date_rule_snapshot: DueDateRule;
    fixed_due_day_snapshot: number | null;
    collection_timing_snapshot: CollectionTiming;
    policy_version_id: string;
    calculation_version: string;
    version: number;
    issued_at: Date;
  }>(
    `SELECT i."id"::text AS id,
            i."invoice_number",
            i."student_id"::text AS student_id,
            i."enrollment_id"::text AS enrollment_id,
            i."billing_cycle_id"::text AS billing_cycle_id,
            bc."cycle_type"::text AS cycle_type,
            bc."cycle_key",
            bc."cycle_seq",
            bc."period_start_date"::text AS period_start_date,
            bc."period_end_date"::text AS period_end_date,
            bc."planned_lessons",
            bc."billable_lessons",
            i."billed_lessons",
            i."frozen_credited_lessons",
            i."currency"::text AS currency,
            i."tariff_snapshot_uzs"::text AS tariff_snapshot_uzs,
            i."tariff_effective_from_snapshot"::text AS tariff_effective_from_snapshot,
            i."base_pro_rata_charge_uzs"::text AS base_pro_rata_charge_uzs,
            i."approved_discount_uzs"::text AS approved_discount_uzs,
            i."credit_note_adjustments_uzs"::text AS credit_note_adjustments_uzs,
            i."effective_net_charge_uzs"::text AS effective_net_charge_uzs,
            i."allocated_paid_uzs"::text AS allocated_paid_uzs,
            i."remaining_debt_uzs"::text AS remaining_debt_uzs,
            i."status"::text AS status,
            i."due_date"::text AS due_date,
            bc."due_date_rule_snapshot"::text AS due_date_rule_snapshot,
            bc."fixed_due_day_snapshot",
            i."collection_timing_snapshot"::text AS collection_timing_snapshot,
            i."policy_version_id"::text AS policy_version_id,
            i."calculation_version",
            i."version",
            i."issued_at"
       FROM "invoices" i
       JOIN "billing_cycles" bc
         ON bc."id" = i."billing_cycle_id"
        AND bc."center_id" = i."center_id"
      WHERE i."id" = $1::uuid
        AND i."center_id" = $2::uuid
      LIMIT 1`,
    [invoiceId, centerId],
  );

  const row = invRes.rows[0];
  if (!row) {
    throw createError({
      statusCode: 404,
      errorCode: 'NOT_FOUND',
      message: 'Invoice not found in center scope',
    });
  }

  const linesRes = await tx.query<{
    id: string;
    line_type: CanonicalInvoiceLineDto['line_type'];
    description: string;
    amount_uzs: string;
    formula_snapshot: string;
    created_at: Date;
  }>(
    `SELECT "id"::text AS id,
            "line_type"::text AS line_type,
            "description",
            "amount_uzs"::text AS amount_uzs,
            "formula_snapshot",
            "created_at"
       FROM "invoice_lines"
      WHERE "invoice_id" = $1::uuid
        AND "center_id" = $2::uuid
      ORDER BY "created_at" ASC, "id" ASC`,
    [invoiceId, centerId],
  );

  return Object.freeze({
    invoice_id: row.id,
    invoice_number: row.invoice_number,
    student_id: row.student_id,
    enrollment_id: row.enrollment_id,
    billing_cycle_id: row.billing_cycle_id,
    cycle_type: row.cycle_type,
    cycle_key: row.cycle_key,
    cycle_seq: Number(row.cycle_seq),
    period_start_date: formatCanonicalPgDate(row.period_start_date) ?? '1970-01-01',
    period_end_date: formatCanonicalPgDate(row.period_end_date),
    planned_lessons: Number(row.planned_lessons),
    billable_lessons: Number(row.billable_lessons),
    billed_lessons: Number(row.billed_lessons),
    frozen_credited_lessons: Number(row.frozen_credited_lessons),
    currency: 'UZS',
    tariff_snapshot_uzs: BigInt(row.tariff_snapshot_uzs).toString(10),
    tariff_effective_from_snapshot: formatCanonicalPgDate(row.tariff_effective_from_snapshot),
    base_pro_rata_charge_uzs: BigInt(row.base_pro_rata_charge_uzs).toString(10),
    approved_discount_uzs: BigInt(row.approved_discount_uzs).toString(10),
    credit_note_adjustments_uzs: BigInt(row.credit_note_adjustments_uzs).toString(10),
    effective_net_charge_uzs: BigInt(row.effective_net_charge_uzs).toString(10),
    allocated_paid_uzs: BigInt(row.allocated_paid_uzs).toString(10),
    remaining_debt_uzs: BigInt(row.remaining_debt_uzs).toString(10),
    status: row.status,
    due_date: formatCanonicalPgDate(row.due_date) ?? '1970-01-01',
    due_date_rule: row.due_date_rule_snapshot,
    fixed_due_day:
      row.fixed_due_day_snapshot !== null ? Number(row.fixed_due_day_snapshot) : null,
    collection_timing: row.collection_timing_snapshot,
    policy_version_id: row.policy_version_id,
    calculation_version: row.calculation_version,
    version: Number(row.version),
    issued_at_utc: new Date(row.issued_at).toISOString(),
    lines: Object.freeze(
      linesRes.rows.map((l) =>
        Object.freeze({
          id: l.id,
          line_type: l.line_type,
          description: l.description,
          amount_uzs: BigInt(l.amount_uzs).toString(10),
          formula_snapshot: l.formula_snapshot,
          created_at_utc: new Date(l.created_at).toISOString(),
        }),
      ),
    ),
  });
}

function maybeInjectCanonicalTestFault(
  targetStep: CanonicalFaultInjectionStep,
  enableFaultInjection?: boolean,
  configuredFault?: CanonicalFaultInjectionStep,
): void {
  if (enableFaultInjection && configuredFault === targetStep) {
    throw new Error(`SIMULATED_S08_FAULT_AFTER_${targetStep}`);
  }
}

export async function executeCanonicalBillingCycleIssuanceInTx(
  tx: CanonicalSqlQueryExecutor,
  params: CanonicalIssueInvoiceParams,
): Promise<{ readonly invoice: CanonicalInvoiceResponseDto; readonly replayedByCycleIdentity: boolean }> {
  const createError = params.createError ?? defaultCreateError;
  const enableFaults = params.enableTestFaultInjection ?? true;

  // 1. Lock enrollment row FOR UPDATE to serialize concurrent invoice issuance on the same enrollment
  const enrRes = await tx.query<{
    id: string;
    center_id: string;
    student_id: string;
    group_id: string;
    status: string;
    enrolled_at_date: unknown;
    first_trial_date: unknown;
    left_at_date: unknown;
    billing_anchor_day: number | null;
    package_lessons_remaining: number | null;
  }>(
    `SELECT "id"::text AS id,
            "center_id"::text AS center_id,
            "student_id"::text AS student_id,
            "group_id"::text AS group_id,
            "status"::text AS status,
            "enrolled_at_date"::text AS enrolled_at_date,
            "first_trial_date"::text AS first_trial_date,
            "left_at_date"::text AS left_at_date,
            "billing_anchor_day",
            "package_lessons_remaining"
       FROM "enrollments"
      WHERE "id" = $1::uuid
        AND "center_id" = $2::uuid
      FOR UPDATE`,
    [params.enrollmentId, params.centerId],
  );

  const enrollment = enrRes.rows[0];
  if (!enrollment) {
    throw createError({
      statusCode: 404,
      errorCode: 'NOT_FOUND',
      message: 'Enrollment not found in center scope',
    });
  }
  if (enrollment.status === 'LEFT') {
    throw createError({
      statusCode: 422,
      errorCode: 'VALIDATION_ERROR',
      message: 'Cannot issue a new billing cycle invoice for a LEFT enrollment (09.04)',
    });
  }
  if (enrollment.status === 'TRIAL') {
    throw createError({
      statusCode: 422,
      errorCode: 'VALIDATION_ERROR',
      message:
        'Cannot issue a billing cycle invoice for a TRIAL enrollment before canonical 2nd distinct attended lesson activates the enrollment (T08.03 / K03)',
    });
  }
  if (params.requireActiveEnrollment && enrollment.status !== 'ACTIVE') {
    throw createError({
      statusCode: 422,
      errorCode: 'VALIDATION_ERROR',
      message: `Cannot issue scheduled billing invoice for non-ACTIVE enrollment status=${enrollment.status}`,
    });
  }

  const effectiveExitDate = formatCanonicalPgDate(enrollment.left_at_date);
  if (effectiveExitDate && params.periodStartDate > effectiveExitDate) {
    throw createError({
      statusCode: 422,
      errorCode: 'VALIDATION_ERROR',
      message: `Cannot issue a billing cycle invoice starting ${params.periodStartDate} after enrollment left_at_date (${effectiveExitDate}) (09.04)`,
    });
  }

  // 2. Check durable business identity (enrollment_id, cycle_type, cycle_key) BEFORE creating a duplicate cycle/invoice
  const existingCycleRes = await tx.query<{
    cycle_id: string;
    period_start_date: unknown;
    period_end_date: unknown;
    invoice_id: string | null;
  }>(
    `SELECT bc."id"::text AS cycle_id,
            bc."period_start_date"::text AS period_start_date,
            bc."period_end_date"::text AS period_end_date,
            i."id"::text AS invoice_id
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

  const existingCycle = existingCycleRes.rows[0];
  if (existingCycle && existingCycle.invoice_id) {
    const existingStart = formatCanonicalPgDate(existingCycle.period_start_date);
    const existingEnd = formatCanonicalPgDate(existingCycle.period_end_date);
    if (
      existingStart !== params.periodStartDate ||
      (params.periodEndDate !== undefined &&
        params.periodEndDate !== null &&
        existingEnd !== params.periodEndDate)
    ) {
      throw createError({
        statusCode: 409,
        errorCode: 'VERSION_CONFLICT',
        message: `BillingCycle (${params.cycleType}, ${params.cycleKey}) already exists for enrollment with period ${existingStart}..${existingEnd ?? 'NULL'} (cannot reissue with conflicting period ${params.periodStartDate}..${params.periodEndDate ?? 'NULL'})`,
      });
    }
    const existingDto = await loadCanonicalInvoiceResponseInTx(
      tx,
      params.centerId,
      existingCycle.invoice_id,
      createError,
    );
    return { invoice: existingDto, replayedByCycleIdentity: true };
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
    schedule_days_json: CanonicalScheduleDayCode[];
    timezone: string;
    status: string;
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
            "schedule_days_json",
            "timezone",
            "status"::text AS status
       FROM "course_groups"
      WHERE "id" = $1::uuid
        AND "center_id" = $2::uuid
      LIMIT 1`,
    [enrollment.group_id, params.centerId],
  );

  const group = groupRes.rows[0];
  if (!group) {
    throw createError({
      statusCode: 404,
      errorCode: 'NOT_FOUND',
      message: 'Course group for enrollment not found in center scope',
    });
  }

  const expectedCycleType: BillingCycleType =
    group.billing_mode === 'CALENDAR_PRO_RATA'
      ? 'CALENDAR_MONTH'
      : group.billing_mode === 'ROLLING_MONTH'
        ? 'ROLLING_MONTH'
        : 'LESSON_PACKAGE_12';
  if (params.cycleType !== expectedCycleType) {
    throw createError({
      statusCode: 422,
      errorCode: 'VALIDATION_ERROR',
      message: `Requested cycle_type '${params.cycleType}' does not match group billing_mode '${group.billing_mode}' (expected '${expectedCycleType}')`,
    });
  }

  // 4. Resolve active BillingPolicyVersion as of periodStartDate
  type PolicyRow = {
    id: string;
    version_number: number;
    billing_mode: BillingMode;
    first_partial_charge_mode: string | null;
    rounding_mode: string;
    rolling_month_end_mode: string;
    package_cancel_mode: string;
    cancelled_lesson_proration_mode: string | null;
    policy_confirmation_status: string | null;
    effective_from_date: unknown;
  };

  let policyRow: PolicyRow | undefined;
  if (group.billing_policy_version_id) {
    const boundRes = await tx.query<PolicyRow>(
      `SELECT "id"::text AS id,
              "version_number",
              "billing_mode"::text AS billing_mode,
              "first_partial_charge_mode"::text AS first_partial_charge_mode,
              "rounding_mode"::text AS rounding_mode,
              "rolling_month_end_mode"::text AS rolling_month_end_mode,
              "package_cancel_mode"::text AS package_cancel_mode,
              "cancelled_lesson_proration_mode"::text AS cancelled_lesson_proration_mode,
              "policy_confirmation_status"::text AS policy_confirmation_status,
              "effective_from_date"::text AS effective_from_date
         FROM "billing_policy_versions"
        WHERE "id" = $1::uuid
          AND "center_id" = $2::uuid
        LIMIT 1`,
      [group.billing_policy_version_id, params.centerId],
    );
    policyRow = boundRes.rows[0];
    if (!policyRow) {
      throw createError({
        statusCode: 404,
        errorCode: 'NOT_FOUND',
        message: 'Bound billing_policy_version_id not found in center scope',
      });
    }
    if (policyRow.billing_mode !== group.billing_mode) {
      throw createError({
        statusCode: 422,
        errorCode: 'VALIDATION_ERROR',
        message: `Bound billing_policy_version_id mode (${policyRow.billing_mode}) does not match group billing_mode (${group.billing_mode})`,
      });
    }
  } else {
    const modeRes = await tx.query<PolicyRow>(
      `SELECT "id"::text AS id,
              "version_number",
              "billing_mode"::text AS billing_mode,
              "first_partial_charge_mode"::text AS first_partial_charge_mode,
              "rounding_mode"::text AS rounding_mode,
              "rolling_month_end_mode"::text AS rolling_month_end_mode,
              "package_cancel_mode"::text AS package_cancel_mode,
              "cancelled_lesson_proration_mode"::text AS cancelled_lesson_proration_mode,
              "policy_confirmation_status"::text AS policy_confirmation_status,
              "effective_from_date"::text AS effective_from_date
         FROM "billing_policy_versions"
        WHERE "center_id" = $1::uuid
          AND "billing_mode" = $2
          AND "policy_confirmation_status" = 'CONFIRMED'
          AND "effective_from_date" IS NOT NULL
          AND "effective_from_date" <= $3::date
          AND ($2 = 'LESSON_PACKAGE_12' OR "first_partial_charge_mode" <> 'UNCONFIGURED')
        ORDER BY "effective_from_date" DESC,
                 "version_number" DESC
        LIMIT 1`,
      [params.centerId, group.billing_mode, params.periodStartDate],
    );
    policyRow = modeRes.rows[0];
    if (!policyRow) {
      throw createError({
        statusCode: 403,
        errorCode: 'POLICY_DECISION_NOT_CONFIRMED',
        message: `No CONFIRMED BillingPolicyVersion is active for billing_mode=${group.billing_mode} as of ${params.periodStartDate}; Director must explicitly confirm center billing policy before issuing invoices (K02 / OWNER-20261104-03)`,
      });
    }
  }

  const policyConfirmationStatus: PolicyConfirmationStatus =
    policyRow.policy_confirmation_status === 'CONFIRMED' ? 'CONFIRMED' : 'UNCONFIGURED';
  const policyEffectiveFromDate = formatCanonicalPgDate(policyRow.effective_from_date);
  const firstPartialChargeMode: FirstPartialChargeMode =
    policyRow.first_partial_charge_mode === 'PRORATE_REMAINING_LESSONS' ||
    policyRow.first_partial_charge_mode === 'FULL_CYCLE'
      ? policyRow.first_partial_charge_mode
      : 'UNCONFIGURED';
  const roundingMode = policyRow.rounding_mode as RoundingMode;
  const rollingMonthEndMode = policyRow.rolling_month_end_mode as RollingMonthEndMode;
  const packageCancelMode = policyRow.package_cancel_mode as PackageCancelMode;
  const cancelledLessonProrationMode = (policyRow.cancelled_lesson_proration_mode ??
    'EXCLUDE_CANCELLED_FROM_PLANNED') as CancelledLessonProrationMode;

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
    params.overrideBillingStartDate ??
    formatCanonicalPgDate(enrollment.first_trial_date) ??
    formatCanonicalPgDate(enrollment.enrolled_at_date) ??
    params.periodStartDate;

  // 6. Build cycle spec and resolve period boundaries (enforcing K04 serviceBeginDate eligibility)
  let resolvedPeriodStart = params.periodStartDate;
  let resolvedPeriodEnd: string | null = params.periodEndDate ?? null;
  let effectiveEnrollmentStart = enrollmentBillingStartDate;
  let isFirstPartialPeriod = false;

  if (params.cycleType === 'CALENDAR_MONTH') {
    const startParts = parseCanonicalIsoDateParts(params.periodStartDate, createError);
    if (startParts.day !== 1) {
      throw createError({
        statusCode: 422,
        errorCode: 'VALIDATION_ERROR',
        message: `CALENDAR_MONTH period_start_date (${params.periodStartDate}) must be the 1st of the Gregorian month (YYYY-MM-01 — T08.02)`,
      });
    }
    const lastDay = daysInCanonicalGregorianMonth(startParts.year, startParts.month);
    const canonicalEnd = formatCanonicalIsoDateParts(startParts.year, startParts.month, lastDay);
    if (params.periodEndDate && params.periodEndDate !== canonicalEnd) {
      throw createError({
        statusCode: 422,
        errorCode: 'VALIDATION_ERROR',
        message: `CALENDAR_MONTH period_end_date (${params.periodEndDate}) must equal the last day of the month (${canonicalEnd})`,
      });
    }
    if (canonicalEnd < enrollmentBillingStartDate) {
      throw createError({
        statusCode: 422,
        errorCode: 'VALIDATION_ERROR',
        message: `Cannot bill service period ${params.periodStartDate}..${canonicalEnd} because it ends before enrollment service begin date (${enrollmentBillingStartDate}) (K04)`,
      });
    }
    const monthTag = `${String(startParts.year).padStart(4, '0')}-${String(startParts.month).padStart(2, '0')}`;
    const canonicalKey = `CAL:${monthTag}`;
    const trimmedKey = params.cycleKey.trim();
    if (trimmedKey !== canonicalKey && trimmedKey !== monthTag) {
      throw createError({
        statusCode: 422,
        errorCode: 'VALIDATION_ERROR',
        message: `CALENDAR_MONTH cycle_key '${trimmedKey}' does not match period_start_date month (${canonicalKey})`,
      });
    }
    resolvedPeriodStart = params.periodStartDate;
    resolvedPeriodEnd = canonicalEnd;
    isFirstPartialPeriod =
      enrollmentBillingStartDate > resolvedPeriodStart &&
      enrollmentBillingStartDate <= canonicalEnd;
    effectiveEnrollmentStart = isFirstPartialPeriod
      ? enrollmentBillingStartDate
      : resolvedPeriodStart;
  } else if (params.cycleType === 'ROLLING_MONTH') {
    const prevEnd = latestPrevCycle ? formatCanonicalPgDate(latestPrevCycle.period_end_date) : null;
    if (prevEnd) {
      const expectedNextStart = addCanonicalCalendarDaysToIsoDate(prevEnd, 1);
      if (params.periodStartDate !== expectedNextStart) {
        throw createError({
          statusCode: 422,
          errorCode: 'VALIDATION_ERROR',
          message: `ROLLING_MONTH period_start_date (${params.periodStartDate}) must chain directly from previous period_end_date (${prevEnd} -> ${expectedNextStart}) without gap or overlap (OWNER-20261104-03)`,
        });
      }
    }
    const { inclusivePeriodEndDate } = computeCanonicalNextRollingRenewalDate(
      params.periodStartDate,
      rollingMonthEndMode,
      createError,
    );
    if (params.periodEndDate && params.periodEndDate !== inclusivePeriodEndDate) {
      throw createError({
        statusCode: 422,
        errorCode: 'VALIDATION_ERROR',
        message: `ROLLING_MONTH period_end_date (${params.periodEndDate}) must equal inclusive renewal boundary (${inclusivePeriodEndDate})`,
      });
    }
    if (params.periodStartDate < enrollmentBillingStartDate) {
      throw createError({
        statusCode: 422,
        errorCode: 'VALIDATION_ERROR',
        message: `ROLLING_MONTH period_start_date (${params.periodStartDate}) cannot precede enrollment service begin date (${enrollmentBillingStartDate}) (K04)`,
      });
    }
    resolvedPeriodStart = params.periodStartDate;
    resolvedPeriodEnd = inclusivePeriodEndDate;
    isFirstPartialPeriod =
      enrollmentBillingStartDate > resolvedPeriodStart &&
      enrollmentBillingStartDate <= inclusivePeriodEndDate;
    effectiveEnrollmentStart = isFirstPartialPeriod
      ? enrollmentBillingStartDate
      : resolvedPeriodStart;
  } else {
    if (params.periodStartDate < enrollmentBillingStartDate) {
      throw createError({
        statusCode: 422,
        errorCode: 'VALIDATION_ERROR',
        message: `LESSON_PACKAGE_12 period_start_date (${params.periodStartDate}) cannot precede enrollment service begin date (${enrollmentBillingStartDate}) (K04)`,
      });
    }
    if (
      params.periodEndDate !== undefined &&
      params.periodEndDate !== null &&
      params.periodEndDate < enrollmentBillingStartDate
    ) {
      throw createError({
        statusCode: 422,
        errorCode: 'VALIDATION_ERROR',
        message: `Cannot bill service period ${params.periodStartDate}..${params.periodEndDate} because it ends before enrollment service begin date (${enrollmentBillingStartDate}) (K04)`,
      });
    }
  }

  // Check overlapping date-bounded cycles under a different cycle_key on the same enrollment
  if (resolvedPeriodEnd !== null) {
    for (const prev of prevCyclesRes.rows) {
      const pStart = formatCanonicalPgDate(prev.period_start_date);
      const pEnd = formatCanonicalPgDate(prev.period_end_date);
      if (pStart && pEnd && resolvedPeriodStart <= pEnd && resolvedPeriodEnd >= pStart) {
        throw createError({
          statusCode: 409,
          errorCode: 'VERSION_CONFLICT',
          message: `Requested service period ${resolvedPeriodStart}..${resolvedPeriodEnd} overlaps existing cycle '${prev.cycle_key}' (${pStart}..${pEnd}) for enrollment`,
        });
      }
    }
  }

  // 7. Load lesson occurrences in the service period window
  const lessonWindowEnd = resolvedPeriodEnd ?? '9999-12-31';
  const lessonsRes = await tx.query<{
    id: string;
    lesson_date: unknown;
    occurrence_seq: number;
    status: string;
    cancellation_source: string | null;
    rescheduled_from_lesson_id: string | null;
  }>(
    `SELECT "id"::text AS id,
            "lesson_date"::text AS lesson_date,
            "occurrence_seq",
            "status"::text AS status,
            "cancellation_source"::text AS cancellation_source,
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
    lesson_date: formatCanonicalPgDate(r.lesson_date) ?? resolvedPeriodStart,
    occurrence_seq: Number(r.occurrence_seq),
    status: r.status,
    cancellation_source: r.cancellation_source,
    rescheduled_from_lesson_id: r.rescheduled_from_lesson_id,
  }));

  const hasCancelledLessonsInWindow = candidateLessons.some(
    (l) => l.status === 'CANCELLED_BY_CENTER',
  );

  // 8. Enforce policy confirmation boundary before any calculation or write (K02, OWNER-20261104-02 / 03)
  if (policyConfirmationStatus !== 'CONFIRMED') {
    throw createError({
      statusCode: 403,
      errorCode: 'POLICY_DECISION_NOT_CONFIRMED',
      message: `Billing policy version ${policyRow.version_number} is UNCONFIGURED (status=${policyConfirmationStatus}); explicit Director policy confirmation is required before billing (K02 / OWNER-20261104-03)`,
    });
  }
  if (!policyEffectiveFromDate) {
    throw createError({
      statusCode: 403,
      errorCode: 'POLICY_DECISION_NOT_CONFIRMED',
      message: `Billing policy version ${policyRow.version_number} has no confirmed effective_from_date (K02)`,
    });
  }
  if (policyEffectiveFromDate > resolvedPeriodStart) {
    throw createError({
      statusCode: 403,
      errorCode: 'POLICY_DECISION_NOT_CONFIRMED',
      message: `Billing policy version ${policyRow.version_number} (effective_from_date=${policyEffectiveFromDate}) is not yet effective for service period starting ${resolvedPeriodStart} (K02)`,
    });
  }
  if (roundingMode !== 'HALF_UP_UZS_INT') {
    throw createError({
      statusCode: 403,
      errorCode: 'POLICY_DECISION_NOT_CONFIRMED',
      message: `Rounding mode '${roundingMode}' is not confirmed under OWNER-20261104-03 (only HALF_UP_UZS_INT is confirmed)`,
    });
  }
  if (
    (params.cycleType !== 'LESSON_PACKAGE_12' || isFirstPartialPeriod) &&
    firstPartialChargeMode === 'UNCONFIGURED'
  ) {
    throw createError({
      statusCode: 403,
      errorCode: 'POLICY_DECISION_NOT_CONFIRMED',
      message:
        'Center billing policy first_partial_charge_mode is UNCONFIGURED; Director must explicitly choose PRORATE_REMAINING_LESSONS or FULL_CYCLE (K02 / OWNER-20261104-03)',
    });
  }
  if (
    params.cycleType === 'ROLLING_MONTH' &&
    rollingMonthEndMode !== 'CLAMP_LAST_DAY' &&
    rollingMonthEndMode !== 'CONTINUE_FROM_CLAMPED_DAY'
  ) {
    throw createError({
      statusCode: 403,
      errorCode: 'POLICY_DECISION_NOT_CONFIRMED',
      message: `Rolling month end mode '${rollingMonthEndMode}' is not confirmed under OWNER-20261104-03`,
    });
  }
  if (params.cycleType === 'LESSON_PACKAGE_12') {
    if (packageCancelMode === 'UNCONFIGURED') {
      throw createError({
        statusCode: 403,
        errorCode: 'POLICY_DECISION_NOT_CONFIRMED',
        message: '12-lesson package cancellation policy (D21) is UNCONFIGURED for this center',
      });
    }
    if (hasCancelledLessonsInWindow && packageCancelMode === 'CREDIT_NEXT_CYCLE') {
      throw createError({
        statusCode: 403,
        errorCode: 'POLICY_DECISION_NOT_CONFIRMED',
        message:
          '12-lesson package cancelled-lesson CreditNote adjustment formula (D21 CREDIT_NEXT_CYCLE) is not confirmed',
      });
    }
  }

  // 9. Resolve due date orthogonally per due_date_rule and collection_timing
  const isInitialPartialCycle = nextCycleSeq === 1 && isFirstPartialPeriod;
  let resolvedDueDate: string;
  let resolvedFixedDueDay: number | null = null;
  if (group.due_date_rule === 'ENROLLMENT_ANNIVERSARY') {
    if (group.collection_timing === 'ADVANCE') {
      resolvedDueDate = resolvedPeriodStart;
    } else {
      resolvedDueDate = resolvedPeriodEnd
        ? addCanonicalCalendarDaysToIsoDate(resolvedPeriodEnd, 1)
        : computeCanonicalNextRollingRenewalDate(
            resolvedPeriodStart,
            'CONTINUE_FROM_CLAMPED_DAY',
            createError,
          ).nextRenewalDate;
    }
  } else {
    const fixedDay = group.fixed_due_day !== null ? Number(group.fixed_due_day) : null;
    if (fixedDay === null || fixedDay === undefined || fixedDay < 1 || fixedDay > 31) {
      throw createError({
        statusCode: 400,
        errorCode: 'VALIDATION_ERROR',
        message: 'fixed_due_day (1..31) is required when due_date_rule is CENTER_FIXED_DAY',
      });
    }
    const startParts = parseCanonicalIsoDateParts(resolvedPeriodStart, createError);
    let targetYear = startParts.year;
    let targetMonth = startParts.month;

    if (group.collection_timing === 'ARREARS') {
      if (params.cycleType === 'ROLLING_MONTH' || startParts.day > fixedDay) {
        targetYear = startParts.month === 12 ? startParts.year + 1 : startParts.year;
        targetMonth = startParts.month === 12 ? 1 : startParts.month + 1;
      }
    } else if (isInitialPartialCycle && startParts.day > fixedDay) {
      throw createError({
        statusCode: 403,
        errorCode: 'POLICY_DECISION_NOT_CONFIRMED',
        message: `Ambiguous initial prepaid service-period boundary for CENTER_FIXED_DAY=${fixedDay} with ADVANCE timing when period_start_date=${resolvedPeriodStart} is after day ${fixedDay} (OWNER-20261104-02 / OWNER-20261104-03)`,
      });
    }

    const maxDayInTargetMonth = daysInCanonicalGregorianMonth(targetYear, targetMonth);
    if (fixedDay > maxDayInTargetMonth) {
      throw createError({
        statusCode: 403,
        errorCode: 'POLICY_DECISION_NOT_CONFIRMED',
        message: `CENTER_FIXED_DAY=${fixedDay} does not exist in target month ${targetYear}-${String(targetMonth).padStart(2, '0')} (max=${maxDayInTargetMonth}); fixed due-day short-month clamping is not assumed from anniversary rules (OWNER-20261104-03)`,
      });
    }
    resolvedDueDate = formatCanonicalIsoDateParts(targetYear, targetMonth, fixedDay);
    resolvedFixedDueDay = fixedDay;
  }

  // 10. Resolve authoritative tariff from Stage 07 price-resolver as of resolvedPeriodStart
  const tariffState = await resolveCanonicalGroupTariffAsOf(tx, {
    centerId: params.centerId,
    courseId: group.course_id,
    groupId: group.id,
    storedCurrentFeeUzs: group.current_fee_uzs,
    asOfDate: resolvedPeriodStart,
    createError,
  });

  // 11. Compute lesson counts and charge amount
  let plannedLessons: number;
  let billableLessons: number;
  let billedLessons: number;
  let baseChargeUzs: bigint;
  let lineType: 'BASE_TARIFF' | 'PRO_RATA_CALC';
  let formulaSnapshot: string;
  let packageRemainingToPersist: number | null = null;
  let packageAllocatedLessonIdsToPersist: readonly string[] | null = null;
  let packageConsumedLessonIdsToPersist: readonly string[] | null = null;

  if (params.cycleType === 'LESSON_PACKAGE_12') {
    const rawKey = params.cycleKey.trim();
    const pkgKeyMatch = /^PKG:([1-9][0-9]*)$/.exec(rawKey);
    if (!pkgKeyMatch) {
      throw createError({
        statusCode: 422,
        errorCode: 'VALIDATION_ERROR',
        message: `LESSON_PACKAGE_12 cycle_key '${rawKey}' must follow canonical format PKG:<positive_seq> (e.g. PKG:1, PKG:2)`,
      });
    }
    const parsedSeq = Number(pkgKeyMatch[1]);
    if (nextCycleSeq !== parsedSeq) {
      throw createError({
        statusCode: 422,
        errorCode: 'VALIDATION_ERROR',
        message: `LESSON_PACKAGE_12 cycle_seq (${nextCycleSeq}) must match cycle_key '${rawKey}'`,
      });
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
    for (const row of priorAllocRes.rows) {
      const list = persistedByCycle.get(row.billing_cycle_id) ?? [];
      list.push(row.lesson_id);
      persistedByCycle.set(row.billing_cycle_id, list);
    }

    const excludedPriorLessonIds = new Set<string>();
    for (const prevCycle of [...prevCyclesRes.rows].reverse()) {
      const tableIds = persistedByCycle.get(prevCycle.id) ?? [];
      const jsonIds = Array.isArray(prevCycle.allocated_lesson_ids_json)
        ? (prevCycle.allocated_lesson_ids_json as string[])
        : null;

      if (tableIds.length === 0 && jsonIds === null) {
        throw createError({
          statusCode: 403,
          errorCode: 'POLICY_DECISION_NOT_CONFIRMED',
          message: `Prior LESSON_PACKAGE_12 cycle '${prevCycle.cycle_key}' has no durable lesson ownership snapshot; live calendar recomputation is forbidden and explicit historical repair policy is required (L02)`,
        });
      }

      for (const id of tableIds) excludedPriorLessonIds.add(id);
      if (jsonIds) {
        for (const id of jsonIds) excludedPriorLessonIds.add(id);
      }
    }

    let expandedChange = true;
    while (expandedChange) {
      expandedChange = false;
      for (const occ of candidateLessons) {
        if (
          occ.rescheduled_from_lesson_id &&
          excludedPriorLessonIds.has(occ.rescheduled_from_lesson_id) &&
          !excludedPriorLessonIds.has(occ.id)
        ) {
          excludedPriorLessonIds.add(occ.id);
          expandedChange = true;
        }
      }
    }

    const lpc = Number(group.lessons_per_cycle);
    if (!Number.isInteger(lpc) || lpc < 1) {
      throw createError({
        statusCode: 422,
        errorCode: 'VALIDATION_ERROR',
        message: 'lessons_per_cycle must be a positive integer for LESSON_PACKAGE_12',
      });
    }

    const eligibleIds: string[] = [];
    const seenLessonIds = new Set<string>();
    for (const occ of candidateLessons) {
      if (seenLessonIds.has(occ.id) || excludedPriorLessonIds.has(occ.id)) continue;
      seenLessonIds.add(occ.id);
      if (occ.status === 'RESCHEDULED') continue;
      if (occ.status === 'CANCELLED_BY_CENTER') {
        if (packageCancelMode === 'CREDIT_NEXT_CYCLE') {
          throw createError({
            statusCode: 403,
            errorCode: 'POLICY_DECISION_NOT_CONFIRMED',
            message:
              'LESSON_PACKAGE_12 cancelled-lesson CreditNote adjustment (CREDIT_NEXT_CYCLE) is not confirmed (D21)',
          });
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
    const consumedIds: string[] = [];
    const consumedSet = new Set<string>();
    for (const r of attendedRes.rows) {
      if (eligibleSet.has(r.lesson_id) && !consumedSet.has(r.lesson_id)) {
        consumedSet.add(r.lesson_id);
        consumedIds.push(r.lesson_id);
      }
    }
    const cappedConsumed = consumedIds.slice(0, lpc);

    plannedLessons = lpc;
    billableLessons = lpc;
    billedLessons = lpc;
    baseChargeUzs = tariffState.effectiveFeeAsOfUzs;
    const tariffStr = baseChargeUzs.toString(10);
    lineType = 'BASE_TARIFF';
    formulaSnapshot = `FULL_PERIOD: ${tariffStr} * ${lpc}/${lpc} = ${tariffStr} (${roundingMode})`;
    packageRemainingToPersist = Math.max(0, lpc - cappedConsumed.length);
    packageAllocatedLessonIdsToPersist = Object.freeze(eligibleIds);
    packageConsumedLessonIdsToPersist = Object.freeze(cappedConsumed);
  } else {
    const billableStartFloor =
      effectiveEnrollmentStart > resolvedPeriodStart
        ? effectiveEnrollmentStart
        : resolvedPeriodStart;
    const periodEndStr = resolvedPeriodEnd ?? resolvedPeriodStart;

    if (candidateLessons.length > 0) {
      const inWindow = candidateLessons.filter(
        (l) => l.lesson_date >= resolvedPeriodStart && l.lesson_date <= periodEndStr,
      );
      const eligible = [];
      for (const l of inWindow) {
        if (l.status === 'RESCHEDULED') continue;
        if (l.status === 'CANCELLED_BY_CENTER') {
          if (cancelledLessonProrationMode === 'UNCONFIGURED') {
            throw createError({
              statusCode: 403,
              errorCode: 'POLICY_DECISION_NOT_CONFIRMED',
              message:
                'Period contains CANCELLED_BY_CENTER lessons while cancelled_lesson_proration_mode is UNCONFIGURED',
            });
          }
          if (cancelledLessonProrationMode === 'EXCLUDE_CANCELLED_FROM_PLANNED') {
            continue;
          }
        }
        eligible.push(l);
      }
      if (eligible.length === 0) {
        throw createError({
          statusCode: 422,
          errorCode: 'INVALID_SCHEDULE_ZERO_LESSONS',
          message: `Zero eligible planned lessons in service period ${resolvedPeriodStart}..${periodEndStr}; billing is blocked (T08.01)`,
        });
      }
      plannedLessons = eligible.length;
      billableLessons = eligible.filter((l) => l.lesson_date >= billableStartFloor).length;
    } else {
      const schedDays: CanonicalScheduleDayCode[] = Array.isArray(group.schedule_days_json)
        ? group.schedule_days_json
        : ['MON', 'WED', 'FRI'];
      const scheduleSet = new Set<CanonicalScheduleDayCode>(schedDays);
      const allDates = enumerateCanonicalCalendarDatesInclusive(resolvedPeriodStart, periodEndStr);
      const plannedDates = allDates.filter((d) =>
        scheduleSet.has(getCanonicalIsoDateWeekday(d)),
      );
      if (plannedDates.length === 0) {
        throw createError({
          statusCode: 422,
          errorCode: 'INVALID_SCHEDULE_ZERO_LESSONS',
          message: `Zero scheduled lessons in service period ${resolvedPeriodStart}..${periodEndStr}; billing is blocked (T08.01)`,
        });
      }
      plannedLessons = plannedDates.length;
      billableLessons = plannedDates.filter((d) => d >= billableStartFloor).length;
    }

    const tariffStr = tariffState.effectiveFeeAsOfUzs.toString(10);
    const isPartial = isFirstPartialPeriod || billableLessons < plannedLessons;
    if (!isPartial && billableLessons === plannedLessons) {
      billedLessons = plannedLessons;
      baseChargeUzs = tariffState.effectiveFeeAsOfUzs;
      lineType = 'BASE_TARIFF';
      formulaSnapshot = `FULL_PERIOD: ${tariffStr} * ${plannedLessons}/${plannedLessons} = ${tariffStr} (${roundingMode})`;
    } else if (firstPartialChargeMode === 'FULL_CYCLE') {
      if (billableLessons === 0) {
        throw createError({
          statusCode: 403,
          errorCode: 'POLICY_DECISION_NOT_CONFIRMED',
          message:
            'FULL_CYCLE first-charge policy cannot bill a zero-lesson / no-service partial period (remaining_lessons=0) without explicit policy confirmation',
        });
      }
      billedLessons = plannedLessons;
      baseChargeUzs = tariffState.effectiveFeeAsOfUzs;
      lineType = 'BASE_TARIFF';
      formulaSnapshot = `FULL_CYCLE: ${tariffStr} (remaining_lessons=${billableLessons}/${plannedLessons}, ${roundingMode})`;
    } else {
      billedLessons = billableLessons;
      baseChargeUzs =
        billableLessons === 0
          ? 0n
          : roundCanonicalRationalHalfUpUzs(
              tariffState.effectiveFeeAsOfUzs * BigInt(billableLessons),
              BigInt(plannedLessons),
              createError,
            );
      const chargeStr = baseChargeUzs.toString(10);
      lineType = 'PRO_RATA_CALC';
      formulaSnapshot = `PRO_RATA: ${tariffStr} * ${billableLessons}/${plannedLessons} = ${chargeStr} (${roundingMode})`;
    }
  }

  // 12. Apply available credit notes up to baseChargeUzs cap under enrollment FOR UPDATE serialization
  const applyCredits = params.applyAvailableCreditNotes ?? true;
  const approvedDiscountUzs = 0n;
  let totalCreditAppliedUzs = 0n;
  const creditNoteApplicationsToInsert: Array<{
    readonly creditNoteId: string;
    readonly appliedAmountUzs: bigint;
    readonly creditReason: string;
  }> = [];

  if (applyCredits && baseChargeUzs > 0n) {
    const creditNotesRes = await tx.query<{
      id: string;
      amount_uzs: string;
      already_applied_uzs: string;
      credit_reason: string;
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

    let remainingCap = baseChargeUzs - approvedDiscountUzs;
    for (const cn of creditNotesRes.rows) {
      if (remainingCap <= 0n) break;
      const avail = BigInt(cn.amount_uzs) - BigInt(cn.already_applied_uzs);
      if (avail <= 0n) continue;
      const toApply = avail <= remainingCap ? avail : remainingCap;
      totalCreditAppliedUzs += toApply;
      remainingCap -= toApply;
      creditNoteApplicationsToInsert.push({
        creditNoteId: cn.id,
        appliedAmountUzs: toApply,
        creditReason: cn.credit_reason,
      });
    }
  }

  const effectiveNetChargeUzs =
    baseChargeUzs - approvedDiscountUzs - totalCreditAppliedUzs > 0n
      ? baseChargeUzs - approvedDiscountUzs - totalCreditAppliedUzs
      : 0n;
  const allocatedPaidUzs = 0n;
  const remainingDebtUzs = effectiveNetChargeUzs;

  const invoiceStatus: InvoiceStatus =
    effectiveNetChargeUzs === 0n
      ? approvedDiscountUzs > 0n
        ? 'GRANT_ZERO'
        : 'PAID'
      : 'ISSUED_OPEN';

  // 13. Insert BillingCycle
  const billingCycleId = crypto.randomUUID();
  const effectiveFirstChargeModeSnapshot =
    firstPartialChargeMode === 'UNCONFIGURED'
      ? 'PRORATE_REMAINING_LESSONS'
      : firstPartialChargeMode;

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
      policyRow.id,
      group.due_date_rule,
      resolvedFixedDueDay,
      group.collection_timing,
      effectiveFirstChargeModeSnapshot,
      packageAllocatedLessonIdsToPersist !== null
        ? JSON.stringify(packageAllocatedLessonIdsToPersist)
        : null,
      packageConsumedLessonIdsToPersist !== null
        ? JSON.stringify(packageConsumedLessonIdsToPersist)
        : null,
      CANONICAL_BILLING_CALCULATION_VERSION,
      params.now.toISOString(),
    ],
  );
  maybeInjectCanonicalTestFault(
    'BILLING_CYCLE',
    enableFaults,
    params.testFaultAfterStep,
  );

  // 13b. L02: Insert normalized immutable billing_cycle_lesson_allocations rows for LESSON_PACKAGE_12
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
          params.now.toISOString(),
        ],
      );
    }
    maybeInjectCanonicalTestFault(
      'PACKAGE_ALLOCATIONS',
      enableFaults,
      params.testFaultAfterStep,
    );
  }

  // 14. Insert Invoice
  const invoiceId = crypto.randomUUID();
  const invoiceNumber = await allocateCanonicalNextInvoiceNumber(
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
       $10::bigint, $11::bigint,
       $12::bigint, $13::bigint,
       $14::bigint, $15::bigint,
       $16::int, 0,
       $17, $18::date, $19,
       $20, 1, $21::timestamptz, $21::timestamptz
     )`,
    [
      invoiceId,
      params.centerId,
      invoiceNumber,
      enrollment.student_id,
      params.enrollmentId,
      billingCycleId,
      policyRow.id,
      tariffState.effectiveFeeAsOfUzs.toString(10),
      tariffState.tariffEffectiveFromSnapshot,
      baseChargeUzs.toString(10),
      approvedDiscountUzs.toString(10),
      totalCreditAppliedUzs.toString(10),
      effectiveNetChargeUzs.toString(10),
      allocatedPaidUzs.toString(10),
      remainingDebtUzs.toString(10),
      billedLessons,
      invoiceStatus,
      resolvedDueDate,
      group.collection_timing,
      CANONICAL_BILLING_CALCULATION_VERSION,
      params.now.toISOString(),
    ],
  );
  maybeInjectCanonicalTestFault('INVOICE', enableFaults, params.testFaultAfterStep);

  // Update enrollment rolling anchor or package remaining lessons if applicable
  if (params.cycleType === 'ROLLING_MONTH') {
    const anchorDay = Number(resolvedPeriodStart.slice(8, 10));
    await tx.query(
      `UPDATE "enrollments"
          SET "billing_anchor_day" = $1::smallint,
              "updated_at" = $2::timestamptz
        WHERE "id" = $3::uuid
          AND "center_id" = $4::uuid`,
      [anchorDay, params.now.toISOString(), params.enrollmentId, params.centerId],
    );
  } else if (params.cycleType === 'LESSON_PACKAGE_12' && packageRemainingToPersist !== null) {
    await tx.query(
      `UPDATE "enrollments"
          SET "package_lessons_remaining" = $1::int,
              "updated_at" = $2::timestamptz
        WHERE "id" = $3::uuid
          AND "center_id" = $4::uuid`,
      [packageRemainingToPersist, params.now.toISOString(), params.enrollmentId, params.centerId],
    );
  }

  // 15. Insert InvoiceLine(s) and CreditNoteApplication(s)
  const truncatedJobName = params.systemJobName ? params.systemJobName.slice(0, 64) : null;
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
      params.now.toISOString(),
    ],
  );

  for (const cna of creditNoteApplicationsToInsert) {
    await tx.query(
      `INSERT INTO "credit_note_applications" (
         "id", "center_id", "credit_note_id", "unapplied_credit_id",
         "target_invoice_id", "applied_amount_uzs",
         "actor_type", "actor_staff_id", "system_job_name", "created_at"
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, NULL,
         $4::uuid, $5::bigint,
         $6, $7::uuid, $8, $9::timestamptz
       )`,
      [
        crypto.randomUUID(),
        params.centerId,
        cna.creditNoteId,
        invoiceId,
        cna.appliedAmountUzs.toString(10),
        params.actorType,
        params.actorStaffId,
        truncatedJobName,
        params.now.toISOString(),
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
        params.now.toISOString(),
      ],
    );
  }
  maybeInjectCanonicalTestFault('INVOICE_LINES', enableFaults, params.testFaultAfterStep);

  // 16. Insert LedgerEntry(s) (INVOICE_ISSUED + any CREDIT_NOTE_APPLIED)
  await tx.query(
    `INSERT INTO "ledger_entries" (
       "id", "center_id", "entry_type", "student_id", "invoice_id",
       "direction", "amount_uzs", "actor_type", "actor_staff_id",
       "system_job_name", "created_at"
     ) VALUES (
       $1::uuid, $2::uuid, 'INVOICE_ISSUED', $3::uuid, $4::uuid,
       'DEBIT', $5::bigint, $6, $7::uuid,
       $8, $9::timestamptz
     )`,
    [
      crypto.randomUUID(),
      params.centerId,
      enrollment.student_id,
      invoiceId,
      baseChargeUzs.toString(10),
      params.actorType,
      params.actorStaffId,
      truncatedJobName,
      params.now.toISOString(),
    ],
  );

  for (const cna of creditNoteApplicationsToInsert) {
    await tx.query(
      `INSERT INTO "ledger_entries" (
         "id", "center_id", "entry_type", "student_id", "invoice_id",
         "credit_note_id", "direction", "amount_uzs",
         "actor_type", "actor_staff_id", "system_job_name", "created_at"
       ) VALUES (
         $1::uuid, $2::uuid, 'CREDIT_NOTE_APPLIED', $3::uuid, $4::uuid,
         $5::uuid, 'CREDIT', $6::bigint,
         $7, $8::uuid, $9, $10::timestamptz
       )`,
      [
        crypto.randomUUID(),
        params.centerId,
        enrollment.student_id,
        invoiceId,
        cna.creditNoteId,
        cna.appliedAmountUzs.toString(10),
        params.actorType,
        params.actorStaffId,
        truncatedJobName,
        params.now.toISOString(),
      ],
    );
  }
  maybeInjectCanonicalTestFault('LEDGER_ENTRY', enableFaults, params.testFaultAfterStep);

  // 17. Insert AuditLog
  await tx.query(
    `INSERT INTO "audit_logs" (
       "id", "center_id", "actor_type", "actor_id", "actor_role",
       "action", "entity_type", "entity_id", "severity",
       "after_redacted_json", "request_id", "created_at"
     ) VALUES (
       $1::uuid, $2::uuid, $3, $4::uuid, $5,
       'BILLING_CYCLE_INVOICE_ISSUED', 'Invoice', $6::uuid, 'INFO',
       $7::jsonb, $8, $9::timestamptz
     )`,
    [
      crypto.randomUUID(),
      params.centerId,
      params.actorType,
      params.actorStaffId,
      params.actorRole,
      invoiceId,
      JSON.stringify({
        invoice_id: invoiceId,
        invoice_number: invoiceNumber,
        enrollment_id: params.enrollmentId,
        billing_cycle_id: billingCycleId,
        cycle_type: params.cycleType,
        cycle_key: params.cycleKey,
        tariff_snapshot_uzs: tariffState.effectiveFeeAsOfUzs.toString(10),
        base_pro_rata_charge_uzs: baseChargeUzs.toString(10),
        credit_note_adjustments_uzs: totalCreditAppliedUzs.toString(10),
        effective_net_charge_uzs: effectiveNetChargeUzs.toString(10),
        remaining_debt_uzs: remainingDebtUzs.toString(10),
        due_date: resolvedDueDate,
        policy_version_id: policyRow.id,
        allocated_lesson_ids: packageAllocatedLessonIdsToPersist,
      }),
      params.requestId.slice(0, 64),
      params.now.toISOString(),
    ],
  );
  maybeInjectCanonicalTestFault('AUDIT_LOG', enableFaults, params.testFaultAfterStep);

  // 18. Insert OutboxEvent (AllocationAdjusted v1)
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
      params.now.toISOString(),
    ],
  );
  maybeInjectCanonicalTestFault('OUTBOX_EVENT', enableFaults, params.testFaultAfterStep);

  const dto = await loadCanonicalInvoiceResponseInTx(tx, params.centerId, invoiceId, createError);
  return { invoice: dto, replayedByCycleIdentity: false };
}
