import { Controller, Get, Inject, Req } from '@nestjs/common';
import { ApiEnvConfig } from '../config/env';
import { RequestWithCorrelationId, resolveRequestId } from '../common/request-id.middleware';

export const API_CONFIG_TOKEN = 'EDUERP_API_ENV_CONFIG';

export interface SafeHealthResponse {
  readonly status: 'OK' | 'DEGRADED';
  readonly center_slug: string;
  readonly license_mode: 'ACTIVE' | 'GRACE_PERIOD' | 'READ_ONLY';
  readonly request_id: string;
  readonly timestamp_utc: string;
}

export function buildSafeHealthResponse(
  config: Pick<ApiEnvConfig, 'centerSlug' | 'licenseMode'>,
  requestId: string,
  now: Date = new Date(),
): SafeHealthResponse {
  return Object.freeze({
    status: 'OK',
    center_slug: config.centerSlug,
    license_mode: config.licenseMode,
    request_id: requestId,
    timestamp_utc: now.toISOString(),
  });
}

@Controller('api/v1/health')
export class HealthController {
  constructor(@Inject(API_CONFIG_TOKEN) private readonly config: ApiEnvConfig) {}

  @Get()
  public getHealth(@Req() req: RequestWithCorrelationId): SafeHealthResponse {
    const requestId = req.requestId ?? resolveRequestId(req.headers['x-request-id']);
    return buildSafeHealthResponse(this.config, requestId);
  }
}
