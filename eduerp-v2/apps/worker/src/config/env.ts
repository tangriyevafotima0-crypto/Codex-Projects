import { URL } from 'node:url';

export type WorkerNodeEnv = 'development' | 'test' | 'production';
export type WorkerLogLevel = 'debug' | 'info' | 'warn' | 'error';
export type WorkerLicenseMode = 'ACTIVE' | 'GRACE_PERIOD' | 'READ_ONLY';

export interface WorkerEnvConfig {
  readonly nodeEnv: WorkerNodeEnv;
  readonly logLevel: WorkerLogLevel;
  readonly workerId: string;
  readonly centerId: string;
  readonly centerSlug: string;
  readonly centerTimezone: string;
  readonly licenseMode: WorkerLicenseMode;
  readonly databaseUrl: string;
  readonly pollIntervalMs: number;
  readonly shutdownTimeoutMs: number;
  readonly botOutboundEnabled: boolean;
}

export class WorkerConfigValidationError extends Error {
  public readonly invalidFields: readonly string[];

  constructor(invalidFields: readonly string[], details: readonly string[]) {
    super(`Worker configuration validation failed for [${invalidFields.join(', ')}]: ${details.join('; ')}`);
    this.name = 'WorkerConfigValidationError';
    this.invalidFields = invalidFields;
  }
}

const UUID_REGEX = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const SLUG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const WORKER_ID_REGEX = /^[A-Za-z0-9._-]{3,64}$/;
const ALLOWED_NODE_ENVS: ReadonlySet<string> = new Set(['development', 'test', 'production']);
const ALLOWED_LOG_LEVELS: ReadonlySet<string> = new Set(['debug', 'info', 'warn', 'error']);
const ALLOWED_LICENSE_MODES: ReadonlySet<string> = new Set(['ACTIVE', 'GRACE_PERIOD', 'READ_ONLY']);

function validateDatabaseUrl(rawUrl: string | undefined): string | null {
  if (!rawUrl || rawUrl.trim().length === 0) {
    return 'DATABASE_URL is required';
  }
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
      return 'DATABASE_URL must use postgresql:// or postgres:// protocol';
    }
    if (!parsed.hostname || !parsed.username || !parsed.password) {
      return 'DATABASE_URL must specify hostname, username, and password';
    }
    if (!parsed.pathname.replace(/^\//, '').trim()) {
      return 'DATABASE_URL must specify a database name';
    }
    return null;
  } catch {
    return 'DATABASE_URL is not a valid URL';
  }
}

export function loadWorkerEnv(rawEnv: NodeJS.ProcessEnv = process.env): WorkerEnvConfig {
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

  const workerId = (rawEnv.WORKER_ID ?? '').trim();
  if (!WORKER_ID_REGEX.test(workerId)) {
    recordError('WORKER_ID', 'must be 3..64 safe ASCII characters');
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
    recordError('CENTER_TIMEZONE', 'must be a valid IANA timezone');
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

  const dbErr = validateDatabaseUrl(rawEnv.DATABASE_URL);
  if (dbErr) {
    recordError('DATABASE_URL', dbErr);
  }

  const pollIntervalMs = Number((rawEnv.WORKER_POLL_INTERVAL_MS ?? '500').trim());
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 50 || pollIntervalMs > 60000) {
    recordError('WORKER_POLL_INTERVAL_MS', 'must be an integer between 50 and 60000 ms');
  }

  const shutdownTimeoutMs = Number((rawEnv.WORKER_SHUTDOWN_TIMEOUT_MS ?? '5000').trim());
  if (!Number.isInteger(shutdownTimeoutMs) || shutdownTimeoutMs < 100 || shutdownTimeoutMs > 60000) {
    recordError('WORKER_SHUTDOWN_TIMEOUT_MS', 'must be an integer between 100 and 60000 ms');
  }

  const botOutboundRaw = (rawEnv.BOT_OUTBOUND_ENABLED ?? 'false').trim().toLowerCase();
  if (botOutboundRaw !== 'true' && botOutboundRaw !== 'false') {
    recordError('BOT_OUTBOUND_ENABLED', 'must be true or false (defaults to false for restore safety B14)');
  }

  if (invalidFields.length > 0) {
    throw new WorkerConfigValidationError(invalidFields, details);
  }

  return Object.freeze({
    nodeEnv: nodeEnvRaw as WorkerNodeEnv,
    logLevel: logLevelRaw as WorkerLogLevel,
    workerId,
    centerId,
    centerSlug,
    centerTimezone,
    licenseMode: licenseModeRaw as WorkerLicenseMode,
    databaseUrl: (rawEnv.DATABASE_URL ?? '').trim(),
    pollIntervalMs,
    shutdownTimeoutMs,
    botOutboundEnabled: botOutboundRaw === 'true',
  });
}

export function redactWorkerConfig(config: WorkerEnvConfig): Record<string, unknown> {
  return {
    nodeEnv: config.nodeEnv,
    logLevel: config.logLevel,
    workerId: config.workerId,
    centerId: config.centerId,
    centerSlug: config.centerSlug,
    centerTimezone: config.centerTimezone,
    licenseMode: config.licenseMode,
    databaseUrl: '[REDACTED_DATABASE_URL]',
    pollIntervalMs: config.pollIntervalMs,
    shutdownTimeoutMs: config.shutdownTimeoutMs,
    botOutboundEnabled: config.botOutboundEnabled,
  };
}
