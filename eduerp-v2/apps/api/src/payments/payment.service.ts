/**
 * EduERP v2.0 — Stage 10, Step 10.01 (`T10.01`, `OWNER-20261105-05`):
 * Manual External Payment Recording (`CASH`, `CARD`, `CLICK`, `PAYME`, `TRANSFER`),
 * S11 Open Cash Shift Guard Seam, Late Entry Dual-Timestamp (`paid_at` vs `recorded_at`) Audit,
 * Scoped External Reference Uniqueness, and Atomic Payment + Allocation + Promise + CashShift + Ledger + Receipt + Outbox Execution.
 */

import { Inject, Injectable } from '@nestjs/common';
import type { CashShiftStatus, PaymentSourceChannel } from '@eduerp/contracts';
import * as crypto from 'node:crypto';
import { ApiHttpException } from '../auth/auth.errors';
import { ClockService } from '../auth/clock.service';
import { AuthenticatedStaffPrincipal } from '../auth/permissions.guard';
import { formatCenterLocalDate } from '../auth/staff.service';
import { requireIdempotencyKeyHeader } from '../auth/validation';
import { RequestWithCorrelationId, resolveRequestId } from '../common/request-id.middleware';
import { ApiEnvConfig } from '../config/env';
import { API_CONFIG_TOKEN } from '../config/tokens';
import { DatabaseService } from '../database/database.service';
import {
  computeCanonicalPayloadHash,
  executeIdempotentOperation,
} from '../database/idempotency';
import { formatMoneyUzs } from '../database/money';
import { executeOptimisticUpdate, TransactionContext } from '../database/transaction';
import { AllocationService } from './allocation.service';
import {
  PaymentFaultInjectionStep,
  PaymentRecordedResponseDto,
  validateRecordPaymentInput,
} from './dto';
import { ReceiptsService } from './receipts.service';

@Injectable()
export class PaymentService {
  constructor(
    @Inject(API_CONFIG_TOKEN) private readonly config: ApiEnvConfig,
    @Inject(DatabaseService) private readonly databaseService: DatabaseService,
    @Inject(ClockService) private readonly clock: ClockService,
    @Inject(AllocationService) private readonly allocationService: AllocationService,
    @Inject(ReceiptsService) private readonly receiptsService: ReceiptsService,
  ) {}

  private maybeInjectTestFault(
    targetStep: PaymentFaultInjectionStep,
    configuredFault?: PaymentFaultInjectionStep,
  ): void {
    if (this.config.nodeEnv === 'test' && configuredFault === targetStep) {
      throw new Error(`SIMULATED_S10_PAYMENT_FAULT_AFTER_${targetStep}`);
    }
  }

  /**
   * Records a manual external payment (`POST /api/v1/payments` — `10.01`, `10.02`, `10.04`, `OWNER-20261105-05`).
   */
  public async recordPaymentWithRequiredPromise(
    req: RequestWithCorrelationId,
    principal: AuthenticatedStaffPrincipal,
    rawBody: unknown,
    options?: { readonly testFaultAfterStep?: PaymentFaultInjectionStep },
  ): Promise<PaymentRecordedResponseDto> {
    if (principal.role !== 'DIRECTOR' && principal.role !== 'ADMIN') {
      throw new ApiHttpException({
        statusCode: 403,
        errorCode: 'FORBIDDEN_ROLE',
        message: 'Only DIRECTOR and ADMIN are permitted to record payments (T10.01)',
      });
    }

    const idempotencyKey = requireIdempotencyKeyHeader(req);
    const requestId = req.requestId ?? resolveRequestId(req.headers['x-request-id']);
    const nowUtc = this.clock.now();
    const centerTodayDate = formatCenterLocalDate(nowUtc, this.config.centerTimezone);

    const parsed = validateRecordPaymentInput(rawBody, nowUtc, centerTodayDate);

    // Note: Do not include server-generated `recordedAtUtc` (or default `paidAtUtc`) in the idempotency
    // request hash when the caller omitted `paid_at`, so retries with the same key and body across ticks
    // match the canonical request digest!
    const rawBodyObj = rawBody as Record<string, unknown>;
    const callerProvidedPaidAt =
      rawBodyObj.paid_at !== undefined && rawBodyObj.paid_at !== null
        ? parsed.paidAtUtc
        : null;

    const canonicalIdempotencyPayload = {
      student_id: parsed.studentId,
      cash_shift_id: parsed.cashShiftId,
      amount_uzs: formatMoneyUzs(parsed.amountUzs),
      currency: parsed.currency,
      payment_method: parsed.paymentMethod,
      target_invoice_ids: parsed.targetInvoiceIds,
      allocations: parsed.explicitAllocations
        ? parsed.explicitAllocations.map((a) => ({
            invoice_id: a.invoiceId,
            allocated_amount_uzs: formatMoneyUzs(a.allocatedAmountUzs),
          }))
        : null,
      promise_date: parsed.promiseDate,
      paid_at: callerProvidedPaidAt,
      external_reference: parsed.externalReference,
      payment_note: parsed.paymentNote,
    };

    const requestHash = computeCanonicalPayloadHash(canonicalIdempotencyPayload);

    const idemOutcome = await executeIdempotentOperation<PaymentRecordedResponseDto>(
      this.databaseService,
      {
        centerId: principal.centerId,
        actorStaffId: principal.staffId,
        operationType: 'RECORD_PAYMENT_WITH_REQUIRED_PROMISE',
        idempotencyKey,
        requestPayload: canonicalIdempotencyPayload,
        authorizeBeforeReplayOrExecute: async (tx: TransactionContext) => {
          // 1. Live staff status & role check before returning cached replay (I03 / L23)
          const staffRes = await tx.query<{
            role: string;
            status: string;
          }>(
            `SELECT "role"::text AS role,
                    "status"::text AS status
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
              message: 'Only DIRECTOR and ADMIN are permitted to record payments',
            });
          }

          // 2. Lock mutable Student row FOR UPDATE (verifies center lineage and serializes student balance updates)
          const studentRes = await tx.query<{ id: string }>(
            `SELECT "id"::text AS id
               FROM "students"
              WHERE "id" = $1::uuid
                AND "center_id" = $2::uuid
              FOR UPDATE`,
            [parsed.studentId, principal.centerId],
          );
          if (!studentRes.rows[0]) {
            throw new ApiHttpException({
              statusCode: 404,
              errorCode: 'NOT_FOUND',
              message: 'Student not found in center scope',
            });
          }

          // 3. S11 Cash Shift Guard Seam: verify shift exists in center (status checked in handler for fresh executions)
          const shiftCheckRes = await tx.query<{
            id: string;
            status: CashShiftStatus;
          }>(
            `SELECT "id"::text AS id,
                    "status"::text AS status
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

          // 4. Verify any explicitly requested invoices belong to center and student
          const reqInvIds =
            parsed.explicitAllocations !== null
              ? parsed.explicitAllocations.map((a) => a.invoiceId)
              : parsed.targetInvoiceIds !== null
                ? [...parsed.targetInvoiceIds]
                : [];
          if (reqInvIds.length > 0) {
            const invRes = await tx.query<{ id: string; student_id: string }>(
              `SELECT "id"::text AS id,
                      "student_id"::text AS student_id
                 FROM "invoices"
                WHERE "center_id" = $1::uuid
                  AND "id" = ANY($2::uuid[])`,
              [principal.centerId, reqInvIds],
            );
            const map = new Map(invRes.rows.map((r) => [r.id, r.student_id]));
            for (const invId of reqInvIds) {
              const ownerStudentId = map.get(invId);
              if (!ownerStudentId) {
                throw new ApiHttpException({
                  statusCode: 404,
                  errorCode: 'NOT_FOUND',
                  message: `Target invoice ${invId} not found in center scope`,
                });
              }
              if (ownerStudentId !== parsed.studentId) {
                throw new ApiHttpException({
                  statusCode: 403,
                  errorCode: 'FORBIDDEN_OBJECT_SCOPE',
                  message: `Target invoice ${invId} belongs to another student`,
                });
              }
            }
          }
        },
        handler: async (tx: TransactionContext) => {
          // 1. Lock the mutable CashShift row FOR UPDATE and enforce status === 'OPEN'
          const shiftRes = await tx.query<{
            id: string;
            status: CashShiftStatus;
            opening_cash_uzs: string;
            cash_receipts_uzs: string;
            non_cash_receipts_uzs: string;
            cash_refunds_uzs: string;
            non_cash_refunds_uzs: string;
            cash_expenses_uzs: string;
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
              message: `Cannot record payment into a CLOSED cash shift (${parsed.cashShiftId}); open an active shift first (10.01 / T11.01)`,
            });
          }

          // 2. If external_reference is provided, enforce center + method uniqueness
          if (parsed.externalReference !== null) {
            await tx.query(
              `SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`,
              [
                principal.centerId,
                `EXT_REF:${parsed.paymentMethod}:${parsed.externalReference}`,
              ],
            );
            const dupRefRes = await tx.query<{ id: string }>(
              `SELECT "id"::text AS id
                 FROM "payments"
                WHERE "center_id" = $1::uuid
                  AND "payment_method" = $2
                  AND "external_reference" = $3
                LIMIT 1`,
              [principal.centerId, parsed.paymentMethod, parsed.externalReference],
            );
            if (dupRefRes.rows[0]) {
              throw new ApiHttpException({
                statusCode: 409,
                errorCode: 'VERSION_CONFLICT',
                message: `External reference '${parsed.externalReference}' for payment method ${parsed.paymentMethod} has already been recorded in this center`,
              });
            }
          }

          const paymentId = crypto.randomUUID();
          const sourceChannel: PaymentSourceChannel =
            principal.role === 'DIRECTOR'
              ? 'DIRECTOR_MANUAL_ENTRY'
              : 'ADMIN_MANUAL_ENTRY';

          // 3. Insert append-only Payment row
          await tx.query(
            `INSERT INTO "payments" (
               "id",
               "center_id",
               "student_id",
               "cash_shift_id",
               "amount_uzs",
               "currency",
               "payment_method",
               "paid_at",
               "recorded_at",
               "external_reference",
               "payment_note",
               "source_channel",
               "recorded_by_admin_id",
               "idempotency_key",
               "request_hash",
               "created_at"
             ) VALUES (
               $1::uuid,
               $2::uuid,
               $3::uuid,
               $4::uuid,
               $5::bigint,
               'UZS',
               $6,
               $7::timestamptz,
               $8::timestamptz,
               $9,
               $10,
               $11,
               $12::uuid,
               $13,
               $14,
               $8::timestamptz
             )`,
            [
              paymentId,
              principal.centerId,
              parsed.studentId,
              parsed.cashShiftId,
              formatMoneyUzs(parsed.amountUzs),
              parsed.paymentMethod,
              parsed.paidAtUtc,
              parsed.recordedAtUtc,
              parsed.externalReference,
              parsed.paymentNote,
              sourceChannel,
              principal.staffId,
              idempotencyKey,
              requestHash,
            ],
          );

          this.maybeInjectTestFault('PAYMENT_INSERT', options?.testFaultAfterStep);

          // 4. Apply allocations, update invoices, create unapplied credit, and enforce/create PromiseToPay
          const allocOutcome =
            await this.allocationService.applyPaymentAllocationsAndPromisesInTx(tx, {
              centerId: principal.centerId,
              studentId: parsed.studentId,
              paymentId,
              paymentAmountUzs: parsed.amountUzs,
              targetInvoiceIds: parsed.targetInvoiceIds,
              explicitAllocations: parsed.explicitAllocations,
              promiseDate: parsed.promiseDate,
              centerTodayDate,
              nowUtc,
            });

          this.maybeInjectTestFault('ALLOCATION_APPLY', options?.testFaultAfterStep);

          // 5. Update CashShift drawer/non-cash totals
          const openingCash = BigInt(shift.opening_cash_uzs);
          const cashReceipts = BigInt(shift.cash_receipts_uzs);
          const nonCashReceipts = BigInt(shift.non_cash_receipts_uzs);
          const cashRefunds = BigInt(shift.cash_refunds_uzs);
          const cashExpenses = BigInt(shift.cash_expenses_uzs);

          if (parsed.paymentMethod === 'CASH') {
            const newCashReceipts = cashReceipts + parsed.amountUzs;
            const newExpectedClosing =
              openingCash + newCashReceipts - cashRefunds - cashExpenses;
            await executeOptimisticUpdate(tx, {
              tableName: 'cash_shifts',
              entityName: 'CashShift',
              id: shift.id,
              centerId: principal.centerId,
              expectedVersion: Number(shift.version),
              setClauseSql: `"cash_receipts_uzs" = $4::bigint, "expected_closing_cash_uzs" = $5::bigint`,
              additionalValues: [
                formatMoneyUzs(newCashReceipts),
                formatMoneyUzs(newExpectedClosing),
              ],
            });
          } else {
            const newNonCashReceipts = nonCashReceipts + parsed.amountUzs;
            await executeOptimisticUpdate(tx, {
              tableName: 'cash_shifts',
              entityName: 'CashShift',
              id: shift.id,
              centerId: principal.centerId,
              expectedVersion: Number(shift.version),
              setClauseSql: `"non_cash_receipts_uzs" = $4::bigint`,
              additionalValues: [formatMoneyUzs(newNonCashReceipts)],
            });
          }

          this.maybeInjectTestFault('CASH_SHIFT_UPDATE', options?.testFaultAfterStep);

          // 6. Insert append-only LedgerEntry (PAYMENT_RECEIVED, CREDIT)
          const ledgerEntryId = crypto.randomUUID();
          const singleInvoiceId =
            allocOutcome.allocations.length === 1
              ? allocOutcome.allocations[0].invoice_id
              : null;

          await tx.query(
            `INSERT INTO "ledger_entries" (
               "id",
               "center_id",
               "entry_type",
               "student_id",
               "invoice_id",
               "payment_id",
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
               'PAYMENT_RECEIVED',
               $3::uuid,
               $4::uuid,
               $5::uuid,
               'CREDIT',
               $6::bigint,
               $7,
               'STAFF',
               $8::uuid,
               NULL,
               $9::timestamptz
             )`,
            [
              ledgerEntryId,
              principal.centerId,
              parsed.studentId,
              singleInvoiceId,
              paymentId,
              formatMoneyUzs(parsed.amountUzs),
              parsed.paymentMethod,
              principal.staffId,
              parsed.recordedAtUtc,
            ],
          );

          this.maybeInjectTestFault('LEDGER_ENTRY', options?.testFaultAfterStep);

          // 7. Issue internal electronic receipt (is_fiscal_tax_receipt = FALSE)
          const receiptOutcome = await this.receiptsService.issueReceiptInTx(tx, {
            centerId: principal.centerId,
            paymentId,
            studentId: parsed.studentId,
            amountUzs: parsed.amountUzs,
            paymentMethod: parsed.paymentMethod,
            remainingDebtSnapshotUzs: allocOutcome.totalStudentRemainingDebtUzs,
            nextDueDateSnapshot: allocOutcome.nextDueDateSnapshot,
            paidAtUtc: parsed.paidAtUtc,
            recordedAtUtc: parsed.recordedAtUtc,
            centerTodayDate,
          });

          this.maybeInjectTestFault('RECEIPT_INSERT', options?.testFaultAfterStep);

          // 8. Insert AuditLog (redacted, zero raw phone/secrets; marks WARN if late entry paid_at < recorded_at)
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
               'PAYMENT_RECORDED',
               'Payment',
               $5::uuid,
               $6,
               NULL,
               $7::jsonb,
               $8,
               $9::timestamptz
             )`,
            [
              auditId,
              principal.centerId,
              principal.staffId,
              principal.role,
              paymentId,
              parsed.isLateEntry ? 'WARN' : 'INFO',
              JSON.stringify({
                payment_id: paymentId,
                receipt_id: receiptOutcome.receiptId,
                receipt_number: receiptOutcome.receiptNumber,
                student_id: parsed.studentId,
                cash_shift_id: parsed.cashShiftId,
                amount_uzs: formatMoneyUzs(parsed.amountUzs),
                currency: 'UZS',
                payment_method: parsed.paymentMethod,
                paid_at_utc: parsed.paidAtUtc,
                recorded_at_utc: parsed.recordedAtUtc,
                late_entry: parsed.isLateEntry,
                external_reference: parsed.externalReference,
                payment_note: parsed.paymentNote,
                source_channel: sourceChannel,
                allocated_total_uzs: formatMoneyUzs(allocOutcome.allocatedTotalUzs),
                unapplied_credit_uzs: formatMoneyUzs(allocOutcome.unappliedCreditUzs),
                remaining_debt_uzs: formatMoneyUzs(allocOutcome.totalStudentRemainingDebtUzs),
                promise_id: allocOutcome.primaryPromiseId,
                promise_date: allocOutcome.promiseDate,
              }),
              requestId,
              parsed.recordedAtUtc,
            ],
          );

          this.maybeInjectTestFault('AUDIT_LOG', options?.testFaultAfterStep);

          // 9. Insert OutboxEvent (PaymentRecorded v1)
          const outboxId = crypto.randomUUID();
          const outboxPayload = {
            payment_id: paymentId,
            receipt_id: receiptOutcome.receiptId,
            receipt_number: receiptOutcome.receiptNumber,
            student_id: parsed.studentId,
            amount_uzs: formatMoneyUzs(parsed.amountUzs),
            currency: 'UZS',
            payment_method: parsed.paymentMethod,
            allocated_total_uzs: formatMoneyUzs(allocOutcome.allocatedTotalUzs),
            unapplied_credit_uzs: formatMoneyUzs(allocOutcome.unappliedCreditUzs),
            remaining_debt_uzs: formatMoneyUzs(allocOutcome.totalStudentRemainingDebtUzs),
            promise_id: allocOutcome.primaryPromiseId,
            promise_date: allocOutcome.promiseDate,
          };

          await tx.query(
            `INSERT INTO "outbox_events" (
               "id",
               "center_id",
               "event_name",
               "schema_version",
               "aggregate_type",
               "aggregate_id",
               "aggregate_version",
               "dedup_key",
               "payload_json",
               "status",
               "lease_token",
               "occurred_at_utc",
               "next_attempt_at",
               "updated_at"
             ) VALUES (
               $1::uuid,
               $2::uuid,
               'PaymentRecorded',
               1,
               'Payment',
               $3::uuid,
               1,
               $4,
               $5::jsonb,
               'PENDING',
               0,
               $6::timestamptz,
               $6::timestamptz,
               $6::timestamptz
             )`,
            [
              outboxId,
              principal.centerId,
              paymentId,
              `PaymentRecorded:${paymentId}`,
              JSON.stringify(outboxPayload),
              parsed.recordedAtUtc,
            ],
          );

          this.maybeInjectTestFault('OUTBOX_EVENT', options?.testFaultAfterStep);

          const responseDto: PaymentRecordedResponseDto = Object.freeze({
            payment_id: paymentId,
            receipt_id: receiptOutcome.receiptId,
            receipt_number: receiptOutcome.receiptNumber,
            student_id: parsed.studentId,
            cash_shift_id: parsed.cashShiftId,
            amount_uzs: formatMoneyUzs(parsed.amountUzs),
            currency: 'UZS',
            payment_method: parsed.paymentMethod,
            paid_at_utc: parsed.paidAtUtc,
            recorded_at_utc: parsed.recordedAtUtc,
            late_entry: parsed.isLateEntry,
            external_reference: parsed.externalReference,
            payment_note: parsed.paymentNote,
            source_channel: sourceChannel,
            allocated_total_uzs: formatMoneyUzs(allocOutcome.allocatedTotalUzs),
            unapplied_credit_uzs: formatMoneyUzs(allocOutcome.unappliedCreditUzs),
            unapplied_credit_id: allocOutcome.unappliedCreditId,
            remaining_debt_uzs: formatMoneyUzs(allocOutcome.totalStudentRemainingDebtUzs),
            promise_id: allocOutcome.primaryPromiseId,
            promise_date: allocOutcome.promiseDate,
            allocations: allocOutcome.allocations,
            is_fiscal_tax_receipt: false,
          });

          return {
            statusCode: 201,
            body: responseDto,
          };
        },
      },
    );

    return idemOutcome.body;
  }
}
