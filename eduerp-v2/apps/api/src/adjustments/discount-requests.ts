/**
 * EduERP v2.0 — Stage 09, Step 09.01 (`T09.01`):
 * Discount & Grant Request Creation (`FAMILY_DISCOUNT`, `SPECIAL_50_PERCENT`, `CUSTOM_PERCENT`, `CUSTOM_FIXED`, `FULL_GRANT_100`),
 * Basis-Point Exact Percentage Validation, Fixed Discount Cap Guard, and Authenticated Guardian Family Offer Eligibility.
 */

import { Inject, Injectable } from '@nestjs/common';
import type { DiscountKind, DiscountRequestStatus } from '@eduerp/contracts';
import * as crypto from 'node:crypto';
import { ApiHttpException } from '../auth/auth.errors';
import { ClockService } from '../auth/clock.service';
import { AuthenticatedStaffPrincipal } from '../auth/permissions.guard';
import { formatCenterLocalDate } from '../auth/staff.service';
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
import { formatMoneyUzs, parsePositiveMoneyUzs } from '../database/money';
import { TransactionContext } from '../database/transaction';
import { validateIsoDate } from '../students/normalization';

export const ALLOWED_DISCOUNT_KINDS: ReadonlySet<DiscountKind> = new Set([
  'FAMILY_DISCOUNT',
  'SPECIAL_50_PERCENT',
  'CUSTOM_PERCENT',
  'CUSTOM_FIXED',
  'FULL_GRANT_100',
]);

export interface ParsedPercentBasisPoints {
  readonly basisPoints: number;
  readonly percentNumber: number;
  readonly percentSqlDecimal: string;
}

export interface ValidatedDiscountRequestInput {
  readonly enrollmentId: string;
  readonly targetInvoiceId: string | null;
  readonly discountKind: DiscountKind;
  readonly percentBasisPoints: number | null;
  readonly percentNumber: number | null;
  readonly percentSqlDecimal: string | null;
  readonly fixedAmountUzs: bigint | null;
  readonly reason: string;
  readonly validFrom: string;
  readonly validUntil: string;
}

export interface FamilyOfferEligibilityResult {
  readonly eligible: boolean;
  readonly activeGuardianSiblingCount: number;
  readonly activeEnrollmentCount: number;
  readonly qualifyingBasis: 'GUARDIAN_SIBLING_LINK' | 'MULTI_COURSE_ENROLLMENT' | 'NONE';
}

export interface DiscountRequestResponseDto {
  readonly discount_request_id: string;
  readonly student_id: string;
  readonly enrollment_id: string;
  readonly target_invoice_id: string | null;
  readonly discount_kind: DiscountKind;
  readonly percent_value: number | null;
  readonly fixed_amount_uzs: string | null;
  readonly reason: string;
  readonly valid_from: string;
  readonly valid_until: string;
  readonly status: DiscountRequestStatus;
  readonly applied_amount_uzs: string;
  readonly approval_id: string | null;
  readonly approved_by_director_id: string | null;
  readonly decision_note: string | null;
  readonly policy_version_id: string | null;
  readonly discount_stacking_mode_snapshot: string | null;
  readonly calculation_version: string | null;
  readonly family_offer_eligible: boolean;
  readonly version: number;
  readonly created_at_utc: string;
  readonly updated_at_utc: string;
}

function formatPgDate(val: unknown): string {
  if (val instanceof Date) return val.toISOString().slice(0, 10);
  return String(val).slice(0, 10);
}

/**
 * Parses a percentage value (`0.01..100`) into exact integer basis points (`1..10000`)
 * without binary floating-point rounding drift.
 */
export function parsePercentValueToBasisPoints(
  raw: unknown,
  fieldName = 'percent_value',
): ParsedPercentBasisPoints {
  if (typeof raw !== 'number' && typeof raw !== 'string') {
    throw new ApiHttpException({
      statusCode: 400,
      errorCode: 'VALIDATION_ERROR',
      message: `${fieldName} must be a number in range 0.01..100`,
    });
  }
  if (typeof raw === 'number' && !Number.isFinite(raw)) {
    throw new ApiHttpException({
      statusCode: 400,
      errorCode: 'VALIDATION_ERROR',
      message: `${fieldName} must be a finite number`,
    });
  }

  const str = String(raw).trim();
  const match = /^([0-9]{1,3})(?:\.([0-9]{1,2}))?$/.exec(str);
  if (!match) {
    throw new ApiHttpException({
      statusCode: 422,
      errorCode: 'VALIDATION_ERROR',
      message: `${fieldName} must be between 0.01 and 100 with at most 2 decimal places`,
    });
  }

  const whole = Number(match[1]);
  const fracStr = (match[2] ?? '').padEnd(2, '0');
  const frac = Number(fracStr);
  const basisPoints = whole * 100 + frac;

  if (basisPoints < 1 || basisPoints > 10000) {
    throw new ApiHttpException({
      statusCode: 422,
      errorCode: 'VALIDATION_ERROR',
      message: `${fieldName} must be in range 0.01..100 (got ${str})`,
    });
  }

  const percentSqlDecimal = `${whole}.${fracStr}`;
  const percentNumber = Number(percentSqlDecimal);

  return Object.freeze({
    basisPoints,
    percentNumber,
    percentSqlDecimal,
  });
}

/**
 * Pure validator for `CreateDiscountRequest` payloads (`09.01`).
 */
export function validateDiscountRequestInput(
  rawBody: unknown,
  centerTodayDate: string,
): ValidatedDiscountRequestInput {
  const obj = assertPlainObject(rawBody, [
    'enrollment_id',
    'target_invoice_id',
    'discount_kind',
    'percent_value',
    'fixed_amount_uzs',
    'reason',
    'valid_from',
    'valid_until',
  ]);

  const enrollmentId = assertValidUuid(obj.enrollment_id, 'enrollment_id');
  const targetInvoiceId =
    obj.target_invoice_id !== undefined && obj.target_invoice_id !== null
      ? assertValidUuid(obj.target_invoice_id, 'target_invoice_id')
      : null;

  const kindRaw =
    typeof obj.discount_kind === 'string' ? obj.discount_kind.trim().toUpperCase() : '';
  if (!ALLOWED_DISCOUNT_KINDS.has(kindRaw as DiscountKind)) {
    throw new ApiHttpException({
      statusCode: 400,
      errorCode: 'VALIDATION_ERROR',
      message:
        'discount_kind must be FAMILY_DISCOUNT, SPECIAL_50_PERCENT, CUSTOM_PERCENT, CUSTOM_FIXED, or FULL_GRANT_100',
    });
  }
  const discountKind = kindRaw as DiscountKind;

  if (typeof obj.reason !== 'string') {
    throw new ApiHttpException({
      statusCode: 400,
      errorCode: 'VALIDATION_ERROR',
      message: 'reason is required and must be a string',
    });
  }
  const reason = obj.reason.trim();
  if (reason.length < 3 || reason.length > 500) {
    throw new ApiHttpException({
      statusCode: 422,
      errorCode: 'VALIDATION_ERROR',
      message: 'reason must be between 3 and 500 characters (T09.01)',
    });
  }

  const validFrom = validateIsoDate(obj.valid_from, 'valid_from');
  const validUntil = validateIsoDate(obj.valid_until, 'valid_until');
  if (validUntil < validFrom) {
    throw new ApiHttpException({
      statusCode: 422,
      errorCode: 'VALIDATION_ERROR',
      message: `valid_until (${validUntil}) cannot be earlier than valid_from (${validFrom}) (T09.01)`,
    });
  }
  const cleanToday = validateIsoDate(centerTodayDate, 'centerTodayDate');
  if (validUntil < cleanToday) {
    throw new ApiHttpException({
      statusCode: 422,
      errorCode: 'VALIDATION_ERROR',
      message: `Cannot create an already-expired discount request: valid_until (${validUntil}) is earlier than center date (${cleanToday})`,
    });
  }

  const hasPercent = obj.percent_value !== undefined && obj.percent_value !== null;
  const hasFixed = obj.fixed_amount_uzs !== undefined && obj.fixed_amount_uzs !== null;

  let percentBasisPoints: number | null = null;
  let percentNumber: number | null = null;
  let percentSqlDecimal: string | null = null;
  let fixedAmountUzs: bigint | null = null;

  if (discountKind === 'FULL_GRANT_100') {
    if (hasFixed) {
      throw new ApiHttpException({
        statusCode: 422,
        errorCode: 'VALIDATION_ERROR',
        message: 'FULL_GRANT_100 cannot specify fixed_amount_uzs',
      });
    }
    if (hasPercent) {
      const parsed = parsePercentValueToBasisPoints(obj.percent_value, 'percent_value');
      if (parsed.basisPoints !== 10000) {
        throw new ApiHttpException({
          statusCode: 422,
          errorCode: 'VALIDATION_ERROR',
          message: 'FULL_GRANT_100 percent_value must be 100',
        });
      }
    }
    percentBasisPoints = 10000;
    percentNumber = 100;
    percentSqlDecimal = '100.00';
  } else if (discountKind === 'SPECIAL_50_PERCENT') {
    if (hasFixed) {
      throw new ApiHttpException({
        statusCode: 422,
        errorCode: 'VALIDATION_ERROR',
        message: 'SPECIAL_50_PERCENT cannot specify fixed_amount_uzs',
      });
    }
    if (hasPercent) {
      const parsed = parsePercentValueToBasisPoints(obj.percent_value, 'percent_value');
      if (parsed.basisPoints !== 5000) {
        throw new ApiHttpException({
          statusCode: 422,
          errorCode: 'VALIDATION_ERROR',
          message: 'SPECIAL_50_PERCENT percent_value must be 50',
        });
      }
    }
    percentBasisPoints = 5000;
    percentNumber = 50;
    percentSqlDecimal = '50.00';
  } else if (discountKind === 'CUSTOM_PERCENT') {
    if (!hasPercent || hasFixed) {
      throw new ApiHttpException({
        statusCode: 422,
        errorCode: 'VALIDATION_ERROR',
        message: 'CUSTOM_PERCENT requires percent_value (0.01..100) and forbids fixed_amount_uzs',
      });
    }
    const parsed = parsePercentValueToBasisPoints(obj.percent_value, 'percent_value');
    percentBasisPoints = parsed.basisPoints;
    percentNumber = parsed.percentNumber;
    percentSqlDecimal = parsed.percentSqlDecimal;
  } else if (discountKind === 'CUSTOM_FIXED') {
    if (!hasFixed || hasPercent) {
      throw new ApiHttpException({
        statusCode: 422,
        errorCode: 'VALIDATION_ERROR',
        message: 'CUSTOM_FIXED requires positive fixed_amount_uzs and forbids percent_value',
      });
    }
    try {
      fixedAmountUzs = parsePositiveMoneyUzs(obj.fixed_amount_uzs, 'fixed_amount_uzs');
    } catch (err: unknown) {
      throw new ApiHttpException({
        statusCode: 422,
        errorCode: 'VALIDATION_ERROR',
        message: err instanceof Error ? err.message : 'Invalid fixed_amount_uzs',
      });
    }
  } else {
    // FAMILY_DISCOUNT: requires exactly one of percent_value or fixed_amount_uzs
    if ((hasPercent && hasFixed) || (!hasPercent && !hasFixed)) {
      throw new ApiHttpException({
        statusCode: 422,
        errorCode: 'VALIDATION_ERROR',
        message:
          'FAMILY_DISCOUNT must specify either percent_value (0.01..100) or positive fixed_amount_uzs, not both',
      });
    }
    if (hasPercent) {
      const parsed = parsePercentValueToBasisPoints(obj.percent_value, 'percent_value');
      percentBasisPoints = parsed.basisPoints;
      percentNumber = parsed.percentNumber;
      percentSqlDecimal = parsed.percentSqlDecimal;
    } else {
      try {
        fixedAmountUzs = parsePositiveMoneyUzs(obj.fixed_amount_uzs, 'fixed_amount_uzs');
      } catch (err: unknown) {
        throw new ApiHttpException({
          statusCode: 422,
          errorCode: 'VALIDATION_ERROR',
          message: err instanceof Error ? err.message : 'Invalid fixed_amount_uzs',
        });
      }
    }
  }

  return Object.freeze({
    enrollmentId,
    targetInvoiceId,
    discountKind,
    percentBasisPoints,
    percentNumber,
    percentSqlDecimal,
    fixedAmountUzs,
    reason,
    validFrom,
    validUntil,
  });
}

/**
 * Pure helper evaluating whether a student qualifies for a family discount offer proposal (`09.01`):
 * Requires an authenticated active guardian link (`guardian_students.active = TRUE`) with `>= 2` active children
 * OR `>= 2` active enrollments for the same student in the center. Raw unlinked name/phone similarity is NEVER sufficient.
 */
export function evaluateFamilyOfferEligibility(params: {
  readonly activeGuardianMaxSiblingCount: number;
  readonly activeEnrollmentCount: number;
}): FamilyOfferEligibilityResult {
  if (params.activeGuardianMaxSiblingCount >= 2) {
    return Object.freeze({
      eligible: true,
      activeGuardianSiblingCount: params.activeGuardianMaxSiblingCount,
      activeEnrollmentCount: params.activeEnrollmentCount,
      qualifyingBasis: 'GUARDIAN_SIBLING_LINK',
    });
  }
  if (params.activeEnrollmentCount >= 2) {
    return Object.freeze({
      eligible: true,
      activeGuardianSiblingCount: params.activeGuardianMaxSiblingCount,
      activeEnrollmentCount: params.activeEnrollmentCount,
      qualifyingBasis: 'MULTI_COURSE_ENROLLMENT',
    });
  }
  return Object.freeze({
    eligible: false,
    activeGuardianSiblingCount: params.activeGuardianMaxSiblingCount,
    activeEnrollmentCount: params.activeEnrollmentCount,
    qualifyingBasis: 'NONE',
  });
}

@Injectable()
export class DiscountRequestsService {
  constructor(
    @Inject(API_CONFIG_TOKEN) private readonly config: ApiEnvConfig,
    @Inject(DatabaseService) private readonly databaseService: DatabaseService,
    @Inject(ClockService) private readonly clock: ClockService,
  ) {}

  public async queryStudentFamilyOfferEligibilityInTx(
    tx: Pick<DatabaseService, 'query'> | TransactionContext,
    centerId: string,
    studentId: string,
  ): Promise<FamilyOfferEligibilityResult> {
    const res = await tx.query<{
      max_sibling_count: number;
      active_enr_count: number;
    }>(
      `SELECT COALESCE(
                (SELECT MAX(sib.cnt)::int
                   FROM (
                     SELECT COUNT(DISTINCT gs2."student_id") AS cnt
                       FROM "guardian_students" gs1
                       JOIN "guardians" g
                         ON g."id" = gs1."guardian_id"
                        AND g."center_id" = gs1."center_id"
                       JOIN "guardian_students" gs2
                         ON gs2."guardian_id" = g."id"
                        AND gs2."center_id" = g."center_id"
                       JOIN "students" s2
                         ON s2."id" = gs2."student_id"
                        AND s2."center_id" = gs2."center_id"
                      WHERE gs1."center_id" = $1::uuid
                        AND gs1."student_id" = $2::uuid
                        AND gs1."active" = TRUE
                        AND g."status" = 'ACTIVE'
                        AND gs2."active" = TRUE
                        AND s2."status" = 'ACTIVE'
                      GROUP BY g."id"
                   ) sib),
                0
              )::int AS max_sibling_count,
              (SELECT COUNT(*)::int
                 FROM "enrollments" e
                WHERE e."center_id" = $1::uuid
                  AND e."student_id" = $2::uuid
                  AND e."status" IN ('TRIAL', 'ACTIVE', 'FROZEN')) AS active_enr_count`,
      [centerId, studentId],
    );

    const row = res.rows[0];
    return evaluateFamilyOfferEligibility({
      activeGuardianMaxSiblingCount: Number(row?.max_sibling_count ?? 0),
      activeEnrollmentCount: Number(row?.active_enr_count ?? 0),
    });
  }

  public async loadDiscountRequestResponseInTx(
    tx: Pick<DatabaseService, 'query'> | TransactionContext,
    centerId: string,
    discountRequestId: string,
  ): Promise<DiscountRequestResponseDto> {
    const res = await tx.query<{
      id: string;
      student_id: string;
      enrollment_id: string;
      target_invoice_id: string | null;
      discount_kind: DiscountKind;
      percent_value: string | null;
      fixed_amount_uzs: string | null;
      reason: string;
      valid_from: unknown;
      valid_until: unknown;
      status: DiscountRequestStatus;
      version: number;
      created_at: Date;
      updated_at: Date;
      approval_id: string | null;
      director_staff_id: string | null;
      applied_amount_uzs: string | null;
      decision_note: string | null;
      policy_version_id: string | null;
      discount_stacking_mode_snapshot: string | null;
      calculation_version: string | null;
    }>(
      `SELECT dr."id"::text AS id,
              dr."student_id"::text AS student_id,
              dr."enrollment_id"::text AS enrollment_id,
              dr."target_invoice_id"::text AS target_invoice_id,
              dr."discount_kind"::text AS discount_kind,
              dr."percent_value"::text AS percent_value,
              dr."fixed_amount_uzs"::text AS fixed_amount_uzs,
              dr."reason",
              dr."valid_from"::text AS valid_from,
              dr."valid_until"::text AS valid_until,
              dr."status"::text AS status,
              dr."version",
              dr."created_at",
              dr."updated_at",
              da."id"::text AS approval_id,
              da."director_staff_id"::text AS director_staff_id,
              da."applied_amount_uzs"::text AS applied_amount_uzs,
              da."decision_note",
              da."policy_version_id"::text AS policy_version_id,
              da."discount_stacking_mode_snapshot"::text AS discount_stacking_mode_snapshot,
              da."calculation_version"::text AS calculation_version
         FROM "discount_requests" dr
         LEFT JOIN "discount_approvals" da
           ON da."discount_request_id" = dr."id"
          AND da."center_id" = dr."center_id"
        WHERE dr."id" = $1::uuid
          AND dr."center_id" = $2::uuid
        LIMIT 1`,
      [discountRequestId, centerId],
    );

    const row = res.rows[0];
    if (!row) {
      throw new ApiHttpException({
        statusCode: 404,
        errorCode: 'NOT_FOUND',
        message: 'Discount request not found in center scope',
      });
    }

    const familyEligibility = await this.queryStudentFamilyOfferEligibilityInTx(
      tx,
      centerId,
      row.student_id,
    );

    return Object.freeze({
      discount_request_id: row.id,
      student_id: row.student_id,
      enrollment_id: row.enrollment_id,
      target_invoice_id: row.target_invoice_id ?? null,
      discount_kind: row.discount_kind,
      percent_value: row.percent_value !== null ? Number(row.percent_value) : null,
      fixed_amount_uzs:
        row.fixed_amount_uzs !== null ? BigInt(row.fixed_amount_uzs).toString(10) : null,
      reason: row.reason,
      valid_from: formatPgDate(row.valid_from),
      valid_until: formatPgDate(row.valid_until),
      status: row.status,
      applied_amount_uzs:
        row.applied_amount_uzs !== null ? BigInt(row.applied_amount_uzs).toString(10) : '0',
      approval_id: row.approval_id ?? null,
      approved_by_director_id: row.director_staff_id ?? null,
      decision_note: row.decision_note ?? null,
      policy_version_id: row.policy_version_id ?? null,
      discount_stacking_mode_snapshot: row.discount_stacking_mode_snapshot ?? null,
      calculation_version: row.calculation_version ?? null,
      family_offer_eligible: familyEligibility.eligible,
      version: Number(row.version),
      created_at_utc: new Date(row.created_at).toISOString(),
      updated_at_utc: new Date(row.updated_at).toISOString(),
    });
  }

  public async createDiscountOrGrantRequest(
    req: RequestWithCorrelationId,
    principal: AuthenticatedStaffPrincipal,
    rawBody: unknown,
  ): Promise<DiscountRequestResponseDto> {
    const idempotencyKey = requireIdempotencyKeyHeader(req);
    const now = this.clock.now();
    const centerTodayDate = formatCenterLocalDate(now, this.config.centerTimezone);
    const parsed = validateDiscountRequestInput(rawBody, centerTodayDate);
    const requestId = req.requestId ?? resolveRequestId(req.headers['x-request-id']);

    const outcome = await executeIdempotentOperation<DiscountRequestResponseDto>(
      this.databaseService,
      {
        centerId: principal.centerId,
        actorStaffId: principal.staffId,
        operationType: 'CREATE_DISCOUNT_OR_GRANT_REQUEST',
        idempotencyKey,
        requestPayload: {
          enrollment_id: parsed.enrollmentId,
          target_invoice_id: parsed.targetInvoiceId,
          discount_kind: parsed.discountKind,
          percent_value: parsed.percentSqlDecimal,
          fixed_amount_uzs:
            parsed.fixedAmountUzs !== null ? formatMoneyUzs(parsed.fixedAmountUzs) : null,
          reason: parsed.reason,
          valid_from: parsed.validFrom,
          valid_until: parsed.validUntil,
        },
        authorizeBeforeReplayOrExecute: async (tx) => {
          const enrCheck = await tx.query<{ id: string }>(
            `SELECT "id"::text AS id
               FROM "enrollments"
              WHERE "id" = $1::uuid
                AND "center_id" = $2::uuid
              FOR UPDATE`,
            [parsed.enrollmentId, principal.centerId],
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
          const enrRes = await tx.query<{
            id: string;
            student_id: string;
            group_id: string;
            status: string;
          }>(
            `SELECT "id"::text AS id,
                    "student_id"::text AS student_id,
                    "group_id"::text AS group_id,
                    "status"::text AS status
               FROM "enrollments"
              WHERE "id" = $1::uuid
                AND "center_id" = $2::uuid
              FOR UPDATE`,
            [parsed.enrollmentId, principal.centerId],
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
              message: 'Cannot create a discount or grant request for a LEFT enrollment',
            });
          }

          const familyEligibility = await this.queryStudentFamilyOfferEligibilityInTx(
            tx,
            principal.centerId,
            enrollment.student_id,
          );
          if (parsed.discountKind === 'FAMILY_DISCOUNT' && !familyEligibility.eligible) {
            throw new ApiHttpException({
              statusCode: 422,
              errorCode: 'VALIDATION_ERROR',
              message:
                'FAMILY_DISCOUNT requires an authenticated active guardian link with >= 2 active children or >= 2 active enrollments for this student in this center (09.01)',
            });
          }

          if (parsed.targetInvoiceId !== null) {
            const invRes = await tx.query<{
              id: string;
              student_id: string;
              enrollment_id: string;
              base_pro_rata_charge_uzs: string;
              status: string;
              period_start_date: unknown;
              period_end_date: unknown;
            }>(
              `SELECT i."id"::text AS id,
                      i."student_id"::text AS student_id,
                      i."enrollment_id"::text AS enrollment_id,
                      i."base_pro_rata_charge_uzs"::text AS base_pro_rata_charge_uzs,
                      i."status"::text AS status,
                      bc."period_start_date"::text AS period_start_date,
                      bc."period_end_date"::text AS period_end_date
                 FROM "invoices" i
                 JOIN "billing_cycles" bc
                   ON bc."id" = i."billing_cycle_id"
                  AND bc."center_id" = i."center_id"
                WHERE i."id" = $1::uuid
                  AND i."center_id" = $2::uuid
                FOR UPDATE OF i`,
              [parsed.targetInvoiceId, principal.centerId],
            );

            const targetInvoice = invRes.rows[0];
            if (!targetInvoice) {
              throw new ApiHttpException({
                statusCode: 404,
                errorCode: 'NOT_FOUND',
                message: 'Target invoice not found in center scope',
              });
            }
            if (
              targetInvoice.enrollment_id !== enrollment.id ||
              targetInvoice.student_id !== enrollment.student_id
            ) {
              throw new ApiHttpException({
                statusCode: 422,
                errorCode: 'VALIDATION_ERROR',
                message:
                  'target_invoice_id does not belong to the specified enrollment_id and student_id',
              });
            }
            if (targetInvoice.status === 'VOID_COMPENSATED') {
              throw new ApiHttpException({
                statusCode: 422,
                errorCode: 'VALIDATION_ERROR',
                message: 'Cannot request a discount on a VOID_COMPENSATED invoice',
              });
            }

            const pStart = formatPgDate(targetInvoice.period_start_date);
            const pEnd = targetInvoice.period_end_date
              ? formatPgDate(targetInvoice.period_end_date)
              : pStart;
            if (parsed.validUntil < pStart || parsed.validFrom > pEnd) {
              throw new ApiHttpException({
                statusCode: 422,
                errorCode: 'VALIDATION_ERROR',
                message: `Discount validity window ${parsed.validFrom}..${parsed.validUntil} does not cover target invoice period ${pStart}..${pEnd} (CASE-10)`,
              });
            }

            const baseChargeUzs = BigInt(targetInvoice.base_pro_rata_charge_uzs);
            if (parsed.fixedAmountUzs !== null && parsed.fixedAmountUzs > baseChargeUzs) {
              throw new ApiHttpException({
                statusCode: 422,
                errorCode: 'VALIDATION_ERROR',
                message: `Fixed discount amount (${formatMoneyUzs(parsed.fixedAmountUzs)} UZS) cannot exceed target invoice base charge (${formatMoneyUzs(baseChargeUzs)} UZS) (T09.01)`,
              });
            }
          }

          const discountRequestId = crypto.randomUUID();
          await tx.query(
            `INSERT INTO "discount_requests" (
               "id", "center_id", "student_id", "enrollment_id", "target_invoice_id",
               "discount_kind", "percent_value", "fixed_amount_uzs",
               "reason", "valid_from", "valid_until",
               "requested_by_admin_id", "status", "version", "created_at", "updated_at"
             ) VALUES (
               $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
               $6, $7::numeric(5,2), $8::bigint,
               $9, $10::date, $11::date,
               $12::uuid, 'PENDING_APPROVAL', 1, $13::timestamptz, $13::timestamptz
             )`,
            [
              discountRequestId,
              principal.centerId,
              enrollment.student_id,
              enrollment.id,
              parsed.targetInvoiceId,
              parsed.discountKind,
              parsed.percentSqlDecimal,
              parsed.fixedAmountUzs !== null ? formatMoneyUzs(parsed.fixedAmountUzs) : null,
              parsed.reason,
              parsed.validFrom,
              parsed.validUntil,
              principal.staffId,
              now.toISOString(),
            ],
          );

          await tx.query(
            `INSERT INTO "audit_logs" (
               "id", "center_id", "actor_type", "actor_id", "actor_role",
               "action", "entity_type", "entity_id", "severity",
               "after_redacted_json", "request_id", "created_at"
             ) VALUES (
               $1::uuid, $2::uuid, 'STAFF', $3::uuid, $4,
               'DISCOUNT_REQUEST_CREATED', 'DiscountRequest', $5::uuid, 'INFO',
               $6::jsonb, $7, $8::timestamptz
             )`,
            [
              crypto.randomUUID(),
              principal.centerId,
              principal.staffId,
              principal.role,
              discountRequestId,
              JSON.stringify({
                discount_request_id: discountRequestId,
                student_id: enrollment.student_id,
                enrollment_id: enrollment.id,
                target_invoice_id: parsed.targetInvoiceId,
                discount_kind: parsed.discountKind,
                percent_value: parsed.percentSqlDecimal,
                fixed_amount_uzs:
                  parsed.fixedAmountUzs !== null ? formatMoneyUzs(parsed.fixedAmountUzs) : null,
                valid_from: parsed.validFrom,
                valid_until: parsed.validUntil,
                status: 'PENDING_APPROVAL',
                family_offer_eligible: familyEligibility.eligible,
              }),
              requestId,
              now.toISOString(),
            ],
          );

          const dto = await this.loadDiscountRequestResponseInTx(
            tx,
            principal.centerId,
            discountRequestId,
          );
          return {
            statusCode: 201,
            body: dto,
          };
        },
      },
    );

    return outcome.body;
  }
}
