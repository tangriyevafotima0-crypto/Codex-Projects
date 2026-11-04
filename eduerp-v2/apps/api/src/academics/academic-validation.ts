import type { BillingMode, CollectionTiming, DueDateRule } from '@eduerp/contracts';
import { ApiHttpException } from '../auth/auth.errors';
import { validateIsoDate } from '../students/normalization';

export type ScheduleDayCode = 'MON' | 'TUE' | 'WED' | 'THU' | 'FRI' | 'SAT' | 'SUN';
export type LessonStatus = 'SCHEDULED' | 'COMPLETED' | 'CANCELLED_BY_CENTER' | 'RESCHEDULED';
export type CancellationSource =
  | 'ADMIN_MANUAL'
  | 'PUBLIC_HOLIDAY'
  | 'WEATHER_EMERGENCY'
  | 'HOLIDAY_CALENDAR_INPUT';
export type DstDisambiguationMode = 'REJECT' | 'EARLIER' | 'LATER';

export const ALLOWED_SCHEDULE_DAYS: ReadonlySet<ScheduleDayCode> = new Set([
  'MON',
  'TUE',
  'WED',
  'THU',
  'FRI',
  'SAT',
  'SUN',
]);

export const ALLOWED_BILLING_MODES: ReadonlySet<BillingMode> = new Set([
  'CALENDAR_PRO_RATA',
  'ROLLING_MONTH',
  'LESSON_PACKAGE_12',
]);

export const ALLOWED_DUE_DATE_RULES: ReadonlySet<DueDateRule> = new Set([
  'ENROLLMENT_ANNIVERSARY',
  'CENTER_FIXED_DAY',
]);

export const ALLOWED_COLLECTION_TIMINGS: ReadonlySet<CollectionTiming> = new Set([
  'ADVANCE',
  'ARREARS',
]);

export const ALLOWED_CANCELLATION_SOURCES: ReadonlySet<CancellationSource> = new Set([
  'ADMIN_MANUAL',
  'PUBLIC_HOLIDAY',
  'WEATHER_EMERGENCY',
  'HOLIDAY_CALENDAR_INPUT',
]);

export const MAX_SIGNED_BIGINT_UZS = 9223372036854775807n;
const NON_NEGATIVE_MONEY_REGEX = /^(0|[1-9][0-9]{0,18})$/;
const WALL_TIME_HH_MM_REGEX = /^([01][0-9]|2[0-3]):([0-5][0-9])$/;
const CONTROL_CHAR_REGEX = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;

/**
 * Validates a non-negative integer UZS amount within PostgreSQL BIGINT bounds (0 .. 9223372036854775807).
 * Rejects negative numbers, decimals, leading zeros, or values exceeding int64 max.
 */
export function parseNonNegativeMoneyUzs(raw: unknown, fieldName: string): bigint {
  if (typeof raw !== 'string' || !NON_NEGATIVE_MONEY_REGEX.test(raw)) {
    throw new ApiHttpException({
      statusCode: 400,
      errorCode: 'VALIDATION_ERROR',
      message: `${fieldName} must be a non-negative integer UZS string matching ^(0|[1-9][0-9]{0,18})$`,
    });
  }
  const value = BigInt(raw);
  if (value < 0n || value > MAX_SIGNED_BIGINT_UZS) {
    throw new ApiHttpException({
      statusCode: 422,
      errorCode: 'VALIDATION_ERROR',
      message: `${fieldName} exceeds signed 64-bit BIGINT bounds (0..9223372036854775807)`,
    });
  }
  return value;
}

export function validateIanaTimezone(raw: unknown, fieldName = 'timezone'): string {
  if (typeof raw !== 'string' || raw.trim().length === 0 || raw.trim().length > 64) {
    throw new ApiHttpException({
      statusCode: 400,
      errorCode: 'VALIDATION_ERROR',
      message: `${fieldName} must be a valid IANA timezone identifier`,
    });
  }
  const trimmed = raw.trim();
  // Reject raw numeric offset strings like '+05:00' or 'GMT+5' so only explicit IANA zones (or UTC) are accepted
  if (/^[+-]\d/.test(trimmed) || /^GMT[+-]/i.test(trimmed) || /^UTC[+-]/i.test(trimmed)) {
    throw new ApiHttpException({
      statusCode: 400,
      errorCode: 'VALIDATION_ERROR',
      message: `${fieldName} must be an explicit IANA timezone name (e.g. Asia/Tashkent), not a fixed offset`,
    });
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: trimmed }).format(new Date(0));
    return trimmed;
  } catch {
    throw new ApiHttpException({
      statusCode: 400,
      errorCode: 'VALIDATION_ERROR',
      message: `${fieldName} '${trimmed}' is not a recognized IANA timezone`,
    });
  }
}

export function validateWallTimeHhMm(
  raw: unknown,
  fieldName = 'starts_time',
): { readonly formatted: string; readonly hour: number; readonly minute: number } {
  if (typeof raw !== 'string' || !WALL_TIME_HH_MM_REGEX.test(raw.trim())) {
    throw new ApiHttpException({
      statusCode: 400,
      errorCode: 'VALIDATION_ERROR',
      message: `${fieldName} must be in 24-hour HH:MM format (00:00..23:59)`,
    });
  }
  const trimmed = raw.trim();
  const [hStr, mStr] = trimmed.split(':');
  return {
    formatted: trimmed,
    hour: Number(hStr),
    minute: Number(mStr),
  };
}

export function validateScheduleDays(raw: unknown, fieldName = 'schedule_days'): readonly ScheduleDayCode[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 7) {
    throw new ApiHttpException({
      statusCode: 400,
      errorCode: 'VALIDATION_ERROR',
      message: `${fieldName} must be a non-empty array of 1..7 weekday codes (MON..SUN)`,
    });
  }
  const seen = new Set<ScheduleDayCode>();
  const result: ScheduleDayCode[] = [];
  for (const item of raw) {
    if (typeof item !== 'string' || !ALLOWED_SCHEDULE_DAYS.has(item as ScheduleDayCode)) {
      throw new ApiHttpException({
        statusCode: 400,
        errorCode: 'VALIDATION_ERROR',
        message: `${fieldName} contains invalid day '${String(item)}'; allowed values are MON, TUE, WED, THU, FRI, SAT, SUN`,
      });
    }
    const code = item as ScheduleDayCode;
    if (seen.has(code)) {
      throw new ApiHttpException({
        statusCode: 400,
        errorCode: 'VALIDATION_ERROR',
        message: `${fieldName} must not contain duplicate weekday '${code}'`,
      });
    }
    seen.add(code);
    result.push(code);
  }
  return Object.freeze(result);
}

const SHORT_WEEKDAY_MAP: Readonly<Record<string, ScheduleDayCode>> = Object.freeze({
  Mon: 'MON',
  Tue: 'TUE',
  Wed: 'WED',
  Thu: 'THU',
  Fri: 'FRI',
  Sat: 'SAT',
  Sun: 'SUN',
});

/**
 * Formats a UTC instant into calendar date (`YYYY-MM-DD`), wall time (`HH:MM:SS`), and weekday (`MON`..`SUN`)
 * in the target IANA timezone, 100% independent of the Node process timezone (`process.env.TZ`).
 */
export function formatInstantInTimezone(
  instant: Date,
  timeZone: string,
): {
  readonly date: string;
  readonly time: string;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly weekday: ScheduleDayCode;
} {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);

  const year = parts.find((p) => p.type === 'year')?.value ?? '1970';
  const month = parts.find((p) => p.type === 'month')?.value ?? '01';
  const day = parts.find((p) => p.type === 'day')?.value ?? '01';
  const hourStr = parts.find((p) => p.type === 'hour')?.value ?? '00';
  const minuteStr = parts.find((p) => p.type === 'minute')?.value ?? '00';
  const secondStr = parts.find((p) => p.type === 'second')?.value ?? '00';
  const wkRaw = parts.find((p) => p.type === 'weekday')?.value ?? 'Mon';
  const weekday = SHORT_WEEKDAY_MAP[wkRaw] ?? 'MON';

  return {
    date: `${year}-${month}-${day}`,
    time: `${hourStr}:${minuteStr}:${secondStr}`,
    hour: Number(hourStr),
    minute: Number(minuteStr),
    second: Number(secondStr),
    weekday,
  };
}

/**
 * Converts a calendar date (`YYYY-MM-DD`) and local wall time (`HH:MM`) in an explicit IANA timezone
 * into a UTC `Date` instant, independent of `process.env.TZ`.
 *
 * - If the local wall time does NOT exist on `lessonDate` in `timeZone` (e.g. a spring-forward DST gap
 *   such as `2026-03-08 02:30` in `America/New_York`), throws `422 VALIDATION_ERROR` (`NONEXISTENT_LOCAL_TIME_DST_GAP`).
 * - If the local wall time occurs TWICE on `lessonDate` in `timeZone` (e.g. a fall-back DST overlap
 *   such as `2026-11-01 01:30` in `America/New_York`):
 *   - When `disambiguation === 'REJECT'` (default), throws `422 VALIDATION_ERROR` (`AMBIGUOUS_LOCAL_TIME_DST_OVERLAP`).
 *   - When `disambiguation === 'EARLIER'`, selects the earlier UTC instant (pre-transition offset).
 *   - When `disambiguation === 'LATER'`, selects the later UTC instant (post-transition offset).
 */
export function resolveWallTimeToUtcInstant(params: {
  readonly lessonDate: string;
  readonly localTime: string;
  readonly timeZone: string;
  readonly disambiguation?: DstDisambiguationMode;
}): Date {
  const dateStr = validateIsoDate(params.lessonDate, 'lesson_date');
  const { formatted: timeStr, hour, minute } = validateWallTimeHhMm(
    params.localTime,
    'local_starts_time',
  );
  const tz = validateIanaTimezone(params.timeZone, 'timezone');
  const disambiguation: DstDisambiguationMode = params.disambiguation ?? 'REJECT';

  const [yStr, mStr, dStr] = dateStr.split('-');
  const targetUtcNominalMs = Date.UTC(
    Number(yStr),
    Number(mStr) - 1,
    Number(dStr),
    hour,
    minute,
    0,
    0,
  );

  // Sample offsets across a [-18h, +18h] window in 30-minute steps to discover all candidate UTC instants
  // whose local wall representation in `tz` could match (dateStr, hour, minute, 0).
  const candidateUtcMsSet = new Set<number>();
  for (let deltaMinutes = -18 * 60; deltaMinutes <= 18 * 60; deltaMinutes += 30) {
    const probeMs = targetUtcNominalMs + deltaMinutes * 60_000;
    const formatted = formatInstantInTimezone(new Date(probeMs), tz);
    const [fY, fM, fD] = formatted.date.split('-').map(Number);
    const probeAsUtcMs = Date.UTC(
      fY,
      fM - 1,
      fD,
      formatted.hour,
      formatted.minute,
      formatted.second,
      0,
    );
    const offsetMs = probeAsUtcMs - probeMs;
    const candidateMs = targetUtcNominalMs - offsetMs;
    const verify = formatInstantInTimezone(new Date(candidateMs), tz);
    if (
      verify.date === dateStr &&
      verify.hour === hour &&
      verify.minute === minute &&
      verify.second === 0
    ) {
      candidateUtcMsSet.add(candidateMs);
    }
  }

  const matchingInstants = [...candidateUtcMsSet].sort((a, b) => a - b);

  if (matchingInstants.length === 0) {
    throw new ApiHttpException({
      statusCode: 422,
      errorCode: 'VALIDATION_ERROR',
      message: `NONEXISTENT_LOCAL_TIME_DST_GAP: Local wall time ${dateStr} ${timeStr} does not exist in timezone ${tz} due to a DST transition gap`,
    });
  }

  if (matchingInstants.length > 1) {
    if (disambiguation === 'REJECT') {
      throw new ApiHttpException({
        statusCode: 422,
        errorCode: 'VALIDATION_ERROR',
        message: `AMBIGUOUS_LOCAL_TIME_DST_OVERLAP: Local wall time ${dateStr} ${timeStr} occurs twice in timezone ${tz}; specify dst_disambiguation ('EARLIER' or 'LATER') or explicit starts_at_utc`,
      });
    }
    if (disambiguation === 'EARLIER') {
      return new Date(matchingInstants[0]);
    }
    return new Date(matchingInstants[matchingInstants.length - 1]);
  }

  return new Date(matchingInstants[0]);
}

/**
 * Pure calendar weekday computation ('MON'..'SUN') for an ISO calendar date ('YYYY-MM-DD'),
 * independent of process timezone.
 */
export function getIsoDateWeekday(isoDate: string): ScheduleDayCode {
  const validated = validateIsoDate(isoDate, 'date');
  const [y, m, d] = validated.split('-').map(Number);
  const utcDay = new Date(Date.UTC(y, m - 1, d, 12, 0, 0)).getUTCDay();
  const map: readonly ScheduleDayCode[] = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
  return map[utcDay] ?? 'MON';
}

/**
 * Steps through ISO calendar dates from `startDate` to `endDate` inclusive, independent of process TZ.
 */
export function enumerateCalendarDatesInclusive(
  startDate: string,
  endDate: string,
  maxDays = 62,
): readonly string[] {
  const start = validateIsoDate(startDate, 'start_date');
  const end = validateIsoDate(endDate, 'end_date');
  if (end < start) {
    throw new ApiHttpException({
      statusCode: 422,
      errorCode: 'VALIDATION_ERROR',
      message: `end_date (${end}) cannot be earlier than start_date (${start})`,
    });
  }
  const [sY, sM, sD] = start.split('-').map(Number);
  const [eY, eM, eD] = end.split('-').map(Number);
  const startUtcMs = Date.UTC(sY, sM - 1, sD, 12, 0, 0);
  const endUtcMs = Date.UTC(eY, eM - 1, eD, 12, 0, 0);
  const totalDays = Math.round((endUtcMs - startUtcMs) / 86_400_000) + 1;
  if (totalDays > maxDays) {
    throw new ApiHttpException({
      statusCode: 422,
      errorCode: 'VALIDATION_ERROR',
      message: `Date range (${totalDays} days) exceeds maximum batch generation window of ${maxDays} days`,
    });
  }
  const dates: string[] = [];
  for (let i = 0; i < totalDays; i += 1) {
    const dt = new Date(startUtcMs + i * 86_400_000);
    dates.push(dt.toISOString().slice(0, 10));
  }
  return Object.freeze(dates);
}

/**
 * 07.04 Server-side plain-text comment validator & sanitizer:
 * - Rejects non-strings, strings > 500 chars, or ASCII control characters.
 * - Neutralizes HTML/script angle brackets (< and >) and inline event-handler / javascript: tokens
 *   so stored `comment_sanitized` is strictly plain text at the server/API JSON boundary.
 */
export function sanitizePlainTextGradeComment(
  raw: unknown,
  fieldName = 'comment',
): string | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  if (typeof raw !== 'string') {
    throw new ApiHttpException({
      statusCode: 400,
      errorCode: 'VALIDATION_ERROR',
      message: `${fieldName} must be a string up to 500 characters`,
    });
  }
  if (CONTROL_CHAR_REGEX.test(raw)) {
    throw new ApiHttpException({
      statusCode: 400,
      errorCode: 'VALIDATION_ERROR',
      message: `${fieldName} must not contain control characters`,
    });
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (trimmed.length > 500) {
    throw new ApiHttpException({
      statusCode: 400,
      errorCode: 'VALIDATION_ERROR',
      message: `${fieldName} must not exceed 500 characters`,
    });
  }

  // Strip angle-bracket tags and neutralize any remaining <, >, or javascript: protocol tokens
  const neutralized = trimmed
    .replace(/<\/?\s*script[^>]*>/gi, '[REDACTED_TAG]')
    .replace(/on[a-z]+\s*=/gi, 'attr_blocked=')
    .replace(/javascript\s*:/gi, 'blocked_proto:')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  if (neutralized.length > 500) {
    return neutralized.slice(0, 500);
  }
  return neutralized;
}

export function validateGradeScore(raw: unknown, fieldName = 'score'): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    throw new ApiHttpException({
      statusCode: 400,
      errorCode: 'VALIDATION_ERROR',
      message: `${fieldName} must be a finite number between 0 and 100`,
    });
  }
  if (raw < 0 || raw > 100) {
    throw new ApiHttpException({
      statusCode: 422,
      errorCode: 'VALIDATION_ERROR',
      message: `${fieldName} (${raw}) must be between 0 and 100 inclusive`,
    });
  }
  const scaled = Math.round(raw * 100);
  if (Math.abs(raw * 100 - scaled) > 1e-6) {
    throw new ApiHttpException({
      statusCode: 400,
      errorCode: 'VALIDATION_ERROR',
      message: `${fieldName} may have at most 2 decimal places`,
    });
  }
  return scaled / 100;
}

/**
 * 07.02 Operational Eligibility Contract Predicate:
 * Cancelled (`CANCELLED_BY_CENTER`) and replaced (`RESCHEDULED`) lessons are never eligible to trigger
 * 20-minute teacher attendance pings (`TeacherPingDue`), 2-lesson trial conversions (`TrialActivated`),
 * or 12-lesson package balance deductions.
 */
export function isLessonEligibleForOperationalTriggers(status: LessonStatus): {
  readonly eligible_for_teacher_ping: boolean;
  readonly eligible_for_trial_conversion: boolean;
  readonly eligible_for_package_consumption: boolean;
} {
  return Object.freeze({
    eligible_for_teacher_ping: status === 'SCHEDULED',
    eligible_for_trial_conversion: status === 'SCHEDULED' || status === 'COMPLETED',
    eligible_for_package_consumption: status === 'SCHEDULED' || status === 'COMPLETED',
  });
}
