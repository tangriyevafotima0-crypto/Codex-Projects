import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ApiErrorEnvelopeFilter } from './auth/auth.errors';
import { createRequestIdMiddleware, RequestLoggerFn } from './common/request-id.middleware';
import { ApiEnvConfig } from './config/env';

export async function createApiApplication(config: ApiEnvConfig, logger?: RequestLoggerFn) {
  const app = await NestFactory.create(AppModule.register(config), { logger: false });
  app.use(createRequestIdMiddleware(logger));
  app.useGlobalFilters(new ApiErrorEnvelopeFilter());
  app.enableShutdownHooks();
  return app;
}
