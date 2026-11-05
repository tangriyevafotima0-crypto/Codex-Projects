import { DynamicModule, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AcademicsModule } from './academics/academics.module';
import { AdjustmentsModule } from './adjustments/adjustments.module';
import { AttendanceModule } from './attendance/attendance.module';
import { AuthModule } from './auth/auth.module';
import { PermissionsGuard } from './auth/permissions.guard';
import { BillingModule } from './billing/billing.module';
import { CashModule } from './cash/cash.module';
import { ApiEnvConfig } from './config/env';
import { DatabaseModule } from './database/database.module';
import { DatabaseService } from './database/database.service';
import { HealthController } from './health/health.controller';
import { ReadinessController } from './health/readiness.controller';
import { PaymentsModule } from './payments/payments.module';
import { StudentsModule } from './students/students.module';

@Module({})
export class AppModule {
  static register(config: ApiEnvConfig, customDatabaseService?: DatabaseService): DynamicModule {
    return {
      module: AppModule,
      imports: [
        DatabaseModule.register(config, customDatabaseService),
        AuthModule,
        StudentsModule,
        AcademicsModule,
        BillingModule,
        AdjustmentsModule,
        PaymentsModule,
        CashModule,
        AttendanceModule,
      ],
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
