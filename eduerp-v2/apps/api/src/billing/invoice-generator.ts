/**
 * EduERP v2.0 — Stage 08, Step 08.04 (`T08.04`, `L02`) & Stage 13 (`S13FIX-T` / `T02`):
 * Idempotent BillingCycle & Invoice Generator, Durable Package Cycle -> Lesson Ownership Allocation (`L02`),
 * Authoritative Historical Tariff Snapshot, CreditNote Application Cap Boundary,
 * and Atomic Ledger/Audit/Outbox Execution via Shared Canonical Engine (`@eduerp/contracts`).
 */

import { Inject, Injectable } from '@nestjs/common';
import {
  BillingCycleType,
  CanonicalFaultInjectionStep,
  CanonicalInvoiceLineDto,
  CanonicalInvoiceResponseDto,
  CollectionTiming,
  DueDateRule,
  executeCanonicalBillingCycleIssuanceInTx,
  InvoiceStatus,
  loadCanonicalInvoiceResponseInTx,
} from '@eduerp/contracts';
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
import { runInTransaction, TransactionContext } from '../database/transaction';
import { parseOptionalStrictBoolean, validateIsoDate } from '../students/normalization';
import { BillingPolicyService } from './policy';

export type FaultInjectionStep = CanonicalFaultInjectionStep;
export type InvoiceLineDto = CanonicalInvoiceLineDto;
export type InvoiceResponseDto = CanonicalInvoiceResponseDto;

export interface InvoiceListResponseDto {
  readonly items: readonly InvoiceResponseDto[];
  readonly next_cursor: string | null;
}

export interface InternalIssueInvoiceParams {
  readonly centerId: string;
  readonly enrollmentId: string;
  readonly cycleType: BillingCycleType;
  readonly cycleKey: string;
  readonly periodStartDate: string;
  readonly periodEndDate?: string | null;
  readonly applyAvailableCreditNotes?: boolean;
  readonly actorType: 'STAFF' | 'SYSTEM_WORKER';
  readonly actorStaffId: string | null;
  readonly actorRole: string | null;
  readonly systemJobName: string | null;
  readonly requestId: string;
  readonly now: Date;
  readonly overrideBillingStartDate?: string;
  readonly testFaultAfterStep?: FaultInjectionStep;
}

const ALLOWED_CYCLE_TYPES: ReadonlySet<BillingCycleType> = new Set([
  'CALENDAR_MONTH',
  'ROLLING_MONTH',
  'LESSON_PACKAGE_12',
]);

const createApiHttpError = (spec: {
  readonly statusCode: number;
  readonly errorCode: string;
  readonly message: string;
}): Error =>
  new ApiHttpException({
    statusCode: spec.statusCode,
    errorCode: spec.errorCode as ConstructorParameters<typeof ApiHttpException>[0]['errorCode'],
    message: spec.message,
  });

@Injectable()
export class InvoiceGeneratorService {
  constructor(
    @Inject(API_CONFIG_TOKEN) private readonly config: ApiEnvConfig,
    @Inject(DatabaseService) private readonly databaseService: DatabaseService,
    @Inject(ClockService) private readonly clock: ClockService,
    @Inject(BillingPolicyService) private readonly policyService: BillingPolicyService,
  ) {}

  public async loadInvoiceResponseInTx(
    tx: Pick<DatabaseService, 'query'> | TransactionContext,
    centerId: string,
    invoiceId: string,
  ): Promise<InvoiceResponseDto> {
    return loadCanonicalInvoiceResponseInTx(tx, centerId, invoiceId, createApiHttpError);
  }

  /**
   * Core transactional BillingCycle + Package Lesson Allocations + Invoice + InvoiceLine + LedgerEntry + AuditLog + OutboxEvent execution.
   * Delegates directly to the single shared canonical billing engine in `@eduerp/contracts` (`S13FIX-T` / `T02`).
   */
  public async issueCycleInvoiceWithinTransaction(
    tx: TransactionContext,
    params: InternalIssueInvoiceParams,
  ): Promise<{ readonly invoice: InvoiceResponseDto; readonly replayedByCycleIdentity: boolean }> {
    return executeCanonicalBillingCycleIssuanceInTx(tx, {
      ...params,
      enableTestFaultInjection: this.config.nodeEnv === 'test',
      createError: createApiHttpError,
    });
  }

  public async issueBillingCycleInvoice(
    req: RequestWithCorrelationId,
    principal: AuthenticatedStaffPrincipal,
    rawBody: unknown,
    options?: { readonly testFaultAfterStep?: FaultInjectionStep },
  ): Promise<InvoiceResponseDto> {
    const idempotencyKey = requireIdempotencyKeyHeader(req);
    const obj = assertPlainObject(rawBody, [
      'enrollment_id',
      'cycle_type',
      'cycle_key',
      'period_start_date',
      'period_end_date',
      'apply_available_credit_notes',
    ]);

    const enrollmentId = assertValidUuid(obj.enrollment_id, 'enrollment_id');
    const cycleTypeRaw =
      typeof obj.cycle_type === 'string' ? obj.cycle_type.trim().toUpperCase() : '';
    if (!ALLOWED_CYCLE_TYPES.has(cycleTypeRaw as BillingCycleType)) {
      throw new ApiHttpException({
        statusCode: 400,
        errorCode: 'VALIDATION_ERROR',
        message: 'cycle_type must be CALENDAR_MONTH, ROLLING_MONTH, or LESSON_PACKAGE_12',
      });
    }
    const cycleType = cycleTypeRaw as BillingCycleType;

    const cycleKey = typeof obj.cycle_key === 'string' ? obj.cycle_key.trim() : '';
    if (cycleKey.length < 3 || cycleKey.length > 64) {
      throw new ApiHttpException({
        statusCode: 400,
        errorCode: 'VALIDATION_ERROR',
        message: 'cycle_key must be between 3 and 64 characters',
      });
    }

    const periodStartDate = validateIsoDate(obj.period_start_date, 'period_start_date');
    const periodEndDate =
      obj.period_end_date !== undefined && obj.period_end_date !== null
        ? validateIsoDate(obj.period_end_date, 'period_end_date')
        : null;
    if (periodEndDate !== null && periodEndDate < periodStartDate) {
      throw new ApiHttpException({
        statusCode: 422,
        errorCode: 'VALIDATION_ERROR',
        message: 'period_end_date cannot be earlier than period_start_date',
      });
    }

    const applyAvailableCreditNotes = parseOptionalStrictBoolean(
      obj.apply_available_credit_notes,
      'apply_available_credit_notes',
      true,
    );

    const requestId = req.requestId ?? resolveRequestId(req.headers['x-request-id']);
    const now = this.clock.now();

    const idemOutcome = await executeIdempotentOperation<InvoiceResponseDto>(
      this.databaseService,
      {
        centerId: principal.centerId,
        actorStaffId: principal.staffId,
        operationType: 'ISSUE_BILLING_CYCLE_INVOICE',
        idempotencyKey,
        requestPayload: {
          enrollment_id: enrollmentId,
          cycle_type: cycleType,
          cycle_key: cycleKey,
          period_start_date: periodStartDate,
          period_end_date: periodEndDate,
          apply_available_credit_notes: applyAvailableCreditNotes,
        },
        authorizeBeforeReplayOrExecute: async (tx) => {
          const enrCheck = await tx.query<{ id: string }>(
            `SELECT "id"::text AS id
               FROM "enrollments"
              WHERE "id" = $1::uuid
                AND "center_id" = $2::uuid
              FOR UPDATE`,
            [enrollmentId, principal.centerId],
          );
          if (!enrCheck.rows[0]) {
            throw new ApiHttpException({
              statusCode: 404,
              errorCode: 'NOT_FOUND',
              message: 'Enrollment not found in center scope',
            });
          }
        },
        handler: async (tx) => {
          const { invoice } = await this.issueCycleInvoiceWithinTransaction(tx, {
            centerId: principal.centerId,
            enrollmentId,
            cycleType,
            cycleKey,
            periodStartDate,
            periodEndDate,
            applyAvailableCreditNotes,
            actorType: 'STAFF',
            actorStaffId: principal.staffId,
            actorRole: principal.role,
            systemJobName: null,
            requestId,
            now,
            testFaultAfterStep: options?.testFaultAfterStep,
          });
          return {
            statusCode: 200,
            body: invoice,
          };
        },
      },
    );

    return idemOutcome.body;
  }

  public async getInvoiceDetails(
    principal: AuthenticatedStaffPrincipal,
    rawInvoiceId: unknown,
  ): Promise<InvoiceResponseDto> {
    const invoiceId = assertValidUuid(rawInvoiceId, 'invoice_id');
    return this.loadInvoiceResponseInTx(this.databaseService, principal.centerId, invoiceId);
  }

  public async listStudentInvoices(
    principal: AuthenticatedStaffPrincipal,
    rawStudentId: unknown,
    rawLimit?: unknown,
  ): Promise<InvoiceListResponseDto> {
    const studentId = assertValidUuid(rawStudentId, 'student_id');
    const limitNum = rawLimit === undefined ? 50 : Number(rawLimit);
    const limit = Number.isInteger(limitNum) && limitNum >= 1 && limitNum <= 100 ? limitNum : 50;

    const stuCheck = await this.databaseService.query<{ id: string }>(
      `SELECT "id"::text AS id
         FROM "students"
        WHERE "id" = $1::uuid
          AND "center_id" = $2::uuid
        LIMIT 1`,
      [studentId, principal.centerId],
    );
    if (!stuCheck.rows[0]) {
      throw new ApiHttpException({
        statusCode: 404,
        errorCode: 'NOT_FOUND',
        message: 'Student not found in center scope',
      });
    }

    const invIdsRes = await this.databaseService.query<{ id: string }>(
      `SELECT "id"::text AS id
         FROM "invoices"
        WHERE "center_id" = $1::uuid
          AND "student_id" = $2::uuid
        ORDER BY "issued_at" DESC, "id" DESC
        LIMIT $3::int`,
      [principal.centerId, studentId, limit],
    );

    const items: InvoiceResponseDto[] = [];
    for (const row of invIdsRes.rows) {
      items.push(
        await this.loadInvoiceResponseInTx(this.databaseService, principal.centerId, row.id),
      );
    }

    return Object.freeze({
      items: Object.freeze(items),
      next_cursor: null,
    });
  }

  public async issueWorkerInvoiceForCycle(params: {
    readonly centerId: string;
    readonly enrollmentId: string;
    readonly cycleType: BillingCycleType;
    readonly cycleKey: string;
    readonly periodStartDate: string;
    readonly periodEndDate?: string | null;
    readonly systemJobName: string;
    readonly testFaultAfterStep?: FaultInjectionStep;
  }): Promise<{ readonly invoice: InvoiceResponseDto; readonly replayedByCycleIdentity: boolean }> {
    const { result } = await runInTransaction(this.databaseService, async (tx) => {
      return this.issueCycleInvoiceWithinTransaction(tx, {
        centerId: params.centerId,
        enrollmentId: params.enrollmentId,
        cycleType: params.cycleType,
        cycleKey: params.cycleKey,
        periodStartDate: params.periodStartDate,
        periodEndDate: params.periodEndDate,
        applyAvailableCreditNotes: true,
        actorType: 'SYSTEM_WORKER',
        actorStaffId: null,
        actorRole: null,
        systemJobName: params.systemJobName,
        requestId: `worker-${crypto.randomUUID()}`,
        now: this.clock.now(),
        testFaultAfterStep: params.testFaultAfterStep,
      });
    });
    return result;
  }
}
