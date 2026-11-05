import { validateIsoDate } from '../students/normalization';
/**
 * EduERP v2.0 — Stage 11, Step 11.03 (`T11.03`, `BR-05`, `CASE-11`, `CASE-22`):
 * Promise-to-Pay Lifecycle, Reminder Candidate Eligibility (`evaluatePromiseReminderEligibility`),
 * and Role-Safe Center-Scoped Debtors & Promises Projection (`GET /api/v1/promises`).
 */

import { Inject, Injectable } from '@nestjs/common';
import type { PromiseToPayStatus } from '@eduerp/contracts';
import { ApiHttpException } from '../auth/auth.errors';
import { ClockService } from '../auth/clock.service';
import { AuthenticatedStaffPrincipal } from '../auth/permissions.guard';
import { formatCenterLocalDate } from '../auth/staff.service';
import { assertValidUuid } from '../auth/validation';
import { ApiEnvConfig } from '../config/env';
import { API_CONFIG_TOKEN } from '../config/tokens';
import { DatabaseService } from '../database/database.service';
import { formatMoneyUzs } from '../database/money';
import { runInTransaction } from '../database/transaction';
import {
  DebtorInvoiceSummaryDto,
  DebtorsAndPromisesListResponseDto,
  DebtorStudentSummaryDto,
  PromiseToPayItemDto,
} from './dto';

function formatPgDate(val: unknown): string {
  if (val instanceof Date) return val.toISOString().slice(0, 10);
  return String(val).slice(0, 10);
}

export function evaluatePromiseReminderEligibility(params: {
  readonly status: PromiseToPayStatus;
  readonly promiseDate: string;
  readonly centerTodayDate: string;
  readonly currentInvoiceRemainingDebtUzs: bigint;
  readonly supersededByPromiseId: string | null;
  readonly reminderSentAt: string | Date | null;
}): boolean {
  if (params.status !== 'ACTIVE') {
    return false;
  }
  if (params.supersededByPromiseId !== null) {
    return false;
  }
  if (params.reminderSentAt !== null) {
    return false;
  }
  if (params.currentInvoiceRemainingDebtUzs <= 0n) {
    return false;
  }
  return params.centerTodayDate >= params.promiseDate;
}

@Injectable()
export class PromisesService {
  constructor(
    @Inject(API_CONFIG_TOKEN) private readonly config: ApiEnvConfig,
    @Inject(DatabaseService) private readonly databaseService: DatabaseService,
    @Inject(ClockService) private readonly clock: ClockService,
  ) {}

  public async listDebtorsAndPromises(
    principal: AuthenticatedStaffPrincipal,
    query: {
      readonly status?: string;
      readonly student_id?: string;
      readonly invoice_id?: string;
      readonly due_on_or_before?: string;
    },
  ): Promise<DebtorsAndPromisesListResponseDto> {
    if (principal.role !== 'DIRECTOR' && principal.role !== 'ADMIN') {
      throw new ApiHttpException({
        statusCode: 403,
        errorCode: 'FORBIDDEN_ROLE',
        message: 'Only DIRECTOR and ADMIN are permitted to list debtors and promises-to-pay (T11.03)',
      });
    }

    const statusFilter =
      query.status !== undefined && query.status.trim() !== ''
        ? query.status.trim().toUpperCase()
        : null;
    if (
      statusFilter !== null &&
      statusFilter !== 'ACTIVE' &&
      statusFilter !== 'FULFILLED' &&
      statusFilter !== 'OVERDUE_NOTIFIED' &&
      statusFilter !== 'CANCELLED'
    ) {
      throw new ApiHttpException({
        statusCode: 400,
        errorCode: 'VALIDATION_ERROR',
        message: 'status filter must be ACTIVE, FULFILLED, OVERDUE_NOTIFIED, or CANCELLED',
      });
    }

    const studentIdFilter =
      query.student_id !== undefined && query.student_id.trim() !== ''
        ? assertValidUuid(query.student_id.trim(), 'student_id')
        : null;
    const invoiceIdFilter =
      query.invoice_id !== undefined && query.invoice_id.trim() !== ''
        ? assertValidUuid(query.invoice_id.trim(), 'invoice_id')
        : null;
    const dueOnOrBeforeFilter =
      query.due_on_or_before !== undefined && query.due_on_or_before.trim() !== ''
        ? validateIsoDate(query.due_on_or_before.trim(), 'due_on_or_before')
        : null;

    const centerTodayDate = formatCenterLocalDate(
      this.clock.now(),
      this.config.centerTimezone,
    );

    const txRes = await runInTransaction(
      this.databaseService,
      async (tx) => {
        if (studentIdFilter !== null) {
          const stCheck = await tx.query<{ id: string }>(
            `SELECT "id"::text AS id
               FROM "students"
              WHERE "id" = $1::uuid
                AND "center_id" = $2::uuid
              LIMIT 1`,
            [studentIdFilter, principal.centerId],
          );
          if (!stCheck.rows[0]) {
            throw new ApiHttpException({
              statusCode: 404,
              errorCode: 'NOT_FOUND',
              message: 'Student not found in center scope',
            });
          }
        }

        if (invoiceIdFilter !== null) {
          const invCheck = await tx.query<{ id: string }>(
            `SELECT "id"::text AS id
               FROM "invoices"
              WHERE "id" = $1::uuid
                AND "center_id" = $2::uuid
              LIMIT 1`,
            [invoiceIdFilter, principal.centerId],
          );
          if (!invCheck.rows[0]) {
            throw new ApiHttpException({
              statusCode: 404,
              errorCode: 'NOT_FOUND',
              message: 'Invoice not found in center scope',
            });
          }
        }

        const promiseRowsRes = await tx.query<{
          id: string;
          student_id: string;
          invoice_id: string;
          trigger_payment_id: string;
          promised_amount_uzs: string;
          promise_date: unknown;
          status: PromiseToPayStatus;
          cancel_reason: string | null;
          superseded_by_promise_id: string | null;
          reminder_sent_at: Date | null;
          version: number;
          created_at: Date;
          updated_at: Date;
          invoice_remaining_debt_uzs: string;
        }>(
          `SELECT p."id"::text AS id,
                  p."student_id"::text AS student_id,
                  p."invoice_id"::text AS invoice_id,
                  p."trigger_payment_id"::text AS trigger_payment_id,
                  p."promised_amount_uzs"::text AS promised_amount_uzs,
                  p."promise_date"::text AS promise_date,
                  p."status"::text AS status,
                  p."cancel_reason",
                  p."superseded_by_promise_id"::text AS superseded_by_promise_id,
                  p."reminder_sent_at",
                  p."version",
                  p."created_at",
                  p."updated_at",
                  i."remaining_debt_uzs"::text AS invoice_remaining_debt_uzs
             FROM "promises_to_pay" p
             JOIN "invoices" i
               ON i."id" = p."invoice_id"
              AND i."center_id" = p."center_id"
            WHERE p."center_id" = $1::uuid
              AND ($2::text IS NULL OR p."status"::text = $2)
              AND ($3::uuid IS NULL OR p."student_id" = $3::uuid)
              AND ($4::uuid IS NULL OR p."invoice_id" = $4::uuid)
              AND ($5::date IS NULL OR p."promise_date" <= $5::date)
            ORDER BY p."promise_date" ASC, p."created_at" DESC, p."id" ASC`,
          [
            principal.centerId,
            statusFilter,
            studentIdFilter,
            invoiceIdFilter,
            dueOnOrBeforeFilter,
          ],
        );

        const promises: PromiseToPayItemDto[] = [];
        const dueReminderCandidates: PromiseToPayItemDto[] = [];
        const activePromiseByInvoiceId = new Map<string, PromiseToPayItemDto>();

        for (const r of promiseRowsRes.rows) {
          const promiseDate = formatPgDate(r.promise_date);
          const currentInvoiceRemainingDebtUzs = BigInt(r.invoice_remaining_debt_uzs);
          const eligibleForDueReminder = evaluatePromiseReminderEligibility({
            status: r.status,
            promiseDate,
            centerTodayDate,
            currentInvoiceRemainingDebtUzs,
            supersededByPromiseId: r.superseded_by_promise_id,
            reminderSentAt: r.reminder_sent_at,
          });

          const item: PromiseToPayItemDto = Object.freeze({
            promise_id: r.id,
            student_id: r.student_id,
            invoice_id: r.invoice_id,
            trigger_payment_id: r.trigger_payment_id,
            promised_amount_uzs: formatMoneyUzs(BigInt(r.promised_amount_uzs)),
            current_invoice_remaining_debt_uzs: formatMoneyUzs(currentInvoiceRemainingDebtUzs),
            promise_date: promiseDate,
            status: r.status,
            cancel_reason: r.cancel_reason,
            superseded_by_promise_id: r.superseded_by_promise_id,
            reminder_sent_at_utc: r.reminder_sent_at
              ? new Date(r.reminder_sent_at).toISOString()
              : null,
            eligible_for_due_reminder: eligibleForDueReminder,
            version: Number(r.version),
            created_at_utc: new Date(r.created_at).toISOString(),
            updated_at_utc: new Date(r.updated_at).toISOString(),
          });

          promises.push(item);
          if (eligibleForDueReminder) {
            dueReminderCandidates.push(item);
          }
          if (r.status === 'ACTIVE' && !activePromiseByInvoiceId.has(r.invoice_id)) {
            activePromiseByInvoiceId.set(r.invoice_id, item);
          }
        }

        const openInvoicesRes = await tx.query<{
          invoice_id: string;
          invoice_number: string;
          student_id: string;
          student_code: string;
          full_name: string;
          enrollment_id: string;
          effective_net_charge_uzs: string;
          allocated_paid_uzs: string;
          remaining_debt_uzs: string;
          status: string;
          due_date: unknown;
          unapplied_credit_uzs: string;
        }>(
          `SELECT i."id"::text AS invoice_id,
                  i."invoice_number",
                  i."student_id"::text AS student_id,
                  s."student_code",
                  s."full_name",
                  i."enrollment_id"::text AS enrollment_id,
                  i."effective_net_charge_uzs"::text AS effective_net_charge_uzs,
                  i."allocated_paid_uzs"::text AS allocated_paid_uzs,
                  i."remaining_debt_uzs"::text AS remaining_debt_uzs,
                  i."status"::text AS status,
                  i."due_date"::text AS due_date,
                  COALESCE((
                    SELECT SUM(uc."remaining_credit_uzs")
                      FROM "unapplied_credits" uc
                     WHERE uc."center_id" = i."center_id"
                       AND uc."student_id" = i."student_id"
                  ), 0)::text AS unapplied_credit_uzs
             FROM "invoices" i
             JOIN "students" s
               ON s."id" = i."student_id"
              AND s."center_id" = i."center_id"
            WHERE i."center_id" = $1::uuid
              AND i."remaining_debt_uzs" > 0
              AND i."status" IN ('ISSUED_OPEN', 'PARTIALLY_PAID', 'OVERDUE')
              AND ($2::uuid IS NULL OR i."student_id" = $2::uuid)
              AND ($3::uuid IS NULL OR i."id" = $3::uuid)
            ORDER BY i."due_date" ASC, i."id" ASC`,
          [principal.centerId, studentIdFilter, invoiceIdFilter],
        );

        const debtorsMap = new Map<
          string,
          {
            student_id: string;
            student_code: string;
            full_name: string;
            total_remaining_debt_uzs: bigint;
            unapplied_credit_uzs: bigint;
            open_invoices: DebtorInvoiceSummaryDto[];
          }
        >();

        for (const inv of openInvoicesRes.rows) {
          const dueDate = formatPgDate(inv.due_date);
          const remainingDebtUzs = BigInt(inv.remaining_debt_uzs);
          const activePromise = activePromiseByInvoiceId.get(inv.invoice_id) ?? null;
          const isOverdue = centerTodayDate > dueDate;
          const needsNewPromise =
            activePromise === null ||
            activePromise.status === 'OVERDUE_NOTIFIED' ||
            centerTodayDate > activePromise.promise_date;

          const invSummary: DebtorInvoiceSummaryDto = Object.freeze({
            invoice_id: inv.invoice_id,
            invoice_number: inv.invoice_number,
            enrollment_id: inv.enrollment_id,
            effective_net_charge_uzs: formatMoneyUzs(BigInt(inv.effective_net_charge_uzs)),
            allocated_paid_uzs: formatMoneyUzs(BigInt(inv.allocated_paid_uzs)),
            remaining_debt_uzs: formatMoneyUzs(remainingDebtUzs),
            status: inv.status,
            due_date: dueDate,
            is_overdue: isOverdue,
            active_promise: activePromise,
            needs_new_promise: needsNewPromise,
          });

          const existing = debtorsMap.get(inv.student_id);
          if (!existing) {
            debtorsMap.set(inv.student_id, {
              student_id: inv.student_id,
              student_code: inv.student_code,
              full_name: inv.full_name,
              total_remaining_debt_uzs: remainingDebtUzs,
              unapplied_credit_uzs: BigInt(inv.unapplied_credit_uzs),
              open_invoices: [invSummary],
            });
          } else {
            existing.total_remaining_debt_uzs += remainingDebtUzs;
            existing.open_invoices.push(invSummary);
          }
        }

        const debtors: DebtorStudentSummaryDto[] = Array.from(debtorsMap.values()).map((d) =>
          Object.freeze({
            student_id: d.student_id,
            student_code: d.student_code,
            full_name: d.full_name,
            total_remaining_debt_uzs: formatMoneyUzs(d.total_remaining_debt_uzs),
            unapplied_credit_uzs: formatMoneyUzs(d.unapplied_credit_uzs),
            open_invoices: Object.freeze(d.open_invoices),
          }),
        );

        return Object.freeze({
          center_date: centerTodayDate,
          debtors: Object.freeze(debtors),
          promises: Object.freeze(promises),
          due_reminder_candidates: Object.freeze(dueReminderCandidates),
        });
      },
      { isolationLevel: 'REPEATABLE READ' },
    );

    return txRes.result;
  }
}
