import { Controller, Get, Inject, Req, Res } from '@nestjs/common';
import type { ServerResponse } from 'node:http';
import { ApiEnvConfig } from '../config/env';
import { RequestWithCorrelationId, resolveRequestId } from '../common/request-id.middleware';
import { DatabaseService } from '../database/database.service';
import { API_CONFIG_TOKEN } from './health.controller';

export interface DatabaseReadinessResponse {
  readonly status: 'READY';
  readonly center_slug: string;
  readonly license_mode: 'ACTIVE' | 'GRACE_PERIOD' | 'READ_ONLY';
  readonly database_status: 'READY';
  readonly schema_tables_verified: number;
  readonly immutable_triggers_verified: number;
  readonly request_id: string;
  readonly timestamp_utc: string;
}

export interface ReadinessUnavailableErrorEnvelope {
  readonly error_code: 'DATABASE_UNAVAILABLE';
  readonly message: string;
  readonly request_id: string;
  readonly timestamp_utc: string;
  readonly retry_after_seconds: number;
  readonly conflict_details: null;
}

@Controller('api/v1/ready')
export class ReadinessController {
  constructor(
    @Inject(API_CONFIG_TOKEN) private readonly config: ApiEnvConfig,
    @Inject(DatabaseService) private readonly databaseService: DatabaseService,
  ) {}

  @Get()
  public async getReadiness(
    @Req() req: RequestWithCorrelationId,
    @Res({ passthrough: true }) res: ServerResponse,
  ): Promise<DatabaseReadinessResponse | ReadinessUnavailableErrorEnvelope> {
    const requestId = req.requestId ?? resolveRequestId(req.headers['x-request-id']);
    const nowIso = new Date().toISOString();
    const report = await this.databaseService.checkReadiness();

    if (!report.ready) {
      res.statusCode = 503;
      return Object.freeze({
        error_code: 'DATABASE_UNAVAILABLE',
        message: report.redacted_reason ?? 'Database readiness verification failed',
        request_id: requestId,
        timestamp_utc: nowIso,
        retry_after_seconds: 5,
        conflict_details: null,
      });
    }

    res.statusCode = 200;
    return Object.freeze({
      status: 'READY',
      center_slug: this.config.centerSlug,
      license_mode: this.config.licenseMode,
      database_status: 'READY',
      schema_tables_verified: report.schema_tables_verified,
      immutable_triggers_verified: report.immutable_triggers_verified,
      request_id: requestId,
      timestamp_utc: nowIso,
    });
  }
}
