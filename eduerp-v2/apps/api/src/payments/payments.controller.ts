import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  RequestWithAuthPrincipal,
  RequireRoutePolicy,
} from '../auth/permissions.guard';
import {
  PaymentRecordedResponseDto,
  ReceiptResponseDto,
  ReversalOrRefundResponseDto,
} from './dto';
import { PaymentService } from './payment.service';
import { ReceiptsService } from './receipts.service';
import { ReversalService } from './reversal.service';

@Controller('api/v1')
export class PaymentsController {
  constructor(
    @Inject(PaymentService) private readonly paymentService: PaymentService,
    @Inject(ReversalService) private readonly reversalService: ReversalService,
    @Inject(ReceiptsService) private readonly receiptsService: ReceiptsService,
  ) {}

  @Post('payments')
  @HttpCode(201)
  @RequireRoutePolicy({
    actionId: 'recordPaymentWithRequiredPromise',
    allowedRoles: ['DIRECTOR', 'ADMIN'],
    readOnlyLicensePolicy: 'BLOCKED_403_LICENSE_READ_ONLY_MODE',
  })
  public async recordPaymentWithRequiredPromise(
    @Req() req: RequestWithAuthPrincipal,
    @Body() body: unknown,
  ): Promise<PaymentRecordedResponseDto> {
    return this.paymentService.recordPaymentWithRequiredPromise(
      req,
      req.principal!,
      body,
    );
  }

  @Post('payments/reversals')
  @HttpCode(201)
  @RequireRoutePolicy({
    actionId: 'requestPaymentReversalOrRefund',
    allowedRoles: ['DIRECTOR', 'ADMIN'],
    readOnlyLicensePolicy: 'BLOCKED_403_LICENSE_READ_ONLY_MODE',
  })
  public async requestPaymentReversalOrRefund(
    @Req() req: RequestWithAuthPrincipal,
    @Body() body: unknown,
  ): Promise<ReversalOrRefundResponseDto> {
    return this.reversalService.requestPaymentReversalOrRefund(
      req,
      req.principal!,
      body,
    );
  }

  @Post('payments/reversals/:reversal_id/decision')
  @HttpCode(200)
  @RequireRoutePolicy({
    actionId: 'decidePaymentReversalOrRefund',
    allowedRoles: ['DIRECTOR'],
    readOnlyLicensePolicy: 'BLOCKED_403_LICENSE_READ_ONLY_MODE',
  })
  public async decidePaymentReversalOrRefund(
    @Req() req: RequestWithAuthPrincipal,
    @Param('reversal_id') reversalId: string,
    @Body() body: unknown,
  ): Promise<ReversalOrRefundResponseDto> {
    return this.reversalService.decidePaymentReversalOrRefund(
      req,
      req.principal!,
      reversalId,
      body,
    );
  }

  @Get('receipts/:receipt_id')
  @HttpCode(200)
  @RequireRoutePolicy({
    actionId: 'getPaymentReceipt',
    allowedRoles: ['DIRECTOR', 'ADMIN'],
    readOnlyLicensePolicy: 'ALLOWED_IN_READ_ONLY',
  })
  public async getPaymentReceipt(
    @Req() req: RequestWithAuthPrincipal,
    @Param('receipt_id') receiptId: string,
    @Query('student_id') studentId?: string,
  ): Promise<ReceiptResponseDto> {
    return this.receiptsService.getPaymentReceipt(
      req.principal!,
      receiptId,
      studentId,
    );
  }
}
