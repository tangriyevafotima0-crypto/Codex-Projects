/**
 * EduERP v2.0 — Stage 11, Step 11.04 (`T11.04`, `BR-09`, `C03`, `CASE-18`):
 * Canonical Cash Shift Reconciliation & Method-Wise Breakdown (`CASH`, `CARD`, `CLICK`, `PAYME`, `TRANSFER`),
 * Independent Recomputation from Immutable `payments`, `reversal_or_refund_executions`, `cash_expenses`, and `ledger_entries`,
 * and Fail-Closed Stored Projection Drift Detection.
 */

import { Inject, Injectable } from '@nestjs/common';
import type { CashShiftStatus, PaymentMethod } from '@eduerp/contracts';
import { ApiHttpException } from '../auth/auth.errors';
import { AuthenticatedStaffPrincipal } from '../auth/permissions.guard';
import { assertValidUuid } from '../auth/validation';
import { DatabaseService } from '../database/database.service';
import { formatMoneyUzs, parseNonNegativeMoneyUzs } from '../database/money';
import { runInTransaction, TransactionContext } from '../database/transaction';
import {
  CashExpenseRecordDto,
  CashShiftReconciliationResponseDto,
  ShiftMethodBreakdownItemDto,
} from './dto';

export const CANONICAL_PAYMENT_METHODS_ORDER: readonly PaymentMethod[] = Object.freeze([
  'CASH',
  'CARD',
  'CLICK',
  'PAYME',
  'TRANSFER',
]);

export interface RecomputedShiftTotals {
  readonly openingCashUzs: bigint;
  readonly cashReceiptsUzs: bigint;
  readonly nonCashReceiptsUzs: bigint;
  readonly cashRefundsUzs: bigint;
  readonly nonCashRefundsUzs: bigint;
  readonly cashExpensesUzs: bigint;
  readonly nonCashExpensesUzs: bigint;
  readonly expectedClosingCashUzs: bigint;
  readonly netNonCashFlowUzs: bigint;
  readonly countedClosingCashUzs: bigint | null;
  readonly discrepancyUzs: bigint | null;
  readonly methodBreakdown: readonly ShiftMethodBreakdownItemDto[];
}

function formatPgDate(val: unknown): string {
  if (val instanceof Date) return val.toISOString().slice(0, 10);
  return String(val).slice(0, 10);
}

export function computeCanonicalShiftReconciliation(params: {
  readonly openingCashUzs: bigint | string;
  readonly paymentsByMethod?: Partial<Record<PaymentMethod, bigint | string>>;
  readonly reversalsByMethod?: Partial<Record<PaymentMethod, bigint | string>>;
  readonly grossExpensesByMethod?: Partial<Record<PaymentMethod, bigint | string>>;
  readonly expenseReversalsByMethod?: Partial<Record<PaymentMethod, bigint | string>>;
  readonly countedClosingCashUzs?: bigint | string | null;
}): RecomputedShiftTotals {
  const openingCashUzs = parseNonNegativeMoneyUzs(params.openingCashUzs, 'openingCashUzs');
  const countedClosingCashUzs =
    params.countedClosingCashUzs !== undefined && params.countedClosingCashUzs !== null
      ? parseNonNegativeMoneyUzs(params.countedClosingCashUzs, 'countedClosingCashUzs')
      : null;

  let cashReceiptsUzs = 0n;
  let nonCashReceiptsUzs = 0n;
  let cashRefundsUzs = 0n;
  let nonCashRefundsUzs = 0n;
  let cashExpensesUzs = 0n;
  let nonCashExpensesUzs = 0n;

  const methodBreakdown: ShiftMethodBreakdownItemDto[] = [];

  for (const method of CANONICAL_PAYMENT_METHODS_ORDER) {
    const grossReceipts = parseNonNegativeMoneyUzs(
      params.paymentsByMethod?.[method] ?? 0n,
      `paymentsByMethod.${method}`,
    );
    const refunds = parseNonNegativeMoneyUzs(
      params.reversalsByMethod?.[method] ?? 0n,
      `reversalsByMethod.${method}`,
    );
    const grossExpenses = parseNonNegativeMoneyUzs(
      params.grossExpensesByMethod?.[method] ?? 0n,
      `grossExpensesByMethod.${method}`,
    );
    const expenseReversals = parseNonNegativeMoneyUzs(
      params.expenseReversalsByMethod?.[method] ?? 0n,
      `expenseReversalsByMethod.${method}`,
    );

    if (expenseReversals > grossExpenses) {
      throw new ApiHttpException({
        statusCode: 409,
        errorCode: 'VERSION_CONFLICT',
        message: `Expense reversals (${formatMoneyUzs(expenseReversals)} UZS) for method ${method} exceed gross expenses (${formatMoneyUzs(grossExpenses)} UZS)`,
      });
    }

    const netExpenses = grossExpenses - expenseReversals;
    const netFlow = grossReceipts - refunds - netExpenses;

    if (method === 'CASH') {
      cashReceiptsUzs += grossReceipts;
      cashRefundsUzs += refunds;
      cashExpensesUzs += netExpenses;
    } else {
      nonCashReceiptsUzs += grossReceipts;
      nonCashRefundsUzs += refunds;
      nonCashExpensesUzs += netExpenses;
    }

    methodBreakdown.push(
      Object.freeze({
        payment_method: method,
        gross_receipts_uzs: formatMoneyUzs(grossReceipts),
        refunds_and_reversals_uzs: formatMoneyUzs(refunds),
        gross_expenses_uzs: formatMoneyUzs(grossExpenses),
        expense_reversals_uzs: formatMoneyUzs(expenseReversals),
        net_expenses_uzs: formatMoneyUzs(netExpenses),
        net_flow_uzs: formatMoneyUzs(netFlow),
      }),
    );
  }

  const expectedClosingCashUzs =
    openingCashUzs + cashReceiptsUzs - cashRefundsUzs - cashExpensesUzs;
  const netNonCashFlowUzs =
    nonCashReceiptsUzs - nonCashRefundsUzs - nonCashExpensesUzs;
  const discrepancyUzs =
    countedClosingCashUzs !== null
      ? countedClosingCashUzs - expectedClosingCashUzs
      : null;

  return Object.freeze({
    openingCashUzs,
    cashReceiptsUzs,
    nonCashReceiptsUzs,
    cashRefundsUzs,
    nonCashRefundsUzs,
    cashExpensesUzs,
    nonCashExpensesUzs,
    expectedClosingCashUzs,
    netNonCashFlowUzs,
    countedClosingCashUzs,
    discrepancyUzs,
    methodBreakdown: Object.freeze(methodBreakdown),
  });
}

@Injectable()
export class ReconciliationService {
  constructor(
    @Inject(DatabaseService) private readonly databaseService: DatabaseService,
  ) {}

  public async buildShiftReconciliationDtoInTx(
    tx: TransactionContext,
    params: {
      readonly centerId: string;
      readonly shiftId: string;
      readonly lockShiftForUpdate?: boolean;
      readonly strictDriftCheck?: boolean;
      readonly lastRecordedExpenseId?: string | null;
    },
  ): Promise<{
    readonly dto: CashShiftReconciliationResponseDto;
    readonly recomputed: RecomputedShiftTotals;
    readonly driftDetected: boolean;
  }> {
    const lockClause = params.lockShiftForUpdate ? 'FOR UPDATE' : '';
    const shiftRes = await tx.query<{
      id: string;
      center_id: string;
      shift_date: unknown;
      opened_by_admin_id: string;
      opened_at: Date;
      opening_cash_uzs: string;
      cash_receipts_uzs: string;
      non_cash_receipts_uzs: string;
      cash_refunds_uzs: string;
      non_cash_refunds_uzs: string;
      cash_expenses_uzs: string;
      non_cash_expenses_uzs: string;
      expected_closing_cash_uzs: string;
      counted_closing_cash_uzs: string | null;
      discrepancy_uzs: string | null;
      discrepancy_reason: string | null;
      status: CashShiftStatus;
      closed_by_admin_id: string | null;
      closed_at: Date | null;
      version: number;
    }>(
      `SELECT "id"::text AS id,
              "center_id"::text AS center_id,
              "shift_date"::text AS shift_date,
              "opened_by_admin_id"::text AS opened_by_admin_id,
              "opened_at",
              "opening_cash_uzs"::text AS opening_cash_uzs,
              "cash_receipts_uzs"::text AS cash_receipts_uzs,
              "non_cash_receipts_uzs"::text AS non_cash_receipts_uzs,
              "cash_refunds_uzs"::text AS cash_refunds_uzs,
              "non_cash_refunds_uzs"::text AS non_cash_refunds_uzs,
              "cash_expenses_uzs"::text AS cash_expenses_uzs,
              "non_cash_expenses_uzs"::text AS non_cash_expenses_uzs,
              "expected_closing_cash_uzs"::text AS expected_closing_cash_uzs,
              "counted_closing_cash_uzs"::text AS counted_closing_cash_uzs,
              "discrepancy_uzs"::text AS discrepancy_uzs,
              "discrepancy_reason",
              "status"::text AS status,
              "closed_by_admin_id"::text AS closed_by_admin_id,
              "closed_at",
              "version"
         FROM "cash_shifts"
        WHERE "id" = $1::uuid
          AND "center_id" = $2::uuid
        ${lockClause}`,
      [params.shiftId, params.centerId],
    );

    const shift = shiftRes.rows[0];
    if (!shift) {
      throw new ApiHttpException({
        statusCode: 404,
        errorCode: 'NOT_FOUND',
        message: 'Cash shift not found in center scope',
      });
    }

    const payAggRes = await tx.query<{
      payment_method: PaymentMethod;
      total_uzs: string;
    }>(
      `SELECT "payment_method"::text AS payment_method,
              COALESCE(SUM("amount_uzs"), 0)::text AS total_uzs
         FROM "payments"
        WHERE "center_id" = $1::uuid
          AND "cash_shift_id" = $2::uuid
        GROUP BY "payment_method"`,
      [params.centerId, params.shiftId],
    );
    const paymentsByMethod: Partial<Record<PaymentMethod, bigint>> = {};
    for (const r of payAggRes.rows) {
      paymentsByMethod[r.payment_method] = BigInt(r.total_uzs);
    }

    const revAggRes = await tx.query<{
      refund_method: PaymentMethod;
      total_uzs: string;
    }>(
      `SELECT "refund_method"::text AS refund_method,
              COALESCE(SUM("amount_uzs"), 0)::text AS total_uzs
         FROM "reversal_or_refund_executions"
        WHERE "center_id" = $1::uuid
          AND "cash_shift_id" = $2::uuid
        GROUP BY "refund_method"`,
      [params.centerId, params.shiftId],
    );
    const reversalsByMethod: Partial<Record<PaymentMethod, bigint>> = {};
    for (const r of revAggRes.rows) {
      reversalsByMethod[r.refund_method] = BigInt(r.total_uzs);
    }

    const expRowsRes = await tx.query<{
      id: string;
      cash_shift_id: string;
      category: string;
      amount_uzs: string;
      payment_method: PaymentMethod;
      reason_and_doc: string;
      reverses_expense_id: string | null;
      recorded_by_staff_id: string;
      created_at: Date;
    }>(
      `SELECT "id"::text AS id,
              "cash_shift_id"::text AS cash_shift_id,
              "category",
              "amount_uzs"::text AS amount_uzs,
              "payment_method"::text AS payment_method,
              "reason_and_doc",
              "reverses_expense_id"::text AS reverses_expense_id,
              "recorded_by_staff_id"::text AS recorded_by_staff_id,
              "created_at"
         FROM "cash_expenses"
        WHERE "center_id" = $1::uuid
          AND "cash_shift_id" = $2::uuid
        ORDER BY "created_at" ASC, "id" ASC`,
      [params.centerId, params.shiftId],
    );

    const grossExpensesByMethod: Partial<Record<PaymentMethod, bigint>> = {};
    const expenseReversalsByMethod: Partial<Record<PaymentMethod, bigint>> = {};
    const reversedByMap = new Map<string, string>();

    for (const exp of expRowsRes.rows) {
      const amt = BigInt(exp.amount_uzs);
      if (exp.reverses_expense_id === null) {
        grossExpensesByMethod[exp.payment_method] =
          (grossExpensesByMethod[exp.payment_method] ?? 0n) + (amt >= 0n ? amt : -amt);
      } else {
        reversedByMap.set(exp.reverses_expense_id, exp.id);
        expenseReversalsByMethod[exp.payment_method] =
          (expenseReversalsByMethod[exp.payment_method] ?? 0n) + (amt < 0n ? -amt : amt);
      }
    }

    const expensesList: CashExpenseRecordDto[] = expRowsRes.rows.map((exp) =>
      Object.freeze({
        expense_id: exp.id,
        cash_shift_id: exp.cash_shift_id,
        category: exp.category,
        amount_uzs: BigInt(exp.amount_uzs).toString(10),
        payment_method: exp.payment_method,
        reason_and_doc: exp.reason_and_doc,
        reverses_expense_id: exp.reverses_expense_id,
        is_reversed: reversedByMap.has(exp.id),
        reversed_by_expense_id: reversedByMap.get(exp.id) ?? null,
        recorded_by_staff_id: exp.recorded_by_staff_id,
        created_at_utc: new Date(exp.created_at).toISOString(),
      }),
    );

    const recomputed = computeCanonicalShiftReconciliation({
      openingCashUzs: BigInt(shift.opening_cash_uzs),
      paymentsByMethod,
      reversalsByMethod,
      grossExpensesByMethod,
      expenseReversalsByMethod,
      countedClosingCashUzs:
        shift.counted_closing_cash_uzs !== null
          ? BigInt(shift.counted_closing_cash_uzs)
          : null,
    });

    const ledgerCheckRes = await tx.query<{
      pay_credit: string;
      rev_debit: string;
      exp_debit: string;
      exp_rev_credit: string;
    }>(
      `SELECT COALESCE(SUM(CASE WHEN le."entry_type" = 'PAYMENT_RECEIVED' AND le."direction" = 'CREDIT' THEN le."amount_uzs" ELSE 0 END), 0)::text AS pay_credit,
              COALESCE(SUM(CASE WHEN le."entry_type" IN ('PAYMENT_REVERSED', 'REFUND_PAID') AND le."direction" = 'DEBIT' THEN le."amount_uzs" ELSE 0 END), 0)::text AS rev_debit,
              COALESCE(SUM(CASE WHEN le."entry_type" = 'EXPENSE_RECORDED' AND le."direction" = 'DEBIT' THEN le."amount_uzs" ELSE 0 END), 0)::text AS exp_debit,
              COALESCE(SUM(CASE WHEN le."entry_type" = 'EXPENSE_REVERSED' AND le."direction" = 'CREDIT' THEN le."amount_uzs" ELSE 0 END), 0)::text AS exp_rev_credit
         FROM "ledger_entries" le
        WHERE le."center_id" = $1::uuid
          AND (
            le."payment_id" IN (SELECT p."id" FROM "payments" p WHERE p."center_id" = $1::uuid AND p."cash_shift_id" = $2::uuid AND p."id" = le."payment_id" AND le."payment_id" IS NOT NULL AND le."reversal_execution_id" IS NULL)
            OR le."reversal_execution_id" IN (SELECT re."id" FROM "reversal_or_refund_executions" re WHERE re."center_id" = $1::uuid AND re."cash_shift_id" = $2::uuid)
            OR le."cash_expense_id" IN (SELECT ce."id" FROM "cash_expenses" ce WHERE ce."center_id" = $1::uuid AND ce."cash_shift_id" = $2::uuid)
          )`,
      [params.centerId, params.shiftId],
    );

    const ledgerRow = ledgerCheckRes.rows[0]!;
    const ledgerNetExpenses =
      BigInt(ledgerRow.exp_debit) - BigInt(ledgerRow.exp_rev_credit);
    const recomputedTotalReceipts =
      recomputed.cashReceiptsUzs + recomputed.nonCashReceiptsUzs;
    const recomputedTotalRefunds =
      recomputed.cashRefundsUzs + recomputed.nonCashRefundsUzs;
    const recomputedTotalNetExpenses =
      recomputed.cashExpensesUzs + recomputed.nonCashExpensesUzs;

    const hasLedgerRows =
      BigInt(ledgerRow.pay_credit) > 0n ||
      BigInt(ledgerRow.rev_debit) > 0n ||
      BigInt(ledgerRow.exp_debit) > 0n ||
      BigInt(ledgerRow.exp_rev_credit) > 0n;

    const ledgerMismatch =
      hasLedgerRows &&
      (BigInt(ledgerRow.pay_credit) !== recomputedTotalReceipts ||
        BigInt(ledgerRow.rev_debit) !== recomputedTotalRefunds ||
        ledgerNetExpenses !== recomputedTotalNetExpenses);

    const storedCashReceipts = BigInt(shift.cash_receipts_uzs);
    const storedNonCashReceipts = BigInt(shift.non_cash_receipts_uzs);
    const storedCashRefunds = BigInt(shift.cash_refunds_uzs);
    const storedNonCashRefunds = BigInt(shift.non_cash_refunds_uzs);
    const storedCashExpenses = BigInt(shift.cash_expenses_uzs);
    const storedNonCashExpenses = BigInt(shift.non_cash_expenses_uzs ?? '0');
    const storedExpectedClosing = BigInt(shift.expected_closing_cash_uzs);

    const driftDetected =
      ledgerMismatch ||
      storedCashReceipts !== recomputed.cashReceiptsUzs ||
      storedNonCashReceipts !== recomputed.nonCashReceiptsUzs ||
      storedCashRefunds !== recomputed.cashRefundsUzs ||
      storedNonCashRefunds !== recomputed.nonCashRefundsUzs ||
      storedCashExpenses !== recomputed.cashExpensesUzs ||
      storedNonCashExpenses !== recomputed.nonCashExpensesUzs ||
      storedExpectedClosing !== recomputed.expectedClosingCashUzs;

    if (params.strictDriftCheck && driftDetected) {
      throw new ApiHttpException({
        statusCode: 409,
        errorCode: 'VERSION_CONFLICT',
        message:
          'Cash shift stored projection columns drifted from canonical immutable payment/reversal/expense/ledger records; refusing to close or mutate corrupted shift state (11.04)',
        conflictDetails: {
          stored_expected_closing_cash_uzs: formatMoneyUzs(storedExpectedClosing),
          recomputed_expected_closing_cash_uzs: formatMoneyUzs(
            recomputed.expectedClosingCashUzs,
          ),
          stored_cash_receipts_uzs: formatMoneyUzs(storedCashReceipts),
          recomputed_cash_receipts_uzs: formatMoneyUzs(recomputed.cashReceiptsUzs),
          stored_cash_expenses_uzs: formatMoneyUzs(storedCashExpenses),
          recomputed_cash_expenses_uzs: formatMoneyUzs(recomputed.cashExpensesUzs),
        },
      });
    }

    const dto: CashShiftReconciliationResponseDto = Object.freeze({
      shift_id: shift.id,
      shift_date: formatPgDate(shift.shift_date),
      status: shift.status,
      opened_by_admin_id: shift.opened_by_admin_id,
      opened_at_utc: new Date(shift.opened_at).toISOString(),
      closed_by_admin_id: shift.closed_by_admin_id,
      closed_at_utc: shift.closed_at ? new Date(shift.closed_at).toISOString() : null,
      opening_cash_uzs: formatMoneyUzs(recomputed.openingCashUzs),
      cash_receipts_uzs: formatMoneyUzs(recomputed.cashReceiptsUzs),
      non_cash_receipts_uzs: formatMoneyUzs(recomputed.nonCashReceiptsUzs),
      cash_refunds_uzs: formatMoneyUzs(recomputed.cashRefundsUzs),
      non_cash_refunds_uzs: formatMoneyUzs(recomputed.nonCashRefundsUzs),
      cash_expenses_uzs: formatMoneyUzs(recomputed.cashExpensesUzs),
      non_cash_expenses_uzs: formatMoneyUzs(recomputed.nonCashExpensesUzs),
      expected_closing_cash_uzs: formatMoneyUzs(recomputed.expectedClosingCashUzs),
      counted_closing_cash_uzs:
        recomputed.countedClosingCashUzs !== null
          ? formatMoneyUzs(recomputed.countedClosingCashUzs)
          : null,
      discrepancy_uzs:
        recomputed.discrepancyUzs !== null
          ? formatMoneyUzs(recomputed.discrepancyUzs)
          : null,
      discrepancy_reason: shift.discrepancy_reason,
      net_non_cash_flow_uzs: formatMoneyUzs(recomputed.netNonCashFlowUzs),
      projection_drift_detected: driftDetected,
      method_breakdown: recomputed.methodBreakdown,
      expenses: Object.freeze(expensesList),
      last_recorded_expense_id:
        params.lastRecordedExpenseId !== undefined
          ? params.lastRecordedExpenseId
          : expensesList.length > 0
            ? expensesList[expensesList.length - 1].expense_id
            : null,
      version: Number(shift.version),
    });

    return Object.freeze({
      dto,
      recomputed,
      driftDetected,
    });
  }

  public async getCashShiftReconciliation(
    principal: AuthenticatedStaffPrincipal,
    rawShiftId: unknown,
  ): Promise<CashShiftReconciliationResponseDto> {
    if (principal.role !== 'DIRECTOR' && principal.role !== 'ADMIN') {
      throw new ApiHttpException({
        statusCode: 403,
        errorCode: 'FORBIDDEN_ROLE',
        message: 'Only DIRECTOR and ADMIN are permitted to view cash shift reconciliation reports (T11.04)',
      });
    }

    const shiftId = assertValidUuid(rawShiftId, 'shift_id');

    const txRes = await runInTransaction(
      this.databaseService,
      async (tx) => {
        const out = await this.buildShiftReconciliationDtoInTx(tx, {
          centerId: principal.centerId,
          shiftId,
          lockShiftForUpdate: false,
          strictDriftCheck: true,
        });
        return out.dto;
      },
      { isolationLevel: 'REPEATABLE READ' },
    );

    return txRes.result;
  }
}
