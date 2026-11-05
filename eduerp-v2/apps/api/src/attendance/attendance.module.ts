import { Module } from '@nestjs/common';
import { AcademicsModule } from '../academics/academics.module';
import { AuthModule } from '../auth/auth.module';
import { BillingModule } from '../billing/billing.module';
import { DatabaseModule } from '../database/database.module';
import { AttendanceController } from './attendance.controller';
import { AttendanceService } from './attendance.service';
import { ConflictsService } from './conflicts.service';
import { SyncService } from './sync.service';

@Module({
  imports: [DatabaseModule, AuthModule, AcademicsModule, BillingModule],
  controllers: [AttendanceController],
  providers: [ConflictsService, AttendanceService, SyncService],
  exports: [ConflictsService, AttendanceService, SyncService],
})
export class AttendanceModule {}
