/**
 * EduERP v2.0 — Lossless UZS Money Domain Helpers (Stage 04, Step 04.03).
 *
 * Enforces ENGINEERING_PROPOSAL C03 & S2F07:
 * - Currency is integer UZS (`scale = 0`, 1 integer = 1 UZS so'm).
 * - Stored in PostgreSQL as signed 64-bit `BIGINT` (`-9223372036854775808`..`9223372036854775807`).
 * - Represented in TypeScript runtime as `bigint` and serialized in JSON/OpenAPI as canonical base-10 string
 *   without leading zeros or fractional decimals, avoiding IEEE-754 `Number` precision loss above 2^53 - 1.
 */

export const MAX_PG_BIGINT = 9223372036854775807n;
export const MIN_PG_BIGINT = -9223372036854775808n;
export const MAX_OAS_18_DIGIT_UZS = 999999999999999999n;
export const MIN_OAS_18_DIGIT_UZS = -999999999999999999n;

const POSITIVE_MONEY_REGEX = /^[1-9][0-9]{0,18}$/;
const NON_NEGATIVE_MONEY_REGEX = /^(0|[1-9][0-9]{0,18})$/;
const SIGNED_MONEY_REGEX = /^(0|-?[1-9][0-9]{0,18})$/;
const NON_ZERO_SIGNED_MONEY_REGEX = /^-?[1-9][0-9]{0,18}$/;

export class MoneyValidationError extends Error {
  public readonly code: string;
  public readonly fieldName: string;

  constructor(fieldName: string, message: string, code: string = 'VALIDATION_ERROR') {
    super(`${fieldName}: ${message}`);
    this.name = 'MoneyValidationError';
    this.fieldName = fieldName;
    this.code = code;
  }
}

function assertWithinPgBigIntBounds(value: bigint, fieldName: string): bigint {
  if (value > MAX_PG_BIGINT || value < MIN_PG_BIGINT) {
    throw new MoneyValidationError(
      fieldName,
      'UZS amount exceeds signed 64-bit PostgreSQL BIGINT bounds',
    );
  }
  return value;
}

export function parsePositiveMoneyUzs(raw: unknown, fieldName: string = 'amount_uzs'): bigint {
  if (typeof raw === 'number') {
    throw new MoneyValidationError(
      fieldName,
      'Unsafe JS number rejected for UZS money; pass canonical integer string or bigint',
    );
  }
  if (typeof raw === 'bigint') {
    assertWithinPgBigIntBounds(raw, fieldName);
    if (raw <= 0n) {
      throw new MoneyValidationError(fieldName, 'PositiveMoneyUzs must be strictly greater than 0');
    }
    return raw;
  }
  if (typeof raw !== 'string' || !POSITIVE_MONEY_REGEX.test(raw)) {
    throw new MoneyValidationError(
      fieldName,
      'PositiveMoneyUzs must be a canonical base-10 positive integer string without leading zeros or decimals',
    );
  }
  const parsed = BigInt(raw);
  return assertWithinPgBigIntBounds(parsed, fieldName);
}

export function parseNonNegativeMoneyUzs(raw: unknown, fieldName: string = 'amount_uzs'): bigint {
  if (typeof raw === 'number') {
    throw new MoneyValidationError(
      fieldName,
      'Unsafe JS number rejected for UZS money; pass canonical integer string or bigint',
    );
  }
  if (typeof raw === 'bigint') {
    assertWithinPgBigIntBounds(raw, fieldName);
    if (raw < 0n) {
      throw new MoneyValidationError(fieldName, 'NonNegativeMoneyUzs must be >= 0');
    }
    return raw;
  }
  if (typeof raw !== 'string' || !NON_NEGATIVE_MONEY_REGEX.test(raw)) {
    throw new MoneyValidationError(
      fieldName,
      'NonNegativeMoneyUzs must be "0" or a positive base-10 integer string without leading zeros or decimals',
    );
  }
  const parsed = BigInt(raw);
  return assertWithinPgBigIntBounds(parsed, fieldName);
}

export function parseSignedMoneyDeltaUzs(raw: unknown, fieldName: string = 'delta_uzs'): bigint {
  if (typeof raw === 'number') {
    throw new MoneyValidationError(
      fieldName,
      'Unsafe JS number rejected for UZS money; pass canonical integer string or bigint',
    );
  }
  if (typeof raw === 'bigint') {
    return assertWithinPgBigIntBounds(raw, fieldName);
  }
  if (typeof raw !== 'string' || !SIGNED_MONEY_REGEX.test(raw)) {
    throw new MoneyValidationError(
      fieldName,
      'SignedMoneyDeltaUzs must be a canonical signed base-10 integer string without leading zeros or decimals',
    );
  }
  const parsed = BigInt(raw);
  return assertWithinPgBigIntBounds(parsed, fieldName);
}

export function parseNonZeroSignedMoneyDeltaUzs(raw: unknown, fieldName: string = 'delta_amount_uzs'): bigint {
  if (typeof raw === 'number') {
    throw new MoneyValidationError(
      fieldName,
      'Unsafe JS number rejected for UZS money; pass canonical integer string or bigint',
    );
  }
  if (typeof raw === 'bigint') {
    assertWithinPgBigIntBounds(raw, fieldName);
    if (raw === 0n) {
      throw new MoneyValidationError(fieldName, 'NonZeroSignedMoneyDeltaUzs must not be 0');
    }
    return raw;
  }
  if (typeof raw !== 'string' || !NON_ZERO_SIGNED_MONEY_REGEX.test(raw)) {
    throw new MoneyValidationError(
      fieldName,
      'NonZeroSignedMoneyDeltaUzs must be a non-zero signed base-10 integer string',
    );
  }
  const parsed = BigInt(raw);
  return assertWithinPgBigIntBounds(parsed, fieldName);
}

export function formatMoneyUzs(amount: bigint, fieldName: string = 'amount_uzs'): string {
  if (typeof amount !== 'bigint') {
    throw new MoneyValidationError(fieldName, 'Expected bigint for formatMoneyUzs');
  }
  assertWithinPgBigIntBounds(amount, fieldName);
  return amount.toString(10);
}

export function addMoneyUzs(a: bigint, b: bigint, fieldName: string = 'amount_uzs'): bigint {
  const sum = a + b;
  return assertWithinPgBigIntBounds(sum, fieldName);
}

export function subtractMoneyUzs(a: bigint, b: bigint, fieldName: string = 'amount_uzs'): bigint {
  const diff = a - b;
  return assertWithinPgBigIntBounds(diff, fieldName);
}


/**
 * Exact non-negative rational division with HALF_UP rounding to integer UZS (scale = 0):
 * floor((2 * numerator + denominator) / (2 * denominator))
 */
export function divideAndRoundHalfUpUzs(
  numerator: bigint,
  denominator: bigint,
  fieldName: string = "amount_uzs",
): bigint {
  if (typeof numerator !== "bigint" || typeof denominator !== "bigint") {
    throw new MoneyValidationError(fieldName, "numerator and denominator must be bigint");
  }
  if (denominator <= 0n) {
    throw new MoneyValidationError(fieldName, "denominator must be > 0");
  }
  if (numerator < 0n) {
    throw new MoneyValidationError(fieldName, "numerator must be >= 0");
  }
  if (numerator === 0n) {
    return 0n;
  }
  const quotient = (numerator * 2n + denominator) / (denominator * 2n);
  return assertWithinPgBigIntBounds(quotient, fieldName);
}
