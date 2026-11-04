import { DynamicModule, Module } from '@nestjs/common';
import { ApiEnvConfig } from './config/env';
import { API_CONFIG_TOKEN, HealthController } from './health/health.controller';

@Module({})
export class AppModule {
  static register(config: ApiEnvConfig): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController],
      providers: [{ provide: API_CONFIG_TOKEN, useValue: config }],
      exports: [API_CONFIG_TOKEN],
    };
  }
}
