import { DynamicModule, Module } from '@nestjs/common';
import { AcademicsModule } from './academics/academics.module';
import { AdjustmentsModule } from './adjustments/adjustments.module';
import { AttendanceModule } from './attendance/attendance.module';
import { AuthModule } from './auth/auth.module';
import { BillingModule } from './billing/billing.module';
import { CashModule } from './cash/cash.module';
import { ApiEnvConfig } from './config/env';
import { API_CONFIG_TOKEN } from './config/tokens';
import { DatabaseModule } from './database/database.module';
import { HealthController } from './health/health.controller';
import { PaymentsModule } from './payments/payments.module';
import { StudentsModule } from './students/students.module';

export { API_CONFIG_TOKEN } from './config/tokens';

@Module({})
export class AppModule {
  public static register(config: ApiEnvConfig): DynamicModule {
    return {
      module: AppModule,
      global: true,
      imports: [
        DatabaseModule,
        AuthModule,
        StudentsModule,
        AcademicsModule,
        BillingModule,
        AdjustmentsModule,
        PaymentsModule,
        CashModule,
        AttendanceModule,
      ],
      controllers: [HealthController],
      providers: [
        {
          provide: API_CONFIG_TOKEN,
          useValue: config,
        },
      ],
      exports: [API_CONFIG_TOKEN, DatabaseModule, AuthModule],
    };
  }
}
