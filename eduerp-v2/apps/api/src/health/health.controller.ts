import { Controller, Get, Inject, Req } from '@nestjs/common';
import type { HealthResponseContract } from '@eduerp/contracts';
import { PublicBootstrap } from '../auth/permissions.guard';
import { RequestWithCorrelationId, resolveRequestId } from '../common/request-id.middleware';
import { ApiEnvConfig } from '../config/env';

import { API_CONFIG_TOKEN } from '../config/tokens';
export { API_CONFIG_TOKEN } from '../config/tokens';

@Controller('api/v1/health')
export class HealthController {
  constructor(@Inject(API_CONFIG_TOKEN) private readonly config: ApiEnvConfig) {}

  @Get()
  @PublicBootstrap('getSystemHealth')
  public getHealth(@Req() req: RequestWithCorrelationId): HealthResponseContract {
    const requestId = req.requestId ?? resolveRequestId(req.headers['x-request-id']);
    return {
      status: 'OK',
      center_slug: this.config.centerSlug,
      license_mode: this.config.licenseMode,
      request_id: requestId,
      timestamp_utc: new Date().toISOString(),
    };
  }
}
