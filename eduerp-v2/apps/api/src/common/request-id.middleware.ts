import { randomUUID } from 'node:crypto';
import { IncomingMessage, ServerResponse } from 'node:http';

export const REQUEST_ID_HEADER = 'x-request-id';
export const CANONICAL_REQUEST_ID_HEADER = 'X-Request-Id';
export const MAX_REQUEST_ID_LENGTH = 64;

const SAFE_REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const SENSITIVE_HEADER_NAMES: ReadonlySet<string> = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'x-internal-bot-signature',
  'x-telegram-bot-api-secret-token',
]);

export interface RequestWithCorrelationId extends IncomingMessage {
  requestId?: string;
}

export interface RequestLogEntry {
  readonly level: 'info' | 'warn' | 'error';
  readonly event: 'http_request';
  readonly request_id: string;
  readonly method: string;
  readonly path: string;
  readonly status_code: number;
  readonly duration_ms: number;
  readonly redacted_headers: Record<string, string>;
  readonly timestamp_utc: string;
}

export type RequestLoggerFn = (entry: RequestLogEntry) => void;

export function resolveRequestId(rawHeaderValue: string | string[] | undefined): string {
  if (typeof rawHeaderValue === 'string') {
    const trimmed = rawHeaderValue.trim();
    if (trimmed.length >= 1 && trimmed.length <= MAX_REQUEST_ID_LENGTH && SAFE_REQUEST_ID_PATTERN.test(trimmed)) {
      return trimmed;
    }
  }
  return randomUUID();
}

export function redactRequestHeaders(headers: IncomingMessage['headers']): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const [key, val] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (SENSITIVE_HEADER_NAMES.has(lower) || lower.includes('secret') || lower.includes('token') || lower.includes('password')) {
      safe[lower] = '[REDACTED]';
    } else if (typeof val === 'string') {
      safe[lower] = val;
    } else if (Array.isArray(val)) {
      safe[lower] = val.join(',');
    }
  }
  return safe;
}

export function defaultJsonRequestLogger(entry: RequestLogEntry): void {
  process.stdout.write(`${JSON.stringify(entry)}\n`);
}

export function createRequestIdMiddleware(logger: RequestLoggerFn = defaultJsonRequestLogger) {
  return function requestIdMiddleware(
    req: RequestWithCorrelationId,
    res: ServerResponse,
    next: () => void,
  ): void {
    const startNs = process.hrtime.bigint();
    const requestId = resolveRequestId(req.headers[REQUEST_ID_HEADER]);
    req.requestId = requestId;
    res.setHeader(CANONICAL_REQUEST_ID_HEADER, requestId);

    res.on('finish', () => {
      const elapsedMs = Number(process.hrtime.bigint() - startNs) / 1_000_000;
      const rawUrl = req.url ?? '/';
      const cleanPath = rawUrl.split('?')[0] || '/';
      logger({
        level: 'info',
        event: 'http_request',
        request_id: requestId,
        method: req.method ?? 'GET',
        path: cleanPath,
        status_code: res.statusCode,
        duration_ms: Math.round(elapsedMs * 100) / 100,
        redacted_headers: redactRequestHeaders(req.headers),
        timestamp_utc: new Date().toISOString(),
      });
    });

    next();
  };
}

export class RequestIdMiddleware {
  private readonly handler: (req: RequestWithCorrelationId, res: ServerResponse, next: () => void) => void;

  constructor(logger: RequestLoggerFn = defaultJsonRequestLogger) {
    this.handler = createRequestIdMiddleware(logger);
  }

  public use(req: RequestWithCorrelationId, res: ServerResponse, next: () => void): void {
    this.handler(req, res, next);
  }
}
