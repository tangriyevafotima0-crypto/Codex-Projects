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
import {
  resolveEntityTariffFromHistory,
  type CoursePriceHistoryItemDto,
} from '../src/academics/price-resolver';
import { computeCanonicalPayloadHash, executeIdempotentOperation } from '../src/database/idempotency';
import { ApiHttpException } from '../src/auth/auth.errors';
import type { Pool } from 'pg';

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

  it('resolves authoritative current and as_of_date course/group tariffs across future effective dates, multiple changes, same-date revisions, and BigInt > MAX_SAFE_INTEGER (ACAD-UNIT-04 / I04)', () => {
    const baseFee = '480000';
    const historyItems: CoursePriceHistoryItemDto[] = [
      // Most recent future change (Change 2: 2026-11-20, BigInt > Number.MAX_SAFE_INTEGER)
      {
        id: '00000000-0000-4000-8000-000000000003',
        course_id: '00000000-0000-4000-8000-000000000100',
        group_id: '00000000-0000-4000-8000-000000000200',
        previous_fee_uzs: '700000',
        new_fee_uzs: '9007199254740999',
        effective_from: '2026-11-20',
        changed_by_staff_id: '00000000-0000-4000-8000-000000000010',
        change_reason: 'Enterprise tier',
        target_version_snapshot: 4,
        created_at_utc: '2026-11-04T12:00:00.000Z',
      },
      // Same-date second revision on 2026-11-10 (higher target_version_snapshot = 3 wins over 2)
      {
        id: '00000000-0000-4000-8000-000000000002',
        course_id: '00000000-0000-4000-8000-000000000100',
        group_id: '00000000-0000-4000-8000-000000000200',
        previous_fee_uzs: '650000',
        new_fee_uzs: '700000',
        effective_from: '2026-11-10',
        changed_by_staff_id: '00000000-0000-4000-8000-000000000010',
        change_reason: 'Revised Nov 10 tariff',
        target_version_snapshot: 3,
        created_at_utc: '2026-11-04T11:00:00.000Z',
      },
      // Initial future change on 2026-11-10 (target_version_snapshot = 2)
      {
        id: '00000000-0000-4000-8000-000000000001',
        course_id: '00000000-0000-4000-8000-000000000100',
        group_id: '00000000-0000-4000-8000-000000000200',
        previous_fee_uzs: '480000',
        new_fee_uzs: '650000',
        effective_from: '2026-11-10',
        changed_by_staff_id: '00000000-0000-4000-8000-000000000010',
        change_reason: 'Initial Nov 10 tariff',
        target_version_snapshot: 2,
        created_at_utc: '2026-11-04T10:00:00.000Z',
      },
    ];

    // 1. Before 2026-11-10 (asOfDate = 2026-11-09): active fee remains baseline ('480000')
    const beforeEffective = resolveEntityTariffFromHistory(historyItems, baseFee, '2026-11-09');
    assert.equal(beforeEffective.effective_fee_as_of_uzs, '480000');
    assert.equal(beforeEffective.as_of_date, '2026-11-09');
    assert.equal(beforeEffective.latest_scheduled_fee_uzs, '9007199254740999');
    assert.equal(beforeEffective.latest_effective_from, '2026-11-20');

    // 2. On/after 2026-11-10 (asOfDate = 2026-11-10 and 2026-11-11): active fee transitions to '700000'
    //    (selecting target_version_snapshot = 3 over 2 on the same effective_from date)
    const onFirstEffective = resolveEntityTariffFromHistory(historyItems, baseFee, '2026-11-10');
    assert.equal(onFirstEffective.effective_fee_as_of_uzs, '700000');
    assert.equal(onFirstEffective.as_of_date, '2026-11-10');

    const afterFirstEffective = resolveEntityTariffFromHistory(historyItems, baseFee, '2026-11-11');
    assert.equal(afterFirstEffective.effective_fee_as_of_uzs, '700000');

    // 3. On/after second future change (asOfDate = 2026-11-21): active fee transitions to BigInt string
    const onSecondEffective = resolveEntityTariffFromHistory(historyItems, baseFee, '2026-11-21');
    assert.equal(onSecondEffective.effective_fee_as_of_uzs, '9007199254740999');
  });

  it('enforces authorizeBeforeReplayOrExecute before returning cached idempotency replay so revoked actors get 403 while active actors get 200 (ACAD-UNIT-05 / I03)', async () => {
    const reqPayload = { lesson_id: '00000000-0000-4000-8000-000000000999', score: 91 };
    const payloadHash = computeCanonicalPayloadHash(reqPayload);
    const cachedEnvelope = {
      lesson_id: '00000000-0000-4000-8000-000000000999',
      grades_processed_count: 1,
      version: 2,
    };

    let clientOpLogsLookupCount = 0;
    const makeFakePool = (): Pool =>
      ({
        connect: async () => ({
          query: async (sql: string) => {
            if (sql.includes('client_operation_logs')) {
              clientOpLogsLookupCount += 1;
              return {
                rows: [
                  {
                    request_body_sha256: payloadHash,
                    response_status_code: 200,
                    response_payload_json: cachedEnvelope,
                  },
                ],
                rowCount: 1,
              };
            }
            return { rows: [], rowCount: 0 };
          },
          release: () => {},
        }),
      }) as unknown as Pool;

    let handlerCalled = false;
    // 1. Authorized caller replaying exact same payload -> returns cached 200 without invoking handler
    const authorizedReplay = await executeIdempotentOperation(makeFakePool(), {
      centerId: '00000000-0000-4000-8000-000000000001',
      actorStaffId: '00000000-0000-4000-8000-000000000002',
      operationType: 'SUBMIT_LESSON_GRADES',
      idempotencyKey: 'idem-unit-sub-replay-001',
      requestPayload: reqPayload,
      authorizeBeforeReplayOrExecute: async () => {
        // Actor is still authorized on lesson
      },
      handler: async () => {
        handlerCalled = true;
        return { statusCode: 200, body: cachedEnvelope };
      },
    });
    assert.equal(authorizedReplay.replayed, true);
    assert.equal(authorizedReplay.statusCode, 200);
    assert.equal(handlerCalled, false);
    assert.equal(clientOpLogsLookupCount, 1);

    // 2. Revoked substitute replaying the exact same Idempotency-Key and payload -> fails closed with 403 BEFORE client_operation_logs is queried!
    clientOpLogsLookupCount = 0;
    await assert.rejects(
      () =>
        executeIdempotentOperation(makeFakePool(), {
          centerId: '00000000-0000-4000-8000-000000000001',
          actorStaffId: '00000000-0000-4000-8000-000000000002',
          operationType: 'SUBMIT_LESSON_GRADES',
          idempotencyKey: 'idem-unit-sub-replay-001',
          requestPayload: reqPayload,
          authorizeBeforeReplayOrExecute: async () => {
            throw new ApiHttpException({ statusCode: 403, errorCode: 'FORBIDDEN_OBJECT_SCOPE', message: 'Substitute assignment was revoked' });
          },
          handler: async () => ({ statusCode: 200, body: cachedEnvelope }),
        }),
      (err: unknown) => err instanceof ApiHttpException && err.statusCode === 403 && err.errorCode === 'FORBIDDEN_OBJECT_SCOPE',
    );
    assert.equal(clientOpLogsLookupCount, 0);
  });
});
