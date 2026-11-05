/**
 * EduERP v2.0 — Stage 10, Step 10.04 (`T10.04`, `D13`, `OWNER-20261105-05`):
 * Internal Electronic Receipt Generation, Center-Scoped Unique Receipt Numbering,
 * Immutable Snapshot Persistence (`is_fiscal_tax_receipt = false`), and Reversal-Aware Receipt Retrieval.
 */

import { Inject, Injectable } from '@nestjs/common';
import type { PaymentMethod, ReversalOrRefundKind } from '@eduerp/contracts';
import * as crypto from 'node:crypto';
import { ApiHttpException } from '../auth/auth.errors';
import { AuthenticatedStaffPrincipal } from '../auth/permissions.guard';
import { assertValidUuid } from '../auth/validation';
import { DatabaseService } from '../database/database.service';
import { formatMoneyUzs } from '../database/money';
import { TransactionContext } from '../database/transaction';
import { ReceiptResponseDto, ReceiptReversalSummaryDto } from './dto';

function formatPgDate(val: unknown): string | null {
  if (val === null || val === undefined) return null;
  if (val instanceof Date) return val.toISOString().slice(0, 10);
  return String(val).slice(0, 10);
}

/**
 * Pure helper formatting a center-scoped internal receipt number (`RCP-YYYYMM-NNNNNN`).
 */
export function formatInternalReceiptNumber(yearMonthCompact: string, seqNumber: number): string {
  if (!/^\d{6}$/.test(yearMonthCompact)) {
    throw new Error(`Invalid yearMonthCompact '${yearMonthCompact}' for receipt number`);
  }
  if (!Number.isInteger(seqNumber) || seqNumber < 1) {
    throw new Error(`Receipt sequence number must be an integer >= 1 (got ${seqNumber})`);
  }
  return `RCP-${yearMonthCompact}-${String(seqNumber).padStart(6, '0')}`;
}

@Injectable()
export class ReceiptsService {
  constructor(
    @Inject(DatabaseService) private readonly databaseService: DatabaseService,
  ) {}

  /**
   * Issues an immutable internal electronic receipt inside the same database transaction as the payment.
   * Serializes center receipt number allocation via transaction-scoped advisory lock (`pg_advisory_xact_lock`)
   * without issuing `FOR UPDATE` on the append-only `receipts` table (`L45`).
   */
  public async issueReceiptInTx(
    tx: TransactionContext,
    params: {
      readonly centerId: string;
      readonly paymentId: string;
      readonly studentId: string;
      readonly amountUzs: bigint;
      readonly paymentMethod: PaymentMethod;
      readonly remainingDebtSnapshotUzs: bigint;
      readonly nextDueDateSnapshot: string | null;
      readonly paidAtUtc: string;
      readonly recordedAtUtc: string;
      readonly centerTodayDate: string;
    },
  ): Promise<{ readonly receiptId: string; readonly receiptNumber: string }> {
    await tx.query(
      `SELECT pg_advisory_xact_lock(hashtext($1), hashtext('S10_CENTER_RECEIPT_NUMBER_SEQ'))`,
      [params.centerId],
    );

    const ymCompact = params.centerTodayDate.slice(0, 7).replace('-', '');
    const prefix = `RCP-${ymCompact}-`;

    const maxSeqRes = await tx.query<{ max_seq: string | null }>(
      `SELECT MAX(CAST(SUBSTRING("receipt_number" FROM 12) AS INTEGER))::text AS max_seq
         FROM "receipts"
        WHERE "center_id" = $1::uuid
          AND "receipt_number" LIKE $2`,
      [params.centerId, `${prefix}%`],
    );

    const currentMax = Number(maxSeqRes.rows[0]?.max_seq ?? '0');
    const nextSeq = (Number.isFinite(currentMax) && currentMax >= 0 ? currentMax : 0) + 1;
    const receiptNumber = formatInternalReceiptNumber(ymCompact, nextSeq);
    const receiptId = crypto.randomUUID();

    await tx.query(
      `INSERT INTO "receipts" (
         "id",
         "center_id",
         "receipt_number",
         "payment_id",
         "student_id",
         "amount_uzs",
         "currency",
         "payment_method",
         "remaining_debt_snapshot_uzs",
         "next_due_date_snapshot",
         "is_fiscal_tax_receipt",
         "paid_at_snapshot",
         "recorded_at_snapshot",
         "issued_at"
       ) VALUES (
         $1::uuid,
         $2::uuid,
         $3,
         $4::uuid,
         $5::uuid,
         $6::bigint,
         'UZS',
         $7,
         $8::bigint,
         $9::date,
         FALSE,
         $10::timestamptz,
         $11::timestamptz,
         $11::timestamptz
       )`,
      [
        receiptId,
        params.centerId,
        receiptNumber,
        params.paymentId,
        params.studentId,
        formatMoneyUzs(params.amountUzs),
        params.paymentMethod,
        formatMoneyUzs(params.remainingDebtSnapshotUzs),
        params.nextDueDateSnapshot,
        params.paidAtUtc,
        params.recordedAtUtc,
      ],
    );

    return Object.freeze({
      receiptId,
      receiptNumber,
    });
  }

  /**
   * Retrieves an internal electronic receipt (`GET /api/v1/receipts/{receipt_id}` — `10.04`).
   * Strictly enforces center isolation and role guard (`DIRECTOR` / `ADMIN` only; `TEACHER` denied).
   * Includes linked append-only reversal history while preserving the original receipt snapshot untouched.
   */
  public async getPaymentReceipt(
    principal: AuthenticatedStaffPrincipal,
    rawReceiptId: unknown,
    studentIdFilter?: unknown,
  ): Promise<ReceiptResponseDto> {
    if (principal.role !== 'DIRECTOR' && principal.role !== 'ADMIN') {
      throw new ApiHttpException({
        statusCode: 403,
        errorCode: 'FORBIDDEN_ROLE',
        message: 'Only DIRECTOR and ADMIN are permitted to view payment receipts (T10.04)',
      });
    }

    const receiptId = assertValidUuid(rawReceiptId, 'receipt_id');
    const expectedStudentId =
      studentIdFilter !== undefined && studentIdFilter !== null
        ? assertValidUuid(studentIdFilter, 'student_id')
        : null;

    const receiptRes = await this.databaseService.query<{
      id: string;
      center_id: string;
      receipt_number: string;
      payment_id: string;
      student_id: string;
      amount_uzs: string;
      payment_method: PaymentMethod;
      remaining_debt_snapshot_uzs: string;
      next_due_date_snapshot: unknown;
      is_fiscal_tax_receipt: boolean;
      paid_at_snapshot: Date;
      recorded_at_snapshot: Date;
      issued_at: Date;
    }>(
      `SELECT r."id"::text AS id,
              r."center_id"::text AS center_id,
              r."receipt_number",
              r."payment_id"::text AS payment_id,
              r."student_id"::text AS student_id,
              r."amount_uzs"::text AS amount_uzs,
              r."payment_method"::text AS payment_method,
              r."remaining_debt_snapshot_uzs"::text AS remaining_debt_snapshot_uzs,
              r."next_due_date_snapshot"::text AS next_due_date_snapshot,
              r."is_fiscal_tax_receipt",
              r."paid_at_snapshot",
              r."recorded_at_snapshot",
              r."issued_at"
         FROM "receipts" r
        WHERE r."id" = $1::uuid
          AND r."center_id" = $2::uuid
        LIMIT 1`,
      [receiptId, principal.centerId],
    );

    const row = receiptRes.rows[0];
    if (!row) {
      throw new ApiHttpException({
        statusCode: 404,
        errorCode: 'NOT_FOUND',
        message: 'Receipt not found in center scope',
      });
    }

    if (expectedStudentId !== null && row.student_id !== expectedStudentId) {
      throw new ApiHttpException({
        statusCode: 403,
        errorCode: 'FORBIDDEN_OBJECT_SCOPE',
        message: 'Receipt does not belong to the specified student (T10.04)',
      });
    }

    const execRes = await this.databaseService.query<{
      id: string;
      request_id: string;
      kind: ReversalOrRefundKind;
      amount_uzs: string;
      refund_method: PaymentMethod;
      executed_at: Date;
    }>(
      `SELECT "id"::text AS id,
              "request_id"::text AS request_id,
              "kind"::text AS kind,
              "amount_uzs"::text AS amount_uzs,
              "refund_method"::text AS refund_method,
              "executed_at"
         FROM "reversal_or_refund_executions"
        WHERE "center_id" = $1::uuid
          AND "original_payment_id" = $2::uuid
        ORDER BY "executed_at" ASC, "id" ASC`,
      [principal.centerId, row.payment_id],
    );

    const pendingReqRes = await this.databaseService.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt
         FROM "reversal_or_refund_requests"
        WHERE "center_id" = $1::uuid
          AND "original_payment_id" = $2::uuid
          AND "status" = 'PENDING_DIRECTOR_APPROVAL'`,
      [principal.centerId, row.payment_id],
    );

    const originalAmountUzs = BigInt(row.amount_uzs);
    let reversedTotalUzs = 0n;
    const reversals: ReceiptReversalSummaryDto[] = [];

    for (const ex of execRes.rows) {
      const revAmt = BigInt(ex.amount_uzs);
      reversedTotalUzs += revAmt;
      reversals.push(
        Object.freeze({
          execution_id: ex.id,
          request_id: ex.request_id,
          kind: ex.kind,
          reversed_amount_uzs: formatMoneyUzs(revAmt),
          refund_method: ex.refund_method,
          executed_at: new Date(ex.executed_at).toISOString(),
        }),
      );
    }

    const netEffectivePaymentUzs =
      originalAmountUzs > reversedTotalUzs ? originalAmountUzs - reversedTotalUzs : 0n;
    const hasPending = Number(pendingReqRes.rows[0]?.cnt ?? '0') > 0;

    let reversalStatus: ReceiptResponseDto['reversal_status'] = 'NONE';
    if (reversedTotalUzs >= originalAmountUzs && originalAmountUzs > 0n) {
      reversalStatus = 'FULLY_REVERSED';
    } else if (reversedTotalUzs > 0n) {
      reversalStatus = 'PARTIALLY_REVERSED';
    } else if (hasPending) {
      reversalStatus = 'PENDING_REVERSAL';
    }

    return Object.freeze({
      id: row.id,
      receipt_number: row.receipt_number,
      payment_id: row.payment_id,
      student_id: row.student_id,
      amount_uzs: formatMoneyUzs(originalAmountUzs),
      currency: 'UZS',
      payment_method: row.payment_method,
      paid_at_utc: new Date(row.paid_at_snapshot).toISOString(),
      recorded_at_utc: new Date(row.recorded_at_snapshot).toISOString(),
      remaining_debt_snapshot_uzs: BigInt(row.remaining_debt_snapshot_uzs).toString(10),
      next_due_date_snapshot: formatPgDate(row.next_due_date_snapshot),
      is_fiscal_tax_receipt: false,
      issued_at: new Date(row.issued_at).toISOString(),
      reversed_total_uzs: formatMoneyUzs(reversedTotalUzs),
      net_effective_payment_uzs: formatMoneyUzs(netEffectivePaymentUzs),
      reversal_status: reversalStatus,
      reversals: Object.freeze(reversals),
    });
  }
}
