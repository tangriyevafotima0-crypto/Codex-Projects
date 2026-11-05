/**
 * EduERP v2.0 — Stage 09 Unit Test Suite (`ADJ-UNIT-01..05`):
 * - `ADJ-UNIT-01`: `OWNER-20261105-04` separate policy confirmation boundary (`assertConfirmedPolicyForDiscountExecution`, `assertConfirmedPolicyForFreezeExecution`).
 * - `ADJ-UNIT-02`: `09.01` discount request validation (`parsePercentValueToBasisPoints`, `validateDiscountRequestInput`, `evaluateFamilyOfferEligibility`).
 * - `ADJ-UNIT-03`: `09.02` center-configurable discount stacking (`MAX_SINGLE`, `SEQUENTIAL`, `PERCENT_THEN_FIXED`, `FIXED_THEN_PERCENT`, `FULL_GRANT_100`, cap & unconfigured rejection).
 * - `ADJ-UNIT-04`: `09.03` freeze interval union, cancelled/rescheduled/attended/package-owned filtering (`selectDistinctEligibleFreezeLessons`), and `NET_PROPORTIONAL_LESSON` (`384,000 * 3 / 12 = 96,000` UZS) calculation (`calculateFreezeProportionalCreditUzs`).
 * - `ADJ-UNIT-05`: `09.04` withdrawal churn reason validation (`validateWithdrawalRequestInput`), unconfirmed exit adjustment rejection (`403 POLICY_DECISION_NOT_CONFIRMED`), and lossless `BigInt` debt summary (`buildWithdrawalFinalAccountSummary`).
 */

import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertConfirmedPolicyForDiscountExecution,
  assertConfirmedPolicyForFreezeExecution,
  BillingPolicyVersionDto,
} from '../src/billing/policy';
import {
  evaluateFamilyOfferEligibility,
  parsePercentValueToBasisPoints,
  validateDiscountRequestInput,
} from '../src/adjustments/discount-requests';
import { calculateInvoiceDiscountStackUzs } from '../src/adjustments/discount-approval';
import {
  calculateFreezeProportionalCreditUzs,
  selectDistinctEligibleFreezeLessons,
} from '../src/adjustments/freeze-credit';
import {
  buildWithdrawalFinalAccountSummary,
  validateWithdrawalRequestInput,
} from '../src/adjustments/withdrawal';

function buildMockPolicy(overrides: Partial<BillingPolicyVersionDto> = {}): BillingPolicyVersionDto {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    center_id: '22222222-2222-4222-8222-222222222222',
    version_number: 1,
    billing_mode: 'CALENDAR_MONTH',
    first_partial_charge_mode: 'PRORATE_REMAINING_LESSONS',
    rounding_mode: 'HALF_UP_UZS_INT',
    rolling_month_end_mode: 'CONTINUE_FROM_CLAMPED_DAY',
    package_cancel_mode: 'EXTEND_PACKAGE_WINDOW',
    cancelled_lesson_proration_mode: 'EXCLUDE_CANCELLED_FROM_PLANNED',
    discount_stacking_mode: 'UNCONFIGURED',
    freeze_credit_basis: 'UNCONFIGURED',
    refund_debt_mode: 'PRESERVE_DEBT_NO_AUTO_REFUND',
    policy_confirmation_status: 'CONFIRMED',
    discount_policy_status: 'UNCONFIGURED',
    freeze_policy_status: 'UNCONFIGURED',
    effective_from_date: '2026-10-01',
    created_by_staff_id: '33333333-3333-4333-8333-333333333333',
    created_at_utc: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('Stage 09 Unit Suite — Discounts, Stacking, Freeze Credits & Withdrawals (ADJ-UNIT-01..05)', () => {
  it('ADJ-UNIT-01: enforces OWNER-20261105-04 separate S09 policy confirmation boundary for discounts and freezes', () => {
    const generalConfirmedOnly = buildMockPolicy();

    assert.throws(
      () =>
        assertConfirmedPolicyForDiscountExecution({
          policy: generalConfirmedOnly,
          periodStartDate: '2026-11-01',
        }),
      (err: unknown) => {
        const ex = err as { statusCode?: number; errorCode?: string };
        return ex.statusCode === 403 && ex.errorCode === 'POLICY_DECISION_NOT_CONFIRMED';
      },
    );

    assert.throws(
      () =>
        assertConfirmedPolicyForFreezeExecution({
          policy: generalConfirmedOnly,
          periodStartDate: '2026-11-01',
        }),
      (err: unknown) => {
        const ex = err as { statusCode?: number; errorCode?: string };
        return ex.statusCode === 403 && ex.errorCode === 'POLICY_DECISION_NOT_CONFIRMED';
      },
    );

    const confirmedS09Policy = buildMockPolicy({
      discount_stacking_mode: 'MAX_SINGLE',
      discount_policy_status: 'CONFIRMED',
      freeze_credit_basis: 'NET_PROPORTIONAL_LESSON',
      freeze_policy_status: 'CONFIRMED',
      effective_from_date: '2026-11-01',
    });

    assert.equal(
      assertConfirmedPolicyForDiscountExecution({
        policy: confirmedS09Policy,
        periodStartDate: '2026-11-01',
      }),
      'MAX_SINGLE',
    );
    assert.equal(
      assertConfirmedPolicyForFreezeExecution({
        policy: confirmedS09Policy,
        periodStartDate: '2026-11-01',
      }),
      'NET_PROPORTIONAL_LESSON',
    );

    // Future effective_from_date fails closed with 403 POLICY_DECISION_NOT_CONFIRMED
    assert.throws(
      () =>
        assertConfirmedPolicyForDiscountExecution({
          policy: confirmedS09Policy,
          periodStartDate: '2026-10-15',
        }),
      (err: unknown) => {
        const ex = err as { statusCode?: number; errorCode?: string };
        return ex.statusCode === 403 && ex.errorCode === 'POLICY_DECISION_NOT_CONFIRMED';
      },
    );
  });

  it('ADJ-UNIT-02: validates 09.01 discount request inputs, basis points, and guardian family offer eligibility', () => {
    const bp = parsePercentValueToBasisPoints('12.5');
    assert.equal(bp.basisPoints, 1250);
    assert.equal(bp.percentSqlDecimal, '12.50');

    assert.throws(() => parsePercentValueToBasisPoints(0));
    assert.throws(() => parsePercentValueToBasisPoints(100.01));
    assert.throws(() => parsePercentValueToBasisPoints('12.345'));

    const validReq = validateDiscountRequestInput(
      {
        enrollment_id: '44444444-4444-4444-8444-444444444444',
        target_invoice_id: '55555555-5555-4555-8555-555555555555',
        discount_kind: 'CUSTOM_PERCENT',
        percent_value: 20,
        reason: 'Olympiad winner scholarship',
        valid_from: '2026-11-01',
        valid_until: '2026-11-30',
      },
      '2026-11-04',
    );
    assert.equal(validReq.percentBasisPoints, 2000);
    assert.equal(validReq.fixedAmountUzs, null);

    // Rejects mass-assignment of status/approved_by_director_id
    assert.throws(() =>
      validateDiscountRequestInput(
        {
          enrollment_id: '44444444-4444-4444-8444-444444444444',
          discount_kind: 'FULL_GRANT_100',
          reason: 'Attempted self-approval',
          valid_from: '2026-11-01',
          valid_until: '2026-11-30',
          status: 'APPROVED',
        },
        '2026-11-04',
      ),
    );

    assert.equal(
      evaluateFamilyOfferEligibility({
        activeGuardianMaxSiblingCount: 1,
        activeEnrollmentCount: 1,
      }).eligible,
      false,
    );
    assert.equal(
      evaluateFamilyOfferEligibility({
        activeGuardianMaxSiblingCount: 2,
        activeEnrollmentCount: 1,
      }).qualifyingBasis,
      'GUARDIAN_SIBLING_LINK',
    );
    assert.equal(
      evaluateFamilyOfferEligibility({
        activeGuardianMaxSiblingCount: 1,
        activeEnrollmentCount: 2,
      }).qualifyingBasis,
      'MULTI_COURSE_ENROLLMENT',
    );
  });

  it('ADJ-UNIT-03: computes 09.02 discount stacking under MAX_SINGLE, SEQUENTIAL, FIXED_THEN_PERCENT, and FULL_GRANT_100', () => {
    const existing20Pct = {
      requestId: 'req-1',
      discountKind: 'CUSTOM_PERCENT' as const,
      percentBasisPoints: 2000,
      fixedAmountUzs: null,
    };
    const candidate10Pct = {
      requestId: 'req-2',
      discountKind: 'FAMILY_DISCOUNT' as const,
      percentBasisPoints: 1000,
      fixedAmountUzs: null,
    };

    // MAX_SINGLE: 480,000 with 20% (96,000) and 10% (48,000) -> keeps 96,000 discount, 384,000 net
    const maxSingle = calculateInvoiceDiscountStackUzs({
      baseChargeUzs: 480000n,
      currentApprovedDiscountUzs: 96000n,
      stackingMode: 'MAX_SINGLE',
      existingApprovedDiscounts: [existing20Pct],
      candidateDiscount: candidate10Pct,
    });
    assert.equal(maxSingle.newTotalApprovedDiscountUzs, 96000n);
    assert.equal(maxSingle.appliedDeltaUzs, 0n);
    assert.equal(maxSingle.resultingGrossAfterDiscountUzs, 384000n);

    // SEQUENTIAL: 480,000 -> -20% (384,000) -> -10% (38,400) = 345,600 net (134,400 total discount)
    const sequential = calculateInvoiceDiscountStackUzs({
      baseChargeUzs: 480000n,
      currentApprovedDiscountUzs: 96000n,
      stackingMode: 'SEQUENTIAL',
      existingApprovedDiscounts: [existing20Pct],
      candidateDiscount: candidate10Pct,
    });
    assert.equal(sequential.newTotalApprovedDiscountUzs, 134400n);
    assert.equal(sequential.appliedDeltaUzs, 38400n);
    assert.equal(sequential.resultingGrossAfterDiscountUzs, 345600n);

    // PERCENT_THEN_FIXED vs FIXED_THEN_PERCENT on 320,000 with 10% and 20,000 UZS
    const item10Pct = {
      requestId: 'req-pct',
      discountKind: 'CUSTOM_PERCENT' as const,
      percentBasisPoints: 1000,
      fixedAmountUzs: null,
    };
    const item20kFixed = {
      requestId: 'req-fix',
      discountKind: 'CUSTOM_FIXED' as const,
      percentBasisPoints: null,
      fixedAmountUzs: 20000n,
    };

    const pctThenFixed = calculateInvoiceDiscountStackUzs({
      baseChargeUzs: 320000n,
      currentApprovedDiscountUzs: 32000n,
      stackingMode: 'PERCENT_THEN_FIXED',
      existingApprovedDiscounts: [item10Pct],
      candidateDiscount: item20kFixed,
    });
    assert.equal(pctThenFixed.resultingGrossAfterDiscountUzs, 268000n);
    assert.equal(pctThenFixed.newTotalApprovedDiscountUzs, 52000n);

    const fixedThenPct = calculateInvoiceDiscountStackUzs({
      baseChargeUzs: 320000n,
      currentApprovedDiscountUzs: 20000n,
      stackingMode: 'FIXED_THEN_PERCENT',
      existingApprovedDiscounts: [item20kFixed],
      candidateDiscount: item10Pct,
    });
    assert.equal(fixedThenPct.resultingGrossAfterDiscountUzs, 270000n);
    assert.equal(fixedThenPct.newTotalApprovedDiscountUzs, 50000n);

    // FULL_GRANT_100 -> 100% discount, 0 remaining charge
    const fullGrant = calculateInvoiceDiscountStackUzs({
      baseChargeUzs: 480000n,
      currentApprovedDiscountUzs: 0n,
      stackingMode: 'MAX_SINGLE',
      existingApprovedDiscounts: [],
      candidateDiscount: {
        requestId: 'req-grant',
        discountKind: 'FULL_GRANT_100',
        percentBasisPoints: 10000,
        fixedAmountUzs: null,
      },
    });
    assert.equal(fullGrant.newTotalApprovedDiscountUzs, 480000n);
    assert.equal(fullGrant.resultingGrossAfterDiscountUzs, 0n);
  });

  it('ADJ-UNIT-04: selects distinct eligible freeze lessons and computes 09.03 proportional HALF_UP credit (384,000 * 3 / 12 = 96,000)', () => {
    const candidateLessons = [
      { id: 'les-1', lesson_date: '2026-11-09', occurrence_seq: 1, status: 'SCHEDULED' },
      { id: 'les-2', lesson_date: '2026-11-11', occurrence_seq: 1, status: 'SCHEDULED' },
      { id: 'les-3', lesson_date: '2026-11-13', occurrence_seq: 1, status: 'SCHEDULED' },
      { id: 'les-4', lesson_date: '2026-11-16', occurrence_seq: 1, status: 'CANCELLED_BY_CENTER' },
      { id: 'les-5', lesson_date: '2026-11-18', occurrence_seq: 1, status: 'COMPLETED' },
    ];

    const firstSelection = selectDistinctEligibleFreezeLessons({
      freezeStartDate: '2026-11-09',
      freezeEndDate: '2026-11-18',
      candidateLessons,
      alreadyFrozenLessonIds: [],
      attendedPresentOrLateLessonIds: ['les-5'],
    });
    assert.deepEqual(firstSelection.distinctNewFrozenLessonIds, ['les-1', 'les-2', 'les-3']);
    assert.equal(firstSelection.skippedCancelledOrRescheduledCount, 1);
    assert.equal(firstSelection.skippedAttendedCount, 1);

    const credit1 = calculateFreezeProportionalCreditUzs({
      freezeCreditBasis: 'NET_PROPORTIONAL_LESSON',
      baseProRataChargeUzs: 480000n,
      approvedDiscountUzs: 96000n,
      effectiveNetChargeUzs: 384000n,
      billedLessons: 12,
      alreadyFrozenLessonsCount: 0,
      alreadyCreditedUzs: 0n,
      newDistinctFrozenLessonIds: firstSelection.distinctNewFrozenLessonIds,
    });
    assert.equal(credit1.basisNetChargeUzs, 384000n);
    assert.equal(credit1.distinctFrozenLessons, 3);
    assert.equal(credit1.calculatedCreditUzs, 96000n);

    // Overlapping second freeze [2026-11-13..2026-11-20] with les-6 on 2026-11-20 only credits les-6 (32,000 UZS)
    const secondSelection = selectDistinctEligibleFreezeLessons({
      freezeStartDate: '2026-11-13',
      freezeEndDate: '2026-11-20',
      candidateLessons: [
        ...candidateLessons,
        { id: 'les-6', lesson_date: '2026-11-20', occurrence_seq: 1, status: 'SCHEDULED' },
      ],
      alreadyFrozenLessonIds: ['les-1', 'les-2', 'les-3'],
      attendedPresentOrLateLessonIds: ['les-5'],
    });
    assert.deepEqual(secondSelection.distinctNewFrozenLessonIds, ['les-6']);
    assert.equal(secondSelection.skippedAlreadyFrozenCount, 1);

    const credit2 = calculateFreezeProportionalCreditUzs({
      freezeCreditBasis: 'NET_PROPORTIONAL_LESSON',
      baseProRataChargeUzs: 480000n,
      approvedDiscountUzs: 96000n,
      effectiveNetChargeUzs: 384000n,
      billedLessons: 12,
      alreadyFrozenLessonsCount: 3,
      alreadyCreditedUzs: 96000n,
      newDistinctFrozenLessonIds: secondSelection.distinctNewFrozenLessonIds,
    });
    assert.equal(credit2.calculatedCreditUzs, 32000n);

    // 100% Grant invoice (basisNetChargeUzs = 0) produces 0 UZS credit
    const grantCredit = calculateFreezeProportionalCreditUzs({
      freezeCreditBasis: 'NET_PROPORTIONAL_LESSON',
      baseProRataChargeUzs: 480000n,
      approvedDiscountUzs: 480000n,
      effectiveNetChargeUzs: 0n,
      billedLessons: 12,
      alreadyFrozenLessonsCount: 0,
      alreadyCreditedUzs: 0n,
      newDistinctFrozenLessonIds: ['les-1', 'les-2'],
    });
    assert.equal(grantCredit.calculatedCreditUzs, 0n);
  });

  it('ADJ-UNIT-05: validates 09.04 mandatory churn reasons 1..5, rejects unconfirmed exit adjustments, and preserves BigInt debt', () => {
    const mockReq = { headers: { 'if-match': '"2"' } } as never;

    assert.throws(() =>
      validateWithdrawalRequestInput(
        mockReq,
        '66666666-6666-4666-8666-666666666666',
        { left_at_date: '2026-11-15', churn_reason_code: 6 },
      ),
    );

    assert.throws(
      () =>
        validateWithdrawalRequestInput(
          mockReq,
          '66666666-6666-4666-8666-666666666666',
          {
            left_at_date: '2026-11-15',
            churn_reason_code: 1,
            expected_version: 2,
            apply_retroactive_prorata_adjustment: true,
          },
        ),
      (err: unknown) => {
        const ex = err as { statusCode?: number; errorCode?: string };
        return ex.statusCode === 403 && ex.errorCode === 'POLICY_DECISION_NOT_CONFIRMED';
      },
    );

    const validWithdraw = validateWithdrawalRequestInput(
      mockReq,
      '66666666-6666-4666-8666-666666666666',
      {
        left_at_date: '2026-11-15',
        churn_reason_code: 3,
        churn_notes: 'University schedule conflict',
        expected_version: 2,
      },
    );
    assert.equal(validWithdraw.churnReasonCode, 3);
    assert.equal(validWithdraw.churnReasonLabel, '3_SCHEDULE_MISMATCH');

    const summary = buildWithdrawalFinalAccountSummary({
      enrollmentId: '66666666-6666-4666-8666-666666666666',
      studentId: '77777777-7777-4777-8777-777777777777',
      leftAtDate: '2026-11-15',
      churnReasonCode: 3,
      openEnrollmentInvoicesDebtUzs: ['200000', '120000'],
      totalStudentRemainingDebtUzs: '320000',
      unconsumedCreditNotesUzs: '0',
    });
    assert.equal(summary.preservedEnrollmentDebtUzs, '320000');
    assert.equal(summary.preservedStudentTotalDebtUzs, '320000');
    assert.equal(summary.automaticRefundOrWriteoffApplied, false);
  });
});
