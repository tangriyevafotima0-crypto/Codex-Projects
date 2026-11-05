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
  CashShiftReconciliationResponseDto,
  DebtorsAndPromisesListResponseDto,
} from './dto';
import { ExpensesService } from './expenses.service';
import { PromisesService } from './promises.service';
import { ReconciliationService } from './reconciliation.service';
import { ShiftsService } from './shifts.service';

@Controller('api/v1')
export class CashController {
  constructor(
    @Inject(ShiftsService) private readonly shiftsService: ShiftsService,
    @Inject(ExpensesService) private readonly expensesService: ExpensesService,
    @Inject(PromisesService) private readonly promisesService: PromisesService,
    @Inject(ReconciliationService)
    private readonly reconciliationService: ReconciliationService,
  ) {}

  @Post('cash-shifts/open')
  @HttpCode(201)
  @RequireRoutePolicy({
    actionId: 'openCashShift',
    allowedRoles: ['DIRECTOR', 'ADMIN'],
    readOnlyLicensePolicy: 'BLOCKED_403_LICENSE_READ_ONLY_MODE',
  })
  public async openCashShift(
    @Req() req: RequestWithAuthPrincipal,
    @Body() body: unknown,
  ): Promise<CashShiftReconciliationResponseDto> {
    return this.shiftsService.openCashShift(req, req.principal!, body);
  }

  @Post('cash-shifts/:shift_id/close')
  @HttpCode(200)
  @RequireRoutePolicy({
    actionId: 'closeCashShiftAndReconcile',
    allowedRoles: ['DIRECTOR', 'ADMIN'],
    readOnlyLicensePolicy: 'BLOCKED_403_LICENSE_READ_ONLY_MODE',
  })
  public async closeCashShiftAndReconcile(
    @Req() req: RequestWithAuthPrincipal,
    @Param('shift_id') shiftId: string,
    @Body() body: unknown,
  ): Promise<CashShiftReconciliationResponseDto> {
    return this.shiftsService.closeCashShiftAndReconcile(
      req,
      req.principal!,
      shiftId,
      body,
    );
  }

  @Get('cash-shifts/:shift_id')
  @HttpCode(200)
  @RequireRoutePolicy({
    actionId: 'getCashShiftReconciliation',
    allowedRoles: ['DIRECTOR', 'ADMIN'],
    readOnlyLicensePolicy: 'ALLOWED_IN_READ_ONLY',
  })
  public async getCashShiftReconciliation(
    @Req() req: RequestWithAuthPrincipal,
    @Param('shift_id') shiftId: string,
  ): Promise<CashShiftReconciliationResponseDto> {
    return this.reconciliationService.getCashShiftReconciliation(
      req.principal!,
      shiftId,
    );
  }

  @Post('cash-expenses')
  @HttpCode(201)
  @RequireRoutePolicy({
    actionId: 'recordCashOrCardExpense',
    allowedRoles: ['DIRECTOR', 'ADMIN'],
    readOnlyLicensePolicy: 'BLOCKED_403_LICENSE_READ_ONLY_MODE',
  })
  public async recordCashOrCardExpense(
    @Req() req: RequestWithAuthPrincipal,
    @Body() body: unknown,
  ): Promise<CashShiftReconciliationResponseDto> {
    return this.expensesService.recordCashOrCardExpense(req, req.principal!, body);
  }

  @Post('cash-expenses/:expense_id/reverse')
  @HttpCode(201)
  @RequireRoutePolicy({
    actionId: 'reverseExpenseById',
    allowedRoles: ['DIRECTOR'],
    readOnlyLicensePolicy: 'BLOCKED_403_LICENSE_READ_ONLY_MODE',
  })
  public async reverseExpenseById(
    @Req() req: RequestWithAuthPrincipal,
    @Param('expense_id') expenseId: string,
    @Body() body: unknown,
  ): Promise<CashShiftReconciliationResponseDto> {
    return this.expensesService.reverseExpenseById(
      req,
      req.principal!,
      expenseId,
      body,
    );
  }

  @Get('promises')
  @HttpCode(200)
  @RequireRoutePolicy({
    actionId: 'listDebtorsAndPromises',
    allowedRoles: ['DIRECTOR', 'ADMIN'],
    readOnlyLicensePolicy: 'ALLOWED_IN_READ_ONLY',
  })
  public async listDebtorsAndPromises(
    @Req() req: RequestWithAuthPrincipal,
    @Query('status') status?: string,
    @Query('student_id') studentId?: string,
    @Query('invoice_id') invoiceId?: string,
    @Query('due_on_or_before') dueOnOrBefore?: string,
  ): Promise<DebtorsAndPromisesListResponseDto> {
    return this.promisesService.listDebtorsAndPromises(req.principal!, {
      status,
      student_id: studentId,
      invoice_id: invoiceId,
      due_on_or_before: dueOnOrBefore,
    });
  }
}
