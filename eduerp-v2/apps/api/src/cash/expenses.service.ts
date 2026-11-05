/**
 * EduERP v2.0 — Stage 11, Step 11.02 (`T11.02`, `BR-09`, `C03`):
 * Categorized Cash & Non-Cash Expense Recording (`CASH`, `CARD`, `CLICK`, `PAYME`, `TRANSFER`),
 * Negative Cash Overdraft Guard, Director-Only Append-Only Expense Reversal (`reverses_expense_id`),
 * Single-Reversal Uniqueness, and Atomic `CashExpense` + `CashShift` + `LedgerEntry` + `AuditLog`.
 */

import { Inject, Injectable } from '@nestjs/common';
import type { CashShiftStatus, PaymentMethod } from '@eduerp/contracts';
import * as crypto from 'node:crypto';
import { ApiHttpException } from '../auth/auth.errors';
import { ClockService } from '../auth/clock.service';
import { AuthenticatedStaffPrincipal } from '../auth/permissions.guard';
import {
  assertPlainObject,
  assertValidUuid,
  requireIdempotencyKeyHeader,
} from '../auth/validation';
import { RequestWithCorrelationId, resolveRequestId } from '../common/request-id.middleware';
import { ApiEnvConfig } from '../config/env';
import { API_CONFIG_TOKEN } from '../config/tokens';
import { DatabaseService } from '../database/database.service';
import { executeIdempotentOperation } from '../database/idempotency';
import { formatMoneyUzs } from '../database/money';
import { executeOptimisticUpdate, TransactionContext } from '../database/transaction';
import {
  CashShiftReconciliationResponseDto,
  ExpenseFaultInjectionStep,
  validateRecordExpenseInput,
} from './dto';
import { ReconciliationService } from './reconciliation.service';

@Injectable()
export class ExpensesService {
  constructor(
    @Inject(API_CONFIG_TOKEN) private readonly config: ApiEnvConfig,
    @Inject(DatabaseService) private readonly databaseService: DatabaseService,
    @Inject(ClockService) private readonly clock: ClockService,
    @Inject(ReconciliationService)
    private readonly reconciliationService: ReconciliationService,
  ) {}

  private maybeInjectTestFault(
    targetStep: ExpenseFaultInjectionStep,
    configuredFault?: ExpenseFaultInjectionStep,
  ): void {
    if (this.config.nodeEnv === 'test' && configuredFault === targetStep) {
      throw new Error(`SIMULATED_S11_EXPENSE_FAULT_AFTER_${targetStep}`);
    }
  }

  public async recordCashOrCardExpense(
    req: RequestWithCorrelationId,
    principal: AuthenticatedStaffPrincipal,
    rawBody: unknown,
    options?: { readonly testFaultAfterStep?: ExpenseFaultInjectionStep },
  ): Promise<CashShiftReconciliationResponseDto> {
    if (principal.role !== 'DIRECTOR' && principal.role !== 'ADMIN') {
      throw new ApiHttpException({
        statusCode: 403,
        errorCode: 'FORBIDDEN_ROLE',
        message: 'Only DIRECTOR and ADMIN are permitted to record expenses (T11.02)',
      });
    }

    const idempotencyKey = requireIdempotencyKeyHeader(req);
    const requestId = req.requestId ?? resolveRequestId(req.headers['x-request-id']);
    const nowUtc = this.clock.now();
    const parsed = validateRecordExpenseInput(rawBody);

    if (parsed.reversesExpenseId !== null && principal.role !== 'DIRECTOR') {
      throw new ApiHttpException({
        statusCode: 403,
        errorCode: 'FORBIDDEN_ROLE',
        message: 'Only DIRECTOR is permitted to reverse a recorded cash or non-cash expense (11.02)',
      });
    }

    const idemPayload = {
      cash_shift_id: parsed.cashShiftId,
      category: parsed.category,
      amount_uzs: formatMoneyUzs(parsed.rawSignedAmountUzs),
      payment_method: parsed.paymentMethod,
      reason_and_doc: parsed.reasonAndDoc,
      reverses_expense_id: parsed.reversesExpenseId,
    };

    const idemOutcome = await executeIdempotentOperation<CashShiftReconciliationResponseDto>(
      this.databaseService,
      {
        centerId: principal.centerId,
        actorStaffId: principal.staffId,
        operationType: 'RECORD_CASH_OR_CARD_EXPENSE',
        idempotencyKey,
        requestPayload: idemPayload,
        authorizeBeforeReplayOrExecute: async (tx: TransactionContext) => {
          const staffRes = await tx.query<{ role: string; status: string }>(
            `SELECT "role"::text AS role, "status"::text AS status
               FROM "staff_users"
              WHERE "id" = $1::uuid
                AND "center_id" = $2::uuid
              LIMIT 1`,
            [principal.staffId, principal.centerId],
          );
          const staffRow = staffRes.rows[0];
          if (!staffRow || staffRow.status !== 'ACTIVE') {
            throw new ApiHttpException({
              statusCode: 401,
              errorCode: 'UNAUTHORIZED',
              message: 'Staff user is no longer active',
            });
          }
          if (staffRow.role !== 'DIRECTOR' && staffRow.role !== 'ADMIN') {
            throw new ApiHttpException({
              statusCode: 403,
              errorCode: 'FORBIDDEN_ROLE',
              message: 'Only DIRECTOR and ADMIN are permitted to record expenses',
            });
          }
          if (parsed.reversesExpenseId !== null && staffRow.role !== 'DIRECTOR') {
            throw new ApiHttpException({
              statusCode: 403,
              errorCode: 'FORBIDDEN_ROLE',
              message: 'Only DIRECTOR is permitted to reverse a recorded expense',
            });
          }

          if (parsed.reversesExpenseId !== null) {
            await tx.query(
              `SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`,
              [principal.centerId, parsed.reversesExpenseId],
            );
          }

          const shiftCheckRes = await tx.query<{ id: string }>(
            `SELECT "id"::text AS id
               FROM "cash_shifts"
              WHERE "id" = $1::uuid
                AND "center_id" = $2::uuid
              LIMIT 1`,
            [parsed.cashShiftId, principal.centerId],
          );
          if (!shiftCheckRes.rows[0]) {
            throw new ApiHttpException({
              statusCode: 404,
              errorCode: 'NOT_FOUND',
              message: 'Cash shift not found in center scope',
            });
          }
        },
        handler: async (tx: TransactionContext) => {
          const shiftRes = await tx.query<{
            id: string;
            status: CashShiftStatus;
            opening_cash_uzs: string;
            cash_receipts_uzs: string;
            non_cash_receipts_uzs: string;
            cash_refunds_uzs: string;
            non_cash_refunds_uzs: string;
            cash_expenses_uzs: string;
            non_cash_expenses_uzs: string;
            expected_closing_cash_uzs: string;
            version: number;
          }>(
            `SELECT "id"::text AS id,
                    "status"::text AS status,
                    "opening_cash_uzs"::text AS opening_cash_uzs,
                    "cash_receipts_uzs"::text AS cash_receipts_uzs,
                    "non_cash_receipts_uzs"::text AS non_cash_receipts_uzs,
                    "cash_refunds_uzs"::text AS cash_refunds_uzs,
                    "non_cash_refunds_uzs"::text AS non_cash_refunds_uzs,
                    "cash_expenses_uzs"::text AS cash_expenses_uzs,
                    "non_cash_expenses_uzs"::text AS non_cash_expenses_uzs,
                    "expected_closing_cash_uzs"::text AS expected_closing_cash_uzs,
                    "version"
               FROM "cash_shifts"
              WHERE "id" = $1::uuid
                AND "center_id" = $2::uuid
              FOR UPDATE`,
            [parsed.cashShiftId, principal.centerId],
          );

          const shift = shiftRes.rows[0];
          if (!shift) {
            throw new ApiHttpException({
              statusCode: 404,
              errorCode: 'NOT_FOUND',
              message: 'Cash shift not found in center scope',
            });
          }
          if (shift.status !== 'OPEN') {
            throw new ApiHttpException({
              statusCode: 409,
              errorCode: 'SHIFT_CLOSED',
              message: `Cannot record or reverse expense in CLOSED cash shift (${parsed.cashShiftId}) (T11.01, T11.02)`,
            });
          }

          const openingCashUzs = BigInt(shift.opening_cash_uzs);
          const cashReceiptsUzs = BigInt(shift.cash_receipts_uzs);
          const cashRefundsUzs = BigInt(shift.cash_refunds_uzs);
          const cashExpensesUzs = BigInt(shift.cash_expenses_uzs);
          const nonCashExpensesUzs = BigInt(shift.non_cash_expenses_uzs ?? '0');
          const expectedClosingCashUzs = BigInt(shift.expected_closing_cash_uzs);

          const expenseId = crypto.randomUUID();

          if (parsed.reversesExpenseId === null) {
            const positiveExpenseUzs = parsed.rawSignedAmountUzs;

            if (parsed.paymentMethod === 'CASH') {
              if (positiveExpenseUzs > expectedClosingCashUzs) {
                throw new ApiHttpException({
                  statusCode: 422,
                  errorCode: 'VALIDATION_ERROR',
                  message: `Cash expense (${formatMoneyUzs(positiveExpenseUzs)} UZS) exceeds available cash in shift drawer (${formatMoneyUzs(expectedClosingCashUzs)} UZS); negative cash drawer overdraft is forbidden (11.02)`,
                });
              }
            }

            await tx.query(
              `INSERT INTO "cash_expenses" (
                 "id",
                 "center_id",
                 "cash_shift_id",
                 "category",
                 "amount_uzs",
                 "payment_method",
                 "reason_and_doc",
                 "reverses_expense_id",
                 "recorded_by_staff_id",
                 "created_at"
               ) VALUES (
                 $1::uuid,
                 $2::uuid,
                 $3::uuid,
                 $4,
                 $5::bigint,
                 $6,
                 $7,
                 NULL,
                 $8::uuid,
                 $9::timestamptz
               )`,
              [
                expenseId,
                principal.centerId,
                parsed.cashShiftId,
                parsed.category,
                formatMoneyUzs(positiveExpenseUzs),
                parsed.paymentMethod,
                parsed.reasonAndDoc,
                principal.staffId,
                nowUtc.toISOString(),
              ],
            );

            this.maybeInjectTestFault('EXPENSE_INSERT', options?.testFaultAfterStep);

            if (parsed.paymentMethod === 'CASH') {
              const newCashExpenses = cashExpensesUzs + positiveExpenseUzs;
              const newExpectedClosing =
                openingCashUzs + cashReceiptsUzs - cashRefundsUzs - newCashExpenses;
              await executeOptimisticUpdate(tx, {
                tableName: 'cash_shifts',
                entityName: 'CashShift',
                id: shift.id,
                centerId: principal.centerId,
                expectedVersion: Number(shift.version),
                setClauseSql: `"cash_expenses_uzs" = $4::bigint, "expected_closing_cash_uzs" = $5::bigint`,
                additionalValues: [
                  formatMoneyUzs(newCashExpenses),
                  formatMoneyUzs(newExpectedClosing),
                ],
              });
            } else {
              const newNonCashExpenses = nonCashExpensesUzs + positiveExpenseUzs;
              await executeOptimisticUpdate(tx, {
                tableName: 'cash_shifts',
                entityName: 'CashShift',
                id: shift.id,
                centerId: principal.centerId,
                expectedVersion: Number(shift.version),
                setClauseSql: `"non_cash_expenses_uzs" = $4::bigint`,
                additionalValues: [formatMoneyUzs(newNonCashExpenses)],
              });
            }

            this.maybeInjectTestFault('CASH_SHIFT_UPDATE', options?.testFaultAfterStep);

            const ledgerId = crypto.randomUUID();
            await tx.query(
              `INSERT INTO "ledger_entries" (
                 "id",
                 "center_id",
                 "entry_type",
                 "cash_expense_id",
                 "direction",
                 "amount_uzs",
                 "payment_method",
                 "actor_type",
                 "actor_staff_id",
                 "system_job_name",
                 "created_at"
               ) VALUES (
                 $1::uuid,
                 $2::uuid,
                 'EXPENSE_RECORDED',
                 $3::uuid,
                 'DEBIT',
                 $4::bigint,
                 $5,
                 'STAFF',
                 $6::uuid,
                 NULL,
                 $7::timestamptz
               )`,
              [
                ledgerId,
                principal.centerId,
                expenseId,
                formatMoneyUzs(positiveExpenseUzs),
                parsed.paymentMethod,
                principal.staffId,
                nowUtc.toISOString(),
              ],
            );

            this.maybeInjectTestFault('LEDGER_ENTRY', options?.testFaultAfterStep);

            const auditId = crypto.randomUUID();
            await tx.query(
              `INSERT INTO "audit_logs" (
                 "id",
                 "center_id",
                 "actor_type",
                 "actor_id",
                 "actor_role",
                 "action",
                 "entity_type",
                 "entity_id",
                 "severity",
                 "before_redacted_json",
                 "after_redacted_json",
                 "request_id",
                 "created_at"
               ) VALUES (
                 $1::uuid,
                 $2::uuid,
                 'STAFF',
                 $3::uuid,
                 $4,
                 'CASH_EXPENSE_RECORDED',
                 'CashExpense',
                 $5::uuid,
                 'INFO',
                 NULL,
                 $6::jsonb,
                 $7,
                 $8::timestamptz
               )`,
              [
                auditId,
                principal.centerId,
                principal.staffId,
                principal.role,
                expenseId,
                JSON.stringify({
                  expense_id: expenseId,
                  cash_shift_id: parsed.cashShiftId,
                  category: parsed.category,
                  amount_uzs: formatMoneyUzs(positiveExpenseUzs),
                  payment_method: parsed.paymentMethod,
                  reason_and_doc: parsed.reasonAndDoc,
                  reverses_expense_id: null,
                }),
                requestId,
                nowUtc.toISOString(),
              ],
            );

            this.maybeInjectTestFault('AUDIT_LOG', options?.testFaultAfterStep);
          } else {
            const origRes = await tx.query<{
              id: string;
              cash_shift_id: string;
              category: string;
              amount_uzs: string;
              payment_method: PaymentMethod;
              reverses_expense_id: string | null;
            }>(
              `SELECT "id"::text AS id,
                      "cash_shift_id"::text AS cash_shift_id,
                      "category",
                      "amount_uzs"::text AS amount_uzs,
                      "payment_method"::text AS payment_method,
                      "reverses_expense_id"::text AS reverses_expense_id
                 FROM "cash_expenses"
                WHERE "id" = $1::uuid
                  AND "center_id" = $2::uuid
                LIMIT 1`,
              [parsed.reversesExpenseId, principal.centerId],
            );

            const origExpense = origRes.rows[0];
            if (!origExpense) {
              throw new ApiHttpException({
                statusCode: 404,
                errorCode: 'NOT_FOUND',
                message: 'Original expense to reverse was not found in center scope',
              });
            }

            if (origExpense.reverses_expense_id !== null || BigInt(origExpense.amount_uzs) <= 0n) {
              throw new ApiHttpException({
                statusCode: 422,
                errorCode: 'VALIDATION_ERROR',
                message: 'Cannot reverse an expense reversal record (reverse-of-reversal is forbidden — 11.02)',
              });
            }

            if (origExpense.cash_shift_id !== parsed.cashShiftId) {
              throw new ApiHttpException({
                statusCode: 422,
                errorCode: 'VALIDATION_ERROR',
                message: `Expense ${origExpense.id} belongs to shift ${origExpense.cash_shift_id}, not shift ${parsed.cashShiftId} (11.02)`,
              });
            }

            const existingRevRes = await tx.query<{ id: string }>(
              `SELECT "id"::text AS id
                 FROM "cash_expenses"
                WHERE "center_id" = $1::uuid
                  AND "reverses_expense_id" = $2::uuid
                LIMIT 1`,
              [principal.centerId, origExpense.id],
            );
            if (existingRevRes.rows[0]) {
              throw new ApiHttpException({
                statusCode: 409,
                errorCode: 'VERSION_CONFLICT',
                message: `Expense ${origExpense.id} has already been reversed by ${existingRevRes.rows[0].id} (11.02)`,
              });
            }

            const origPositiveAmountUzs = BigInt(origExpense.amount_uzs);
            const absProvidedUzs =
              parsed.rawSignedAmountUzs < 0n
                ? -parsed.rawSignedAmountUzs
                : parsed.rawSignedAmountUzs;

            if (absProvidedUzs !== origPositiveAmountUzs) {
              throw new ApiHttpException({
                statusCode: 422,
                errorCode: 'VALIDATION_ERROR',
                message: `Expense reversal amount (${formatMoneyUzs(absProvidedUzs)} UZS) must match original expense amount (${formatMoneyUzs(origPositiveAmountUzs)} UZS) (11.02)`,
              });
            }

            if (parsed.paymentMethod !== origExpense.payment_method) {
              throw new ApiHttpException({
                statusCode: 422,
                errorCode: 'VALIDATION_ERROR',
                message: `Expense reversal payment_method (${parsed.paymentMethod}) must match original expense payment_method (${origExpense.payment_method}) (11.02)`,
              });
            }

            const signedReversalDeltaUzs = -origPositiveAmountUzs;

            await tx.query(
              `INSERT INTO "cash_expenses" (
                 "id",
                 "center_id",
                 "cash_shift_id",
                 "category",
                 "amount_uzs",
                 "payment_method",
                 "reason_and_doc",
                 "reverses_expense_id",
                 "recorded_by_staff_id",
                 "created_at"
               ) VALUES (
                 $1::uuid,
                 $2::uuid,
                 $3::uuid,
                 $4,
                 $5::bigint,
                 $6,
                 $7,
                 $8::uuid,
                 $9::uuid,
                 $10::timestamptz
               )`,
              [
                expenseId,
                principal.centerId,
                parsed.cashShiftId,
                origExpense.category,
                formatMoneyUzs(signedReversalDeltaUzs),
                origExpense.payment_method,
                parsed.reasonAndDoc,
                origExpense.id,
                principal.staffId,
                nowUtc.toISOString(),
              ],
            );

            this.maybeInjectTestFault('EXPENSE_INSERT', options?.testFaultAfterStep);

            if (origExpense.payment_method === 'CASH') {
              const newCashExpenses = cashExpensesUzs - origPositiveAmountUzs;
              const newExpectedClosing =
                openingCashUzs + cashReceiptsUzs - cashRefundsUzs - newCashExpenses;
              await executeOptimisticUpdate(tx, {
                tableName: 'cash_shifts',
                entityName: 'CashShift',
                id: shift.id,
                centerId: principal.centerId,
                expectedVersion: Number(shift.version),
                setClauseSql: `"cash_expenses_uzs" = $4::bigint, "expected_closing_cash_uzs" = $5::bigint`,
                additionalValues: [
                  formatMoneyUzs(newCashExpenses),
                  formatMoneyUzs(newExpectedClosing),
                ],
              });
            } else {
              const newNonCashExpenses = nonCashExpensesUzs - origPositiveAmountUzs;
              await executeOptimisticUpdate(tx, {
                tableName: 'cash_shifts',
                entityName: 'CashShift',
                id: shift.id,
                centerId: principal.centerId,
                expectedVersion: Number(shift.version),
                setClauseSql: `"non_cash_expenses_uzs" = $4::bigint`,
                additionalValues: [formatMoneyUzs(newNonCashExpenses)],
              });
            }

            this.maybeInjectTestFault('CASH_SHIFT_UPDATE', options?.testFaultAfterStep);

            const ledgerId = crypto.randomUUID();
            await tx.query(
              `INSERT INTO "ledger_entries" (
                 "id",
                 "center_id",
                 "entry_type",
                 "cash_expense_id",
                 "direction",
                 "amount_uzs",
                 "payment_method",
                 "actor_type",
                 "actor_staff_id",
                 "system_job_name",
                 "created_at"
               ) VALUES (
                 $1::uuid,
                 $2::uuid,
                 'EXPENSE_REVERSED',
                 $3::uuid,
                 'CREDIT',
                 $4::bigint,
                 $5,
                 'STAFF',
                 $6::uuid,
                 NULL,
                 $7::timestamptz
               )`,
              [
                ledgerId,
                principal.centerId,
                expenseId,
                formatMoneyUzs(origPositiveAmountUzs),
                origExpense.payment_method,
                principal.staffId,
                nowUtc.toISOString(),
              ],
            );

            this.maybeInjectTestFault('LEDGER_ENTRY', options?.testFaultAfterStep);

            const auditId = crypto.randomUUID();
            await tx.query(
              `INSERT INTO "audit_logs" (
                 "id",
                 "center_id",
                 "actor_type",
                 "actor_id",
                 "actor_role",
                 "action",
                 "entity_type",
                 "entity_id",
                 "severity",
                 "before_redacted_json",
                 "after_redacted_json",
                 "request_id",
                 "created_at"
               ) VALUES (
                 $1::uuid,
                 $2::uuid,
                 'STAFF',
                 $3::uuid,
                 'DIRECTOR',
                 'CASH_EXPENSE_REVERSED',
                 'CashExpense',
                 $4::uuid,
                 'WARN',
                 $5::jsonb,
                 $6::jsonb,
                 $7,
                 $8::timestamptz
               )`,
              [
                auditId,
                principal.centerId,
                principal.staffId,
                expenseId,
                JSON.stringify({
                  original_expense_id: origExpense.id,
                  original_amount_uzs: formatMoneyUzs(origPositiveAmountUzs),
                  payment_method: origExpense.payment_method,
                }),
                JSON.stringify({
                  reversal_expense_id: expenseId,
                  reverses_expense_id: origExpense.id,
                  cash_shift_id: parsed.cashShiftId,
                  amount_uzs: formatMoneyUzs(signedReversalDeltaUzs),
                  payment_method: origExpense.payment_method,
                  reason_and_doc: parsed.reasonAndDoc,
                }),
                requestId,
                nowUtc.toISOString(),
              ],
            );

            this.maybeInjectTestFault('AUDIT_LOG', options?.testFaultAfterStep);
          }

          const summary = await this.reconciliationService.buildShiftReconciliationDtoInTx(
            tx,
            {
              centerId: principal.centerId,
              shiftId: parsed.cashShiftId,
              lockShiftForUpdate: false,
              strictDriftCheck: true,
              lastRecordedExpenseId: expenseId,
            },
          );

          return {
            statusCode: 201,
            body: summary.dto,
          };
        },
      },
    );

    return idemOutcome.body;
  }

  public async reverseExpenseById(
    req: RequestWithCorrelationId,
    principal: AuthenticatedStaffPrincipal,
    rawExpenseId: unknown,
    rawBody: unknown,
    options?: { readonly testFaultAfterStep?: ExpenseFaultInjectionStep },
  ): Promise<CashShiftReconciliationResponseDto> {
    if (principal.role !== 'DIRECTOR') {
      throw new ApiHttpException({
        statusCode: 403,
        errorCode: 'FORBIDDEN_ROLE',
        message: 'Only DIRECTOR is permitted to reverse a recorded expense (11.02)',
      });
    }

    const expenseId = assertValidUuid(rawExpenseId, 'expense_id');
    const obj = assertPlainObject(rawBody, [
      'cash_shift_id',
      'reason_and_doc',
      'category',
      'amount_uzs',
      'payment_method',
    ]);

    const origRes = await this.databaseService.query<{
      id: string;
      cash_shift_id: string;
      category: string;
      amount_uzs: string;
      payment_method: PaymentMethod;
      reverses_expense_id: string | null;
    }>(
      `SELECT "id"::text AS id,
              "cash_shift_id"::text AS cash_shift_id,
              "category",
              "amount_uzs"::text AS amount_uzs,
              "payment_method"::text AS payment_method,
              "reverses_expense_id"::text AS reverses_expense_id
         FROM "cash_expenses"
        WHERE "id" = $1::uuid
          AND "center_id" = $2::uuid
        LIMIT 1`,
      [expenseId, principal.centerId],
    );

    const orig = origRes.rows[0];
    if (!orig) {
      throw new ApiHttpException({
        statusCode: 404,
        errorCode: 'NOT_FOUND',
        message: 'Original expense not found in center scope',
      });
    }

    if (orig.reverses_expense_id !== null || BigInt(orig.amount_uzs) <= 0n) {
      throw new ApiHttpException({
        statusCode: 422,
        errorCode: 'VALIDATION_ERROR',
        message: 'Cannot reverse an expense reversal record (reverse-of-reversal is forbidden — 11.02)',
      });
    }

    const negAmountStr = `-${BigInt(orig.amount_uzs).toString(10)}`;

    return this.recordCashOrCardExpense(
      req,
      principal,
      {
        cash_shift_id: obj.cash_shift_id ?? orig.cash_shift_id,
        category: obj.category ?? orig.category,
        amount_uzs: obj.amount_uzs ?? negAmountStr,
        payment_method: obj.payment_method ?? orig.payment_method,
        reason_and_doc: obj.reason_and_doc,
        reverses_expense_id: expenseId,
      },
      options,
    );
  }
}
