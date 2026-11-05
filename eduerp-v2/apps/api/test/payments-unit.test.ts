/**
 * EduERP v2.0 — Stage 10 Unit Test Suite (`PAY-UNIT-01..05`):
 * - `PAY-UNIT-01`: `10.01` & `OWNER-20261105-05` `validateRecordPaymentInput` (all 5 manual payment methods,
 *   BigInt money bounds, dual timestamps `paid_at` vs `recorded_at`, future `paid_at` rejection, closed-shift backfill gate).
 * - `PAY-UNIT-02`: `10.02` `planPaymentAllocations` (`CASE-11` partial payment 500k-300k=200k + mandatory `promise_date`,
 *   `CASE-12` overpayment 600k on 500k -> 500k allocation + 100k `UnappliedCredit`, multi-invoice ordered & explicit allocations, cross-student guard).
 * - `PAY-UNIT-03`: `10.03` & `OWNER-20261105-05` `validateCreateReversalInput` & `validateApproveReversalInput`
 *   (reason bounds, `CLOSE_WITH_CREDIT_NOTE` & gateway refund `403 POLICY_DECISION_NOT_CONFIRMED` gate).
 * - `PAY-UNIT-04`: `10.03` `planPaymentReversalUnwind` (`CASE-13` 4,000,000 error storno -> 400,000 net,
 *   `CASE-14` partial refund 150,000 of 400,000 cap & exact invoice debt restoration).
 * - `PAY-UNIT-05`: `10.04` `formatInternalReceiptNumber` (`RCP-YYYYMM-NNNNNN` formatting & bounds).
 */

import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  validateApproveReversalInput,
  validateCreateReversalInput,
  validateRecordPaymentInput,
} from '../src/payments/dto';
import { planPaymentAllocations } from '../src/payments/allocation.service';
import { formatInternalReceiptNumber } from '../src/payments/receipts.service';
import { planPaymentReversalUnwind } from '../src/payments/reversal.service';

const STUDENT_ID = '11111111-2222-4333-8444-000000000040';
const OTHER_STUDENT_ID = '11111111-2222-4333-8444-000000000099';
const SHIFT_ID = '11111111-2222-4333-8444-000000000070';
const INV_1_ID = '11111111-2222-4333-8444-000000000101';
const INV_2_ID = '11111111-2222-4333-8444-000000000102';
const ENR_1_ID = '11111111-2222-4333-8444-000000000201';
const PAY_1_ID = '11111111-2222-4333-8444-000000000301';
const REV_1_ID = '11111111-2222-4333-8444-000000000401';

describe('Stage 10 Unit Suite — Manual Payments, Allocations, Promises, Reversals & Receipts (PAY-UNIT-01..05)', () => {
  it('PAY-UNIT-01: validates 10.01 manual payment methods, BigInt money bounds, dual timestamps (paid_at vs recorded_at), and OWNER-20261105-05 gates', () => {
    const serverNow = new Date('2026-11-05T10:00:00.000Z');
    const centerToday = '2026-11-05';

    for (const method of ['CASH', 'CARD', 'CLICK', 'PAYME', 'TRANSFER'] as const) {
      const res = validateRecordPaymentInput(
        {
          student_id: STUDENT_ID,
          cash_shift_id: SHIFT_ID,
          amount_uzs: '480000',
          currency: 'UZS',
          payment_method: method,
          paid_at: '2026-11-04T15:30:00.000Z',
          external_reference: `REF-${method}-001`,
          payment_note: `Manual ${method} entry`,
        },
        serverNow,
        centerToday,
      );
      assert.equal(res.paymentMethod, method);
      assert.equal(res.amountUzs, 480000n);
      assert.equal(res.paidAtUtc, '2026-11-04T15:30:00.000Z');
      assert.equal(res.recordedAtUtc, '2026-11-05T10:00:00.000Z');
      assert.equal(res.isLateEntry, true);
      assert.equal(res.externalReference, `REF-${method}-001`);
    }

    // Lossless BigInt above Number.MAX_SAFE_INTEGER (9007199254740993)
    const huge = validateRecordPaymentInput(
      {
        student_id: STUDENT_ID,
        cash_shift_id: SHIFT_ID,
        amount_uzs: '9007199254740993',
        currency: 'UZS',
        payment_method: 'TRANSFER',
      },
      serverNow,
      centerToday,
    );
    assert.equal(huge.amountUzs, 9007199254740993n);
    assert.equal(huge.isLateEntry, false);

    // Rejects float/number, zero, negative, and int64 overflow
    for (const badAmount of [300000, '0', '-50000', '300000.50', '9223372036854775808']) {
      assert.throws(() =>
        validateRecordPaymentInput(
          {
            student_id: STUDENT_ID,
            cash_shift_id: SHIFT_ID,
            amount_uzs: badAmount,
            currency: 'UZS',
            payment_method: 'CASH',
          },
          serverNow,
          centerToday,
        ),
      );
    }

    // Rejects future paid_at > recorded_at with 422 VALIDATION_ERROR
    assert.throws(
      () =>
        validateRecordPaymentInput(
          {
            student_id: STUDENT_ID,
            cash_shift_id: SHIFT_ID,
            amount_uzs: '300000',
            currency: 'UZS',
            payment_method: 'CLICK',
            paid_at: '2026-11-05T10:00:01.000Z',
          },
          serverNow,
          centerToday,
        ),
      (err: unknown) => {
        const ex = err as { statusCode?: number; errorCode?: string };
        return ex.statusCode === 422 && ex.errorCode === 'VALIDATION_ERROR';
      },
    );

    // Rejects closed shift backfill / reopen flags with 403 POLICY_DECISION_NOT_CONFIRMED
    assert.throws(
      () =>
        validateRecordPaymentInput(
          {
            student_id: STUDENT_ID,
            cash_shift_id: SHIFT_ID,
            amount_uzs: '300000',
            currency: 'UZS',
            payment_method: 'CASH',
            backfill_closed_shift_ledger: true,
          },
          serverNow,
          centerToday,
        ),
      (err: unknown) => {
        const ex = err as { statusCode?: number; errorCode?: string };
        return ex.statusCode === 403 && ex.errorCode === 'POLICY_DECISION_NOT_CONFIRMED';
      },
    );
  });

  it('PAY-UNIT-02: computes 10.02 partial, full, overpayment (UnappliedCredit), and multi-invoice allocations with mandatory promise_date (CASE-11, CASE-12)', () => {
    const inv500k = {
      id: INV_1_ID,
      studentId: STUDENT_ID,
      enrollmentId: ENR_1_ID,
      effectiveNetChargeUzs: 500000n,
      allocatedPaidUzs: 0n,
      remainingDebtUzs: 500000n,
      status: 'ISSUED_OPEN' as const,
      dueDate: '2026-11-05',
      version: 1,
    };

    // CASE-11a: 300,000 payment on 500,000 invoice without promise_date -> 422 PROMISE_DATE_REQUIRED_FOR_PARTIAL_PAYMENT
    assert.throws(
      () =>
        planPaymentAllocations({
          studentId: STUDENT_ID,
          paymentAmountUzs: 300000n,
          targetInvoicesInOrder: [inv500k],
          promiseDate: null,
          centerTodayDate: '2026-11-05',
        }),
      (err: unknown) => {
        const ex = err as { statusCode?: number; errorCode?: string };
        return (
          ex.statusCode === 422 &&
          ex.errorCode === 'PROMISE_DATE_REQUIRED_FOR_PARTIAL_PAYMENT'
        );
      },
    );

    // CASE-11b: 300,000 payment on 500,000 invoice with promise_date = 2026-11-15 -> 200,000 debt
    const partialPlan = planPaymentAllocations({
      studentId: STUDENT_ID,
      paymentAmountUzs: 300000n,
      targetInvoicesInOrder: [inv500k],
      promiseDate: '2026-11-15',
      centerTodayDate: '2026-11-05',
    });
    assert.equal(partialPlan.allocatedTotalUzs, 300000n);
    assert.equal(partialPlan.unappliedCreditUzs, 0n);
    assert.equal(partialPlan.totalStudentRemainingDebtUzs, 200000n);
    assert.equal(partialPlan.requiresPromiseToPay, true);
    assert.equal(partialPlan.promiseDate, '2026-11-15');
    assert.equal(partialPlan.plannedAllocations.length, 1);
    assert.equal(partialPlan.plannedAllocations[0].newRemainingDebtUzs, 200000n);
    assert.equal(partialPlan.plannedAllocations[0].newStatus, 'PARTIALLY_PAID');

    // CASE-12: 600,000 payment on 500,000 invoice -> 500,000 allocation (0 debt, PAID) + 100,000 UnappliedCredit
    const overpayPlan = planPaymentAllocations({
      studentId: STUDENT_ID,
      paymentAmountUzs: 600000n,
      targetInvoicesInOrder: [inv500k],
      promiseDate: null,
      centerTodayDate: '2026-11-05',
    });
    assert.equal(overpayPlan.allocatedTotalUzs, 500000n);
    assert.equal(overpayPlan.unappliedCreditUzs, 100000n);
    assert.equal(overpayPlan.totalStudentRemainingDebtUzs, 0n);
    assert.equal(overpayPlan.requiresPromiseToPay, false);
    assert.equal(overpayPlan.plannedAllocations[0].newRemainingDebtUzs, 0n);
    assert.equal(overpayPlan.plannedAllocations[0].newStatus, 'PAID');

    // Multi-invoice explicit allocation (inv1=300k, inv2=400k, payment=450k -> 200k + 250k)
    const inv300k = { ...inv500k, id: INV_1_ID, effectiveNetChargeUzs: 300000n, remainingDebtUzs: 300000n };
    const inv400k = { ...inv500k, id: INV_2_ID, effectiveNetChargeUzs: 400000n, remainingDebtUzs: 400000n };

    const multiExplicit = planPaymentAllocations({
      studentId: STUDENT_ID,
      paymentAmountUzs: 450000n,
      targetInvoicesInOrder: [inv300k, inv400k],
      explicitAllocations: [
        { invoiceId: INV_1_ID, allocatedAmountUzs: 200000n },
        { invoiceId: INV_2_ID, allocatedAmountUzs: 250000n },
      ],
      promiseDate: '2026-11-20',
      centerTodayDate: '2026-11-05',
    });
    assert.equal(multiExplicit.allocatedTotalUzs, 450000n);
    assert.equal(multiExplicit.unappliedCreditUzs, 0n);
    assert.equal(multiExplicit.totalStudentRemainingDebtUzs, 250000n);
    assert.equal(multiExplicit.plannedAllocations[0].newRemainingDebtUzs, 100000n);
    assert.equal(multiExplicit.plannedAllocations[1].newRemainingDebtUzs, 150000n);

    // Cross-student invoice rejected with 403 FORBIDDEN_OBJECT_SCOPE
    assert.throws(
      () =>
        planPaymentAllocations({
          studentId: STUDENT_ID,
          paymentAmountUzs: 300000n,
          targetInvoicesInOrder: [{ ...inv300k, studentId: OTHER_STUDENT_ID }],
          promiseDate: null,
          centerTodayDate: '2026-11-05',
        }),
      (err: unknown) => {
        const ex = err as { statusCode?: number; errorCode?: string };
        return ex.statusCode === 403 && ex.errorCode === 'FORBIDDEN_OBJECT_SCOPE';
      },
    );
  });

  it('PAY-UNIT-03: validates 10.03 reversal requests and gates unconfirmed D22 CLOSE_WITH_CREDIT_NOTE / gateway refund flags', () => {
    const validReq = validateCreateReversalInput({
      original_payment_id: PAY_1_ID,
      kind: 'ERROR_STORNO_REVERSAL',
      amount_uzs: '4000000',
      refund_method: 'CASH',
      reason: 'Entered 4,000,000 instead of 400,000 by mistake',
    });
    assert.equal(validReq.amountUzs, 4000000n);
    assert.equal(validReq.debtEffectPolicy, 'REOPEN_INVOICE_DEBT');

    // Rejects short reason (< 5 chars)
    assert.throws(() =>
      validateCreateReversalInput({
        original_payment_id: PAY_1_ID,
        kind: 'ERROR_STORNO_REVERSAL',
        amount_uzs: '400000',
        refund_method: 'CASH',
        reason: 'bad',
      }),
    );

    // Gates CLOSE_WITH_CREDIT_NOTE with 403 POLICY_DECISION_NOT_CONFIRMED
    assert.throws(
      () =>
        validateCreateReversalInput({
          original_payment_id: PAY_1_ID,
          kind: 'PARTIAL_REFUND',
          amount_uzs: '150000',
          refund_method: 'CASH',
          debt_effect_policy: 'CLOSE_WITH_CREDIT_NOTE',
          reason: 'Student leaving mid-month refund request',
        }),
      (err: unknown) => {
        const ex = err as { statusCode?: number; errorCode?: string };
        return ex.statusCode === 403 && ex.errorCode === 'POLICY_DECISION_NOT_CONFIRMED';
      },
    );

    const mockReq = { headers: { 'if-match': '"1"' } } as never;
    assert.throws(
      () =>
        validateApproveReversalInput(mockReq, REV_1_ID, {
          decision: 'APPROVED_EXECUTED',
          debt_effect_policy: 'CLOSE_WITH_CREDIT_NOTE',
          expected_version: 1,
        }),
      (err: unknown) => {
        const ex = err as { statusCode?: number; errorCode?: string };
        return ex.statusCode === 403 && ex.errorCode === 'POLICY_DECISION_NOT_CONFIRMED';
      },
    );
  });

  it('PAY-UNIT-04: plans 10.03 append-only reversal allocation unwind for CASE-13 (4,000,000 -> 400,000) and CASE-14 (150,000 partial refund cap)', () => {
    // CASE-13: 4,000,000 payment on 400,000 invoice (400,000 allocated + 3,600,000 unapplied credit)
    const case13Unwind = planPaymentReversalUnwind({
      kind: 'ERROR_STORNO_REVERSAL',
      debtEffectPolicy: 'REOPEN_INVOICE_DEBT',
      originalPaymentAmountUzs: 4000000n,
      alreadyReversedTotalUzs: 0n,
      requestedReversalUzs: 4000000n,
      currentUnappliedCreditUzs: 3600000n,
      allocationsInReverseOrder: [
        {
          allocationId: 'alloc-1',
          invoiceId: INV_1_ID,
          enrollmentId: ENR_1_ID,
          allocatedAmountUzs: 400000n,
          alreadyReversedOnAllocationUzs: 0n,
          invoiceEffectiveNetChargeUzs: 400000n,
          invoiceAllocatedPaidUzs: 400000n,
          invoiceRemainingDebtUzs: 0n,
          invoiceVersion: 2,
        },
      ],
    });
    assert.equal(case13Unwind.unappliedCreditReductionUzs, 3600000n);
    assert.equal(case13Unwind.newUnappliedRemainingCreditUzs, 0n);
    assert.equal(case13Unwind.totalInvoiceDebtRestoredUzs, 400000n);
    assert.equal(case13Unwind.plannedAllocationReversals.length, 1);
    assert.equal(case13Unwind.plannedAllocationReversals[0].reversedAmountUzs, 400000n);
    assert.equal(case13Unwind.plannedAllocationReversals[0].newInvoiceRemainingDebtUzs, 400000n);
    assert.equal(case13Unwind.plannedAllocationReversals[0].newInvoiceStatus, 'ISSUED_OPEN');

    // CASE-14: 150,000 partial refund on 400,000 payment -> restores 150,000 debt, leaves 250,000 cap
    const case14First = planPaymentReversalUnwind({
      kind: 'PARTIAL_REFUND',
      debtEffectPolicy: 'REOPEN_INVOICE_DEBT',
      originalPaymentAmountUzs: 400000n,
      alreadyReversedTotalUzs: 0n,
      requestedReversalUzs: 150000n,
      currentUnappliedCreditUzs: 0n,
      allocationsInReverseOrder: [
        {
          allocationId: 'alloc-2',
          invoiceId: INV_1_ID,
          enrollmentId: ENR_1_ID,
          allocatedAmountUzs: 400000n,
          alreadyReversedOnAllocationUzs: 0n,
          invoiceEffectiveNetChargeUzs: 400000n,
          invoiceAllocatedPaidUzs: 400000n,
          invoiceRemainingDebtUzs: 0n,
          invoiceVersion: 2,
        },
      ],
    });
    assert.equal(case14First.remainingReversibleAfterUzs, 250000n);
    assert.equal(case14First.totalInvoiceDebtRestoredUzs, 150000n);
    assert.equal(case14First.plannedAllocationReversals[0].newInvoiceAllocatedPaidUzs, 250000n);
    assert.equal(case14First.plannedAllocationReversals[0].newInvoiceRemainingDebtUzs, 150000n);
    assert.equal(case14First.plannedAllocationReversals[0].newInvoiceStatus, 'PARTIALLY_PAID');

    // Subsequent 300,000 refund request exceeds remaining 250,000 cap -> 422 REFUND_CAP_EXCEEDED
    assert.throws(
      () =>
        planPaymentReversalUnwind({
          kind: 'PARTIAL_REFUND',
          debtEffectPolicy: 'REOPEN_INVOICE_DEBT',
          originalPaymentAmountUzs: 400000n,
          alreadyReversedTotalUzs: 150000n,
          requestedReversalUzs: 300000n,
          currentUnappliedCreditUzs: 0n,
          allocationsInReverseOrder: [],
        }),
      (err: unknown) => {
        const ex = err as { statusCode?: number; errorCode?: string };
        return ex.statusCode === 422 && ex.errorCode === 'REFUND_CAP_EXCEEDED';
      },
    );
  });

  it('PAY-UNIT-05: formats center-scoped internal electronic receipt numbers (10.04)', () => {
    assert.equal(formatInternalReceiptNumber('202611', 1), 'RCP-202611-000001');
    assert.equal(formatInternalReceiptNumber('202611', 42), 'RCP-202611-000042');
    assert.throws(() => formatInternalReceiptNumber('2026-11', 1));
    assert.throws(() => formatInternalReceiptNumber('202611', 0));
  });
});
