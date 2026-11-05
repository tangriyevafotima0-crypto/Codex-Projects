/**
 * EduERP v2.0 — Stage 09, Step 09.03 (`T09.03`, `C03`, `OWNER-20261105-04`):
 * Freeze Interval Union, Overlap Deduplication (`UNIQUE (enrollment_id, lesson_id)`),
 * Cancelled/Rescheduled/Attended Lesson Exclusion, Net-Earned Proportional `HALF_UP` Credit Calculation,
 * 100% Grant Zero-Credit Boundary, and Atomic `FreezeRecord` + `FreezeLessonLink` + `CreditNote` + `LedgerEntry` + `OutboxEvent`.
 */

import { Inject, Injectable } from '@nestjs/common';
import type {
  BillingCycleType,
  BillingMode,
  FreezeCreditBasis,
  FreezeReasonType,
} from '@eduerp/contracts';
import * as crypto from 'node:crypto';
import { ApiHttpException } from '../auth/auth.errors';
import { ClockService } from '../auth/clock.service';
import { AuthenticatedStaffPrincipal } from '../auth/permissions.guard';
import {
  assertPlainObject,
  assertValidUuid,
  requireIdempotencyKeyHeader,
  resolveExpectedVersion,
} from '../auth/validation';
import { RequestWithCorrelationId, resolveRequestId } from '../common/request-id.middleware';
import { ApiEnvConfig } from '../config/env';
import { API_CONFIG_TOKEN } from '../config/tokens';
import { DatabaseService } from '../database/database.service';
import { executeIdempotentOperation } from '../database/idempotency';
import {
  divideAndRoundHalfUpUzs,
  formatMoneyUzs,
  parseNonNegativeMoneyUzs,
} from '../database/money';
import { executeOptimisticUpdate, TransactionContext } from '../database/transaction';
import { parseOptionalStrictBoolean, validateIsoDate } from '../students/normalization';
import {
  ADJUSTMENTS_CALCULATION_VERSION,
  BillingPolicyService,
  CONFIRMED_FREEZE_CREDIT_BASES,
} from '../billing/policy';

export type FreezeFaultInjectionStep =
  | 'FREEZE_RECORD'
  | 'FREEZE_LESSON_LINKS'
  | 'CREDIT_NOTE'
  | 'LEDGER_ENTRY'
  | 'INVOICE_UPDATE'
  | 'ENROLLMENT_UPDATE'
  | 'AUDIT_LOG'
  | 'OUTBOX_EVENT';

export const ALLOWED_FREEZE_REASON_TYPES: ReadonlySet<FreezeReasonType> = new Set([
  'MEDICAL_CERTIFICATE',
  'PRIOR_NOTICE',
]);

export interface FreezeCandidateLesson {
  readonly id: string;
  readonly lesson_date: string;
  readonly occurrence_seq: number;
  readonly status: string;
}

export interface FreezeLessonSelectionResult {
  readonly distinctNewFrozenLessonIds: readonly string[];
  readonly skippedAlreadyFrozenCount: number;
  readonly skippedCancelledOrRescheduledCount: number;
  readonly skippedAttendedCount: number;
}

export interface FreezeCreditCalculationResult {
  readonly basisNetChargeUzs: bigint;
  readonly remainingCreditCapUzs: bigint;
  readonly distinctFrozenLessons: number;
  readonly calculatedCreditUzs: bigint;
  readonly perLessonCreditedAmountsUzs: readonly bigint[];
  readonly freezeCreditBasis: FreezeCreditBasis;
  readonly calculationVersion: string;
  readonly formulaSnapshot: string;
}

export interface FreezeResponseDto {
  readonly freeze_record_id: string;
  readonly enrollment_id: string;
  readonly source_invoice_id: string;
  readonly freeze_start_date: string;
  readonly freeze_end_date: string;
  readonly reason_type: FreezeReasonType;
  readonly reason_details: string;
  readonly distinct_frozen_lessons: number;
  readonly frozen_lesson_ids: readonly string[];
  readonly basis_net_charge_uzs: string;
  readonly calculated_credit_uzs: string;
  readonly credit_note_id: string | null;
  readonly policy_version_id: string;
  readonly freeze_credit_basis_snapshot: string;
  readonly calculation_version: string;
  readonly enrollment_version: number;
  readonly created_at_utc: string;
}

function formatPgDate(val: unknown): string {
  if (val instanceof Date) return val.toISOString().slice(0, 10);
  return String(val).slice(0, 10);
}

/**
 * Pure helper selecting distinct eligible lessons in `[freezeStartDate, freezeEndDate]` (`09.03`):
 * - Excludes lessons already frozen for this enrollment (`alreadyFrozenLessonIds`).
 * - Excludes `CANCELLED_BY_CENTER` and `RESCHEDULED` lessons (`T09.03`).
 * - Excludes lessons where the student has `PRESENT` or `LATE` attendance (`attendedPresentOrLateLessonIds`).
 * - When `packageAllocatedLessonIds` is provided (`LESSON_PACKAGE_12` — `L02`), restricts strictly to lessons
 *   durably owned by the source package cycle.
 */
export function selectDistinctEligibleFreezeLessons(params: {
  readonly freezeStartDate: string;
  readonly freezeEndDate: string;
  readonly candidateLessons: readonly FreezeCandidateLesson[];
  readonly alreadyFrozenLessonIds?: readonly string[];
  readonly attendedPresentOrLateLessonIds?: readonly string[];
  readonly packageAllocatedLessonIds?: readonly string[] | null;
}): FreezeLessonSelectionResult {
  const start = validateIsoDate(params.freezeStartDate, 'freeze_start_date');
  const end = validateIsoDate(params.freezeEndDate, 'freeze_end_date');
  if (end < start) {
    throw new ApiHttpException({
      statusCode: 422,
      errorCode: 'VALIDATION_ERROR',
      message: `freeze_end_date (${end}) cannot be earlier than freeze_start_date (${start})`,
    });
  }

  const alreadyFrozenSet = new Set(params.alreadyFrozenLessonIds ?? []);
  const attendedSet = new Set(params.attendedPresentOrLateLessonIds ?? []);
  const packageSet =
    params.packageAllocatedLessonIds !== undefined &&
    params.packageAllocatedLessonIds !== null
      ? new Set(params.packageAllocatedLessonIds)
      : null;

  const sorted = [...params.candidateLessons].sort((a, b) => {
    if (a.lesson_date !== b.lesson_date) {
      return a.lesson_date < b.lesson_date ? -1 : 1;
    }
    if (a.occurrence_seq !== b.occurrence_seq) {
      return a.occurrence_seq - b.occurrence_seq;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const seenIds = new Set<string>();
  const distinctNewIds: string[] = [];
  let skippedAlreadyFrozenCount = 0;
  let skippedCancelledOrRescheduledCount = 0;
  let skippedAttendedCount = 0;

  for (const lesson of sorted) {
    if (seenIds.has(lesson.id)) continue;
    seenIds.add(lesson.id);

    if (lesson.lesson_date < start || lesson.lesson_date > end) {
      continue;
    }
    if (packageSet !== null && !packageSet.has(lesson.id)) {
      continue;
    }
    if (lesson.status === 'CANCELLED_BY_CENTER' || lesson.status === 'RESCHEDULED') {
      skippedCancelledOrRescheduledCount += 1;
      continue;
    }
    if (lesson.status !== 'SCHEDULED' && lesson.status !== 'COMPLETED') {
      continue;
    }
    if (attendedSet.has(lesson.id)) {
      skippedAttendedCount += 1;
      continue;
    }
    if (alreadyFrozenSet.has(lesson.id)) {
      skippedAlreadyFrozenCount += 1;
      continue;
    }
    distinctNewIds.push(lesson.id);
  }

  return Object.freeze({
    distinctNewFrozenLessonIds: Object.freeze(distinctNewIds),
    skippedAlreadyFrozenCount,
    skippedCancelledOrRescheduledCount,
    skippedAttendedCount,
  });
}

/**
 * Pure calculator for Stage 09 (`09.03`, `C03`, `OWNER-20261105-04`) freeze credit:
 * - Requires an explicitly confirmed `freezeCreditBasis` (`NET_PROPORTIONAL_LESSON` or `DISABLED` variant).
 * - Calculates credit from the source invoice's post-discount net charge (`basisNetChargeUzs`) proportional
 *   to `distinctFrozenLessons / billedLessons` using integer `HALF_UP`, strictly capped at
 *   `remainingCreditCapUzs = basisNetChargeUzs - alreadyCreditedUzs`.
 * - For a 100% Grant invoice (`basisNetChargeUzs === 0n`), overlapping repeat with `0` new lessons,
 *   or `DISABLED` mode, `calculatedCreditUzs === 0n` (never creates a negative balance or cash refund).
 */
export function calculateFreezeProportionalCreditUzs(params: {
  readonly freezeCreditBasis: string;
  readonly baseProRataChargeUzs: bigint | string | number;
  readonly approvedDiscountUzs: bigint | string | number;
  readonly effectiveNetChargeUzs: bigint | string | number;
  readonly billedLessons: number;
  readonly alreadyFrozenLessonsCount?: number;
  readonly alreadyCreditedUzs?: bigint | string | number;
  readonly newDistinctFrozenLessonIds: readonly string[];
}): FreezeCreditCalculationResult {
  const rawBasis = params.freezeCreditBasis.trim().toUpperCase() as FreezeCreditBasis;
  if (!CONFIRMED_FREEZE_CREDIT_BASES.has(rawBasis)) {
    throw new ApiHttpException({
      statusCode: 403,
      errorCode: 'POLICY_DECISION_NOT_CONFIRMED',
      message: `Freeze credit basis '${params.freezeCreditBasis}' is not confirmed under OWNER-20261105-04`,
    });
  }

  const baseCharge = parseNonNegativeMoneyUzs(
    params.baseProRataChargeUzs,
    'baseProRataChargeUzs',
  );
  const approvedDiscount = parseNonNegativeMoneyUzs(
    params.approvedDiscountUzs,
    'approvedDiscountUzs',
  );
  const effectiveNet = parseNonNegativeMoneyUzs(
    params.effectiveNetChargeUzs,
    'effectiveNetChargeUzs',
  );
  const alreadyCredited = parseNonNegativeMoneyUzs(
    params.alreadyCreditedUzs ?? 0n,
    'alreadyCreditedUzs',
  );

  if (!Number.isInteger(params.billedLessons) || params.billedLessons < 0) {
    throw new ApiHttpException({
      statusCode: 422,
      errorCode: 'VALIDATION_ERROR',
      message: 'Invoice billed_lessons must be a non-negative integer',
    });
  }

  const alreadyFrozenCount = params.alreadyFrozenLessonsCount ?? 0;
  const distinctFrozenLessons = params.newDistinctFrozenLessonIds.length;

  if (alreadyFrozenCount + distinctFrozenLessons > params.billedLessons) {
    throw new ApiHttpException({
      statusCode: 422,
      errorCode: 'FREEZE_CREDIT_CAP_EXCEEDED',
      message: `Total frozen lessons (${alreadyFrozenCount + distinctFrozenLessons}) cannot exceed source invoice billed_lessons (${params.billedLessons})`,
    });
  }

  const postDiscountBasis =
    baseCharge > approvedDiscount ? baseCharge - approvedDiscount : 0n;
  const basisNetChargeUzs =
    postDiscountBasis <= effectiveNet ? postDiscountBasis : effectiveNet;
  const remainingCreditCapUzs =
    basisNetChargeUzs > alreadyCredited ? basisNetChargeUzs - alreadyCredited : 0n;

  const isDisabledMode = rawBasis === 'DISABLED' || rawBasis === 'NO_FREEZE_CREDIT';
  let calculatedCreditUzs = 0n;

  if (
    !isDisabledMode &&
    distinctFrozenLessons > 0 &&
    basisNetChargeUzs > 0n &&
    params.billedLessons > 0
  ) {
    const rawProportional = divideAndRoundHalfUpUzs(
      basisNetChargeUzs * BigInt(distinctFrozenLessons),
      BigInt(params.billedLessons),
    );
    calculatedCreditUzs =
      rawProportional <= remainingCreditCapUzs ? rawProportional : remainingCreditCapUzs;
  }

  const perLessonAmounts: bigint[] = [];
  if (distinctFrozenLessons > 0) {
    const basePerLesson = calculatedCreditUzs / BigInt(distinctFrozenLessons);
    let remainder = calculatedCreditUzs % BigInt(distinctFrozenLessons);
    for (let i = 0; i < distinctFrozenLessons; i += 1) {
      if (remainder > 0n) {
        perLessonAmounts.push(basePerLesson + 1n);
        remainder -= 1n;
      } else {
        perLessonAmounts.push(basePerLesson);
      }
    }
  }

  const formulaSnapshot = `FREEZE_CREDIT(${rawBasis}): basis_net=${formatMoneyUzs(basisNetChargeUzs)}, frozen_lessons=${distinctFrozenLessons}/${params.billedLessons}, already_credited=${formatMoneyUzs(alreadyCredited)}, credit=${formatMoneyUzs(calculatedCreditUzs)} (${ADJUSTMENTS_CALCULATION_VERSION})`;

  return Object.freeze({
    basisNetChargeUzs,
    remainingCreditCapUzs,
    distinctFrozenLessons,
    calculatedCreditUzs,
    perLessonCreditedAmountsUzs: Object.freeze(perLessonAmounts),
    freezeCreditBasis: rawBasis,
    calculationVersion: ADJUSTMENTS_CALCULATION_VERSION,
    formulaSnapshot,
  });
}

@Injectable()
export class FreezeCreditService {
  constructor(
    @Inject(API_CONFIG_TOKEN) private readonly config: ApiEnvConfig,
    @Inject(DatabaseService) private readonly databaseService: DatabaseService,
    @Inject(ClockService) private readonly clock: ClockService,
    @Inject(BillingPolicyService) private readonly policyService: BillingPolicyService,
  ) {}

  private maybeInjectTestFault(
    targetStep: FreezeFaultInjectionStep,
    configuredFault?: FreezeFaultInjectionStep,
  ): void {
    if (this.config.nodeEnv === 'test' && configuredFault === targetStep) {
      throw new Error(`SIMULATED_S09_FREEZE_FAULT_AFTER_${targetStep}`);
    }
  }

  public async createFreezeAndIssueCreditNote(
    req: RequestWithCorrelationId,
    principal: AuthenticatedStaffPrincipal,
    rawBody: unknown,
    options?: { readonly testFaultAfterStep?: FreezeFaultInjectionStep },
  ): Promise<FreezeResponseDto> {
    const idempotencyKey = requireIdempotencyKeyHeader(req);
    const obj = assertPlainObject(rawBody, [
      'enrollment_id',
      'source_invoice_id',
      'freeze_start_date',
      'freeze_end_date',
      'reason_type',
      'reason_details',
      'expected_version',
      'request_cash_refund',
      'undo_prior_freeze_id',
    ]);

    const enrollmentId = assertValidUuid(obj.enrollment_id, 'enrollment_id');
    const sourceInvoiceId = assertValidUuid(obj.source_invoice_id, 'source_invoice_id');
    const freezeStartDate = validateIsoDate(obj.freeze_start_date, 'freeze_start_date');
    const freezeEndDate = validateIsoDate(obj.freeze_end_date, 'freeze_end_date');
    if (freezeEndDate < freezeStartDate) {
      throw new ApiHttpException({
        statusCode: 422,
        errorCode: 'VALIDATION_ERROR',
        message: `freeze_end_date (${freezeEndDate}) cannot be earlier than freeze_start_date (${freezeStartDate})`,
      });
    }

    const reasonTypeRaw =
      typeof obj.reason_type === 'string' ? obj.reason_type.trim().toUpperCase() : '';
    if (!ALLOWED_FREEZE_REASON_TYPES.has(reasonTypeRaw as FreezeReasonType)) {
      throw new ApiHttpException({
        statusCode: 400,
        errorCode: 'VALIDATION_ERROR',
        message: 'reason_type must be MEDICAL_CERTIFICATE or PRIOR_NOTICE',
      });
    }
    const reasonType = reasonTypeRaw as FreezeReasonType;

    if (typeof obj.reason_details !== 'string') {
      throw new ApiHttpException({
        statusCode: 400,
        errorCode: 'VALIDATION_ERROR',
        message: 'reason_details is required and must be a string',
      });
    }
    const reasonDetails = obj.reason_details.trim();
    if (reasonDetails.length < 3 || reasonDetails.length > 500) {
      throw new ApiHttpException({
        statusCode: 422,
        errorCode: 'VALIDATION_ERROR',
        message: 'reason_details must be between 3 and 500 characters',
      });
    }

    const expectedVersion = resolveExpectedVersion(req, obj.expected_version);

    // 09.03 Safety Gates: Cash refund on freeze or unconfirmed freeze undo/reversal is strictly gated
    if (parseOptionalStrictBoolean(obj.request_cash_refund, 'request_cash_refund', false)) {
      throw new ApiHttpException({
        statusCode: 403,
        errorCode: 'POLICY_DECISION_NOT_CONFIRMED',
        message:
          'Cash refund for frozen lessons is not confirmed under OWNER-20261105-04 (only next-period CreditNote or disabled credit is supported)',
      });
    }
    if (obj.undo_prior_freeze_id !== undefined && obj.undo_prior_freeze_id !== null) {
      throw new ApiHttpException({
        statusCode: 403,
        errorCode: 'POLICY_DECISION_NOT_CONFIRMED',
        message:
          'Freeze undo/correction formula is gated by unconfirmed policy decisions (09.03); historical freeze records and credit notes are immutable',
      });
    }

    const requestId = req.requestId ?? resolveRequestId(req.headers['x-request-id']);
    const now = this.clock.now();

    const outcome = await executeIdempotentOperation<FreezeResponseDto>(
      this.databaseService,
      {
        centerId: principal.centerId,
        actorStaffId: principal.staffId,
        operationType: 'CREATE_FREEZE_AND_ISSUE_CREDIT_NOTE',
        idempotencyKey,
        requestPayload: {
          enrollment_id: enrollmentId,
          source_invoice_id: sourceInvoiceId,
          freeze_start_date: freezeStartDate,
          freeze_end_date: freezeEndDate,
          reason_type: reasonType,
          reason_details: reasonDetails,
          expected_version: expectedVersion,
        },
        authorizeBeforeReplayOrExecute: async (tx) => {
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
          // 1. Lock enrollment FOR UPDATE
          const enrRes = await tx.query<{
            id: string;
            student_id: string;
            group_id: string;
            status: string;
            enrolled_at_date: unknown;
            first_trial_date: unknown;
            version: number;
          }>(
            `SELECT "id"::text AS id,
                    "student_id"::text AS student_id,
                    "group_id"::text AS group_id,
                    "status"::text AS status,
                    "enrolled_at_date"::text AS enrolled_at_date,
                    "first_trial_date"::text AS first_trial_date,
                    "version"
               FROM "enrollments"
              WHERE "id" = $1::uuid
                AND "center_id" = $2::uuid
              FOR UPDATE`,
            [enrollmentId, principal.centerId],
          );

          const enrollment = enrRes.rows[0];
          if (!enrollment) {
            throw new ApiHttpException({
              statusCode: 404,
              errorCode: 'NOT_FOUND',
              message: 'Enrollment not found in center scope',
            });
          }
          if (enrollment.status === 'LEFT' || enrollment.status === 'TRIAL') {
            throw new ApiHttpException({
              statusCode: 422,
              errorCode: 'VALIDATION_ERROR',
              message: `Cannot create freeze credit for enrollment in '${enrollment.status}' status`,
            });
          }
          if (Number(enrollment.version) !== expectedVersion) {
            throw new ApiHttpException({
              statusCode: 409,
              errorCode: 'VERSION_CONFLICT',
              message: `Enrollment expected_version (${expectedVersion}) does not match current version (${enrollment.version})`,
            });
          }

          // 2. Lock source invoice and load cycle metadata
          const invRes = await tx.query<{
            id: string;
            student_id: string;
            enrollment_id: string;
            billing_cycle_id: string;
            base_pro_rata_charge_uzs: string;
            approved_discount_uzs: string;
            effective_net_charge_uzs: string;
            billed_lessons: number;
            frozen_credited_lessons: number;
            status: string;
            version: number;
            cycle_type: BillingCycleType;
            period_start_date: unknown;
            period_end_date: unknown;
            allocated_lesson_ids_json: unknown;
          }>(
            `SELECT i."id"::text AS id,
                    i."student_id"::text AS student_id,
                    i."enrollment_id"::text AS enrollment_id,
                    i."billing_cycle_id"::text AS billing_cycle_id,
                    i."base_pro_rata_charge_uzs"::text AS base_pro_rata_charge_uzs,
                    i."approved_discount_uzs"::text AS approved_discount_uzs,
                    i."effective_net_charge_uzs"::text AS effective_net_charge_uzs,
                    i."billed_lessons",
                    i."frozen_credited_lessons",
                    i."status"::text AS status,
                    i."version",
                    bc."cycle_type"::text AS cycle_type,
                    bc."period_start_date"::text AS period_start_date,
                    bc."period_end_date"::text AS period_end_date,
                    bc."allocated_lesson_ids_json"
               FROM "invoices" i
               JOIN "billing_cycles" bc
                 ON bc."id" = i."billing_cycle_id"
                AND bc."center_id" = i."center_id"
              WHERE i."id" = $1::uuid
                AND i."center_id" = $2::uuid
              FOR UPDATE OF i`,
            [sourceInvoiceId, principal.centerId],
          );

          const sourceInvoice = invRes.rows[0];
          if (!sourceInvoice) {
            throw new ApiHttpException({
              statusCode: 404,
              errorCode: 'NOT_FOUND',
              message: 'Source invoice not found in center scope',
            });
          }
          if (
            sourceInvoice.enrollment_id !== enrollment.id ||
            sourceInvoice.student_id !== enrollment.student_id
          ) {
            throw new ApiHttpException({
              statusCode: 422,
              errorCode: 'VALIDATION_ERROR',
              message: 'source_invoice_id does not belong to the specified enrollment_id',
            });
          }
          if (sourceInvoice.status === 'VOID_COMPENSATED') {
            throw new ApiHttpException({
              statusCode: 422,
              errorCode: 'VALIDATION_ERROR',
              message: 'Cannot issue freeze credit from a VOID_COMPENSATED invoice',
            });
          }

          const cycleStart = formatPgDate(sourceInvoice.period_start_date);
          const cycleEnd = sourceInvoice.period_end_date
            ? formatPgDate(sourceInvoice.period_end_date)
            : null;
          const serviceBeginDate =
            (enrollment.first_trial_date ? formatPgDate(enrollment.first_trial_date) : null) ??
            formatPgDate(enrollment.enrolled_at_date);

          if (freezeStartDate < cycleStart || freezeStartDate < serviceBeginDate) {
            throw new ApiHttpException({
              statusCode: 422,
              errorCode: 'VALIDATION_ERROR',
              message: `freeze_start_date (${freezeStartDate}) cannot precede invoice period_start_date (${cycleStart}) or enrollment service begin date (${serviceBeginDate})`,
            });
          }
          if (cycleEnd !== null && freezeEndDate > cycleEnd) {
            throw new ApiHttpException({
              statusCode: 422,
              errorCode: 'VALIDATION_ERROR',
              message: `freeze_end_date (${freezeEndDate}) cannot exceed source invoice period_end_date (${cycleEnd})`,
            });
          }

          // 3. Load group and resolve confirmed S09 freeze credit policy (OWNER-20261105-04)
          const grpRes = await tx.query<{
            id: string;
            billing_mode: BillingMode;
            billing_policy_version_id: string | null;
          }>(
            `SELECT "id"::text AS id,
                    "billing_mode"::text AS billing_mode,
                    "billing_policy_version_id"::text AS billing_policy_version_id
               FROM "course_groups"
              WHERE "id" = $1::uuid
                AND "center_id" = $2::uuid
              LIMIT 1`,
            [enrollment.group_id, principal.centerId],
          );
          const group = grpRes.rows[0];
          if (!group) {
            throw new ApiHttpException({
              statusCode: 404,
              errorCode: 'NOT_FOUND',
              message: 'Course group not found in center scope',
            });
          }

          const policy = await this.policyService.resolveActiveFreezePolicyForGroupPeriod(
            tx,
            principal.centerId,
            group.billing_mode,
            group.billing_policy_version_id,
            cycleStart,
          );

          // 4. Load candidate lessons in [freezeStartDate, freezeEndDate]
          const lessonsRes = await tx.query<{
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
                AND "lesson_date" <= $4::date
              ORDER BY "lesson_date" ASC, "occurrence_seq" ASC, "id" ASC`,
            [principal.centerId, group.id, freezeStartDate, freezeEndDate],
          );

          // Load package allocated lesson IDs if LESSON_PACKAGE_12
          let packageAllocatedLessonIds: string[] | null = null;
          if (sourceInvoice.cycle_type === 'LESSON_PACKAGE_12') {
            const bclaRes = await tx.query<{ lesson_id: string }>(
              `SELECT "lesson_id"::text AS lesson_id
                 FROM "billing_cycle_lesson_allocations"
                WHERE "center_id" = $1::uuid
                  AND "billing_cycle_id" = $2::uuid
                ORDER BY "slot_index" ASC`,
              [principal.centerId, sourceInvoice.billing_cycle_id],
            );
            if (bclaRes.rows.length > 0) {
              packageAllocatedLessonIds = bclaRes.rows.map((r) => r.lesson_id);
            } else if (Array.isArray(sourceInvoice.allocated_lesson_ids_json)) {
              packageAllocatedLessonIds = sourceInvoice.allocated_lesson_ids_json as string[];
            }
          }

          // Load already-frozen lesson links for this enrollment (locked FOR UPDATE to serialize overlapping freeze requests)
          const existingLinksRes = await tx.query<{ lesson_id: string }>(
            `SELECT "lesson_id"::text AS lesson_id
               FROM "freeze_lesson_links"
              WHERE "center_id" = $1::uuid
                AND "enrollment_id" = $2::uuid
              FOR UPDATE`,
            [principal.centerId, enrollment.id],
          );

          // Load PRESENT/LATE attended lessons in the freeze window
          const attendedRes = await tx.query<{ lesson_id: string }>(
            `SELECT DISTINCT "lesson_id"::text AS lesson_id
               FROM "attendance_records"
              WHERE "center_id" = $1::uuid
                AND "enrollment_id" = $2::uuid
                AND "status" IN ('PRESENT', 'LATE')`,
            [principal.centerId, enrollment.id],
          );

          const selection = selectDistinctEligibleFreezeLessons({
            freezeStartDate,
            freezeEndDate,
            candidateLessons: lessonsRes.rows.map((r) => ({
              id: r.id,
              lesson_date: formatPgDate(r.lesson_date),
              occurrence_seq: Number(r.occurrence_seq),
              status: r.status,
            })),
            alreadyFrozenLessonIds: existingLinksRes.rows.map((r) => r.lesson_id),
            attendedPresentOrLateLessonIds: attendedRes.rows.map((r) => r.lesson_id),
            packageAllocatedLessonIds,
          });

          // Load already-credited freeze totals on this source invoice
          const priorFreezesRes = await tx.query<{
            total_lessons: number;
            total_credited_uzs: string;
          }>(
            `SELECT COALESCE(SUM("distinct_frozen_lessons"), 0)::int AS total_lessons,
                    COALESCE(SUM("calculated_credit_uzs"), 0)::text AS total_credited_uzs
               FROM "freeze_records"
              WHERE "center_id" = $1::uuid
                AND "source_invoice_id" = $2::uuid`,
            [principal.centerId, sourceInvoice.id],
          );

          const alreadyFrozenOnInvoice = Number(priorFreezesRes.rows[0]?.total_lessons ?? 0);
          const alreadyCreditedOnInvoiceUzs = BigInt(
            priorFreezesRes.rows[0]?.total_credited_uzs ?? '0',
          );

          const creditCalc = calculateFreezeProportionalCreditUzs({
            freezeCreditBasis: policy.freeze_credit_basis,
            baseProRataChargeUzs: BigInt(sourceInvoice.base_pro_rata_charge_uzs),
            approvedDiscountUzs: BigInt(sourceInvoice.approved_discount_uzs),
            effectiveNetChargeUzs: BigInt(sourceInvoice.effective_net_charge_uzs),
            billedLessons: Number(sourceInvoice.billed_lessons),
            alreadyFrozenLessonsCount: alreadyFrozenOnInvoice,
            alreadyCreditedUzs: alreadyCreditedOnInvoiceUzs,
            newDistinctFrozenLessonIds: selection.distinctNewFrozenLessonIds,
          });

          // 5. Insert FreezeRecord
          const freezeRecordId = crypto.randomUUID();
          await tx.query(
            `INSERT INTO "freeze_records" (
               "id", "center_id", "enrollment_id", "source_invoice_id",
               "freeze_start_date", "freeze_end_date",
               "reason_type", "reason_details",
               "distinct_frozen_lessons", "basis_net_charge_uzs", "calculated_credit_uzs",
               "policy_version_id", "freeze_credit_basis_snapshot", "calculation_version",
               "created_by_admin_id", "created_at"
             ) VALUES (
               $1::uuid, $2::uuid, $3::uuid, $4::uuid,
               $5::date, $6::date,
               $7, $8,
               $9::int, $10::bigint, $11::bigint,
               $12::uuid, $13, $14,
               $15::uuid, $16::timestamptz
             )`,
            [
              freezeRecordId,
              principal.centerId,
              enrollment.id,
              sourceInvoice.id,
              freezeStartDate,
              freezeEndDate,
              reasonType,
              reasonDetails,
              creditCalc.distinctFrozenLessons,
              formatMoneyUzs(creditCalc.basisNetChargeUzs),
              formatMoneyUzs(creditCalc.calculatedCreditUzs),
              policy.id,
              creditCalc.freezeCreditBasis,
              creditCalc.calculationVersion,
              principal.staffId,
              now.toISOString(),
            ],
          );
          this.maybeInjectTestFault('FREEZE_RECORD', options?.testFaultAfterStep);

          // 6. Insert FreezeLessonLinks (UNIQUE (enrollment_id, lesson_id))
          for (let i = 0; i < selection.distinctNewFrozenLessonIds.length; i += 1) {
            const lessonId = selection.distinctNewFrozenLessonIds[i];
            const linkCreditUzs = creditCalc.perLessonCreditedAmountsUzs[i] ?? 0n;
            await tx.query(
              `INSERT INTO "freeze_lesson_links" (
                 "id", "center_id", "enrollment_id", "lesson_id",
                 "freeze_record_id", "credited_amount_uzs", "created_at"
               ) VALUES (
                 $1::uuid, $2::uuid, $3::uuid, $4::uuid,
                 $5::uuid, $6::bigint, $7::timestamptz
               )`,
              [
                crypto.randomUUID(),
                principal.centerId,
                enrollment.id,
                lessonId,
                freezeRecordId,
                formatMoneyUzs(linkCreditUzs),
                now.toISOString(),
              ],
            );

            // Mark any existing ABSENT attendance row for this lesson as excused/frozen
            await tx.query(
              `UPDATE "attendance_records"
                  SET "is_excused_frozen" = TRUE,
                      "version" = "version" + 1,
                      "updated_at" = $1::timestamptz
                WHERE "center_id" = $2::uuid
                  AND "enrollment_id" = $3::uuid
                  AND "lesson_id" = $4::uuid
                  AND "status" = 'ABSENT'`,
              [now.toISOString(), principal.centerId, enrollment.id, lessonId],
            );
          }
          this.maybeInjectTestFault('FREEZE_LESSON_LINKS', options?.testFaultAfterStep);

          // 7. Create CreditNote + LedgerEntry ONLY when calculatedCreditUzs > 0n (grant=0 or 100% overlap or DISABLED mode creates 0 credit note & 0 refund!)
          let creditNoteId: string | null = null;
          if (creditCalc.calculatedCreditUzs > 0n) {
            creditNoteId = crypto.randomUUID();
            await tx.query(
              `INSERT INTO "credit_notes" (
                 "id", "center_id", "student_id", "enrollment_id", "source_invoice_id",
                 "credit_reason", "amount_uzs", "source_event_key",
                 "actor_type", "actor_staff_id", "system_job_name", "created_at"
               ) VALUES (
                 $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
                 'FREEZE_NEXT_PERIOD_CREDIT', $6::bigint, $7,
                 'STAFF', $8::uuid, NULL, $9::timestamptz
               )`,
              [
                creditNoteId,
                principal.centerId,
                enrollment.student_id,
                enrollment.id,
                sourceInvoice.id,
                formatMoneyUzs(creditCalc.calculatedCreditUzs),
                `freeze:${freezeRecordId}`,
                principal.staffId,
                now.toISOString(),
              ],
            );
            this.maybeInjectTestFault('CREDIT_NOTE', options?.testFaultAfterStep);

            await tx.query(
              `INSERT INTO "ledger_entries" (
                 "id", "center_id", "entry_type", "student_id", "invoice_id",
                 "credit_note_id", "direction", "amount_uzs",
                 "actor_type", "actor_staff_id", "system_job_name", "created_at"
               ) VALUES (
                 $1::uuid, $2::uuid, 'CREDIT_NOTE_ISSUED', $3::uuid, $4::uuid,
                 $5::uuid, 'CREDIT', $6::bigint,
                 'STAFF', $7::uuid, NULL, $8::timestamptz
               )`,
              [
                crypto.randomUUID(),
                principal.centerId,
                enrollment.student_id,
                sourceInvoice.id,
                creditNoteId,
                formatMoneyUzs(creditCalc.calculatedCreditUzs),
                principal.staffId,
                now.toISOString(),
              ],
            );
            this.maybeInjectTestFault('LEDGER_ENTRY', options?.testFaultAfterStep);
          }

          // 8. Update sourceInvoice.frozen_credited_lessons and enrollment.version
          const newFrozenCreditedTotal =
            Number(sourceInvoice.frozen_credited_lessons) + creditCalc.distinctFrozenLessons;
          await executeOptimisticUpdate<{ version: number }>(tx, {
            tableName: 'invoices',
            entityName: 'Invoice',
            id: sourceInvoice.id,
            centerId: principal.centerId,
            expectedVersion: Number(sourceInvoice.version),
            setClauseSql: `"frozen_credited_lessons" = $4::int`,
            additionalValues: [newFrozenCreditedTotal],
            returningColumnsSql: '"version"',
          });
          this.maybeInjectTestFault('INVOICE_UPDATE', options?.testFaultAfterStep);

          const updatedEnrollment = await executeOptimisticUpdate<{ version: number }>(tx, {
            tableName: 'enrollments',
            entityName: 'Enrollment',
            id: enrollment.id,
            centerId: principal.centerId,
            expectedVersion,
            setClauseSql: `"status" = "status"`,
            additionalValues: [],
            returningColumnsSql: '"version"',
          });
          this.maybeInjectTestFault('ENROLLMENT_UPDATE', options?.testFaultAfterStep);

          // 9. Insert AuditLog
          await tx.query(
            `INSERT INTO "audit_logs" (
               "id", "center_id", "actor_type", "actor_id", "actor_role",
               "action", "entity_type", "entity_id", "severity",
               "after_redacted_json", "request_id", "created_at"
             ) VALUES (
               $1::uuid, $2::uuid, 'STAFF', $3::uuid, $4,
               'FREEZE_CREDIT_RECORDED', 'FreezeRecord', $5::uuid, 'INFO',
               $6::jsonb, $7, $8::timestamptz
             )`,
            [
              crypto.randomUUID(),
              principal.centerId,
              principal.staffId,
              principal.role,
              freezeRecordId,
              JSON.stringify({
                freeze_record_id: freezeRecordId,
                enrollment_id: enrollment.id,
                source_invoice_id: sourceInvoice.id,
                freeze_start_date: freezeStartDate,
                freeze_end_date: freezeEndDate,
                reason_type: reasonType,
                distinct_frozen_lessons: creditCalc.distinctFrozenLessons,
                frozen_lesson_ids: selection.distinctNewFrozenLessonIds,
                basis_net_charge_uzs: formatMoneyUzs(creditCalc.basisNetChargeUzs),
                calculated_credit_uzs: formatMoneyUzs(creditCalc.calculatedCreditUzs),
                credit_note_id: creditNoteId,
                policy_version_id: policy.id,
                freeze_credit_basis: creditCalc.freezeCreditBasis,
                formula_snapshot: creditCalc.formulaSnapshot,
              }),
              requestId,
              now.toISOString(),
            ],
          );
          this.maybeInjectTestFault('AUDIT_LOG', options?.testFaultAfterStep);

          // 10. Insert canonical FreezeCreditIssued v1 OutboxEvent (docs/architecture/events.md#evt-FreezeCreditIssued)
          await tx.query(
            `INSERT INTO "outbox_events" (
               "id", "center_id", "event_name", "schema_version",
               "aggregate_type", "aggregate_id", "aggregate_version",
               "dedup_key", "payload_json", "status",
               "next_attempt_at", "occurred_at_utc", "updated_at"
             ) VALUES (
               $1::uuid, $2::uuid, 'FreezeCreditIssued', 1,
               'FreezeRecord', $3::uuid, 1,
               $4, $5::jsonb, 'PENDING',
               $6::timestamptz, $6::timestamptz, $6::timestamptz
             )`,
            [
              crypto.randomUUID(),
              principal.centerId,
              freezeRecordId,
              `FreezeCreditIssued:${freezeRecordId}`,
              JSON.stringify({
                freeze_record_id: freezeRecordId,
                credit_note_id: creditNoteId,
                enrollment_id: enrollment.id,
                source_invoice_id: sourceInvoice.id,
                distinct_frozen_lessons: creditCalc.distinctFrozenLessons,
                basis_net_charge_uzs: formatMoneyUzs(creditCalc.basisNetChargeUzs),
                calculated_credit_uzs: formatMoneyUzs(creditCalc.calculatedCreditUzs),
              }),
              now.toISOString(),
            ],
          );
          this.maybeInjectTestFault('OUTBOX_EVENT', options?.testFaultAfterStep);

          const responseDto: FreezeResponseDto = Object.freeze({
            freeze_record_id: freezeRecordId,
            enrollment_id: enrollment.id,
            source_invoice_id: sourceInvoice.id,
            freeze_start_date: freezeStartDate,
            freeze_end_date: freezeEndDate,
            reason_type: reasonType,
            reason_details: reasonDetails,
            distinct_frozen_lessons: creditCalc.distinctFrozenLessons,
            frozen_lesson_ids: selection.distinctNewFrozenLessonIds,
            basis_net_charge_uzs: formatMoneyUzs(creditCalc.basisNetChargeUzs),
            calculated_credit_uzs: formatMoneyUzs(creditCalc.calculatedCreditUzs),
            credit_note_id: creditNoteId,
            policy_version_id: policy.id,
            freeze_credit_basis_snapshot: creditCalc.freezeCreditBasis,
            calculation_version: creditCalc.calculationVersion,
            enrollment_version: Number(updatedEnrollment.version),
            created_at_utc: now.toISOString(),
          });

          return {
            statusCode: 201,
            body: responseDto,
          };
        },
      },
    );

    return outcome.body;
  }
}
