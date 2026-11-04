import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import type { ErrorCodeContract, ErrorEnvelopeContract } from '@eduerp/contracts';
import type { ServerResponse } from 'node:http';
import {
  CANONICAL_REQUEST_ID_HEADER,
  RequestWithCorrelationId,
  resolveRequestId,
} from '../common/request-id.middleware';
import { IdempotencyConflictError } from '../database/idempotency';
import { MoneyValidationError } from '../database/money';
import { OptimisticVersionConflictError } from '../database/transaction';

export class ApiHttpException extends Error {
  public readonly statusCode: number;
  public readonly errorCode: ErrorCodeContract;
  public readonly retryAfterSeconds: number | null;
  public readonly conflictDetails: Record<string, unknown> | null;

  constructor(params: {
    readonly statusCode: number;
    readonly errorCode: ErrorCodeContract;
    readonly message: string;
    readonly retryAfterSeconds?: number | null;
    readonly conflictDetails?: Record<string, unknown> | null;
  }) {
    super(params.message);
    this.name = 'ApiHttpException';
    this.statusCode = params.statusCode;
    this.errorCode = params.errorCode;
    this.retryAfterSeconds = params.retryAfterSeconds ?? null;
    this.conflictDetails = params.conflictDetails ?? null;
  }
}

@Catch()
export class ApiErrorEnvelopeFilter implements ExceptionFilter {
  public catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<RequestWithCorrelationId>();
    const res = ctx.getResponse<ServerResponse & { status?: (code: number) => unknown; json?: (body: unknown) => unknown }>();
    const requestId = req.requestId ?? resolveRequestId(req.headers['x-request-id']);
    const nowIso = new Date().toISOString();

    let statusCode = 500;
    let errorCode: ErrorCodeContract = 'VALIDATION_ERROR';
    let message = 'Internal server error';
    let retryAfterSeconds: number | null = null;
    let conflictDetails: Record<string, unknown> | null = null;

    if (exception instanceof ApiHttpException) {
      statusCode = exception.statusCode;
      errorCode = exception.errorCode;
      message = exception.message;
      retryAfterSeconds = exception.retryAfterSeconds;
      conflictDetails = exception.conflictDetails;
    } else if (exception instanceof IdempotencyConflictError) {
      statusCode = 409;
      errorCode = 'IDEMPOTENCY_PAYLOAD_MISMATCH';
      message = 'Idempotency-Key was already used with a different request payload';
    } else if (exception instanceof OptimisticVersionConflictError) {
      statusCode = 409;
      errorCode = 'VERSION_CONFLICT';
      message = 'Resource version conflict; refresh and retry with current version';
      conflictDetails = {
        entity: exception.entityName,
        expected_version: exception.expectedVersion,
      };
    } else if (exception instanceof MoneyValidationError) {
      statusCode = 400;
      errorCode = 'VALIDATION_ERROR';
      message = exception.message;
    } else if (exception instanceof HttpException) {
      const status = exception.getStatus();
      if (status === 404) {
        statusCode = 404;
        errorCode = 'NOT_FOUND';
        message = 'Requested endpoint or resource was not found';
      } else if (status === 401) {
        statusCode = 401;
        errorCode = 'UNAUTHORIZED';
        message = 'Authentication required or credentials invalid';
      } else if (status === 403) {
        statusCode = 403;
        errorCode = 'FORBIDDEN_ROLE';
        message = 'Access denied for current actor scope';
      } else if (status >= 400 && status < 500) {
        statusCode = status;
        errorCode = 'VALIDATION_ERROR';
        message = 'Invalid request payload or parameters';
      }
    } else if (
      exception &&
      typeof exception === 'object' &&
      'type' in exception &&
      (exception as { type?: string }).type === 'entity.parse.failed'
    ) {
      statusCode = 400;
      errorCode = 'VALIDATION_ERROR';
      message = 'Malformed JSON request body';
    } else if (
      exception &&
      typeof exception === 'object' &&
      'type' in exception &&
      (exception as { type?: string }).type === 'entity.too.large'
    ) {
      statusCode = 400;
      errorCode = 'VALIDATION_ERROR';
      message = 'Request payload exceeds maximum allowed size';
    }

    const envelope: ErrorEnvelopeContract = {
      error_code: errorCode,
      message,
      request_id: requestId,
      timestamp_utc: nowIso,
      retry_after_seconds: retryAfterSeconds,
      conflict_details: conflictDetails,
    };

    res.setHeader(CANONICAL_REQUEST_ID_HEADER, requestId);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.statusCode = statusCode;
    res.end(JSON.stringify(envelope));
  }
}
