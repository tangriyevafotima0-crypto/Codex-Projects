import { URL } from 'node:url';

export type NodeEnvMode = 'development' | 'test' | 'production';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LicenseMode = 'ACTIVE' | 'GRACE_PERIOD' | 'READ_ONLY';

export interface ApiEnvConfig {
  readonly nodeEnv: NodeEnvMode;
  readonly logLevel: LogLevel;
  readonly apiHost: string;
  readonly apiPort: number;
  readonly centerId: string;
  readonly centerSlug: string;
  readonly centerTimezone: string;
  readonly licenseMode: LicenseMode;
  readonly databaseUrl: string;
  readonly readonlyDatabaseUrl?: string;
  readonly dbPoolMax: number;
  readonly dbConnectTimeoutMs: number;
  readonly jwtAccessSecret: string;
  readonly jwtRefreshSecret: string;
  readonly jwtAccessTtlSeconds: number;
  readonly sessionRefreshTtlSeconds: number;
  readonly authLockoutMaxAttempts: number;
  readonly authLockoutDurationSeconds: number;
  readonly authRateLimitWindowSeconds: number;
  readonly authRateLimitMaxRequests: number;
  readonly trustProxy: boolean;
  readonly allowedOrigins: readonly string[];
  readonly internalBotHmacSecret: string;
  readonly telegramWebhookSecret: string;
}

export class ApiConfigValidationError extends Error {
  public readonly invalidFields: readonly string[];

  constructor(invalidFields: readonly string[], details: readonly string[]) {
    super(`API configuration validation failed for [${invalidFields.join(', ')}]: ${details.join('; ')}`);
    this.name = 'ApiConfigValidationError';
    this.invalidFields = invalidFields;
  }
}

const UUID_REGEX = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const SLUG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ALLOWED_NODE_ENVS: ReadonlySet<string> = new Set(['development', 'test', 'production']);
const ALLOWED_LOG_LEVELS: ReadonlySet<string> = new Set(['debug', 'info', 'warn', 'error']);
const ALLOWED_LICENSE_MODES: ReadonlySet<string> = new Set(['ACTIVE', 'GRACE_PERIOD', 'READ_ONLY']);

export function validatePostgresUrl(rawUrl: string | undefined, fieldName: string = 'DATABASE_URL'): string | null {
  if (!rawUrl || rawUrl.trim().length === 0) {
    return `${fieldName} is required`;
  }
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
      return `${fieldName} must use postgresql:// or postgres:// protocol`;
    }
    if (!parsed.hostname) {
      return `${fieldName} must specify a database hostname`;
    }
    if (!parsed.username || !parsed.password) {
      return `${fieldName} must include both database username and password`;
    }
    const dbName = parsed.pathname.replace(/^\//, '').trim();
    if (!dbName) {
      return `${fieldName} must specify a non-empty database name in path`;
    }
    return null;
  } catch {
    return `${fieldName} is not a valid URL`;
  }
}

function parseOriginsList(
  rawOrigins: string | undefined,
  centerSlug: string,
  nodeEnv: string,
  apiPort: number,
  recordError: (field: string, reason: string) => void,
): readonly string[] {
  if (!rawOrigins || rawOrigins.trim().length === 0) {
    const defaults = [`https://${centerSlug}.eduerp.uz`];
    if (nodeEnv !== 'production') {
      defaults.push(`http://127.0.0.1:${apiPort}`, `http://localhost:${apiPort}`);
    }
    return Object.freeze(defaults);
  }
  const items = rawOrigins
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (items.length === 0) {
    recordError('ALLOWED_ORIGINS', 'must contain at least one valid origin URL when specified');
    return Object.freeze([]);
  }
  for (const origin of items) {
    if (origin === '*') {
      recordError('ALLOWED_ORIGINS', 'wildcard "*" origin is forbidden with credentialed auth');
      continue;
    }
    try {
      const parsed = new URL(origin);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        recordError('ALLOWED_ORIGINS', `invalid origin protocol in ${origin}`);
      }
      if (nodeEnv === 'production' && parsed.protocol !== 'https:') {
        recordError('ALLOWED_ORIGINS', 'production origins must use https://');
      }
    } catch {
      recordError('ALLOWED_ORIGINS', `malformed origin URL: ${origin}`);
    }
  }
  return Object.freeze(items);
}

export function loadApiEnv(rawEnv: NodeJS.ProcessEnv = process.env): ApiEnvConfig {
  const invalidFields: string[] = [];
  const details: string[] = [];

  const recordError = (field: string, reason: string): void => {
    if (!invalidFields.includes(field)) {
      invalidFields.push(field);
    }
    details.push(`${field}: ${reason}`);
  };

  const nodeEnvRaw = (rawEnv.NODE_ENV ?? 'development').trim();
  if (!ALLOWED_NODE_ENVS.has(nodeEnvRaw)) {
    recordError('NODE_ENV', 'must be one of development, test, production');
  }

  const logLevelRaw = (rawEnv.LOG_LEVEL ?? 'info').trim();
  if (!ALLOWED_LOG_LEVELS.has(logLevelRaw)) {
    recordError('LOG_LEVEL', 'must be one of debug, info, warn, error');
  }

  const apiHost = (rawEnv.API_HOST ?? '0.0.0.0').trim();
  if (!apiHost) {
    recordError('API_HOST', 'must be a non-empty host address');
  }

  const portStr = (rawEnv.API_PORT ?? '3000').trim();
  const apiPort = Number(portStr);
  if (!Number.isInteger(apiPort) || apiPort < 1 || apiPort > 65535) {
    recordError('API_PORT', 'must be an integer port between 1 and 65535');
  }

  const centerId = (rawEnv.CENTER_ID ?? '').trim();
  if (!UUID_REGEX.test(centerId)) {
    recordError('CENTER_ID', 'must be a valid UUID string');
  }

  const centerSlug = (rawEnv.CENTER_SLUG ?? '').trim();
  if (centerSlug.length < 3 || centerSlug.length > 64 || !SLUG_REGEX.test(centerSlug)) {
    recordError('CENTER_SLUG', 'must be a lowercase kebab-case slug (3..64 chars)');
  }

  const centerTimezone = (rawEnv.CENTER_TIMEZONE ?? 'Asia/Tashkent').trim();
  if (!centerTimezone || centerTimezone.length > 64) {
    recordError('CENTER_TIMEZONE', 'must be a valid IANA timezone identifier');
  }

  try {
    new Intl.DateTimeFormat('en', { timeZone: centerTimezone }).format();
  } catch {
    recordError('CENTER_TIMEZONE', 'must be a valid IANA timezone identifier');
  }

  const licenseModeRaw = (rawEnv.LICENSE_MODE ?? 'ACTIVE').trim();
  if (!ALLOWED_LICENSE_MODES.has(licenseModeRaw)) {
    recordError('LICENSE_MODE', 'must be one of ACTIVE, GRACE_PERIOD, READ_ONLY');
  }

  const dbError = validatePostgresUrl(rawEnv.DATABASE_URL, 'DATABASE_URL');
  if (dbError) {
    recordError('DATABASE_URL', dbError);
  }

  const readonlyDatabaseUrlRaw = rawEnv.READONLY_DATABASE_URL?.trim();
  if (readonlyDatabaseUrlRaw) {
    const roErr = validatePostgresUrl(readonlyDatabaseUrlRaw, 'READONLY_DATABASE_URL');
    if (roErr) {
      recordError('READONLY_DATABASE_URL', roErr);
    }
  }

  const dbPoolMax = Number((rawEnv.DB_POOL_MAX ?? '10').trim());
  if (!Number.isInteger(dbPoolMax) || dbPoolMax < 1 || dbPoolMax > 100) {
    recordError('DB_POOL_MAX', 'must be an integer between 1 and 100');
  }

  const dbConnectTimeoutMs = Number((rawEnv.DB_CONNECT_TIMEOUT_MS ?? '3000').trim());
  if (!Number.isInteger(dbConnectTimeoutMs) || dbConnectTimeoutMs < 100 || dbConnectTimeoutMs > 60000) {
    recordError('DB_CONNECT_TIMEOUT_MS', 'must be an integer between 100 and 60000 ms');
  }

  const jwtAccessSecret = (rawEnv.JWT_ACCESS_SECRET ?? '').trim();
  if (jwtAccessSecret.length < 32) {
    recordError('JWT_ACCESS_SECRET', 'must be at least 32 characters long');
  }

  const jwtRefreshSecret = (rawEnv.JWT_REFRESH_SECRET ?? '').trim();
  if (jwtRefreshSecret.length < 32) {
    recordError('JWT_REFRESH_SECRET', 'must be at least 32 characters long');
  } else if (jwtAccessSecret.length >= 32 && jwtRefreshSecret === jwtAccessSecret) {
    recordError('JWT_REFRESH_SECRET', 'must be distinct from JWT_ACCESS_SECRET');
  }

  const jwtAccessTtlSeconds = Number((rawEnv.JWT_ACCESS_TTL_SECONDS ?? '900').trim());
  if (!Number.isInteger(jwtAccessTtlSeconds) || jwtAccessTtlSeconds < 60 || jwtAccessTtlSeconds > 86400) {
    recordError('JWT_ACCESS_TTL_SECONDS', 'must be an integer between 60 and 86400 seconds');
  }

  const sessionRefreshTtlSeconds = Number((rawEnv.SESSION_REFRESH_TTL_SECONDS ?? '604800').trim());
  if (
    !Number.isInteger(sessionRefreshTtlSeconds) ||
    sessionRefreshTtlSeconds < 300 ||
    sessionRefreshTtlSeconds > 2592000
  ) {
    recordError('SESSION_REFRESH_TTL_SECONDS', 'must be an integer between 300 and 2592000 seconds');
  }

  const authLockoutMaxAttempts = Number((rawEnv.AUTH_LOCKOUT_MAX_ATTEMPTS ?? '5').trim());
  if (!Number.isInteger(authLockoutMaxAttempts) || authLockoutMaxAttempts < 3 || authLockoutMaxAttempts > 20) {
    recordError('AUTH_LOCKOUT_MAX_ATTEMPTS', 'must be an integer between 3 and 20');
  }

  const authLockoutDurationSeconds = Number((rawEnv.AUTH_LOCKOUT_DURATION_SECONDS ?? '900').trim());
  if (
    !Number.isInteger(authLockoutDurationSeconds) ||
    authLockoutDurationSeconds < 60 ||
    authLockoutDurationSeconds > 86400
  ) {
    recordError('AUTH_LOCKOUT_DURATION_SECONDS', 'must be an integer between 60 and 86400 seconds');
  }

  const authRateLimitWindowSeconds = Number((rawEnv.AUTH_RATE_LIMIT_WINDOW_SECONDS ?? '900').trim());
  if (
    !Number.isInteger(authRateLimitWindowSeconds) ||
    authRateLimitWindowSeconds < 60 ||
    authRateLimitWindowSeconds > 86400
  ) {
    recordError('AUTH_RATE_LIMIT_WINDOW_SECONDS', 'must be an integer between 60 and 86400 seconds');
  }

  const authRateLimitMaxRequests = Number((rawEnv.AUTH_RATE_LIMIT_MAX_REQUESTS ?? '5').trim());
  if (
    !Number.isInteger(authRateLimitMaxRequests) ||
    authRateLimitMaxRequests < 3 ||
    authRateLimitMaxRequests > 100
  ) {
    recordError('AUTH_RATE_LIMIT_MAX_REQUESTS', 'must be an integer between 3 and 100');
  }

  const trustProxyRaw = (rawEnv.TRUST_PROXY ?? 'false').trim().toLowerCase();
  if (trustProxyRaw !== 'true' && trustProxyRaw !== 'false') {
    recordError('TRUST_PROXY', 'must be true or false');
  }

  const allowedOrigins = parseOriginsList(
    rawEnv.ALLOWED_ORIGINS,
    centerSlug || 'center',
    nodeEnvRaw,
    Number.isInteger(apiPort) && apiPort >= 1 && apiPort <= 65535 ? apiPort : 3000,
    recordError,
  );

  const internalBotHmacSecret = (rawEnv.INTERNAL_BOT_HMAC_SECRET ?? '').trim();
  if (internalBotHmacSecret.length < 32) {
    recordError('INTERNAL_BOT_HMAC_SECRET', 'must be at least 32 characters long');
  }

  const telegramWebhookSecret = (rawEnv.TELEGRAM_WEBHOOK_SECRET ?? '').trim();
  if (telegramWebhookSecret.length < 16) {
    recordError('TELEGRAM_WEBHOOK_SECRET', 'must be at least 16 characters long');
  }

  if (invalidFields.length > 0) {
    throw new ApiConfigValidationError(invalidFields, details);
  }

  return Object.freeze({
    nodeEnv: nodeEnvRaw as NodeEnvMode,
    logLevel: logLevelRaw as LogLevel,
    apiHost,
    apiPort,
    centerId,
    centerSlug,
    centerTimezone,
    licenseMode: licenseModeRaw as LicenseMode,
    databaseUrl: (rawEnv.DATABASE_URL ?? '').trim(),
    ...(readonlyDatabaseUrlRaw ? { readonlyDatabaseUrl: readonlyDatabaseUrlRaw } : {}),
    dbPoolMax,
    dbConnectTimeoutMs,
    jwtAccessSecret,
    jwtRefreshSecret,
    jwtAccessTtlSeconds,
    sessionRefreshTtlSeconds,
    authLockoutMaxAttempts,
    authLockoutDurationSeconds,
    authRateLimitWindowSeconds,
    authRateLimitMaxRequests,
    trustProxy: trustProxyRaw === 'true',
    allowedOrigins,
    internalBotHmacSecret,
    telegramWebhookSecret,
  });
}

export function redactApiConfig(config: ApiEnvConfig): Record<string, unknown> {
  return {
    nodeEnv: config.nodeEnv,
    logLevel: config.logLevel,
    apiHost: config.apiHost,
    apiPort: config.apiPort,
    centerId: config.centerId,
    centerSlug: config.centerSlug,
    centerTimezone: config.centerTimezone,
    licenseMode: config.licenseMode,
    databaseUrl: '[REDACTED_DATABASE_URL]',
    ...(config.readonlyDatabaseUrl ? { readonlyDatabaseUrl: '[REDACTED_DATABASE_URL]' } : {}),
    dbPoolMax: config.dbPoolMax,
    dbConnectTimeoutMs: config.dbConnectTimeoutMs,
    jwtAccessSecret: '[REDACTED_SECRET]',
    jwtRefreshSecret: '[REDACTED_SECRET]',
    jwtAccessTtlSeconds: config.jwtAccessTtlSeconds,
    sessionRefreshTtlSeconds: config.sessionRefreshTtlSeconds,
    authLockoutMaxAttempts: config.authLockoutMaxAttempts,
    authLockoutDurationSeconds: config.authLockoutDurationSeconds,
    authRateLimitWindowSeconds: config.authRateLimitWindowSeconds,
    authRateLimitMaxRequests: config.authRateLimitMaxRequests,
    trustProxy: config.trustProxy,
    allowedOrigins: config.allowedOrigins,
    internalBotHmacSecret: '[REDACTED_SECRET]',
    telegramWebhookSecret: '[REDACTED_SECRET]',
  };
}
