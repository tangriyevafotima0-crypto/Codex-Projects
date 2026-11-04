import { DynamicModule, Module } from '@nestjs/common';
import { ApiEnvConfig } from './config/env';
import { DatabaseModule } from './database/database.module';
import { DatabaseService } from './database/database.service';
import { API_CONFIG_TOKEN, HealthController } from './health/health.controller';
import { ReadinessController } from './health/readiness.controller';

@Module({})
export class AppModule {
  static register(config: ApiEnvConfig, customDatabaseService?: DatabaseService): DynamicModule {
    const dbProvider = customDatabaseService
      ? { provide: DatabaseService, useValue: customDatabaseService }
      : DatabaseService;

    return {
      module: AppModule,
      imports: [DatabaseModule],
      controllers: [HealthController, ReadinessController],
      providers: [{ provide: API_CONFIG_TOKEN, useValue: config }, dbProvider],
      exports: [API_CONFIG_TOKEN, DatabaseService],
    };
  }
}
