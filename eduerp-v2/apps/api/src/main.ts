import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { loadApiEnv, redactApiConfig } from './config/env';
import { createRequestIdMiddleware } from './common/request-id.middleware';

export async function bootstrapApi(): Promise<void> {
  // Fail-fast before starting HTTP server if required config is missing or invalid (T03.02)
  const config = loadApiEnv(process.env);

  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  app.use(createRequestIdMiddleware());
  app.enableShutdownHooks();

  await app.listen(config.apiPort, config.apiHost);
  process.stdout.write(
    `${JSON.stringify({
      level: 'info',
      event: 'api_started',
      config: redactApiConfig(config),
      timestamp_utc: new Date().toISOString(),
    })}\n`,
  );
}

if (require.main === module) {
  bootstrapApi().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : 'Unknown startup error';
    process.stderr.write(
      `${JSON.stringify({
        level: 'error',
        event: 'api_startup_failed',
        message,
        timestamp_utc: new Date().toISOString(),
      })}\n`,
    );
    process.exit(1);
  });
}
