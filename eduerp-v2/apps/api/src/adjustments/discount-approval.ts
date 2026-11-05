/**
 * EduERP v2.0 — Stage 09, Step 09.02 (`T09.02`, `OWNER-20261105-04`):
 * Director-Only Discount & Grant Decision (`APPROVED` / `REJECTED`),
 * Configurable Center Stacking (`MAX_SINGLE` vs `SEQUENTIAL` / `PERCENT_THEN_FIXED` / `FIXED_THEN_PERCENT`),
 * 100% Grant Zero-Debt Execution, Retroactive Overpayment Safety Gate,
 * and Atomic Invoice / InvoiceLine / LedgerEntry / AuditLog / OutboxEvent Execution.
 */

import { Inject, Injectable } from '@nestjs/common';
import type {
  BillingMode,
  DiscountDecision,
  DiscountKind,
  DiscountStackingMode,
  InvoiceStatus,
} from '@eduerp/contracts';
import * as crypto from 'node:crypto';
import { ApiHttpException } from '../auth/auth.errors';
import { ClockService } from '../auth/clock.service';
import { AuthenticatedStaffPrincipal } from '../auth/permissions.guard';
import { formatCenterLocalDate } from '../auth/staff.service';
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
import { executeOptimisticUpdate } from '../database/transaction';
import {
  ADJUSTMENTS_CALCULATION_VERSION,
  BillingPolicyService,
  CONFIRMED_DISCOUNT_STACKING_MODES,
} from '../billing/policy';
import {
  DiscountRequestResponseDto,
  DiscountRequestsService,
  parsePercentValueToBasisPoints,
} from './discount-requests';

export type DiscountApprovalFaultStep =
  | 'DISCOUNT_REQUEST_UPDATE'
  | 'DISCOUNT_APPROVAL'
  | 'INVOICE_UPDATE'
  | 'INVOICE_LINE'
  | 'LEDGER_ENTRY'
  | 'AUDIT_LOG'
  | 'OUTBOX_EVENT';

export interface DiscountCalculationItem {
  readonly requestId: string;
  readonly discountKind: DiscountKind;
  readonly percentBasisPoints: number | null;
  readonly fixedAmountUzs: bigint | null;
}

export interface DiscountStackCalculationResult {
  readonly baseChargeUzs: bigint;
  readonly previousApprovedDiscountUzs: bigint;
  readonly newTotalApprovedDiscountUzs: bigint;
  readonly appliedDeltaUzs: bigint;
  readonly resultingGrossAfterDiscountUzs: bigint;
  readonly stackingMode: DiscountStackingMode;
  readonly calculationVersion: string;
  readonly formulaSnapshot: string;
}

function formatPgDate(val: unknown): string {
  if (val instanceof Date) return val.toISOString().slice(0, 10);
  return String(val).slice(0, 10);
}

function computeSingleDiscountBenefitOnCharge(
  chargeUzs: bigint,
  item: DiscountCalculationItem,
): bigint {
  if (chargeUzs <= 0n) return 0n;
  if (item.discountKind === 'FULL_GRANT_100') {
    return chargeUzs;
  }
  if (item.percentBasisPoints !== null) {
    const raw = divideAndRoundHalfUpUzs(
      chargeUzs * BigInt(item.percentBasisPoints),
      10000n,
    );
    return raw <= chargeUzs ? raw : chargeUzs;
  }
  if (item.fixedAmountUzs !== null) {
    return item.fixedAmountUzs <= chargeUzs ? item.fixedAmountUzs : chargeUzs;
  }
  return 0n;
}

/**
 * Pure deterministic calculator for Stage 09 (`09.02`, `OWNER-20261105-04`) discount stacking:
 * - Fails closed (`403 POLICY_DECISION_NOT_CONFIRMED`) when `stackingMode` is `'UNCONFIGURED'` or unconfirmed.
 * - Under `MAX_SINGLE` (`'MAX_SINGLE' | 'MAX_SINGLE_DISCOUNT' | 'HIGHEST_ONLY'`):
 *   Does NOT sum multiple discounts; picks the single highest-value discount on `baseChargeUzs`
 *   (e.g., `480,000` with `20%` (`96,000`) and `10%` (`48,000`) -> `96,000` discount, `384,000` charge).
 * - Under `SEQUENTIAL` (`'SEQUENTIAL' | 'SEQUENTIAL_APPROVAL_ORDER' | 'PERCENT_THEN_FIXED' | 'SEQUENTIAL_PERCENT_THEN_FIXED' | 'FIXED_THEN_PERCENT' | 'SEQUENTIAL_FIXED_THEN_PERCENT'`):
 *   Applies discounts sequentially in deterministic order against the running remaining charge using `HALF_UP`
 *   (e.g., `480,000 * (1 - 20%) * (1 - 10%) = 384,000 * 90% = 345,600` charge, total discount `134,400`).
 * - Total discount never exceeds `baseChargeUzs` (`resultingGrossAfterDiscountUzs >= 0n`).
 */
export function calculateInvoiceDiscountStackUzs(params: {
  readonly baseChargeUzs: bigint | string | number;
  readonly currentApprovedDiscountUzs?: bigint | string | number;
  readonly stackingMode: string;
  readonly existingApprovedDiscounts?: readonly DiscountCalculationItem[];
  readonly candidateDiscount: DiscountCalculationItem;
}): DiscountStackCalculationResult {
  const baseChargeUzs = parseNonNegativeMoneyUzs(params.baseChargeUzs, 'baseChargeUzs');
  const previousApprovedDiscountUzs = parseNonNegativeMoneyUzs(
    params.currentApprovedDiscountUzs ?? 0n,
    'currentApprovedDiscountUzs',
  );
  const rawMode = params.stackingMode.trim().toUpperCase() as DiscountStackingMode;

  if (!CONFIRMED_DISCOUNT_STACKING_MODES.has(rawMode)) {
    throw new ApiHttpException({
      statusCode: 403,
      errorCode: 'POLICY_DECISION_NOT_CONFIRMED',
      message: `Discount stacking mode '${params.stackingMode}' is not confirmed under OWNER-20261105-04`,
    });
  }

  const candidate = params.candidateDiscount;
  if (candidate.fixedAmountUzs !== null && candidate.fixedAmountUzs > baseChargeUzs) {
    throw new ApiHttpException({
      statusCode: 422,
      errorCode: 'VALIDATION_ERROR',
      message: `Fixed discount amount (${formatMoneyUzs(candidate.fixedAmountUzs)} UZS) exceeds invoice base charge (${formatMoneyUzs(baseChargeUzs)} UZS)`,
    });
  }

  const allItems: DiscountCalculationItem[] = [
    ...(params.existingApprovedDiscounts ?? []),
    candidate,
  ];

  const isMaxSingle =
    rawMode === 'MAX_SINGLE' ||
    rawMode === 'MAX_SINGLE_DISCOUNT' ||
    rawMode === 'HIGHEST_ONLY';

  let newTotalApprovedDiscountUzs: bigint;
  let formulaDesc: string;

  if (isMaxSingle) {
    let bestBenefit = previousApprovedDiscountUzs;
    for (const item of allItems) {
      const benefit = computeSingleDiscountBenefitOnCharge(baseChargeUzs, item);
      if (benefit > bestBenefit) {
        bestBenefit = benefit;
      }
    }
    newTotalApprovedDiscountUzs = bestBenefit <= baseChargeUzs ? bestBenefit : baseChargeUzs;
    formulaDesc = `MAX_SINGLE(${rawMode}): base=${formatMoneyUzs(baseChargeUzs)}, prev_discount=${formatMoneyUzs(previousApprovedDiscountUzs)}, new_total_discount=${formatMoneyUzs(newTotalApprovedDiscountUzs)}`;
  } else {
    let orderedItems = [...allItems];
    if (
      rawMode === 'PERCENT_THEN_FIXED' ||
      rawMode === 'SEQUENTIAL_PERCENT_THEN_FIXED'
    ) {
      const pcts = orderedItems.filter(
        (x) => x.discountKind === 'FULL_GRANT_100' || x.percentBasisPoints !== null,
      );
      const fixeds = orderedItems.filter(
        (x) => x.discountKind !== 'FULL_GRANT_100' && x.percentBasisPoints === null,
      );
      orderedItems = [...pcts, ...fixeds];
    } else if (
      rawMode === 'FIXED_THEN_PERCENT' ||
      rawMode === 'SEQUENTIAL_FIXED_THEN_PERCENT'
    ) {
      const fixeds = orderedItems.filter(
        (x) => x.discountKind !== 'FULL_GRANT_100' && x.percentBasisPoints === null,
      );
      const pcts = orderedItems.filter(
        (x) => x.discountKind === 'FULL_GRANT_100' || x.percentBasisPoints !== null,
      );
      orderedItems = [...fixeds, ...pcts];
    }

    let runningRemaining = baseChargeUzs;
    const steps: string[] = [];
    for (const item of orderedItems) {
      const stepBenefit = computeSingleDiscountBenefitOnCharge(runningRemaining, item);
      runningRemaining -= stepBenefit;
      steps.push(`${item.discountKind}:${formatMoneyUzs(stepBenefit)}`);
    }
    const computedTotal = baseChargeUzs - runningRemaining;
    newTotalApprovedDiscountUzs =
      computedTotal >= previousApprovedDiscountUzs
        ? computedTotal <= baseChargeUzs
          ? computedTotal
          : baseChargeUzs
        : previousApprovedDiscountUzs;
    formulaDesc = `SEQUENTIAL(${rawMode}) [${steps.join(' -> ')}]: base=${formatMoneyUzs(baseChargeUzs)}, total_discount=${formatMoneyUzs(newTotalApprovedDiscountUzs)}, net_after_discount=${formatMoneyUzs(baseChargeUzs - newTotalApprovedDiscountUzs)}`;
  }

  const appliedDeltaUzs =
    newTotalApprovedDiscountUzs > previousApprovedDiscountUzs
      ? newTotalApprovedDiscountUzs - previousApprovedDiscountUzs
      : 0n;
  const resultingGrossAfterDiscountUzs = baseChargeUzs - newTotalApprovedDiscountUzs;

  return Object.freeze({
    baseChargeUzs,
    previousApprovedDiscountUzs,
    newTotalApprovedDiscountUzs,
    appliedDeltaUzs,
    resultingGrossAfterDiscountUzs,
    stackingMode: rawMode,
    calculationVersion: ADJUSTMENTS_CALCULATION_VERSION,
    formulaSnapshot: `${formulaDesc} (${ADJUSTMENTS_CALCULATION_VERSION})`,
  });
}

@Injectable()
export class DiscountApprovalService {
  constructor(
    @Inject(API_CONFIG_TOKEN) private readonly config: ApiEnvConfig,
    @Inject(DatabaseService) private readonly databaseService: DatabaseService,
    @Inject(ClockService) private readonly clock: ClockService,
    @Inject(BillingPolicyService) private readonly policyService: BillingPolicyService,
    @Inject(DiscountRequestsService)
    private readonly discountRequestsService: DiscountRequestsService,
  ) {}

  private maybeInjectTestFault(
    targetStep: DiscountApprovalFaultStep,
    configuredFault?: DiscountApprovalFaultStep,
  ): void {
    if (this.config.nodeEnv === 'test' && configuredFault === targetStep) {
      throw new Error(`SIMULATED_S09_DISCOUNT_FAULT_AFTER_${targetStep}`);
    }
  }

  public async decideDiscountOrGrantRequest(
    req: RequestWithCorrelationId,
    principal: AuthenticatedStaffPrincipal,
    rawDiscountRequestId: unknown,
    rawBody: unknown,
    options?: { readonly testFaultAfterStep?: DiscountApprovalFaultStep },
  ): Promise<DiscountRequestResponseDto> {
    if (principal.role !== 'DIRECTOR') {
      throw new ApiHttpException({
        statusCode: 403,
        errorCode: 'FORBIDDEN_ROLE',
        message: 'Only DIRECTOR is permitted to approve or reject discount and grant requests (T09.02)',
      });
    }

    const idempotencyKey = requireIdempotencyKeyHeader(req);
    const discountRequestId = assertValidUuid(rawDiscountRequestId, 'discount_request_id');
    const obj = assertPlainObject(rawBody, ['decision', 'decision_note', 'expected_version']);

    const decisionRaw =
      typeof obj.decision === 'string' ? obj.decision.trim().toUpperCase() : '';
    if (decisionRaw !== 'APPROVED' && decisionRaw !== 'REJECTED') {
      throw new ApiHttpException({
        statusCode: 400,
        errorCode: 'VALIDATION_ERROR',
        message: 'decision must be APPROVED or REJECTED',
      });
    }
    const decision = decisionRaw as DiscountDecision;

    let decisionNote: string | null = null;
    if (obj.decision_note !== undefined && obj.decision_note !== null) {
      if (typeof obj.decision_note !== 'string' || obj.decision_note.length > 500) {
        throw new ApiHttpException({
          statusCode: 400,
          errorCode: 'VALIDATION_ERROR',
          message: 'decision_note must be a string up to 500 characters',
        });
      }
      decisionNote = obj.decision_note.trim() || null;
    }

    const expectedVersion = resolveExpectedVersion(req, obj.expected_version);
    const requestId = req.requestId ?? resolveRequestId(req.headers['x-request-id']);
    const now = this.clock.now();
    const centerTodayDate = formatCenterLocalDate(now, this.config.centerTimezone);

    const outcome = await executeIdempotentOperation<DiscountRequestResponseDto>(
      this.databaseService,
      {
        centerId: principal.centerId,
        actorStaffId: principal.staffId,
        operationType: 'DECIDE_DISCOUNT_OR_GRANT_REQUEST',
        idempotencyKey,
        requestPayload: {
          discount_request_id: discountRequestId,
          decision,
          decision_note: decisionNote,
          expected_version: expectedVersion,
        },
        authorizeBeforeReplayOrExecute: async (tx) => {
          const staffCheck = await tx.query<{ role: string; status: string }>(
            `SELECT "role"::text AS role, "status"::text AS status
               FROM "staff_users"
              WHERE "id" = $1::uuid
                AND "center_id" = $2::uuid
              LIMIT 1`,
            [principal.staffId, principal.centerId],
          );
          if (
            !staffCheck.rows[0] ||
            staffCheck.rows[0].status !== 'ACTIVE' ||
            staffCheck.rows[0].role !== 'DIRECTOR'
          ) {
            throw new ApiHttpException({
              statusCode: 403,
              errorCode: 'FORBIDDEN_ROLE',
              message: 'Live DIRECTOR authorization required to decide discount requests',
            });
          }

          const reqCheck = await tx.query<{ id: string }>(
            `SELECT "id"::text AS id
               FROM "discount_requests"
              WHERE "id" = $1::uuid
                AND "center_id" = $2::uuid
              FOR UPDATE`,
            [discountRequestId, principal.centerId],
          );
          if (!reqCheck.rows[0]) {
            throw new ApiHttpException({
              statusCode: 404,
              errorCode: 'NOT_FOUND',
              message: 'Discount request not found in center scope',
            });
          }
        },
        handler: async (tx) => {
          const reqRes = await tx.query<{
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
            status: string;
            version: number;
          }>(
            `SELECT "id"::text AS id,
                    "student_id"::text AS student_id,
                    "enrollment_id"::text AS enrollment_id,
                    "target_invoice_id"::text AS target_invoice_id,
                    "discount_kind"::text AS discount_kind,
                    "percent_value"::text AS percent_value,
                    "fixed_amount_uzs"::text AS fixed_amount_uzs,
                    "reason",
                    "valid_from"::text AS valid_from,
                    "valid_until"::text AS valid_until,
                    "status"::text AS status,
                    "version"
               FROM "discount_requests"
              WHERE "id" = $1::uuid
                AND "center_id" = $2::uuid
              FOR UPDATE`,
            [discountRequestId, principal.centerId],
          );

          const discountReq = reqRes.rows[0];
          if (!discountReq) {
            throw new ApiHttpException({
              statusCode: 404,
              errorCode: 'NOT_FOUND',
              message: 'Discount request not found in center scope',
            });
          }

          if (discountReq.status !== 'PENDING_APPROVAL') {
            throw new ApiHttpException({
              statusCode: 409,
              errorCode: 'VERSION_CONFLICT',
              message: `Discount request is in status '${discountReq.status}' and cannot be decided again (T09.02)`,
            });
          }

          if (Number(discountReq.version) !== expectedVersion) {
            throw new ApiHttpException({
              statusCode: 409,
              errorCode: 'VERSION_CONFLICT',
              message: `DiscountRequest expected_version (${expectedVersion}) does not match current version (${discountReq.version})`,
            });
          }

          const validFrom = formatPgDate(discountReq.valid_from);
          const validUntil = formatPgDate(discountReq.valid_until);

          if (decision === 'REJECTED') {
            const updatedReq = await executeOptimisticUpdate<{ version: number }>(tx, {
              tableName: 'discount_requests',
              entityName: 'DiscountRequest',
              id: discountRequestId,
              centerId: principal.centerId,
              expectedVersion,
              setClauseSql: `"status" = 'REJECTED'`,
              additionalValues: [],
            });
            this.maybeInjectTestFault('DISCOUNT_REQUEST_UPDATE', options?.testFaultAfterStep);

            const approvalId = crypto.randomUUID();
            await tx.query(
              `INSERT INTO "discount_approvals" (
                 "id", "center_id", "discount_request_id", "decision",
                 "director_staff_id", "approval_channel", "applied_amount_uzs",
                 "decision_note", "policy_version_id", "discount_stacking_mode_snapshot",
                 "calculation_version", "decided_at"
               ) VALUES (
                 $1::uuid, $2::uuid, $3::uuid, 'REJECTED',
                 $4::uuid, 'STAFF_WEB', 0,
                 $5, NULL, 'UNCONFIGURED',
                 $6, $7::timestamptz
               )`,
              [
                approvalId,
                principal.centerId,
                discountRequestId,
                principal.staffId,
                decisionNote,
                ADJUSTMENTS_CALCULATION_VERSION,
                now.toISOString(),
              ],
            );
            this.maybeInjectTestFault('DISCOUNT_APPROVAL', options?.testFaultAfterStep);

            await tx.query(
              `INSERT INTO "audit_logs" (
                 "id", "center_id", "actor_type", "actor_id", "actor_role",
                 "action", "entity_type", "entity_id", "severity",
                 "before_redacted_json", "after_redacted_json", "request_id", "created_at"
               ) VALUES (
                 $1::uuid, $2::uuid, 'STAFF', $3::uuid, $4,
                 'DISCOUNT_REQUEST_REJECTED', 'DiscountRequest', $5::uuid, 'INFO',
                 $6::jsonb, $7::jsonb, $8, $9::timestamptz
               )`,
              [
                crypto.randomUUID(),
                principal.centerId,
                principal.staffId,
                principal.role,
                discountRequestId,
                JSON.stringify({ status: 'PENDING_APPROVAL', version: expectedVersion }),
                JSON.stringify({
                  status: 'REJECTED',
                  approval_id: approvalId,
                  applied_amount_uzs: '0',
                  version: Number(updatedReq.version),
                }),
                requestId,
                now.toISOString(),
              ],
            );

            const dto = await this.discountRequestsService.loadDiscountRequestResponseInTx(
              tx,
              principal.centerId,
              discountRequestId,
            );
            return {
              statusCode: 200,
              body: dto,
            };
          }

          // APPROVED flow:
          if (validUntil < centerTodayDate) {
            throw new ApiHttpException({
              statusCode: 422,
              errorCode: 'VALIDATION_ERROR',
              message: `Cannot approve expired discount request: valid_until (${validUntil}) < center today (${centerTodayDate}) (CASE-10 / T09.02)`,
            });
          }

          // Lock enrollment FOR UPDATE
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
            [discountReq.enrollment_id, principal.centerId],
          );
          const enrollment = enrRes.rows[0];
          if (!enrollment) {
            throw new ApiHttpException({
              statusCode: 404,
              errorCode: 'NOT_FOUND',
              message: 'Enrollment for discount request not found in center scope',
            });
          }
          if (enrollment.status === 'LEFT') {
            throw new ApiHttpException({
              statusCode: 422,
              errorCode: 'VALIDATION_ERROR',
              message: 'Cannot approve a discount request for a LEFT enrollment',
            });
          }

          // Load group billing_mode and optional bound policy
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

          // Resolve & lock target invoice FOR UPDATE
          const invQuerySql = discountReq.target_invoice_id
            ? `SELECT i."id"::text AS id,
                      i."student_id"::text AS student_id,
                      i."enrollment_id"::text AS enrollment_id,
                      i."base_pro_rata_charge_uzs"::text AS base_pro_rata_charge_uzs,
                      i."approved_discount_uzs"::text AS approved_discount_uzs,
                      i."credit_note_adjustments_uzs"::text AS credit_note_adjustments_uzs,
                      i."effective_net_charge_uzs"::text AS effective_net_charge_uzs,
                      i."allocated_paid_uzs"::text AS allocated_paid_uzs,
                      i."remaining_debt_uzs"::text AS remaining_debt_uzs,
                      i."frozen_credited_lessons",
                      i."status"::text AS status,
                      i."version",
                      bc."period_start_date"::text AS period_start_date,
                      bc."period_end_date"::text AS period_end_date
                 FROM "invoices" i
                 JOIN "billing_cycles" bc
                   ON bc."id" = i."billing_cycle_id"
                  AND bc."center_id" = i."center_id"
                WHERE i."id" = $1::uuid
                  AND i."center_id" = $2::uuid
                FOR UPDATE OF i`
            : `SELECT i."id"::text AS id,
                      i."student_id"::text AS student_id,
                      i."enrollment_id"::text AS enrollment_id,
                      i."base_pro_rata_charge_uzs"::text AS base_pro_rata_charge_uzs,
                      i."approved_discount_uzs"::text AS approved_discount_uzs,
                      i."credit_note_adjustments_uzs"::text AS credit_note_adjustments_uzs,
                      i."effective_net_charge_uzs"::text AS effective_net_charge_uzs,
                      i."allocated_paid_uzs"::text AS allocated_paid_uzs,
                      i."remaining_debt_uzs"::text AS remaining_debt_uzs,
                      i."frozen_credited_lessons",
                      i."status"::text AS status,
                      i."version",
                      bc."period_start_date"::text AS period_start_date,
                      bc."period_end_date"::text AS period_end_date
                 FROM "invoices" i
                 JOIN "billing_cycles" bc
                   ON bc."id" = i."billing_cycle_id"
                  AND bc."center_id" = i."center_id"
                WHERE i."enrollment_id" = $1::uuid
                  AND i."center_id" = $2::uuid
                  AND bc."period_start_date" >= $3::date
                  AND bc."period_start_date" <= $4::date
                ORDER BY i."issued_at" DESC, i."id" DESC
                LIMIT 1
                FOR UPDATE OF i`;

          const invParams = discountReq.target_invoice_id
            ? [discountReq.target_invoice_id, principal.centerId]
            : [enrollment.id, principal.centerId, validFrom, validUntil];

          const invRes = await tx.query<{
            id: string;
            student_id: string;
            enrollment_id: string;
            base_pro_rata_charge_uzs: string;
            approved_discount_uzs: string;
            credit_note_adjustments_uzs: string;
            effective_net_charge_uzs: string;
            allocated_paid_uzs: string;
            remaining_debt_uzs: string;
            frozen_credited_lessons: number;
            status: InvoiceStatus;
            version: number;
            period_start_date: unknown;
            period_end_date: unknown;
          }>(invQuerySql, invParams);

          const invoice = invRes.rows[0];
          if (!invoice) {
            throw new ApiHttpException({
              statusCode: 422,
              errorCode: 'VALIDATION_ERROR',
              message:
                'No target invoice exists for this enrollment within the discount validity window',
            });
          }

          if (
            invoice.enrollment_id !== enrollment.id ||
            invoice.student_id !== enrollment.student_id
          ) {
            throw new ApiHttpException({
              statusCode: 422,
              errorCode: 'VALIDATION_ERROR',
              message: 'Target invoice lineage does not match discount request enrollment',
            });
          }

          if (invoice.status === 'VOID_COMPENSATED') {
            throw new ApiHttpException({
              statusCode: 422,
              errorCode: 'VALIDATION_ERROR',
              message: 'Cannot apply discount to a VOID_COMPENSATED invoice',
            });
          }

          const periodStartDate = formatPgDate(invoice.period_start_date);
          const periodEndDate = invoice.period_end_date
            ? formatPgDate(invoice.period_end_date)
            : periodStartDate;

          if (validUntil < periodStartDate || validFrom > periodEndDate) {
            throw new ApiHttpException({
              statusCode: 422,
              errorCode: 'VALIDATION_ERROR',
              message: `Discount validity window ${validFrom}..${validUntil} does not cover invoice period ${periodStartDate}..${periodEndDate} (CASE-10)`,
            });
          }

          // OWNER-20261105-04: Resolve active confirmed S09 discount policy for this group and period!
          const policy = await this.policyService.resolveActiveDiscountPolicyForGroupPeriod(
            tx,
            principal.centerId,
            group.billing_mode,
            group.billing_policy_version_id,
            periodStartDate,
          );

          // Load existing approved discounts on this invoice in deterministic approval order
          const existingApprovedRes = await tx.query<{
            id: string;
            discount_kind: DiscountKind;
            percent_value: string | null;
            fixed_amount_uzs: string | null;
          }>(
            `SELECT dr."id"::text AS id,
                    dr."discount_kind"::text AS discount_kind,
                    dr."percent_value"::text AS percent_value,
                    dr."fixed_amount_uzs"::text AS fixed_amount_uzs
               FROM "discount_requests" dr
               JOIN "discount_approvals" da
                 ON da."discount_request_id" = dr."id"
                AND da."center_id" = dr."center_id"
              WHERE dr."center_id" = $1::uuid
                AND dr."target_invoice_id" = $2::uuid
                AND dr."status" = 'APPROVED'
                AND da."decision" = 'APPROVED'
              ORDER BY da."decided_at" ASC, dr."id" ASC`,
            [principal.centerId, invoice.id],
          );

          const existingApprovedItems: DiscountCalculationItem[] = existingApprovedRes.rows.map(
            (r) => ({
              requestId: r.id,
              discountKind: r.discount_kind,
              percentBasisPoints:
                r.percent_value !== null
                  ? parsePercentValueToBasisPoints(r.percent_value).basisPoints
                  : r.discount_kind === 'FULL_GRANT_100'
                    ? 10000
                    : null,
              fixedAmountUzs: r.fixed_amount_uzs !== null ? BigInt(r.fixed_amount_uzs) : null,
            }),
          );

          const candidateItem: DiscountCalculationItem = {
            requestId: discountReq.id,
            discountKind: discountReq.discount_kind,
            percentBasisPoints:
              discountReq.percent_value !== null
                ? parsePercentValueToBasisPoints(discountReq.percent_value).basisPoints
                : discountReq.discount_kind === 'FULL_GRANT_100'
                  ? 10000
                  : null,
            fixedAmountUzs:
              discountReq.fixed_amount_uzs !== null
                ? BigInt(discountReq.fixed_amount_uzs)
                : null,
          };

          const stackResult = calculateInvoiceDiscountStackUzs({
            baseChargeUzs: BigInt(invoice.base_pro_rata_charge_uzs),
            currentApprovedDiscountUzs: BigInt(invoice.approved_discount_uzs),
            stackingMode: policy.discount_stacking_mode,
            existingApprovedDiscounts: existingApprovedItems,
            candidateDiscount: candidateItem,
          });

          const creditNoteAdjustmentsUzs = BigInt(invoice.credit_note_adjustments_uzs);
          const allocatedPaidUzs = BigInt(invoice.allocated_paid_uzs);
          const frozenCreditedLessons = Number(invoice.frozen_credited_lessons);

          // 09.02 Safety Gate: If the invoice already has freeze credits issued, or if already-allocated
          // payments + credit notes exceed the new post-discount charge, fail closed with 403 POLICY_DECISION_NOT_CONFIRMED!
          if (
            frozenCreditedLessons > 0 ||
            creditNoteAdjustmentsUzs + allocatedPaidUzs >
              stackResult.resultingGrossAfterDiscountUzs
          ) {
            throw new ApiHttpException({
              statusCode: 403,
              errorCode: 'POLICY_DECISION_NOT_CONFIRMED',
              message:
                'Retroactive discount reducing charge below already allocated payments/credits or after freeze credit issuance is gated by unconfirmed reallocation/refund policy decisions (D14/D22 / 09.02)',
            });
          }

          const newEffectiveNetChargeUzs =
            stackResult.resultingGrossAfterDiscountUzs - creditNoteAdjustmentsUzs;
          const newRemainingDebtUzs = newEffectiveNetChargeUzs - allocatedPaidUzs;

          const newInvoiceStatus: InvoiceStatus =
            newEffectiveNetChargeUzs === 0n
              ? stackResult.newTotalApprovedDiscountUzs > 0n &&
                creditNoteAdjustmentsUzs === 0n
                ? 'GRANT_ZERO'
                : 'PAID'
              : allocatedPaidUzs > 0n
                ? 'PARTIALLY_PAID'
                : 'ISSUED_OPEN';

          // 1. Update discount_requests -> APPROVED
          const updatedReq = await executeOptimisticUpdate<{ version: number }>(tx, {
            tableName: 'discount_requests',
            entityName: 'DiscountRequest',
            id: discountRequestId,
            centerId: principal.centerId,
            expectedVersion,
            setClauseSql: `"status" = 'APPROVED', "target_invoice_id" = $4::uuid`,
            additionalValues: [invoice.id],
          });
          this.maybeInjectTestFault('DISCOUNT_REQUEST_UPDATE', options?.testFaultAfterStep);

          // 2. Insert discount_approvals
          const approvalId = crypto.randomUUID();
          await tx.query(
            `INSERT INTO "discount_approvals" (
               "id", "center_id", "discount_request_id", "decision",
               "director_staff_id", "approval_channel", "applied_amount_uzs",
               "decision_note", "policy_version_id", "discount_stacking_mode_snapshot",
               "calculation_version", "decided_at"
             ) VALUES (
               $1::uuid, $2::uuid, $3::uuid, 'APPROVED',
               $4::uuid, 'STAFF_WEB', $5::bigint,
               $6, $7::uuid, $8,
               $9, $10::timestamptz
             )`,
            [
              approvalId,
              principal.centerId,
              discountRequestId,
              principal.staffId,
              formatMoneyUzs(stackResult.appliedDeltaUzs),
              decisionNote,
              policy.id,
              stackResult.stackingMode,
              stackResult.calculationVersion,
              now.toISOString(),
            ],
          );
          this.maybeInjectTestFault('DISCOUNT_APPROVAL', options?.testFaultAfterStep);

          // 3. Optimistically update invoice balances
          await executeOptimisticUpdate<{ version: number }>(tx, {
            tableName: 'invoices',
            entityName: 'Invoice',
            id: invoice.id,
            centerId: principal.centerId,
            expectedVersion: Number(invoice.version),
            setClauseSql: `"approved_discount_uzs" = $4::bigint, "effective_net_charge_uzs" = $5::bigint, "remaining_debt_uzs" = $6::bigint, "status" = $7`,
            additionalValues: [
              formatMoneyUzs(stackResult.newTotalApprovedDiscountUzs),
              formatMoneyUzs(newEffectiveNetChargeUzs),
              formatMoneyUzs(newRemainingDebtUzs),
              newInvoiceStatus,
            ],
          });
          this.maybeInjectTestFault('INVOICE_UPDATE', options?.testFaultAfterStep);

          // 4. Insert InvoiceLine (APPROVED_DISCOUNT)
          await tx.query(
            `INSERT INTO "invoice_lines" (
               "id", "center_id", "invoice_id", "line_type",
               "description", "amount_uzs", "formula_snapshot", "created_at"
             ) VALUES (
               $1::uuid, $2::uuid, $3::uuid, 'APPROVED_DISCOUNT',
               $4, $5::bigint, $6, $7::timestamptz
             )`,
            [
              crypto.randomUUID(),
              principal.centerId,
              invoice.id,
              `Approved ${discountReq.discount_kind} (${discountReq.id}) under ${stackResult.stackingMode}`,
              stackResult.appliedDeltaUzs > 0n
                ? `-${formatMoneyUzs(stackResult.appliedDeltaUzs)}`
                : '0',
              stackResult.formulaSnapshot,
              now.toISOString(),
            ],
          );
          this.maybeInjectTestFault('INVOICE_LINE', options?.testFaultAfterStep);

          // 5. Insert LedgerEntry (DISCOUNT_APPLIED, direction = CREDIT, amount_uzs >= 0; never fake PAYMENT_RECEIVED/REFUND_PAID!)
          await tx.query(
            `INSERT INTO "ledger_entries" (
               "id", "center_id", "entry_type", "student_id", "invoice_id",
               "direction", "amount_uzs", "actor_type", "actor_staff_id",
               "system_job_name", "created_at"
             ) VALUES (
               $1::uuid, $2::uuid, 'DISCOUNT_APPLIED', $3::uuid, $4::uuid,
               'CREDIT', $5::bigint, 'STAFF', $6::uuid,
               NULL, $7::timestamptz
             )`,
            [
              crypto.randomUUID(),
              principal.centerId,
              invoice.student_id,
              invoice.id,
              formatMoneyUzs(stackResult.appliedDeltaUzs),
              principal.staffId,
              now.toISOString(),
            ],
          );
          this.maybeInjectTestFault('LEDGER_ENTRY', options?.testFaultAfterStep);

          // 6. Insert AuditLog
          await tx.query(
            `INSERT INTO "audit_logs" (
               "id", "center_id", "actor_type", "actor_id", "actor_role",
               "action", "entity_type", "entity_id", "severity",
               "before_redacted_json", "after_redacted_json", "request_id", "created_at"
             ) VALUES (
               $1::uuid, $2::uuid, 'STAFF', $3::uuid, $4,
               'DISCOUNT_REQUEST_APPROVED', 'DiscountRequest', $5::uuid, 'INFO',
               $6::jsonb, $7::jsonb, $8, $9::timestamptz
             )`,
            [
              crypto.randomUUID(),
              principal.centerId,
              principal.staffId,
              principal.role,
              discountRequestId,
              JSON.stringify({
                status: 'PENDING_APPROVAL',
                invoice_approved_discount_uzs: invoice.approved_discount_uzs,
                invoice_effective_net_charge_uzs: invoice.effective_net_charge_uzs,
                invoice_remaining_debt_uzs: invoice.remaining_debt_uzs,
              }),
              JSON.stringify({
                status: 'APPROVED',
                approval_id: approvalId,
                target_invoice_id: invoice.id,
                discount_kind: discountReq.discount_kind,
                applied_amount_uzs: formatMoneyUzs(stackResult.appliedDeltaUzs),
                new_approved_discount_uzs: formatMoneyUzs(
                  stackResult.newTotalApprovedDiscountUzs,
                ),
                new_effective_net_charge_uzs: formatMoneyUzs(newEffectiveNetChargeUzs),
                new_remaining_debt_uzs: formatMoneyUzs(newRemainingDebtUzs),
                new_invoice_status: newInvoiceStatus,
                policy_version_id: policy.id,
                discount_stacking_mode: stackResult.stackingMode,
                calculation_version: stackResult.calculationVersion,
              }),
              requestId,
              now.toISOString(),
            ],
          );
          this.maybeInjectTestFault('AUDIT_LOG', options?.testFaultAfterStep);

          // 7. Insert canonical DiscountApproved v1 OutboxEvent (docs/architecture/events.md#evt-DiscountApproved)
          const updatedReqVersion = Number(updatedReq.version);
          await tx.query(
            `INSERT INTO "outbox_events" (
               "id", "center_id", "event_name", "schema_version",
               "aggregate_type", "aggregate_id", "aggregate_version",
               "dedup_key", "payload_json", "status",
               "next_attempt_at", "occurred_at_utc", "updated_at"
             ) VALUES (
               $1::uuid, $2::uuid, 'DiscountApproved', 1,
               'DiscountRequest', $3::uuid, $4::int,
               $5, $6::jsonb, 'PENDING',
               $7::timestamptz, $7::timestamptz, $7::timestamptz
             )`,
            [
              crypto.randomUUID(),
              principal.centerId,
              discountRequestId,
              updatedReqVersion,
              `DiscountApproved:${discountRequestId}:v${updatedReqVersion}`,
              JSON.stringify({
                discount_request_id: discountRequestId,
                approval_id: approvalId,
                enrollment_id: enrollment.id,
                target_invoice_id: invoice.id,
                discount_kind: discountReq.discount_kind,
                applied_amount_uzs: formatMoneyUzs(stackResult.appliedDeltaUzs),
                new_effective_net_charge_uzs: formatMoneyUzs(newEffectiveNetChargeUzs),
                director_staff_id: principal.staffId,
                approval_channel: 'STAFF_WEB',
              }),
              now.toISOString(),
            ],
          );
          this.maybeInjectTestFault('OUTBOX_EVENT', options?.testFaultAfterStep);

          const dto = await this.discountRequestsService.loadDiscountRequestResponseInTx(
            tx,
            principal.centerId,
            discountRequestId,
          );
          return {
            statusCode: 200,
            body: dto,
          };
        },
      },
    );

    return outcome.body;
  }
}
