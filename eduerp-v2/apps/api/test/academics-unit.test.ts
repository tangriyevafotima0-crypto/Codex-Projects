import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  enumerateCalendarDatesInclusive,
  formatInstantInTimezone,
  getIsoDateWeekday,
  isLessonEligibleForOperationalTriggers,
  parseNonNegativeMoneyUzs,
  resolveWallTimeToUtcInstant,
  sanitizePlainTextGradeComment,
  validateGradeScore,
  validateIanaTimezone,
  validateScheduleDays,
} from '../src/academics/academic-validation';

describe('Stage 07 Academics, Timezone/DST, Schedule & Grades Unit Tests (07.01..07.04)', () => {
  it('validates UZS BigInt money bounds (0..int64_max), schedule weekday arrays, and IANA timezones (ACAD-UNIT-01)', () => {
    assert.equal(parseNonNegativeMoneyUzs('0', 'fee'), 0n);
    assert.equal(parseNonNegativeMoneyUzs('480000', 'fee'), 480000n);
    assert.equal(parseNonNegativeMoneyUzs('9223372036854775807', 'fee'), 9223372036854775807n);

    for (const badFee of ['-1', '00', '480000.50', '9223372036854775808', 'abc', '']) {
      assert.throws(
        () => parseNonNegativeMoneyUzs(badFee, 'fee'),
        /fee/,
        `Expected parseNonNegativeMoneyUzs to reject ${badFee}`,
      );
    }

    assert.deepEqual(validateScheduleDays(['MON', 'WED', 'FRI']), ['MON', 'WED', 'FRI']);
    assert.throws(() => validateScheduleDays([]), /non-empty array/);
    assert.throws(() => validateScheduleDays(['MON', 'MON']), /duplicate weekday/);
    assert.throws(() => validateScheduleDays(['MONDAY']), /invalid day/);

    assert.equal(validateIanaTimezone('Asia/Tashkent'), 'Asia/Tashkent');
    assert.equal(validateIanaTimezone('America/New_York'), 'America/New_York');
    assert.throws(() => validateIanaTimezone('+05:00'), /explicit IANA timezone/);
    assert.throws(() => validateIanaTimezone('Invalid/Timezone_Name'), /not a recognized IANA timezone/);
  });

  it('converts local wall times to UTC instants independent of process TZ and rejects/disambiguates DST gaps and overlaps (ACAD-UNIT-02)', () => {
    // 1. Asia/Tashkent (UTC+5): 2026-11-04 09:00 local == 2026-11-04T04:00:00.000Z
    const tashkentUtc = resolveWallTimeToUtcInstant({
      lessonDate: '2026-11-04',
      localTime: '09:00',
      timeZone: 'Asia/Tashkent',
    });
    assert.equal(tashkentUtc.toISOString(), '2026-11-04T04:00:00.000Z');

    // Late evening in Asia/Tashkent: 2026-11-04 01:30 local == 2026-11-03T20:30:00.000Z (previous UTC day!)
    const tashkentEarlyMorning = resolveWallTimeToUtcInstant({
      lessonDate: '2026-11-04',
      localTime: '01:30',
      timeZone: 'Asia/Tashkent',
    });
    assert.equal(tashkentEarlyMorning.toISOString(), '2026-11-03T20:30:00.000Z');
    assert.equal(
      formatInstantInTimezone(tashkentEarlyMorning, 'Asia/Tashkent').date,
      '2026-11-04',
    );
    assert.equal(formatInstantInTimezone(tashkentEarlyMorning, 'UTC').date, '2026-11-03');

    // 2. Nonexistent spring-forward DST gap in America/New_York (2026-03-08 02:30 does not exist)
    assert.throws(
      () =>
        resolveWallTimeToUtcInstant({
          lessonDate: '2026-03-08',
          localTime: '02:30',
          timeZone: 'America/New_York',
        }),
      /NONEXISTENT_LOCAL_TIME_DST_GAP/,
    );

    // 3. Ambiguous fall-back DST overlap in America/New_York (2026-11-01 01:30 occurs twice: EDT UTC-4 and EST UTC-5)
    assert.throws(
      () =>
        resolveWallTimeToUtcInstant({
          lessonDate: '2026-11-01',
          localTime: '01:30',
          timeZone: 'America/New_York',
          disambiguation: 'REJECT',
        }),
      /AMBIGUOUS_LOCAL_TIME_DST_OVERLAP/,
    );

    const earlierDst = resolveWallTimeToUtcInstant({
      lessonDate: '2026-11-01',
      localTime: '01:30',
      timeZone: 'America/New_York',
      disambiguation: 'EARLIER',
    });
    const laterDst = resolveWallTimeToUtcInstant({
      lessonDate: '2026-11-01',
      localTime: '01:30',
      timeZone: 'America/New_York',
      disambiguation: 'LATER',
    });
    assert.equal(earlierDst.toISOString(), '2026-11-01T05:30:00.000Z');
    assert.equal(laterDst.toISOString(), '2026-11-01T06:30:00.000Z');

    assert.equal(getIsoDateWeekday('2026-11-04'), 'WED');
    assert.deepEqual(enumerateCalendarDatesInclusive('2026-11-01', '2026-11-03'), [
      '2026-11-01',
      '2026-11-02',
      '2026-11-03',
    ]);
  });

  it('validates grade scores (0..100), sanitizes plain-text comments against HTML/script tags, and evaluates lesson eligibility predicates (ACAD-UNIT-03)', () => {
    assert.equal(validateGradeScore(0), 0);
    assert.equal(validateGradeScore(100), 100);
    assert.equal(validateGradeScore(92.75), 92.75);
    assert.throws(() => validateGradeScore(-0.01), /between 0 and 100/);
    assert.throws(() => validateGradeScore(100.01), /between 0 and 100/);
    assert.throws(() => validateGradeScore(85.123), /2 decimal places/);
    assert.throws(() => validateGradeScore(Number.NaN), /finite number/);

    const sanitized = sanitizePlainTextGradeComment(
      '  <script>alert("xss")</script> Excellent progress & effort > 90%!  ',
    );
    assert.ok(sanitized);
    assert.equal(sanitized.includes('<script>'), false);
    assert.equal(sanitized.includes('</script>'), false);
    assert.equal(sanitized.includes('>'), false);
    assert.ok(sanitized.includes('[REDACTED_TAG]'));
    assert.throws(() => sanitizePlainTextGradeComment('Bad\x00Comment'), /control characters/);

    const schedElig = isLessonEligibleForOperationalTriggers('SCHEDULED');
    assert.equal(schedElig.eligible_for_teacher_ping, true);
    assert.equal(schedElig.eligible_for_trial_conversion, true);

    const cancelElig = isLessonEligibleForOperationalTriggers('CANCELLED_BY_CENTER');
    assert.equal(cancelElig.eligible_for_teacher_ping, false);
    assert.equal(cancelElig.eligible_for_trial_conversion, false);
    assert.equal(cancelElig.eligible_for_package_consumption, false);
  });
});
