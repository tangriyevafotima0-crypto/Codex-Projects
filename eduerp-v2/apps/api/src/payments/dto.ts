/**
 * EduERP v2.0 — Stage 10 (`10.01`–`10.05`, `OWNER-20261105-05`):
 * Manual External Payment Recording, Allocation, Promise-to-Pay Seam,
 * Reversal/Refund Request & Director Approval, and Internal Electronic Receipt DTOs & Pure Validators.
 */

import type {
  DebtEffectPolicy,
  PaymentMethod,
  PaymentSourceChannel,
  ReversalDecision,
  ReversalOrRefundKind,
  ReversalOrRefundStatus,
} from '@eduerp/contracts';
import { ApiHttpException } from '../auth/auth.errors';
import {
  assertPlainObject,
  assertValidUuid,
  resolveExpectedVersion,
} from '../auth/validation';
import { RequestWithCorrelationId } from '../common/request-id.middleware';
import { parsePositiveMoneyUzs } from '../database/money';
import { parseOptionalStrictBoolean, validateIsoDate } from '../students/normalization';

export const PAYMENTS_CALCULATION_VERSION = 's10-v1';

export const ALLOWED_PAYMENT_METHODS: ReadonlySet<PaymentMethod> = new Set([
  'CASH',
  'CARD',
  'CLICK',
  'PAYME',
  'TRANSFER',
]);

export const ALLOWED_REVERSAL_KINDS: ReadonlySet<ReversalOrRefundKind> = new Set([
  'ERROR_STORNO_REVERSAL',
  'PARTIAL_REFUND',
  'FULL_REFUND',
]);

export const ALLOWED_REVERSAL_DECISIONS: ReadonlySet<ReversalDecision> = new Set([
  'APPROVED_EXECUTED',
  'REJECTED',
]);

export const ALLOWED_DEBT_EFFECT_POLICIES: ReadonlySet<DebtEffectPolicy> = new Set([
  'REOPEN_INVOICE_DEBT',
  'CLOSE_WITH_CREDIT_NOTE',
]);

export type PaymentFaultInjectionStep =
  | 'PAYMENT_INSERT'
  | 'ALLOCATION_APPLY'
  | 'CASH_SHIFT_UPDATE'
  | 'LEDGER_ENTRY'
  | 'RECEIPT_INSERT'
  | 'AUDIT_LOG'
  | 'OUTBOX_EVENT';

export type ReversalFaultInjectionStep =
  | 'REQUEST_UPDATE'
  | 'EXECUTION_INSERT'
  | 'UNAPPLIED_CREDIT_UPDATE'
  | 'ALLOCATION_REVERSAL'
  | 'INVOICE_UPDATE'
  | 'CASH_SHIFT_UPDATE'
  | 'LEDGER_ENTRY'
  | 'AUDIT_LOG'
  | 'OUTBOX_EVENT';

export interface ExplicitInvoiceAllocationInput {
  readonly invoiceId: string;
  readonly allocatedAmountUzs: bigint;
}

export interface ValidatedRecordPaymentInput {
  readonly studentId: string;
  readonly cashShiftId: string;
  readonly amountUzs: bigint;
  readonly currency: 'UZS';
  readonly paymentMethod: PaymentMethod;
  readonly targetInvoiceIds: readonly string[] | null;
  readonly explicitAllocations: readonly ExplicitInvoiceAllocationInput[] | null;
  readonly promiseDate: string | null;
  readonly paidAtUtc: string;
  readonly recordedAtUtc: string;
  readonly isLateEntry: boolean;
  readonly externalReference: string | null;
  readonly paymentNote: string | null;
}

export interface PaymentAllocationItemDto {
  readonly allocation_id: string;
  readonly invoice_id: string;
  readonly allocated_amount_uzs: string;
  readonly resulting_invoice_debt_uzs: string;
  readonly resulting_invoice_status: string;
}

export interface PaymentRecordedResponseDto {
  readonly payment_id: string;
  readonly receipt_id: string;
  readonly receipt_number: string;
  readonly student_id: string;
  readonly cash_shift_id: string;
  readonly amount_uzs: string;
  readonly currency: 'UZS';
  readonly payment_method: PaymentMethod;
  readonly paid_at_utc: string;
  readonly recorded_at_utc: string;
  readonly late_entry: boolean;
  readonly external_reference: string | null;
  readonly payment_note: string | null;
  readonly source_channel: PaymentSourceChannel;
  readonly allocated_total_uzs: string;
  readonly unapplied_credit_uzs: string;
  readonly unapplied_credit_id: string | null;
  readonly remaining_debt_uzs: string;
  readonly promise_id: string | null;
  readonly promise_date: string | null;
  readonly allocations: readonly PaymentAllocationItemDto[];
  readonly is_fiscal_tax_receipt: false;
}

export interface ValidatedCreateReversalInput {
  readonly originalPaymentId: string;
  readonly kind: ReversalOrRefundKind;
  readonly amountUzs: bigint;
  readonly refundMethod: PaymentMethod;
  readonly debtEffectPolicy: DebtEffectPolicy;
  readonly reason: string;
}

export interface ValidatedApproveReversalInput {
  readonly reversalId: string;
  readonly decision: ReversalDecision;
  readonly debtEffectPolicy: DebtEffectPolicy;
  readonly cashShiftId: string | null;
  readonly decisionNote: string | null;
  readonly expectedVersion: number;
}

export interface ReversalExecutionResponseDto {
  readonly execution_id: string;
  readonly request_id: string;
  readonly original_payment_id: string;
  readonly cash_shift_id: string | null;
  readonly kind: ReversalOrRefundKind;
  readonly amount_uzs: string;
  readonly refund_method: PaymentMethod;
  readonly debt_effect_policy: DebtEffectPolicy;
  readonly approved_by_director_id: string;
  readonly allocation_reversal_ids: readonly string[];
  readonly compensation_credit_note_id: string | null;
  readonly executed_at: string;
}

export interface ReversalOrRefundResponseDto {
  readonly request_id: string;
  readonly original_payment_id: string;
  readonly kind: ReversalOrRefundKind;
  readonly amount_uzs: string;
  readonly refund_method: PaymentMethod;
  readonly debt_effect_policy: DebtEffectPolicy;
  readonly reason: string;
  readonly requested_by_admin_id: string;
  readonly decided_by_director_id: string | null;
  readonly decision_note: string | null;
  readonly red_alert_sent_at: string | null;
  readonly status: ReversalOrRefundStatus;
  readonly version: number;
  readonly execution: ReversalExecutionResponseDto | null;
}

export interface ReceiptReversalSummaryDto {
  readonly execution_id: string;
  readonly request_id: string;
  readonly kind: ReversalOrRefundKind;
  readonly reversed_amount_uzs: string;
  readonly refund_method: PaymentMethod;
  readonly executed_at: string;
}

export interface ReceiptResponseDto {
  readonly id: string;
  readonly receipt_number: string;
  readonly payment_id: string;
  readonly student_id: string;
  readonly amount_uzs: string;
  readonly currency: 'UZS';
  readonly payment_method: PaymentMethod;
  readonly paid_at_utc: string;
  readonly recorded_at_utc: string;
  readonly remaining_debt_snapshot_uzs: string;
  readonly next_due_date_snapshot: string | null;
  readonly is_fiscal_tax_receipt: false;
  readonly issued_at: string;
  readonly reversed_total_uzs: string;
  readonly net_effective_payment_uzs: string;
  readonly reversal_status: 'NONE' | 'PENDING_REVERSAL' | 'PARTIALLY_REVERSED' | 'FULLY_REVERSED';
  readonly reversals: readonly ReceiptReversalSummaryDto[];
}

function parseIsoUtcTimestamp(raw: unknown, fieldName: string): Date {
  if (typeof raw !== 'string' || raw.trim().length < 10) {
    throw new ApiHttpException({
      statusCode: 400,
      errorCode: 'VALIDATION_ERROR',
      message: `${fieldName} must be a valid ISO-8601 timestamp string`,
    });
  }
  const trimmed = raw.trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(trimmed)) {
    throw new ApiHttpException({
      statusCode: 400,
      errorCode: 'VALIDATION_ERROR',
      message: `${fieldName} must be a complete ISO-8601 timestamp with timezone offset or Z`,
    });
  }
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    throw new ApiHttpException({
      statusCode: 400,
      errorCode: 'VALIDATION_ERROR',
      message: `${fieldName} is not a valid calendar timestamp`,
    });
  }
  return parsed;
}

function parsePaymentMethod(raw: unknown, fieldName: string): PaymentMethod {
  const val = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
  if (!ALLOWED_PAYMENT_METHODS.has(val as PaymentMethod)) {
    throw new ApiHttpException({
      statusCode: 400,
      errorCode: 'VALIDATION_ERROR',
      message: `${fieldName} must be CASH, CARD, CLICK, PAYME, or TRANSFER`,
    });
  }
  return val as PaymentMethod;
}

function parsePositiveMoneyOrThrow(raw: unknown, fieldName: string): bigint {
  try {
    return parsePositiveMoneyUzs(raw, fieldName);
  } catch (err: unknown) {
    throw new ApiHttpException({
      statusCode: 400,
      errorCode: 'VALIDATION_ERROR',
      message: err instanceof Error ? err.message : `Invalid ${fieldName}`,
    });
  }
}

/**
 * Pure validator for `POST /api/v1/payments` (`RecordPaymentCommand` — `10.01`, `10.02`, `OWNER-20261105-05`).
 */
export function validateRecordPaymentInput(
  rawBody: unknown,
  serverNow: Date,
  centerTodayDate: string,
): ValidatedRecordPaymentInput {
  const obj = assertPlainObject(rawBody, [
    'student_id',
    'cash_shift_id',
    'amount_uzs',
    'currency',
    'payment_method',
    'target_invoice_ids',
    'allocations',
    'promise_date',
    'paid_at',
    'external_reference',
    'payment_note',
    'backfill_closed_shift_ledger',
    'reopen_closed_shift',
  ]);

  const backfillClosedShift = parseOptionalStrictBoolean(
    obj.backfill_closed_shift_ledger,
    'backfill_closed_shift_ledger',
    false,
  );
  const reopenClosedShift = parseOptionalStrictBoolean(
    obj.reopen_closed_shift,
    'reopen_closed_shift',
    false,
  );
  if (backfillClosedShift || reopenClosedShift) {
    throw new ApiHttpException({
      statusCode: 403,
      errorCode: 'POLICY_DECISION_NOT_CONFIRMED',
      message:
        'Backfilling or reopening a closed cash shift ledger is forbidden; late payments must be recorded into an active OPEN shift with audit timestamps (10.01 / OWNER-20261105-05)',
    });
  }

  const studentId = assertValidUuid(obj.student_id, 'student_id');
  const cashShiftId = assertValidUuid(obj.cash_shift_id, 'cash_shift_id');
  const amountUzs = parsePositiveMoneyOrThrow(obj.amount_uzs, 'amount_uzs');

  if (obj.currency !== 'UZS') {
    throw new ApiHttpException({
      statusCode: 400,
      errorCode: 'VALIDATION_ERROR',
      message: 'currency is required and must be "UZS"',
    });
  }

  const paymentMethod = parsePaymentMethod(obj.payment_method, 'payment_method');

  let targetInvoiceIds: string[] | null = null;
  if (obj.target_invoice_ids !== undefined && obj.target_invoice_ids !== null) {
    if (!Array.isArray(obj.target_invoice_ids)) {
      throw new ApiHttpException({
        statusCode: 400,
        errorCode: 'VALIDATION_ERROR',
        message: 'target_invoice_ids must be an array of UUIDs',
      });
    }
    const seen = new Set<string>();
    targetInvoiceIds = [];
    for (const rawId of obj.target_invoice_ids) {
      const invId = assertValidUuid(rawId, 'target_invoice_ids[]');
      if (seen.has(invId)) {
        throw new ApiHttpException({
          statusCode: 422,
          errorCode: 'VALIDATION_ERROR',
          message: `Duplicate invoice_id ${invId} in target_invoice_ids`,
        });
      }
      seen.add(invId);
      targetInvoiceIds.push(invId);
    }
  }

  let explicitAllocations: ExplicitInvoiceAllocationInput[] | null = null;
  if (obj.allocations !== undefined && obj.allocations !== null) {
    if (!Array.isArray(obj.allocations) || obj.allocations.length === 0) {
      throw new ApiHttpException({
        statusCode: 400,
        errorCode: 'VALIDATION_ERROR',
        message: 'allocations must be a non-empty array when provided',
      });
    }
    const seen = new Set<string>();
    explicitAllocations = [];
    let sumExplicit = 0n;
    for (const rawAlloc of obj.allocations) {
      const itemObj = assertPlainObject(rawAlloc, ['invoice_id', 'allocated_amount_uzs']);
      const invId = assertValidUuid(itemObj.invoice_id, 'allocations[].invoice_id');
      if (seen.has(invId)) {
        throw new ApiHttpException({
          statusCode: 422,
          errorCode: 'VALIDATION_ERROR',
          message: `Duplicate invoice_id ${invId} in allocations`,
        });
      }
      seen.add(invId);
      const allocAmt = parsePositiveMoneyOrThrow(
        itemObj.allocated_amount_uzs,
        'allocations[].allocated_amount_uzs',
      );
      sumExplicit += allocAmt;
      explicitAllocations.push(Object.freeze({ invoiceId: invId, allocatedAmountUzs: allocAmt }));
    }
    if (sumExplicit > amountUzs) {
      throw new ApiHttpException({
        statusCode: 422,
        errorCode: 'VALIDATION_ERROR',
        message: `Sum of explicit allocations (${sumExplicit.toString(10)} UZS) exceeds payment amount (${amountUzs.toString(10)} UZS)`,
      });
    }
    if (targetInvoiceIds !== null) {
      const explicitIds = explicitAllocations.map((a) => a.invoiceId);
      if (
        targetInvoiceIds.length !== explicitIds.length ||
        targetInvoiceIds.some((id, idx) => id !== explicitIds[idx])
      ) {
        throw new ApiHttpException({
          statusCode: 422,
          errorCode: 'VALIDATION_ERROR',
          message: 'When both target_invoice_ids and allocations are provided, their invoice_id lists must match',
        });
      }
    }
  }

  let promiseDate: string | null = null;
  if (obj.promise_date !== undefined && obj.promise_date !== null) {
    promiseDate = validateIsoDate(obj.promise_date, 'promise_date');
    // Parse-only before idempotent replay. New execution enforces the live date
    // in planPaymentAllocations inside the transaction; an old committed result
    // must remain replayable after its promise date has passed.
    validateIsoDate(centerTodayDate, 'centerTodayDate');
  }

  const recordedAtDate = new Date(serverNow.getTime());
  let paidAtDate = recordedAtDate;
  if (obj.paid_at !== undefined && obj.paid_at !== null) {
    paidAtDate = parseIsoUtcTimestamp(obj.paid_at, 'paid_at');
    if (paidAtDate.getTime() > recordedAtDate.getTime()) {
      throw new ApiHttpException({
        statusCode: 422,
        errorCode: 'VALIDATION_ERROR',
        message: `paid_at (${paidAtDate.toISOString()}) cannot be in the future relative to server recorded_at (${recordedAtDate.toISOString()}) (10.01 / OWNER-20261105-05)`,
      });
    }
  }

  let externalReference: string | null = null;
  if (obj.external_reference !== undefined && obj.external_reference !== null) {
    if (
      typeof obj.external_reference !== 'string' ||
      obj.external_reference.trim().length === 0 ||
      obj.external_reference.trim().length > 128
    ) {
      throw new ApiHttpException({
        statusCode: 400,
        errorCode: 'VALIDATION_ERROR',
        message: 'external_reference must be a non-empty string up to 128 characters',
      });
    }
    externalReference = obj.external_reference.trim();
  }

  let paymentNote: string | null = null;
  if (obj.payment_note !== undefined && obj.payment_note !== null) {
    if (typeof obj.payment_note !== 'string' || obj.payment_note.length > 500) {
      throw new ApiHttpException({
        statusCode: 400,
        errorCode: 'VALIDATION_ERROR',
        message: 'payment_note must be a string up to 500 characters',
      });
    }
    paymentNote = obj.payment_note.trim() || null;
  }

  const paidAtUtc = paidAtDate.toISOString();
  const recordedAtUtc = recordedAtDate.toISOString();
  const isLateEntry = paidAtDate.getTime() < recordedAtDate.getTime();

  return Object.freeze({
    studentId,
    cashShiftId,
    amountUzs,
    currency: 'UZS',
    paymentMethod,
    targetInvoiceIds: targetInvoiceIds ? Object.freeze(targetInvoiceIds) : null,
    explicitAllocations: explicitAllocations ? Object.freeze(explicitAllocations) : null,
    promiseDate,
    paidAtUtc,
    recordedAtUtc,
    isLateEntry,
    externalReference,
    paymentNote,
  });
}

/**
 * Pure validator for `POST /api/v1/payments/reversals` (`CreateReversalOrRefundRequest` — `10.03`, `OWNER-20261105-05`).
 */
export function validateCreateReversalInput(rawBody: unknown): ValidatedCreateReversalInput {
  const obj = assertPlainObject(rawBody, [
    'original_payment_id',
    'kind',
    'amount_uzs',
    'refund_method',
    'debt_effect_policy',
    'reason',
    'cancel_service_invoice',
    'issue_withdrawal_service_credit_note',
    'execute_bank_gateway_refund',
  ]);

  const cancelServiceInvoice = parseOptionalStrictBoolean(
    obj.cancel_service_invoice,
    'cancel_service_invoice',
    false,
  );
  const issueServiceCredit = parseOptionalStrictBoolean(
    obj.issue_withdrawal_service_credit_note,
    'issue_withdrawal_service_credit_note',
    false,
  );
  const executeGatewayRefund = parseOptionalStrictBoolean(
    obj.execute_bank_gateway_refund,
    'execute_bank_gateway_refund',
    false,
  );

  if (cancelServiceInvoice || issueServiceCredit || executeGatewayRefund) {
    throw new ApiHttpException({
      statusCode: 403,
      errorCode: 'POLICY_DECISION_NOT_CONFIRMED',
      message:
        'Service cancellation credit-note refund formulas (D22) and automated bank/gateway refund operations are not confirmed under OWNER-20261105-05',
    });
  }

  const originalPaymentId = assertValidUuid(obj.original_payment_id, 'original_payment_id');

  const kindRaw = typeof obj.kind === 'string' ? obj.kind.trim().toUpperCase() : '';
  if (!ALLOWED_REVERSAL_KINDS.has(kindRaw as ReversalOrRefundKind)) {
    throw new ApiHttpException({
      statusCode: 400,
      errorCode: 'VALIDATION_ERROR',
      message: 'kind must be ERROR_STORNO_REVERSAL, PARTIAL_REFUND, or FULL_REFUND',
    });
  }
  const kind = kindRaw as ReversalOrRefundKind;

  const amountUzs = parsePositiveMoneyOrThrow(obj.amount_uzs, 'amount_uzs');
  const refundMethod = parsePaymentMethod(obj.refund_method, 'refund_method');

  let debtEffectPolicy: DebtEffectPolicy = 'REOPEN_INVOICE_DEBT';
  if (obj.debt_effect_policy !== undefined && obj.debt_effect_policy !== null) {
    const policyRaw =
      typeof obj.debt_effect_policy === 'string' ? obj.debt_effect_policy.trim().toUpperCase() : '';
    if (!ALLOWED_DEBT_EFFECT_POLICIES.has(policyRaw as DebtEffectPolicy)) {
      throw new ApiHttpException({
        statusCode: 400,
        errorCode: 'VALIDATION_ERROR',
        message: 'debt_effect_policy must be REOPEN_INVOICE_DEBT or CLOSE_WITH_CREDIT_NOTE',
      });
    }
    debtEffectPolicy = policyRaw as DebtEffectPolicy;
  }

  if (debtEffectPolicy === 'CLOSE_WITH_CREDIT_NOTE') {
    throw new ApiHttpException({
      statusCode: 403,
      errorCode: 'POLICY_DECISION_NOT_CONFIRMED',
      message:
        'D22 CLOSE_WITH_CREDIT_NOTE service-cancellation refund policy is not confirmed under OWNER-20261105-05; only REOPEN_INVOICE_DEBT accounting reversal is enabled',
    });
  }

  if (typeof obj.reason !== 'string') {
    throw new ApiHttpException({
      statusCode: 400,
      errorCode: 'VALIDATION_ERROR',
      message: 'reason is required and must be a string',
    });
  }
  const reason = obj.reason.trim();
  if (reason.length < 5 || reason.length > 500) {
    throw new ApiHttpException({
      statusCode: 422,
      errorCode: 'VALIDATION_ERROR',
      message: 'reason must be between 5 and 500 characters (T10.03)',
    });
  }

  return Object.freeze({
    originalPaymentId,
    kind,
    amountUzs,
    refundMethod,
    debtEffectPolicy,
    reason,
  });
}

/**
 * Pure validator for `POST /api/v1/payments/reversals/{reversal_id}/decision` (`ApproveReversalOrRefundRequest` — `10.03`).
 */
export function validateApproveReversalInput(
  req: RequestWithCorrelationId,
  rawReversalId: unknown,
  rawBody: unknown,
): ValidatedApproveReversalInput {
  const reversalId = assertValidUuid(rawReversalId, 'reversal_id');
  const obj = assertPlainObject(rawBody, [
    'decision',
    'debt_effect_policy',
    'cash_shift_id',
    'decision_note',
    'expected_version',
    'cancel_service_invoice',
    'execute_bank_gateway_refund',
  ]);

  const cancelServiceInvoice = parseOptionalStrictBoolean(
    obj.cancel_service_invoice,
    'cancel_service_invoice',
    false,
  );
  const executeGatewayRefund = parseOptionalStrictBoolean(
    obj.execute_bank_gateway_refund,
    'execute_bank_gateway_refund',
    false,
  );
  if (cancelServiceInvoice || executeGatewayRefund) {
    throw new ApiHttpException({
      statusCode: 403,
      errorCode: 'POLICY_DECISION_NOT_CONFIRMED',
      message:
        'Service cancellation credit-note refund formulas (D22) and automated bank/gateway refund operations are not confirmed under OWNER-20261105-05',
    });
  }

  const decisionRaw = typeof obj.decision === 'string' ? obj.decision.trim().toUpperCase() : '';
  if (!ALLOWED_REVERSAL_DECISIONS.has(decisionRaw as ReversalDecision)) {
    throw new ApiHttpException({
      statusCode: 400,
      errorCode: 'VALIDATION_ERROR',
      message: 'decision must be APPROVED_EXECUTED or REJECTED',
    });
  }
  const decision = decisionRaw as ReversalDecision;

  const policyRaw =
    typeof obj.debt_effect_policy === 'string' ? obj.debt_effect_policy.trim().toUpperCase() : '';
  if (!ALLOWED_DEBT_EFFECT_POLICIES.has(policyRaw as DebtEffectPolicy)) {
    throw new ApiHttpException({
      statusCode: 400,
      errorCode: 'VALIDATION_ERROR',
      message: 'debt_effect_policy is required and must be REOPEN_INVOICE_DEBT or CLOSE_WITH_CREDIT_NOTE',
    });
  }
  const debtEffectPolicy = policyRaw as DebtEffectPolicy;

  if (decision === 'APPROVED_EXECUTED' && debtEffectPolicy === 'CLOSE_WITH_CREDIT_NOTE') {
    throw new ApiHttpException({
      statusCode: 403,
      errorCode: 'POLICY_DECISION_NOT_CONFIRMED',
      message:
        'D22 CLOSE_WITH_CREDIT_NOTE service-cancellation refund policy is not confirmed under OWNER-20261105-05; only REOPEN_INVOICE_DEBT accounting reversal is enabled',
    });
  }

  const cashShiftId =
    obj.cash_shift_id !== undefined && obj.cash_shift_id !== null
      ? assertValidUuid(obj.cash_shift_id, 'cash_shift_id')
      : null;

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

  return Object.freeze({
    reversalId,
    decision,
    debtEffectPolicy,
    cashShiftId,
    decisionNote,
    expectedVersion,
  });
}
