import { DynamicModule, Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module';
import { ApiEnvConfig } from './config/env';
import { DatabaseModule } from './database/database.module';
import { DatabaseService } from './database/database.service';
import { HealthController } from './health/health.controller';
import { ReadinessController } from './health/readiness.controller';

@Module({})
export class AppModule {
  static register(config: ApiEnvConfig, customDatabaseService?: DatabaseService): DynamicModule {
    return {
      module: AppModule,
      imports: [DatabaseModule.register(config, customDatabaseService), AuthModule],
      controllers: [HealthController, ReadinessController],
    };
  }
}
