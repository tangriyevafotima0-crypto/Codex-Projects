import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ApiEnvConfig, loadApiEnv } from './config/env';
import { RequestIdMiddleware } from './common/request-id.middleware';
import { API_CONFIG_TOKEN, HealthController } from './health/health.controller';

@Module({
  controllers: [HealthController],
  providers: [
    {
      provide: API_CONFIG_TOKEN,
      useFactory: (): ApiEnvConfig => loadApiEnv(process.env),
    },
    {
      provide: HealthController,
      useFactory: (config: ApiEnvConfig): HealthController => new HealthController(config),
      inject: [API_CONFIG_TOKEN],
    },
  ],
  exports: [API_CONFIG_TOKEN],
})
export class AppModule implements NestModule {
  public configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
