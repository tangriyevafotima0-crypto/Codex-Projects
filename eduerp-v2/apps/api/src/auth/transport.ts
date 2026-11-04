import type { IncomingMessage, ServerResponse } from 'node:http';
import { ApiEnvConfig } from '../config/env';
import { ApiHttpException } from './auth.errors';
import { verifyCsrfTokenHash } from './token.service';

export type AuthTransportMode = 'BEARER' | 'COOKIE';

export const REFRESH_COOKIE_NAME = 'eduerp_refresh_token';
export const CSRF_COOKIE_NAME = 'eduerp_csrf_token';
export const CSRF_HEADER_NAME = 'x-csrf-token';
export const TRANSPORT_MODE_HEADER = 'x-auth-transport';
export const REDACTED_COOKIE_REFRESH_PLACEHOLDER = 'COOKIE_REDACTED';

export function resolveTransportModeHeader(req: IncomingMessage): AuthTransportMode {
  const raw = req.headers[TRANSPORT_MODE_HEADER];
  if (raw === undefined) {
    return 'BEARER';
  }
  const value = (Array.isArray(raw) ? raw[0] : raw).trim().toUpperCase();
  if (value === 'BEARER') {
    return 'BEARER';
  }
  if (value === 'COOKIE') {
    return 'COOKIE';
  }
  throw new ApiHttpException({
    statusCode: 400,
    errorCode: 'VALIDATION_ERROR',
    message: 'X-Auth-Transport header must be "cookie" or "bearer"',
  });
}

export function parseCookies(cookieHeader: string | string[] | undefined): Record<string, string> {
  if (!cookieHeader) {
    return {};
  }
  const raw = Array.isArray(cookieHeader) ? cookieHeader.join('; ') : cookieHeader;
  const result: Record<string, string> = {};
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) {
      result[key] = decodeURIComponent(val);
    }
  }
  return result;
}

export function setBrowserSessionCookies(
  res: ServerResponse,
  config: ApiEnvConfig,
  refreshToken: string,
  csrfToken: string,
): void {
  const secureAttr = config.nodeEnv === 'production' ? '; Secure' : '';
  const maxAge = config.sessionRefreshTtlSeconds;
  const refreshCookie = `${REFRESH_COOKIE_NAME}=${encodeURIComponent(refreshToken)}; HttpOnly; Path=/api/v1/auth; SameSite=Strict; Max-Age=${maxAge}${secureAttr}`;
  const csrfCookie = `${CSRF_COOKIE_NAME}=${encodeURIComponent(csrfToken)}; Path=/; SameSite=Strict; Max-Age=${maxAge}${secureAttr}`;
  res.setHeader('Set-Cookie', [refreshCookie, csrfCookie]);
  res.setHeader('X-CSRF-Token', csrfToken);
}

export function clearBrowserSessionCookies(res: ServerResponse, config: ApiEnvConfig): void {
  const secureAttr = config.nodeEnv === 'production' ? '; Secure' : '';
  const refreshCookie = `${REFRESH_COOKIE_NAME}=; HttpOnly; Path=/api/v1/auth; SameSite=Strict; Max-Age=0${secureAttr}`;
  const csrfCookie = `${CSRF_COOKIE_NAME}=; Path=/; SameSite=Strict; Max-Age=0${secureAttr}`;
  res.setHeader('Set-Cookie', [refreshCookie, csrfCookie]);
}

export function verifyTrustedOrigin(req: IncomingMessage, config: ApiEnvConfig): void {
  const originHeader = req.headers.origin;
  const origin = (Array.isArray(originHeader) ? originHeader[0] : originHeader ?? '').trim();
  if (!origin || !config.allowedOrigins.includes(origin)) {
    throw new ApiHttpException({
      statusCode: 403,
      errorCode: 'FORBIDDEN_ROLE',
      message: 'Untrusted or missing Origin header for browser cookie session operation',
    });
  }
}

export function enforceCookieCsrfAndOrigin(
  req: IncomingMessage,
  config: ApiEnvConfig,
  expectedCsrfTokenHash: string | null,
): void {
  verifyTrustedOrigin(req, config);
  const csrfHeader = req.headers[CSRF_HEADER_NAME];
  const rawCsrf = Array.isArray(csrfHeader) ? csrfHeader[0] : csrfHeader;
  if (!verifyCsrfTokenHash(rawCsrf, expectedCsrfTokenHash)) {
    throw new ApiHttpException({
      statusCode: 403,
      errorCode: 'FORBIDDEN_ROLE',
      message: 'Missing or invalid session-bound X-CSRF-Token header',
    });
  }
}

export function resolveClientIp(req: IncomingMessage, config: ApiEnvConfig): string {
  if (config.trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    const rawXff = Array.isArray(xff) ? xff[0] : xff;
    if (typeof rawXff === 'string' && rawXff.trim().length > 0) {
      return rawXff.split(',')[0].trim();
    }
  }
  return req.socket?.remoteAddress ?? '127.0.0.1';
}
