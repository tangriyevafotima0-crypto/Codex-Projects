import * as crypto from 'node:crypto';
import { ApiHttpException } from '../auth/auth.errors';
import { TransactionContext } from '../database/transaction';

/**
 * EduERP v2.0 — Stage 06 Name, Phone (E.164 / +998), Date & Search Normalization (06.01, 06.02, 06.04).
 *
 * Invariants:
 * - `normalizePersonName`: Applies Unicode NFKC normalization, collapses whitespace, preserves display
 *   `fullName`, and produces a deterministic `normalizedName` unifying all Uzbek/Latin apostrophe
 *   variants (`'`, `‘`, `’`, `` ` ``, `ʻ`, `ʼ`, `´`) to ASCII `'` in lowercase.
 * - `normalizePhoneE164`: Enforces canonical E.164 (`+[1-9][0-9]{7,14}`). Supports Uzbekistan numbers
 *   written as `+998XXXXXXXXX` or `998XXXXXXXXX` (exact 12 digits: `998` + 9 digits) and international
 *   numbers starting with `+`. Rejects ambiguous local numbers without country prefix (e.g. `901234567`,
 *   `8901234567`, `00998...`) rather than guessing.
 */

const CONTROL_CHAR_REGEX = /[\x00-\x1F\x7F]/;
const APOSTROPHE_VARIANTS_REGEX = /[\u2018\u2019\u02BB\u02BC\u0060\u00B4']/g;
const E164_STRICT_REGEX = /^\+[1-9][0-9]{7,14}$/;
const UZ_E164_STRICT_REGEX = /^\+998[0-9]{9}$/;
const UZ_NO_PLUS_REGEX = /^998[0-9]{9}$/;
const ISO_DATE_REGEX = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;

export interface NormalizedPersonName {
  readonly fullName: string;
  readonly normalizedName: string;
}

export function normalizePersonName(
  rawName: unknown,
  fieldName: string = 'full_name',
): NormalizedPersonName {
  if (typeof rawName !== 'string') {
    throw new ApiHttpException({
      statusCode: 400,
      errorCode: 'VALIDATION_ERROR',
      message: `${fieldName} must be a string`,
    });
  }
  if (CONTROL_CHAR_REGEX.test(rawName)) {
    throw new ApiHttpException({
      statusCode: 400,
      errorCode: 'VALIDATION_ERROR',
      message: `${fieldName} must not contain control characters`,
    });
  }

  const fullName = rawName.normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (fullName.length < 2 || fullName.length > 120) {
    throw new ApiHttpException({
      statusCode: 400,
      errorCode: 'VALIDATION_ERROR',
      message: `${fieldName} must be between 2 and 120 characters`,
    });
  }

  const normalizedName = fullName
    .replace(APOSTROPHE_VARIANTS_REGEX, "'")
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

  return Object.freeze({
    fullName,
    normalizedName,
  });
}

export function normalizeSearchQueryText(rawQuery: string): string {
  return rawQuery
    .normalize('NFKC')
    .replace(APOSTROPHE_VARIANTS_REGEX, "'")
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function escapeSqlLikePattern(rawPattern: string): string {
  return rawPattern.replace(/[\\%_]/g, '\\$&');
}

export function normalizePhoneE164(
  rawPhone: unknown,
  fieldName: string = 'phone_e164',
): string {
  if (typeof rawPhone !== 'string') {
    throw new ApiHttpException({
      statusCode: 400,
      errorCode: 'VALIDATION_ERROR',
      message: `${fieldName} must be a string`,
    });
  }

  const trimmed = rawPhone.trim();
  if (trimmed.length === 0 || CONTROL_CHAR_REGEX.test(trimmed)) {
    throw new ApiHttpException({
      statusCode: 400,
      errorCode: 'VALIDATION_ERROR',
      message: `${fieldName} is required`,
    });
  }

  // Only digits, optional leading '+', spaces, hyphens, and parentheses may appear in raw input
  if (!/^\+?[0-9\s\-()]+$/.test(trimmed)) {
    throw new ApiHttpException({
      statusCode: 400,
      errorCode: 'VALIDATION_ERROR',
      message: `${fieldName} contains invalid characters`,
    });
  }

  const stripped = trimmed.replace(/[\s\-()]/g, '');

  // Reject 00-prefixed or 0-prefixed ambiguous numbers
  if (stripped.startsWith('0') || stripped.startsWith('+0')) {
    throw new ApiHttpException({
      statusCode: 400,
      errorCode: 'VALIDATION_ERROR',
      message: `${fieldName} must use canonical E.164 country prefix (e.g. +998901234567)`,
    });
  }

  let candidate: string;
  if (stripped.startsWith('+')) {
    candidate = stripped;
  } else if (UZ_NO_PLUS_REGEX.test(stripped)) {
    // Explicit Uzbekistan 12-digit format 998XXXXXXXXX -> +998XXXXXXXXX
    candidate = `+${stripped}`;
  } else {
    throw new ApiHttpException({
      statusCode: 400,
      errorCode: 'VALIDATION_ERROR',
      message: `${fieldName} is ambiguous or missing country code; provide E.164 format (+998XXXXXXXXX or +<country><number>)`,
    });
  }

  if (candidate.startsWith('+998')) {
    if (!UZ_E164_STRICT_REGEX.test(candidate)) {
      throw new ApiHttpException({
        statusCode: 400,
        errorCode: 'VALIDATION_ERROR',
        message: `${fieldName} for Uzbekistan (+998) must have exactly 9 subscriber digits (+998XXXXXXXXX)`,
      });
    }
    return candidate;
  }

  if (!E164_STRICT_REGEX.test(candidate)) {
    throw new ApiHttpException({
      statusCode: 400,
      errorCode: 'VALIDATION_ERROR',
      message: `${fieldName} must match canonical E.164 format (+[1-9][0-9]{7,14})`,
    });
  }

  return candidate;
}

export function validateIsoDate(rawDate: unknown, fieldName: string): string {
  if (typeof rawDate !== 'string') {
    throw new ApiHttpException({
      statusCode: 400,
      errorCode: 'VALIDATION_ERROR',
      message: `${fieldName} must be an ISO date string (YYYY-MM-DD)`,
    });
  }
  const trimmed = rawDate.trim();
  const match = ISO_DATE_REGEX.exec(trimmed);
  if (!match) {
    throw new ApiHttpException({
      statusCode: 400,
      errorCode: 'VALIDATION_ERROR',
      message: `${fieldName} must match YYYY-MM-DD format`,
    });
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1900 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) {
    throw new ApiHttpException({
      statusCode: 400,
      errorCode: 'VALIDATION_ERROR',
      message: `${fieldName} contains out-of-range calendar components`,
    });
  }
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (
    dt.getUTCFullYear() !== year ||
    dt.getUTCMonth() + 1 !== month ||
    dt.getUTCDate() !== day
  ) {
    throw new ApiHttpException({
      statusCode: 400,
      errorCode: 'VALIDATION_ERROR',
      message: `${fieldName} is not a valid calendar date`,
    });
  }
  return trimmed;
}

export async function generateUniqueStudentCode(
  tx: TransactionContext,
  centerId: string,
): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const token = crypto.randomBytes(4).toString('hex').toUpperCase();
    const candidate = `STU-${token}`;
    const existing = await tx.query<{ id: string }>(
      `SELECT "id"::text AS id
         FROM "students"
        WHERE "center_id" = $1::uuid
          AND "student_code" = $2
        LIMIT 1`,
      [centerId, candidate],
    );
    if (!existing.rows[0]) {
      return candidate;
    }
  }
  return `STU-${Date.now().toString(36).toUpperCase().slice(-8)}`;
}
