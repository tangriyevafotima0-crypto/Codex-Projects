/**
 * EduERP v2.0 — Stage 10, Step 10.02 (`T10.02`, `BR-05`, `BR-06`, `B03`, `CASE-11`, `CASE-12`, `CASE-22`):
 * Partial, Full, Overpaid (`UnappliedCredit`), and Multi-Invoice Payment Allocation,
 * Canonical Ledger/Allocation Debt Projection, Mandatory `PromiseToPay` Seam,
 * and Automatic Early-Fulfillment of Open Promises When Debt Reaches Zero.
 */

import { Injectable } from '@nestjs/common';
import type { InvoiceStatus } from '@eduerp/contracts';
import * as crypto from 'node:crypto';
import { ApiHttpException } from '../auth/auth.errors';
import {
  formatMoneyUzs,
  parseNonNegativeMoneyUzs,
  parsePositiveMoneyUzs,
} from '../database/money';
import { executeOptimisticUpdate, TransactionContext } from '../database/transaction';
import { validateIsoDate } from '../students/normalization';
import { ExplicitInvoiceAllocationInput, PaymentAllocationItemDto } from './dto';

export interface AllocationTargetInvoiceSnapshot {
  readonly id: string;
  readonly studentId: string;
  readonly enrollmentId: string;
  readonly effectiveNetChargeUzs: bigint;
  readonly allocatedPaidUzs: bigint;
  readonly remainingDebtUzs: bigint;
  readonly status: InvoiceStatus;
  readonly dueDate: string;
  readonly version: number;
}

export interface PlannedInvoiceAllocation {
  readonly invoiceId: string;
  readonly enrollmentId: string;
  readonly allocatedAmountUzs: bigint;
  readonly previousAllocatedPaidUzs: bigint;
  readonly newAllocatedPaidUzs: bigint;
  readonly previousRemainingDebtUzs: bigint;
  readonly newRemainingDebtUzs: bigint;
  readonly newStatus: InvoiceStatus;
  readonly expectedVersion: number;
}

export interface PaymentAllocationPlanResult {
  readonly paymentAmountUzs: bigint;
  readonly allocatedTotalUzs: bigint;
  readonly unappliedCreditUzs: bigint;
  readonly targetedRemainingDebtUzs: bigint;
  readonly totalStudentRemainingDebtUzs: bigint;
  readonly requiresPromiseToPay: boolean;
  readonly promiseDate: string | null;
  readonly plannedAllocations: readonly PlannedInvoiceAllocation[];
}

export interface AppliedAllocationsAndPromisesResult {
  readonly allocatedTotalUzs: bigint;
  readonly unappliedCreditUzs: bigint;
  readonly unappliedCreditId: string | null;
  readonly totalStudentRemainingDebtUzs: bigint;
  readonly nextDueDateSnapshot: string | null;
  readonly primaryPromiseId: string | null;
  readonly promiseDate: string | null;
  readonly allocations: readonly PaymentAllocationItemDto[];
}

function formatPgDate(val: unknown): string {
  if (val instanceof Date) return val.toISOString().slice(0, 10);
  return String(val).slice(0, 10);
}

/**
 * Pure deterministic calculator for Stage 10 (`10.02`, `BR-05`, `BR-06`, `CASE-11`, `CASE-12`) payment allocations:
 * - `500,000` invoice + `300,000` payment -> `300,000` allocation, `200,000` remaining debt (`PARTIALLY_PAID`), requires `promise_date`.
 * - `500,000` invoice + `600,000` payment -> `500,000` allocation, `0` remaining debt (`PAID`), `100,000` `unappliedCreditUzs`.
 * - Multi-invoice: supports ordered greedy allocation or explicit per-invoice `explicitAllocations`.
 * - Never allows total allocations > `paymentAmountUzs` or per-invoice allocation > `invoice.remainingDebtUzs`.
 * - Never leaves unapplied cash when a targeted invoice still has unpaid remaining debt.
 */
export function planPaymentAllocations(params: {
  readonly studentId: string;
  readonly paymentAmountUzs: bigint | string;
  readonly targetInvoicesInOrder: readonly AllocationTargetInvoiceSnapshot[];
  readonly explicitAllocations?: readonly ExplicitInvoiceAllocationInput[] | null;
  readonly otherOpenStudentDebtUzs?: bigint | string;
  readonly promiseDate: string | null;
  readonly centerTodayDate: string;
}): PaymentAllocationPlanResult {
  const paymentAmountUzs = parsePositiveMoneyUzs(params.paymentAmountUzs, 'paymentAmountUzs');
  const otherOpenDebtUzs = parseNonNegativeMoneyUzs(
    params.otherOpenStudentDebtUzs ?? 0n,
    'otherOpenStudentDebtUzs',
  );
  const cleanToday = validateIsoDate(params.centerTodayDate, 'centerTodayDate');

  let cleanPromiseDate: string | null = null;
  if (params.promiseDate !== null && params.promiseDate !== undefined) {
    cleanPromiseDate = validateIsoDate(params.promiseDate, 'promise_date');
    if (cleanPromiseDate < cleanToday) {
      throw new ApiHttpException({
        statusCode: 422,
        errorCode: 'VALIDATION_ERROR',
        message: `promise_date (${cleanPromiseDate}) cannot be earlier than center current date (${cleanToday})`,
      });
    }
  }

  for (const inv of params.targetInvoicesInOrder) {
    if (inv.studentId !== params.studentId) {
      throw new ApiHttpException({
        statusCode: 403,
        errorCode: 'FORBIDDEN_OBJECT_SCOPE',
        message: `Cannot allocate payment for student ${params.studentId} to invoice ${inv.id} belonging to another student`,
      });
    }
    if (inv.status === 'VOID_COMPENSATED' || inv.status === 'GRANT_ZERO') {
      throw new ApiHttpException({
        statusCode: 422,
        errorCode: 'VALIDATION_ERROR',
        message: `Cannot allocate payment to invoice ${inv.id} with status ${inv.status}`,
      });
    }
  }

  const plannedAllocations: PlannedInvoiceAllocation[] = [];
  let allocatedTotalUzs = 0n;
  let targetedRemainingDebtUzs = 0n;

  if (params.explicitAllocations && params.explicitAllocations.length > 0) {
    const invoiceById = new Map<string, AllocationTargetInvoiceSnapshot>(
      params.targetInvoicesInOrder.map((inv) => [inv.id, inv]),
    );

    let sumExplicit = 0n;
    for (const exp of params.explicitAllocations) {
      const inv = invoiceById.get(exp.invoiceId);
      if (!inv) {
        throw new ApiHttpException({
          statusCode: 404,
          errorCode: 'NOT_FOUND',
          message: `Target invoice ${exp.invoiceId} not found in center scope`,
        });
      }
      if (exp.allocatedAmountUzs <= 0n) {
        throw new ApiHttpException({
          statusCode: 422,
          errorCode: 'VALIDATION_ERROR',
          message: `Allocated amount for invoice ${inv.id} must be > 0`,
        });
      }
      if (exp.allocatedAmountUzs > inv.remainingDebtUzs) {
        throw new ApiHttpException({
          statusCode: 422,
          errorCode: 'VALIDATION_ERROR',
          message: `Explicit allocation (${formatMoneyUzs(exp.allocatedAmountUzs)} UZS) exceeds invoice ${inv.id} remaining debt (${formatMoneyUzs(inv.remainingDebtUzs)} UZS)`,
        });
      }
      sumExplicit += exp.allocatedAmountUzs;
      const newAllocatedPaidUzs = inv.allocatedPaidUzs + exp.allocatedAmountUzs;
      const newRemainingDebtUzs = inv.effectiveNetChargeUzs - newAllocatedPaidUzs;
      const newStatus: InvoiceStatus = newRemainingDebtUzs === 0n ? 'PAID' : 'PARTIALLY_PAID';

      plannedAllocations.push(
        Object.freeze({
          invoiceId: inv.id,
          enrollmentId: inv.enrollmentId,
          allocatedAmountUzs: exp.allocatedAmountUzs,
          previousAllocatedPaidUzs: inv.allocatedPaidUzs,
          newAllocatedPaidUzs,
          previousRemainingDebtUzs: inv.remainingDebtUzs,
          newRemainingDebtUzs,
          newStatus,
          expectedVersion: inv.version,
        }),
      );
      allocatedTotalUzs += exp.allocatedAmountUzs;
      targetedRemainingDebtUzs += newRemainingDebtUzs;
    }

    if (sumExplicit > paymentAmountUzs) {
      throw new ApiHttpException({
        statusCode: 422,
        errorCode: 'VALIDATION_ERROR',
        message: `Sum of explicit allocations (${formatMoneyUzs(sumExplicit)} UZS) exceeds payment amount (${formatMoneyUzs(paymentAmountUzs)} UZS)`,
      });
    }

    if (sumExplicit < paymentAmountUzs && targetedRemainingDebtUzs > 0n) {
      throw new ApiHttpException({
        statusCode: 422,
        errorCode: 'VALIDATION_ERROR',
        message:
          'Cannot leave unapplied credit while a targeted invoice still has unpaid remaining debt (T10.02)',
      });
    }
  } else {
    let remainingToAllocate = paymentAmountUzs;
    for (const inv of params.targetInvoicesInOrder) {
      if (inv.remainingDebtUzs <= 0n) {
        continue;
      }
      const alloc =
        remainingToAllocate <= inv.remainingDebtUzs
          ? remainingToAllocate
          : inv.remainingDebtUzs;
      const newAllocatedPaidUzs = inv.allocatedPaidUzs + alloc;
      const newRemainingDebtUzs = inv.effectiveNetChargeUzs - newAllocatedPaidUzs;
      const newStatus: InvoiceStatus =
        newRemainingDebtUzs === 0n
          ? 'PAID'
          : newAllocatedPaidUzs > 0n
            ? 'PARTIALLY_PAID'
            : inv.status;

      if (alloc > 0n) {
        plannedAllocations.push(
          Object.freeze({
            invoiceId: inv.id,
            enrollmentId: inv.enrollmentId,
            allocatedAmountUzs: alloc,
            previousAllocatedPaidUzs: inv.allocatedPaidUzs,
            newAllocatedPaidUzs,
            previousRemainingDebtUzs: inv.remainingDebtUzs,
            newRemainingDebtUzs,
            newStatus,
            expectedVersion: inv.version,
          }),
        );
        allocatedTotalUzs += alloc;
        remainingToAllocate -= alloc;
      }
      targetedRemainingDebtUzs += newRemainingDebtUzs;
    }
  }

  const unappliedCreditUzs = paymentAmountUzs - allocatedTotalUzs;
  const totalStudentRemainingDebtUzs = targetedRemainingDebtUzs + otherOpenDebtUzs;
  const requiresPromiseToPay = totalStudentRemainingDebtUzs > 0n;

  if (requiresPromiseToPay && !cleanPromiseDate) {
    throw new ApiHttpException({
      statusCode: 422,
      errorCode: 'PROMISE_DATE_REQUIRED_FOR_PARTIAL_PAYMENT',
      message: `promise_date is mandatory when remaining student invoice debt (${formatMoneyUzs(totalStudentRemainingDebtUzs)} UZS) > 0 after payment (B03, BR-05, CASE-11)`,
    });
  }

  return Object.freeze({
    paymentAmountUzs,
    allocatedTotalUzs,
    unappliedCreditUzs,
    targetedRemainingDebtUzs,
    totalStudentRemainingDebtUzs,
    requiresPromiseToPay,
    promiseDate: requiresPromiseToPay ? cleanPromiseDate : null,
    plannedAllocations: Object.freeze(plannedAllocations),
  });
}

@Injectable()
export class AllocationService {
  /**
   * Executes invoice row locking (`ORDER BY "id" ASC FOR UPDATE`), canonical allocation calculation,
   * `PaymentAllocation` inserts, `Invoice` balance updates, `UnappliedCredit` creation,
   * automatic early fulfillment of open `PromiseToPay` rows when debt hits `0`, and new `PromiseToPay` creation when debt > 0.
   */
  public async applyPaymentAllocationsAndPromisesInTx(
    tx: TransactionContext,
    params: {
      readonly centerId: string;
      readonly studentId: string;
      readonly paymentId: string;
      readonly paymentAmountUzs: bigint;
      readonly targetInvoiceIds: readonly string[] | null;
      readonly explicitAllocations: readonly ExplicitInvoiceAllocationInput[] | null;
      readonly promiseDate: string | null;
      readonly centerTodayDate: string;
      readonly nowUtc: Date;
    },
  ): Promise<AppliedAllocationsAndPromisesResult> {
    const requestedIds: string[] =
      params.explicitAllocations !== null
        ? params.explicitAllocations.map((a) => a.invoiceId)
        : params.targetInvoiceIds !== null
          ? [...params.targetInvoiceIds]
          : [];

    type LockedInvoiceRow = {
      id: string;
      student_id: string;
      enrollment_id: string;
      effective_net_charge_uzs: string;
      allocated_paid_uzs: string;
      remaining_debt_uzs: string;
      status: InvoiceStatus;
      due_date: unknown;
      version: number;
    };

    let allStudentOpenRows: LockedInvoiceRow[] = [];

    if (requestedIds.length > 0) {
      // Lock all requested invoices in deterministic UUID order (prevents deadlocks across concurrent multi-invoice payments)
      const requestedLockedRes = await tx.query<LockedInvoiceRow>(
        `SELECT "id"::text AS id,
                "student_id"::text AS student_id,
                "enrollment_id"::text AS enrollment_id,
                "effective_net_charge_uzs"::text AS effective_net_charge_uzs,
                "allocated_paid_uzs"::text AS allocated_paid_uzs,
                "remaining_debt_uzs"::text AS remaining_debt_uzs,
                "status"::text AS status,
                "due_date"::text AS due_date,
                "version"
           FROM "invoices"
          WHERE "center_id" = $1::uuid
            AND ("id" = ANY($2::uuid[]) OR ("student_id" = $3::uuid AND "remaining_debt_uzs" > 0 AND "status" IN ('ISSUED_OPEN', 'PARTIALLY_PAID')))
          ORDER BY "id" ASC
          FOR UPDATE`,
        [params.centerId, requestedIds, params.studentId],
      );

      const byId = new Map<string, LockedInvoiceRow>(
        requestedLockedRes.rows.map((r) => [r.id, r]),
      );

      for (const reqId of requestedIds) {
        const found = byId.get(reqId);
        if (!found) {
          throw new ApiHttpException({
            statusCode: 404,
            errorCode: 'NOT_FOUND',
            message: `Target invoice ${reqId} not found in center scope`,
          });
        }
        if (found.student_id !== params.studentId) {
          throw new ApiHttpException({
            statusCode: 403,
            errorCode: 'FORBIDDEN_OBJECT_SCOPE',
            message: `Target invoice ${reqId} belongs to another student in this center`,
          });
        }
      }

      allStudentOpenRows = requestedLockedRes.rows.filter(
        (r) => r.student_id === params.studentId,
      );
    } else {
      // Lock all open invoices for this student in deterministic order
      const openLockedRes = await tx.query<LockedInvoiceRow>(
        `SELECT "id"::text AS id,
                "student_id"::text AS student_id,
                "enrollment_id"::text AS enrollment_id,
                "effective_net_charge_uzs"::text AS effective_net_charge_uzs,
                "allocated_paid_uzs"::text AS allocated_paid_uzs,
                "remaining_debt_uzs"::text AS remaining_debt_uzs,
                "status"::text AS status,
                "due_date"::text AS due_date,
                "version"
           FROM "invoices"
          WHERE "center_id" = $1::uuid
            AND "student_id" = $2::uuid
            AND "remaining_debt_uzs" > 0
            AND "status" IN ('ISSUED_OPEN', 'PARTIALLY_PAID')
          ORDER BY "id" ASC
          FOR UPDATE`,
        [params.centerId, params.studentId],
      );
      allStudentOpenRows = openLockedRes.rows;
    }

    // Recompute canonical allocated_paid_uzs from committed/in-tx payment_allocations minus payment_allocation_reversals
    const invoiceIdsToVerify = allStudentOpenRows.map((r) => r.id);
    const canonicalAllocMap = new Map<string, bigint>();
    if (invoiceIdsToVerify.length > 0) {
      const allocSumRes = await tx.query<{
        invoice_id: string;
        net_allocated_uzs: string;
      }>(
        `SELECT i."id"::text AS invoice_id,
                (
                  COALESCE(
                    (SELECT SUM(pa."allocated_amount_uzs")
                       FROM "payment_allocations" pa
                      WHERE pa."invoice_id" = i."id"
                        AND pa."center_id" = i."center_id"),
                    0
                  ) - COALESCE(
                    (SELECT SUM(par."reversed_amount_uzs")
                       FROM "payment_allocation_reversals" par
                      WHERE par."invoice_id" = i."id"
                        AND par."center_id" = i."center_id"),
                    0
                  )
                )::text AS net_allocated_uzs
           FROM "invoices" i
          WHERE i."center_id" = $1::uuid
            AND i."id" = ANY($2::uuid[])`,
        [params.centerId, invoiceIdsToVerify],
      );
      for (const row of allocSumRes.rows) {
        canonicalAllocMap.set(row.invoice_id, BigInt(row.net_allocated_uzs));
      }
    }

    const snapshotMap = new Map<string, AllocationTargetInvoiceSnapshot>();
    for (const row of allStudentOpenRows) {
      const effectiveNet = BigInt(row.effective_net_charge_uzs);
      const canonicalAlloc = canonicalAllocMap.get(row.id) ?? BigInt(row.allocated_paid_uzs);
      const storedAlloc = BigInt(row.allocated_paid_uzs);
      const effectiveAlloc = canonicalAlloc >= storedAlloc ? canonicalAlloc : storedAlloc;
      const remainingDebt = effectiveNet > effectiveAlloc ? effectiveNet - effectiveAlloc : 0n;
      snapshotMap.set(row.id, {
        id: row.id,
        studentId: row.student_id,
        enrollmentId: row.enrollment_id,
        effectiveNetChargeUzs: effectiveNet,
        allocatedPaidUzs: effectiveAlloc,
        remainingDebtUzs: remainingDebt,
        status: row.status,
        dueDate: formatPgDate(row.due_date),
        version: Number(row.version),
      });
    }

    let targetSnapshotsInOrder: AllocationTargetInvoiceSnapshot[] = [];
    let otherOpenStudentDebtUzs = 0n;

    if (requestedIds.length > 0) {
      const requestedSet = new Set(requestedIds);
      targetSnapshotsInOrder = requestedIds.map((id) => snapshotMap.get(id)!);
      for (const [id, snap] of snapshotMap.entries()) {
        if (!requestedSet.has(id) && snap.remainingDebtUzs > 0n) {
          otherOpenStudentDebtUzs += snap.remainingDebtUzs;
        }
      }
    } else {
      targetSnapshotsInOrder = [...snapshotMap.values()].sort((a, b) => {
        if (a.dueDate !== b.dueDate) return a.dueDate < b.dueDate ? -1 : 1;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });
    }

    const plan = planPaymentAllocations({
      studentId: params.studentId,
      paymentAmountUzs: params.paymentAmountUzs,
      targetInvoicesInOrder: targetSnapshotsInOrder,
      explicitAllocations: params.explicitAllocations,
      otherOpenStudentDebtUzs,
      promiseDate: params.promiseDate,
      centerTodayDate: params.centerTodayDate,
    });

    const appliedDtos: PaymentAllocationItemDto[] = [];

    for (const planned of plan.plannedAllocations) {
      const allocationId = crypto.randomUUID();
      await tx.query(
        `INSERT INTO "payment_allocations" (
           "id",
           "center_id",
           "payment_id",
           "invoice_id",
           "allocated_amount_uzs",
           "created_at"
         ) VALUES (
           $1::uuid,
           $2::uuid,
           $3::uuid,
           $4::uuid,
           $5::bigint,
           $6::timestamptz
         )`,
        [
          allocationId,
          params.centerId,
          params.paymentId,
          planned.invoiceId,
          formatMoneyUzs(planned.allocatedAmountUzs),
          params.nowUtc.toISOString(),
        ],
      );

      const updatedInv = await executeOptimisticUpdate<{ version: number }>(tx, {
        tableName: 'invoices',
        entityName: 'Invoice',
        id: planned.invoiceId,
        centerId: params.centerId,
        expectedVersion: planned.expectedVersion,
        setClauseSql: `"allocated_paid_uzs" = $4::bigint, "remaining_debt_uzs" = $5::bigint, "status" = $6`,
        additionalValues: [
          formatMoneyUzs(planned.newAllocatedPaidUzs),
          formatMoneyUzs(planned.newRemainingDebtUzs),
          planned.newStatus,
        ],
      });

      const allocOutboxId = crypto.randomUUID();
      const allocPayload = {
        invoice_id: planned.invoiceId,
        enrollment_id: planned.enrollmentId,
        student_id: params.studentId,
        allocation_id: allocationId,
        allocation_reversal_id: null,
        delta_allocated_uzs: formatMoneyUzs(planned.allocatedAmountUzs),
        new_remaining_debt_uzs: formatMoneyUzs(planned.newRemainingDebtUzs),
        invoice_status: planned.newStatus,
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
           'AllocationAdjusted',
           1,
           'Invoice',
           $3::uuid,
           $4::int,
           $5,
           $6::jsonb,
           'PENDING',
           0,
           $7::timestamptz,
           $7::timestamptz,
           $7::timestamptz
         )`,
        [
          allocOutboxId,
          params.centerId,
          planned.invoiceId,
          Number(updatedInv.version),
          `AllocationAdjusted:${planned.invoiceId}:v${Number(updatedInv.version)}`,
          JSON.stringify(allocPayload),
          params.nowUtc.toISOString(),
        ],
      );

      // CASE-22 / T11.03: If invoice remaining debt reached 0, fulfill any ACTIVE PromiseToPay rows on this invoice!
      if (planned.newRemainingDebtUzs === 0n) {
        const activePromisesRes = await tx.query<{
          id: string;
          version: number;
        }>(
          `SELECT "id"::text AS id, "version"
             FROM "promises_to_pay"
            WHERE "center_id" = $1::uuid
              AND "invoice_id" = $2::uuid
              AND "status" = 'ACTIVE'
            ORDER BY "id" ASC
            FOR UPDATE`,
          [params.centerId, planned.invoiceId],
        );

        for (const pRow of activePromisesRes.rows) {
          const updatedPromise = await executeOptimisticUpdate<{ version: number }>(tx, {
            tableName: 'promises_to_pay',
            entityName: 'PromiseToPay',
            id: pRow.id,
            centerId: params.centerId,
            expectedVersion: Number(pRow.version),
            setClauseSql: `"status" = 'FULFILLED'`,
          });

          const pfEventId = crypto.randomUUID();
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
               'PromiseFulfilled',
               1,
               'PromiseToPay',
               $3::uuid,
               $4::int,
               $5,
               $6::jsonb,
               'PENDING',
               0,
               $7::timestamptz,
               $7::timestamptz,
               $7::timestamptz
             )`,
            [
              pfEventId,
              params.centerId,
              pRow.id,
              Number(updatedPromise.version),
              `PromiseFulfilled:${pRow.id}:v${Number(updatedPromise.version)}`,
              JSON.stringify({
                promise_id: pRow.id,
                student_id: params.studentId,
                invoice_id: planned.invoiceId,
                fulfilled_by_payment_id: params.paymentId,
                fulfilled_at_utc: params.nowUtc.toISOString(),
              }),
              params.nowUtc.toISOString(),
            ],
          );
        }
      }

      appliedDtos.push(
        Object.freeze({
          allocation_id: allocationId,
          invoice_id: planned.invoiceId,
          allocated_amount_uzs: formatMoneyUzs(planned.allocatedAmountUzs),
          resulting_invoice_debt_uzs: formatMoneyUzs(planned.newRemainingDebtUzs),
          resulting_invoice_status: planned.newStatus,
        }),
      );
    }

    let unappliedCreditId: string | null = null;
    if (plan.unappliedCreditUzs > 0n) {
      unappliedCreditId = crypto.randomUUID();
      await tx.query(
        `INSERT INTO "unapplied_credits" (
           "id",
           "center_id",
           "student_id",
           "source_payment_id",
           "initial_credit_uzs",
           "remaining_credit_uzs",
           "version",
           "created_at",
           "updated_at"
         ) VALUES (
           $1::uuid,
           $2::uuid,
           $3::uuid,
           $4::uuid,
           $5::bigint,
           $5::bigint,
           1,
           $6::timestamptz,
           $6::timestamptz
         )`,
        [
          unappliedCreditId,
          params.centerId,
          params.studentId,
          params.paymentId,
          formatMoneyUzs(plan.unappliedCreditUzs),
          params.nowUtc.toISOString(),
        ],
      );
    }

    let primaryPromiseId: string | null = null;
    if (plan.requiresPromiseToPay && plan.promiseDate) {
      // Create PromiseToPay rows for each targeted invoice that still has remaining debt > 0 (or the earliest open student invoice)
      const openTargeted = plan.plannedAllocations.filter((a) => a.newRemainingDebtUzs > 0n);
      const unallocatedTargeted = targetSnapshotsInOrder.filter(
        (inv) =>
          inv.remainingDebtUzs > 0n &&
          !plan.plannedAllocations.some((a) => a.invoiceId === inv.id),
      );

      const promiseTargets: Array<{ invoiceId: string; debtUzs: bigint }> = [
        ...openTargeted.map((a) => ({
          invoiceId: a.invoiceId,
          debtUzs: a.newRemainingDebtUzs,
        })),
        ...unallocatedTargeted.map((inv) => ({
          invoiceId: inv.id,
          debtUzs: inv.remainingDebtUzs,
        })),
      ];

      if (promiseTargets.length === 0) {
        // Fallback to any remaining open student invoice
        for (const snap of snapshotMap.values()) {
          if (
            snap.remainingDebtUzs > 0n &&
            !plan.plannedAllocations.some((a) => a.invoiceId === snap.id)
          ) {
            promiseTargets.push({
              invoiceId: snap.id,
              debtUzs: snap.remainingDebtUzs,
            });
          }
        }
      }

      for (const pt of promiseTargets) {
        const promiseId = crypto.randomUUID();
        if (!primaryPromiseId) {
          primaryPromiseId = promiseId;
        }
        // 11.03: Supersede any prior ACTIVE PromiseToPay on the same invoice before inserting the new ACTIVE promise
        const priorActiveRes = await tx.query<{ id: string; version: number }>(
          `SELECT "id"::text AS id, "version"
             FROM "promises_to_pay"
            WHERE "center_id" = $1::uuid
              AND "invoice_id" = $2::uuid
              AND "status" = 'ACTIVE'
            ORDER BY "id" ASC
            FOR UPDATE`,
          [params.centerId, pt.invoiceId],
        );
        for (const oldPromise of priorActiveRes.rows) {
          await executeOptimisticUpdate(tx, {
            tableName: 'promises_to_pay',
            entityName: 'PromiseToPay',
            id: oldPromise.id,
            centerId: params.centerId,
            expectedVersion: Number(oldPromise.version),
            setClauseSql: `"status" = 'CANCELLED', "cancel_reason" = 'SUPERSEDED_BY_NEW_PARTIAL_PAYMENT_PROMISE', "superseded_by_promise_id" = $4::uuid`,
            additionalValues: [promiseId],
          });
        }
        await tx.query(
          `INSERT INTO "promises_to_pay" (
             "id",
             "center_id",
             "student_id",
             "invoice_id",
             "trigger_payment_id",
             "promised_amount_uzs",
             "promise_date",
             "status",
             "version",
             "created_at",
             "updated_at"
           ) VALUES (
             $1::uuid,
             $2::uuid,
             $3::uuid,
             $4::uuid,
             $5::uuid,
             $6::bigint,
             $7::date,
             'ACTIVE',
             1,
             $8::timestamptz,
             $8::timestamptz
           )`,
          [
            promiseId,
            params.centerId,
            params.studentId,
            pt.invoiceId,
            params.paymentId,
            formatMoneyUzs(pt.debtUzs),
            plan.promiseDate,
            params.nowUtc.toISOString(),
          ],
        );
      }
    }

    // Recompute canonical total student remaining debt and next due date from open invoices
    const finalDebtRes = await tx.query<{
      total_debt: string;
      earliest_due_date: unknown;
    }>(
      `SELECT COALESCE(SUM("remaining_debt_uzs"), 0)::text AS total_debt,
              MIN("due_date")::text AS earliest_due_date
         FROM "invoices"
        WHERE "center_id" = $1::uuid
          AND "student_id" = $2::uuid
          AND "remaining_debt_uzs" > 0
          AND "status" IN ('ISSUED_OPEN', 'PARTIALLY_PAID')`,
      [params.centerId, params.studentId],
    );

    const finalRemainingDebtUzs = BigInt(finalDebtRes.rows[0]?.total_debt ?? '0');
    const earliestDueDateRaw = finalDebtRes.rows[0]?.earliest_due_date;
    const nextDueDateSnapshot =
      plan.promiseDate ??
      (earliestDueDateRaw ? formatPgDate(earliestDueDateRaw) : null);

    return Object.freeze({
      allocatedTotalUzs: plan.allocatedTotalUzs,
      unappliedCreditUzs: plan.unappliedCreditUzs,
      unappliedCreditId,
      totalStudentRemainingDebtUzs: finalRemainingDebtUzs,
      nextDueDateSnapshot,
      primaryPromiseId,
      promiseDate: plan.promiseDate,
      allocations: Object.freeze(appliedDtos),
    });
  }
}
