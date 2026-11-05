import { Inject, Injectable } from '@nestjs/common';
import type {
  BillingMode,
  CancelledLessonProrationMode,
  FirstPartialChargeMode,
  PackageCancelMode,
  PolicyConfirmationStatus,
  RollingMonthEndMode,
  RoundingMode,
} from '@eduerp/contracts';
import * as crypto from 'node:crypto';
import { ApiHttpException } from '../auth/auth.errors';
import { ClockService } from '../auth/clock.service';
import { AuthenticatedStaffPrincipal } from '../auth/permissions.guard';
import { formatCenterLocalDate } from '../auth/staff.service';
import { assertPlainObject, requireIdempotencyKeyHeader } from '../auth/validation';
import { RequestWithCorrelationId, resolveRequestId } from '../common/request-id.middleware';
import { ApiEnvConfig } from '../config/env';
import { API_CONFIG_TOKEN } from '../config/tokens';
import { DatabaseService } from '../database/database.service';
import { executeIdempotentOperation } from '../database/idempotency';
import { TransactionContext } from '../database/transaction';
import { validateIsoDate } from '../students/normalization';
import { ALLOWED_BILLING_MODES } from '../academics/academic-validation';

export const BILLING_CALCULATION_VERSION = 's08-v1';

export const ALLOWED_FIRST_PARTIAL_CHARGE_MODES: ReadonlySet<FirstPartialChargeMode> = new Set([
  'UNCONFIGURED',
  'PRORATE_REMAINING_LESSONS',
  'FULL_CYCLE',
]);

export const ALLOWED_ROUNDING_MODES: ReadonlySet<RoundingMode> = new Set(['HALF_UP_UZS_INT']);

export const ALLOWED_ROLLING_MONTH_END_MODES: ReadonlySet<RollingMonthEndMode> = new Set([
  'CLAMP_LAST_DAY',
  'CONTINUE_FROM_CLAMPED_DAY',
  'RESTORE_ANCHOR_31',
  'UNCONFIGURED',
]);

export const ALLOWED_PACKAGE_CANCEL_MODES: ReadonlySet<PackageCancelMode> = new Set([
  'PRESERVE_BALANCE',
  'CREDIT_NEXT_CYCLE',
  'UNCONFIGURED',
]);

export const ALLOWED_CANCELLED_LESSON_PRORATION_MODES: ReadonlySet<CancelledLessonProrationMode> =
  new Set(['UNCONFIGURED', 'EXCLUDE_CANCELLED_FROM_PLANNED', 'COUNT_SCHEDULED_BASELINE']);

export const ALLOWED_POLICY_CONFIRMATION_STATUSES: ReadonlySet<PolicyConfirmationStatus> = new Set([
  'UNCONFIGURED',
  'CONFIRMED',
]);

export interface BillingPolicyVersionDto {
  readonly id: string;
  readonly center_id: string;
  readonly version_number: number;
  readonly billing_mode: BillingMode;
  readonly first_partial_charge_mode: FirstPartialChargeMode;
  readonly rounding_mode: RoundingMode;
  readonly rolling_month_end_mode: RollingMonthEndMode;
  readonly package_cancel_mode: PackageCancelMode;
  readonly cancelled_lesson_proration_mode: CancelledLessonProrationMode;
  readonly discount_stacking_mode: string;
  readonly freeze_credit_basis: string;
  readonly refund_debt_mode: string;
  readonly policy_confirmation_status: PolicyConfirmationStatus;
  readonly effective_from_date: string | null;
  readonly created_by_staff_id: string | null;
  readonly created_at_utc: string;
}

export interface BillingPolicyListResponseDto {
  readonly items: readonly BillingPolicyVersionDto[];
}

function formatPgDateOrNull(val: unknown): string | null {
  if (val === null || val === undefined || val === '') {
    return null;
  }
  if (val instanceof Date) {
    return val.toISOString().slice(0, 10);
  }
  const s = String(val).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

/**
 * Maps a `billing_policy_versions` row to `BillingPolicyVersionDto`.
 * K02 Invariant: Never fabricates `'CONFIRMED'` or `'2026-01-01'` when fields are missing or null;
 * legacy/unconfigured rows map to `policy_confirmation_status = 'UNCONFIGURED'` and `effective_from_date = null`.
 */
export function mapBillingPolicyRowToDto(row: {
  id: string;
  center_id: string;
  version_number: number;
  billing_mode: BillingMode;
  first_partial_charge_mode?: string | null;
  rounding_mode: string;
  rolling_month_end_mode: string;
  package_cancel_mode: string;
  cancelled_lesson_proration_mode?: string | null;
  discount_stacking_mode: string;
  freeze_credit_basis: string;
  refund_debt_mode: string;
  policy_confirmation_status?: string | null;
  effective_from_date?: unknown;
  created_by_staff_id?: string | null;
  created_at: Date | string;
}): BillingPolicyVersionDto {
  const rawStatus = row.policy_confirmation_status;
  const confirmationStatus: PolicyConfirmationStatus =
    rawStatus === 'CONFIRMED' ? 'CONFIRMED' : 'UNCONFIGURED';

  const rawFirstPartial = row.first_partial_charge_mode;
  const firstPartialChargeMode: FirstPartialChargeMode =
    rawFirstPartial === 'PRORATE_REMAINING_LESSONS' || rawFirstPartial === 'FULL_CYCLE'
      ? rawFirstPartial
      : 'UNCONFIGURED';

  return Object.freeze({
    id: row.id,
    center_id: row.center_id,
    version_number: Number(row.version_number),
    billing_mode: row.billing_mode,
    first_partial_charge_mode: firstPartialChargeMode,
    rounding_mode: row.rounding_mode as RoundingMode,
    rolling_month_end_mode: row.rolling_month_end_mode as RollingMonthEndMode,
    package_cancel_mode: row.package_cancel_mode as PackageCancelMode,
    cancelled_lesson_proration_mode: (row.cancelled_lesson_proration_mode ??
      'EXCLUDE_CANCELLED_FROM_PLANNED') as CancelledLessonProrationMode,
    discount_stacking_mode: row.discount_stacking_mode,
    freeze_credit_basis: row.freeze_credit_basis,
    refund_debt_mode: row.refund_debt_mode,
    policy_confirmation_status: confirmationStatus,
    effective_from_date: formatPgDateOrNull(row.effective_from_date),
    created_by_staff_id: row.created_by_staff_id ?? null,
    created_at_utc: new Date(row.created_at).toISOString(),
  });
}

/**
 * Enforces `K02`, `OWNER-20261104-02`, and `OWNER-20261104-03` policy confirmation boundaries:
 * - Every billing execution (full-period, partial-period, rolling, package, worker, or trial conversion)
 *   requires an explicitly `CONFIRMED` policy version with a non-null `effective_from_date <= periodStartDate`
 *   and an explicit `first_partial_charge_mode` (`PRORATE_REMAINING_LESSONS` or `FULL_CYCLE`, except for `LESSON_PACKAGE_12`
 *   which bills by package cycle).
 * - Legacy/seed unconfigured rows (`policy_confirmation_status === 'UNCONFIGURED'` or `first_partial_charge_mode === 'UNCONFIGURED'`)
 *   always fail closed with `403 POLICY_DECISION_NOT_CONFIRMED` and zero financial side effects.
 */
export function assertConfirmedPolicyForBillingExecution(params: {
  readonly policy: BillingPolicyVersionDto;
  readonly periodStartDate?: string;
  readonly isFirstPartialPeriod: boolean;
  readonly isRollingMonth: boolean;
  readonly isLessonPackage12: boolean;
  readonly hasCancelledLessonsInPackageWindow: boolean;
}): void {
  const {
    policy,
    periodStartDate,
    isFirstPartialPeriod,
    isRollingMonth,
    isLessonPackage12,
    hasCancelledLessonsInPackageWindow,
  } = params;

  if (policy.policy_confirmation_status !== 'CONFIRMED') {
    throw new ApiHttpException({
      statusCode: 403,
      errorCode: 'POLICY_DECISION_NOT_CONFIRMED',
      message: `Billing policy version ${policy.version_number} is UNCONFIGURED (status=${policy.policy_confirmation_status}); explicit Director policy confirmation is required before billing (K02 / OWNER-20261104-03)`,
    });
  }

  if (!policy.effective_from_date) {
    throw new ApiHttpException({
      statusCode: 403,
      errorCode: 'POLICY_DECISION_NOT_CONFIRMED',
      message: `Billing policy version ${policy.version_number} has no confirmed effective_from_date (K02)`,
    });
  }

  if (periodStartDate && policy.effective_from_date > periodStartDate) {
    throw new ApiHttpException({
      statusCode: 403,
      errorCode: 'POLICY_DECISION_NOT_CONFIRMED',
      message: `Billing policy version ${policy.version_number} (effective_from_date=${policy.effective_from_date}) is not yet effective for service period starting ${periodStartDate} (K02)`,
    });
  }

  if (policy.rounding_mode !== 'HALF_UP_UZS_INT') {
    throw new ApiHttpException({
      statusCode: 403,
      errorCode: 'POLICY_DECISION_NOT_CONFIRMED',
      message: `Rounding mode '${policy.rounding_mode}' is not confirmed under OWNER-20261104-03 (only HALF_UP_UZS_INT is confirmed)`,
    });
  }

  if (
    (!isLessonPackage12 || isFirstPartialPeriod) &&
    policy.first_partial_charge_mode === 'UNCONFIGURED'
  ) {
    throw new ApiHttpException({
      statusCode: 403,
      errorCode: 'POLICY_DECISION_NOT_CONFIRMED',
      message:
        'Center billing policy first_partial_charge_mode is UNCONFIGURED; Director must explicitly choose PRORATE_REMAINING_LESSONS or FULL_CYCLE (K02 / OWNER-20261104-03)',
    });
  }

  if (
    isRollingMonth &&
    policy.rolling_month_end_mode !== 'CLAMP_LAST_DAY' &&
    policy.rolling_month_end_mode !== 'CONTINUE_FROM_CLAMPED_DAY'
  ) {
    throw new ApiHttpException({
      statusCode: 403,
      errorCode: 'POLICY_DECISION_NOT_CONFIRMED',
      message: `Rolling month end mode '${policy.rolling_month_end_mode}' is not confirmed under OWNER-20261104-03 (only CLAMP_LAST_DAY / CONTINUE_FROM_CLAMPED_DAY is confirmed)`,
    });
  }

  if (isLessonPackage12) {
    if (policy.package_cancel_mode === 'UNCONFIGURED') {
      throw new ApiHttpException({
        statusCode: 403,
        errorCode: 'POLICY_DECISION_NOT_CONFIRMED',
        message: '12-lesson package cancellation policy (D21) is UNCONFIGURED for this center',
      });
    }
    if (hasCancelledLessonsInPackageWindow && policy.package_cancel_mode === 'CREDIT_NEXT_CYCLE') {
      throw new ApiHttpException({
        statusCode: 403,
        errorCode: 'POLICY_DECISION_NOT_CONFIRMED',
        message:
          '12-lesson package cancelled-lesson CreditNote adjustment formula (D21 CREDIT_NEXT_CYCLE) is not confirmed',
      });
    }
  }
}

@Injectable()
export class BillingPolicyService {
  constructor(
    @Inject(API_CONFIG_TOKEN) private readonly config: ApiEnvConfig,
    @Inject(DatabaseService) private readonly databaseService: DatabaseService,
    @Inject(ClockService) private readonly clock: ClockService,
  ) {}

  public async listPolicies(
    principal: AuthenticatedStaffPrincipal,
  ): Promise<BillingPolicyListResponseDto> {
    const res = await this.databaseService.query<{
      id: string;
      center_id: string;
      version_number: number;
      billing_mode: BillingMode;
      first_partial_charge_mode: string | null;
      rounding_mode: string;
      rolling_month_end_mode: string;
      package_cancel_mode: string;
      cancelled_lesson_proration_mode: string | null;
      discount_stacking_mode: string;
      freeze_credit_basis: string;
      refund_debt_mode: string;
      policy_confirmation_status: string | null;
      effective_from_date: unknown;
      created_by_staff_id: string | null;
      created_at: Date;
    }>(
      `SELECT "id"::text AS id,
              "center_id"::text AS center_id,
              "version_number",
              "billing_mode"::text AS billing_mode,
              "first_partial_charge_mode"::text AS first_partial_charge_mode,
              "rounding_mode"::text AS rounding_mode,
              "rolling_month_end_mode"::text AS rolling_month_end_mode,
              "package_cancel_mode"::text AS package_cancel_mode,
              "cancelled_lesson_proration_mode"::text AS cancelled_lesson_proration_mode,
              "discount_stacking_mode"::text AS discount_stacking_mode,
              "freeze_credit_basis"::text AS freeze_credit_basis,
              "refund_debt_mode"::text AS refund_debt_mode,
              "policy_confirmation_status"::text AS policy_confirmation_status,
              "effective_from_date"::text AS effective_from_date,
              "created_by_staff_id"::text AS created_by_staff_id,
              "created_at"
         FROM "billing_policy_versions"
        WHERE "center_id" = $1::uuid
        ORDER BY "version_number" DESC`,
      [principal.centerId],
    );

    return Object.freeze({
      items: Object.freeze(res.rows.map((r) => mapBillingPolicyRowToDto(r))),
    });
  }

  public async createPolicyVersion(
    req: RequestWithCorrelationId,
    principal: AuthenticatedStaffPrincipal,
    rawBody: unknown,
  ): Promise<BillingPolicyVersionDto> {
    const idempotencyKey = requireIdempotencyKeyHeader(req);
    const obj = assertPlainObject(rawBody, [
      'billing_mode',
      'first_partial_charge_mode',
      'rounding_mode',
      'rolling_month_end_mode',
      'package_cancel_mode',
      'cancelled_lesson_proration_mode',
      'discount_stacking_mode',
      'freeze_credit_basis',
      'refund_debt_mode',
      'policy_confirmation_status',
      'effective_from_date',
    ]);

    const billingModeRaw =
      typeof obj.billing_mode === 'string' ? obj.billing_mode.trim().toUpperCase() : '';
    if (!ALLOWED_BILLING_MODES.has(billingModeRaw as BillingMode)) {
      throw new ApiHttpException({
        statusCode: 400,
        errorCode: 'VALIDATION_ERROR',
        message: 'billing_mode must be CALENDAR_PRO_RATA, ROLLING_MONTH, or LESSON_PACKAGE_12',
      });
    }
    const billingMode = billingModeRaw as BillingMode;

    const confirmationStatusRaw =
      obj.policy_confirmation_status === undefined
        ? 'CONFIRMED'
        : typeof obj.policy_confirmation_status === 'string'
          ? obj.policy_confirmation_status.trim().toUpperCase()
          : '';
    if (
      !ALLOWED_POLICY_CONFIRMATION_STATUSES.has(confirmationStatusRaw as PolicyConfirmationStatus)
    ) {
      throw new ApiHttpException({
        statusCode: 400,
        errorCode: 'VALIDATION_ERROR',
        message: 'policy_confirmation_status must be UNCONFIGURED or CONFIRMED',
      });
    }
    const policyConfirmationStatus = confirmationStatusRaw as PolicyConfirmationStatus;

    const firstPartialRaw =
      obj.first_partial_charge_mode === undefined
        ? billingMode === 'LESSON_PACKAGE_12'
          ? 'FULL_CYCLE'
          : 'UNCONFIGURED'
        : typeof obj.first_partial_charge_mode === 'string'
          ? obj.first_partial_charge_mode.trim().toUpperCase()
          : '';
    if (!ALLOWED_FIRST_PARTIAL_CHARGE_MODES.has(firstPartialRaw as FirstPartialChargeMode)) {
      throw new ApiHttpException({
        statusCode: 400,
        errorCode: 'VALIDATION_ERROR',
        message:
          'first_partial_charge_mode must be UNCONFIGURED, PRORATE_REMAINING_LESSONS, or FULL_CYCLE',
      });
    }
    const firstPartialChargeMode = firstPartialRaw as FirstPartialChargeMode;

    if (
      policyConfirmationStatus === 'CONFIRMED' &&
      billingMode !== 'LESSON_PACKAGE_12' &&
      firstPartialChargeMode === 'UNCONFIGURED'
    ) {
      throw new ApiHttpException({
        statusCode: 422,
        errorCode: 'VALIDATION_ERROR',
        message:
          'CONFIRMED billing policy for CALENDAR_PRO_RATA or ROLLING_MONTH must explicitly specify first_partial_charge_mode as PRORATE_REMAINING_LESSONS or FULL_CYCLE (K02 / OWNER-20261104-03)',
      });
    }

    const roundingRaw =
      obj.rounding_mode === undefined
        ? 'HALF_UP_UZS_INT'
        : typeof obj.rounding_mode === 'string'
          ? obj.rounding_mode.trim().toUpperCase()
          : '';
    if (!ALLOWED_ROUNDING_MODES.has(roundingRaw as RoundingMode)) {
      throw new ApiHttpException({
        statusCode: 400,
        errorCode: 'VALIDATION_ERROR',
        message: 'rounding_mode must be HALF_UP_UZS_INT (OWNER-20261104-03)',
      });
    }
    const roundingMode = roundingRaw as RoundingMode;

    const rollingEndRaw =
      obj.rolling_month_end_mode === undefined
        ? 'CONTINUE_FROM_CLAMPED_DAY'
        : typeof obj.rolling_month_end_mode === 'string'
          ? obj.rolling_month_end_mode.trim().toUpperCase()
          : '';
    if (!ALLOWED_ROLLING_MONTH_END_MODES.has(rollingEndRaw as RollingMonthEndMode)) {
      throw new ApiHttpException({
        statusCode: 400,
        errorCode: 'VALIDATION_ERROR',
        message:
          'rolling_month_end_mode must be CLAMP_LAST_DAY, CONTINUE_FROM_CLAMPED_DAY, RESTORE_ANCHOR_31, or UNCONFIGURED',
      });
    }
    const rollingMonthEndMode = rollingEndRaw as RollingMonthEndMode;

    const pkgCancelRaw =
      obj.package_cancel_mode === undefined
        ? 'PRESERVE_BALANCE'
        : typeof obj.package_cancel_mode === 'string'
          ? obj.package_cancel_mode.trim().toUpperCase()
          : '';
    if (!ALLOWED_PACKAGE_CANCEL_MODES.has(pkgCancelRaw as PackageCancelMode)) {
      throw new ApiHttpException({
        statusCode: 400,
        errorCode: 'VALIDATION_ERROR',
        message: 'package_cancel_mode must be PRESERVE_BALANCE, CREDIT_NEXT_CYCLE, or UNCONFIGURED',
      });
    }
    const packageCancelMode = pkgCancelRaw as PackageCancelMode;

    const cancelledProrationRaw =
      obj.cancelled_lesson_proration_mode === undefined
        ? 'EXCLUDE_CANCELLED_FROM_PLANNED'
        : typeof obj.cancelled_lesson_proration_mode === 'string'
          ? obj.cancelled_lesson_proration_mode.trim().toUpperCase()
          : '';
    if (
      !ALLOWED_CANCELLED_LESSON_PRORATION_MODES.has(
        cancelledProrationRaw as CancelledLessonProrationMode,
      )
    ) {
      throw new ApiHttpException({
        statusCode: 400,
        errorCode: 'VALIDATION_ERROR',
        message:
          'cancelled_lesson_proration_mode must be UNCONFIGURED, EXCLUDE_CANCELLED_FROM_PLANNED, or COUNT_SCHEDULED_BASELINE',
      });
    }
    const cancelledLessonProrationMode = cancelledProrationRaw as CancelledLessonProrationMode;

    const discountStackingMode =
      typeof obj.discount_stacking_mode === 'string' && obj.discount_stacking_mode.trim().length > 0
        ? obj.discount_stacking_mode.trim().toUpperCase()
        : 'MAX_SINGLE_DISCOUNT';
    const freezeCreditBasis =
      typeof obj.freeze_credit_basis === 'string' && obj.freeze_credit_basis.trim().length > 0
        ? obj.freeze_credit_basis.trim().toUpperCase()
        : 'NET_PROPORTIONAL_LESSON';
    const refundDebtMode =
      typeof obj.refund_debt_mode === 'string' && obj.refund_debt_mode.trim().length > 0
        ? obj.refund_debt_mode.trim().toUpperCase()
        : 'REOPEN_INVOICE_DEBT';

    if (
      discountStackingMode.length > 32 ||
      freezeCreditBasis.length > 32 ||
      refundDebtMode.length > 32
    ) {
      throw new ApiHttpException({
        statusCode: 400,
        errorCode: 'VALIDATION_ERROR',
        message: 'Policy mode fields must not exceed 32 characters',
      });
    }

    const now = this.clock.now();
    const effectiveFromDate =
      obj.effective_from_date !== undefined && obj.effective_from_date !== null
        ? validateIsoDate(obj.effective_from_date, 'effective_from_date')
        : policyConfirmationStatus === 'CONFIRMED'
          ? formatCenterLocalDate(now, this.config.centerTimezone)
          : null;
    const requestId = req.requestId ?? resolveRequestId(req.headers['x-request-id']);

    const outcome = await executeIdempotentOperation<BillingPolicyVersionDto>(
      this.databaseService,
      {
        centerId: principal.centerId,
        actorStaffId: principal.staffId,
        operationType: 'CREATE_BILLING_POLICY_VERSION',
        idempotencyKey,
        requestPayload: {
          billing_mode: billingMode,
          first_partial_charge_mode: firstPartialChargeMode,
          rounding_mode: roundingMode,
          rolling_month_end_mode: rollingMonthEndMode,
          package_cancel_mode: packageCancelMode,
          cancelled_lesson_proration_mode: cancelledLessonProrationMode,
          discount_stacking_mode: discountStackingMode,
          freeze_credit_basis: freezeCreditBasis,
          refund_debt_mode: refundDebtMode,
          policy_confirmation_status: policyConfirmationStatus,
          effective_from_date: effectiveFromDate,
        },
        handler: async (tx) => {
          await tx.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [
            'BILLING_POLICY_VERSION_SEQ',
            principal.centerId,
          ]);

          const maxVerRes = await tx.query<{ max_ver: number }>(
            `SELECT COALESCE(MAX("version_number"), 0)::int AS max_ver
               FROM "billing_policy_versions"
              WHERE "center_id" = $1::uuid`,
            [principal.centerId],
          );
          const nextVersionNumber = Number(maxVerRes.rows[0]?.max_ver ?? 0) + 1;
          const policyId = crypto.randomUUID();

          const ins = await tx.query<{
            id: string;
            center_id: string;
            version_number: number;
            billing_mode: BillingMode;
            first_partial_charge_mode: string;
            rounding_mode: string;
            rolling_month_end_mode: string;
            package_cancel_mode: string;
            cancelled_lesson_proration_mode: string;
            discount_stacking_mode: string;
            freeze_credit_basis: string;
            refund_debt_mode: string;
            policy_confirmation_status: string;
            effective_from_date: unknown;
            created_by_staff_id: string | null;
            created_at: Date;
          }>(
            `INSERT INTO "billing_policy_versions" (
               "id", "center_id", "version_number", "billing_mode",
               "first_partial_charge_mode", "rounding_mode",
               "discount_stacking_mode", "freeze_credit_basis",
               "rolling_month_end_mode", "package_cancel_mode",
               "cancelled_lesson_proration_mode", "refund_debt_mode",
               "policy_confirmation_status", "effective_from_date",
               "created_by_staff_id", "created_at"
             ) VALUES (
               $1::uuid, $2::uuid, $3::int, $4,
               $5, $6,
               $7, $8,
               $9, $10,
               $11, $12,
               $13, $14::date,
               $15::uuid, $16::timestamptz
             )
             RETURNING "id"::text AS id,
                       "center_id"::text AS center_id,
                       "version_number",
                       "billing_mode"::text AS billing_mode,
                       "first_partial_charge_mode"::text AS first_partial_charge_mode,
                       "rounding_mode"::text AS rounding_mode,
                       "rolling_month_end_mode"::text AS rolling_month_end_mode,
                       "package_cancel_mode"::text AS package_cancel_mode,
                       "cancelled_lesson_proration_mode"::text AS cancelled_lesson_proration_mode,
                       "discount_stacking_mode"::text AS discount_stacking_mode,
                       "freeze_credit_basis"::text AS freeze_credit_basis,
                       "refund_debt_mode"::text AS refund_debt_mode,
                       "policy_confirmation_status"::text AS policy_confirmation_status,
                       "effective_from_date"::text AS effective_from_date,
                       "created_by_staff_id"::text AS created_by_staff_id,
                       "created_at"`,
            [
              policyId,
              principal.centerId,
              nextVersionNumber,
              billingMode,
              firstPartialChargeMode,
              roundingMode,
              discountStackingMode,
              freezeCreditBasis,
              rollingMonthEndMode,
              packageCancelMode,
              cancelledLessonProrationMode,
              refundDebtMode,
              policyConfirmationStatus,
              effectiveFromDate,
              principal.staffId,
              now.toISOString(),
            ],
          );

          const dto = mapBillingPolicyRowToDto(ins.rows[0]);

          await tx.query(
            `INSERT INTO "audit_logs" (
               "id", "center_id", "actor_type", "actor_id", "actor_role",
               "action", "entity_type", "entity_id", "severity",
               "after_redacted_json", "request_id", "created_at"
             ) VALUES (
               $1::uuid, $2::uuid, 'STAFF', $3::uuid, $4,
               'BILLING_POLICY_VERSION_CREATED', 'BillingPolicyVersion', $5::uuid, 'INFO',
               $6::jsonb, $7, $8::timestamptz
             )`,
            [
              crypto.randomUUID(),
              principal.centerId,
              principal.staffId,
              principal.role,
              policyId,
              JSON.stringify(dto),
              requestId,
              now.toISOString(),
            ],
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

  /**
   * Resolves the active BillingPolicyVersion for a group and service period start date (`K02`):
   * 1. If the group has an explicit `billing_policy_version_id`, loads that exact version in `center_id`.
   * 2. Otherwise, resolves the latest version in `center_id` matching `billing_mode` where:
   *    - First prefers `policy_confirmation_status = 'CONFIRMED' AND effective_from_date IS NOT NULL AND effective_from_date <= $3::date`,
   *      ordered by `effective_from_date DESC, version_number DESC`.
   *    - If no confirmed effective policy exists for `billing_mode` as of `periodStartDate`, returns the latest row (if any) so
   *      `assertConfirmedPolicyForBillingExecution` fails closed with `403 POLICY_DECISION_NOT_CONFIRMED` and a diagnostic message
   *      (never silently falling back to a future-dated policy or an unconfirmed seed policy!).
   */
  public async resolveActivePolicyForGroupPeriod(
    tx: TransactionContext,
    centerId: string,
    groupBillingMode: BillingMode,
    groupPolicyVersionId: string | null,
    periodStartDate: string,
  ): Promise<BillingPolicyVersionDto> {
    if (groupPolicyVersionId) {
      const boundRes = await tx.query<{
        id: string;
        center_id: string;
        version_number: number;
        billing_mode: BillingMode;
        first_partial_charge_mode: string | null;
        rounding_mode: string;
        rolling_month_end_mode: string;
        package_cancel_mode: string;
        cancelled_lesson_proration_mode: string | null;
        discount_stacking_mode: string;
        freeze_credit_basis: string;
        refund_debt_mode: string;
        policy_confirmation_status: string | null;
        effective_from_date: unknown;
        created_by_staff_id: string | null;
        created_at: Date;
      }>(
        `SELECT "id"::text AS id,
                "center_id"::text AS center_id,
                "version_number",
                "billing_mode"::text AS billing_mode,
                "first_partial_charge_mode"::text AS first_partial_charge_mode,
                "rounding_mode"::text AS rounding_mode,
                "rolling_month_end_mode"::text AS rolling_month_end_mode,
                "package_cancel_mode"::text AS package_cancel_mode,
                "cancelled_lesson_proration_mode"::text AS cancelled_lesson_proration_mode,
                "discount_stacking_mode"::text AS discount_stacking_mode,
                "freeze_credit_basis"::text AS freeze_credit_basis,
                "refund_debt_mode"::text AS refund_debt_mode,
                "policy_confirmation_status"::text AS policy_confirmation_status,
                "effective_from_date"::text AS effective_from_date,
                "created_by_staff_id"::text AS created_by_staff_id,
                "created_at"
           FROM "billing_policy_versions"
          WHERE "id" = $1::uuid
            AND "center_id" = $2::uuid
          LIMIT 1`,
        [groupPolicyVersionId, centerId],
      );
      const row = boundRes.rows[0];
      if (!row) {
        throw new ApiHttpException({
          statusCode: 404,
          errorCode: 'NOT_FOUND',
          message: 'Bound billing_policy_version_id not found in center scope',
        });
      }
      if (row.billing_mode !== groupBillingMode) {
        throw new ApiHttpException({
          statusCode: 422,
          errorCode: 'VALIDATION_ERROR',
          message: `Bound billing_policy_version_id mode (${row.billing_mode}) does not match group billing_mode (${groupBillingMode})`,
        });
      }
      return mapBillingPolicyRowToDto(row);
    }

    const modeRes = await tx.query<{
      id: string;
      center_id: string;
      version_number: number;
      billing_mode: BillingMode;
      first_partial_charge_mode: string | null;
      rounding_mode: string;
      rolling_month_end_mode: string;
      package_cancel_mode: string;
      cancelled_lesson_proration_mode: string | null;
      discount_stacking_mode: string;
      freeze_credit_basis: string;
      refund_debt_mode: string;
      policy_confirmation_status: string | null;
      effective_from_date: unknown;
      created_by_staff_id: string | null;
      created_at: Date;
    }>(
      `SELECT "id"::text AS id,
              "center_id"::text AS center_id,
              "version_number",
              "billing_mode"::text AS billing_mode,
              "first_partial_charge_mode"::text AS first_partial_charge_mode,
              "rounding_mode"::text AS rounding_mode,
              "rolling_month_end_mode"::text AS rolling_month_end_mode,
              "package_cancel_mode"::text AS package_cancel_mode,
              "cancelled_lesson_proration_mode"::text AS cancelled_lesson_proration_mode,
              "discount_stacking_mode"::text AS discount_stacking_mode,
              "freeze_credit_basis"::text AS freeze_credit_basis,
              "refund_debt_mode"::text AS refund_debt_mode,
              "policy_confirmation_status"::text AS policy_confirmation_status,
              "effective_from_date"::text AS effective_from_date,
              "created_by_staff_id"::text AS created_by_staff_id,
              "created_at"
         FROM "billing_policy_versions"
        WHERE "center_id" = $1::uuid
          AND "billing_mode" = $2
          AND "policy_confirmation_status" = 'CONFIRMED'
          AND "effective_from_date" IS NOT NULL
          AND "effective_from_date" <= $3::date
        ORDER BY "effective_from_date" DESC,
                 "version_number" DESC
        LIMIT 1`,
      [centerId, groupBillingMode, periodStartDate],
    );

    const row = modeRes.rows[0];
    if (!row) {
      throw new ApiHttpException({
        statusCode: 403,
        errorCode: 'POLICY_DECISION_NOT_CONFIRMED',
        message: `No CONFIRMED BillingPolicyVersion is active for billing_mode=${groupBillingMode} as of ${periodStartDate}; Director must explicitly confirm center billing policy before issuing invoices (K02 / OWNER-20261104-03)`,
      });
    }
    return mapBillingPolicyRowToDto(row);
  }
}
