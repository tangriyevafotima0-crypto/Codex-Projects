import type { StaffRole } from '@eduerp/contracts';
import { IncomingMessage } from 'node:http';
import { ApiHttpException } from './auth.errors';

const UUID_REGEX = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const USERNAME_REGEX = /^[A-Za-z0-9._-]{3,64}$/;
const PHONE_E164_REGEX = /^\+[1-9][0-9]{7,14}$/;
const ALLOWED_ROLES: ReadonlySet<string> = new Set(['DIRECTOR', 'ADMIN', 'TEACHER']);
const ALLOWED_STAFF_STATUSES: ReadonlySet<string> = new Set(['ACTIVE', 'DEACTIVATED']);

export function assertPlainObject(
  body: unknown,
  allowedKeys: readonly string[],
): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiHttpException({
      statusCode: 400,
      errorCode: 'VALIDATION_ERROR',
      message: 'Request body must be a JSON object',
    });
  }
  const obj = body as Record<string, unknown>;
  const allowedSet = new Set(allowedKeys);
  for (const key of Object.keys(obj)) {
    if (!allowedSet.has(key)) {
      throw new ApiHttpException({
        statusCode: 400,
        errorCode: 'VALIDATION_ERROR',
        message: `Unexpected field '${key}' in request payload`,
      });
    }
  }
  return obj;
}

export function assertValidUuid(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || !UUID_REGEX.test(value.trim())) {
    throw new ApiHttpException({
      statusCode: 400,
      errorCode: 'VALIDATION_ERROR',
      message: `${fieldName} must be a valid UUID`,
    });
  }
  return value.trim().toLowerCase();
}

export function requireIdempotencyKeyHeader(req: IncomingMessage): string {
  const raw = req.headers['idempotency-key'];
  const val = (Array.isArray(raw) ? raw[0] : raw ?? '').trim();
  if (val.length < 8 || val.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(val)) {
    throw new ApiHttpException({
      statusCode: 400,
      errorCode: 'VALIDATION_ERROR',
      message: 'Idempotency-Key header is required (8..128 safe ASCII characters)',
    });
  }
  return val;
}

export function resolveExpectedVersion(
  req: IncomingMessage,
  bodyExpectedVersion: unknown,
): number {
  if (
    typeof bodyExpectedVersion !== 'number' ||
    !Number.isInteger(bodyExpectedVersion) ||
    bodyExpectedVersion < 1
  ) {
    throw new ApiHttpException({
      statusCode: 400,
      errorCode: 'VALIDATION_ERROR',
      message: 'expected_version must be an integer >= 1',
    });
  }
  const ifMatchRaw = req.headers['if-match-version'];
  if (ifMatchRaw !== undefined) {
    const headerVal = Number(Array.isArray(ifMatchRaw) ? ifMatchRaw[0] : ifMatchRaw);
    if (!Number.isInteger(headerVal) || headerVal < 1 || headerVal !== bodyExpectedVersion) {
      throw new ApiHttpException({
        statusCode: 400,
        errorCode: 'VALIDATION_ERROR',
        message: 'If-Match-Version header must match body expected_version',
      });
    }
  }
  return bodyExpectedVersion;
}

export function validateLoginRequest(body: unknown): {
  username: string;
  password: string;
  deviceInfo: string | null;
} {
  const obj = assertPlainObject(body, ['username', 'password', 'device_info']);
  const username = typeof obj.username === 'string' ? obj.username.trim() : '';
  const password = typeof obj.password === 'string' ? obj.password : '';
  if (!USERNAME_REGEX.test(username) || password.length < 8 || password.length > 128) {
    throw new ApiHttpException({
      statusCode: 400,
      errorCode: 'VALIDATION_ERROR',
      message: 'username (3..64 chars) and password (8..128 chars) are required',
    });
  }
  let deviceInfo: string | null = null;
  if (obj.device_info !== undefined && obj.device_info !== null) {
    if (typeof obj.device_info !== 'string' || obj.device_info.length > 255) {
      throw new ApiHttpException({
        statusCode: 400,
        errorCode: 'VALIDATION_ERROR',
        message: 'device_info must be a string up to 255 characters',
      });
    }
    deviceInfo = obj.device_info.trim() || null;
  }
  return { username, password, deviceInfo };
}

export function validateRefreshRequest(body: unknown, isCookieMode: boolean): {
  refreshToken: string | null;
  deviceInfo: string | null;
} {
  if (isCookieMode && (body === undefined || body === null || (typeof body === 'object' && Object.keys(body as object).length === 0))) {
    return { refreshToken: null, deviceInfo: null };
  }
  const obj = assertPlainObject(body, ['refresh_token', 'device_info']);
  let refreshToken: string | null = null;
  if (obj.refresh_token !== undefined && obj.refresh_token !== null) {
    if (typeof obj.refresh_token !== 'string' || obj.refresh_token.trim().length < 32 || obj.refresh_token.trim().length > 512) {
      throw new ApiHttpException({
        statusCode: 400,
        errorCode: 'VALIDATION_ERROR',
        message: 'refresh_token must be a string between 32 and 512 characters',
      });
    }
    refreshToken = obj.refresh_token.trim();
  } else if (!isCookieMode) {
    throw new ApiHttpException({
      statusCode: 400,
      errorCode: 'VALIDATION_ERROR',
      message: 'refresh_token is required in bearer transport mode',
    });
  }
  let deviceInfo: string | null = null;
  if (obj.device_info !== undefined && obj.device_info !== null) {
    if (typeof obj.device_info !== 'string' || obj.device_info.length > 255) {
      throw new ApiHttpException({
        statusCode: 400,
        errorCode: 'VALIDATION_ERROR',
        message: 'device_info must be a string up to 255 characters',
      });
    }
    deviceInfo = obj.device_info.trim() || null;
  }
  return { refreshToken, deviceInfo };
}

export function validateChangePasswordRequest(
  req: IncomingMessage,
  body: unknown,
): {
  currentPassword: string;
  newPassword: string;
  expectedVersion: number;
} {
  const obj = assertPlainObject(body, ['current_password', 'new_password', 'expected_version']);
  const currentPassword = typeof obj.current_password === 'string' ? obj.current_password : '';
  const newPassword = typeof obj.new_password === 'string' ? obj.new_password : '';
  if (currentPassword.length < 1 || currentPassword.length > 128) {
    throw new ApiHttpException({
      statusCode: 400,
      errorCode: 'VALIDATION_ERROR',
      message: 'current_password is required',
    });
  }
  if (newPassword.length < 8 || newPassword.length > 128) {
    throw new ApiHttpException({
      statusCode: 400,
      errorCode: 'VALIDATION_ERROR',
      message: 'new_password must be between 8 and 128 characters',
    });
  }
  const expectedVersion = resolveExpectedVersion(req, obj.expected_version);
  return { currentPassword, newPassword, expectedVersion };
}

export function validateCreateStaffRequest(body: unknown): {
  fullName: string;
  loginUsername: string;
  role: StaffRole;
  phoneE164: string | null;
  initialPassword: string;
} {
  const obj = assertPlainObject(body, [
    'full_name',
    'login_username',
    'role',
    'phone_e164',
    'initial_password',
  ]);
  const fullName = typeof obj.full_name === 'string' ? obj.full_name.trim() : '';
  const loginUsername = typeof obj.login_username === 'string' ? obj.login_username.trim() : '';
  const role = typeof obj.role === 'string' ? obj.role : '';
  const initialPassword = typeof obj.initial_password === 'string' ? obj.initial_password : '';

  if (fullName.length < 2 || fullName.length > 120) {
    throw new ApiHttpException({
      statusCode: 400,
      errorCode: 'VALIDATION_ERROR',
      message: 'full_name must be between 2 and 120 characters',
    });
  }
  if (!USERNAME_REGEX.test(loginUsername)) {
    throw new ApiHttpException({
      statusCode: 400,
      errorCode: 'VALIDATION_ERROR',
      message: 'login_username must be 3..64 safe ASCII characters',
    });
  }
  if (!ALLOWED_ROLES.has(role)) {
    throw new ApiHttpException({
      statusCode: 400,
      errorCode: 'VALIDATION_ERROR',
      message: 'role must be DIRECTOR, ADMIN, or TEACHER',
    });
  }
  if (initialPassword.length < 8 || initialPassword.length > 128) {
    throw new ApiHttpException({
      statusCode: 400,
      errorCode: 'VALIDATION_ERROR',
      message: 'initial_password must be between 8 and 128 characters',
    });
  }
  let phoneE164: string | null = null;
  if (obj.phone_e164 !== undefined && obj.phone_e164 !== null) {
    if (typeof obj.phone_e164 !== 'string' || !PHONE_E164_REGEX.test(obj.phone_e164.trim())) {
      throw new ApiHttpException({
        statusCode: 400,
        errorCode: 'VALIDATION_ERROR',
        message: 'phone_e164 must match E.164 format (+[1-9][0-9]{7,14})',
      });
    }
    phoneE164 = obj.phone_e164.trim();
  }
  return {
    fullName,
    loginUsername,
    role: role as StaffRole,
    phoneE164,
    initialPassword,
  };
}

export function validateUpdateStaffStatusRequest(
  req: IncomingMessage,
  body: unknown,
): {
  status: 'ACTIVE' | 'DEACTIVATED';
  role: StaffRole;
  reason: string;
  expectedVersion: number;
} {
  const obj = assertPlainObject(body, ['status', 'role', 'reason', 'expected_version']);
  const status = typeof obj.status === 'string' ? obj.status : '';
  const role = typeof obj.role === 'string' ? obj.role : '';
  const reason = typeof obj.reason === 'string' ? obj.reason.trim() : '';

  if (!ALLOWED_STAFF_STATUSES.has(status)) {
    throw new ApiHttpException({
      statusCode: 400,
      errorCode: 'VALIDATION_ERROR',
      message: 'status must be ACTIVE or DEACTIVATED',
    });
  }
  if (!ALLOWED_ROLES.has(role)) {
    throw new ApiHttpException({
      statusCode: 400,
      errorCode: 'VALIDATION_ERROR',
      message: 'role must be DIRECTOR, ADMIN, or TEACHER',
    });
  }
  if (reason.length < 3 || reason.length > 255) {
    throw new ApiHttpException({
      statusCode: 400,
      errorCode: 'VALIDATION_ERROR',
      message: 'reason must be between 3 and 255 characters',
    });
  }
  const expectedVersion = resolveExpectedVersion(req, obj.expected_version);
  return {
    status: status as 'ACTIVE' | 'DEACTIVATED',
    role: role as StaffRole,
    reason,
    expectedVersion,
  };
}

export function validateRevokeSessionsRequest(body: unknown): { reason: string } {
  const obj = assertPlainObject(body, ['reason']);
  const reason = typeof obj.reason === 'string' ? obj.reason.trim() : '';
  if (reason.length < 3 || reason.length > 255) {
    throw new ApiHttpException({
      statusCode: 400,
      errorCode: 'VALIDATION_ERROR',
      message: 'reason must be between 3 and 255 characters',
    });
  }
  return { reason };
}
