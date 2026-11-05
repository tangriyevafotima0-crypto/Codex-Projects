/**
 * EduERP v2.0 — Stage 11 (`11.01`–`11.05`, `BR-05`, `BR-09`, `C03`, `CASE-11`, `CASE-18`, `CASE-22`, `OWNER-20261105-05`):
 * Cash Shifts, Categorized Expenses & Append-Only Expense Reversals,
 * Promise-to-Pay & Debtor Projections, and Canonical Shift Reconciliation DTOs & Pure Validators.
 */

import type {
  CashShiftStatus,
  PaymentMethod,
  PromiseToPayStatus,
} from '@eduerp/contracts';
import { ApiHttpException } from '../auth/auth.errors';
import {
  assertPlainObject,
  assertValidUuid,
  resolveExpectedVersion,
} from '../auth/validation';
import { RequestWithCorrelationId } from '../common/request-id.middleware';
import {
  parseNonNegativeMoneyUzs,
  parseNonZeroSignedMoneyDeltaUzs,
  parseSignedMoneyDeltaUzs,
} from '../database/money';
import { parseOptionalStrictBoolean, validateIsoDate } from '../students/normalization';
import { ALLOWED_PAYMENT_METHODS } from '../payments/dto';

export type ShiftFaultInjectionStep =
  | 'SHIFT_INSERT'
  | 'SHIFT_CLOSE_UPDATE'
  | 'AUDIT_LOG'
  | 'OUTBOX_EVENT';

export type ExpenseFaultInjectionStep =
  | 'EXPENSE_INSERT'
  | 'CASH_SHIFT_UPDATE'
  | 'LEDGER_ENTRY'
  | 'AUDIT_LOG'
  | 'OUTBOX_EVENT';

export interface ExpenseWriteOptions {
  readonly testFaultAfterStep?: ExpenseFaultInjectionStep;
}

export interface ValidatedOpenCashShiftInput {
  readonly shiftDate: string;
  readonly openingCashUzs: bigint;
}

export interface ValidatedCloseCashShiftInput {
  readonly shiftId: string;
  readonly countedClosingCashUzs: bigint;
  readonly discrepancyReason: string | null;
  readonly expectedVersion: number;
}

export interface ValidatedRecordExpenseInput {
  readonly cashShiftId: string;
  readonly category: string;
  readonly rawSignedAmountUzs: bigint;
  readonly paymentMethod: PaymentMethod;
  readonly reasonAndDoc: string;
  readonly reversesExpenseId: string | null;
}

export interface ShiftMethodBreakdownItemDto {
  readonly payment_method: PaymentMethod;
  readonly gross_receipts_uzs: string;
  readonly refunds_and_reversals_uzs: string;
  readonly gross_expenses_uzs: string;
  readonly expense_reversals_uzs: string;
  readonly net_expenses_uzs: string;
  readonly net_flow_uzs: string;
}

export interface CashExpenseRecordDto {
  readonly expense_id: string;
  readonly cash_shift_id: string;
  readonly category: string;
  readonly amount_uzs: string;
  readonly payment_method: PaymentMethod;
  readonly reason_and_doc: string;
  readonly reverses_expense_id: string | null;
  readonly is_reversed: boolean;
  readonly reversed_by_expense_id: string | null;
  readonly recorded_by_staff_id: string;
  readonly created_at_utc: string;
}

export interface CashShiftReconciliationResponseDto {
  readonly shift_id: string;
  readonly shift_date: string;
  readonly status: CashShiftStatus;
  readonly opened_by_admin_id: string;
  readonly opened_at_utc: string;
  readonly closed_by_admin_id: string | null;
  readonly closed_at_utc: string | null;
  readonly opening_cash_uzs: string;
  readonly cash_receipts_uzs: string;
  readonly non_cash_receipts_uzs: string;
  readonly cash_refunds_uzs: string;
  readonly non_cash_refunds_uzs: string;
  readonly cash_expenses_uzs: string;
  readonly non_cash_expenses_uzs: string;
  readonly expected_closing_cash_uzs: string;
  readonly counted_closing_cash_uzs: string | null;
  readonly discrepancy_uzs: string | null;
  readonly discrepancy_reason: string | null;
  readonly net_non_cash_flow_uzs: string;
  readonly projection_drift_detected: boolean;
  readonly method_breakdown: readonly ShiftMethodBreakdownItemDto[];
  readonly expenses: readonly CashExpenseRecordDto[];
  readonly last_recorded_expense_id: string | null;
  readonly version: number;
}

export interface PromiseToPayItemDto {
  readonly promise_id: string;
  readonly student_id: string;
  readonly invoice_id: string;
  readonly trigger_payment_id: string;
  readonly promised_amount_uzs: string;
  readonly current_invoice_remaining_debt_uzs: string;
  readonly promise_date: string;
  readonly status: PromiseToPayStatus;
  readonly cancel_reason: string | null;
  readonly superseded_by_promise_id: string | null;
  readonly reminder_sent_at_utc: string | null;
  readonly eligible_for_due_reminder: boolean;
  readonly version: number;
  readonly created_at_utc: string;
  readonly updated_at_utc: string;
}

export interface DebtorInvoiceSummaryDto {
  readonly invoice_id: string;
  readonly invoice_number: string;
  readonly enrollment_id: string;
  readonly effective_net_charge_uzs: string;
  readonly allocated_paid_uzs: string;
  readonly remaining_debt_uzs: string;
  readonly status: string;
  readonly due_date: string;
  readonly is_overdue: boolean;
  readonly active_promise: PromiseToPayItemDto | null;
  readonly needs_new_promise: boolean;
}

export interface DebtorStudentSummaryDto {
  readonly student_id: string;
  readonly student_code: string;
  readonly full_name: string;
  readonly total_remaining_debt_uzs: string;
  readonly unapplied_credit_uzs: string;
  readonly open_invoices: readonly DebtorInvoiceSummaryDto[];
}

export interface DebtorsAndPromisesListResponseDto {
  readonly center_date: string;
  readonly debtors: readonly DebtorStudentSummaryDto[];
  readonly promises: readonly PromiseToPayItemDto[];
  readonly due_reminder_candidates: readonly PromiseToPayItemDto[];
}

function parseNonNegativeMoneyOrThrow(raw: unknown, fieldName: string): bigint {
  try {
    return parseNonNegativeMoneyUzs(raw, fieldName);
  } catch (err: unknown) {
    throw new ApiHttpException({
      statusCode: 400,
      errorCode: 'VALIDATION_ERROR',
      message: err instanceof Error ? err.message : `Invalid ${fieldName}`,
    });
  }
}

function parseNonZeroMoneyOrThrow(raw: unknown, fieldName: string): bigint {
  try {
    return parseNonZeroSignedMoneyDeltaUzs(raw, fieldName);
  } catch (err: unknown) {
    throw new ApiHttpException({
      statusCode: 400,
      errorCode: 'VALIDATION_ERROR',
      message: err instanceof Error ? err.message : `Invalid ${fieldName}`,
    });
  }
}

export function parseSignedMoneyOrThrow(raw: unknown, fieldName: string): bigint {
  try {
    return parseSignedMoneyDeltaUzs(raw, fieldName);
  } catch (err: unknown) {
    throw new ApiHttpException({
      statusCode: 400,
      errorCode: 'VALIDATION_ERROR',
      message: err instanceof Error ? err.message : `Invalid ${fieldName}`,
    });
  }
}

export function validateOpenCashShiftInput(rawBody: unknown): ValidatedOpenCashShiftInput {
  const obj = assertPlainObject(rawBody, [
    'shift_date',
    'opening_cash_uzs',
    'auto_carry_over_previous_counted_cash',
    'reopen_closed_shift_id',
  ]);

  const autoCarryOver = parseOptionalStrictBoolean(
    obj.auto_carry_over_previous_counted_cash,
    'auto_carry_over_previous_counted_cash',
    false,
  );
  if (autoCarryOver || (obj.reopen_closed_shift_id !== undefined && obj.reopen_closed_shift_id !== null)) {
    throw new ApiHttpException({
      statusCode: 403,
      errorCode: 'POLICY_DECISION_NOT_CONFIRMED',
      message:
        'Automatic carry-over of prior shift counted cash or reopening a closed shift is forbidden; opening_cash_uzs must be explicitly specified (11.01)',
    });
  }

  const shiftDate = validateIsoDate(obj.shift_date, 'shift_date');
  const openingCashUzs = parseNonNegativeMoneyOrThrow(obj.opening_cash_uzs, 'opening_cash_uzs');

  return Object.freeze({
    shiftDate,
    openingCashUzs,
  });
}

export function validateCloseCashShiftInput(
  req: RequestWithCorrelationId,
  rawShiftId: unknown,
  rawBody: unknown,
): ValidatedCloseCashShiftInput {
  const shiftId = assertValidUuid(rawShiftId, 'shift_id');
  const obj = assertPlainObject(rawBody, [
    'counted_closing_cash_uzs',
    'discrepancy_reason',
    'expected_version',
    'convert_discrepancy_to_expense',
    'overwrite_expected_closing_cash',
  ]);

  const convertToExpense = parseOptionalStrictBoolean(
    obj.convert_discrepancy_to_expense,
    'convert_discrepancy_to_expense',
    false,
  );
  const overwriteExpected = parseOptionalStrictBoolean(
    obj.overwrite_expected_closing_cash,
    'overwrite_expected_closing_cash',
    false,
  );
  if (convertToExpense || overwriteExpected) {
    throw new ApiHttpException({
      statusCode: 403,
      errorCode: 'POLICY_DECISION_NOT_CONFIRMED',
      message:
        'Converting cash discrepancy into a fake expense or overwriting expected_closing_cash_uzs is forbidden (11.01 / 11.04)',
    });
  }

  const countedClosingCashUzs = parseNonNegativeMoneyOrThrow(
    obj.counted_closing_cash_uzs,
    'counted_closing_cash_uzs',
  );

  let discrepancyReason: string | null = null;
  if (obj.discrepancy_reason !== undefined && obj.discrepancy_reason !== null) {
    if (typeof obj.discrepancy_reason !== 'string' || obj.discrepancy_reason.length > 500) {
      throw new ApiHttpException({
        statusCode: 400,
        errorCode: 'VALIDATION_ERROR',
        message: 'discrepancy_reason must be a string up to 500 characters',
      });
    }
    discrepancyReason = obj.discrepancy_reason.trim() || null;
  }

  const expectedVersion = resolveExpectedVersion(req, obj.expected_version);

  return Object.freeze({
    shiftId,
    countedClosingCashUzs,
    discrepancyReason,
    expectedVersion,
  });
}

export function validateRecordExpenseInput(rawBody: unknown): ValidatedRecordExpenseInput {
  const obj = assertPlainObject(rawBody, [
    'cash_shift_id',
    'category',
    'amount_uzs',
    'payment_method',
    'reason_and_doc',
    'reverses_expense_id',
    'allow_negative_cash_overdraft',
  ]);

  const allowOverdraft = parseOptionalStrictBoolean(
    obj.allow_negative_cash_overdraft,
    'allow_negative_cash_overdraft',
    false,
  );
  if (allowOverdraft) {
    throw new ApiHttpException({
      statusCode: 403,
      errorCode: 'POLICY_DECISION_NOT_CONFIRMED',
      message: 'Unconfirmed cash drawer overdraft policy is forbidden (11.02)',
    });
  }

  const cashShiftId = assertValidUuid(obj.cash_shift_id, 'cash_shift_id');

  if (typeof obj.category !== 'string') {
    throw new ApiHttpException({
      statusCode: 400,
      errorCode: 'VALIDATION_ERROR',
      message: 'category is required and must be a string',
    });
  }
  const category = obj.category.trim();
  if (category.length < 2 || category.length > 48) {
    throw new ApiHttpException({
      statusCode: 422,
      errorCode: 'VALIDATION_ERROR',
      message: 'category must be between 2 and 48 characters (T11.02)',
    });
  }

  const rawSignedAmountUzs = parseNonZeroMoneyOrThrow(obj.amount_uzs, 'amount_uzs');

  const methodRaw =
    typeof obj.payment_method === 'string' ? obj.payment_method.trim().toUpperCase() : '';
  if (!ALLOWED_PAYMENT_METHODS.has(methodRaw as PaymentMethod)) {
    throw new ApiHttpException({
      statusCode: 400,
      errorCode: 'VALIDATION_ERROR',
      message: 'payment_method must be CASH, CARD, CLICK, PAYME, or TRANSFER',
    });
  }
  const paymentMethod = methodRaw as PaymentMethod;

  if (typeof obj.reason_and_doc !== 'string') {
    throw new ApiHttpException({
      statusCode: 400,
      errorCode: 'VALIDATION_ERROR',
      message: 'reason_and_doc is required and must be a string',
    });
  }
  const reasonAndDoc = obj.reason_and_doc.trim();
  if (reasonAndDoc.length < 3 || reasonAndDoc.length > 255) {
    throw new ApiHttpException({
      statusCode: 422,
      errorCode: 'VALIDATION_ERROR',
      message: 'reason_and_doc must be between 3 and 255 characters (T11.02)',
    });
  }
  if (/^https?:\/\//i.test(reasonAndDoc)) {
    throw new ApiHttpException({
      statusCode: 422,
      errorCode: 'VALIDATION_ERROR',
      message: 'reason_and_doc must be local document/reason metadata, not an external URL fetch target (11.02)',
    });
  }

  const reversesExpenseId =
    obj.reverses_expense_id !== undefined && obj.reverses_expense_id !== null
      ? assertValidUuid(obj.reverses_expense_id, 'reverses_expense_id')
      : null;

  if (reversesExpenseId === null && rawSignedAmountUzs <= 0n) {
    throw new ApiHttpException({
      statusCode: 422,
      errorCode: 'VALIDATION_ERROR',
      message: 'New expense amount_uzs must be strictly positive (> 0); negative amount_uzs requires reverses_expense_id (T11.02)',
    });
  }

  return Object.freeze({
    cashShiftId,
    category,
    rawSignedAmountUzs,
    paymentMethod,
    reasonAndDoc,
    reversesExpenseId,
  });
}
