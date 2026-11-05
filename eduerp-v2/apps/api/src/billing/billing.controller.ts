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
  BillingPolicyListResponseDto,
  BillingPolicyService,
  BillingPolicyVersionDto,
} from './policy';
import {
  InvoiceGeneratorService,
  InvoiceListResponseDto,
  InvoiceResponseDto,
} from './invoice-generator';

@Controller('/api/v1')
export class BillingController {
  constructor(
    @Inject(BillingPolicyService) private readonly policyService: BillingPolicyService,
    @Inject(InvoiceGeneratorService)
    private readonly invoiceGenerator: InvoiceGeneratorService,
  ) {}

  @Get('/billing/policies')
  @RequireRoutePolicy({
    actionId: 'listBillingPolicyVersions',
    allowedRoles: ['DIRECTOR', 'ADMIN'],
    readOnlyLicensePolicy: 'ALLOWED_IN_READ_ONLY',
  })
  public async listBillingPolicyVersions(
    @Req() req: RequestWithAuthPrincipal,
  ): Promise<BillingPolicyListResponseDto> {
    return this.policyService.listPolicies(req.principal!);
  }

  @Post('/billing/policies')
  @HttpCode(201)
  @RequireRoutePolicy({
    actionId: 'createBillingPolicyVersion',
    allowedRoles: ['DIRECTOR'],
    readOnlyLicensePolicy: 'BLOCKED_403_LICENSE_READ_ONLY_MODE',
  })
  public async createBillingPolicyVersion(
    @Req() req: RequestWithAuthPrincipal,
    @Body() body: unknown,
  ): Promise<BillingPolicyVersionDto> {
    return this.policyService.createPolicyVersion(req, req.principal!, body);
  }

  @Post('/billing/cycles/invoice')
  @HttpCode(200)
  @RequireRoutePolicy({
    actionId: 'issueBillingCycleInvoice',
    allowedRoles: ['DIRECTOR', 'ADMIN'],
    readOnlyLicensePolicy: 'BLOCKED_403_LICENSE_READ_ONLY_MODE',
  })
  public async issueBillingCycleInvoice(
    @Req() req: RequestWithAuthPrincipal,
    @Body() body: unknown,
  ): Promise<InvoiceResponseDto> {
    return this.invoiceGenerator.issueBillingCycleInvoice(req, req.principal!, body);
  }

  @Get('/students/:student_id/invoices')
  @RequireRoutePolicy({
    actionId: 'listStudentInvoices',
    allowedRoles: ['DIRECTOR', 'ADMIN'],
    readOnlyLicensePolicy: 'ALLOWED_IN_READ_ONLY',
  })
  public async listStudentInvoices(
    @Req() req: RequestWithAuthPrincipal,
    @Param('student_id') studentId: string,
    @Query('limit') limit?: string,
  ): Promise<InvoiceListResponseDto> {
    return this.invoiceGenerator.listStudentInvoices(req.principal!, studentId, limit);
  }

  @Get('/invoices/:invoice_id')
  @RequireRoutePolicy({
    actionId: 'getInvoiceDetails',
    allowedRoles: ['DIRECTOR', 'ADMIN'],
    readOnlyLicensePolicy: 'ALLOWED_IN_READ_ONLY',
  })
  public async getInvoiceDetails(
    @Req() req: RequestWithAuthPrincipal,
    @Param('invoice_id') invoiceId: string,
  ): Promise<InvoiceResponseDto> {
    return this.invoiceGenerator.getInvoiceDetails(req.principal!, invoiceId);
  }
}
