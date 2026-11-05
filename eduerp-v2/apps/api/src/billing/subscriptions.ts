/**
 * EduERP v2.0 — Stage 08, Step 08.02 (`T08.02`):
 * Discriminated Subscription & Cycle Boundary Policies (`CALENDAR_MONTH`, `ROLLING_MONTH`, `LESSON_PACKAGE_12`)
 * and Orthogonal Due-Date / Collection-Timing Resolution (`OWNER-20261104-02` & `OWNER-20261104-03`).
 *
 * Key Invariants:
 * 1. `CALENDAR_MONTH`: Bound to Gregorian 1st-of-month (`YYYY-MM-01` .. `YYYY-MM-lastDay` inclusive).
 *    Next cycle starts `YYYY-(MM+1)-01` with zero gap and zero overlap.
 * 2. `ROLLING_MONTH`: Chained from the **stored previous boundary** (`periodStartDate`), NEVER `initialDate + N months`!
 *    Under `OWNER-20261104-03` Decision #3, once a renewal date clamps to the end of a short month
 *    (`2026-01-31 -> 2026-02-28` or leap year `2028-01-31 -> 2028-02-29`), subsequent renewals continue from that
 *    actual clamped day (`2026-02-28 -> 2026-03-28`, `2028-02-29 -> 2028-03-29`) without restoring the 31 anchor.
 *    Inclusive `periodEndDate` is `nextRenewalDate - 1 day`, so consecutive cycles have zero gap and zero overlap.
 * 3. `LESSON_PACKAGE_12`: Uses distinct cycle keys `PKG:1`, `PKG:2`, etc., consuming 12 distinct eligible lessons
 *    (deduplicated by `lesson_id`). Cancelled lessons (`CANCELLED_BY_CENTER`) never decrement remaining lessons under
 *    `PRESERVE_BALANCE`, while unconfirmed package cancellation financial credits fail closed with `403 POLICY_DECISION_NOT_CONFIRMED`.
 * 4. `due_date_rule` (`ENROLLMENT_ANNIVERSARY` vs `CENTER_FIXED_DAY`) and `collection_timing` (`ARREARS` vs `ADVANCE`)
 *    are resolved orthogonally without mutating `base_pro_rata_charge_uzs`. Ambiguous fixed due-day short-month (`29/30/31` in Feb)
 *    or unconfirmed initial prepaid fixed-day period fails closed with `403 POLICY_DECISION_NOT_CONFIRMED`.
 */

import type {
  BillingCycleType,
  BillingMode,
  CollectionTiming,
  DueDateRule,
  PackageCancelMode,
  RollingMonthEndMode,
} from '@eduerp/contracts';
import { ApiHttpException } from '../auth/auth.errors';
import { validateIsoDate } from '../students/normalization';

export interface CalendarMonthCycleSpec {
  readonly kind: 'CALENDAR_MONTH';
  readonly billingMode: 'CALENDAR_PRO_RATA';
  readonly cycleType: 'CALENDAR_MONTH';
  readonly cycleKey: string;
  readonly cycleSeq: number;
  readonly periodStartDate: string;
  readonly periodEndDate: string;
  readonly nextPeriodStartDate: string;
  readonly effectiveEnrollmentStartDate: string;
  readonly isFirstPartialPeriod: boolean;
}

export interface RollingMonthCycleSpec {
  readonly kind: 'ROLLING_MONTH';
  readonly billingMode: 'ROLLING_MONTH';
  readonly cycleType: 'ROLLING_MONTH';
  readonly cycleKey: string;
  readonly cycleSeq: number;
  readonly periodStartDate: string;
  readonly periodEndDate: string;
  readonly nextRenewalDate: string;
  readonly activeAnchorDay: number;
  readonly effectiveEnrollmentStartDate: string;
  readonly isFirstPartialPeriod: boolean;
}

export interface LessonPackage12CycleSpec {
  readonly kind: 'LESSON_PACKAGE_12';
  readonly billingMode: 'LESSON_PACKAGE_12';
  readonly cycleType: 'LESSON_PACKAGE_12';
  readonly cycleKey: string;
  readonly cycleSeq: number;
  readonly periodStartDate: string;
  readonly periodEndDate: string | null;
  readonly lessonsPerCycle: number;
  readonly distinctEligibleLessonIds: readonly string[];
  readonly distinctConsumedLessonsCount: number;
  readonly packageLessonsRemaining: number;
  readonly cancelledLessonsSkippedCount: number;
}

export type SubscriptionCycleSpec =
  | CalendarMonthCycleSpec
  | RollingMonthCycleSpec
  | LessonPackage12CycleSpec;

export interface DueDateResolutionResult {
  readonly dueDate: string;
  readonly dueDateRule: DueDateRule;
  readonly fixedDueDay: number | null;
  readonly collectionTiming: CollectionTiming;
  readonly requiresPolicyConfirmation: boolean;
  readonly policyConfirmationReason: string | null;
}

export function parseIsoDateParts(isoDate: string): {
  readonly year: number;
  readonly month: number;
  readonly day: number;
} {
  const clean = validateIsoDate(isoDate, 'date');
  const [y, m, d] = clean.split('-').map((x) => Number(x));
  return { year: y, month: m, day: d };
}

export function formatIsoDateParts(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function isGregorianLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInGregorianMonth(year: number, month: number): number {
  switch (month) {
    case 1:
    case 3:
    case 5:
    case 7:
    case 8:
    case 10:
    case 12:
      return 31;
    case 4:
    case 6:
    case 9:
    case 11:
      return 30;
    case 2:
      return isGregorianLeapYear(year) ? 29 : 28;
    default:
      throw new Error(`Invalid Gregorian month: ${month}`);
  }
}

export function addCalendarDaysToIsoDate(isoDate: string, deltaDays: number): string {
  const { year, month, day } = parseIsoDateParts(isoDate);
  const utcMs = Date.UTC(year, month - 1, day) + deltaDays * 86_400_000;
  return new Date(utcMs).toISOString().slice(0, 10);
}

/**
 * Computes the next rolling-month renewal date from a **single stored boundary** (`currentBoundaryDate`),
 * enforcing `OWNER-20261104-03` Decision #3:
 * - Advances 1 calendar month from `currentBoundaryDate` (`YYYY-MM-DD`).
 * - Clamps `day = Math.min(DD, daysInGregorianMonth(nextYear, nextMonth))`.
 * - Because the next cycle's `periodStartDate` is this clamped date, subsequent renewals continue from
 *   the clamped day (`2026-01-31 -> 2026-02-28 -> 2026-03-28`; leap year `2028-01-31 -> 2028-02-29 -> 2028-03-29`)
 *   and NEVER restore the original `31` anchor!
 */
export function computeNextRollingRenewalDate(
  currentBoundaryDate: string,
  rollingMonthEndMode: RollingMonthEndMode = 'CONTINUE_FROM_CLAMPED_DAY',
): {
  readonly nextRenewalDate: string;
  readonly inclusivePeriodEndDate: string;
  readonly resultingDayOfMonth: number;
} {
  if (
    rollingMonthEndMode !== 'CLAMP_LAST_DAY' &&
    rollingMonthEndMode !== 'CONTINUE_FROM_CLAMPED_DAY'
  ) {
    throw new ApiHttpException({
      statusCode: 403,
      errorCode: 'POLICY_DECISION_NOT_CONFIRMED',
      message: `rolling_month_end_mode '${rollingMonthEndMode}' is not confirmed under OWNER-20261104-03`,
    });
  }

  const { year, month, day } = parseIsoDateParts(currentBoundaryDate);
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const maxDay = daysInGregorianMonth(nextYear, nextMonth);
  const clampedDay = Math.min(day, maxDay);
  const nextRenewalDate = formatIsoDateParts(nextYear, nextMonth, clampedDay);
  const inclusivePeriodEndDate = addCalendarDaysToIsoDate(nextRenewalDate, -1);

  return Object.freeze({
    nextRenewalDate,
    inclusivePeriodEndDate,
    resultingDayOfMonth: clampedDay,
  });
}

/**
 * Generates a chain of `count` consecutive rolling-month cycles starting from `initialStartDate`,
 * chaining strictly from each cycle's `nextRenewalDate` (`stored previous boundary`), never `initialStartDate + N months`.
 */
export function buildRollingMonthRenewalChain(
  initialStartDate: string,
  count: number,
  rollingMonthEndMode: RollingMonthEndMode = 'CONTINUE_FROM_CLAMPED_DAY',
): readonly RollingMonthCycleSpec[] {
  if (!Number.isInteger(count) || count < 1 || count > 60) {
    throw new ApiHttpException({
      statusCode: 400,
      errorCode: 'VALIDATION_ERROR',
      message: 'Rolling chain count must be an integer between 1 and 60',
    });
  }

  const chain: RollingMonthCycleSpec[] = [];
  let cursorStart = validateIsoDate(initialStartDate, 'initialStartDate');

  for (let seq = 1; seq <= count; seq += 1) {
    const { nextRenewalDate, inclusivePeriodEndDate } = computeNextRollingRenewalDate(
      cursorStart,
      rollingMonthEndMode,
    );
    const { day: activeAnchorDay } = parseIsoDateParts(cursorStart);
    chain.push(
      Object.freeze({
        kind: 'ROLLING_MONTH',
        billingMode: 'ROLLING_MONTH',
        cycleType: 'ROLLING_MONTH',
        cycleKey: `ROL:${cursorStart}`,
        cycleSeq: seq,
        periodStartDate: cursorStart,
        periodEndDate: inclusivePeriodEndDate,
        nextRenewalDate,
        activeAnchorDay,
        effectiveEnrollmentStartDate: cursorStart,
        isFirstPartialPeriod: false,
      }),
    );
    cursorStart = nextRenewalDate;
  }

  return Object.freeze(chain);
}

/**
 * Builds and validates a `CALENDAR_MONTH` cycle specification (`YYYY-MM-01` .. `YYYY-MM-lastDay`).
 */
export function buildCalendarMonthCycleSpec(params: {
  readonly periodStartDate: string;
  readonly periodEndDate?: string | null;
  readonly cycleKey?: string;
  readonly cycleSeq?: number;
  readonly enrollmentBillingStartDate: string;
}): CalendarMonthCycleSpec {
  const start = parseIsoDateParts(params.periodStartDate);
  if (start.day !== 1) {
    throw new ApiHttpException({
      statusCode: 422,
      errorCode: 'VALIDATION_ERROR',
      message: `CALENDAR_MONTH period_start_date (${params.periodStartDate}) must be the 1st of the Gregorian month (YYYY-MM-01 — T08.02)`,
    });
  }

  const lastDay = daysInGregorianMonth(start.year, start.month);
  const canonicalEnd = formatIsoDateParts(start.year, start.month, lastDay);
  if (params.periodEndDate && params.periodEndDate !== canonicalEnd) {
    throw new ApiHttpException({
      statusCode: 422,
      errorCode: 'VALIDATION_ERROR',
      message: `CALENDAR_MONTH period_end_date (${params.periodEndDate}) must equal the last day of the month (${canonicalEnd})`,
    });
  }

  const nextYear = start.month === 12 ? start.year + 1 : start.year;
  const nextMonth = start.month === 12 ? 1 : start.month + 1;
  const nextPeriodStartDate = formatIsoDateParts(nextYear, nextMonth, 1);

  const monthTag = `${String(start.year).padStart(4, '0')}-${String(start.month).padStart(2, '0')}`;
  const canonicalKey = `CAL:${monthTag}`;
  const cycleKey = params.cycleKey ? params.cycleKey.trim() : canonicalKey;
  if (cycleKey !== canonicalKey && cycleKey !== monthTag) {
    throw new ApiHttpException({
      statusCode: 422,
      errorCode: 'VALIDATION_ERROR',
      message: `CALENDAR_MONTH cycle_key '${cycleKey}' does not match period_start_date month (${canonicalKey})`,
    });
  }

  const enrollStart = validateIsoDate(
    params.enrollmentBillingStartDate,
    'enrollmentBillingStartDate',
  );
  const isFirstPartialPeriod =
    enrollStart > params.periodStartDate && enrollStart <= canonicalEnd;
  const effectiveEnrollmentStartDate = isFirstPartialPeriod
    ? enrollStart
    : params.periodStartDate;

  return Object.freeze({
    kind: 'CALENDAR_MONTH',
    billingMode: 'CALENDAR_PRO_RATA',
    cycleType: 'CALENDAR_MONTH',
    cycleKey,
    cycleSeq: params.cycleSeq ?? 1,
    periodStartDate: params.periodStartDate,
    periodEndDate: canonicalEnd,
    nextPeriodStartDate,
    effectiveEnrollmentStartDate,
    isFirstPartialPeriod,
  });
}

/**
 * Builds and validates a `ROLLING_MONTH` cycle specification chained from `previousCycleEndDate` (if any).
 */
export function buildRollingMonthCycleSpec(params: {
  readonly periodStartDate: string;
  readonly periodEndDate?: string | null;
  readonly cycleKey?: string;
  readonly cycleSeq?: number;
  readonly previousCycleEndDate?: string | null;
  readonly enrollmentBillingStartDate: string;
  readonly rollingMonthEndMode?: RollingMonthEndMode;
}): RollingMonthCycleSpec {
  const start = validateIsoDate(params.periodStartDate, 'period_start_date');

  if (params.previousCycleEndDate) {
    const expectedNextStart = addCalendarDaysToIsoDate(params.previousCycleEndDate, 1);
    if (start !== expectedNextStart) {
      throw new ApiHttpException({
        statusCode: 422,
        errorCode: 'VALIDATION_ERROR',
        message: `ROLLING_MONTH period_start_date (${start}) must chain directly from previous period_end_date (${params.previousCycleEndDate} -> ${expectedNextStart}) without gap or overlap (OWNER-20261104-03)`,
      });
    }
  }

  const { nextRenewalDate, inclusivePeriodEndDate } = computeNextRollingRenewalDate(
    start,
    params.rollingMonthEndMode ?? 'CONTINUE_FROM_CLAMPED_DAY',
  );

  if (params.periodEndDate && params.periodEndDate !== inclusivePeriodEndDate) {
    throw new ApiHttpException({
      statusCode: 422,
      errorCode: 'VALIDATION_ERROR',
      message: `ROLLING_MONTH period_end_date (${params.periodEndDate}) must equal inclusive renewal boundary (${inclusivePeriodEndDate})`,
    });
  }

  const enrollStart = validateIsoDate(
    params.enrollmentBillingStartDate,
    'enrollmentBillingStartDate',
  );
  const isFirstPartialPeriod =
    enrollStart > start && enrollStart <= inclusivePeriodEndDate;
  const effectiveEnrollmentStartDate = isFirstPartialPeriod ? enrollStart : start;
  const { day: activeAnchorDay } = parseIsoDateParts(start);

  return Object.freeze({
    kind: 'ROLLING_MONTH',
    billingMode: 'ROLLING_MONTH',
    cycleType: 'ROLLING_MONTH',
    cycleKey: params.cycleKey ? params.cycleKey.trim() : `ROL:${start}`,
    cycleSeq: params.cycleSeq ?? 1,
    periodStartDate: start,
    periodEndDate: inclusivePeriodEndDate,
    nextRenewalDate,
    activeAnchorDay,
    effectiveEnrollmentStartDate,
    isFirstPartialPeriod,
  });
}

/**
 * Builds and validates a `LESSON_PACKAGE_12` cycle specification (`PKG:1`, `PKG:2`, ...),
 * deduplicating consumed lessons by `lesson_id` and enforcing `D21` package cancellation boundaries.
 */
export function buildLessonPackage12CycleSpec(params: {
  readonly cycleKey: string;
  readonly cycleSeq?: number;
  readonly periodStartDate: string;
  readonly periodEndDate?: string | null;
  readonly lessonsPerCycle?: number;
  readonly packageCancelMode?: PackageCancelMode;
  readonly lessonOccurrences?: readonly {
    readonly id: string;
    readonly status: string;
  }[];
  readonly attendedLessonIds?: readonly string[];
}): LessonPackage12CycleSpec {
  const rawKey = params.cycleKey.trim();
  const match = /^PKG:([1-9][0-9]*)$/.exec(rawKey);
  if (!match) {
    throw new ApiHttpException({
      statusCode: 422,
      errorCode: 'VALIDATION_ERROR',
      message: `LESSON_PACKAGE_12 cycle_key '${rawKey}' must follow canonical format PKG:<positive_seq> (e.g. PKG:1, PKG:2)`,
    });
  }
  const parsedSeq = Number(match[1]);
  const cycleSeq = params.cycleSeq ?? parsedSeq;
  if (cycleSeq !== parsedSeq) {
    throw new ApiHttpException({
      statusCode: 422,
      errorCode: 'VALIDATION_ERROR',
      message: `LESSON_PACKAGE_12 cycle_seq (${cycleSeq}) must match cycle_key '${rawKey}'`,
    });
  }

  const lessonsPerCycle = params.lessonsPerCycle ?? 12;
  if (!Number.isInteger(lessonsPerCycle) || lessonsPerCycle < 1) {
    throw new ApiHttpException({
      statusCode: 422,
      errorCode: 'VALIDATION_ERROR',
      message: 'lessons_per_cycle must be a positive integer for LESSON_PACKAGE_12',
    });
  }

  const packageCancelMode: PackageCancelMode = params.packageCancelMode ?? 'PRESERVE_BALANCE';
  if (packageCancelMode === 'UNCONFIGURED') {
    throw new ApiHttpException({
      statusCode: 403,
      errorCode: 'POLICY_DECISION_NOT_CONFIRMED',
      message: 'package_cancel_mode is UNCONFIGURED for LESSON_PACKAGE_12 (D21)',
    });
  }

  const occurrences = params.lessonOccurrences ?? [];
  let cancelledSkippedCount = 0;
  const eligibleIds: string[] = [];
  const seenLessonIds = new Set<string>();

  for (const occ of occurrences) {
    if (seenLessonIds.has(occ.id)) continue;
    seenLessonIds.add(occ.id);

    if (occ.status === 'RESCHEDULED') {
      continue;
    }
    if (occ.status === 'CANCELLED_BY_CENTER') {
      if (packageCancelMode === 'CREDIT_NEXT_CYCLE') {
        throw new ApiHttpException({
          statusCode: 403,
          errorCode: 'POLICY_DECISION_NOT_CONFIRMED',
          message:
            'LESSON_PACKAGE_12 cancelled-lesson CreditNote adjustment (CREDIT_NEXT_CYCLE) is not confirmed (D21)',
        });
      }
      // Under PRESERVE_BALANCE, center-cancelled lesson does NOT consume package balance
      cancelledSkippedCount += 1;
      continue;
    }
    if (eligibleIds.length < lessonsPerCycle) {
      eligibleIds.push(occ.id);
    }
  }

  const eligibleSet = new Set(eligibleIds);
  const distinctConsumedSet = new Set<string>();
  for (const attendedId of params.attendedLessonIds ?? []) {
    if (eligibleSet.size === 0 || eligibleSet.has(attendedId)) {
      distinctConsumedSet.add(attendedId);
    }
  }
  const distinctConsumedLessonsCount = Math.min(lessonsPerCycle, distinctConsumedSet.size);
  const packageLessonsRemaining = Math.max(0, lessonsPerCycle - distinctConsumedLessonsCount);

  return Object.freeze({
    kind: 'LESSON_PACKAGE_12',
    billingMode: 'LESSON_PACKAGE_12',
    cycleType: 'LESSON_PACKAGE_12',
    cycleKey: rawKey,
    cycleSeq,
    periodStartDate: validateIsoDate(params.periodStartDate, 'period_start_date'),
    periodEndDate: params.periodEndDate ? validateIsoDate(params.periodEndDate, 'period_end_date') : null,
    lessonsPerCycle,
    distinctEligibleLessonIds: Object.freeze(eligibleIds),
    distinctConsumedLessonsCount,
    packageLessonsRemaining,
    cancelledLessonsSkippedCount: cancelledSkippedCount,
  });
}

/**
 * Resolves the invoice `due_date` (`YYYY-MM-DD`) orthogonally from `due_date_rule` (`ENROLLMENT_ANNIVERSARY` vs `CENTER_FIXED_DAY`)
 * and `collection_timing` (`ARREARS` vs `ADVANCE`) per `OWNER-20261104-02` and `OWNER-20261104-03`:
 * - Anniversary + Arrears: `Aug 12 -> Sep 12` (due on `nextRenewalDate` / day after `periodEndDate`).
 * - Anniversary + Advance: due on `periodStartDate`.
 * - Fixed Due Day (e.g. `15`) + Arrears: `Aug 12 -> Sep 15` for rolling period starting Aug 12; `Nov 01..Nov 30 -> Nov 15` for calendar month.
 * - Fixed Due Day (`29`, `30`, `31`) in a shorter month (e.g. Feb 31): NOT covered by the anniversary clamp rule (`OWNER-20261104-03` #3) ->
 *   flags `requiresPolicyConfirmation: true` in preview and throws `403 POLICY_DECISION_NOT_CONFIRMED` when `enforceConfirmed === true`.
 * - Fixed Due Day + Advance on an initial mid-month enrollment where `enrollmentStartDate > fixedDueDateInStartMonth`:
 *   flags `requiresPolicyConfirmation: true` in preview and throws `403 POLICY_DECISION_NOT_CONFIRMED` when `enforceConfirmed === true`.
 */
export function resolveCycleDueDate(params: {
  readonly cycleType: BillingCycleType;
  readonly periodStartDate: string;
  readonly periodEndDate: string | null;
  readonly dueDateRule: DueDateRule;
  readonly fixedDueDay: number | null;
  readonly collectionTiming: CollectionTiming;
  readonly isInitialCycle?: boolean;
  readonly enforceConfirmed?: boolean;
}): DueDateResolutionResult {
  const enforceConfirmed = params.enforceConfirmed ?? true;

  if (params.dueDateRule === 'ENROLLMENT_ANNIVERSARY') {
    if (params.collectionTiming === 'ADVANCE') {
      return Object.freeze({
        dueDate: params.periodStartDate,
        dueDateRule: params.dueDateRule,
        fixedDueDay: null,
        collectionTiming: params.collectionTiming,
        requiresPolicyConfirmation: false,
        policyConfirmationReason: null,
      });
    }
    // ARREARS: due at the end of the service period (next renewal date = periodEndDate + 1 day, or periodStartDate + 1 month)
    const dueDate = params.periodEndDate
      ? addCalendarDaysToIsoDate(params.periodEndDate, 1)
      : computeNextRollingRenewalDate(params.periodStartDate, 'CONTINUE_FROM_CLAMPED_DAY')
          .nextRenewalDate;

    return Object.freeze({
      dueDate,
      dueDateRule: params.dueDateRule,
      fixedDueDay: null,
      collectionTiming: params.collectionTiming,
      requiresPolicyConfirmation: false,
      policyConfirmationReason: null,
    });
  }

  // CENTER_FIXED_DAY
  const fixedDay = params.fixedDueDay;
  if (fixedDay === null || fixedDay === undefined || fixedDay < 1 || fixedDay > 31) {
    throw new ApiHttpException({
      statusCode: 400,
      errorCode: 'VALIDATION_ERROR',
      message: 'fixed_due_day (1..31) is required when due_date_rule is CENTER_FIXED_DAY',
    });
  }

  const startParts = parseIsoDateParts(params.periodStartDate);

  // Determine target year/month for the fixed due day
  let targetYear = startParts.year;
  let targetMonth = startParts.month;

  if (params.collectionTiming === 'ARREARS') {
    if (params.cycleType === 'ROLLING_MONTH' || startParts.day > fixedDay) {
      targetYear = startParts.month === 12 ? startParts.year + 1 : startParts.year;
      targetMonth = startParts.month === 12 ? 1 : startParts.month + 1;
    }
  } else {
    // ADVANCE + CENTER_FIXED_DAY
    if (Boolean(params.isInitialCycle) && startParts.day > fixedDay) {
      const reason =
        `Ambiguous initial prepaid service-period boundary for CENTER_FIXED_DAY=${fixedDay} with ADVANCE timing when period_start_date=${params.periodStartDate} is after day ${fixedDay} (OWNER-20261104-02 / OWNER-20261104-03)`;
      if (enforceConfirmed) {
        throw new ApiHttpException({
          statusCode: 403,
          errorCode: 'POLICY_DECISION_NOT_CONFIRMED',
          message: reason,
        });
      }
      return Object.freeze({
        dueDate: formatIsoDateParts(
          startParts.month === 12 ? startParts.year + 1 : startParts.year,
          startParts.month === 12 ? 1 : startParts.month + 1,
          Math.min(
            fixedDay,
            daysInGregorianMonth(
              startParts.month === 12 ? startParts.year + 1 : startParts.year,
              startParts.month === 12 ? 1 : startParts.month + 1,
            ),
          ),
        ),
        dueDateRule: params.dueDateRule,
        fixedDueDay: fixedDay,
        collectionTiming: params.collectionTiming,
        requiresPolicyConfirmation: true,
        policyConfirmationReason: reason,
      });
    }
  }

  const maxDayInTargetMonth = daysInGregorianMonth(targetYear, targetMonth);
  if (fixedDay > maxDayInTargetMonth) {
    const reason =
      `CENTER_FIXED_DAY=${fixedDay} does not exist in target month ${targetYear}-${String(targetMonth).padStart(2, '0')} (max=${maxDayInTargetMonth}); fixed due-day short-month clamping is not assumed from anniversary rules (OWNER-20261104-03)`;
    if (enforceConfirmed) {
      throw new ApiHttpException({
        statusCode: 403,
        errorCode: 'POLICY_DECISION_NOT_CONFIRMED',
        message: reason,
      });
    }
    return Object.freeze({
      dueDate: formatIsoDateParts(targetYear, targetMonth, maxDayInTargetMonth),
      dueDateRule: params.dueDateRule,
      fixedDueDay: fixedDay,
      collectionTiming: params.collectionTiming,
      requiresPolicyConfirmation: true,
      policyConfirmationReason: reason,
    });
  }

  return Object.freeze({
    dueDate: formatIsoDateParts(targetYear, targetMonth, fixedDay),
    dueDateRule: params.dueDateRule,
    fixedDueDay: fixedDay,
    collectionTiming: params.collectionTiming,
    requiresPolicyConfirmation: false,
    policyConfirmationReason: null,
  });
}

export function assertGroupBillingModeMatchesCycleType(
  groupBillingMode: BillingMode,
  cycleType: BillingCycleType,
): void {
  const expectedCycleType: BillingCycleType =
    groupBillingMode === 'CALENDAR_PRO_RATA'
      ? 'CALENDAR_MONTH'
      : groupBillingMode === 'ROLLING_MONTH'
        ? 'ROLLING_MONTH'
        : 'LESSON_PACKAGE_12';

  if (cycleType !== expectedCycleType) {
    throw new ApiHttpException({
      statusCode: 422,
      errorCode: 'VALIDATION_ERROR',
      message: `Requested cycle_type '${cycleType}' does not match group billing_mode '${groupBillingMode}' (expected '${expectedCycleType}')`,
    });
  }
}
