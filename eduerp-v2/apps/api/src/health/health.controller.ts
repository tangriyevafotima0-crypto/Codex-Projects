import { createServer, Server, ServerResponse } from 'node:http';
import { ApiEnvConfig } from '../config/env';
import {
  CANONICAL_REQUEST_ID_HEADER,
  createRequestIdMiddleware,
  RequestLoggerFn,
  RequestWithCorrelationId,
  resolveRequestId,
} from '../common/request-id.middleware';

export const API_CONFIG_TOKEN = 'EDUERP_API_ENV_CONFIG';

export interface SafeHealthResponse {
  readonly status: 'OK' | 'DEGRADED';
  readonly center_slug: string;
  readonly license_mode: 'ACTIVE' | 'GRACE_PERIOD' | 'READ_ONLY';
  readonly request_id: string;
  readonly timestamp_utc: string;
}

function defineNestRouteMetadata(key: string, value: unknown, target: object): void {
  const reflectObj = Reflect as unknown as {
    defineMetadata?: (k: string, v: unknown, t: object) => void;
  };
  if (typeof reflectObj.defineMetadata === 'function') {
    reflectObj.defineMetadata(key, value, target);
  }
}

function NestControllerPath(routePath: string): ClassDecorator {
  return (target) => {
    defineNestRouteMetadata('path', routePath, target);
  };
}

function NestHttpGet(routePath = '/'): MethodDecorator {
  return (_target, _propertyKey, descriptor) => {
    if (descriptor.value && typeof descriptor.value === 'object' || typeof descriptor.value === 'function') {
      defineNestRouteMetadata('path', routePath, descriptor.value as object);
      defineNestRouteMetadata('method', 0, descriptor.value as object);
    }
    return descriptor;
  };
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

@NestControllerPath('api/v1/health')
export class HealthController {
  private readonly config: ApiEnvConfig;

  constructor(config: ApiEnvConfig) {
    this.config = config;
  }

  @NestHttpGet()
  public getHealth(req?: RequestWithCorrelationId): SafeHealthResponse {
    const requestId = req?.requestId ?? resolveRequestId(req?.headers?.['x-request-id']);
    return buildSafeHealthResponse(this.config, requestId);
  }
}

export function createHealthHttpServer(
  config: ApiEnvConfig,
  logger?: RequestLoggerFn,
): Server {
  const controller = new HealthController(config);
  const middleware = createRequestIdMiddleware(logger);

  return createServer((req: RequestWithCorrelationId, res: ServerResponse) => {
    middleware(req, res, () => {
      const requestId = req.requestId ?? resolveRequestId(undefined);
      const urlPath = (req.url ?? '/').split('?')[0];

      if (req.method === 'GET' && urlPath === '/api/v1/health') {
        const body = controller.getHealth(req);
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader(CANONICAL_REQUEST_ID_HEADER, requestId);
        res.end(JSON.stringify(body));
        return;
      }

      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader(CANONICAL_REQUEST_ID_HEADER, requestId);
      res.end(
        JSON.stringify({
          error_code: 'NOT_FOUND',
          message: 'Target endpoint does not exist in Stage 03 foundation scaffold.',
          request_id: requestId,
          timestamp_utc: new Date().toISOString(),
          retry_after_seconds: null,
          conflict_details: null,
        }),
      );
    });
  });
}
