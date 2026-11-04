import { Controller, Get, Inject, Req, Res } from '@nestjs/common';
import type { DatabaseReadinessResponseContract, ErrorEnvelopeContract } from '@eduerp/contracts';
import type { ServerResponse } from 'node:http';
import { PublicBootstrap } from '../auth/permissions.guard';
import {
  CANONICAL_REQUEST_ID_HEADER,
  RequestWithCorrelationId,
  resolveRequestId,
} from '../common/request-id.middleware';
import { ApiEnvConfig } from '../config/env';
import { DatabaseService, PUBLIC_READINESS_FAILURE_MESSAGE } from '../database/database.service';
import { API_CONFIG_TOKEN } from './health.controller';

@Controller('api/v1/ready')
export class ReadinessController {
  constructor(
    @Inject(API_CONFIG_TOKEN) private readonly config: ApiEnvConfig,
    @Inject(DatabaseService) private readonly databaseService: DatabaseService,
  ) {}

  @Get()
  @PublicBootstrap('getDatabaseReadiness')
  public async getReadiness(
    @Req() req: RequestWithCorrelationId,
    @Res() res: ServerResponse,
  ): Promise<void> {
    const requestId = req.requestId ?? resolveRequestId(req.headers['x-request-id']);
    const nowIso = new Date().toISOString();
    const report = await this.databaseService.checkReadiness();

    res.setHeader(CANONICAL_REQUEST_ID_HEADER, requestId);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');

    if (!report.ready) {
      const errorBody: ErrorEnvelopeContract = {
        error_code: 'DATABASE_UNAVAILABLE',
        message: PUBLIC_READINESS_FAILURE_MESSAGE,
        request_id: requestId,
        timestamp_utc: nowIso,
        retry_after_seconds: 5,
        conflict_details: null,
      };
      res.statusCode = 503;
      res.end(JSON.stringify(errorBody));
      return;
    }

    const readyBody: DatabaseReadinessResponseContract = {
      status: 'READY',
      center_slug: this.config.centerSlug,
      license_mode: this.config.licenseMode,
      database_status: 'READY',
      schema_tables_verified: report.schema_tables_verified,
      immutable_triggers_verified: report.immutable_triggers_verified,
      request_id: requestId,
      timestamp_utc: nowIso,
    };
    res.statusCode = 200;
    res.end(JSON.stringify(readyBody));
  }
}
