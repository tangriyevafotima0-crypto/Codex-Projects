/**
 * EduERP v2.0 — Stage 10, Step 10.03 (`T10.03`, `BR-07`, `CASE-13`, `CASE-14`, `OWNER-20261105-05`):
 * Reason-Required Payment Correction / Reversal / Refund Request (`PENDING_DIRECTOR_APPROVAL`),
 * Immediate Director Red-Alert Outbox Notification, Director-Only Approval (`APPROVED_EXECUTED` / `REJECTED`),
 * Append-Only `ReversalOrRefundExecution` + `PaymentAllocationReversal` + `LedgerEntry`,
 * Exact Invoice Debt Restoration, and Partial Reversal Cap Enforcement.
 */

import { Inject, Injectable } from '@nestjs/common';
import type {
  CashShiftStatus,
  DebtEffectPolicy,
  InvoiceStatus,
  PaymentMethod,
  ReversalOrRefundKind,
  ReversalOrRefundStatus,
} from '@eduerp/contracts';
import * as crypto from 'node:crypto';
import { ApiHttpException } from '../auth/auth.errors';
import { ClockService } from '../auth/clock.service';
import { AuthenticatedStaffPrincipal } from '../auth/permissions.guard';
import { requireIdempotencyKeyHeader } from '../auth/validation';
import { RequestWithCorrelationId, resolveRequestId } from '../common/request-id.middleware';
import { ApiEnvConfig } from '../config/env';
import { API_CONFIG_TOKEN } from '../config/tokens';
import { DatabaseService } from '../database/database.service';
import { executeIdempotentOperation } from '../database/idempotency';
import {
  formatMoneyUzs,
  parseNonNegativeMoneyUzs,
  parsePositiveMoneyUzs,
} from '../database/money';
import { executeOptimisticUpdate, TransactionContext } from '../database/transaction';
import {
  ReversalExecutionResponseDto,
  ReversalFaultInjectionStep,
  ReversalOrRefundResponseDto,
  validateApproveReversalInput,
  validateCreateReversalInput,
} from './dto';

export interface ReversalAllocationCandidate {
  readonly allocationId: string;
  readonly invoiceId: string;
  readonly enrollmentId: string;
  readonly allocatedAmountUzs: bigint;
  readonly alreadyReversedOnAllocationUzs: bigint;
  readonly invoiceEffectiveNetChargeUzs: bigint;
  readonly invoiceAllocatedPaidUzs: bigint;
  readonly invoiceRemainingDebtUzs: bigint;
  readonly invoiceVersion: number;
}

export interface PlannedAllocationReversalItem {
  readonly originalAllocationId: string;
  readonly invoiceId: string;
  readonly enrollmentId: string;
  readonly reversedAmountUzs: bigint;
  readonly newInvoiceAllocatedPaidUzs: bigint;
  readonly newInvoiceRemainingDebtUzs: bigint;
  readonly newInvoiceStatus: InvoiceStatus;
  readonly expectedInvoiceVersion: number;
}

export interface PaymentReversalUnwindPlanResult {
  readonly originalPaymentAmountUzs: bigint;
  readonly alreadyReversedTotalUzs: bigint;
  readonly remainingReversibleBeforeUzs: bigint;
  readonly requestedReversalUzs: bigint;
  readonly remainingReversibleAfterUzs: bigint;
  readonly unappliedCreditReductionUzs: bigint;
  readonly newUnappliedRemainingCreditUzs: bigint;
  readonly totalInvoiceDebtRestoredUzs: bigint;
  readonly plannedAllocationReversals: readonly PlannedAllocationReversalItem[];
}

/**
 * Pure deterministic calculator for Stage 10 (`10.03`, `BR-07`, `CASE-13`, `CASE-14`, `OWNER-20261105-05`) payment reversals:
 * - Enforces `debtEffectPolicy === 'REOPEN_INVOICE_DEBT'` (`CLOSE_WITH_CREDIT_NOTE` fails closed with `403 POLICY_DECISION_NOT_CONFIRMED`).
 * - Enforces cumulative cap: `alreadyReversedTotalUzs + requestedReversalUzs <= originalPaymentAmountUzs` (`422 REFUND_CAP_EXCEEDED`).
 * - Unwinds unconsumed `UnappliedCredit` first, then reverses `PaymentAllocation` rows in reverse chronological order,
 *   restoring invoice `remaining_debt_uzs` by the exact reversed allocation amount (`CASE-13`, `CASE-14`).
 */
export function planPaymentReversalUnwind(params: {
  readonly kind: ReversalOrRefundKind;
  readonly debtEffectPolicy: string;
  readonly originalPaymentAmountUzs: bigint | string;
  readonly alreadyReversedTotalUzs: bigint | string;
  readonly requestedReversalUzs: bigint | string;
  readonly currentUnappliedCreditUzs: bigint | string;
  readonly allocationsInReverseOrder: readonly ReversalAllocationCandidate[];
}): PaymentReversalUnwindPlanResult {
  const policyRaw = params.debtEffectPolicy.trim().toUpperCase();
  if (policyRaw !== 'REOPEN_INVOICE_DEBT') {
    throw new ApiHttpException({
      statusCode: 403,
      errorCode: 'POLICY_DECISION_NOT_CONFIRMED',
      message: `Debt effect policy '${params.debtEffectPolicy}' is not confirmed under OWNER-20261105-05 (D22 service-cancellation credit-note refund remains gated)`,
    });
  }

  const originalPaymentAmountUzs = parsePositiveMoneyUzs(
    params.originalPaymentAmountUzs,
    'originalPaymentAmountUzs',
  );
  const alreadyReversedTotalUzs = parseNonNegativeMoneyUzs(
    params.alreadyReversedTotalUzs,
    'alreadyReversedTotalUzs',
  );
  const requestedReversalUzs = parsePositiveMoneyUzs(
    params.requestedReversalUzs,
    'requestedReversalUzs',
  );
  const currentUnappliedCreditUzs = parseNonNegativeMoneyUzs(
    params.currentUnappliedCreditUzs,
    'currentUnappliedCreditUzs',
  );

  const remainingReversibleBeforeUzs =
    originalPaymentAmountUzs > alreadyReversedTotalUzs
      ? originalPaymentAmountUzs - alreadyReversedTotalUzs
      : 0n;

  if (requestedReversalUzs > remainingReversibleBeforeUzs) {
    throw new ApiHttpException({
      statusCode: 422,
      errorCode: 'REFUND_CAP_EXCEEDED',
      message: `Requested reversal amount (${formatMoneyUzs(requestedReversalUzs)} UZS) exceeds remaining reversible balance (${formatMoneyUzs(remainingReversibleBeforeUzs)} UZS) on original payment (${formatMoneyUzs(originalPaymentAmountUzs)} UZS) (CASE-14 / T10.03)`,
    });
  }

  if (
    params.kind === 'FULL_REFUND' &&
    (alreadyReversedTotalUzs > 0n || requestedReversalUzs !== originalPaymentAmountUzs)
  ) {
    throw new ApiHttpException({
      statusCode: 422,
      errorCode: 'VALIDATION_ERROR',
      message: `FULL_REFUND requires amount_uzs (${formatMoneyUzs(requestedReversalUzs)}) to equal full unreversed original payment amount (${formatMoneyUzs(originalPaymentAmountUzs)})`,
    });
  }

  let remainingToUnwind = requestedReversalUzs;

  const unappliedCreditReductionUzs =
    remainingToUnwind <= currentUnappliedCreditUzs
      ? remainingToUnwind
      : currentUnappliedCreditUzs;
  const newUnappliedRemainingCreditUzs =
    currentUnappliedCreditUzs - unappliedCreditReductionUzs;
  remainingToUnwind -= unappliedCreditReductionUzs;

  const plannedAllocationReversals: PlannedAllocationReversalItem[] = [];
  let totalInvoiceDebtRestoredUzs = 0n;

  for (const alloc of params.allocationsInReverseOrder) {
    if (remainingToUnwind <= 0n) {
      break;
    }
    const allocReversible =
      alloc.allocatedAmountUzs > alloc.alreadyReversedOnAllocationUzs
        ? alloc.allocatedAmountUzs - alloc.alreadyReversedOnAllocationUzs
        : 0n;
    if (allocReversible <= 0n) {
      continue;
    }

    const revAmount =
      remainingToUnwind <= allocReversible ? remainingToUnwind : allocReversible;
    const newInvoiceAllocatedPaidUzs =
      alloc.invoiceAllocatedPaidUzs >= revAmount
        ? alloc.invoiceAllocatedPaidUzs - revAmount
        : 0n;
    const newInvoiceRemainingDebtUzs =
      alloc.invoiceEffectiveNetChargeUzs > newInvoiceAllocatedPaidUzs
        ? alloc.invoiceEffectiveNetChargeUzs - newInvoiceAllocatedPaidUzs
        : 0n;
    const newInvoiceStatus: InvoiceStatus =
      alloc.invoiceEffectiveNetChargeUzs === 0n
        ? 'GRANT_ZERO'
        : newInvoiceRemainingDebtUzs === 0n
          ? 'PAID'
          : newInvoiceAllocatedPaidUzs > 0n
            ? 'PARTIALLY_PAID'
            : 'ISSUED_OPEN';

    plannedAllocationReversals.push(
      Object.freeze({
        originalAllocationId: alloc.allocationId,
        invoiceId: alloc.invoiceId,
        enrollmentId: alloc.enrollmentId,
        reversedAmountUzs: revAmount,
        newInvoiceAllocatedPaidUzs,
        newInvoiceRemainingDebtUzs,
        newInvoiceStatus,
        expectedInvoiceVersion: alloc.invoiceVersion,
      }),
    );

    totalInvoiceDebtRestoredUzs += revAmount;
    remainingToUnwind -= revAmount;
  }

  if (remainingToUnwind > 0n) {
    throw new ApiHttpException({
      statusCode: 422,
      errorCode: 'REFUND_CAP_EXCEEDED',
      message: `Cannot reverse ${formatMoneyUzs(requestedReversalUzs)} UZS because ${formatMoneyUzs(remainingToUnwind)} UZS of unapplied credit from the original payment was already consumed`,
    });
  }

  return Object.freeze({
    originalPaymentAmountUzs,
    alreadyReversedTotalUzs,
    remainingReversibleBeforeUzs,
    requestedReversalUzs,
    remainingReversibleAfterUzs: remainingReversibleBeforeUzs - requestedReversalUzs,
    unappliedCreditReductionUzs,
    newUnappliedRemainingCreditUzs,
    totalInvoiceDebtRestoredUzs,
    plannedAllocationReversals: Object.freeze(plannedAllocationReversals),
  });
}

@Injectable()
export class ReversalService {
  constructor(
    @Inject(API_CONFIG_TOKEN) private readonly config: ApiEnvConfig,
    @Inject(DatabaseService) private readonly databaseService: DatabaseService,
    @Inject(ClockService) private readonly clock: ClockService,
  ) {}

  private maybeInjectTestFault(
    targetStep: ReversalFaultInjectionStep,
    configuredFault?: ReversalFaultInjectionStep,
  ): void {
    if (this.config.nodeEnv === 'test' && configuredFault === targetStep) {
      throw new Error(`SIMULATED_S10_REVERSAL_FAULT_AFTER_${targetStep}`);
    }
  }

  private async readReversalResponseDto(
    tx: TransactionContext,
    centerId: string,
    requestId: string,
  ): Promise<ReversalOrRefundResponseDto> {
    const reqRes = await tx.query<{
      id: string;
      original_payment_id: string;
      kind: ReversalOrRefundKind;
      amount_uzs: string;
      refund_method: PaymentMethod;
      debt_effect_policy: DebtEffectPolicy;
      reason: string;
      requested_by_admin_id: string;
      status: ReversalOrRefundStatus;
      decided_by_director_id: string | null;
      decision_note: string | null;
      red_alert_sent_at: Date | null;
      version: number;
    }>(
      `SELECT "id"::text AS id,
              "original_payment_id"::text AS original_payment_id,
              "kind"::text AS kind,
              "amount_uzs"::text AS amount_uzs,
              "refund_method"::text AS refund_method,
              "debt_effect_policy"::text AS debt_effect_policy,
              "reason",
              "requested_by_admin_id"::text AS requested_by_admin_id,
              "status"::text AS status,
              "decided_by_director_id"::text AS decided_by_director_id,
              "decision_note",
              "red_alert_sent_at",
              "version"
         FROM "reversal_or_refund_requests"
        WHERE "id" = $1::uuid
          AND "center_id" = $2::uuid
        LIMIT 1`,
      [requestId, centerId],
    );

    const row = reqRes.rows[0];
    if (!row) {
      throw new ApiHttpException({
        statusCode: 404,
        errorCode: 'NOT_FOUND',
        message: 'Reversal or refund request not found in center scope',
      });
    }

    let executionDto: ReversalExecutionResponseDto | null = null;
    if (row.status === 'APPROVED_EXECUTED') {
      const execRes = await tx.query<{
        id: string;
        request_id: string;
        original_payment_id: string;
        cash_shift_id: string | null;
        kind: ReversalOrRefundKind;
        amount_uzs: string;
        refund_method: PaymentMethod;
        debt_effect_policy: DebtEffectPolicy;
        approved_by_director_id: string;
        compensation_credit_note_id: string | null;
        executed_at: Date;
      }>(
        `SELECT "id"::text AS id,
                "request_id"::text AS request_id,
                "original_payment_id"::text AS original_payment_id,
                "cash_shift_id"::text AS cash_shift_id,
                "kind"::text AS kind,
                "amount_uzs"::text AS amount_uzs,
                "refund_method"::text AS refund_method,
                "debt_effect_policy"::text AS debt_effect_policy,
                "approved_by_director_id"::text AS approved_by_director_id,
                "compensation_credit_note_id"::text AS compensation_credit_note_id,
                "executed_at"
           FROM "reversal_or_refund_executions"
          WHERE "request_id" = $1::uuid
            AND "center_id" = $2::uuid
          LIMIT 1`,
        [requestId, centerId],
      );

      const ex = execRes.rows[0];
      if (ex) {
        const revIdsRes = await tx.query<{ id: string }>(
          `SELECT "id"::text AS id
             FROM "payment_allocation_reversals"
            WHERE "reversal_execution_id" = $1::uuid
              AND "center_id" = $2::uuid
            ORDER BY "created_at" ASC, "id" ASC`,
          [ex.id, centerId],
        );

        executionDto = Object.freeze({
          execution_id: ex.id,
          request_id: ex.request_id,
          original_payment_id: ex.original_payment_id,
          cash_shift_id: ex.cash_shift_id,
          kind: ex.kind,
          amount_uzs: BigInt(ex.amount_uzs).toString(10),
          refund_method: ex.refund_method,
          debt_effect_policy: ex.debt_effect_policy,
          approved_by_director_id: ex.approved_by_director_id,
          allocation_reversal_ids: Object.freeze(revIdsRes.rows.map((r) => r.id)),
          compensation_credit_note_id: ex.compensation_credit_note_id,
          executed_at: new Date(ex.executed_at).toISOString(),
        });
      }
    }

    return Object.freeze({
      request_id: row.id,
      original_payment_id: row.original_payment_id,
      kind: row.kind,
      amount_uzs: BigInt(row.amount_uzs).toString(10),
      refund_method: row.refund_method,
      debt_effect_policy: row.debt_effect_policy,
      reason: row.reason,
      requested_by_admin_id: row.requested_by_admin_id,
      decided_by_director_id: row.decided_by_director_id,
      decision_note: row.decision_note,
      red_alert_sent_at: row.red_alert_sent_at
        ? new Date(row.red_alert_sent_at).toISOString()
        : null,
      status: row.status,
      version: Number(row.version),
      execution: executionDto,
    });
  }

  /**
   * Creates a reason-required payment reversal/refund request (`POST /api/v1/payments/reversals` — `10.03`).
   * Makes zero changes to `Payment`, `Invoice`, `UnappliedCredit`, `CashShift`, or `LedgerEntry` until Director approval.
   */
  public async requestPaymentReversalOrRefund(
    req: RequestWithCorrelationId,
    principal: AuthenticatedStaffPrincipal,
    rawBody: unknown,
    options?: { readonly testFaultAfterStep?: ReversalFaultInjectionStep },
  ): Promise<ReversalOrRefundResponseDto> {
    if (principal.role !== 'DIRECTOR' && principal.role !== 'ADMIN') {
      throw new ApiHttpException({
        statusCode: 403,
        errorCode: 'FORBIDDEN_ROLE',
        message: 'Only DIRECTOR and ADMIN are permitted to request payment reversals (T10.03)',
      });
    }

    const idempotencyKey = requireIdempotencyKeyHeader(req);
    const requestId = req.requestId ?? resolveRequestId(req.headers['x-request-id']);
    const nowUtc = this.clock.now();
    const parsed = validateCreateReversalInput(rawBody);

    const idemPayload = {
      original_payment_id: parsed.originalPaymentId,
      kind: parsed.kind,
      amount_uzs: formatMoneyUzs(parsed.amountUzs),
      refund_method: parsed.refundMethod,
      debt_effect_policy: parsed.debtEffectPolicy,
      reason: parsed.reason,
    };

    const idemOutcome = await executeIdempotentOperation<ReversalOrRefundResponseDto>(
      this.databaseService,
      {
        centerId: principal.centerId,
        actorStaffId: principal.staffId,
        operationType: 'REQUEST_PAYMENT_REVERSAL_OR_REFUND',
        idempotencyKey,
        requestPayload: idemPayload,
        authorizeBeforeReplayOrExecute: async (tx: TransactionContext) => {
          const staffRes = await tx.query<{ role: string; status: string }>(
            `SELECT "role"::text AS role, "status"::text AS status
               FROM "staff_users"
              WHERE "id" = $1::uuid
                AND "center_id" = $2::uuid
              LIMIT 1`,
            [principal.staffId, principal.centerId],
          );
          const staffRow = staffRes.rows[0];
          if (!staffRow || staffRow.status !== 'ACTIVE') {
            throw new ApiHttpException({
              statusCode: 401,
              errorCode: 'UNAUTHORIZED',
              message: 'Staff user is no longer active',
            });
          }
          if (staffRow.role !== 'DIRECTOR' && staffRow.role !== 'ADMIN') {
            throw new ApiHttpException({
              statusCode: 403,
              errorCode: 'FORBIDDEN_ROLE',
              message: 'Only DIRECTOR and ADMIN are permitted to request payment reversals',
            });
          }

          // Note L45: Never issue FOR UPDATE on immutable `payments` table!
          // Read payment and lock the mutable owner `students` row + advisory lock on (centerId, originalPaymentId).
          await tx.query(
            `SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`,
            [principal.centerId, parsed.originalPaymentId],
          );

          const payRes = await tx.query<{
            id: string;
            student_id: string;
            amount_uzs: string;
          }>(
            `SELECT "id"::text AS id,
                    "student_id"::text AS student_id,
                    "amount_uzs"::text AS amount_uzs
               FROM "payments"
              WHERE "id" = $1::uuid
                AND "center_id" = $2::uuid
              LIMIT 1`,
            [parsed.originalPaymentId, principal.centerId],
          );
          const paymentRow = payRes.rows[0];
          if (!paymentRow) {
            throw new ApiHttpException({
              statusCode: 404,
              errorCode: 'NOT_FOUND',
              message: 'Original payment not found in center scope',
            });
          }

          await tx.query(
            `SELECT "id"::text AS id
               FROM "students"
              WHERE "id" = $1::uuid
                AND "center_id" = $2::uuid
              FOR UPDATE`,
            [paymentRow.student_id, principal.centerId],
          );
        },
        handler: async (tx: TransactionContext) => {
          const payRes = await tx.query<{
            id: string;
            student_id: string;
            amount_uzs: string;
            payment_method: PaymentMethod;
          }>(
            `SELECT "id"::text AS id,
                    "student_id"::text AS student_id,
                    "amount_uzs"::text AS amount_uzs,
                    "payment_method"::text AS payment_method
               FROM "payments"
              WHERE "id" = $1::uuid
                AND "center_id" = $2::uuid
              LIMIT 1`,
            [parsed.originalPaymentId, principal.centerId],
          );
          const payment = payRes.rows[0]!;
          const originalAmountUzs = BigInt(payment.amount_uzs);

          const execSumRes = await tx.query<{ reversed_sum: string }>(
            `SELECT COALESCE(SUM("amount_uzs"), 0)::text AS reversed_sum
               FROM "reversal_or_refund_executions"
              WHERE "center_id" = $1::uuid
                AND "original_payment_id" = $2::uuid`,
            [principal.centerId, parsed.originalPaymentId],
          );
          const alreadyReversedUzs = BigInt(execSumRes.rows[0]?.reversed_sum ?? '0');
          const remainingReversibleUzs =
            originalAmountUzs > alreadyReversedUzs
              ? originalAmountUzs - alreadyReversedUzs
              : 0n;

          if (parsed.amountUzs > remainingReversibleUzs) {
            throw new ApiHttpException({
              statusCode: 422,
              errorCode: 'REFUND_CAP_EXCEEDED',
              message: `Requested reversal amount (${formatMoneyUzs(parsed.amountUzs)} UZS) exceeds remaining reversible balance (${formatMoneyUzs(remainingReversibleUzs)} UZS) on original payment (${formatMoneyUzs(originalAmountUzs)} UZS) (CASE-14 / T10.03)`,
            });
          }

          if (
            parsed.kind === 'FULL_REFUND' &&
            (alreadyReversedUzs > 0n || parsed.amountUzs !== originalAmountUzs)
          ) {
            throw new ApiHttpException({
              statusCode: 422,
              errorCode: 'VALIDATION_ERROR',
              message: `FULL_REFUND requires amount_uzs (${formatMoneyUzs(parsed.amountUzs)}) to equal full unreversed original payment amount (${formatMoneyUzs(originalAmountUzs)})`,
            });
          }

          const reversalRequestId = crypto.randomUUID();
          await tx.query(
            `INSERT INTO "reversal_or_refund_requests" (
               "id",
               "center_id",
               "original_payment_id",
               "kind",
               "amount_uzs",
               "refund_method",
               "debt_effect_policy",
               "reason",
               "requested_by_admin_id",
               "status",
               "decided_by_director_id",
               "decision_note",
               "red_alert_sent_at",
               "version",
               "created_at",
               "updated_at"
             ) VALUES (
               $1::uuid,
               $2::uuid,
               $3::uuid,
               $4,
               $5::bigint,
               $6,
               $7,
               $8,
               $9::uuid,
               'PENDING_DIRECTOR_APPROVAL',
               NULL,
               NULL,
               $10::timestamptz,
               1,
               $10::timestamptz,
               $10::timestamptz
             )`,
            [
              reversalRequestId,
              principal.centerId,
              parsed.originalPaymentId,
              parsed.kind,
              formatMoneyUzs(parsed.amountUzs),
              parsed.refundMethod,
              parsed.debtEffectPolicy,
              parsed.reason,
              principal.staffId,
              nowUtc.toISOString(),
            ],
          );

          this.maybeInjectTestFault('REQUEST_UPDATE', options?.testFaultAfterStep);

          const auditId = crypto.randomUUID();
          await tx.query(
            `INSERT INTO "audit_logs" (
               "id",
               "center_id",
               "actor_type",
               "actor_id",
               "actor_role",
               "action",
               "entity_type",
               "entity_id",
               "severity",
               "before_redacted_json",
               "after_redacted_json",
               "request_id",
               "created_at"
             ) VALUES (
               $1::uuid,
               $2::uuid,
               'STAFF',
               $3::uuid,
               $4,
               'PAYMENT_REVERSAL_REQUESTED',
               'ReversalOrRefundRequest',
               $5::uuid,
               'CRITICAL_RED',
               NULL,
               $6::jsonb,
               $7,
               $8::timestamptz
             )`,
            [
              auditId,
              principal.centerId,
              principal.staffId,
              principal.role,
              reversalRequestId,
              JSON.stringify({
                request_id: reversalRequestId,
                original_payment_id: parsed.originalPaymentId,
                student_id: payment.student_id,
                kind: parsed.kind,
                amount_uzs: formatMoneyUzs(parsed.amountUzs),
                refund_method: parsed.refundMethod,
                debt_effect_policy: parsed.debtEffectPolicy,
                reason: parsed.reason,
                status: 'PENDING_DIRECTOR_APPROVAL',
              }),
              requestId,
              nowUtc.toISOString(),
            ],
          );

          this.maybeInjectTestFault('AUDIT_LOG', options?.testFaultAfterStep);

          const outboxId = crypto.randomUUID();
          await tx.query(
            `INSERT INTO "outbox_events" (
               "id",
               "center_id",
               "event_name",
               "schema_version",
               "aggregate_type",
               "aggregate_id",
               "aggregate_version",
               "dedup_key",
               "payload_json",
               "status",
               "lease_token",
               "occurred_at_utc",
               "next_attempt_at",
               "updated_at"
             ) VALUES (
               $1::uuid,
               $2::uuid,
               'RefundRecorded',
               1,
               'ReversalOrRefundRequest',
               $3::uuid,
               1,
               $4,
               $5::jsonb,
               'PENDING',
               0,
               $6::timestamptz,
               $6::timestamptz,
               $6::timestamptz
             )`,
            [
              outboxId,
              principal.centerId,
              reversalRequestId,
              `RefundRecorded:${reversalRequestId}:v1`,
              JSON.stringify({
                request_id: reversalRequestId,
                execution_id: null,
                original_payment_id: parsed.originalPaymentId,
                student_id: payment.student_id,
                kind: parsed.kind,
                amount_uzs: formatMoneyUzs(parsed.amountUzs),
                refund_method: parsed.refundMethod,
                debt_effect_policy: parsed.debtEffectPolicy,
                status: 'PENDING_DIRECTOR_APPROVAL',
                requested_by_admin_id: principal.staffId,
                approved_by_director_id: null,
              }),
              nowUtc.toISOString(),
            ],
          );

          this.maybeInjectTestFault('OUTBOX_EVENT', options?.testFaultAfterStep);

          const responseDto = await this.readReversalResponseDto(
            tx,
            principal.centerId,
            reversalRequestId,
          );
          return {
            statusCode: 201,
            body: responseDto,
          };
        },
      },
    );

    return idemOutcome.body;
  }

  /**
   * Director-only approval or rejection of a payment reversal/refund request
   * (`POST /api/v1/payments/reversals/{reversal_id}/decision` — `10.03`).
   */
  public async decidePaymentReversalOrRefund(
    req: RequestWithCorrelationId,
    principal: AuthenticatedStaffPrincipal,
    rawReversalId: unknown,
    rawBody: unknown,
    options?: { readonly testFaultAfterStep?: ReversalFaultInjectionStep },
  ): Promise<ReversalOrRefundResponseDto> {
    if (principal.role !== 'DIRECTOR') {
      throw new ApiHttpException({
        statusCode: 403,
        errorCode: 'FORBIDDEN_ROLE',
        message: 'Only DIRECTOR is permitted to approve or reject payment reversals (T10.03)',
      });
    }

    const idempotencyKey = requireIdempotencyKeyHeader(req);
    const requestId = req.requestId ?? resolveRequestId(req.headers['x-request-id']);
    const nowUtc = this.clock.now();
    const parsed = validateApproveReversalInput(req, rawReversalId, rawBody);

    const idemPayload = {
      reversal_id: parsed.reversalId,
      decision: parsed.decision,
      debt_effect_policy: parsed.debtEffectPolicy,
      cash_shift_id: parsed.cashShiftId,
      decision_note: parsed.decisionNote,
      expected_version: parsed.expectedVersion,
    };

    const idemOutcome = await executeIdempotentOperation<ReversalOrRefundResponseDto>(
      this.databaseService,
      {
        centerId: principal.centerId,
        actorStaffId: principal.staffId,
        operationType: 'DECIDE_PAYMENT_REVERSAL_OR_REFUND',
        idempotencyKey,
        requestPayload: idemPayload,
        authorizeBeforeReplayOrExecute: async (tx: TransactionContext) => {
          const staffRes = await tx.query<{ role: string; status: string }>(
            `SELECT "role"::text AS role, "status"::text AS status
               FROM "staff_users"
              WHERE "id" = $1::uuid
                AND "center_id" = $2::uuid
              LIMIT 1`,
            [principal.staffId, principal.centerId],
          );
          const staffRow = staffRes.rows[0];
          if (!staffRow || staffRow.status !== 'ACTIVE') {
            throw new ApiHttpException({
              statusCode: 401,
              errorCode: 'UNAUTHORIZED',
              message: 'Staff user is no longer active',
            });
          }
          if (staffRow.role !== 'DIRECTOR') {
            throw new ApiHttpException({
              statusCode: 403,
              errorCode: 'FORBIDDEN_ROLE',
              message: 'Only DIRECTOR is permitted to approve or reject payment reversals',
            });
          }

          const reqCheck = await tx.query<{
            id: string;
            original_payment_id: string;
          }>(
            `SELECT "id"::text AS id,
                    "original_payment_id"::text AS original_payment_id
               FROM "reversal_or_refund_requests"
              WHERE "id" = $1::uuid
                AND "center_id" = $2::uuid
              FOR UPDATE`,
            [parsed.reversalId, principal.centerId],
          );
          const reqRow = reqCheck.rows[0];
          if (!reqRow) {
            throw new ApiHttpException({
              statusCode: 404,
              errorCode: 'NOT_FOUND',
              message: 'Reversal or refund request not found in center scope',
            });
          }

          await tx.query(
            `SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`,
            [principal.centerId, reqRow.original_payment_id],
          );
        },
        handler: async (tx: TransactionContext) => {
          const reqRes = await tx.query<{
            id: string;
            original_payment_id: string;
            kind: ReversalOrRefundKind;
            amount_uzs: string;
            refund_method: PaymentMethod;
            debt_effect_policy: DebtEffectPolicy;
            reason: string;
            requested_by_admin_id: string;
            status: ReversalOrRefundStatus;
            version: number;
          }>(
            `SELECT "id"::text AS id,
                    "original_payment_id"::text AS original_payment_id,
                    "kind"::text AS kind,
                    "amount_uzs"::text AS amount_uzs,
                    "refund_method"::text AS refund_method,
                    "debt_effect_policy"::text AS debt_effect_policy,
                    "reason",
                    "requested_by_admin_id"::text AS requested_by_admin_id,
                    "status"::text AS status,
                    "version"
               FROM "reversal_or_refund_requests"
              WHERE "id" = $1::uuid
                AND "center_id" = $2::uuid
              FOR UPDATE`,
            [parsed.reversalId, principal.centerId],
          );
          const revReq = reqRes.rows[0]!;

          if (revReq.status !== 'PENDING_DIRECTOR_APPROVAL') {
            throw new ApiHttpException({
              statusCode: 409,
              errorCode: 'VERSION_CONFLICT',
              message: `Reversal request ${parsed.reversalId} has already been decided (${revReq.status})`,
            });
          }

          const payRes = await tx.query<{
            id: string;
            student_id: string;
            cash_shift_id: string;
            amount_uzs: string;
            payment_method: PaymentMethod;
          }>(
            `SELECT "id"::text AS id,
                    "student_id"::text AS student_id,
                    "cash_shift_id"::text AS cash_shift_id,
                    "amount_uzs"::text AS amount_uzs,
                    "payment_method"::text AS payment_method
               FROM "payments"
              WHERE "id" = $1::uuid
                AND "center_id" = $2::uuid
              LIMIT 1`,
            [revReq.original_payment_id, principal.centerId],
          );
          const originalPayment = payRes.rows[0]!;

          // Lock mutable Student row FOR UPDATE
          await tx.query(
            `SELECT "id"::text AS id
               FROM "students"
              WHERE "id" = $1::uuid
                AND "center_id" = $2::uuid
              FOR UPDATE`,
            [originalPayment.student_id, principal.centerId],
          );

          if (parsed.decision === 'REJECTED') {
            const updatedReq = await executeOptimisticUpdate<{ version: number }>(tx, {
              tableName: 'reversal_or_refund_requests',
              entityName: 'ReversalOrRefundRequest',
              id: revReq.id,
              centerId: principal.centerId,
              expectedVersion: parsed.expectedVersion,
              setClauseSql: `"status" = 'REJECTED', "decided_by_director_id" = $4::uuid, "decision_note" = $5`,
              additionalValues: [principal.staffId, parsed.decisionNote],
            });

            this.maybeInjectTestFault('REQUEST_UPDATE', options?.testFaultAfterStep);

            const auditId = crypto.randomUUID();
            await tx.query(
              `INSERT INTO "audit_logs" (
                 "id",
                 "center_id",
                 "actor_type",
                 "actor_id",
                 "actor_role",
                 "action",
                 "entity_type",
                 "entity_id",
                 "severity",
                 "before_redacted_json",
                 "after_redacted_json",
                 "request_id",
                 "created_at"
               ) VALUES (
                 $1::uuid,
                 $2::uuid,
                 'STAFF',
                 $3::uuid,
                 'DIRECTOR',
                 'PAYMENT_REVERSAL_REJECTED',
                 'ReversalOrRefundRequest',
                 $4::uuid,
                 'INFO',
                 $5::jsonb,
                 $6::jsonb,
                 $7,
                 $8::timestamptz
               )`,
              [
                auditId,
                principal.centerId,
                principal.staffId,
                revReq.id,
                JSON.stringify({ status: 'PENDING_DIRECTOR_APPROVAL', version: revReq.version }),
                JSON.stringify({
                  status: 'REJECTED',
                  decided_by_director_id: principal.staffId,
                  decision_note: parsed.decisionNote,
                  version: Number(updatedReq.version),
                }),
                requestId,
                nowUtc.toISOString(),
              ],
            );

            this.maybeInjectTestFault('AUDIT_LOG', options?.testFaultAfterStep);

            const dto = await this.readReversalResponseDto(tx, principal.centerId, revReq.id);
            return {
              statusCode: 200,
              body: dto,
            };
          }

          // APPROVED_EXECUTED path:
          const execSumRes = await tx.query<{ reversed_sum: string }>(
            `SELECT COALESCE(SUM("amount_uzs"), 0)::text AS reversed_sum
               FROM "reversal_or_refund_executions"
              WHERE "center_id" = $1::uuid
                AND "original_payment_id" = $2::uuid`,
            [principal.centerId, originalPayment.id],
          );
          const alreadyReversedTotalUzs = BigInt(execSumRes.rows[0]?.reversed_sum ?? '0');

          // Lock mutable UnappliedCredit row (if any) FOR UPDATE
          const unappliedRes = await tx.query<{
            id: string;
            remaining_credit_uzs: string;
            version: number;
          }>(
            `SELECT "id"::text AS id,
                    "remaining_credit_uzs"::text AS remaining_credit_uzs,
                    "version"
               FROM "unapplied_credits"
              WHERE "center_id" = $1::uuid
                AND "source_payment_id" = $2::uuid
              FOR UPDATE`,
            [principal.centerId, originalPayment.id],
          );
          const unappliedRow = unappliedRes.rows[0] ?? null;
          const currentUnappliedCreditUzs = unappliedRow
            ? BigInt(unappliedRow.remaining_credit_uzs)
            : 0n;

          // Read allocations of originalPayment (without FOR UPDATE on immutable payment_allocations!)
          const allocRowsRes = await tx.query<{
            id: string;
            invoice_id: string;
            allocated_amount_uzs: string;
            already_reversed_uzs: string;
          }>(
            `SELECT pa."id"::text AS id,
                    pa."invoice_id"::text AS invoice_id,
                    pa."allocated_amount_uzs"::text AS allocated_amount_uzs,
                    COALESCE(
                      (SELECT SUM(par."reversed_amount_uzs")
                         FROM "payment_allocation_reversals" par
                        WHERE par."original_allocation_id" = pa."id"
                          AND par."center_id" = pa."center_id"),
                      0
                    )::text AS already_reversed_uzs
               FROM "payment_allocations" pa
              WHERE pa."center_id" = $1::uuid
                AND pa."payment_id" = $2::uuid
              ORDER BY pa."created_at" DESC, pa."id" DESC`,
            [principal.centerId, originalPayment.id],
          );

          const allocInvoiceIds = [
            ...new Set(allocRowsRes.rows.map((r) => r.invoice_id)),
          ];

          const invoiceMap = new Map<
            string,
            {
              id: string;
              enrollment_id: string;
              effective_net_charge_uzs: bigint;
              allocated_paid_uzs: bigint;
              remaining_debt_uzs: bigint;
              version: number;
            }
          >();

          if (allocInvoiceIds.length > 0) {
            // Lock mutable Invoice rows FOR UPDATE in deterministic UUID order
            const invRes = await tx.query<{
              id: string;
              enrollment_id: string;
              effective_net_charge_uzs: string;
              allocated_paid_uzs: string;
              remaining_debt_uzs: string;
              version: number;
            }>(
              `SELECT "id"::text AS id,
                      "enrollment_id"::text AS enrollment_id,
                      "effective_net_charge_uzs"::text AS effective_net_charge_uzs,
                      "allocated_paid_uzs"::text AS allocated_paid_uzs,
                      "remaining_debt_uzs"::text AS remaining_debt_uzs,
                      "version"
                 FROM "invoices"
                WHERE "center_id" = $1::uuid
                  AND "id" = ANY($2::uuid[])
                ORDER BY "id" ASC
                FOR UPDATE`,
              [principal.centerId, allocInvoiceIds],
            );
            for (const inv of invRes.rows) {
              invoiceMap.set(inv.id, {
                id: inv.id,
                enrollment_id: inv.enrollment_id,
                effective_net_charge_uzs: BigInt(inv.effective_net_charge_uzs),
                allocated_paid_uzs: BigInt(inv.allocated_paid_uzs),
                remaining_debt_uzs: BigInt(inv.remaining_debt_uzs),
                version: Number(inv.version),
              });
            }
          }

          const candidates: ReversalAllocationCandidate[] = allocRowsRes.rows.map((r) => {
            const inv = invoiceMap.get(r.invoice_id)!;
            return {
              allocationId: r.id,
              invoiceId: r.invoice_id,
              enrollmentId: inv.enrollment_id,
              allocatedAmountUzs: BigInt(r.allocated_amount_uzs),
              alreadyReversedOnAllocationUzs: BigInt(r.already_reversed_uzs),
              invoiceEffectiveNetChargeUzs: inv.effective_net_charge_uzs,
              invoiceAllocatedPaidUzs: inv.allocated_paid_uzs,
              invoiceRemainingDebtUzs: inv.remaining_debt_uzs,
              invoiceVersion: inv.version,
            };
          });

          const unwindPlan = planPaymentReversalUnwind({
            kind: revReq.kind,
            debtEffectPolicy: parsed.debtEffectPolicy,
            originalPaymentAmountUzs: BigInt(originalPayment.amount_uzs),
            alreadyReversedTotalUzs,
            requestedReversalUzs: BigInt(revReq.amount_uzs),
            currentUnappliedCreditUzs,
            allocationsInReverseOrder: candidates,
          });

          // Resolve and lock target CashShift FOR UPDATE
          const targetShiftId = parsed.cashShiftId ?? originalPayment.cash_shift_id;
          const shiftRes = await tx.query<{
            id: string;
            status: CashShiftStatus;
            opening_cash_uzs: string;
            cash_receipts_uzs: string;
            non_cash_receipts_uzs: string;
            cash_refunds_uzs: string;
            non_cash_refunds_uzs: string;
            cash_expenses_uzs: string;
            version: number;
          }>(
            `SELECT "id"::text AS id,
                    "status"::text AS status,
                    "opening_cash_uzs"::text AS opening_cash_uzs,
                    "cash_receipts_uzs"::text AS cash_receipts_uzs,
                    "non_cash_receipts_uzs"::text AS non_cash_receipts_uzs,
                    "cash_refunds_uzs"::text AS cash_refunds_uzs,
                    "non_cash_refunds_uzs"::text AS non_cash_refunds_uzs,
                    "cash_expenses_uzs"::text AS cash_expenses_uzs,
                    "version"
               FROM "cash_shifts"
              WHERE "id" = $1::uuid
                AND "center_id" = $2::uuid
              FOR UPDATE`,
            [targetShiftId, principal.centerId],
          );
          const shiftRow = shiftRes.rows[0];
          if (!shiftRow) {
            throw new ApiHttpException({
              statusCode: 404,
              errorCode: 'NOT_FOUND',
              message: 'Target cash shift not found in center scope',
            });
          }
          if (shiftRow.status !== 'OPEN') {
            throw new ApiHttpException({
              statusCode: 409,
              errorCode: 'SHIFT_CLOSED',
              message: `Cannot execute reversal/refund against CLOSED cash shift (${targetShiftId}); pass an active OPEN cash_shift_id`,
            });
          }

          // 1. Update ReversalOrRefundRequest to APPROVED_EXECUTED
          const updatedReq = await executeOptimisticUpdate<{ version: number }>(tx, {
            tableName: 'reversal_or_refund_requests',
            entityName: 'ReversalOrRefundRequest',
            id: revReq.id,
            centerId: principal.centerId,
            expectedVersion: parsed.expectedVersion,
            setClauseSql: `"status" = 'APPROVED_EXECUTED', "debt_effect_policy" = $4, "decided_by_director_id" = $5::uuid, "decision_note" = $6`,
            additionalValues: [
              parsed.debtEffectPolicy,
              principal.staffId,
              parsed.decisionNote,
            ],
          });

          this.maybeInjectTestFault('REQUEST_UPDATE', options?.testFaultAfterStep);

          // 2. Insert immutable ReversalOrRefundExecution
          const executionId = crypto.randomUUID();
          await tx.query(
            `INSERT INTO "reversal_or_refund_executions" (
               "id",
               "center_id",
               "request_id",
               "original_payment_id",
               "cash_shift_id",
               "kind",
               "amount_uzs",
               "refund_method",
               "debt_effect_policy",
               "approved_by_director_id",
               "compensation_credit_note_id",
               "executed_at"
             ) VALUES (
               $1::uuid,
               $2::uuid,
               $3::uuid,
               $4::uuid,
               $5::uuid,
               $6,
               $7::bigint,
               $8,
               $9,
               $10::uuid,
               NULL,
               $11::timestamptz
             )`,
            [
              executionId,
              principal.centerId,
              revReq.id,
              originalPayment.id,
              shiftRow.id,
              revReq.kind,
              formatMoneyUzs(unwindPlan.requestedReversalUzs),
              revReq.refund_method,
              parsed.debtEffectPolicy,
              principal.staffId,
              nowUtc.toISOString(),
            ],
          );

          this.maybeInjectTestFault('EXECUTION_INSERT', options?.testFaultAfterStep);

          // 3. Reduce UnappliedCredit if applicable
          if (unappliedRow && unwindPlan.unappliedCreditReductionUzs > 0n) {
            await executeOptimisticUpdate(tx, {
              tableName: 'unapplied_credits',
              entityName: 'UnappliedCredit',
              id: unappliedRow.id,
              centerId: principal.centerId,
              expectedVersion: Number(unappliedRow.version),
              setClauseSql: `"remaining_credit_uzs" = $4::bigint`,
              additionalValues: [formatMoneyUzs(unwindPlan.newUnappliedRemainingCreditUzs)],
            });
          }

          this.maybeInjectTestFault('UNAPPLIED_CREDIT_UPDATE', options?.testFaultAfterStep);

          // 4. Insert PaymentAllocationReversal rows & update Invoice remaining_debt_uzs
          const reversedInvoiceIds: string[] = [];
          for (const item of unwindPlan.plannedAllocationReversals) {
            const allocReversalId = crypto.randomUUID();
            await tx.query(
              `INSERT INTO "payment_allocation_reversals" (
                 "id",
                 "center_id",
                 "original_allocation_id",
                 "reversal_execution_id",
                 "invoice_id",
                 "reversed_amount_uzs",
                 "created_at"
               ) VALUES (
                 $1::uuid,
                 $2::uuid,
                 $3::uuid,
                 $4::uuid,
                 $5::uuid,
                 $6::bigint,
                 $7::timestamptz
               )`,
              [
                allocReversalId,
                principal.centerId,
                item.originalAllocationId,
                executionId,
                item.invoiceId,
                formatMoneyUzs(item.reversedAmountUzs),
                nowUtc.toISOString(),
              ],
            );

            this.maybeInjectTestFault('ALLOCATION_REVERSAL', options?.testFaultAfterStep);

            const updatedInv = await executeOptimisticUpdate<{ version: number }>(tx, {
              tableName: 'invoices',
              entityName: 'Invoice',
              id: item.invoiceId,
              centerId: principal.centerId,
              expectedVersion: item.expectedInvoiceVersion,
              setClauseSql: `"allocated_paid_uzs" = $4::bigint, "remaining_debt_uzs" = $5::bigint, "status" = $6`,
              additionalValues: [
                formatMoneyUzs(item.newInvoiceAllocatedPaidUzs),
                formatMoneyUzs(item.newInvoiceRemainingDebtUzs),
                item.newInvoiceStatus,
              ],
            });

            reversedInvoiceIds.push(item.invoiceId);

            this.maybeInjectTestFault('INVOICE_UPDATE', options?.testFaultAfterStep);

            const allocOutboxId = crypto.randomUUID();
            await tx.query(
              `INSERT INTO "outbox_events" (
                 "id",
                 "center_id",
                 "event_name",
                 "schema_version",
                 "aggregate_type",
                 "aggregate_id",
                 "aggregate_version",
                 "dedup_key",
                 "payload_json",
                 "status",
                 "lease_token",
                 "occurred_at_utc",
                 "next_attempt_at",
                 "updated_at"
               ) VALUES (
                 $1::uuid,
                 $2::uuid,
                 'AllocationAdjusted',
                 1,
                 'Invoice',
                 $3::uuid,
                 $4::int,
                 $5,
                 $6::jsonb,
                 'PENDING',
                 0,
                 $7::timestamptz,
                 $7::timestamptz,
                 $7::timestamptz
               )`,
              [
                allocOutboxId,
                principal.centerId,
                item.invoiceId,
                Number(updatedInv.version),
                `AllocationAdjusted:${item.invoiceId}:v${Number(updatedInv.version)}`,
                JSON.stringify({
                  invoice_id: item.invoiceId,
                  enrollment_id: item.enrollmentId,
                  student_id: originalPayment.student_id,
                  allocation_id: item.originalAllocationId,
                  allocation_reversal_id: allocReversalId,
                  delta_allocated_uzs: `-${formatMoneyUzs(item.reversedAmountUzs)}`,
                  new_remaining_debt_uzs: formatMoneyUzs(item.newInvoiceRemainingDebtUzs),
                  invoice_status: item.newInvoiceStatus,
                }),
                nowUtc.toISOString(),
              ],
            );
          }

          // 5. Update CashShift drawer/non-cash refund totals (C03: only CASH refund reduces expected_closing_cash_uzs)
          const openingCash = BigInt(shiftRow.opening_cash_uzs);
          const cashReceipts = BigInt(shiftRow.cash_receipts_uzs);
          const cashRefunds = BigInt(shiftRow.cash_refunds_uzs);
          const nonCashRefunds = BigInt(shiftRow.non_cash_refunds_uzs);
          const cashExpenses = BigInt(shiftRow.cash_expenses_uzs);

          if (revReq.refund_method === 'CASH') {
            const newCashRefunds = cashRefunds + unwindPlan.requestedReversalUzs;
            const newExpectedClosing =
              openingCash + cashReceipts - newCashRefunds - cashExpenses;
            await executeOptimisticUpdate(tx, {
              tableName: 'cash_shifts',
              entityName: 'CashShift',
              id: shiftRow.id,
              centerId: principal.centerId,
              expectedVersion: Number(shiftRow.version),
              setClauseSql: `"cash_refunds_uzs" = $4::bigint, "expected_closing_cash_uzs" = $5::bigint`,
              additionalValues: [
                formatMoneyUzs(newCashRefunds),
                formatMoneyUzs(newExpectedClosing),
              ],
            });
          } else {
            const newNonCashRefunds = nonCashRefunds + unwindPlan.requestedReversalUzs;
            await executeOptimisticUpdate(tx, {
              tableName: 'cash_shifts',
              entityName: 'CashShift',
              id: shiftRow.id,
              centerId: principal.centerId,
              expectedVersion: Number(shiftRow.version),
              setClauseSql: `"non_cash_refunds_uzs" = $4::bigint`,
              additionalValues: [formatMoneyUzs(newNonCashRefunds)],
            });
          }

          this.maybeInjectTestFault('CASH_SHIFT_UPDATE', options?.testFaultAfterStep);

          // 6. Insert append-only LedgerEntry (PAYMENT_REVERSED or REFUND_PAID, DEBIT)
          const ledgerEntryId = crypto.randomUUID();
          const ledgerEntryType =
            revReq.kind === 'ERROR_STORNO_REVERSAL' ? 'PAYMENT_REVERSED' : 'REFUND_PAID';
          const singleInvoiceId =
            reversedInvoiceIds.length === 1 ? reversedInvoiceIds[0] : null;

          await tx.query(
            `INSERT INTO "ledger_entries" (
               "id",
               "center_id",
               "entry_type",
               "student_id",
               "invoice_id",
               "payment_id",
               "reversal_execution_id",
               "direction",
               "amount_uzs",
               "payment_method",
               "actor_type",
               "actor_staff_id",
               "system_job_name",
               "created_at"
             ) VALUES (
               $1::uuid,
               $2::uuid,
               $3,
               $4::uuid,
               $5::uuid,
               $6::uuid,
               $7::uuid,
               'DEBIT',
               $8::bigint,
               $9,
               'STAFF',
               $10::uuid,
               NULL,
               $11::timestamptz
             )`,
            [
              ledgerEntryId,
              principal.centerId,
              ledgerEntryType,
              originalPayment.student_id,
              singleInvoiceId,
              originalPayment.id,
              executionId,
              formatMoneyUzs(unwindPlan.requestedReversalUzs),
              revReq.refund_method,
              principal.staffId,
              nowUtc.toISOString(),
            ],
          );

          this.maybeInjectTestFault('LEDGER_ENTRY', options?.testFaultAfterStep);

          // 7. Insert AuditLog (CRITICAL_RED)
          const auditId = crypto.randomUUID();
          await tx.query(
            `INSERT INTO "audit_logs" (
               "id",
               "center_id",
               "actor_type",
               "actor_id",
               "actor_role",
               "action",
               "entity_type",
               "entity_id",
               "severity",
               "before_redacted_json",
               "after_redacted_json",
               "request_id",
               "created_at"
             ) VALUES (
               $1::uuid,
               $2::uuid,
               'STAFF',
               $3::uuid,
               'DIRECTOR',
               'PAYMENT_REVERSAL_APPROVED_EXECUTED',
               'ReversalOrRefundRequest',
               $4::uuid,
               'CRITICAL_RED',
               $5::jsonb,
               $6::jsonb,
               $7,
               $8::timestamptz
             )`,
            [
              auditId,
              principal.centerId,
              principal.staffId,
              revReq.id,
              JSON.stringify({
                status: 'PENDING_DIRECTOR_APPROVAL',
                version: revReq.version,
              }),
              JSON.stringify({
                status: 'APPROVED_EXECUTED',
                execution_id: executionId,
                original_payment_id: originalPayment.id,
                student_id: originalPayment.student_id,
                kind: revReq.kind,
                amount_uzs: formatMoneyUzs(unwindPlan.requestedReversalUzs),
                refund_method: revReq.refund_method,
                debt_effect_policy: parsed.debtEffectPolicy,
                unapplied_credit_reduced_uzs: formatMoneyUzs(
                  unwindPlan.unappliedCreditReductionUzs,
                ),
                invoice_debt_restored_uzs: formatMoneyUzs(
                  unwindPlan.totalInvoiceDebtRestoredUzs,
                ),
                version: Number(updatedReq.version),
              }),
              requestId,
              nowUtc.toISOString(),
            ],
          );

          this.maybeInjectTestFault('AUDIT_LOG', options?.testFaultAfterStep);

          // 8. Insert OutboxEvent (RefundRecorded v2)
          const outboxId = crypto.randomUUID();
          await tx.query(
            `INSERT INTO "outbox_events" (
               "id",
               "center_id",
               "event_name",
               "schema_version",
               "aggregate_type",
               "aggregate_id",
               "aggregate_version",
               "dedup_key",
               "payload_json",
               "status",
               "lease_token",
               "occurred_at_utc",
               "next_attempt_at",
               "updated_at"
             ) VALUES (
               $1::uuid,
               $2::uuid,
               'RefundRecorded',
               1,
               'ReversalOrRefundRequest',
               $3::uuid,
               $4::int,
               $5,
               $6::jsonb,
               'PENDING',
               0,
               $7::timestamptz,
               $7::timestamptz,
               $7::timestamptz
             )`,
            [
              outboxId,
              principal.centerId,
              revReq.id,
              Number(updatedReq.version),
              `RefundRecorded:${revReq.id}:v${Number(updatedReq.version)}`,
              JSON.stringify({
                request_id: revReq.id,
                execution_id: executionId,
                original_payment_id: originalPayment.id,
                student_id: originalPayment.student_id,
                kind: revReq.kind,
                amount_uzs: formatMoneyUzs(unwindPlan.requestedReversalUzs),
                refund_method: revReq.refund_method,
                debt_effect_policy: parsed.debtEffectPolicy,
                status: 'APPROVED_EXECUTED',
                requested_by_admin_id: revReq.requested_by_admin_id,
                approved_by_director_id: principal.staffId,
              }),
              nowUtc.toISOString(),
            ],
          );

          this.maybeInjectTestFault('OUTBOX_EVENT', options?.testFaultAfterStep);

          const dto = await this.readReversalResponseDto(tx, principal.centerId, revReq.id);
          return {
            statusCode: 200,
            body: dto,
          };
        },
      },
    );

    return idemOutcome.body;
  }
}
