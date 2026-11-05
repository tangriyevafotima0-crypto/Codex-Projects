/**
 * EduERP v2.0 — Stage 09, Step 09.04 (`T09.04`, `BR-08`, `CASE-17`):
 * Student Enrollment Withdrawal Effective Boundary, Mandatory 5 Churn Reason Codes (`1..5`),
 * Lossless `BigInt` Debt Preservation, Pending Discount Revocation, and Post-Exit Billing Block.
 */

import { Inject, Injectable } from '@nestjs/common';
import * as crypto from 'node:crypto';
import { ApiHttpException } from '../auth/auth.errors';
import { ClockService } from '../auth/clock.service';
import { AuthenticatedStaffPrincipal } from '../auth/permissions.guard';
import {
  assertPlainObject,
  assertValidUuid,
  requireIdempotencyKeyHeader,
  resolveExpectedVersion,
} from '../auth/validation';
import { RequestWithCorrelationId, resolveRequestId } from '../common/request-id.middleware';
import { ApiEnvConfig } from '../config/env';
import { API_CONFIG_TOKEN } from '../config/tokens';
import { DatabaseService } from '../database/database.service';
import { executeIdempotentOperation } from '../database/idempotency';
import { formatMoneyUzs, parseNonNegativeMoneyUzs } from '../database/money';
import { executeOptimisticUpdate, TransactionContext } from '../database/transaction';
import {
  ChurnReasonCode,
  EnrollmentResponseDto,
  EnrollmentStatus,
  mapEnrollmentRowToDto,
} from '../students/enrollments.service';
import { parseOptionalStrictBoolean, validateIsoDate } from '../students/normalization';

export type WithdrawalFaultStep = 'ENROLLMENT_UPDATE' | 'REVOKE_PENDING_DISCOUNTS' | 'AUDIT_LOG';

export const ALLOWED_CHURN_REASON_CODES: ReadonlySet<ChurnReasonCode> = new Set([1, 2, 3, 4, 5]);

export const CHURN_REASON_LABELS: Readonly<Record<ChurnReasonCode, string>> = Object.freeze({
  1: '1_FINANCIAL_DIFFICULTY',
  2: '2_DISLIKED_TEACHER',
  3: '3_SCHEDULE_MISMATCH',
  4: '4_MOVED_TO_COMPETITOR',
  5: '5_COMPLETED_OR_RELOCATED',
});

export interface ValidatedWithdrawalInput {
  readonly enrollmentId: string;
  readonly leftAtDate: string;
  readonly churnReasonCode: ChurnReasonCode;
  readonly churnReasonLabel: string;
  readonly churnNotes: string | null;
  readonly expectedVersion: number;
}

export interface WithdrawalFinalAccountSummary {
  readonly enrollmentId: string;
  readonly studentId: string;
  readonly leftAtDate: string;
  readonly churnReasonCode: ChurnReasonCode;
  readonly churnReasonLabel: string;
  readonly openInvoiceCount: number;
  readonly preservedEnrollmentDebtUzs: string;
  readonly preservedStudentTotalDebtUzs: string;
  readonly unconsumedCreditNotesUzs: string;
  readonly automaticRefundOrWriteoffApplied: false;
}

function formatPgDate(val: unknown): string | null {
  if (val === null || val === undefined) return null;
  if (val instanceof Date) return val.toISOString().slice(0, 10);
  return String(val).slice(0, 10);
}

/**
 * Pure validator for withdrawal requests (`09.04`, `T09.04`).
 * Gates unconfirmed retroactive pro-rata adjustment, unused-lesson credit notes, automatic debt forgiveness,
 * and unconfirmed future-scheduled deferred exit jobs with `403 POLICY_DECISION_NOT_CONFIRMED`.
 */
export function validateWithdrawalRequestInput(
  req: RequestWithCorrelationId,
  rawEnrollmentId: unknown,
  rawBody: unknown,
): ValidatedWithdrawalInput {
  const enrollmentId = assertValidUuid(rawEnrollmentId, 'enrollment_id');
  const obj = assertPlainObject(rawBody, [
    'left_at_date',
    'churn_reason_code',
    'churn_notes',
    'expected_version',
    'apply_retroactive_prorata_adjustment',
    'forgive_remaining_debt',
    'issue_unused_lessons_credit_note',
    'schedule_future_withdrawal',
  ]);

  const leftAtDate = validateIsoDate(obj.left_at_date, 'left_at_date');
  const churnReasonCodeNum = Number(obj.churn_reason_code);
  if (
    !Number.isInteger(churnReasonCodeNum) ||
    !ALLOWED_CHURN_REASON_CODES.has(churnReasonCodeNum as ChurnReasonCode)
  ) {
    throw new ApiHttpException({
      statusCode: 400,
      errorCode: 'VALIDATION_ERROR',
      message: 'churn_reason_code is required and must be an integer in 1..5 (T09.04)',
    });
  }
  const churnReasonCode = churnReasonCodeNum as ChurnReasonCode;

  let churnNotes: string | null = null;
  if (obj.churn_notes !== undefined && obj.churn_notes !== null) {
    if (typeof obj.churn_notes !== 'string' || obj.churn_notes.length > 500) {
      throw new ApiHttpException({
        statusCode: 400,
        errorCode: 'VALIDATION_ERROR',
        message: 'churn_notes must be a string up to 500 characters',
      });
    }
    churnNotes = obj.churn_notes.trim() || null;
  }

  const expectedVersion = resolveExpectedVersion(req, obj.expected_version);

  const applyRetroProrata = parseOptionalStrictBoolean(
    obj.apply_retroactive_prorata_adjustment,
    'apply_retroactive_prorata_adjustment',
    false,
  );
  const forgiveDebt = parseOptionalStrictBoolean(
    obj.forgive_remaining_debt,
    'forgive_remaining_debt',
    false,
  );
  const issueUnusedCredit = parseOptionalStrictBoolean(
    obj.issue_unused_lessons_credit_note,
    'issue_unused_lessons_credit_note',
    false,
  );
  const scheduleFutureWithdrawal = parseOptionalStrictBoolean(
    obj.schedule_future_withdrawal,
    'schedule_future_withdrawal',
    false,
  );

  if (applyRetroProrata || forgiveDebt || issueUnusedCredit || scheduleFutureWithdrawal) {
    throw new ApiHttpException({
      statusCode: 403,
      errorCode: 'POLICY_DECISION_NOT_CONFIRMED',
      message:
        'Retroactive invoice pro-rata adjustment, unused-lesson credit note calculation, automatic debt forgiveness, or deferred future-scheduled withdrawal on exit is gated by unconfirmed policy decisions (D03/D21/D22 / 09.04)',
    });
  }

  return Object.freeze({
    enrollmentId,
    leftAtDate,
    churnReasonCode,
    churnReasonLabel: CHURN_REASON_LABELS[churnReasonCode],
    churnNotes,
    expectedVersion,
  });
}

/**
 * Pure helper computing the final account statement snapshot upon withdrawal (`09.04`):
 * Preserves all existing invoice debt without automatic write-off or cash refund.
 */
export function buildWithdrawalFinalAccountSummary(params: {
  readonly enrollmentId: string;
  readonly studentId: string;
  readonly leftAtDate: string;
  readonly churnReasonCode: ChurnReasonCode;
  readonly openEnrollmentInvoicesDebtUzs: readonly (bigint | string | number)[];
  readonly totalStudentRemainingDebtUzs: bigint | string | number;
  readonly unconsumedCreditNotesUzs?: bigint | string | number;
}): WithdrawalFinalAccountSummary {
  let enrollmentDebtSum = 0n;
  for (const d of params.openEnrollmentInvoicesDebtUzs) {
    enrollmentDebtSum += parseNonNegativeMoneyUzs(d, 'invoiceDebtUzs');
  }
  const totalStudentDebt = parseNonNegativeMoneyUzs(
    params.totalStudentRemainingDebtUzs,
    'totalStudentRemainingDebtUzs',
  );
  const unconsumedCredits = parseNonNegativeMoneyUzs(
    params.unconsumedCreditNotesUzs ?? 0n,
    'unconsumedCreditNotesUzs',
  );

  return Object.freeze({
    enrollmentId: params.enrollmentId,
    studentId: params.studentId,
    leftAtDate: validateIsoDate(params.leftAtDate, 'left_at_date'),
    churnReasonCode: params.churnReasonCode,
    churnReasonLabel: CHURN_REASON_LABELS[params.churnReasonCode],
    openInvoiceCount: params.openEnrollmentInvoicesDebtUzs.length,
    preservedEnrollmentDebtUzs: formatMoneyUzs(enrollmentDebtSum),
    preservedStudentTotalDebtUzs: formatMoneyUzs(totalStudentDebt),
    unconsumedCreditNotesUzs: formatMoneyUzs(unconsumedCredits),
    automaticRefundOrWriteoffApplied: false,
  });
}

@Injectable()
export class WithdrawalService {
  constructor(
    @Inject(API_CONFIG_TOKEN) private readonly config: ApiEnvConfig,
    @Inject(DatabaseService) private readonly databaseService: DatabaseService,
    @Inject(ClockService) private readonly clock: ClockService,
  ) {}

  private maybeInjectTestFault(
    targetStep: WithdrawalFaultStep,
    configuredFault?: WithdrawalFaultStep,
  ): void {
    if (this.config.nodeEnv === 'test' && configuredFault === targetStep) {
      throw new Error(`SIMULATED_S09_WITHDRAWAL_FAULT_AFTER_${targetStep}`);
    }
  }

  public async withdrawEnrollmentWithChurnReason(
    req: RequestWithCorrelationId,
    principal: AuthenticatedStaffPrincipal,
    rawEnrollmentId: string,
    rawBody: unknown,
    options?: { readonly testFaultAfterStep?: WithdrawalFaultStep },
  ): Promise<EnrollmentResponseDto> {
    const idempotencyKey = requireIdempotencyKeyHeader(req);
    const parsed = validateWithdrawalRequestInput(req, rawEnrollmentId, rawBody);
    const requestId = req.requestId ?? resolveRequestId(req.headers['x-request-id']);
    const now = this.clock.now();

    const idemOutcome = await executeIdempotentOperation<EnrollmentResponseDto>(
      this.databaseService,
      {
        centerId: principal.centerId,
        actorStaffId: principal.staffId,
        operationType: 'WITHDRAW_ENROLLMENT',
        idempotencyKey,
        requestPayload: {
          enrollment_id: parsed.enrollmentId,
          left_at_date: parsed.leftAtDate,
          churn_reason_code: parsed.churnReasonCode,
          churn_notes: parsed.churnNotes,
          expected_version: parsed.expectedVersion,
        },
        authorizeBeforeReplayOrExecute: async (tx) => {
          const enrCheck = await tx.query<{ id: string }>(
            `SELECT "id"::text AS id
               FROM "enrollments"
              WHERE "id" = $1::uuid
                AND "center_id" = $2::uuid
              FOR UPDATE`,
            [parsed.enrollmentId, principal.centerId],
          );
          if (!enrCheck.rows[0]) {
            throw new ApiHttpException({
              statusCode: 404,
              errorCode: 'NOT_FOUND',
              message: 'Enrollment not found in this center',
            });
          }
        },
        handler: async (tx: TransactionContext) => {
          const enrRes = await tx.query<{
            id: string;
            student_id: string;
            group_id: string;
            status: EnrollmentStatus;
            enrolled_at_date: unknown;
            primary_teacher_id: string;
            version: number;
          }>(
            `SELECT e."id"::text AS id,
                    e."student_id"::text AS student_id,
                    e."group_id"::text AS group_id,
                    e."status"::text AS status,
                    e."enrolled_at_date",
                    g."primary_teacher_id"::text AS primary_teacher_id,
                    e."version"
               FROM "enrollments" e
               JOIN "course_groups" g
                 ON g."id" = e."group_id"
                AND g."center_id" = e."center_id"
              WHERE e."id" = $1::uuid
                AND e."center_id" = $2::uuid
              FOR UPDATE OF e`,
            [parsed.enrollmentId, principal.centerId],
          );

          const before = enrRes.rows[0];
          if (!before) {
            throw new ApiHttpException({
              statusCode: 404,
              errorCode: 'NOT_FOUND',
              message: 'Enrollment not found in this center',
            });
          }

          if (before.status === 'LEFT') {
            throw new ApiHttpException({
              statusCode: 422,
              errorCode: 'VALIDATION_ERROR',
              message: 'Enrollment is already in LEFT status and cannot be withdrawn again',
            });
          }

          const enrolledDateStr = formatPgDate(before.enrolled_at_date) ?? '1970-01-01';
          if (parsed.leftAtDate < enrolledDateStr) {
            throw new ApiHttpException({
              statusCode: 422,
              errorCode: 'VALIDATION_ERROR',
              message: `left_at_date (${parsed.leftAtDate}) cannot be earlier than enrolled_at_date (${enrolledDateStr})`,
            });
          }

          const updated = await executeOptimisticUpdate<{
            id: string;
            student_id: string;
            group_id: string;
            status: EnrollmentStatus;
            enrolled_at_date: unknown;
            left_at_date: unknown;
            churn_reason_code: number | null;
            package_lessons_remaining: number | null;
            transferred_from_enrollment_id: string | null;
            version: number;
          }>(tx, {
            tableName: 'enrollments',
            entityName: 'Enrollment',
            id: parsed.enrollmentId,
            centerId: principal.centerId,
            expectedVersion: parsed.expectedVersion,
            setClauseSql: `"status" = 'LEFT', "left_at_date" = $4::date, "churn_reason_code" = $5::smallint, "churn_attributed_teacher_id" = $6::uuid, "churn_notes" = $7`,
            additionalValues: [
              parsed.leftAtDate,
              parsed.churnReasonCode,
              before.primary_teacher_id,
              parsed.churnNotes,
            ],
          });
          this.maybeInjectTestFault('ENROLLMENT_UPDATE', options?.testFaultAfterStep);

          // Automatically revoke any PENDING_APPROVAL discount requests on this withdrawn enrollment
          // so stale pending requests cannot be approved after withdrawal (09.04)
          await tx.query(
            `UPDATE "discount_requests"
                SET "status" = 'REVOKED',
                    "version" = "version" + 1,
                    "updated_at" = $1::timestamptz
              WHERE "center_id" = $2::uuid
                AND "enrollment_id" = $3::uuid
                AND "status" = 'PENDING_APPROVAL'`,
            [now.toISOString(), principal.centerId, parsed.enrollmentId],
          );
          this.maybeInjectTestFault('REVOKE_PENDING_DISCOUNTS', options?.testFaultAfterStep);

          // Compute lossless BigInt final account debt snapshot without modifying or forgiving any invoice/ledger
          const debtRes = await tx.query<{
            student_total_debt: string;
            enrollment_open_debts: string[] | null;
          }>(
            `SELECT COALESCE(
                      (SELECT SUM("remaining_debt_uzs")
                         FROM "invoices"
                        WHERE "center_id" = $1::uuid
                          AND "student_id" = $2::uuid
                          AND "status" IN ('ISSUED_OPEN', 'PARTIALLY_PAID')),
                      0
                    )::text AS student_total_debt,
                    ARRAY(
                      SELECT "remaining_debt_uzs"::text
                        FROM "invoices"
                       WHERE "center_id" = $1::uuid
                         AND "enrollment_id" = $3::uuid
                         AND "status" IN ('ISSUED_OPEN', 'PARTIALLY_PAID')
                         AND "remaining_debt_uzs" > 0
                    ) AS enrollment_open_debts`,
            [principal.centerId, before.student_id, parsed.enrollmentId],
          );

          const finalSummary = buildWithdrawalFinalAccountSummary({
            enrollmentId: parsed.enrollmentId,
            studentId: before.student_id,
            leftAtDate: parsed.leftAtDate,
            churnReasonCode: parsed.churnReasonCode,
            openEnrollmentInvoicesDebtUzs: debtRes.rows[0]?.enrollment_open_debts ?? [],
            totalStudentRemainingDebtUzs: debtRes.rows[0]?.student_total_debt ?? '0',
          });

          await tx.query(
            `INSERT INTO "audit_logs" (
               "id", "center_id", "actor_type", "actor_id", "actor_role",
               "action", "entity_type", "entity_id", "severity",
               "before_redacted_json", "after_redacted_json", "request_id", "created_at"
             ) VALUES (
               $1::uuid, $2::uuid, 'STAFF', $3::uuid, $4,
               'ENROLLMENT_WITHDRAWN', 'Enrollment', $5::uuid, 'WARN',
               $6::jsonb, $7::jsonb, $8, $9::timestamptz
             )`,
            [
              crypto.randomUUID(),
              principal.centerId,
              principal.staffId,
              principal.role,
              parsed.enrollmentId,
              JSON.stringify({
                status: before.status,
                version: before.version,
              }),
              JSON.stringify({
                status: 'LEFT',
                left_at_date: parsed.leftAtDate,
                churn_reason_code: parsed.churnReasonCode,
                churn_reason_label: parsed.churnReasonLabel,
                preserved_debt_snapshot_uzs: finalSummary.preservedStudentTotalDebtUzs,
                preserved_enrollment_debt_uzs: finalSummary.preservedEnrollmentDebtUzs,
                open_invoice_count: finalSummary.openInvoiceCount,
                version: Number(updated.version),
              }),
              requestId,
              now.toISOString(),
            ],
          );
          this.maybeInjectTestFault('AUDIT_LOG', options?.testFaultAfterStep);

          return {
            statusCode: 200,
            body: mapEnrollmentRowToDto(updated, finalSummary.preservedStudentTotalDebtUzs),
          };
        },
      },
    );

    return idemOutcome.body;
  }
}
