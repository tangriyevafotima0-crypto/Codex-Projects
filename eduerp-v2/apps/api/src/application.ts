import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ApiEnvConfig } from './config/env';
import { createRequestIdMiddleware, RequestLoggerFn } from './common/request-id.middleware';

export async function createApiApplication(config: ApiEnvConfig, logger?: RequestLoggerFn) {
  const app = await NestFactory.create(AppModule.register(config), { logger: false });
  app.use(createRequestIdMiddleware(logger));
  app.enableShutdownHooks();
  return app;
}
