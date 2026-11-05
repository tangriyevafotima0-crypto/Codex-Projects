/**
 * EduERP v2.0 — Stage 08, Step 08.02 (`T08.02`, `K04`, `K05`, `K07`):
 * Discriminated Subscription & Cycle Boundary Policies (`CALENDAR_MONTH`, `ROLLING_MONTH`, `LESSON_PACKAGE_12`),
 * Centralized Service-Begin Eligibility Enforcement (`K04`), and Orthogonal Due-Date / Collection-Timing Resolution.
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
 * K04 Authoritative Service-Begin Eligibility Guard:
 * Ensures no billing cycle or invoice is ever issued for a period before the student's
 * authoritative service begin date (`first_trial_date ?? enrolled_at_date`):
 * - For `CALENDAR_MONTH`: `periodEndDate < serviceBeginDate` (entire calendar month precedes enrollment) -> rejected with `422 VALIDATION_ERROR`.
 *   When `periodStartDate < serviceBeginDate <= periodEndDate`, the student joined mid-month during this calendar month (`isFirstPartialPeriod = true`).
 * - For `ROLLING_MONTH` and `LESSON_PACKAGE_12`: `periodStartDate < serviceBeginDate` -> rejected with `422 VALIDATION_ERROR`.
 */
export function assertServicePeriodEligibleForEnrollmentBegin(params: {
  readonly cycleType: BillingCycleType;
  readonly periodStartDate: string;
  readonly periodEndDate: string | null;
  readonly serviceBeginDate: string;
}): void {
  const begin = validateIsoDate(params.serviceBeginDate, 'serviceBeginDate');
  const start = validateIsoDate(params.periodStartDate, 'period_start_date');
  const end = params.periodEndDate
    ? validateIsoDate(params.periodEndDate, 'period_end_date')
    : null;

  if (end !== null && end < begin) {
    throw new ApiHttpException({
      statusCode: 422,
      errorCode: 'VALIDATION_ERROR',
      message: `Cannot bill service period ${start}..${end} because it ends before enrollment service begin date (${begin}) (K04)`,
    });
  }

  if (params.cycleType !== 'CALENDAR_MONTH' && start < begin) {
    throw new ApiHttpException({
      statusCode: 422,
      errorCode: 'VALIDATION_ERROR',
      message: `${params.cycleType} period_start_date (${start}) cannot precede enrollment service begin date (${begin}) (K04)`,
    });
  }
}

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

  const enrollStart = validateIsoDate(
    params.enrollmentBillingStartDate,
    'enrollmentBillingStartDate',
  );

  // K04: Reject any calendar month that ends wholly before the student's service begin date!
  assertServicePeriodEligibleForEnrollmentBegin({
    cycleType: 'CALENDAR_MONTH',
    periodStartDate: params.periodStartDate,
    periodEndDate: canonicalEnd,
    serviceBeginDate: enrollStart,
  });

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
  const enrollStart = validateIsoDate(
    params.enrollmentBillingStartDate,
    'enrollmentBillingStartDate',
  );

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

  // K04: Reject rolling period starting before enrollment service begin date
  assertServicePeriodEligibleForEnrollmentBegin({
    cycleType: 'ROLLING_MONTH',
    periodStartDate: start,
    periodEndDate: inclusivePeriodEndDate,
    serviceBeginDate: enrollStart,
  });

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
 * enforcing `K04` service-begin eligibility, `K07` per-package lesson slice ownership (never double-consuming
 * a lesson across `PKG:1` and `PKG:2` and never accepting unknown `attendedLessonIds` when `eligibleSet` is empty),
 * and `D21` package cancellation boundaries.
 */
export function buildLessonPackage12CycleSpec(params: {
  readonly cycleKey: string;
  readonly cycleSeq?: number;
  readonly periodStartDate: string;
  readonly periodEndDate?: string | null;
  readonly enrollmentBillingStartDate?: string;
  readonly lessonsPerCycle?: number;
  readonly packageCancelMode?: PackageCancelMode;
  readonly lessonOccurrences?: readonly {
    readonly id: string;
    readonly status: string;
  }[];
  readonly alreadyAllocatedLessonIds?: readonly string[];
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

  const periodStartDate = validateIsoDate(params.periodStartDate, 'period_start_date');
  const periodEndDate = params.periodEndDate
    ? validateIsoDate(params.periodEndDate, 'period_end_date')
    : null;

  if (params.enrollmentBillingStartDate) {
    assertServicePeriodEligibleForEnrollmentBegin({
      cycleType: 'LESSON_PACKAGE_12',
      periodStartDate,
      periodEndDate,
      serviceBeginDate: params.enrollmentBillingStartDate,
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
  const excludedPriorLessonIds = new Set<string>(params.alreadyAllocatedLessonIds ?? []);
  let cancelledSkippedCount = 0;
  const eligibleIds: string[] = [];
  const seenLessonIds = new Set<string>();

  for (const occ of occurrences) {
    if (seenLessonIds.has(occ.id) || excludedPriorLessonIds.has(occ.id)) continue;
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
      cancelledSkippedCount += 1;
      continue;
    }
    if (eligibleIds.length < lessonsPerCycle) {
      eligibleIds.push(occ.id);
    }
  }

  // K07: Only count attended lessons that belong to THIS package cycle's eligibleIds!
  // Never accept unknown attendedLessonIds when eligibleSet is empty or does not contain the lesson ID.
  const eligibleSet = new Set(eligibleIds);
  const distinctConsumedSet = new Set<string>();
  for (const attendedId of params.attendedLessonIds ?? []) {
    if (eligibleSet.has(attendedId)) {
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
    periodStartDate,
    periodEndDate,
    lessonsPerCycle,
    distinctEligibleLessonIds: Object.freeze(eligibleIds),
    distinctConsumedLessonsCount,
    packageLessonsRemaining,
    cancelledLessonsSkippedCount: cancelledSkippedCount,
  });
}

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

  let targetYear = startParts.year;
  let targetMonth = startParts.month;

  if (params.collectionTiming === 'ARREARS') {
    if (params.cycleType === 'ROLLING_MONTH' || startParts.day > fixedDay) {
      targetYear = startParts.month === 12 ? startParts.year + 1 : startParts.year;
      targetMonth = startParts.month === 12 ? 1 : startParts.month + 1;
    }
  } else {
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
