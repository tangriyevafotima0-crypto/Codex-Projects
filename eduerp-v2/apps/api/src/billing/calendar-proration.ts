/**
 * EduERP v2.0 — Stage 08, Step 08.01 (`T08.01`):
 * Exact Rational Integer Pro-Rata Calculation, HALF_UP Rounding & Lesson Snapshot Selection.
 *
 * Owner Decisions Enforced:
 * - `OWNER-20261104-03` #1: First partial-period charge is per-center choice (`PRORATE_REMAINING_LESSONS` vs `FULL_CYCLE`).
 *   Unconfigured mode fails closed with `403 POLICY_DECISION_NOT_CONFIRMED`.
 * - `OWNER-20261104-03` #2: UZS scale = 0; non-negative rational integer `HALF_UP` (`0.5` rounds up) using pure
 *   BigInt integer division & remainder (`2n * remainder >= denominator`), never IEEE-754 float / Math.round.
 */

import type {
  CancelledLessonProrationMode,
  FirstPartialChargeMode,
  RoundingMode,
} from '@eduerp/contracts';
import { ApiHttpException } from '../auth/auth.errors';
import {
  formatMoneyUzs,
  MAX_PG_BIGINT,
  MoneyValidationError,
  parseNonNegativeMoneyUzs,
} from '../database/money';
import {
  enumerateCalendarDatesInclusive,
  getIsoDateWeekday,
  ScheduleDayCode,
} from '../academics/academic-validation';

export interface ProrationCalculationInput {
  readonly tariffUzs: bigint | string;
  readonly plannedLessons: number;
  readonly remainingLessons: number;
  readonly isFirstPartialPeriod?: boolean;
  readonly firstPartialChargeMode?: FirstPartialChargeMode;
  readonly roundingMode?: RoundingMode;
}

export interface ProrationCalculationResult {
  readonly tariffSnapshotUzs: bigint;
  readonly tariffSnapshotStr: string;
  readonly plannedLessons: number;
  readonly billableLessons: number;
  readonly billedLessons: number;
  readonly chargeUzs: bigint;
  readonly chargeUzsStr: string;
  readonly isFirstPartialPeriod: boolean;
  readonly appliedChargeMode: 'FULL_PERIOD' | 'PRORATE_REMAINING_LESSONS' | 'FULL_CYCLE';
  readonly roundingMode: RoundingMode;
  readonly lineType: 'BASE_TARIFF' | 'PRO_RATA_CALC';
  readonly formulaSnapshot: string;
}

export interface LessonCandidateForPeriodSnapshot {
  readonly id: string;
  readonly lesson_date: string;
  readonly occurrence_seq: number;
  readonly status: string;
  readonly cancellation_source?: string | null;
}

export interface PeriodLessonSnapshotResult {
  readonly plannedLessons: number;
  readonly billableLessons: number;
  readonly cancelledLessonsExcludedCount: number;
  readonly rescheduledOriginalsExcludedCount: number;
  readonly eligibleLessonIds: readonly string[];
  readonly billableLessonIds: readonly string[];
  readonly source: 'LESSON_OCCURRENCES_TABLE' | 'GROUP_WEEKDAY_SCHEDULE';
}

function assertValidLessonCount(value: unknown, fieldName: string, allowZero: boolean): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || !Number.isSafeInteger(value)) {
    throw new ApiHttpException({
      statusCode: 400,
      errorCode: 'VALIDATION_ERROR',
      message: `${fieldName} must be a safe integer`,
    });
  }
  if (value < 0) {
    throw new ApiHttpException({
      statusCode: 422,
      errorCode: 'VALIDATION_ERROR',
      message: `${fieldName} cannot be negative`,
    });
  }
  if (!allowZero && value === 0) {
    throw new ApiHttpException({
      statusCode: 422,
      errorCode: 'INVALID_SCHEDULE_ZERO_LESSONS',
      message: `${fieldName} cannot be 0; billing is blocked when planned lessons in the period is 0 (T08.01)`,
    });
  }
  return value;
}

/**
 * Pure BigInt rational division with `HALF_UP` rounding (`0.5` rounds up to next integer UZS).
 * Intermediate `numerator` may exceed 64-bit bounds (e.g. `MAX_SAFE_INTEGER * 7`), while the final
 * rounded quotient is strictly verified to fit within signed 64-bit PostgreSQL `BIGINT` (`0..MAX_PG_BIGINT`).
 */
export function roundRationalHalfUpUzs(
  numerator: bigint,
  denominator: bigint,
  fieldName: string = 'base_pro_rata_charge_uzs',
): bigint {
  if (typeof numerator !== 'bigint' || typeof denominator !== 'bigint') {
    throw new ApiHttpException({
      statusCode: 400,
      errorCode: 'VALIDATION_ERROR',
      message: `${fieldName}: numerator and denominator must be bigint`,
    });
  }
  if (numerator < 0n) {
    throw new ApiHttpException({
      statusCode: 422,
      errorCode: 'VALIDATION_ERROR',
      message: `${fieldName}: negative rational numerator is not allowed for non-negative HALF_UP charge`,
    });
  }
  if (denominator <= 0n) {
    throw new ApiHttpException({
      statusCode: 422,
      errorCode: 'INVALID_SCHEDULE_ZERO_LESSONS',
      message: `${fieldName}: denominator must be > 0`,
    });
  }

  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  const rounded = remainder * 2n >= denominator ? quotient + 1n : quotient;

  if (rounded > MAX_PG_BIGINT) {
    throw new ApiHttpException({
      statusCode: 422,
      errorCode: 'VALIDATION_ERROR',
      message: `${fieldName}: calculated UZS amount overflows PostgreSQL 64-bit BIGINT maximum`,
    });
  }

  return rounded;
}

/**
 * T08.01 Core Proration & First-Period Charge Calculator.
 * - Verifies `tariffUzs` via `parseNonNegativeMoneyUzs` (rejecting JS numbers, floats, negatives, >19-digit/int64 overflow).
 * - Blocks billing when `plannedLessons === 0` (`422 INVALID_SCHEDULE_ZERO_LESSONS`).
 * - Rejects `remainingLessons > plannedLessons` or negative/non-integer counts (`422`/`400 VALIDATION_ERROR`).
 * - Enforces `OWNER-20261104-03` Decision #1 (`firstPartialChargeMode`: `PRORATE_REMAINING_LESSONS` vs `FULL_CYCLE`;
 *   `UNCONFIGURED` fails closed with `403 POLICY_DECISION_NOT_CONFIRMED`).
 * - Enforces `OWNER-20261104-03` Decision #2 (`HALF_UP_UZS_INT`: e.g. `480000 * 7 / 12 = 280000`, `1 * 1 / 2 = 1`, `1 * 1 / 3 = 0`, `1 * 2 / 3 = 1`).
 */
export function calculateProRataOrCycleChargeUzs(
  input: ProrationCalculationInput,
): ProrationCalculationResult {
  let tariffSnapshotUzs: bigint;
  try {
    tariffSnapshotUzs = parseNonNegativeMoneyUzs(input.tariffUzs, 'tariff_snapshot_uzs');
  } catch (err) {
    if (err instanceof MoneyValidationError) {
      throw new ApiHttpException({
        statusCode: 422,
        errorCode: 'VALIDATION_ERROR',
        message: err.message,
      });
    }
    throw err;
  }

  const plannedLessons = assertValidLessonCount(input.plannedLessons, 'planned_lessons', false);
  const remainingLessons = assertValidLessonCount(
    input.remainingLessons,
    'remaining_lessons',
    true,
  );

  if (remainingLessons > plannedLessons) {
    throw new ApiHttpException({
      statusCode: 422,
      errorCode: 'VALIDATION_ERROR',
      message: `remaining_lessons (${remainingLessons}) cannot exceed planned_lessons (${plannedLessons})`,
    });
  }

  const roundingMode: RoundingMode = input.roundingMode ?? 'HALF_UP_UZS_INT';
  if (roundingMode !== 'HALF_UP_UZS_INT') {
    throw new ApiHttpException({
      statusCode: 403,
      errorCode: 'POLICY_DECISION_NOT_CONFIRMED',
      message: `Rounding mode '${roundingMode}' is not confirmed (only HALF_UP_UZS_INT is confirmed under OWNER-20261104-03)`,
    });
  }

  const isPartial =
    Boolean(input.isFirstPartialPeriod) || remainingLessons < plannedLessons;
  const firstPartialChargeMode: FirstPartialChargeMode =
    input.firstPartialChargeMode ?? 'PRORATE_REMAINING_LESSONS';

  if (!isPartial && remainingLessons === plannedLessons) {
    const tariffStr = formatMoneyUzs(tariffSnapshotUzs, 'tariff_snapshot_uzs');
    return Object.freeze({
      tariffSnapshotUzs,
      tariffSnapshotStr: tariffStr,
      plannedLessons,
      billableLessons: plannedLessons,
      billedLessons: plannedLessons,
      chargeUzs: tariffSnapshotUzs,
      chargeUzsStr: tariffStr,
      isFirstPartialPeriod: false,
      appliedChargeMode: 'FULL_PERIOD',
      roundingMode,
      lineType: 'BASE_TARIFF',
      formulaSnapshot: `FULL_PERIOD: ${tariffStr} * ${plannedLessons}/${plannedLessons} = ${tariffStr} (${roundingMode})`,
    });
  }

  // Partial period: enforce per-center choice (OWNER-20261104-03 #1)
  if (firstPartialChargeMode === 'UNCONFIGURED') {
    throw new ApiHttpException({
      statusCode: 403,
      errorCode: 'POLICY_DECISION_NOT_CONFIRMED',
      message:
        'first_partial_charge_mode is UNCONFIGURED; center must explicitly configure PRORATE_REMAINING_LESSONS or FULL_CYCLE before issuing a partial-period invoice (OWNER-20261104-03)',
    });
  }

  const tariffStr = formatMoneyUzs(tariffSnapshotUzs, 'tariff_snapshot_uzs');

  if (firstPartialChargeMode === 'FULL_CYCLE') {
    if (remainingLessons === 0) {
      throw new ApiHttpException({
        statusCode: 403,
        errorCode: 'POLICY_DECISION_NOT_CONFIRMED',
        message:
          'FULL_CYCLE first-charge policy cannot bill a zero-lesson / no-service partial period (remaining_lessons=0) without explicit policy confirmation',
      });
    }
    return Object.freeze({
      tariffSnapshotUzs,
      tariffSnapshotStr: tariffStr,
      plannedLessons,
      billableLessons: remainingLessons,
      billedLessons: plannedLessons,
      chargeUzs: tariffSnapshotUzs,
      chargeUzsStr: tariffStr,
      isFirstPartialPeriod: true,
      appliedChargeMode: 'FULL_CYCLE',
      roundingMode,
      lineType: 'BASE_TARIFF',
      formulaSnapshot: `FULL_CYCLE: ${tariffStr} (remaining_lessons=${remainingLessons}/${plannedLessons}, ${roundingMode})`,
    });
  }

  // PRORATE_REMAINING_LESSONS
  if (remainingLessons === 0) {
    return Object.freeze({
      tariffSnapshotUzs,
      tariffSnapshotStr: tariffStr,
      plannedLessons,
      billableLessons: 0,
      billedLessons: 0,
      chargeUzs: 0n,
      chargeUzsStr: '0',
      isFirstPartialPeriod: true,
      appliedChargeMode: 'PRORATE_REMAINING_LESSONS',
      roundingMode,
      lineType: 'PRO_RATA_CALC',
      formulaSnapshot: `PRO_RATA: ${tariffStr} * 0/${plannedLessons} = 0 (${roundingMode})`,
    });
  }

  const numerator = tariffSnapshotUzs * BigInt(remainingLessons);
  const denominator = BigInt(plannedLessons);
  const chargeUzs = roundRationalHalfUpUzs(numerator, denominator, 'base_pro_rata_charge_uzs');
  const chargeStr = formatMoneyUzs(chargeUzs, 'base_pro_rata_charge_uzs');

  return Object.freeze({
    tariffSnapshotUzs,
    tariffSnapshotStr: tariffStr,
    plannedLessons,
    billableLessons: remainingLessons,
    billedLessons: remainingLessons,
    chargeUzs,
    chargeUzsStr: chargeStr,
    isFirstPartialPeriod: true,
    appliedChargeMode: 'PRORATE_REMAINING_LESSONS',
    roundingMode,
    lineType: 'PRO_RATA_CALC',
    formulaSnapshot: `PRO_RATA: ${tariffStr} * ${remainingLessons}/${plannedLessons} = ${chargeStr} (${roundingMode})`,
  });
}

/**
 * Selects the deterministic planned and billable lesson snapshot for a service period `[periodStartDate, periodEndDate]`:
 * - Uses actual `lesson_occurrences` in `[periodStartDate, periodEndDate]` when present; otherwise derives lesson dates
 *   from the group's `scheduleDays` (`MON..SUN`) — never using calendar day count in place of lesson count!
 * - `RESCHEDULED` original occurrences are always excluded because their replacement occurrence carries the active slot.
 * - `CANCELLED_BY_CENTER` occurrences are handled according to `cancelledLessonProrationMode`:
 *   * `EXCLUDE_CANCELLED_FROM_PLANNED`: cancelled lessons (such as public holidays) are excluded from both `plannedLessons` and `billableLessons`.
 *   * `COUNT_SCHEDULED_BASELINE`: includes originally scheduled occurrences in `plannedLessons` and `billableLessons`.
 *   * `UNCONFIGURED`: if any cancelled lesson exists in the period, fails closed with `403 POLICY_DECISION_NOT_CONFIRMED`.
 */
export function selectPeriodLessonSnapshot(params: {
  readonly periodStartDate: string;
  readonly periodEndDate: string;
  readonly effectiveEnrollmentStartDate: string;
  readonly lessonOccurrences: readonly LessonCandidateForPeriodSnapshot[];
  readonly scheduleDays: readonly ScheduleDayCode[];
  readonly cancelledLessonProrationMode?: CancelledLessonProrationMode;
}): PeriodLessonSnapshotResult {
  const mode: CancelledLessonProrationMode =
    params.cancelledLessonProrationMode ?? 'EXCLUDE_CANCELLED_FROM_PLANNED';

  const billableStartFloor =
    params.effectiveEnrollmentStartDate > params.periodStartDate
      ? params.effectiveEnrollmentStartDate
      : params.periodStartDate;

  if (params.lessonOccurrences.length > 0) {
    const inWindow = params.lessonOccurrences.filter(
      (l) => l.lesson_date >= params.periodStartDate && l.lesson_date <= params.periodEndDate,
    );

    let cancelledExcluded = 0;
    let rescheduledExcluded = 0;
    const eligible: LessonCandidateForPeriodSnapshot[] = [];

    for (const l of inWindow) {
      if (l.status === 'RESCHEDULED') {
        rescheduledExcluded += 1;
        continue;
      }
      if (l.status === 'CANCELLED_BY_CENTER') {
        if (mode === 'UNCONFIGURED') {
          throw new ApiHttpException({
            statusCode: 403,
            errorCode: 'POLICY_DECISION_NOT_CONFIRMED',
            message:
              'Period contains CANCELLED_BY_CENTER lessons while cancelled_lesson_proration_mode is UNCONFIGURED',
          });
        }
        if (mode === 'EXCLUDE_CANCELLED_FROM_PLANNED') {
          cancelledExcluded += 1;
          continue;
        }
      }
      eligible.push(l);
    }

    if (eligible.length === 0) {
      throw new ApiHttpException({
        statusCode: 422,
        errorCode: 'INVALID_SCHEDULE_ZERO_LESSONS',
        message: `Zero eligible planned lessons in service period ${params.periodStartDate}..${params.periodEndDate}; billing is blocked (T08.01)`,
      });
    }

    const billable = eligible.filter((l) => l.lesson_date >= billableStartFloor);

    return Object.freeze({
      plannedLessons: eligible.length,
      billableLessons: billable.length,
      cancelledLessonsExcludedCount: cancelledExcluded,
      rescheduledOriginalsExcludedCount: rescheduledExcluded,
      eligibleLessonIds: Object.freeze(eligible.map((l) => l.id)),
      billableLessonIds: Object.freeze(billable.map((l) => l.id)),
      source: 'LESSON_OCCURRENCES_TABLE',
    });
  }

  // Derive from group's weekday schedule when no lesson_occurrences rows exist yet for the period
  const scheduleSet = new Set<ScheduleDayCode>(params.scheduleDays);
  const allDates = enumerateCalendarDatesInclusive(params.periodStartDate, params.periodEndDate);
  const plannedDates = allDates.filter((d) => scheduleSet.has(getIsoDateWeekday(d)));

  if (plannedDates.length === 0) {
    throw new ApiHttpException({
      statusCode: 422,
      errorCode: 'INVALID_SCHEDULE_ZERO_LESSONS',
      message: `Zero scheduled lessons in service period ${params.periodStartDate}..${params.periodEndDate}; billing is blocked (T08.01)`,
    });
  }

  const billableDates = plannedDates.filter((d) => d >= billableStartFloor);

  return Object.freeze({
    plannedLessons: plannedDates.length,
    billableLessons: billableDates.length,
    cancelledLessonsExcludedCount: 0,
    rescheduledOriginalsExcludedCount: 0,
    eligibleLessonIds: Object.freeze([]),
    billableLessonIds: Object.freeze([]),
    source: 'GROUP_WEEKDAY_SCHEDULE',
  });
}
