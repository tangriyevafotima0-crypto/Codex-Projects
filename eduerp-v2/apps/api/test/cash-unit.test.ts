import assert from 'node:assert/strict';
import test from 'node:test';

import { ValidationException } from '../src/common/exceptions/domain.exceptions';
import {
  computeExpectedClosingCashMinor,
  computePaymentMethodBreakdown,
  computeShiftNetTotals,
  computeShiftReconciliationSummary,
  computeShiftVarianceSummary,
  evaluatePromiseRolloverStatus,
  validateCloseCashShiftDto,
  validateCreateCashExpenseDto,
  validateCreatePaymentPromiseDto,
  validateFulfillPromiseDto,
  validateListExpensesQuery,
  validateListPromisesQuery,
  validateListShiftsQuery,
  validateOpenCashShiftDto,
  validateReconciliationQuery,
  validateReverseCashExpenseDto,
  validateSupersedePromiseDto,
} from '../src/cash/index';

test('CASH-UNIT-01: shift net totals, expected closing cash, variance, and reconciliation summary are deterministic integer minor-unit calculations', () => {
  const breakdown = computePaymentMethodBreakdown({
    receipts: [
      { payment_method: 'CASH', amount_minor: '150000' },
      { payment_method: 'CASH', amount_minor: '50000' },
      { payment_method: 'CLICK', amount_minor: '100000' },
      { payment_method: 'PAYME', amount_minor: '75000' },
    ],
    reversals: [
      { payment_method: 'CASH', reversed_amount_minor: '30000' },
      { payment_method: 'CLICK', reversed_amount_minor: '20000' },
    ],
  });

  const cashRow = breakdown.find((row) => row.payment_method === 'CASH');
  assert.ok(cashRow);
  assert.equal(cashRow.gross_receipts_minor, '200000');
  assert.equal(cashRow.reversals_minor, '30000');
  assert.equal(cashRow.net_receipts_minor, '170000');
  assert.equal(cashRow.receipt_count, 2);
  assert.equal(cashRow.reversal_count, 1);

  const clickRow = breakdown.find((row) => row.payment_method === 'CLICK');
  assert.ok(clickRow);
  assert.equal(clickRow.gross_receipts_minor, '100000');
  assert.equal(clickRow.reversals_minor, '20000');
  assert.equal(clickRow.net_receipts_minor, '80000');

  const totals = computeShiftNetTotals({
    openingCashMinor: '50000',
    grossCashReceiptsMinor: '200000',
    cashReversalsMinor: '30000',
    grossExpensesMinor: '40000',
    expenseReversalsMinor: '10000',
  });

  assert.equal(totals.net_cash_receipts_minor, '170000');
  assert.equal(totals.net_cash_expenses_minor, '30000');
  assert.equal(totals.expected_closing_cash_minor, '190000');

  const expectedClosing = computeExpectedClosingCashMinor({
    openingCashMinor: '50000',
    grossCashReceiptsMinor: '200000',
    cashReversalsMinor: '30000',
    grossExpensesMinor: '40000',
    expenseReversalsMinor: '10000',
  });
  assert.equal(expectedClosing, '190000');

  const balanced = computeShiftVarianceSummary({
    expectedClosingCashMinor: '190000',
    actualCountedCashMinor: '190000',
  });
  assert.equal(balanced.variance_minor, '0');
  assert.equal(balanced.is_balanced, true);
  assert.equal(balanced.requires_variance_note, false);

  const shortage = computeShiftVarianceSummary({
    expectedClosingCashMinor: '190000',
    actualCountedCashMinor: '185000',
  });
  assert.equal(shortage.variance_minor, '-5000');
  assert.equal(shortage.is_balanced, false);
  assert.equal(shortage.requires_variance_note, true);

  const summary = computeShiftReconciliationSummary({
    openingCashMinor: '50000',
    actualCountedCashMinor: '185000',
    grossExpensesMinor: '40000',
    expenseReversalsMinor: '10000',
    ledgerCashInflowMinor: '200000',
    ledgerCashOutflowMinor: '60000',
    receipts: [
      { payment_method: 'CASH', amount_minor: '200000' },
      { payment_method: 'CLICK', amount_minor: '100000' },
    ],
    reversals: [{ payment_method: 'CASH', reversed_amount_minor: '30000' }],
  });

  assert.equal(summary.expected_closing_cash_minor, '190000');
  assert.equal(summary.variance_minor, '-5000');
  assert.equal(summary.net_all_methods_receipts_minor, '270000');
  assert.equal(summary.ledger_cash_net_minor, '140000');
  assert.equal(summary.ledger_matches_operational, true);
});

test('CASH-UNIT-02: promise rollover status evaluator respects terminal states, invoice balance, and due_on date', () => {
  assert.equal(
    evaluatePromiseRolloverStatus({
      currentStatus: 'ACTIVE',
      promisedAmountMinor: '100000',
      invoiceBalanceDueMinor: '0',
      dueOn: '2026-11-10',
      asOfDate: '2026-11-05',
    }),
    'FULFILLED',
  );

  assert.equal(
    evaluatePromiseRolloverStatus({
      currentStatus: 'ACTIVE',
      promisedAmountMinor: '100000',
      invoiceBalanceDueMinor: '50000',
      dueOn: '2026-11-04',
      asOfDate: '2026-11-05',
    }),
    'BROKEN',
  );

  assert.equal(
    evaluatePromiseRolloverStatus({
      currentStatus: 'OVERDUE_NOTIFIED',
      promisedAmountMinor: '100000',
      invoiceBalanceDueMinor: '50000',
      dueOn: '2026-11-04',
      asOfDate: '2026-11-05',
    }),
    'BROKEN',
  );

  assert.equal(
    evaluatePromiseRolloverStatus({
      currentStatus: 'ACTIVE',
      promisedAmountMinor: '100000',
      invoiceBalanceDueMinor: '50000',
      dueOn: '2026-11-05',
      asOfDate: '2026-11-05',
    }),
    'ACTIVE',
  );

  assert.equal(
    evaluatePromiseRolloverStatus({
      currentStatus: 'SUPERSEDED',
      promisedAmountMinor: '100000',
      invoiceBalanceDueMinor: '0',
      dueOn: '2026-11-01',
      asOfDate: '2026-11-05',
    }),
    'SUPERSEDED',
  );
});

test('CASH-UNIT-03: shift DTO validators accept canonical payloads and reject malformed or negative inputs', () => {
  const validOpen = validateOpenCashShiftDto({
    center_id: '10000000-0000-4000-8000-000000000001',
    shift_date: '2026-11-05',
    opening_cash_minor: '50000',
    notes: 'Morning drawer float',
    test_fail_after_step: 'SHIFT_INSERT',
  });
  assert.equal(validOpen.opening_cash_minor, '50000');
  assert.equal(validOpen.test_fail_after_step, 'SHIFT_INSERT');

  assert.throws(
    () =>
      validateOpenCashShiftDto({
        center_id: '10000000-0000-4000-8000-000000000001',
        shift_date: '2026-11-05',
        opening_cash_minor: '-100',
      }),
    ValidationException,
  );

  const validClose = validateCloseCashShiftDto({
    center_id: '10000000-0000-4000-8000-000000000001',
    actual_counted_cash_minor: '190000',
    variance_note: 'Exact count verified by cashier and admin',
    test_fail_after_step: 'SHIFT_CLOSE_UPDATE',
  });
  assert.equal(validClose.actual_counted_cash_minor, '190000');
  assert.equal(validClose.test_fail_after_step, 'SHIFT_CLOSE_UPDATE');

  assert.throws(
    () =>
      validateCloseCashShiftDto({
        center_id: '10000000-0000-4000-8000-000000000001',
        actual_counted_cash_minor: '190000.50',
      }),
    ValidationException,
  );

  const listShifts = validateListShiftsQuery({
    center_id: '10000000-0000-4000-8000-000000000001',
    status: 'OPEN',
  });
  assert.equal(listShifts.status, 'OPEN');

  assert.throws(
    () =>
      validateListShiftsQuery({
        center_id: '10000000-0000-4000-8000-000000000001',
        status: 'INVALID',
      }),
    ValidationException,
  );
});

test('CASH-UNIT-04: expense and reversal DTO validators enforce positive integer amounts, categories, reasons, and OUTBOX_EVENT fault step', () => {
  const validExpense = validateCreateCashExpenseDto({
    center_id: '10000000-0000-4000-8000-000000000001',
    cash_shift_id: '10000000-0000-4000-8000-000000000002',
    category_code: 'SUPPLIES',
    amount_minor: '25000',
    description: 'Whiteboard markers and printer paper',
    voucher_number: 'VCH-001',
    test_fail_after_step: 'OUTBOX_EVENT',
  });
  assert.equal(validExpense.category_code, 'SUPPLIES');
  assert.equal(validExpense.amount_minor, '25000');
  assert.equal(validExpense.test_fail_after_step, 'OUTBOX_EVENT');

  assert.throws(
    () =>
      validateCreateCashExpenseDto({
        center_id: '10000000-0000-4000-8000-000000000001',
        cash_shift_id: '10000000-0000-4000-8000-000000000002',
        category_code: 'UNKNOWN_CATEGORY',
        amount_minor: '25000',
        description: 'Invalid category',
      }),
    ValidationException,
  );

  assert.throws(
    () =>
      validateCreateCashExpenseDto({
        center_id: '10000000-0000-4000-8000-000000000001',
        cash_shift_id: '10000000-0000-4000-8000-000000000002',
        category_code: 'SUPPLIES',
        amount_minor: '0',
        description: 'Zero amount not allowed',
      }),
    ValidationException,
  );

  const validReverse = validateReverseCashExpenseDto({
    center_id: '10000000-0000-4000-8000-000000000001',
    reversal_reason: 'Duplicate voucher entry recorded in error',
    test_fail_after_step: 'OUTBOX_EVENT',
  });
  assert.equal(validReverse.test_fail_after_step, 'OUTBOX_EVENT');

  assert.throws(
    () =>
      validateReverseCashExpenseDto({
        center_id: '10000000-0000-4000-8000-000000000001',
        reversal_reason: 'short',
      }),
    ValidationException,
  );

  const expenseQuery = validateListExpensesQuery({
    center_id: '10000000-0000-4000-8000-000000000001',
    status: 'RECORDED',
  });
  assert.equal(expenseQuery.status, 'RECORDED');
});

test('CASH-UNIT-05: payment promise DTO validators enforce canonical statuses (including OVERDUE_NOTIFIED), due dates, and supersede/fulfill payloads', () => {
  const validPromise = validateCreatePaymentPromiseDto({
    center_id: '10000000-0000-4000-8000-000000000001',
    student_id: '10000000-0000-4000-8000-000000000002',
    invoice_id: '10000000-0000-4000-8000-000000000003',
    promised_amount_minor: '150000',
    due_on: '2026-11-12',
    reason: 'Guardian requested salary date deferral until 12th',
    test_fail_after_step: 'PROMISE_INSERT',
  });
  assert.equal(validPromise.promised_amount_minor, '150000');
  assert.equal(validPromise.due_on, '2026-11-12');

  const validSupersede = validateSupersedePromiseDto({
    center_id: '10000000-0000-4000-8000-000000000001',
    promised_amount_minor: '120000',
    due_on: '2026-11-15',
    reason: 'Partial payment made; remaining promised by 15th',
    test_fail_after_step: 'PROMISE_UPDATE',
  });
  assert.equal(validSupersede.due_on, '2026-11-15');

  const validFulfill = validateFulfillPromiseDto({
    center_id: '10000000-0000-4000-8000-000000000001',
    resolution_note: 'Paid via cash receipt RCP-2026-000101',
    test_fail_after_step: 'OUTBOX_EVENT',
  });
  assert.equal(validFulfill.test_fail_after_step, 'OUTBOX_EVENT');

  const listPromises = validateListPromisesQuery({
    center_id: '10000000-0000-4000-8000-000000000001',
    status: 'OVERDUE_NOTIFIED',
    due_on_or_before: '2026-11-10',
    as_of_date: '2026-11-11',
  });
  assert.equal(listPromises.status, 'OVERDUE_NOTIFIED');
  assert.equal(listPromises.due_on_or_before, '2026-11-10');
  assert.equal(listPromises.as_of_date, '2026-11-11');

  assert.throws(
    () =>
      validateListPromisesQuery({
        center_id: '10000000-0000-4000-8000-000000000001',
        due_on_or_before: 'not-a-date',
      }),
    ValidationException,
  );

  const reconQuery = validateReconciliationQuery({
    center_id: '10000000-0000-4000-8000-000000000001',
    shift_date: '2026-11-05',
  });
  assert.equal(reconQuery.shift_date, '2026-11-05');
});

test('CASH-UNIT-06: shift reconciliation summary detects missing per-record or per-method ledger postings even when aggregate cash net happens to match', () => {
  const missingClickLedger = computeShiftReconciliationSummary({
    openingCashMinor: '50000',
    actualCountedCashMinor: '200000',
    grossExpensesMinor: '0',
    expenseReversalsMinor: '0',
    ledgerCashInflowMinor: '150000',
    ledgerCashOutflowMinor: '0',
    receipts: [
      { payment_method: 'CASH', amount_minor: '150000' },
      { payment_method: 'CLICK', amount_minor: '100000' },
    ],
    reversals: [],
    ledgerMethodCounters: [
      {
        payment_method: 'CASH',
        gross_receipts_minor: '150000',
        reversals_minor: '0',
        receipt_count: 1,
        reversal_count: 0,
      },
    ],
    missingLedgerCounts: {
      missing_receipt_ledger_count: 1,
      missing_payment_reversal_ledger_count: 0,
      missing_expense_ledger_count: 0,
      missing_expense_reversal_ledger_count: 0,
    },
  });

  assert.equal(missingClickLedger.ledger_matches_operational, false);
  assert.equal(
    missingClickLedger.ledger_completeness.missing_receipt_ledger_count,
    1,
  );
  const clickBreakdown = missingClickLedger.method_breakdown.find(
    (m) => m.payment_method === 'CLICK',
  );
  assert.ok(clickBreakdown);
  assert.equal(clickBreakdown.ledger_matches_operational, false);

  const offsetCashError = computeShiftReconciliationSummary({
    openingCashMinor: '50000',
    actualCountedCashMinor: '50000',
    grossExpensesMinor: '40000',
    expenseReversalsMinor: '0',
    ledgerCashInflowMinor: '0',
    ledgerCashOutflowMinor: '0',
    receipts: [{ payment_method: 'CASH', amount_minor: '40000' }],
    reversals: [],
    ledgerMethodCounters: [
      {
        payment_method: 'CASH',
        gross_receipts_minor: '0',
        reversals_minor: '0',
        receipt_count: 0,
        reversal_count: 0,
      },
    ],
    missingLedgerCounts: {
      missing_receipt_ledger_count: 1,
      missing_payment_reversal_ledger_count: 0,
      missing_expense_ledger_count: 1,
      missing_expense_reversal_ledger_count: 0,
    },
  });

  assert.equal(offsetCashError.expected_closing_cash_minor, '50000');
  assert.equal(offsetCashError.ledger_cash_net_minor, '0');
  assert.equal(offsetCashError.ledger_matches_operational, false);
});
