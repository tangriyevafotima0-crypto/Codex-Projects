import { Module } from '@nestjs/common';
import { AcademicsModule } from '../academics/academics.module';
import { AuthModule } from '../auth/auth.module';
import { BillingController } from './billing.controller';
import { InvoiceGeneratorService } from './invoice-generator';
import { BillingPolicyService } from './policy';
import { TrialConversionService } from './trial-conversion';

@Module({
  imports: [AuthModule, AcademicsModule],
  controllers: [BillingController],
  providers: [BillingPolicyService, InvoiceGeneratorService, TrialConversionService],
  exports: [BillingPolicyService, InvoiceGeneratorService, TrialConversionService],
})
export class BillingModule {}
