import { DynamicModule, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthModule } from './auth/auth.module';
import { PermissionsGuard } from './auth/permissions.guard';
import { ApiEnvConfig } from './config/env';
import { DatabaseModule } from './database/database.module';
import { DatabaseService } from './database/database.service';
import { HealthController } from './health/health.controller';
import { ReadinessController } from './health/readiness.controller';
import { AcademicsModule } from './academics/academics.module';
import { StudentsModule } from './students/students.module';

@Module({})
export class AppModule {
  static register(config: ApiEnvConfig, customDatabaseService?: DatabaseService): DynamicModule {
    return {
      module: AppModule,
      imports: [DatabaseModule.register(config, customDatabaseService), AuthModule, StudentsModule, AcademicsModule],
      controllers: [HealthController, ReadinessController],
      providers: [
        {
          provide: APP_GUARD,
          useExisting: PermissionsGuard,
        },
      ],
    };
  }
}
