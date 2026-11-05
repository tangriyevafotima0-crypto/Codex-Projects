import {
  Body,
  Controller,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import {
  RequestWithAuthPrincipal,
  RequireRoutePolicy,
} from '../auth/permissions.guard';
import { DiscountApprovalService } from './discount-approval';
import {
  DiscountRequestResponseDto,
  DiscountRequestsService,
} from './discount-requests';
import {
  FreezeCreditService,
  FreezeResponseDto,
} from './freeze-credit';

@Controller('api/v1')
export class AdjustmentsController {
  constructor(
    @Inject(DiscountRequestsService)
    private readonly discountRequestsService: DiscountRequestsService,
    @Inject(DiscountApprovalService)
    private readonly discountApprovalService: DiscountApprovalService,
    @Inject(FreezeCreditService)
    private readonly freezeCreditService: FreezeCreditService,
  ) {}

  @Post('discounts/requests')
  @HttpCode(201)
  @RequireRoutePolicy({
    actionId: 'createDiscountOrGrantRequest',
    allowedRoles: ['DIRECTOR', 'ADMIN'],
    readOnlyLicensePolicy: 'BLOCKED_403_LICENSE_READ_ONLY_MODE',
  })
  public async createDiscountOrGrantRequest(
    @Req() req: RequestWithAuthPrincipal,
    @Body() body: unknown,
  ): Promise<DiscountRequestResponseDto> {
    return this.discountRequestsService.createDiscountOrGrantRequest(
      req,
      req.principal!,
      body,
    );
  }

  @Post('discounts/requests/:discount_request_id/decision')
  @HttpCode(200)
  @RequireRoutePolicy({
    actionId: 'decideDiscountOrGrantRequest',
    allowedRoles: ['DIRECTOR'],
    readOnlyLicensePolicy: 'BLOCKED_403_LICENSE_READ_ONLY_MODE',
  })
  public async decideDiscountOrGrantRequest(
    @Req() req: RequestWithAuthPrincipal,
    @Param('discount_request_id') discountRequestId: string,
    @Body() body: unknown,
  ): Promise<DiscountRequestResponseDto> {
    return this.discountApprovalService.decideDiscountOrGrantRequest(
      req,
      req.principal!,
      discountRequestId,
      body,
    );
  }

  @Post('freezes')
  @HttpCode(201)
  @RequireRoutePolicy({
    actionId: 'createFreezeAndIssueCreditNote',
    allowedRoles: ['DIRECTOR', 'ADMIN'],
    readOnlyLicensePolicy: 'BLOCKED_403_LICENSE_READ_ONLY_MODE',
  })
  public async createFreezeAndIssueCreditNote(
    @Req() req: RequestWithAuthPrincipal,
    @Body() body: unknown,
  ): Promise<FreezeResponseDto> {
    return this.freezeCreditService.createFreezeAndIssueCreditNote(
      req,
      req.principal!,
      body,
    );
  }
}
