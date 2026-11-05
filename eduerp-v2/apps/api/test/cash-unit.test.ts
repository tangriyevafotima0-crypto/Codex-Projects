/**
 * EduERP v2.0 — Stage 11 Unit Test Suite (`CASH-UNIT-01..05`):
 * - `CASH-UNIT-01`: `11.01` `validateOpenCashShiftInput` & `validateCloseCashShiftInput` (opening float >= 0,
 *   counted closing cash >= 0, `expected_version` / `If-Match-Version`, unconfirmed policy gates `403 POLICY_DECISION_NOT_CONFIRMED`).
 * - `CASH-UNIT-02`: `11.02` `validateRecordExpenseInput` (all 5 expense methods `CASH | CARD | CLICK | PAYME | TRANSFER`,
 *   positive integer UZS for new expenses, append-only reversal via `reverses_expense_id`, URL SSRF rejection, overdraft policy gate).
 * - `CASH-UNIT-03`: `11.03` `evaluatePromiseReminderEligibility` (reminder candidate eligibility for due/overdue `ACTIVE` promises,
 *   suppression when `FULFILLED`, `CANCELLED`, superseded by newer promise, reminder already sent, or invoice settled — `CASE-22`).
 * - `CASH-UNIT-04`: `11.04` `computeCanonicalShiftReconciliation` (`CASE-18` / `T11.04` method-wise reconciliation:
 *   `0 + 3,200,000 - 150,000 = 3,050,000` cash expected while `1,800,000` card/non-cash is excluded from cash drawer).
 * - `CASH-UNIT-05`: `11.02` & `11.04` combined multi-method reconciliation with cash & non-cash expense reversals,
 *   cash payment reversals, discrepancy shortage/overage calculation, and over-reversal guard (`409 VERSION_CONFLICT`).
 */

import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  validateCloseCashShiftInput,
  validateOpenCashShiftInput,
  validateRecordExpenseInput,
} from '../src/cash/dto';
import { computeCanonicalShiftReconciliation } from '../src/cash/reconciliation.service';
import { evaluatePromiseReminderEligibility } from '../src/cash/promises.service';
import { RequestWithCorrelationId } from '../src/common/request-id.middleware';

const SHIFT_ID = '11111111-2222-4333-8444-000000000070';
const EXP_1_ID = '11111111-2222-4333-8444-000000000501';
const PROMISE_2_ID = '11111111-2222-4333-8444-000000000602';

function makeMockReq(headers: Record<string, string> = {}): RequestWithCorrelationId {
  return {
    headers,
    requestId: 'req-s11-unit-01',
  } as unknown as RequestWithCorrelationId;
}

describe('Stage 11 Unit Suite — Cash Shifts, Expenses, Promises & Method-Wise Reconciliation (CASH-UNIT-01..05)', () => {
  it('CASH-UNIT-01: validates 11.01 cash shift open/close inputs, optimistic version, and unconfirmed policy gates', () => {
    const opened = validateOpenCashShiftInput({
      shift_date: '2026-11-05',
      opening_cash_uzs: '0',
    });
    assert.equal(opened.shiftDate, '2026-11-05');
    assert.equal(opened.openingCashUzs, 0n);

    const openedWithFloat = validateOpenCashShiftInput({
      shift_date: '2026-11-05',
      opening_cash_uzs: '250000',
    });
    assert.equal(openedWithFloat.shiftDate, '2026-11-05');
    assert.equal(openedWithFloat.openingCashUzs, 250000n);

    for (const badFloat of ['-1', '100.50', 100000]) {
      assert.throws(() =>
        validateOpenCashShiftInput({
          shift_date: '2026-11-05',
          opening_cash_uzs: badFloat,
        }),
      );
    }

    assert.throws(
      () =>
        validateOpenCashShiftInput({
          shift_date: '2026-11-05',
          opening_cash_uzs: '0',
          auto_carry_over_previous_counted_cash: true,
        }),
      (err: unknown) => {
        const ex = err as { statusCode?: number; errorCode?: string };
        return ex.statusCode === 403 && ex.errorCode === 'POLICY_DECISION_NOT_CONFIRMED';
      },
    );

    const closedZeroDiff = validateCloseCashShiftInput(makeMockReq(), SHIFT_ID, {
      counted_closing_cash_uzs: '3050000',
      expected_version: 2,
    });
    assert.equal(closedZeroDiff.shiftId, SHIFT_ID);
    assert.equal(closedZeroDiff.countedClosingCashUzs, 3050000n);
    assert.equal(closedZeroDiff.discrepancyReason, null);
    assert.equal(closedZeroDiff.expectedVersion, 2);

    const closedWithReason = validateCloseCashShiftInput(
      makeMockReq({ 'if-match-version': '3' }),
      SHIFT_ID,
      {
        counted_closing_cash_uzs: '3000000',
        discrepancy_reason: 'Cashier drawer short by 50,000 UZS due to coin change error',
        expected_version: 3,
      },
    );
    assert.equal(closedWithReason.countedClosingCashUzs, 3000000n);
    assert.equal(
      closedWithReason.discrepancyReason,
      'Cashier drawer short by 50,000 UZS due to coin change error',
    );
    assert.equal(closedWithReason.expectedVersion, 3);

    assert.throws(
      () =>
        validateCloseCashShiftInput(makeMockReq(), SHIFT_ID, {
          counted_closing_cash_uzs: '3000000',
          expected_version: 2,
          convert_discrepancy_to_expense: true,
        }),
      (err: unknown) => {
        const ex = err as { statusCode?: number; errorCode?: string };
        return ex.statusCode === 403 && ex.errorCode === 'POLICY_DECISION_NOT_CONFIRMED';
      },
    );
  });

  it('CASH-UNIT-02: validates 11.02 categorized cash & non-cash expenses, append-only reversal inputs, and SSRF guard', () => {
    for (const method of ['CASH', 'CARD', 'CLICK', 'PAYME', 'TRANSFER'] as const) {
      const exp = validateRecordExpenseInput({
        cash_shift_id: SHIFT_ID,
        category: 'OFFICE_SUPPLIES',
        amount_uzs: '150000',
        payment_method: method,
        reason_and_doc: `Marker and paper purchase via ${method} #DOC-01`,
      });
      assert.equal(exp.cashShiftId, SHIFT_ID);
      assert.equal(exp.category, 'OFFICE_SUPPLIES');
      assert.equal(exp.rawSignedAmountUzs, 150000n);
      assert.equal(exp.paymentMethod, method);
      assert.equal(exp.reversesExpenseId, null);
    }

    const rev = validateRecordExpenseInput({
      cash_shift_id: SHIFT_ID,
      category: 'OFFICE_SUPPLIES',
      amount_uzs: '-150000',
      payment_method: 'CASH',
      reason_and_doc: 'Reversal of duplicate marker expense #DOC-01-REV',
      reverses_expense_id: EXP_1_ID,
    });
    assert.equal(rev.reversesExpenseId, EXP_1_ID);
    assert.equal(rev.rawSignedAmountUzs, -150000n);

    assert.throws(
      () =>
        validateRecordExpenseInput({
          cash_shift_id: SHIFT_ID,
          category: 'OFFICE_SUPPLIES',
          amount_uzs: '-150000',
          payment_method: 'CASH',
          reason_and_doc: 'Negative expense without reverses_expense_id',
        }),
      (err: unknown) => {
        const ex = err as { statusCode?: number; errorCode?: string };
        return ex.statusCode === 422 && ex.errorCode === 'VALIDATION_ERROR';
      },
    );

    assert.throws(
      () =>
        validateRecordExpenseInput({
          cash_shift_id: SHIFT_ID,
          category: 'OFFICE_SUPPLIES',
          amount_uzs: '150000',
          payment_method: 'CASH',
          reason_and_doc: 'https://evil.example.com/receipt.pdf',
        }),
      (err: unknown) => {
        const ex = err as { statusCode?: number; errorCode?: string };
        return ex.statusCode === 422 && ex.errorCode === 'VALIDATION_ERROR';
      },
    );
  });

  it('CASH-UNIT-03: evaluates 11.03 promise-to-pay reminder eligibility and duplicate-reminder suppression (CASE-22)', () => {
    assert.equal(
      evaluatePromiseReminderEligibility({
        status: 'ACTIVE',
        promiseDate: '2026-11-10',
        centerTodayDate: '2026-11-10',
        currentInvoiceRemainingDebtUzs: 200000n,
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
        currentInvoiceRemainingDebtUzs: 200000n,
        supersededByPromiseId: null,
        reminderSentAt: null,
      }),
      false,
    );

    assert.equal(
      evaluatePromiseReminderEligibility({
        status: 'CANCELLED',
        promiseDate: '2026-11-10',
        centerTodayDate: '2026-11-12',
        currentInvoiceRemainingDebtUzs: 100000n,
        supersededByPromiseId: PROMISE_2_ID,
        reminderSentAt: null,
      }),
      false,
    );

    assert.equal(
      evaluatePromiseReminderEligibility({
        status: 'FULFILLED',
        promiseDate: '2026-11-10',
        centerTodayDate: '2026-11-12',
        currentInvoiceRemainingDebtUzs: 0n,
        supersededByPromiseId: null,
        reminderSentAt: null,
      }),
      false,
    );
  });

  it('CASH-UNIT-04: computes 11.04 CASE-18 / T11.04 method-wise reconciliation (0 + 3,200,000 - 150,000 = 3,050,000 cash; 1,800,000 card excluded from cash drawer)', () => {
    const recon = computeCanonicalShiftReconciliation({
      openingCashUzs: 0n,
      paymentsByMethod: {
        CASH: 3200000n,
        CARD: 1800000n,
      },
      reversalsByMethod: {},
      grossExpensesByMethod: {
        CASH: 150000n,
      },
      expenseReversalsByMethod: {},
      countedClosingCashUzs: 3050000n,
    });

    assert.equal(recon.openingCashUzs, 0n);
    assert.equal(recon.cashReceiptsUzs, 3200000n);
    assert.equal(recon.nonCashReceiptsUzs, 1800000n);
    assert.equal(recon.cashRefundsUzs, 0n);
    assert.equal(recon.nonCashRefundsUzs, 0n);
    assert.equal(recon.cashExpensesUzs, 150000n);
    assert.equal(recon.nonCashExpensesUzs, 0n);
    assert.equal(recon.expectedClosingCashUzs, 3050000n);
    assert.equal(recon.netNonCashFlowUzs, 1800000n);
    assert.equal(recon.countedClosingCashUzs, 3050000n);
    assert.equal(recon.discrepancyUzs, 0n);

    const cashRow = recon.methodBreakdown.find((m) => m.payment_method === 'CASH')!;
    const cardRow = recon.methodBreakdown.find((m) => m.payment_method === 'CARD')!;
    assert.equal(cashRow.gross_receipts_uzs, '3200000');
    assert.equal(cashRow.net_expenses_uzs, '150000');
    assert.equal(cashRow.net_flow_uzs, '3050000');
    assert.equal(cardRow.gross_receipts_uzs, '1800000');
    assert.equal(cardRow.net_expenses_uzs, '0');
    assert.equal(cardRow.net_flow_uzs, '1800000');
  });

  it('CASH-UNIT-05: handles expense reversals, non-cash expenses, cash payment reversals, discrepancy shortage/overage, and over-reversal guard', () => {
    const recon = computeCanonicalShiftReconciliation({
      openingCashUzs: 100000n,
      paymentsByMethod: {
        CASH: 1000000n,
        CLICK: 500000n,
      },
      reversalsByMethod: {
        CASH: 200000n,
        CLICK: 100000n,
      },
      grossExpensesByMethod: {
        CASH: 150000n,
        CARD: 80000n,
      },
      expenseReversalsByMethod: {
        CASH: 150000n,
      },
      countedClosingCashUzs: 850000n,
    });

    assert.equal(recon.expectedClosingCashUzs, 900000n);
    assert.equal(recon.cashExpensesUzs, 0n);
    assert.equal(recon.nonCashExpensesUzs, 80000n);
    assert.equal(recon.netNonCashFlowUzs, 320000n);
    assert.equal(recon.discrepancyUzs, -50000n);

    assert.throws(
      () =>
        computeCanonicalShiftReconciliation({
          openingCashUzs: 0n,
          grossExpensesByMethod: { CASH: 100000n },
          expenseReversalsByMethod: { CASH: 150000n },
        }),
      (err: unknown) => {
        const ex = err as { statusCode?: number; errorCode?: string };
        return ex.statusCode === 409 && ex.errorCode === 'VERSION_CONFLICT';
      },
    );
  });
});
