import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { CashController } from './cash.controller';
import { ExpensesService } from './expenses.service';
import { PromisesService } from './promises.service';
import { ReconciliationService } from './reconciliation.service';
import { ShiftsService } from './shifts.service';

@Module({
  imports: [DatabaseModule, AuthModule],
  controllers: [CashController],
  providers: [ShiftsService, ExpensesService, PromisesService, ReconciliationService],
  exports: [ShiftsService, ExpensesService, PromisesService, ReconciliationService],
})
export class CashModule {}
