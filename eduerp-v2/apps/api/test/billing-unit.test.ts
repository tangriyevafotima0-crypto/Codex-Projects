import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ApiHttpException } from '../src/auth/auth.errors';
import {
  calculateProRataOrCycleChargeUzs,
  roundRationalHalfUpUzs,
  selectPeriodLessonSnapshot,
} from '../src/billing/calendar-proration';
import {
  assertConfirmedPolicyForBillingExecution,
  mapBillingPolicyRowToDto,
  type BillingPolicyVersionDto,
} from '../src/billing/policy';
import {
  assertGroupBillingModeMatchesCycleType,
  assertServicePeriodEligibleForEnrollmentBegin,
  buildCalendarMonthCycleSpec,
  buildLessonPackage12CycleSpec,
  buildRollingMonthCycleSpec,
  buildRollingMonthRenewalChain,
  computeNextRollingRenewalDate,
  resolveCycleDueDate,
} from '../src/billing/subscriptions';
import {
  planNextTrialActivationSequence,
  selectDistinctEligibleTrialLessons,
} from '../src/billing/trial-conversion';
import { MAX_PG_BIGINT } from '../src/database/money';

describe('Stage 08 Billing, Proration, Subscriptions, Trial Conversion & Policy Gates Unit Tests (08.01..08.04)', () => {
  it('computes exact rational integer HALF_UP proration (480000*7/12=280000, 1/2->1, 1/3->0, 2/3->1, BigInt > MAX_SAFE_INTEGER) and rejects invalid/overflow inputs (BILL-UNIT-01 / Matrix #1)', () => {
    // T08.01 canonical vector: 480,000 * 7 / 12 = 280,000 UZS
    const t0801 = calculateProRataOrCycleChargeUzs({
      tariffUzs: '480000',
      plannedLessons: 12,
      remainingLessons: 7,
      isFirstPartialPeriod: true,
      firstPartialChargeMode: 'PRORATE_REMAINING_LESSONS',
      roundingMode: 'HALF_UP_UZS_INT',
    });
    assert.equal(t0801.chargeUzs, 280000n);
    assert.equal(t0801.chargeUzsStr, '280000');
    assert.equal(t0801.billedLessons, 7);
    assert.equal(t0801.lineType, 'PRO_RATA_CALC');

    // Rational HALF_UP tie-breaking vectors (OWNER-20261104-03 #2)
    assert.equal(roundRationalHalfUpUzs(1n, 2n), 1n); // 0.5 -> 1
    assert.equal(roundRationalHalfUpUzs(1n, 3n), 0n); // 0.333... -> 0
    assert.equal(roundRationalHalfUpUzs(2n, 3n), 1n); // 0.666... -> 1
    assert.equal(roundRationalHalfUpUzs(5n, 2n), 3n); // 2.5 -> 3
    assert.equal(roundRationalHalfUpUzs(0n, 12n), 0n);

    // Remaining 0 lessons -> 0 UZS under PRORATE_REMAINING_LESSONS
    const zeroRem = calculateProRataOrCycleChargeUzs({
      tariffUzs: '480000',
      plannedLessons: 12,
      remainingLessons: 0,
      isFirstPartialPeriod: true,
      firstPartialChargeMode: 'PRORATE_REMAINING_LESSONS',
    });
    assert.equal(zeroRem.chargeUzs, 0n);
    assert.equal(zeroRem.chargeUzsStr, '0');
    assert.equal(zeroRem.billedLessons, 0);

    // BigInt above Number.MAX_SAFE_INTEGER (9007199254740999 * 7 / 12 = 5254199565265582.75 -> 5254199565265583)
    const bigRes = calculateProRataOrCycleChargeUzs({
      tariffUzs: '9007199254740999',
      plannedLessons: 12,
      remainingLessons: 7,
      isFirstPartialPeriod: true,
      firstPartialChargeMode: 'PRORATE_REMAINING_LESSONS',
    });
    assert.equal(bigRes.chargeUzs, 5254199565265583n);
    assert.equal(bigRes.chargeUzsStr, '5254199565265583');

    // Planned 0 lessons -> billing blocked (422 INVALID_SCHEDULE_ZERO_LESSONS)
    assert.throws(
      () =>
        calculateProRataOrCycleChargeUzs({
          tariffUzs: '480000',
          plannedLessons: 0,
          remainingLessons: 0,
        }),
      (err: unknown) =>
        err instanceof ApiHttpException &&
        err.statusCode === 422 &&
        err.errorCode === 'INVALID_SCHEDULE_ZERO_LESSONS',
    );

    // Remaining > planned, negative, or non-integer lesson counts rejected
    assert.throws(
      () =>
        calculateProRataOrCycleChargeUzs({
          tariffUzs: '480000',
          plannedLessons: 12,
          remainingLessons: 13,
        }),
      (err: unknown) => err instanceof ApiHttpException && err.statusCode === 422,
    );
    assert.throws(
      () =>
        calculateProRataOrCycleChargeUzs({
          tariffUzs: '480000',
          plannedLessons: 12,
          remainingLessons: -1,
        }),
      (err: unknown) => err instanceof ApiHttpException && err.statusCode === 422,
    );
    assert.throws(
      () =>
        calculateProRataOrCycleChargeUzs({
          tariffUzs: '480000',
          plannedLessons: 12.5,
          remainingLessons: 6,
        }),
      (err: unknown) => err instanceof ApiHttpException && err.statusCode === 400,
    );

    // Unsafe JS number, float string, negative string, and int64 final overflow rejected
    for (const badTariff of [480000 as unknown as string, '480000.50', '-100', '9223372036854775808']) {
      assert.throws(
        () =>
          calculateProRataOrCycleChargeUzs({
            tariffUzs: badTariff,
            plannedLessons: 12,
            remainingLessons: 12,
          }),
        (err: unknown) => err instanceof ApiHttpException && err.statusCode === 422,
      );
    }

    assert.throws(
      () => roundRationalHalfUpUzs((MAX_PG_BIGINT + 10n) * 2n, 2n),
      (err: unknown) => err instanceof ApiHttpException && err.statusCode === 422,
    );
  });

  it('enforces per-center first partial-period charge variants (PRORATE_REMAINING_LESSONS vs FULL_CYCLE vs UNCONFIGURED 403) and lesson-based snapshot selection (BILL-UNIT-02 / Matrix #2, #5)', () => {
    // 1. UNCONFIGURED first_partial_charge_mode on partial period fails closed with 403 POLICY_DECISION_NOT_CONFIRMED
    assert.throws(
      () =>
        calculateProRataOrCycleChargeUzs({
          tariffUzs: '480000',
          plannedLessons: 12,
          remainingLessons: 7,
          isFirstPartialPeriod: true,
          firstPartialChargeMode: 'UNCONFIGURED',
        }),
      (err: unknown) =>
        err instanceof ApiHttpException &&
        err.statusCode === 403 &&
        err.errorCode === 'POLICY_DECISION_NOT_CONFIRMED',
    );

    // 2. FULL_CYCLE charges full tariff when remaining_lessons > 0, but blocks zero-lesson partial period (403)
    const fullCycle = calculateProRataOrCycleChargeUzs({
      tariffUzs: '480000',
      plannedLessons: 12,
      remainingLessons: 7,
      isFirstPartialPeriod: true,
      firstPartialChargeMode: 'FULL_CYCLE',
    });
    assert.equal(fullCycle.chargeUzs, 480000n);
    assert.equal(fullCycle.billedLessons, 12);
    assert.equal(fullCycle.lineType, 'BASE_TARIFF');

    assert.throws(
      () =>
        calculateProRataOrCycleChargeUzs({
          tariffUzs: '480000',
          plannedLessons: 12,
          remainingLessons: 0,
          isFirstPartialPeriod: true,
          firstPartialChargeMode: 'FULL_CYCLE',
        }),
      (err: unknown) =>
        err instanceof ApiHttpException &&
        err.statusCode === 403 &&
        err.errorCode === 'POLICY_DECISION_NOT_CONFIRMED',
    );

    // 3. selectPeriodLessonSnapshot excludes RESCHEDULED originals and CANCELLED_BY_CENTER public holidays
    const snap = selectPeriodLessonSnapshot({
      periodStartDate: '2026-11-01',
      periodEndDate: '2026-11-30',
      effectiveEnrollmentStartDate: '2026-11-10',
      scheduleDays: ['MON', 'WED', 'FRI'],
      cancelledLessonProrationMode: 'EXCLUDE_CANCELLED_FROM_PLANNED',
      lessonOccurrences: [
        { id: 'lsn-1', lesson_date: '2026-11-02', occurrence_seq: 1, status: 'COMPLETED' },
        { id: 'lsn-2', lesson_date: '2026-11-04', occurrence_seq: 1, status: 'RESCHEDULED' },
        { id: 'lsn-2-rep', lesson_date: '2026-11-05', occurrence_seq: 1, status: 'COMPLETED' },
        { id: 'lsn-3-hol', lesson_date: '2026-11-09', occurrence_seq: 1, status: 'CANCELLED_BY_CENTER', cancellation_source: 'PUBLIC_HOLIDAY' },
        { id: 'lsn-4', lesson_date: '2026-11-11', occurrence_seq: 1, status: 'SCHEDULED' },
        { id: 'lsn-5', lesson_date: '2026-11-13', occurrence_seq: 1, status: 'SCHEDULED' },
      ],
    });
    assert.equal(snap.plannedLessons, 4); // lsn-1, lsn-2-rep, lsn-4, lsn-5
    assert.equal(snap.billableLessons, 2); // lsn-4, lsn-5 (>= 2026-11-10)
    assert.equal(snap.cancelledLessonsExcludedCount, 1);
    assert.equal(snap.rescheduledOriginalsExcludedCount, 1);
  });

  it('chains rolling-month renewals from stored previous boundary (Jan31->Feb28->Mar28 and leap year Jan31->Feb29->Mar29) without restoring 31 anchor or creating gaps/overlaps (BILL-UNIT-03 / Matrix #3)', () => {
    // Non-leap year 2026: Jan 31 -> Feb 28 -> Mar 28 -> Apr 28 (OWNER-20261104-03 #3)
    const chain2026 = buildRollingMonthRenewalChain('2026-01-31', 4, 'CONTINUE_FROM_CLAMPED_DAY');
    assert.equal(chain2026.length, 4);
    assert.equal(chain2026[0].periodStartDate, '2026-01-31');
    assert.equal(chain2026[0].periodEndDate, '2026-02-27');
    assert.equal(chain2026[0].nextRenewalDate, '2026-02-28');

    assert.equal(chain2026[1].periodStartDate, '2026-02-28');
    assert.equal(chain2026[1].periodEndDate, '2026-03-27');
    assert.equal(chain2026[1].nextRenewalDate, '2026-03-28');

    assert.equal(chain2026[2].periodStartDate, '2026-03-28');
    assert.equal(chain2026[2].periodEndDate, '2026-04-27');
    assert.equal(chain2026[2].nextRenewalDate, '2026-04-28');

    assert.equal(chain2026[3].periodStartDate, '2026-04-28');
    assert.equal(chain2026[3].periodEndDate, '2026-05-27');
    assert.equal(chain2026[3].nextRenewalDate, '2026-05-28');

    // Leap year 2028: Jan 31 -> Feb 29 -> Mar 29
    const chain2028 = buildRollingMonthRenewalChain('2028-01-31', 3, 'CONTINUE_FROM_CLAMPED_DAY');
    assert.equal(chain2028[0].periodStartDate, '2028-01-31');
    assert.equal(chain2028[0].periodEndDate, '2028-02-28');
    assert.equal(chain2028[0].nextRenewalDate, '2028-02-29');

    assert.equal(chain2028[1].periodStartDate, '2028-02-29');
    assert.equal(chain2028[1].periodEndDate, '2028-03-28');
    assert.equal(chain2028[1].nextRenewalDate, '2028-03-29');

    assert.equal(chain2028[2].periodStartDate, '2028-03-29');
    assert.equal(chain2028[2].periodEndDate, '2028-04-28');
    assert.equal(chain2028[2].nextRenewalDate, '2028-04-29');

    // Year-end boundary: 2026-12-31 -> 2027-01-31 -> 2027-02-28 -> 2027-03-28
    const chainYearEnd = buildRollingMonthRenewalChain('2026-12-31', 3, 'CLAMP_LAST_DAY');
    assert.equal(chainYearEnd[0].nextRenewalDate, '2027-01-31');
    assert.equal(chainYearEnd[1].nextRenewalDate, '2027-02-28');
    assert.equal(chainYearEnd[2].nextRenewalDate, '2027-03-28');

    // Reject gap or overlap relative to previousCycleEndDate
    assert.throws(
      () =>
        buildRollingMonthCycleSpec({
          periodStartDate: '2026-03-31', // trying to restore 31 after Feb 27 end!
          previousCycleEndDate: '2026-02-27',
          enrollmentBillingStartDate: '2026-01-31',
        }),
      (err: unknown) => err instanceof ApiHttpException && err.statusCode === 422,
    );

    // Reject unconfirmed RESTORE_ANCHOR_31 mode
    assert.throws(
      () => computeNextRollingRenewalDate('2026-01-31', 'RESTORE_ANCHOR_31'),
      (err: unknown) =>
        err instanceof ApiHttpException &&
        err.statusCode === 403 &&
        err.errorCode === 'POLICY_DECISION_NOT_CONFIRMED',
    );

    // Calendar month must start on 1st of month
    const calSpec = buildCalendarMonthCycleSpec({
      periodStartDate: '2026-11-01',
      enrollmentBillingStartDate: '2026-11-12',
    });
    assert.equal(calSpec.periodEndDate, '2026-11-30');
    assert.equal(calSpec.nextPeriodStartDate, '2026-12-01');
    assert.equal(calSpec.isFirstPartialPeriod, true);

    assert.throws(
      () =>
        buildCalendarMonthCycleSpec({
          periodStartDate: '2026-11-12',
          enrollmentBillingStartDate: '2026-11-12',
        }),
      (err: unknown) => err instanceof ApiHttpException && err.statusCode === 422,
    );
  });

  it('resolves due dates orthogonally for ENROLLMENT_ANNIVERSARY (Aug12->Sep12) vs CENTER_FIXED_DAY=15 (Aug12->Sep15), ADVANCE vs ARREARS, and gates ambiguous fixed-day short-month or initial advance periods (BILL-UNIT-04 / Matrix #4, #5)', () => {
    // OWNER-20261104-02 Example 1: Joined Aug 12, ENROLLMENT_ANNIVERSARY + ARREARS -> due Sep 12
    const ex1 = resolveCycleDueDate({
      cycleType: 'ROLLING_MONTH',
      periodStartDate: '2026-08-12',
      periodEndDate: '2026-09-11',
      dueDateRule: 'ENROLLMENT_ANNIVERSARY',
      fixedDueDay: null,
      collectionTiming: 'ARREARS',
    });
    assert.equal(ex1.dueDate, '2026-09-12');
    assert.equal(ex1.requiresPolicyConfirmation, false);

    // OWNER-20261104-02 Example 2: Joined Aug 12, CENTER_FIXED_DAY=15 + ARREARS -> due Sep 15
    const ex2 = resolveCycleDueDate({
      cycleType: 'ROLLING_MONTH',
      periodStartDate: '2026-08-12',
      periodEndDate: '2026-09-11',
      dueDateRule: 'CENTER_FIXED_DAY',
      fixedDueDay: 15,
      collectionTiming: 'ARREARS',
    });
    assert.equal(ex2.dueDate, '2026-09-15');
    assert.equal(ex2.requiresPolicyConfirmation, false);

    // ENROLLMENT_ANNIVERSARY + ADVANCE -> due on periodStartDate (Aug 12)
    const advAnniv = resolveCycleDueDate({
      cycleType: 'ROLLING_MONTH',
      periodStartDate: '2026-08-12',
      periodEndDate: '2026-09-11',
      dueDateRule: 'ENROLLMENT_ANNIVERSARY',
      fixedDueDay: null,
      collectionTiming: 'ADVANCE',
    });
    assert.equal(advAnniv.dueDate, '2026-08-12');

    // Ambiguous fixed due-day 31 in February: preview flags requiresPolicyConfirmation=true, execution fails closed with 403!
    const febFixedPreview = resolveCycleDueDate({
      cycleType: 'CALENDAR_MONTH',
      periodStartDate: '2026-02-01',
      periodEndDate: '2026-02-28',
      dueDateRule: 'CENTER_FIXED_DAY',
      fixedDueDay: 31,
      collectionTiming: 'ARREARS',
      enforceConfirmed: false,
    });
    assert.equal(febFixedPreview.requiresPolicyConfirmation, true);

    assert.throws(
      () =>
        resolveCycleDueDate({
          cycleType: 'CALENDAR_MONTH',
          periodStartDate: '2026-02-01',
          periodEndDate: '2026-02-28',
          dueDateRule: 'CENTER_FIXED_DAY',
          fixedDueDay: 31,
          collectionTiming: 'ARREARS',
          enforceConfirmed: true,
        }),
      (err: unknown) =>
        err instanceof ApiHttpException &&
        err.statusCode === 403 &&
        err.errorCode === 'POLICY_DECISION_NOT_CONFIRMED',
    );

    // Ambiguous initial mid-month ADVANCE with CENTER_FIXED_DAY=15 when joined Aug 20 -> fails closed with 403!
    assert.throws(
      () =>
        resolveCycleDueDate({
          cycleType: 'CALENDAR_MONTH',
          periodStartDate: '2026-08-20',
          periodEndDate: '2026-08-31',
          dueDateRule: 'CENTER_FIXED_DAY',
          fixedDueDay: 15,
          collectionTiming: 'ADVANCE',
          isInitialCycle: true,
          enforceConfirmed: true,
        }),
      (err: unknown) =>
        err instanceof ApiHttpException &&
        err.statusCode === 403 &&
        err.errorCode === 'POLICY_DECISION_NOT_CONFIRMED',
    );

    assertGroupBillingModeMatchesCycleType('CALENDAR_PRO_RATA', 'CALENDAR_MONTH');
    assert.throws(
      () => assertGroupBillingModeMatchesCycleType('ROLLING_MONTH', 'CALENDAR_MONTH'),
      (err: unknown) => err instanceof ApiHttpException && err.statusCode === 422,
    );
  });

  it('validates LESSON_PACKAGE_12 distinct PKG:1/PKG:2 keys, deduplicates repeated attendance, preserves balance on cancelled lessons, and blocks unconfirmed D21 cancellation credit (BILL-UNIT-05 / Matrix #16)', () => {
    const pkg1 = buildLessonPackage12CycleSpec({
      cycleKey: 'PKG:1',
      periodStartDate: '2026-11-01',
      lessonsPerCycle: 12,
      packageCancelMode: 'PRESERVE_BALANCE',
      lessonOccurrences: [
        { id: 'l1', status: 'COMPLETED' },
        { id: 'l2', status: 'COMPLETED' },
        { id: 'l3-cancel', status: 'CANCELLED_BY_CENTER' },
        { id: 'l4', status: 'SCHEDULED' },
      ],
      // Duplicate 'l1' attendance event passed twice -> counted once!
      attendedLessonIds: ['l1', 'l1', 'l2'],
    });
    assert.equal(pkg1.cycleSeq, 1);
    assert.equal(pkg1.distinctConsumedLessonsCount, 2);
    assert.equal(pkg1.packageLessonsRemaining, 10);
    assert.equal(pkg1.cancelledLessonsSkippedCount, 1);

    const pkg2 = buildLessonPackage12CycleSpec({
      cycleKey: 'PKG:2',
      periodStartDate: '2026-12-01',
      lessonsPerCycle: 12,
      packageCancelMode: 'PRESERVE_BALANCE',
    });
    assert.equal(pkg2.cycleSeq, 2);

    // Invalid package key rejected
    assert.throws(
      () =>
        buildLessonPackage12CycleSpec({
          cycleKey: 'PKG:0',
          periodStartDate: '2026-11-01',
        }),
      (err: unknown) => err instanceof ApiHttpException && err.statusCode === 422,
    );

    // Cancelled lesson in package window when packageCancelMode is CREDIT_NEXT_CYCLE fails closed (403 D21)
    assert.throws(
      () =>
        buildLessonPackage12CycleSpec({
          cycleKey: 'PKG:1',
          periodStartDate: '2026-11-01',
          packageCancelMode: 'CREDIT_NEXT_CYCLE',
          lessonOccurrences: [{ id: 'l1', status: 'CANCELLED_BY_CENTER' }],
        }),
      (err: unknown) =>
        err instanceof ApiHttpException &&
        err.statusCode === 403 &&
        err.errorCode === 'POLICY_DECISION_NOT_CONFIRMED',
    );
  });

  it('deduplicates and filters eligible trial attendance records and plans TrialActivation sequence numbers across COMPENSATED_VOID reactivations (BILL-UNIT-06 / Matrix #12, #13, #14)', () => {
    const eligible = selectDistinctEligibleTrialLessons([
      {
        lesson_id: 'lsn-absent',
        lesson_date: '2026-11-02',
        occurrence_seq: 1,
        lesson_status: 'COMPLETED',
        attendance_id: 'att-1',
        attendance_status: 'ABSENT',
      },
      {
        lesson_id: 'lsn-cancelled',
        lesson_date: '2026-11-04',
        occurrence_seq: 1,
        lesson_status: 'CANCELLED_BY_CENTER',
        attendance_id: 'att-2',
        attendance_status: 'PRESENT',
      },
      {
        lesson_id: 'lsn-trial-1',
        lesson_date: '2026-11-06',
        occurrence_seq: 1,
        lesson_status: 'COMPLETED',
        attendance_id: 'att-3a',
        attendance_status: 'PRESENT',
      },
      // Duplicate submission on same lesson_id lsn-trial-1 -> must not count as 2nd lesson!
      {
        lesson_id: 'lsn-trial-1',
        lesson_date: '2026-11-06',
        occurrence_seq: 1,
        lesson_status: 'COMPLETED',
        attendance_id: 'att-3b',
        attendance_status: 'PRESENT',
      },
      {
        lesson_id: 'lsn-trial-2',
        lesson_date: '2026-11-09',
        occurrence_seq: 1,
        lesson_status: 'COMPLETED',
        attendance_id: 'att-4',
        attendance_status: 'LATE',
      },
    ]);

    assert.equal(eligible.length, 2);
    assert.equal(eligible[0].lesson_id, 'lsn-trial-1');
    assert.equal(eligible[1].lesson_id, 'lsn-trial-2');

    // Sequence planner: after seq=1 COMPENSATED_VOID, next activation uses seq=2
    const planAfterVoid = planNextTrialActivationSequence([
      { id: 'act-1', trial_activation_seq: 1, status: 'COMPENSATED_VOID' },
    ]);
    assert.equal(planAfterVoid.hasActiveActivation, false);
    assert.equal(planAfterVoid.compensatedVoidCount, 1);
    assert.equal(planAfterVoid.nextTrialActivationSeq, 2);

    // Unconfirmed policy object rejected by assertConfirmedPolicyForBillingExecution
    const unconfirmedPolicy: BillingPolicyVersionDto = {
      id: '00000000-0000-4000-8000-000000000001',
      center_id: '11111111-2222-4333-8444-555555555555',
      version_number: 1,
      billing_mode: 'CALENDAR_PRO_RATA',
      first_partial_charge_mode: 'UNCONFIGURED',
      rounding_mode: 'HALF_UP_UZS_INT',
      rolling_month_end_mode: 'CLAMP_LAST_DAY',
      package_cancel_mode: 'PRESERVE_BALANCE',
      cancelled_lesson_proration_mode: 'EXCLUDE_CANCELLED_FROM_PLANNED',
      discount_stacking_mode: 'MAX_SINGLE_DISCOUNT',
      freeze_credit_basis: 'NET_PROPORTIONAL_LESSON',
      refund_debt_mode: 'REOPEN_INVOICE_DEBT',
      policy_confirmation_status: 'CONFIRMED',
      notification_policy_status: 'UNCONFIGURED',
      promise_reminder_channel_policy: 'UNCONFIGURED_CHANNEL_POLICY',
      notification_policy_effective_until: null,
      discount_policy_status: 'UNCONFIGURED',
      freeze_policy_status: 'UNCONFIGURED',
      effective_from_date: '2026-01-01',
      created_by_staff_id: null,
      created_at_utc: '2026-01-01T00:00:00.000Z',
    };
    assert.throws(
      () =>
        assertConfirmedPolicyForBillingExecution({
          policy: unconfirmedPolicy,
          isFirstPartialPeriod: true,
          isRollingMonth: false,
          isLessonPackage12: false,
          hasCancelledLessonsInPackageWindow: false,
        }),
      (err: unknown) =>
        err instanceof ApiHttpException &&
        err.statusCode === 403 &&
        err.errorCode === 'POLICY_DECISION_NOT_CONFIRMED',
    );
  });

  it('enforces K02 fail-closed legacy policy mapping (never fabricating CONFIRMED or 2026-01-01) and K04 service-begin period eligibility across calendar, rolling, and package modes (BILL-UNIT-07 / K02, K04)', () => {
    // 1. K02: mapBillingPolicyRowToDto maps missing/null confirmation status & effective_from_date to UNCONFIGURED & null
    const mappedLegacy = mapBillingPolicyRowToDto({
      id: '11111111-2222-4333-8444-000000000010',
      center_id: '11111111-2222-4333-8444-555555555555',
      version_number: 1,
      billing_mode: 'CALENDAR_PRO_RATA',
      rounding_mode: 'HALF_UP_UZS_INT',
      rolling_month_end_mode: 'CLAMP_LAST_DAY',
      package_cancel_mode: 'PRESERVE_BALANCE',
      discount_stacking_mode: 'MAX_SINGLE_DISCOUNT',
      freeze_credit_basis: 'NET_PROPORTIONAL_LESSON',
      refund_debt_mode: 'REOPEN_INVOICE_DEBT',
      created_at: new Date('2026-11-04T00:00:00.000Z'),
    });
    assert.equal(mappedLegacy.policy_confirmation_status, 'UNCONFIGURED');
    assert.equal(mappedLegacy.first_partial_charge_mode, 'UNCONFIGURED');
    assert.equal(mappedLegacy.effective_from_date, null);

    // Even on a full-month (isFirstPartialPeriod = false) cycle, an UNCONFIGURED legacy policy fails closed with 403!
    assert.throws(
      () =>
        assertConfirmedPolicyForBillingExecution({
          policy: mappedLegacy,
          periodStartDate: '2026-10-01',
          isFirstPartialPeriod: false,
          isRollingMonth: false,
          isLessonPackage12: false,
          hasCancelledLessonsInPackageWindow: false,
        }),
      (err: unknown) =>
        err instanceof ApiHttpException &&
        err.statusCode === 403 &&
        err.errorCode === 'POLICY_DECISION_NOT_CONFIRMED',
    );

    // Future-dated CONFIRMED policy (effective_from_date = 2026-12-01) fails closed for a 2026-10-01 service period (403)
    const futurePolicy: BillingPolicyVersionDto = {
      ...mappedLegacy,
      policy_confirmation_status: 'CONFIRMED',
      first_partial_charge_mode: 'PRORATE_REMAINING_LESSONS',
      effective_from_date: '2026-12-01',
      created_by_staff_id: '11111111-2222-4333-8444-000000000001',
    };
    assert.throws(
      () =>
        assertConfirmedPolicyForBillingExecution({
          policy: futurePolicy,
          periodStartDate: '2026-10-01',
          isFirstPartialPeriod: false,
          isRollingMonth: false,
          isLessonPackage12: false,
          hasCancelledLessonsInPackageWindow: false,
        }),
      (err: unknown) =>
        err instanceof ApiHttpException &&
        err.statusCode === 403 &&
        err.errorCode === 'POLICY_DECISION_NOT_CONFIRMED',
    );

    // 2. K04: Calendar month wholly before enrollment serviceBeginDate (enrolled 2026-11-12, period 2026-10-01..2026-10-31) -> 422
    assert.throws(
      () =>
        buildCalendarMonthCycleSpec({
          periodStartDate: '2026-10-01',
          enrollmentBillingStartDate: '2026-11-12',
        }),
      (err: unknown) =>
        err instanceof ApiHttpException &&
        err.statusCode === 422 &&
        err.errorCode === 'VALIDATION_ERROR',
    );

    // Rolling month starting before enrollment serviceBeginDate -> 422
    assert.throws(
      () =>
        buildRollingMonthCycleSpec({
          periodStartDate: '2026-10-12',
          enrollmentBillingStartDate: '2026-11-12',
        }),
      (err: unknown) =>
        err instanceof ApiHttpException &&
        err.statusCode === 422 &&
        err.errorCode === 'VALIDATION_ERROR',
    );

    // Package 12 starting before enrollment serviceBeginDate -> 422
    assert.throws(
      () =>
        buildLessonPackage12CycleSpec({
          cycleKey: 'PKG:1',
          periodStartDate: '2026-10-01',
          enrollmentBillingStartDate: '2026-11-12',
        }),
      (err: unknown) =>
        err instanceof ApiHttpException &&
        err.statusCode === 422 &&
        err.errorCode === 'VALIDATION_ERROR',
    );

    // Mid-month join in November (enrolled 2026-11-12 in 2026-11-01..2026-11-30) is allowed as first partial period
    const validMidMonth = buildCalendarMonthCycleSpec({
      periodStartDate: '2026-11-01',
      enrollmentBillingStartDate: '2026-11-12',
    });
    assert.equal(validMidMonth.isFirstPartialPeriod, true);
    assert.equal(validMidMonth.effectiveEnrollmentStartDate, '2026-11-12');

    assert.doesNotThrow(() =>
      assertServicePeriodEligibleForEnrollmentBegin({
        cycleType: 'CALENDAR_MONTH',
        periodStartDate: '2026-11-01',
        periodEndDate: '2026-11-30',
        serviceBeginDate: '2026-11-12',
      }),
    );
  });

  it('prevents LESSON_PACKAGE_12 from accepting unknown attendedLessonIds when eligibleSet is empty and prevents PKG:1 lessons from being re-consumed in PKG:2 (BILL-UNIT-08 / K07)', () => {
    // 1. Empty lessonOccurrences -> eligibleSet is empty, so unknown attendedLessonIds must NOT be accepted!
    const emptyEligPkg = buildLessonPackage12CycleSpec({
      cycleKey: 'PKG:1',
      periodStartDate: '2026-11-01',
      lessonsPerCycle: 12,
      packageCancelMode: 'PRESERVE_BALANCE',
      lessonOccurrences: [],
      attendedLessonIds: ['unknown-lesson-1', 'unknown-lesson-2'],
    });
    assert.equal(emptyEligPkg.distinctEligibleLessonIds.length, 0);
    assert.equal(emptyEligPkg.distinctConsumedLessonsCount, 0);
    assert.equal(emptyEligPkg.packageLessonsRemaining, 12);

    // 2. Partitioning across PKG:1 and PKG:2 (lessonsPerCycle = 2): PKG:2 excludes PKG:1's allocated lessons
    const allOccurrences = [
      { id: 'lsn-1', status: 'COMPLETED' },
      { id: 'lsn-2', status: 'COMPLETED' },
      { id: 'lsn-3', status: 'COMPLETED' },
      { id: 'lsn-4', status: 'SCHEDULED' },
    ];
    const pkg1 = buildLessonPackage12CycleSpec({
      cycleKey: 'PKG:1',
      periodStartDate: '2026-11-01',
      lessonsPerCycle: 2,
      packageCancelMode: 'PRESERVE_BALANCE',
      lessonOccurrences: allOccurrences,
      attendedLessonIds: ['lsn-1', 'lsn-2'],
    });
    assert.deepEqual(pkg1.distinctEligibleLessonIds, ['lsn-1', 'lsn-2']);
    assert.equal(pkg1.distinctConsumedLessonsCount, 2);
    assert.equal(pkg1.packageLessonsRemaining, 0);

    const pkg2 = buildLessonPackage12CycleSpec({
      cycleKey: 'PKG:2',
      periodStartDate: '2026-11-10',
      lessonsPerCycle: 2,
      packageCancelMode: 'PRESERVE_BALANCE',
      lessonOccurrences: allOccurrences,
      alreadyAllocatedLessonIds: pkg1.distinctEligibleLessonIds,
      // Even if lsn-1 and lsn-2 are passed in attendedLessonIds, PKG:2 only counts lsn-3!
      attendedLessonIds: ['lsn-1', 'lsn-2', 'lsn-3'],
    });
    assert.deepEqual(pkg2.distinctEligibleLessonIds, ['lsn-3', 'lsn-4']);
    assert.equal(pkg2.distinctConsumedLessonsCount, 1);
    assert.equal(pkg2.packageLessonsRemaining, 1);
  });


  it('enforces L02 durable package ownership across backdated and rescheduled replacement lessons and OWNER-20261105-04 separate S09 discount/freeze policy confirmation (BILL-UNIT-09 / L02, OWNER-04)', () => {
    // 1. L02: PKG:1 owns [l2, l3] (both attended -> 0 remaining).
    //    Later a backdated lesson l1 (earlier date) is inserted AND l3 is rescheduled to l3-replacement.
    //    When PKG:2 is built with alreadyAllocatedLessonIds = [l2, l3], PKG:2 excludes l2, l3, AND l3-replacement,
    //    selecting [l1, l4] and reporting 2 remaining lessons (never re-consuming l2 or l3)!
    const pkg1 = buildLessonPackage12CycleSpec({
      cycleKey: 'PKG:1',
      periodStartDate: '2026-10-01',
      lessonsPerCycle: 2,
      packageCancelMode: 'PRESERVE_BALANCE',
      lessonOccurrences: [
        { id: 'l2-oct02', status: 'COMPLETED' },
        { id: 'l3-oct03', status: 'COMPLETED' },
        { id: 'l4-oct04', status: 'SCHEDULED' },
      ],
      attendedLessonIds: ['l2-oct02', 'l3-oct03'],
    });
    assert.deepEqual(pkg1.distinctEligibleLessonIds, ['l2-oct02', 'l3-oct03']);
    assert.deepEqual(pkg1.distinctConsumedLessonIds, ['l2-oct02', 'l3-oct03']);
    assert.equal(pkg1.packageLessonsRemaining, 0);

    const pkg2AfterBackdatedAndReschedule = buildLessonPackage12CycleSpec({
      cycleKey: 'PKG:2',
      periodStartDate: '2026-10-01',
      lessonsPerCycle: 2,
      packageCancelMode: 'PRESERVE_BALANCE',
      lessonOccurrences: [
        { id: 'l1-oct01-backdated', status: 'SCHEDULED' },
        { id: 'l2-oct02', status: 'COMPLETED' },
        { id: 'l3-oct03', status: 'RESCHEDULED' },
        {
          id: 'l3-replacement',
          status: 'SCHEDULED',
          rescheduled_from_lesson_id: 'l3-oct03',
        },
        { id: 'l4-oct04', status: 'SCHEDULED' },
      ],
      alreadyAllocatedLessonIds: pkg1.distinctEligibleLessonIds,
      attendedLessonIds: ['l2-oct02', 'l3-oct03'],
    });
    assert.deepEqual(pkg2AfterBackdatedAndReschedule.distinctEligibleLessonIds, [
      'l1-oct01-backdated',
      'l4-oct04',
    ]);
    assert.equal(pkg2AfterBackdatedAndReschedule.distinctConsumedLessonsCount, 0);
    assert.equal(pkg2AfterBackdatedAndReschedule.packageLessonsRemaining, 2);

    // 2. OWNER-20261105-04: General S08 CONFIRMED billing policy without explicit discount/freeze confirmation
    //    maps discount_policy_status and freeze_policy_status to UNCONFIGURED.
    const s08OnlyRow = mapBillingPolicyRowToDto({
      id: '11111111-2222-4333-8444-000000000099',
      center_id: '11111111-2222-4333-8444-555555555555',
      version_number: 2,
      billing_mode: 'CALENDAR_PRO_RATA',
      first_partial_charge_mode: 'PRORATE_REMAINING_LESSONS',
      rounding_mode: 'HALF_UP_UZS_INT',
      rolling_month_end_mode: 'CONTINUE_FROM_CLAMPED_DAY',
      package_cancel_mode: 'PRESERVE_BALANCE',
      discount_stacking_mode: 'UNCONFIGURED',
      freeze_credit_basis: 'UNCONFIGURED',
      refund_debt_mode: 'REOPEN_INVOICE_DEBT',
      policy_confirmation_status: 'CONFIRMED',
      discount_policy_status: 'UNCONFIGURED',
      freeze_policy_status: 'UNCONFIGURED',
      effective_from_date: '2026-01-01',
      created_at: '2026-11-04T09:00:00Z',
    });
    assert.equal(s08OnlyRow.policy_confirmation_status, 'CONFIRMED');
    assert.equal(s08OnlyRow.discount_policy_status, 'UNCONFIGURED');
    assert.equal(s08OnlyRow.freeze_policy_status, 'UNCONFIGURED');
  });
});
