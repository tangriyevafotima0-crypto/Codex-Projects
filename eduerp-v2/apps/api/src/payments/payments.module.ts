import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BillingModule } from '../billing/billing.module';
import { AllocationService } from './allocation.service';
import { PaymentService } from './payment.service';
import { PaymentsController } from './payments.controller';
import { ReceiptsService } from './receipts.service';
import { ReversalService } from './reversal.service';

@Module({
  imports: [AuthModule, BillingModule],
  controllers: [PaymentsController],
  providers: [
    AllocationService,
    ReceiptsService,
    PaymentService,
    ReversalService,
  ],
  exports: [
    AllocationService,
    ReceiptsService,
    PaymentService,
    ReversalService,
  ],
})
export class PaymentsModule {}
