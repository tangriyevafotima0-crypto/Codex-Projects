/**
 * EduERP v2.0 — Stage 08, Step 08.04 (`T08.04`):
 * Idempotent BillingCycle & Invoice Generator, Authoritative Historical Tariff Snapshot,
 * CreditNote Application Cap Boundary, and Atomic Ledger/Audit/Outbox Execution.
 */

import { Inject, Injectable } from '@nestjs/common';
import type {
  BillingCycleType,
  BillingMode,
  CollectionTiming,
  DueDateRule,
  InvoiceStatus,
} from '@eduerp/contracts';
import * as crypto from 'node:crypto';
import { ApiHttpException } from '../auth/auth.errors';
import { ClockService } from '../auth/clock.service';
import { AuthenticatedStaffPrincipal } from '../auth/permissions.guard';
import {
  assertPlainObject,
  assertValidUuid,
  requireIdempotencyKeyHeader,
} from '../auth/validation';
import { RequestWithCorrelationId, resolveRequestId } from '../common/request-id.middleware';
import { ApiEnvConfig } from '../config/env';
import { API_CONFIG_TOKEN } from '../config/tokens';
import { DatabaseService } from '../database/database.service';
import { executeIdempotentOperation } from '../database/idempotency';
import { formatMoneyUzs } from '../database/money';
import { runInTransaction, TransactionContext } from '../database/transaction';
import { parseOptionalStrictBoolean, validateIsoDate } from '../students/normalization';
import { ScheduleDayCode } from '../academics/academic-validation';
import { resolveGroupTariffState } from '../academics/price-resolver';
import {
  assertConfirmedPolicyForBillingExecution,
  BILLING_CALCULATION_VERSION,
  BillingPolicyService,
  BillingPolicyVersionDto,
} from './policy';
import {
  calculateProRataOrCycleChargeUzs,
  LessonCandidateForPeriodSnapshot,
  selectPeriodLessonSnapshot,
} from './calendar-proration';
import {
  assertGroupBillingModeMatchesCycleType,
  assertServicePeriodEligibleForEnrollmentBegin,
  buildCalendarMonthCycleSpec,
  buildLessonPackage12CycleSpec,
  buildRollingMonthCycleSpec,
  resolveCycleDueDate,
} from './subscriptions';

export type FaultInjectionStep =
  | 'BILLING_CYCLE'
  | 'INVOICE'
  | 'INVOICE_LINES'
  | 'LEDGER_ENTRY'
  | 'AUDIT_LOG'
  | 'OUTBOX_EVENT';

export interface InvoiceLineDto {
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

export interface InvoiceResponseDto {
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
  readonly lines: readonly InvoiceLineDto[];
}

export interface InvoiceListResponseDto {
  readonly items: readonly InvoiceResponseDto[];
  readonly next_cursor: string | null;
}

export interface InternalIssueInvoiceParams {
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
  readonly testFaultAfterStep?: FaultInjectionStep;
}

function formatPgDate(val: unknown): string | null {
  if (val === null || val === undefined) return null;
  if (val instanceof Date) return val.toISOString().slice(0, 10);
  return String(val).slice(0, 10);
}

const ALLOWED_CYCLE_TYPES: ReadonlySet<BillingCycleType> = new Set([
  'CALENDAR_MONTH',
  'ROLLING_MONTH',
  'LESSON_PACKAGE_12',
]);

@Injectable()
export class InvoiceGeneratorService {
  constructor(
    @Inject(API_CONFIG_TOKEN) private readonly config: ApiEnvConfig,
    @Inject(DatabaseService) private readonly databaseService: DatabaseService,
    @Inject(ClockService) private readonly clock: ClockService,
    @Inject(BillingPolicyService) private readonly policyService: BillingPolicyService,
  ) {}

  private maybeInjectTestFault(
    targetStep: FaultInjectionStep,
    configuredFault?: FaultInjectionStep,
  ): void {
    if (this.config.nodeEnv === 'test' && configuredFault === targetStep) {
      throw new Error(`SIMULATED_S08_FAULT_AFTER_${targetStep}`);
    }
  }

  /**
   * Generates a center-scoped concurrent-safe invoice number (`INV-YYYYMM-XXXXXX`),
   * serialized via `pg_advisory_xact_lock` on `(centerId, 'INVOICE_NUMBER_SEQ')` so
   * parallel invoice transactions never collide on `uq_invoices_center_number`.
   */
  private async allocateNextInvoiceNumber(
    tx: TransactionContext,
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

  public async loadInvoiceResponseInTx(
    tx: Pick<DatabaseService, 'query'> | TransactionContext,
    centerId: string,
    invoiceId: string,
  ): Promise<InvoiceResponseDto> {
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
      throw new ApiHttpException({
        statusCode: 404,
        errorCode: 'NOT_FOUND',
        message: 'Invoice not found in center scope',
      });
    }

    const linesRes = await tx.query<{
      id: string;
      line_type: InvoiceLineDto['line_type'];
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
      period_start_date: formatPgDate(row.period_start_date) ?? '1970-01-01',
      period_end_date: formatPgDate(row.period_end_date),
      planned_lessons: Number(row.planned_lessons),
      billable_lessons: Number(row.billable_lessons),
      billed_lessons: Number(row.billed_lessons),
      frozen_credited_lessons: Number(row.frozen_credited_lessons),
      currency: 'UZS',
      tariff_snapshot_uzs: BigInt(row.tariff_snapshot_uzs).toString(10),
      tariff_effective_from_snapshot: formatPgDate(row.tariff_effective_from_snapshot),
      base_pro_rata_charge_uzs: BigInt(row.base_pro_rata_charge_uzs).toString(10),
      approved_discount_uzs: BigInt(row.approved_discount_uzs).toString(10),
      credit_note_adjustments_uzs: BigInt(row.credit_note_adjustments_uzs).toString(10),
      effective_net_charge_uzs: BigInt(row.effective_net_charge_uzs).toString(10),
      allocated_paid_uzs: BigInt(row.allocated_paid_uzs).toString(10),
      remaining_debt_uzs: BigInt(row.remaining_debt_uzs).toString(10),
      status: row.status,
      due_date: formatPgDate(row.due_date) ?? '1970-01-01',
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

  /**
   * Core transactional BillingCycle + Invoice + InvoiceLine + LedgerEntry + AuditLog + OutboxEvent execution.
   * Called both by `POST /api/v1/billing/cycles/invoice` and by `TrialConversionService` inside an existing `tx`.
   */
  public async issueCycleInvoiceWithinTransaction(
    tx: TransactionContext,
    params: InternalIssueInvoiceParams,
  ): Promise<{ readonly invoice: InvoiceResponseDto; readonly replayedByCycleIdentity: boolean }> {
    // 1. Lock enrollment row FOR UPDATE to serialize concurrent invoice issuance on the same enrollment
    const enrRes = await tx.query<{
      id: string;
      center_id: string;
      student_id: string;
      group_id: string;
      status: string;
      enrolled_at_date: unknown;
      first_trial_date: unknown;
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
      throw new ApiHttpException({
        statusCode: 404,
        errorCode: 'NOT_FOUND',
        message: 'Enrollment not found in center scope',
      });
    }
    if (enrollment.status === 'LEFT') {
      throw new ApiHttpException({
        statusCode: 422,
        errorCode: 'VALIDATION_ERROR',
        message: 'Cannot issue a new billing cycle invoice for a LEFT enrollment',
      });
    }
    if (enrollment.status === 'TRIAL') {
      throw new ApiHttpException({
        statusCode: 422,
        errorCode: 'VALIDATION_ERROR',
        message:
          'Cannot issue a billing cycle invoice for a TRIAL enrollment before canonical 2nd distinct attended lesson activates the enrollment (T08.03 / K03)',
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
      const existingStart = formatPgDate(existingCycle.period_start_date);
      const existingEnd = formatPgDate(existingCycle.period_end_date);
      if (
        existingStart !== params.periodStartDate ||
        (params.periodEndDate !== undefined &&
          params.periodEndDate !== null &&
          existingEnd !== params.periodEndDate)
      ) {
        throw new ApiHttpException({
          statusCode: 409,
          errorCode: 'VERSION_CONFLICT',
          message: `BillingCycle (${params.cycleType}, ${params.cycleKey}) already exists for enrollment with period ${existingStart}..${existingEnd ?? 'NULL'} (cannot reissue with conflicting period ${params.periodStartDate}..${params.periodEndDate ?? 'NULL'})`,
        });
      }
      const existingDto = await this.loadInvoiceResponseInTx(
        tx,
        params.centerId,
        existingCycle.invoice_id,
      );
      return { invoice: existingDto, replayedByCycleIdentity: true };
    }

    // 3. Load group and course metadata
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
      throw new ApiHttpException({
        statusCode: 404,
        errorCode: 'NOT_FOUND',
        message: 'Course group for enrollment not found in center scope',
      });
    }

    assertGroupBillingModeMatchesCycleType(group.billing_mode, params.cycleType);

    // 4. Resolve active BillingPolicyVersion as of periodStartDate
    const policy: BillingPolicyVersionDto =
      await this.policyService.resolveActivePolicyForGroupPeriod(
        tx,
        params.centerId,
        group.billing_mode,
        group.billing_policy_version_id,
        params.periodStartDate,
      );

    // 5. Inspect previous cycles for this enrollment to determine cycle_seq and rolling chain continuity
    const prevCyclesRes = await tx.query<{
      id: string;
      cycle_key: string;
      cycle_seq: number;
      period_start_date: unknown;
      period_end_date: unknown;
    }>(
      `SELECT "id"::text AS id,
              "cycle_key",
              "cycle_seq",
              "period_start_date"::text AS period_start_date,
              "period_end_date"::text AS period_end_date
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
      formatPgDate(enrollment.first_trial_date) ??
      formatPgDate(enrollment.enrolled_at_date) ??
      params.periodStartDate;

    // 6. Build cycle spec and resolve period boundaries (enforcing K04 serviceBeginDate eligibility)
    let resolvedPeriodStart = params.periodStartDate;
    let resolvedPeriodEnd: string | null = params.periodEndDate ?? null;
    let effectiveEnrollmentStart = enrollmentBillingStartDate;
    let isFirstPartialPeriod = false;

    if (params.cycleType === 'CALENDAR_MONTH') {
      const calSpec = buildCalendarMonthCycleSpec({
        periodStartDate: params.periodStartDate,
        periodEndDate: params.periodEndDate,
        cycleKey: params.cycleKey,
        cycleSeq: nextCycleSeq,
        enrollmentBillingStartDate,
      });
      resolvedPeriodStart = calSpec.periodStartDate;
      resolvedPeriodEnd = calSpec.periodEndDate;
      effectiveEnrollmentStart = calSpec.effectiveEnrollmentStartDate;
      isFirstPartialPeriod = calSpec.isFirstPartialPeriod;
    } else if (params.cycleType === 'ROLLING_MONTH') {
      const prevEnd = latestPrevCycle ? formatPgDate(latestPrevCycle.period_end_date) : null;
      const rolSpec = buildRollingMonthCycleSpec({
        periodStartDate: params.periodStartDate,
        periodEndDate: params.periodEndDate,
        cycleKey: params.cycleKey,
        cycleSeq: nextCycleSeq,
        previousCycleEndDate: prevEnd,
        enrollmentBillingStartDate,
        rollingMonthEndMode: policy.rolling_month_end_mode,
      });
      resolvedPeriodStart = rolSpec.periodStartDate;
      resolvedPeriodEnd = rolSpec.periodEndDate;
      effectiveEnrollmentStart = rolSpec.effectiveEnrollmentStartDate;
      isFirstPartialPeriod = rolSpec.isFirstPartialPeriod;
    } else {
      assertServicePeriodEligibleForEnrollmentBegin({
        cycleType: 'LESSON_PACKAGE_12',
        periodStartDate: params.periodStartDate,
        periodEndDate: params.periodEndDate ?? null,
        serviceBeginDate: enrollmentBillingStartDate,
      });
    }

    // Check for overlapping date-bounded cycles under a different cycle_key on the same enrollment
    if (resolvedPeriodEnd !== null) {
      for (const prev of prevCyclesRes.rows) {
        const pStart = formatPgDate(prev.period_start_date);
        const pEnd = formatPgDate(prev.period_end_date);
        if (pStart && pEnd && resolvedPeriodStart <= pEnd && resolvedPeriodEnd >= pStart) {
          throw new ApiHttpException({
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
    }>(
      `SELECT "id"::text AS id,
              "lesson_date"::text AS lesson_date,
              "occurrence_seq",
              "status"::text AS status,
              "cancellation_source"::text AS cancellation_source
         FROM "lesson_occurrences"
        WHERE "center_id" = $1::uuid
          AND "group_id" = $2::uuid
          AND "lesson_date" >= $3::date
          AND "lesson_date" <= $4::date
        ORDER BY "lesson_date" ASC, "occurrence_seq" ASC, "id" ASC`,
      [params.centerId, group.id, resolvedPeriodStart, lessonWindowEnd],
    );

    const candidateLessons: LessonCandidateForPeriodSnapshot[] = lessonsRes.rows.map((r) => ({
      id: r.id,
      lesson_date: formatPgDate(r.lesson_date) ?? resolvedPeriodStart,
      occurrence_seq: Number(r.occurrence_seq),
      status: r.status,
      cancellation_source: r.cancellation_source,
    }));

    const hasCancelledLessonsInWindow = candidateLessons.some(
      (l) => l.status === 'CANCELLED_BY_CENTER',
    );

    // 8. Enforce policy confirmation boundary before any calculation or write (K02, OWNER-20261104-02 / 03)
    assertConfirmedPolicyForBillingExecution({
      policy,
      periodStartDate: resolvedPeriodStart,
      isFirstPartialPeriod,
      isRollingMonth: params.cycleType === 'ROLLING_MONTH',
      isLessonPackage12: params.cycleType === 'LESSON_PACKAGE_12',
      hasCancelledLessonsInPackageWindow: hasCancelledLessonsInWindow,
    });

    // 9. Resolve due date orthogonally per due_date_rule and collection_timing
    const dueDateResolved = resolveCycleDueDate({
      cycleType: params.cycleType,
      periodStartDate: resolvedPeriodStart,
      periodEndDate: resolvedPeriodEnd,
      dueDateRule: group.due_date_rule,
      fixedDueDay: group.fixed_due_day !== null ? Number(group.fixed_due_day) : null,
      collectionTiming: group.collection_timing,
      isInitialCycle: nextCycleSeq === 1 && isFirstPartialPeriod,
      enforceConfirmed: true,
    });

    // 10. Resolve authoritative tariff from Stage 07 price-resolver as of resolvedPeriodStart (never today!)
    const tariffState = await resolveGroupTariffState(tx, {
      centerId: params.centerId,
      courseId: group.course_id,
      groupId: group.id,
      storedCurrentFeeUzs: group.current_fee_uzs,
      asOfDate: resolvedPeriodStart,
    });
    const activeHistoryEntry = tariffState.history.find(
      (h) => h.effective_from <= resolvedPeriodStart,
    );
    const tariffEffectiveFromSnapshot = activeHistoryEntry
      ? activeHistoryEntry.effective_from
      : null;

    // 11. Compute lesson counts and charge amount
    let plannedLessons: number;
    let billableLessons: number;
    let chargeResult: ReturnType<typeof calculateProRataOrCycleChargeUzs>;
    let packageRemainingToPersist: number | null = null;

    if (params.cycleType === 'LESSON_PACKAGE_12') {
      // K07: Load all eligible group lessons on/after enrollmentBillingStartDate and partition by package cycle_seq
      // so PKG:1 and PKG:2 never double-consume the same lesson!
      const allGroupLessonsRes = await tx.query<{
        id: string;
        lesson_date: unknown;
        occurrence_seq: number;
        status: string;
      }>(
        `SELECT "id"::text AS id,
                "lesson_date"::text AS lesson_date,
                "occurrence_seq",
                "status"::text AS status
           FROM "lesson_occurrences"
          WHERE "center_id" = $1::uuid
            AND "group_id" = $2::uuid
            AND "lesson_date" >= $3::date
          ORDER BY "lesson_date" ASC, "occurrence_seq" ASC, "id" ASC`,
        [params.centerId, group.id, enrollmentBillingStartDate],
      );

      const lpc = Number(group.lessons_per_cycle);
      const priorNonCancelledIds: string[] = [];
      for (const l of allGroupLessonsRes.rows) {
        if (l.status === 'RESCHEDULED' || l.status === 'CANCELLED_BY_CENTER') continue;
        if (priorNonCancelledIds.length < (nextCycleSeq - 1) * lpc) {
          priorNonCancelledIds.push(l.id);
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

      const pkgSpec = buildLessonPackage12CycleSpec({
        cycleKey: params.cycleKey,
        cycleSeq: nextCycleSeq,
        periodStartDate: resolvedPeriodStart,
        periodEndDate: resolvedPeriodEnd,
        enrollmentBillingStartDate,
        lessonsPerCycle: lpc,
        packageCancelMode: policy.package_cancel_mode,
        lessonOccurrences: candidateLessons,
        alreadyAllocatedLessonIds: priorNonCancelledIds,
        attendedLessonIds: attendedRes.rows.map((r) => r.lesson_id),
      });

      plannedLessons = pkgSpec.lessonsPerCycle;
      billableLessons = pkgSpec.lessonsPerCycle;
      packageRemainingToPersist = pkgSpec.packageLessonsRemaining;

      chargeResult = calculateProRataOrCycleChargeUzs({
        tariffUzs: tariffState.effective_fee_as_of_uzs,
        plannedLessons,
        remainingLessons: billableLessons,
        isFirstPartialPeriod: false,
        firstPartialChargeMode: policy.first_partial_charge_mode,
        roundingMode: policy.rounding_mode,
      });
    } else {
      const lessonSnapshot = selectPeriodLessonSnapshot({
        periodStartDate: resolvedPeriodStart,
        periodEndDate: resolvedPeriodEnd ?? resolvedPeriodStart,
        effectiveEnrollmentStartDate: effectiveEnrollmentStart,
        lessonOccurrences: candidateLessons,
        scheduleDays: Array.isArray(group.schedule_days_json) ? group.schedule_days_json : ['MON', 'WED', 'FRI'],
        cancelledLessonProrationMode: policy.cancelled_lesson_proration_mode,
      });

      plannedLessons = lessonSnapshot.plannedLessons;
      billableLessons = lessonSnapshot.billableLessons;

      chargeResult = calculateProRataOrCycleChargeUzs({
        tariffUzs: tariffState.effective_fee_as_of_uzs,
        plannedLessons,
        remainingLessons: billableLessons,
        isFirstPartialPeriod,
        firstPartialChargeMode: policy.first_partial_charge_mode,
        roundingMode: policy.rounding_mode,
      });
    }

    // 12. Resolve available existing unconsumed CreditNotes on this enrollment (capped at baseProRataChargeUzs)
    const applyCredits = params.applyAvailableCreditNotes ?? true;
    const baseChargeUzs = chargeResult.chargeUzs;
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
      policy.first_partial_charge_mode === 'UNCONFIGURED'
        ? 'PRORATE_REMAINING_LESSONS'
        : policy.first_partial_charge_mode;

    await tx.query(
      `INSERT INTO "billing_cycles" (
         "id", "center_id", "enrollment_id", "cycle_type", "cycle_key", "cycle_seq",
         "period_start_date", "period_end_date", "planned_lessons", "billable_lessons",
         "policy_version_id", "due_date_rule_snapshot", "fixed_due_day_snapshot",
         "collection_timing_snapshot", "first_partial_charge_mode_snapshot",
         "calculation_version", "created_at"
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4, $5, $6::int,
         $7::date, $8::date, $9::int, $10::int,
         $11::uuid, $12, $13::smallint,
         $14, $15,
         $16, $17::timestamptz
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
        effectiveFirstChargeModeSnapshot,
        BILLING_CALCULATION_VERSION,
        params.now.toISOString(),
      ],
    );
    this.maybeInjectTestFault('BILLING_CYCLE', params.testFaultAfterStep);

    // 14. Insert Invoice
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
        policy.id,
        formatMoneyUzs(chargeResult.tariffSnapshotUzs),
        tariffEffectiveFromSnapshot,
        formatMoneyUzs(baseChargeUzs),
        formatMoneyUzs(approvedDiscountUzs),
        formatMoneyUzs(totalCreditAppliedUzs),
        formatMoneyUzs(effectiveNetChargeUzs),
        formatMoneyUzs(allocatedPaidUzs),
        formatMoneyUzs(remainingDebtUzs),
        chargeResult.billedLessons,
        invoiceStatus,
        dueDateResolved.dueDate,
        dueDateResolved.collectionTiming,
        BILLING_CALCULATION_VERSION,
        params.now.toISOString(),
      ],
    );
    this.maybeInjectTestFault('INVOICE', params.testFaultAfterStep);

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
        chargeResult.lineType,
        `${params.cycleType} (${params.cycleKey}) charge (${chargeResult.billedLessons}/${plannedLessons} lessons)`,
        formatMoneyUzs(baseChargeUzs),
        chargeResult.formulaSnapshot,
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
          formatMoneyUzs(cna.appliedAmountUzs),
          params.actorType,
          params.actorStaffId,
          params.systemJobName,
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
          `-${formatMoneyUzs(cna.appliedAmountUzs)}`,
          `CREDIT_NOTE_CAP: min(available, remaining_charge) = ${formatMoneyUzs(cna.appliedAmountUzs)}`,
          params.now.toISOString(),
        ],
      );
    }
    this.maybeInjectTestFault('INVOICE_LINES', params.testFaultAfterStep);

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
        formatMoneyUzs(baseChargeUzs),
        params.actorType,
        params.actorStaffId,
        params.systemJobName,
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
          formatMoneyUzs(cna.appliedAmountUzs),
          params.actorType,
          params.actorStaffId,
          params.systemJobName,
          params.now.toISOString(),
        ],
      );
    }
    this.maybeInjectTestFault('LEDGER_ENTRY', params.testFaultAfterStep);

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
          tariff_snapshot_uzs: formatMoneyUzs(chargeResult.tariffSnapshotUzs),
          base_pro_rata_charge_uzs: formatMoneyUzs(baseChargeUzs),
          credit_note_adjustments_uzs: formatMoneyUzs(totalCreditAppliedUzs),
          effective_net_charge_uzs: formatMoneyUzs(effectiveNetChargeUzs),
          remaining_debt_uzs: formatMoneyUzs(remainingDebtUzs),
          due_date: dueDateResolved.dueDate,
          policy_version_id: policy.id,
        }),
        params.requestId,
        params.now.toISOString(),
      ],
    );
    this.maybeInjectTestFault('AUDIT_LOG', params.testFaultAfterStep);

    // 18. Insert OutboxEvent (AllocationAdjusted v1 per docs/architecture/events.md#evt-AllocationAdjusted)
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
          new_remaining_debt_uzs: formatMoneyUzs(remainingDebtUzs),
          invoice_status: invoiceStatus,
        }),
        params.now.toISOString(),
      ],
    );
    this.maybeInjectTestFault('OUTBOX_EVENT', params.testFaultAfterStep);

    const dto = await this.loadInvoiceResponseInTx(tx, params.centerId, invoiceId);
    return { invoice: dto, replayedByCycleIdentity: false };
  }

  public async issueBillingCycleInvoice(
    req: RequestWithCorrelationId,
    principal: AuthenticatedStaffPrincipal,
    rawBody: unknown,
    options?: { readonly testFaultAfterStep?: FaultInjectionStep },
  ): Promise<InvoiceResponseDto> {
    const idempotencyKey = requireIdempotencyKeyHeader(req);
    const obj = assertPlainObject(rawBody, [
      'enrollment_id',
      'cycle_type',
      'cycle_key',
      'period_start_date',
      'period_end_date',
      'apply_available_credit_notes',
    ]);

    const enrollmentId = assertValidUuid(obj.enrollment_id, 'enrollment_id');
    const cycleTypeRaw =
      typeof obj.cycle_type === 'string' ? obj.cycle_type.trim().toUpperCase() : '';
    if (!ALLOWED_CYCLE_TYPES.has(cycleTypeRaw as BillingCycleType)) {
      throw new ApiHttpException({
        statusCode: 400,
        errorCode: 'VALIDATION_ERROR',
        message: 'cycle_type must be CALENDAR_MONTH, ROLLING_MONTH, or LESSON_PACKAGE_12',
      });
    }
    const cycleType = cycleTypeRaw as BillingCycleType;

    const cycleKey = typeof obj.cycle_key === 'string' ? obj.cycle_key.trim() : '';
    if (cycleKey.length < 3 || cycleKey.length > 64) {
      throw new ApiHttpException({
        statusCode: 400,
        errorCode: 'VALIDATION_ERROR',
        message: 'cycle_key must be between 3 and 64 characters',
      });
    }

    const periodStartDate = validateIsoDate(obj.period_start_date, 'period_start_date');
    const periodEndDate =
      obj.period_end_date !== undefined && obj.period_end_date !== null
        ? validateIsoDate(obj.period_end_date, 'period_end_date')
        : null;
    if (periodEndDate !== null && periodEndDate < periodStartDate) {
      throw new ApiHttpException({
        statusCode: 422,
        errorCode: 'VALIDATION_ERROR',
        message: 'period_end_date cannot be earlier than period_start_date',
      });
    }

    const applyAvailableCreditNotes = parseOptionalStrictBoolean(
      obj.apply_available_credit_notes,
      'apply_available_credit_notes',
      true,
    );

    const requestId = req.requestId ?? resolveRequestId(req.headers['x-request-id']);
    const now = this.clock.now();

    const idemOutcome = await executeIdempotentOperation<InvoiceResponseDto>(
      this.databaseService,
      {
        centerId: principal.centerId,
        actorStaffId: principal.staffId,
        operationType: 'ISSUE_BILLING_CYCLE_INVOICE',
        idempotencyKey,
        requestPayload: {
          enrollment_id: enrollmentId,
          cycle_type: cycleType,
          cycle_key: cycleKey,
          period_start_date: periodStartDate,
          period_end_date: periodEndDate,
          apply_available_credit_notes: applyAvailableCreditNotes,
        },
        authorizeBeforeReplayOrExecute: async (tx) => {
          // I03 semantics: verify live enrollment center scope and staff/license status before returning cached replay
          const enrCheck = await tx.query<{ id: string }>(
            `SELECT "id"::text AS id
               FROM "enrollments"
              WHERE "id" = $1::uuid
                AND "center_id" = $2::uuid
              FOR UPDATE`,
            [enrollmentId, principal.centerId],
          );
          if (!enrCheck.rows[0]) {
            throw new ApiHttpException({
              statusCode: 404,
              errorCode: 'NOT_FOUND',
              message: 'Enrollment not found in center scope',
            });
          }
        },
        handler: async (tx) => {
          const { invoice } = await this.issueCycleInvoiceWithinTransaction(tx, {
            centerId: principal.centerId,
            enrollmentId,
            cycleType,
            cycleKey,
            periodStartDate,
            periodEndDate,
            applyAvailableCreditNotes,
            actorType: 'STAFF',
            actorStaffId: principal.staffId,
            actorRole: principal.role,
            systemJobName: null,
            requestId,
            now,
            testFaultAfterStep: options?.testFaultAfterStep,
          });
          return {
            statusCode: 200,
            body: invoice,
          };
        },
      },
    );

    return idemOutcome.body;
  }

  public async getInvoiceDetails(
    principal: AuthenticatedStaffPrincipal,
    rawInvoiceId: unknown,
  ): Promise<InvoiceResponseDto> {
    const invoiceId = assertValidUuid(rawInvoiceId, 'invoice_id');
    return this.loadInvoiceResponseInTx(this.databaseService, principal.centerId, invoiceId);
  }

  public async listStudentInvoices(
    principal: AuthenticatedStaffPrincipal,
    rawStudentId: unknown,
    rawLimit?: unknown,
  ): Promise<InvoiceListResponseDto> {
    const studentId = assertValidUuid(rawStudentId, 'student_id');
    const limitNum = rawLimit === undefined ? 50 : Number(rawLimit);
    const limit = Number.isInteger(limitNum) && limitNum >= 1 && limitNum <= 100 ? limitNum : 50;

    const stuCheck = await this.databaseService.query<{ id: string }>(
      `SELECT "id"::text AS id
         FROM "students"
        WHERE "id" = $1::uuid
          AND "center_id" = $2::uuid
        LIMIT 1`,
      [studentId, principal.centerId],
    );
    if (!stuCheck.rows[0]) {
      throw new ApiHttpException({
        statusCode: 404,
        errorCode: 'NOT_FOUND',
        message: 'Student not found in center scope',
      });
    }

    const invIdsRes = await this.databaseService.query<{ id: string }>(
      `SELECT "id"::text AS id
         FROM "invoices"
        WHERE "center_id" = $1::uuid
          AND "student_id" = $2::uuid
        ORDER BY "issued_at" DESC, "id" DESC
        LIMIT $3::int`,
      [principal.centerId, studentId, limit],
    );

    const items: InvoiceResponseDto[] = [];
    for (const row of invIdsRes.rows) {
      items.push(await this.loadInvoiceResponseInTx(this.databaseService, principal.centerId, row.id));
    }

    return Object.freeze({
      items: Object.freeze(items),
      next_cursor: null,
    });
  }

  public async issueWorkerInvoiceForCycle(params: {
    readonly centerId: string;
    readonly enrollmentId: string;
    readonly cycleType: BillingCycleType;
    readonly cycleKey: string;
    readonly periodStartDate: string;
    readonly periodEndDate?: string | null;
    readonly systemJobName: string;
    readonly testFaultAfterStep?: FaultInjectionStep;
  }): Promise<{ readonly invoice: InvoiceResponseDto; readonly replayedByCycleIdentity: boolean }> {
    const { result } = await runInTransaction(this.databaseService, async (tx) => {
      return this.issueCycleInvoiceWithinTransaction(tx, {
        centerId: params.centerId,
        enrollmentId: params.enrollmentId,
        cycleType: params.cycleType,
        cycleKey: params.cycleKey,
        periodStartDate: params.periodStartDate,
        periodEndDate: params.periodEndDate,
        applyAvailableCreditNotes: true,
        actorType: 'SYSTEM_WORKER',
        actorStaffId: null,
        actorRole: null,
        systemJobName: params.systemJobName,
        requestId: `worker-${crypto.randomUUID()}`,
        now: this.clock.now(),
        testFaultAfterStep: params.testFaultAfterStep,
      });
    });
    return result;
  }
}
