import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BillingModule } from '../billing/billing.module';
import { AdjustmentsController } from './adjustments.controller';
import { DiscountApprovalService } from './discount-approval';
import { DiscountRequestsService } from './discount-requests';
import { FreezeCreditService } from './freeze-credit';
import { WithdrawalService } from './withdrawal';

@Module({
  imports: [AuthModule, BillingModule],
  controllers: [AdjustmentsController],
  providers: [
    DiscountRequestsService,
    DiscountApprovalService,
    FreezeCreditService,
    WithdrawalService,
  ],
  exports: [
    DiscountRequestsService,
    DiscountApprovalService,
    FreezeCreditService,
    WithdrawalService,
  ],
})
export class AdjustmentsModule {}
