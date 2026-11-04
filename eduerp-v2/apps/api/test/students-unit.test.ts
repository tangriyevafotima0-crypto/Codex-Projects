import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  escapeSqlLikePattern,
  normalizePersonName,
  normalizePhoneE164,
  normalizeSearchQueryText,
  validateIsoDate,
} from '../src/students/normalization';

describe('Stage 06 Students, Guardians & Enrollments Unit Tests (06.01..06.04)', () => {
  it('normalizes Unicode NFKC names and unifies all Uzbek apostrophe variants while preserving display fullName (STU-UNIT-01)', () => {
    const n1 = normalizePersonName("  O‘ktam   O'g'li  ");
    const n2 = normalizePersonName('oʻktam oʼgʼli');
    const n3 = normalizePersonName('O`ktam O’g’li');

    assert.equal(n1.fullName, "O‘ktam O'g'li");
    assert.equal(n1.normalizedName, "o'ktam o'g'li");
    assert.equal(n2.normalizedName, "o'ktam o'g'li");
    assert.equal(n3.normalizedName, "o'ktam o'g'li");
    assert.equal(normalizeSearchQueryText('  O‘KTAM   '), "o'ktam");
    assert.equal(escapeSqlLikePattern('100%_test\\a'), '100\\%\\_test\\\\a');

    assert.throws(() => normalizePersonName('A'), /between 2 and 120/);
    assert.throws(() => normalizePersonName('Bad\x00Name'), /control characters/);
  });

  it('normalizes valid E.164 and Uzbekistan +998 phone numbers and rejects ambiguous or malformed inputs (STU-UNIT-02)', () => {
    assert.equal(normalizePhoneE164('+998 90 123-45-67'), '+998901234567');
    assert.equal(normalizePhoneE164('998 (90) 123 45 67'), '+998901234567');
    assert.equal(normalizePhoneE164('+1 (415) 555-2671'), '+14155552671');

    // Ambiguous local numbers without country prefix must be rejected rather than guessed
    for (const invalidPhone of [
      '901234567',
      '8901234567',
      '00998901234567',
      '+99890123456', // 8 digits after +998
      '+9989012345678', // 10 digits after +998
      '+0123456789',
      'abc',
      '',
    ]) {
      assert.throws(
        () => normalizePhoneE164(invalidPhone),
        /phone_e164/,
        `Expected normalizePhoneE164 to reject ${invalidPhone}`,
      );
    }
  });

  it('validates calendar ISO dates including leap years (STU-UNIT-03)', () => {
    assert.equal(validateIsoDate('2026-11-04', 'enrolled_at_date'), '2026-11-04');
    assert.equal(validateIsoDate('2028-02-29', 'enrolled_at_date'), '2028-02-29');

    assert.throws(() => validateIsoDate('2026-02-29', 'enrolled_at_date'), /not a valid calendar date/);
    assert.throws(() => validateIsoDate('2026-13-01', 'enrolled_at_date'), /out-of-range/);
    assert.throws(() => validateIsoDate('04-11-2026', 'enrolled_at_date'), /YYYY-MM-DD/);
  });
});
