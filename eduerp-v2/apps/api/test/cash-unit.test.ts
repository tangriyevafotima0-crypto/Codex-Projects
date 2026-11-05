/**
 * EduERP v2.0 — Stage 11 Cash Shifts, Categorized Expenses, Promise-to-Pay & Method-Wise Reconciliation
 * Pure Unit Test Suite (`CASH-UNIT-01..06`).
 */

import * as assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { describe, it } from 'node:test';
import { ApiHttpException } from '../src/auth/auth.errors';
import {
  validateCloseCashShiftInput,
  validateOpenCashShiftInput,
  validateRecordExpenseInput,
} from '../src/cash/dto';
import { evaluatePromiseReminderEligibility } from '../src/cash/promises.service';
import { computeCanonicalShiftReconciliation } from '../src/cash/reconciliation.service';
import { RequestWithCorrelationId } from '../src/common/request-id.middleware';

function makeMockReq(headers: Record<string, string> = {}): RequestWithCorrelationId {
  return {
    headers,
    requestId: 'req-s11-unit-01',
  } as unknown as RequestWithCorrelationId;
}

describe('Stage 11 — Cash Shifts, Expenses, Promises & Method-Wise Reconciliation Unit Suite (CASH-UNIT-01..06)', () => {
  it('CASH-UNIT-01: validates OpenCashShift & CloseCashShift DTOs, integer UZS bounds, If-Match version, and unconfirmed policy gates', () => {
    const validOpen = validateOpenCashShiftInput({
      shift_date: '2026-11-05',
      opening_cash_uzs: '250000',
    });
    assert.equal(validOpen.shiftDate, '2026-11-05');
    assert.equal(validOpen.openingCashUzs, 250000n);

    const zeroOpen = validateOpenCashShiftInput({
      shift_date: '2026-11-05',
      opening_cash_uzs: '0',
    });
    assert.equal(zeroOpen.openingCashUzs, 0n);

    for (const badAmount of ['-100', '100.50', 'abc', '']) {
      assert.throws(
        () =>
          validateOpenCashShiftInput({
            shift_date: '2026-11-05',
            opening_cash_uzs: badAmount,
          }),
        (err: unknown) =>
          err instanceof ApiHttpException &&
          err.statusCode === 400 &&
          err.errorCode === 'VALIDATION_ERROR',
      );
    }

    assert.throws(
      () =>
        validateOpenCashShiftInput({
          shift_date: '2026-11-05',
          opening_cash_uzs: '0',
          auto_carry_over_previous_counted_cash: true,
        }),
      (err: unknown) =>
        err instanceof ApiHttpException &&
        err.statusCode === 403 &&
        err.errorCode === 'POLICY_DECISION_NOT_CONFIRMED',
    );

    const shiftId = crypto.randomUUID();
    const validClose = validateCloseCashShiftInput(
      makeMockReq({ 'if-match-version': '3' }),
      shiftId,
      {
        counted_closing_cash_uzs: '3050000',
        discrepancy_reason: 'Exact count verified',
        expected_version: 3,
      },
    );
    assert.equal(validClose.shiftId, shiftId);
    assert.equal(validClose.countedClosingCashUzs, 3050000n);
    assert.equal(validClose.expectedVersion, 3);
    assert.equal(validClose.discrepancyReason, 'Exact count verified');

    assert.throws(
      () =>
        validateCloseCashShiftInput(
          makeMockReq({ 'if-match-version': '4' }),
          shiftId,
          {
            counted_closing_cash_uzs: '3050000',
            expected_version: 3,
          },
        ),
      (err: unknown) =>
        err instanceof ApiHttpException &&
        err.statusCode === 409 &&
        err.errorCode === 'VERSION_CONFLICT',
    );

    assert.throws(
      () =>
        validateCloseCashShiftInput(makeMockReq(), shiftId, {
          counted_closing_cash_uzs: '3000000',
          expected_version: 1,
          convert_discrepancy_to_expense: true,
        }),
      (err: unknown) =>
        err instanceof ApiHttpException &&
        err.statusCode === 403 &&
        err.errorCode === 'POLICY_DECISION_NOT_CONFIRMED',
    );
  });

  it('CASH-UNIT-02: validates RecordExpense DTOs, positive vs negative reversal rules, and overdraft policy gate', () => {
    const shiftId = crypto.randomUUID();
    const origExpenseId = crypto.randomUUID();

    const posExpense = validateRecordExpenseInput({
      cash_shift_id: shiftId,
      category: 'OFFICE_SUPPLIES',
      amount_uzs: '150000',
      payment_method: 'CASH',
      reason_and_doc: 'A4 paper and markers #INV-2026-11',
    });
    assert.equal(posExpense.rawSignedAmountUzs, 150000n);
    assert.equal(posExpense.reversesExpenseId, null);

    assert.throws(
      () =>
        validateRecordExpenseInput({
          cash_shift_id: shiftId,
          category: 'OFFICE_SUPPLIES',
          amount_uzs: '-150000',
          payment_method: 'CASH',
          reason_and_doc: 'Negative expense without target',
        }),
      (err: unknown) =>
        err instanceof ApiHttpException &&
        err.statusCode === 422 &&
        err.errorCode === 'VALIDATION_ERROR',
    );

    const negReversal = validateRecordExpenseInput({
      cash_shift_id: shiftId,
      category: 'OFFICE_SUPPLIES',
      amount_uzs: '-150000',
      payment_method: 'CASH',
      reason_and_doc: 'Reverse duplicate marker entry #INV-2026-11',
      reverses_expense_id: origExpenseId,
    });
    assert.equal(negReversal.rawSignedAmountUzs, -150000n);
    assert.equal(negReversal.reversesExpenseId, origExpenseId);

    assert.throws(
      () =>
        validateRecordExpenseInput({
          cash_shift_id: shiftId,
          category: 'RENT',
          amount_uzs: '5000000',
          payment_method: 'CASH',
          reason_and_doc: 'Monthly rent payment',
          allow_negative_cash_overdraft: true,
        }),
      (err: unknown) =>
        err instanceof ApiHttpException &&
        err.statusCode === 403 &&
        err.errorCode === 'POLICY_DECISION_NOT_CONFIRMED',
    );
  });

  it('CASH-UNIT-03: computes CASE-18 / T11.04 reconciliation (0 opening + 3,200,000 CASH + 1,800,000 CARD - 150,000 CASH expense => 3,050,000 expected cash)', () => {
    const recon = computeCanonicalShiftReconciliation({
      openingCashUzs: 0n,
      paymentsByMethod: {
        CASH: 3_200_000n,
        CARD: 1_800_000n,
      },
      reversalsByMethod: {},
      grossExpensesByMethod: {
        CASH: 150_000n,
      },
      expenseReversalsByMethod: {},
      countedClosingCashUzs: 3_000_000n,
    });

    assert.equal(recon.openingCashUzs, 0n);
    assert.equal(recon.cashReceiptsUzs, 3_200_000n);
    assert.equal(recon.nonCashReceiptsUzs, 1_800_000n);
    assert.equal(recon.cashRefundsUzs, 0n);
    assert.equal(recon.nonCashRefundsUzs, 0n);
    assert.equal(recon.cashExpensesUzs, 150_000n);
    assert.equal(recon.nonCashExpensesUzs, 0n);
    assert.equal(recon.expectedClosingCashUzs, 3_050_000n);
    assert.equal(recon.netNonCashFlowUzs, 1_800_000n);
    assert.equal(recon.discrepancyUzs, -50_000n);
  });

  it('CASH-UNIT-04: computes multi-method reconciliation with CASH/CARD/CLICK/PAYME/TRANSFER receipts, refunds, non-cash expenses, and expense reversals', () => {
    const recon = computeCanonicalShiftReconciliation({
      openingCashUzs: 500_000n,
      paymentsByMethod: {
        CASH: 2_000_000n,
        CARD: 1_000_000n,
        CLICK: 600_000n,
        PAYME: 400_000n,
        TRANSFER: 500_000n,
      },
      reversalsByMethod: {
        CASH: 300_000n,
        CLICK: 200_000n,
      },
      grossExpensesByMethod: {
        CASH: 200_000n,
        TRANSFER: 100_000n,
      },
      expenseReversalsByMethod: {
        CASH: 50_000n,
      },
      countedClosingCashUzs: 2_050_000n,
    });

    assert.equal(recon.expectedClosingCashUzs, 2_050_000n);
    assert.equal(recon.netNonCashFlowUzs, 2_200_000n);
    assert.equal(recon.discrepancyUzs, 0n);

    const clickBreakdown = recon.methodBreakdown.find((m) => m.payment_method === 'CLICK')!;
    assert.equal(clickBreakdown.gross_receipts_uzs, '600000');
    assert.equal(clickBreakdown.refunds_and_reversals_uzs, '200000');
    assert.equal(clickBreakdown.net_expenses_uzs, '0');
    assert.equal(clickBreakdown.net_flow_uzs, '400000');

    const transferBreakdown = recon.methodBreakdown.find((m) => m.payment_method === 'TRANSFER')!;
    assert.equal(transferBreakdown.gross_receipts_uzs, '500000');
    assert.equal(transferBreakdown.refunds_and_reversals_uzs, '0');
    assert.equal(transferBreakdown.net_expenses_uzs, '100000');
    assert.equal(transferBreakdown.net_flow_uzs, '400000');
  });

  it('CASH-UNIT-05: rejects expense reversals exceeding gross expenses with 409 VERSION_CONFLICT', () => {
    assert.throws(
      () =>
        computeCanonicalShiftReconciliation({
          openingCashUzs: 100_000n,
          grossExpensesByMethod: { CASH: 50_000n },
          expenseReversalsByMethod: { CASH: 100_000n },
        }),
      (err: unknown) =>
        err instanceof ApiHttpException &&
        err.statusCode === 409 &&
        err.errorCode === 'VERSION_CONFLICT',
    );
  });

  it('CASH-UNIT-06: evaluates Promise-to-Pay due reminder eligibility (CASE-11 & CASE-22)', () => {
    assert.equal(
      evaluatePromiseReminderEligibility({
        status: 'ACTIVE',
        promiseDate: '2026-11-10',
        centerTodayDate: '2026-11-10',
        currentInvoiceRemainingDebtUzs: 300_000n,
        supersededByPromiseId: null,
        reminderSentAt: null,
      }),
      true,
    );

    assert.equal(
      evaluatePromiseReminderEligibility({
        status: 'ACTIVE',
        promiseDate: '2026-11-10',
        centerTodayDate: '2026-11-09',
        currentInvoiceRemainingDebtUzs: 300_000n,
        supersededByPromiseId: null,
        reminderSentAt: null,
      }),
      false,
    );

    assert.equal(
      evaluatePromiseReminderEligibility({
        status: 'FULFILLED',
        promiseDate: '2026-11-10',
        centerTodayDate: '2026-11-10',
        currentInvoiceRemainingDebtUzs: 0n,
        supersededByPromiseId: null,
        reminderSentAt: null,
      }),
      false,
    );

    assert.equal(
      evaluatePromiseReminderEligibility({
        status: 'CANCELLED',
        promiseDate: '2026-11-10',
        centerTodayDate: '2026-11-10',
        currentInvoiceRemainingDebtUzs: 200_000n,
        supersededByPromiseId: crypto.randomUUID(),
        reminderSentAt: null,
      }),
      false,
    );
  });
});
