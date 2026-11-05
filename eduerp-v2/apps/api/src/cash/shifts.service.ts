/**
 * EduERP v2.0 — Stage 11, Step 11.01 (`T11.01`, `BR-09`, `CASE-18`):
 * Cash Shift Open & Close Lifecycle, Single Active Shift Guard (`idx_cash_shifts_open_center`),
 * Discrepancy Reason Enforcement (`discrepancy_uzs = counted_closing_cash_uzs - expected_closing_cash_uzs`),
 * Closed Shift Immutability, and `ShiftClosed` Outbox Event.
 */

import { Inject, Injectable } from '@nestjs/common';
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
import { executeIdempotentOperation } from '../database/idempotency';
import { formatMoneyUzs } from '../database/money';
import {
  executeOptimisticUpdate,
  OptimisticVersionConflictError,
  TransactionContext,
} from '../database/transaction';
import {
  CashShiftReconciliationResponseDto,
  ShiftFaultInjectionStep,
  validateCloseCashShiftInput,
  validateOpenCashShiftInput,
} from './dto';
import { ReconciliationService } from './reconciliation.service';

@Injectable()
export class ShiftsService {
  constructor(
    @Inject(API_CONFIG_TOKEN) private readonly config: ApiEnvConfig,
    @Inject(DatabaseService) private readonly databaseService: DatabaseService,
    @Inject(ClockService) private readonly clock: ClockService,
    @Inject(ReconciliationService)
    private readonly reconciliationService: ReconciliationService,
  ) {}

  private maybeInjectTestFault(
    targetStep: ShiftFaultInjectionStep,
    configuredFault?: ShiftFaultInjectionStep,
  ): void {
    if (this.config.nodeEnv === 'test' && configuredFault === targetStep) {
      throw new Error(`SIMULATED_S11_SHIFT_FAULT_AFTER_${targetStep}`);
    }
  }

  public async openCashShift(
    req: RequestWithCorrelationId,
    principal: AuthenticatedStaffPrincipal,
    rawBody: unknown,
    options?: { readonly testFaultAfterStep?: ShiftFaultInjectionStep },
  ): Promise<CashShiftReconciliationResponseDto> {
    if (principal.role !== 'DIRECTOR' && principal.role !== 'ADMIN') {
      throw new ApiHttpException({
        statusCode: 403,
        errorCode: 'FORBIDDEN_ROLE',
        message: 'Only DIRECTOR and ADMIN are permitted to open a cash shift (T11.01)',
      });
    }

    const idempotencyKey = requireIdempotencyKeyHeader(req);
    const requestId = req.requestId ?? resolveRequestId(req.headers['x-request-id']);
    const nowUtc = this.clock.now();
    const centerTodayDate = formatCenterLocalDate(nowUtc, this.config.centerTimezone);
    const parsed = validateOpenCashShiftInput(rawBody);

    const idemPayload = {
      shift_date: parsed.shiftDate,
      opening_cash_uzs: formatMoneyUzs(parsed.openingCashUzs),
    };

    const idemOutcome = await executeIdempotentOperation<CashShiftReconciliationResponseDto>(
      this.databaseService,
      {
        centerId: principal.centerId,
        actorStaffId: principal.staffId,
        operationType: 'OPEN_CASH_SHIFT',
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
              message: 'Only DIRECTOR and ADMIN are permitted to open a cash shift',
            });
          }
        },
        handler: async (tx: TransactionContext) => {
          if (parsed.shiftDate !== centerTodayDate) {
            throw new ApiHttpException({
              statusCode: 422,
              errorCode: 'VALIDATION_ERROR',
              message: `shift_date (${parsed.shiftDate}) must match center current local date (${centerTodayDate}); opening past or future shifts is forbidden (11.01)`,
            });
          }

          await tx.query(
            `SELECT pg_advisory_xact_lock(hashtext($1), hashtext('S11_OPEN_CASH_SHIFT'))`,
            [principal.centerId],
          );

          const existingOpenRes = await tx.query<{ id: string }>(
            `SELECT "id"::text AS id
               FROM "cash_shifts"
              WHERE "center_id" = $1::uuid
                AND "status" = 'OPEN'
              LIMIT 1`,
            [principal.centerId],
          );
          if (existingOpenRes.rows[0]) {
            throw new ApiHttpException({
              statusCode: 409,
              errorCode: 'VERSION_CONFLICT',
              message: `An OPEN cash shift (${existingOpenRes.rows[0].id}) already exists for this center; close the active shift before opening a new one (T11.01)`,
            });
          }

          const shiftId = crypto.randomUUID();
          await tx.query(
            `INSERT INTO "cash_shifts" (
               "id",
               "center_id",
               "shift_date",
               "opened_by_admin_id",
               "opened_at",
               "opening_cash_uzs",
               "cash_receipts_uzs",
               "non_cash_receipts_uzs",
               "cash_refunds_uzs",
               "non_cash_refunds_uzs",
               "cash_expenses_uzs",
               "non_cash_expenses_uzs",
               "expected_closing_cash_uzs",
               "counted_closing_cash_uzs",
               "discrepancy_uzs",
               "discrepancy_reason",
               "status",
               "closed_by_admin_id",
               "closed_at",
               "version",
               "updated_at"
             ) VALUES (
               $1::uuid,
               $2::uuid,
               $3::date,
               $4::uuid,
               $5::timestamptz,
               $6::bigint,
               0,
               0,
               0,
               0,
               0,
               0,
               $6::bigint,
               NULL,
               NULL,
               NULL,
               'OPEN',
               NULL,
               NULL,
               1,
               $5::timestamptz
             )`,
            [
              shiftId,
              principal.centerId,
              parsed.shiftDate,
              principal.staffId,
              nowUtc.toISOString(),
              formatMoneyUzs(parsed.openingCashUzs),
            ],
          );

          this.maybeInjectTestFault('SHIFT_INSERT', options?.testFaultAfterStep);

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
               'CASH_SHIFT_OPENED',
               'CashShift',
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
              shiftId,
              JSON.stringify({
                shift_id: shiftId,
                shift_date: parsed.shiftDate,
                opening_cash_uzs: formatMoneyUzs(parsed.openingCashUzs),
                status: 'OPEN',
                version: 1,
              }),
              requestId,
              nowUtc.toISOString(),
            ],
          );

          this.maybeInjectTestFault('AUDIT_LOG', options?.testFaultAfterStep);

          const summary = await this.reconciliationService.buildShiftReconciliationDtoInTx(
            tx,
            {
              centerId: principal.centerId,
              shiftId,
              lockShiftForUpdate: false,
              strictDriftCheck: true,
              lastRecordedExpenseId: null,
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

  public async closeCashShiftAndReconcile(
    req: RequestWithCorrelationId,
    principal: AuthenticatedStaffPrincipal,
    rawShiftId: unknown,
    rawBody: unknown,
    options?: { readonly testFaultAfterStep?: ShiftFaultInjectionStep },
  ): Promise<CashShiftReconciliationResponseDto> {
    if (principal.role !== 'DIRECTOR' && principal.role !== 'ADMIN') {
      throw new ApiHttpException({
        statusCode: 403,
        errorCode: 'FORBIDDEN_ROLE',
        message: 'Only DIRECTOR and ADMIN are permitted to close a cash shift (T11.01)',
      });
    }

    const idempotencyKey = requireIdempotencyKeyHeader(req);
    const requestId = req.requestId ?? resolveRequestId(req.headers['x-request-id']);
    const nowUtc = this.clock.now();
    const parsed = validateCloseCashShiftInput(req, rawShiftId, rawBody);

    const idemPayload = {
      shift_id: parsed.shiftId,
      counted_closing_cash_uzs: formatMoneyUzs(parsed.countedClosingCashUzs),
      discrepancy_reason: parsed.discrepancyReason,
      expected_version: parsed.expectedVersion,
    };

    const idemOutcome = await executeIdempotentOperation<CashShiftReconciliationResponseDto>(
      this.databaseService,
      {
        centerId: principal.centerId,
        actorStaffId: principal.staffId,
        operationType: 'CLOSE_CASH_SHIFT_AND_RECONCILE',
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
              message: 'Only DIRECTOR and ADMIN are permitted to close a cash shift',
            });
          }

          const shiftCheckRes = await tx.query<{ id: string }>(
            `SELECT "id"::text AS id
               FROM "cash_shifts"
              WHERE "id" = $1::uuid
                AND "center_id" = $2::uuid
              LIMIT 1`,
            [parsed.shiftId, principal.centerId],
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
          const preCloseCheck =
            await this.reconciliationService.buildShiftReconciliationDtoInTx(tx, {
              centerId: principal.centerId,
              shiftId: parsed.shiftId,
              lockShiftForUpdate: true,
              strictDriftCheck: true,
            });

          const currentShift = preCloseCheck.dto;
          const recomputed = preCloseCheck.recomputed;

          if (currentShift.status !== 'OPEN') {
            throw new ApiHttpException({
              statusCode: 409,
              errorCode: 'SHIFT_CLOSED',
              message: `Cash shift ${parsed.shiftId} is already CLOSED (T11.01)`,
            });
          }

          if (currentShift.version !== parsed.expectedVersion) {
            throw new OptimisticVersionConflictError(
              'CashShift',
              parsed.shiftId,
              parsed.expectedVersion,
            );
          }

          if (recomputed.expectedClosingCashUzs < 0n) {
            throw new ApiHttpException({
              statusCode: 422,
              errorCode: 'VALIDATION_ERROR',
              message: `Cannot close shift with negative expected_closing_cash_uzs (${formatMoneyUzs(recomputed.expectedClosingCashUzs)} UZS)`,
            });
          }

          const discrepancyUzs =
            parsed.countedClosingCashUzs - recomputed.expectedClosingCashUzs;

          if (
            discrepancyUzs !== 0n &&
            (!parsed.discrepancyReason || parsed.discrepancyReason.trim().length < 3)
          ) {
            throw new ApiHttpException({
              statusCode: 422,
              errorCode: 'VALIDATION_ERROR',
              message: `discrepancy_reason (at least 3 characters) is mandatory when counted_closing_cash_uzs (${formatMoneyUzs(parsed.countedClosingCashUzs)} UZS) differs from expected_closing_cash_uzs (${formatMoneyUzs(recomputed.expectedClosingCashUzs)} UZS) by ${formatMoneyUzs(discrepancyUzs)} UZS (T11.01, BR-09)`,
            });
          }

          const updatedShift = await executeOptimisticUpdate<{ version: number }>(tx, {
            tableName: 'cash_shifts',
            entityName: 'CashShift',
            id: parsed.shiftId,
            centerId: principal.centerId,
            expectedVersion: parsed.expectedVersion,
            setClauseSql: `"counted_closing_cash_uzs" = $4::bigint, "discrepancy_uzs" = $5::bigint, "discrepancy_reason" = $6, "status" = 'CLOSED', "closed_by_admin_id" = $7::uuid, "closed_at" = $8::timestamptz`,
            additionalValues: [
              formatMoneyUzs(parsed.countedClosingCashUzs),
              formatMoneyUzs(discrepancyUzs),
              parsed.discrepancyReason,
              principal.staffId,
              nowUtc.toISOString(),
            ],
          });

          this.maybeInjectTestFault('SHIFT_CLOSE_UPDATE', options?.testFaultAfterStep);

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
               'CASH_SHIFT_CLOSED',
               'CashShift',
               $5::uuid,
               $6,
               $7::jsonb,
               $8::jsonb,
               $9,
               $10::timestamptz
             )`,
            [
              auditId,
              principal.centerId,
              principal.staffId,
              principal.role,
              parsed.shiftId,
              discrepancyUzs !== 0n ? 'WARN' : 'INFO',
              JSON.stringify({
                status: 'OPEN',
                version: currentShift.version,
              }),
              JSON.stringify({
                shift_id: parsed.shiftId,
                shift_date: currentShift.shift_date,
                status: 'CLOSED',
                opening_cash_uzs: formatMoneyUzs(recomputed.openingCashUzs),
                cash_receipts_uzs: formatMoneyUzs(recomputed.cashReceiptsUzs),
                non_cash_receipts_uzs: formatMoneyUzs(recomputed.nonCashReceiptsUzs),
                cash_refunds_uzs: formatMoneyUzs(recomputed.cashRefundsUzs),
                non_cash_refunds_uzs: formatMoneyUzs(recomputed.nonCashRefundsUzs),
                cash_expenses_uzs: formatMoneyUzs(recomputed.cashExpensesUzs),
                non_cash_expenses_uzs: formatMoneyUzs(recomputed.nonCashExpensesUzs),
                expected_closing_cash_uzs: formatMoneyUzs(recomputed.expectedClosingCashUzs),
                counted_closing_cash_uzs: formatMoneyUzs(parsed.countedClosingCashUzs),
                discrepancy_uzs: formatMoneyUzs(discrepancyUzs),
                discrepancy_reason: parsed.discrepancyReason,
                closed_by_admin_id: principal.staffId,
                version: Number(updatedShift.version),
              }),
              requestId,
              nowUtc.toISOString(),
            ],
          );

          this.maybeInjectTestFault('AUDIT_LOG', options?.testFaultAfterStep);

          const outboxId = crypto.randomUUID();
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
               'ShiftClosed',
               1,
               'CashShift',
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
              outboxId,
              principal.centerId,
              parsed.shiftId,
              Number(updatedShift.version),
              `ShiftClosed:${parsed.shiftId}:v${Number(updatedShift.version)}`,
              JSON.stringify({
                shift_id: parsed.shiftId,
                shift_date: currentShift.shift_date,
                opening_cash_uzs: formatMoneyUzs(recomputed.openingCashUzs),
                cash_receipts_uzs: formatMoneyUzs(recomputed.cashReceiptsUzs),
                non_cash_receipts_uzs: formatMoneyUzs(recomputed.nonCashReceiptsUzs),
                cash_refunds_uzs: formatMoneyUzs(recomputed.cashRefundsUzs),
                non_cash_refunds_uzs: formatMoneyUzs(recomputed.nonCashRefundsUzs),
                cash_expenses_uzs: formatMoneyUzs(recomputed.cashExpensesUzs),
                expected_closing_cash_uzs: formatMoneyUzs(recomputed.expectedClosingCashUzs),
                counted_closing_cash_uzs: formatMoneyUzs(parsed.countedClosingCashUzs),
                discrepancy_uzs: formatMoneyUzs(discrepancyUzs),
              }),
              nowUtc.toISOString(),
            ],
          );

          this.maybeInjectTestFault('OUTBOX_EVENT', options?.testFaultAfterStep);

          const closedSummary =
            await this.reconciliationService.buildShiftReconciliationDtoInTx(tx, {
              centerId: principal.centerId,
              shiftId: parsed.shiftId,
              lockShiftForUpdate: false,
              strictDriftCheck: true,
            });

          return {
            statusCode: 200,
            body: closedSummary.dto,
          };
        },
      },
    );

    return idemOutcome.body;
  }
}
