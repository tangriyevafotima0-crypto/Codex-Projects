/**
 * EduERP v2.0 — Stage 13, Step 13.01 (`T13.01`, `S2F04`, `B13`, `B14`, `BR-15`, `BR-17`, `D09`, `D17`, `S13FIX-T` / `T03` & `T04`):
 * Transactional Outbox Lease Acquisition (`FOR UPDATE SKIP LOCKED`), Monotonic `lease_token` Fencing,
 * Predecessor `aggregate_version` Ordering Gate, Versioned Event Registry (`CANONICAL_OUTBOX_EVENT_REGISTRY`),
 * Atomic `OutboxConsumerReceipt` Deduplication, Fail-Closed Default Production Transport Adapter
 * (`UnboundFailClosedNotificationTransportAdapter`), Durable Pre-Send Attempt Persistence & Fenced Delivery Transitions,
 * Live Pre-Send Notification Policy Re-Verification (`T03`), Exact Guardian–Student Child Scope & Recipient-Specific
 * Payload Projection (`T04`), Selective Restore Reconciliation, Bounded Exponential Backoff (`attempt_count <= 8`)
 * with Deferred-Wait Budget Preservation, and `DEAD_LETTER` Handling.
 */

import * as crypto from 'node:crypto';
import {
  computeOutboxBackoffDelaySeconds,
  NotificationDeliveryStatus,
  NotificationRecipientType,
  OUTBOX_MAX_ATTEMPTS,
  OutboxEventStatus,
  PromiseReminderChannelPolicy,
} from '@eduerp/contracts';
import { WorkerEnvConfig } from './config/env';
import {
  formatCenterLocalDateParts,
  sanitizeWorkerErrorMessage,
  WorkerDatabase,
  WorkerQueryExecutor,
} from './database';

export const SYSTEM_ALLOWLIST_OUTBOX_EVENTS: ReadonlySet<string> = new Set([
  'LicenseStateChanged',
]);

export type OutboxEventRoutingKind =
  | 'NOTIFICATION_ONLY'
  | 'INTERNAL_AND_NOTIFICATION'
  | 'INTERNAL_ONLY';

export interface CanonicalOutboxEventContractSpec {
  readonly eventName: string;
  readonly supportedSchemaVersions: ReadonlySet<number>;
  readonly routingKind: OutboxEventRoutingKind;
  readonly supersededOnRestore: boolean;
}

export const CANONICAL_OUTBOX_EVENT_REGISTRY: ReadonlyMap<
  string,
  CanonicalOutboxEventContractSpec
> = new Map<string, CanonicalOutboxEventContractSpec>([
  [
    'PaymentRecorded',
    {
      eventName: 'PaymentRecorded',
      supportedSchemaVersions: new Set([1]),
      routingKind: 'NOTIFICATION_ONLY',
      supersededOnRestore: true,
    },
  ],
  [
    'AllocationAdjusted',
    {
      eventName: 'AllocationAdjusted',
      supportedSchemaVersions: new Set([1]),
      routingKind: 'INTERNAL_ONLY',
      supersededOnRestore: false,
    },
  ],
  [
    'RefundRecorded',
    {
      eventName: 'RefundRecorded',
      supportedSchemaVersions: new Set([1]),
      routingKind: 'INTERNAL_AND_NOTIFICATION',
      supersededOnRestore: true,
    },
  ],
  [
    'ExpenseRecorded',
    {
      eventName: 'ExpenseRecorded',
      supportedSchemaVersions: new Set([1]),
      routingKind: 'INTERNAL_ONLY',
      supersededOnRestore: false,
    },
  ],
  [
    'ExpenseReversed',
    {
      eventName: 'ExpenseReversed',
      supportedSchemaVersions: new Set([1]),
      routingKind: 'INTERNAL_ONLY',
      supersededOnRestore: false,
    },
  ],
  [
    'AttendanceSubmitted',
    {
      eventName: 'AttendanceSubmitted',
      supportedSchemaVersions: new Set([1]),
      routingKind: 'INTERNAL_AND_NOTIFICATION',
      supersededOnRestore: true,
    },
  ],
  [
    'AttendanceCorrected',
    {
      eventName: 'AttendanceCorrected',
      supportedSchemaVersions: new Set([1]),
      routingKind: 'INTERNAL_AND_NOTIFICATION',
      supersededOnRestore: true,
    },
  ],
  [
    'TrialActivated',
    {
      eventName: 'TrialActivated',
      supportedSchemaVersions: new Set([1]),
      routingKind: 'INTERNAL_ONLY',
      supersededOnRestore: false,
    },
  ],
  [
    'TrialCompensated',
    {
      eventName: 'TrialCompensated',
      supportedSchemaVersions: new Set([1]),
      routingKind: 'INTERNAL_ONLY',
      supersededOnRestore: false,
    },
  ],
  [
    'DiscountApproved',
    {
      eventName: 'DiscountApproved',
      supportedSchemaVersions: new Set([1]),
      routingKind: 'INTERNAL_ONLY',
      supersededOnRestore: false,
    },
  ],
  [
    'FreezeCreditIssued',
    {
      eventName: 'FreezeCreditIssued',
      supportedSchemaVersions: new Set([1]),
      routingKind: 'INTERNAL_ONLY',
      supersededOnRestore: false,
    },
  ],
  [
    'PromiseDue',
    {
      eventName: 'PromiseDue',
      supportedSchemaVersions: new Set([1]),
      routingKind: 'INTERNAL_AND_NOTIFICATION',
      supersededOnRestore: true,
    },
  ],
  [
    'PromiseFulfilled',
    {
      eventName: 'PromiseFulfilled',
      supportedSchemaVersions: new Set([1]),
      routingKind: 'INTERNAL_ONLY',
      supersededOnRestore: false,
    },
  ],
  [
    'TeacherPingDue',
    {
      eventName: 'TeacherPingDue',
      supportedSchemaVersions: new Set([1]),
      routingKind: 'NOTIFICATION_ONLY',
      supersededOnRestore: true,
    },
  ],
  [
    'ShiftClosed',
    {
      eventName: 'ShiftClosed',
      supportedSchemaVersions: new Set([1]),
      routingKind: 'NOTIFICATION_ONLY',
      supersededOnRestore: true,
    },
  ],
  [
    'GuardianLinkRevoked',
    {
      eventName: 'GuardianLinkRevoked',
      supportedSchemaVersions: new Set([1]),
      routingKind: 'INTERNAL_ONLY',
      supersededOnRestore: false,
    },
  ],
  [
    'LicenseStateChanged',
    {
      eventName: 'LicenseStateChanged',
      supportedSchemaVersions: new Set([1]),
      routingKind: 'INTERNAL_ONLY',
      supersededOnRestore: false,
    },
  ],
]);

export interface LeasedOutboxEventRow {
  readonly id: string;
  readonly center_id: string;
  readonly event_name: string;
  readonly schema_version: number;
  readonly aggregate_type: string;
  readonly aggregate_id: string;
  readonly aggregate_version: number;
  readonly dedup_key: string;
  readonly payload_json: Record<string, unknown>;
  readonly status: OutboxEventStatus;
  readonly attempt_count: number;
  readonly lease_token: bigint;
  readonly leased_by_worker: string | null;
  readonly lease_until: Date | null;
  readonly next_attempt_at: Date;
  readonly last_error: string | null;
  readonly occurred_at_utc: Date;
  readonly processed_at_utc: Date | null;
}

export class StaleLeaseTokenError extends Error {
  public readonly eventId: string;
  public readonly attemptedLeaseToken: bigint;

  constructor(eventId: string, attemptedLeaseToken: bigint) {
    super(
      `STALE_LEASE_FENCING_REJECTED: Outbox event ${eventId} is no longer leased under lease_token=${attemptedLeaseToken.toString(10)}`,
    );
    this.name = 'StaleLeaseTokenError';
    this.eventId = eventId;
    this.attemptedLeaseToken = attemptedLeaseToken;
  }
}

export class NonRetryablePoisonEventError extends Error {
  public readonly errorCode: string;

  constructor(errorCode: string, message: string) {
    super(message);
    this.name = 'NonRetryablePoisonEventError';
    this.errorCode = errorCode;
  }
}

export interface InternalConsumerExecutionResult {
  readonly consumerName: string;
  readonly consumerReceiptKey: string;
  readonly deduplicated: boolean;
  readonly fencingLeaseToken: bigint;
  readonly effectSummary: Record<string, unknown>;
}

export interface ExternalNotificationSendRequest {
  readonly centerId: string;
  readonly outboxEventId: string;
  readonly eventName: string;
  readonly deliveryId: string;
  readonly recipientType: NotificationRecipientType;
  readonly recipientId: string;
  readonly telegramChatId: bigint | null;
  readonly leaseToken: bigint;
  readonly attemptNumber: number;
  readonly payload: Record<string, unknown>;
}

export type ExternalNotificationSendOutcome =
  | {
      readonly status: 'API_ACCEPTED';
      readonly telegramMessageId: bigint;
    }
  | {
      readonly status: 'RETRY_429';
      readonly retryAfterSeconds: number;
    }
  | {
      readonly status: 'FAILED_403_BLOCKED';
    }
  | {
      readonly status: 'TRANSIENT_NETWORK_ERROR';
      readonly reason: string;
    }
  | {
      readonly status: 'DEFERRED_TRANSPORT_NOT_BOUND';
      readonly reason: string;
    };

export interface ExternalNotificationTransportAdapter {
  sendNotification(
    request: ExternalNotificationSendRequest,
  ): Promise<ExternalNotificationSendOutcome>;
}

/**
 * S02 Production-Safe Fail-Closed Default Transport Adapter:
 * Until Stage 14 (`14.04`) binds the real Telegram outbound adapter, the worker runtime
 * NEVER fabricates `API_ACCEPTED` or fake `telegram_message_id` values in production.
 * Instead it returns `DEFERRED_TRANSPORT_NOT_BOUND`, keeping deliveries `QUEUED` and
 * releasing the outbox event back to `PENDING` without burning the 8-attempt poison budget.
 */
export class UnboundFailClosedNotificationTransportAdapter
  implements ExternalNotificationTransportAdapter
{
  public async sendNotification(
    _request: ExternalNotificationSendRequest,
  ): Promise<ExternalNotificationSendOutcome> {
    return {
      status: 'DEFERRED_TRANSPORT_NOT_BOUND',
      reason:
        'TELEGRAM_TRANSPORT_NOT_BOUND_S13: Live Telegram outbound transport is bound in Stage 14 (14.04); fake API_ACCEPTED is forbidden',
    };
  }
}

export type SyntheticAdapterMode =
  | 'ACCEPT_OK'
  | 'CRASH_BEFORE_SEND'
  | 'CRASH_AFTER_SEND_BEFORE_ACK'
  | 'CRASH_AFTER_SEND_NO_MEMORY_FLAG'
  | 'RATE_LIMIT_429'
  | 'BLOCKED_403'
  | 'TRANSIENT_TIMEOUT';

export class SyntheticNotificationTransportAdapter
  implements ExternalNotificationTransportAdapter
{
  private mode: SyntheticAdapterMode = 'ACCEPT_OK';
  private nextMessageId = 900_000n;
  private preSendHook: ((request: ExternalNotificationSendRequest) => Promise<void>) | null =
    null;
  private readonly sentExternalLog: Array<{
    readonly deliveryId: string;
    readonly outboxEventId: string;
    readonly recipientId: string;
    readonly leaseToken: string;
    readonly telegramMessageId: string;
    readonly payload: Record<string, unknown>;
  }> = [];

  public setMode(mode: SyntheticAdapterMode): void {
    this.mode = mode;
  }

  public setPreSendHook(
    hook: ((request: ExternalNotificationSendRequest) => Promise<void>) | null,
  ): void {
    this.preSendHook = hook;
  }

  public getSentExternalLog(): ReadonlyArray<{
    readonly deliveryId: string;
    readonly outboxEventId: string;
    readonly recipientId: string;
    readonly leaseToken: string;
    readonly telegramMessageId: string;
    readonly payload: Record<string, unknown>;
  }> {
    return [...this.sentExternalLog];
  }

  public async sendNotification(
    request: ExternalNotificationSendRequest,
  ): Promise<ExternalNotificationSendOutcome> {
    if (this.preSendHook) {
      await this.preSendHook(request);
    }

    if (this.mode === 'CRASH_BEFORE_SEND') {
      throw new Error('SIMULATED_TRANSPORT_CRASH_BEFORE_EXTERNAL_SEND');
    }
    if (this.mode === 'RATE_LIMIT_429') {
      return { status: 'RETRY_429', retryAfterSeconds: 30 };
    }
    if (this.mode === 'BLOCKED_403') {
      return { status: 'FAILED_403_BLOCKED' };
    }
    if (this.mode === 'TRANSIENT_TIMEOUT') {
      return { status: 'TRANSIENT_NETWORK_ERROR', reason: 'Simulated upstream socket timeout' };
    }

    this.nextMessageId += 1n;
    const msgId = this.nextMessageId;
    this.sentExternalLog.push({
      deliveryId: request.deliveryId,
      outboxEventId: request.outboxEventId,
      recipientId: request.recipientId,
      leaseToken: request.leaseToken.toString(10),
      telegramMessageId: msgId.toString(10),
      payload: JSON.parse(JSON.stringify(request.payload)) as Record<string, unknown>,
    });

    if (this.mode === 'CRASH_AFTER_SEND_BEFORE_ACK') {
      const err = new Error(
        `SIMULATED_CRASH_AFTER_EXTERNAL_SEND: message_id=${msgId.toString(10)} sent to external provider before local DB ACK commit (at-least-once ambiguity window)`,
      );
      (err as { externalSendAlreadyOccurred?: boolean }).externalSendAlreadyOccurred = true;
      throw err;
    }

    if (this.mode === 'CRASH_AFTER_SEND_NO_MEMORY_FLAG') {
      throw new Error('SIMULATED_ABRUPT_PROCESS_LOSS_AFTER_EXTERNAL_SEND');
    }

    return {
      status: 'API_ACCEPTED',
      telegramMessageId: msgId,
    };
  }
}

export type OutboxInternalConsumerHandler = (
  tx: WorkerQueryExecutor,
  event: LeasedOutboxEventRow,
  nowUtc: Date,
) => Promise<Record<string, unknown>>;

function formatPgDate(val: unknown): string | null {
  if (val === null || val === undefined || val === '') return null;
  if (val instanceof Date) return val.toISOString().slice(0, 10);
  const s = String(val).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

/**
 * T04: Extracts all distinct target student UUIDs referenced in an outbox event payload
 * (`student_id`, `student_ids`, `absent_student_ids`, `late_student_ids`, `present_student_ids`).
 */
export function extractEventTargetStudentIds(
  payload: Record<string, unknown>,
  fallbackTargetStudentId?: string | null,
): string[] {
  const ids = new Set<string>();
  if (typeof fallbackTargetStudentId === 'string' && fallbackTargetStudentId.trim()) {
    ids.add(fallbackTargetStudentId.trim());
  }
  if (typeof payload.student_id === 'string' && payload.student_id.trim()) {
    ids.add(payload.student_id.trim());
  }
  for (const arrayKey of [
    'student_ids',
    'absent_student_ids',
    'late_student_ids',
    'present_student_ids',
  ] as const) {
    const arr = payload[arrayKey];
    if (Array.isArray(arr)) {
      for (const item of arr) {
        if (typeof item === 'string' && item.trim()) {
          ids.add(item.trim());
        }
      }
    }
  }
  for (const objArrayKey of ['records', 'student_records', 'items', 'students'] as const) {
    const arr = payload[objArrayKey];
    if (Array.isArray(arr)) {
      for (const item of arr) {
        if (item && typeof item === 'object' && typeof (item as { student_id?: unknown }).student_id === 'string') {
          const sid = ((item as { student_id: string }).student_id).trim();
          if (sid) ids.add(sid);
        }
      }
    }
  }
  return [...ids];
}

/**
 * T04: Builds a strict recipient-scoped payload projection for a `GUARDIAN` recipient so that
 * batch events (`AttendanceSubmitted`, `AttendanceCorrected`) NEVER leak another child's UUID,
 * attendance status, grade, or financial fields to an unrelated guardian (`BR-02`, `S13FIX-T`).
 */
export function buildGuardianScopedPayloadProjection(
  rawPayload: Record<string, unknown>,
  permittedStudentIds: readonly string[],
): Record<string, unknown> {
  const permittedSet = new Set(permittedStudentIds);
  const projected: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(rawPayload)) {
    if (
      key === 'absent_student_ids' ||
      key === 'late_student_ids' ||
      key === 'present_student_ids' ||
      key === 'student_ids'
    ) {
      if (Array.isArray(value)) {
        projected[key] = value.filter(
          (id): id is string => typeof id === 'string' && permittedSet.has(id.trim()),
        );
      }
      continue;
    }
    if (
      key === 'records' ||
      key === 'student_records' ||
      key === 'items' ||
      key === 'students'
    ) {
      if (Array.isArray(value)) {
        projected[key] = value.filter(
          (item) =>
            item &&
            typeof item === 'object' &&
            typeof (item as { student_id?: unknown }).student_id === 'string' &&
            permittedSet.has(((item as { student_id: string }).student_id).trim()),
        );
      }
      continue;
    }
    if (key === 'student_id') {
      continue;
    }
    projected[key] = value;
  }

  projected.student_ids = [...permittedSet];
  projected.student_id = permittedStudentIds[0] ?? null;
  return projected;
}

export class OutboxWorker {
  private readonly internalConsumers = new Map<
    string,
    Array<{
      readonly consumerName: string;
      readonly buildReceiptKey: (event: LeasedOutboxEventRow) => string;
      readonly handler: OutboxInternalConsumerHandler;
    }>
  >();

  constructor(
    private readonly config: WorkerEnvConfig,
    private readonly db: WorkerDatabase,
    private readonly transportAdapter: ExternalNotificationTransportAdapter = new UnboundFailClosedNotificationTransportAdapter(),
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.registerDefaultInternalConsumers();
  }

  public registerInternalConsumer(
    eventName: string,
    spec: {
      readonly consumerName: string;
      readonly buildReceiptKey: (event: LeasedOutboxEventRow) => string;
      readonly handler: OutboxInternalConsumerHandler;
    },
  ): void {
    const list = this.internalConsumers.get(eventName) ?? [];
    list.push(spec);
    this.internalConsumers.set(eventName, list);
  }

  private registerDefaultInternalConsumers(): void {
    // 1. AllocationAdjusted -> PromiseLifecycleConsumer
    this.registerInternalConsumer('AllocationAdjusted', {
      consumerName: 'PromiseLifecycleConsumer',
      buildReceiptKey: (ev) => `PromiseLifecycleConsumer:${ev.id}:${ev.aggregate_id}`,
      handler: async (tx, ev, nowUtc) => {
        const invoiceId = String(ev.payload_json.invoice_id ?? ev.aggregate_id);
        const invRes = await tx.query<{ remaining_debt_uzs: string; status: string }>(
          `SELECT "remaining_debt_uzs"::text AS remaining_debt_uzs, "status"::text AS status
             FROM "invoices"
            WHERE "id" = $1::uuid AND "center_id" = $2::uuid
            FOR UPDATE`,
          [invoiceId, ev.center_id],
        );
        const inv = invRes.rows[0];
        if (!inv || BigInt(inv.remaining_debt_uzs) > 0n) {
          return { invoice_id: invoiceId, promises_updated: 0 };
        }
        const updRes = await tx.query<{ id: string }>(
          `UPDATE "promises_to_pay"
              SET "status" = 'FULFILLED',
                  "version" = "version" + 1,
                  "updated_at" = $3::timestamptz
            WHERE "center_id" = $1::uuid
              AND "invoice_id" = $2::uuid
              AND "status" IN ('ACTIVE', 'OVERDUE_NOTIFIED')
            RETURNING "id"::text AS id`,
          [ev.center_id, invoiceId, nowUtc.toISOString()],
        );
        return {
          invoice_id: invoiceId,
          promises_fulfilled_ids: updRes.rows.map((r) => r.id),
        };
      },
    });

    // 2. GuardianLinkRevoked -> BotSessionCacheConsumer
    this.registerInternalConsumer('GuardianLinkRevoked', {
      consumerName: 'BotSessionCacheConsumer',
      buildReceiptKey: (ev) => `BotSessionCacheConsumer:${ev.id}:${ev.aggregate_id}`,
      handler: async (tx, ev, nowUtc) => {
        const guardianId = String(ev.payload_json.guardian_id ?? '');
        if (!guardianId) {
          return { skipped_deliveries: 0 };
        }
        const skipRes = await tx.query<{ id: string }>(
          `UPDATE "notification_deliveries"
              SET "delivery_status" = 'SKIPPED_UNLINKED',
                  "version" = "version" + 1,
                  "updated_at" = $3::timestamptz
            WHERE "center_id" = $1::uuid
              AND "recipient_type" = 'GUARDIAN'
              AND "recipient_id" = $2::uuid
              AND "delivery_status" IN ('QUEUED', 'RETRY_429')
            RETURNING "id"::text AS id`,
          [ev.center_id, guardianId, nowUtc.toISOString()],
        );
        return {
          guardian_id: guardianId,
          skipped_deliveries: skipRes.rows.length,
        };
      },
    });

    // 3. PromiseFulfilled -> SchedulerCancelConsumer
    this.registerInternalConsumer('PromiseFulfilled', {
      consumerName: 'SchedulerCancelConsumer',
      buildReceiptKey: (ev) => `SchedulerCancelConsumer:${ev.id}:${ev.aggregate_id}`,
      handler: async (tx, ev, nowUtc) => {
        const promiseId = String(ev.payload_json.promise_id ?? ev.aggregate_id);
        const skipRes = await tx.query<{ id: string }>(
          `UPDATE "notification_deliveries" AS nd
              SET "delivery_status" = 'SKIPPED_UNLINKED',
                  "version" = nd."version" + 1,
                  "updated_at" = $3::timestamptz
             FROM "outbox_events" AS oe
            WHERE nd."outbox_event_id" = oe."id"
              AND nd."center_id" = oe."center_id"
              AND oe."center_id" = $1::uuid
              AND oe."event_name" = 'PromiseDue'
              AND oe."aggregate_id" = $2::uuid
              AND nd."delivery_status" IN ('QUEUED', 'RETRY_429')
            RETURNING nd."id"::text AS id`,
          [ev.center_id, promiseId, nowUtc.toISOString()],
        );
        return {
          promise_id: promiseId,
          suppressed_due_deliveries: skipRes.rows.length,
        };
      },
    });

    // 4. PromiseDue -> AdminTaskConsumer
    this.registerInternalConsumer('PromiseDue', {
      consumerName: 'AdminTaskConsumer',
      buildReceiptKey: (ev) => `AdminTaskConsumer:${ev.id}:${ev.aggregate_id}`,
      handler: async (_tx, ev) => ({
        promise_id: String(ev.payload_json.promise_id ?? ev.aggregate_id),
        invoice_id: String(ev.payload_json.invoice_id ?? ''),
        verified_remaining_debt_uzs: String(ev.payload_json.verified_remaining_debt_uzs ?? '0'),
      }),
    });

    // 5. LicenseStateChanged -> CenterLicenseGuardConsumer
    this.registerInternalConsumer('LicenseStateChanged', {
      consumerName: 'CenterLicenseGuardConsumer',
      buildReceiptKey: (ev) => `CenterLicenseGuardConsumer:${ev.id}:${ev.center_id}`,
      handler: async (_tx, ev) => ({
        center_id: ev.center_id,
        new_license_mode: String(ev.payload_json.new_license_mode ?? ''),
      }),
    });

    // 6. Documented internal/audit consumer receipts for financial & academic domain events
    for (const [evtName, consumerName] of [
      ['ExpenseRecorded', 'CashShiftExpenseProjectionConsumer'],
      ['ExpenseReversed', 'CashShiftExpenseProjectionConsumer'],
      ['TrialActivated', 'TrialActivationAuditConsumer'],
      ['TrialCompensated', 'TrialCompensationAuditConsumer'],
      ['DiscountApproved', 'DiscountAdjustmentAuditConsumer'],
      ['FreezeCreditIssued', 'FreezeCreditAuditConsumer'],
      ['RefundRecorded', 'ShiftAndReportConsumer'],
      ['AttendanceSubmitted', 'AttendanceProjectionConsumer'],
      ['AttendanceCorrected', 'AttendanceCorrectionProjectionConsumer'],
    ] as const) {
      this.registerInternalConsumer(evtName, {
        consumerName,
        buildReceiptKey: (ev) => `${consumerName}:${ev.id}:${ev.aggregate_id}`,
        handler: async (_tx, ev) => ({
          event_name: ev.event_name,
          aggregate_type: ev.aggregate_type,
          aggregate_id: ev.aggregate_id,
          aggregate_version: ev.aggregate_version,
        }),
      });
    }
  }

  /**
   * Ensures that notification-bearing events emitted by API services (`PaymentRecorded`,
   * `RefundRecorded`, `AttendanceSubmitted`, `AttendanceCorrected`, `ShiftClosed`) have their
   * canonical `notification_deliveries` rows staged inside a fenced transaction before delivery fanout (`T04`).
   * For `GUARDIAN` deliveries, computes exact per-guardian permitted `student_id` subset and
   * persists `target_student_id` + `payload_projection_json` so batch attendance events never leak
   * another student's data.
   */
  private async ensureNotificationDeliveriesStagedFenced(
    event: LeasedOutboxEventRow,
    nowUtc: Date,
  ): Promise<void> {
    const existingCountRes = await this.db.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt
         FROM "notification_deliveries"
        WHERE "center_id" = $1::uuid
          AND "outbox_event_id" = $2::uuid`,
      [event.center_id, event.id],
    );
    if (Number(existingCountRes.rows[0]?.cnt ?? '0') > 0) {
      return;
    }

    const requiresGuardianFanout =
      event.event_name === 'PaymentRecorded' ||
      event.event_name === 'AttendanceSubmitted' ||
      event.event_name === 'AttendanceCorrected';
    const requiresDirectorFanout =
      event.event_name === 'ShiftClosed' || event.event_name === 'RefundRecorded';

    if (!requiresGuardianFanout && !requiresDirectorFanout) {
      return;
    }

    await this.db.runInTransaction(async (tx) => {
      const fenceRes = await tx.query<{ id: string }>(
        `SELECT "id"::text AS id
           FROM "outbox_events"
          WHERE "id" = $1::uuid
            AND "center_id" = $2::uuid
            AND "status" = 'LEASED'
            AND "lease_token" = $3::bigint
          FOR UPDATE`,
        [event.id, event.center_id, event.lease_token.toString(10)],
      );
      if (fenceRes.rows.length === 0) {
        throw new StaleLeaseTokenError(event.id, event.lease_token);
      }

      if (requiresGuardianFanout) {
        const studentIdList = extractEventTargetStudentIds(event.payload_json);
        if (studentIdList.length > 0) {
          const guardiansRes = await tx.query<{
            guardian_id: string;
            student_id: string;
            telegram_chat_id: string | null;
          }>(
            `SELECT gs."guardian_id"::text AS guardian_id,
                    gs."student_id"::text AS student_id,
                    gtl."telegram_chat_id"::text AS telegram_chat_id
               FROM "guardian_students" gs
               JOIN "guardians" g
                 ON g."id" = gs."guardian_id"
                AND g."center_id" = gs."center_id"
               JOIN "students" s
                 ON s."id" = gs."student_id"
                AND s."center_id" = gs."center_id"
               LEFT JOIN "guardian_telegram_links" gtl
                 ON gtl."center_id" = gs."center_id"
                AND gtl."guardian_id" = gs."guardian_id"
                AND gtl."status" = 'ACTIVE'
              WHERE gs."center_id" = $1::uuid
                AND gs."student_id" = ANY($2::uuid[])
                AND gs."active" = TRUE
                AND g."status" = 'ACTIVE'
                AND s."status" = 'ACTIVE'
              ORDER BY gs."guardian_id" ASC, gs."student_id" ASC`,
            [event.center_id, studentIdList],
          );

          const byGuardian = new Map<
            string,
            { readonly telegramChatId: string | null; readonly studentIds: string[] }
          >();
          for (const row of guardiansRes.rows) {
            const existing = byGuardian.get(row.guardian_id);
            if (!existing) {
              byGuardian.set(row.guardian_id, {
                telegramChatId: row.telegram_chat_id,
                studentIds: [row.student_id],
              });
            } else {
              if (!existing.studentIds.includes(row.student_id)) {
                existing.studentIds.push(row.student_id);
              }
            }
          }

          for (const [guardianId, info] of byGuardian.entries()) {
            const delivStatus: NotificationDeliveryStatus = info.telegramChatId
              ? 'QUEUED'
              : 'SKIPPED_UNLINKED';
            const projectedPayload = buildGuardianScopedPayloadProjection(
              event.payload_json,
              info.studentIds,
            );
            await tx.query(
              `INSERT INTO "notification_deliveries" (
                 "id", "center_id", "outbox_event_id", "recipient_type", "recipient_id",
                 "target_student_id", "payload_projection_json",
                 "telegram_chat_id", "delivery_status", "attempt_count",
                 "next_attempt_at", "last_lease_token", "version", "created_at", "updated_at"
               ) VALUES (
                 $1::uuid, $2::uuid, $3::uuid, 'GUARDIAN', $4::uuid,
                 $5::uuid, $6::jsonb,
                 $7::bigint, $8, 0,
                 $9::timestamptz, 0, 1, $9::timestamptz, $9::timestamptz
               )
               ON CONFLICT ("outbox_event_id", "recipient_type", "recipient_id") DO NOTHING`,
              [
                crypto.randomUUID(),
                event.center_id,
                event.id,
                guardianId,
                info.studentIds[0] ?? null,
                JSON.stringify(projectedPayload),
                info.telegramChatId,
                delivStatus,
                nowUtc.toISOString(),
              ],
            );
          }
        }
      }

      if (requiresDirectorFanout) {
        const directorsRes = await tx.query<{
          id: string;
          telegram_user_id: string | null;
        }>(
          `SELECT "id"::text AS id, "telegram_user_id"::text AS telegram_user_id
             FROM "staff_users"
            WHERE "center_id" = $1::uuid
              AND "role" = 'DIRECTOR'
              AND "status" = 'ACTIVE'
            ORDER BY "created_at" ASC`,
          [event.center_id],
        );
        for (const dir of directorsRes.rows) {
          const delivStatus: NotificationDeliveryStatus = dir.telegram_user_id
            ? 'QUEUED'
            : 'SKIPPED_UNLINKED';
          await tx.query(
            `INSERT INTO "notification_deliveries" (
               "id", "center_id", "outbox_event_id", "recipient_type", "recipient_id",
               "telegram_chat_id", "delivery_status", "attempt_count",
               "next_attempt_at", "last_lease_token", "version", "created_at", "updated_at"
             ) VALUES (
               $1::uuid, $2::uuid, $3::uuid, 'DIRECTOR', $4::uuid,
               $5::bigint, $6, 0,
               $7::timestamptz, 0, 1, $7::timestamptz, $7::timestamptz
             )
             ON CONFLICT ("outbox_event_id", "recipient_type", "recipient_id") DO NOTHING`,
            [
              crypto.randomUUID(),
              event.center_id,
              event.id,
              dir.id,
              dir.telegram_user_id,
              delivStatus,
              nowUtc.toISOString(),
            ],
          );
        }
      }
    });
  }

  /**
   * Claims up to `batchSize` eligible outbox events for `config.centerId` using
   * `FOR UPDATE SKIP LOCKED`, predecessor `aggregate_version` ordering gate, and
   * monotonic `lease_token = lease_token + 1` increment (`S2F04`, `13.01`).
   */
  public async claimOutboxBatch(options: {
    readonly batchSize?: number;
    readonly leaseDurationSeconds?: number;
    readonly nowUtc?: Date;
    readonly workerId?: string;
  } = {}): Promise<readonly LeasedOutboxEventRow[]> {
    if (this.db.isClosing()) {
      return [];
    }
    const batchSize = Math.max(1, Math.min(50, options.batchSize ?? 25));
    const leaseDurationSeconds = Math.max(5, Math.min(300, options.leaseDurationSeconds ?? 30));
    const nowUtc = options.nowUtc ?? this.clock();
    const leaseUntilUtc = new Date(nowUtc.getTime() + leaseDurationSeconds * 1000);
    const workerId = options.workerId ?? this.config.workerId;

    const liveLicenseMode = await this.db.resolveLiveCenterLicenseMode();

    const res = await this.db.query<{
      id: string;
      center_id: string;
      event_name: string;
      schema_version: number;
      aggregate_type: string;
      aggregate_id: string;
      aggregate_version: number;
      dedup_key: string;
      payload_json: Record<string, unknown>;
      status: OutboxEventStatus;
      attempt_count: number;
      lease_token: string;
      leased_by_worker: string | null;
      lease_until: Date | null;
      next_attempt_at: Date;
      last_error: string | null;
      occurred_at_utc: Date;
      processed_at_utc: Date | null;
    }>(
      `UPDATE "outbox_events" AS target
          SET "status" = 'LEASED',
              "leased_by_worker" = $2,
              "lease_until" = $3::timestamptz,
              "attempt_count" = target."attempt_count" + 1,
              "lease_token" = target."lease_token" + 1,
              "updated_at" = $4::timestamptz
        WHERE target."id" IN (
          SELECT candidate."id"
            FROM "outbox_events" AS candidate
           WHERE candidate."center_id" = $1::uuid
             AND candidate."status" IN ('PENDING', 'LEASED')
             AND (candidate."lease_until" IS NULL OR candidate."lease_until" <= $4::timestamptz)
             AND candidate."next_attempt_at" <= $4::timestamptz
             AND ($6::boolean = FALSE OR candidate."event_name" = 'LicenseStateChanged')
             AND NOT EXISTS (
               SELECT 1
                 FROM "outbox_events" AS prev
                WHERE prev."center_id" = candidate."center_id"
                  AND prev."aggregate_type" = candidate."aggregate_type"
                  AND prev."aggregate_id" = candidate."aggregate_id"
                  AND prev."aggregate_version" < candidate."aggregate_version"
                  AND prev."status" IN ('PENDING', 'LEASED', 'DEAD_LETTER')
             )
           ORDER BY candidate."occurred_at_utc" ASC, candidate."aggregate_version" ASC, candidate."id" ASC
           LIMIT $5::int
           FOR UPDATE SKIP LOCKED
        )
       RETURNING
         target."id"::text AS id,
         target."center_id"::text AS center_id,
         target."event_name",
         target."schema_version",
         target."aggregate_type",
         target."aggregate_id"::text AS aggregate_id,
         target."aggregate_version",
         target."dedup_key",
         target."payload_json",
         target."status"::text AS status,
         target."attempt_count",
         target."lease_token"::text AS lease_token,
         target."leased_by_worker",
         target."lease_until",
         target."next_attempt_at",
         target."last_error",
         target."occurred_at_utc",
         target."processed_at_utc"`,
      [
        this.config.centerId,
        workerId,
        leaseUntilUtc.toISOString(),
        nowUtc.toISOString(),
        batchSize,
        liveLicenseMode === 'READ_ONLY',
      ],
    );

    return Object.freeze(
      res.rows.map((r) =>
        Object.freeze({
          id: r.id,
          center_id: r.center_id,
          event_name: r.event_name,
          schema_version: Number(r.schema_version),
          aggregate_type: r.aggregate_type,
          aggregate_id: r.aggregate_id,
          aggregate_version: Number(r.aggregate_version),
          dedup_key: r.dedup_key,
          payload_json: (r.payload_json ?? {}) as Record<string, unknown>,
          status: r.status,
          attempt_count: Number(r.attempt_count),
          lease_token: BigInt(r.lease_token),
          leased_by_worker: r.leased_by_worker,
          lease_until: r.lease_until ? new Date(r.lease_until) : null,
          next_attempt_at: new Date(r.next_attempt_at),
          last_error: r.last_error,
          occurred_at_utc: new Date(r.occurred_at_utc),
          processed_at_utc: r.processed_at_utc ? new Date(r.processed_at_utc) : null,
        }),
      ),
    );
  }

  /**
   * Executes a single internal DB consumer inside an atomic PostgreSQL transaction
   * with `lease_token` fencing and `outbox_consumer_receipts` deduplication (`S2F04`, `13.01`).
   */
  public async executeInternalConsumerWithReceipt(params: {
    readonly eventId: string;
    readonly centerId?: string;
    readonly leaseToken: bigint;
    readonly consumerName: string;
    readonly consumerReceiptKey: string;
    readonly nowUtc?: Date;
    readonly effectFn: (tx: WorkerQueryExecutor) => Promise<Record<string, unknown>>;
    readonly testFaultAfterStep?: 'DOMAIN_EFFECT' | 'RECEIPT_INSERT';
  }): Promise<InternalConsumerExecutionResult> {
    const centerId = params.centerId ?? this.config.centerId;
    const nowUtc = params.nowUtc ?? this.clock();

    return this.db.runInTransaction(async (tx) => {
      const lockRes = await tx.query<{ id: string }>(
        `SELECT "id"::text AS id
           FROM "outbox_events"
          WHERE "id" = $1::uuid
            AND "center_id" = $2::uuid
            AND "status" = 'LEASED'
            AND "lease_token" = $3::bigint
          FOR UPDATE`,
        [params.eventId, centerId, params.leaseToken.toString(10)],
      );
      if (lockRes.rows.length === 0) {
        throw new StaleLeaseTokenError(params.eventId, params.leaseToken);
      }

      const existingReceipt = await tx.query<{
        id: string;
        fencing_lease_token: string;
        effect_summary_json: Record<string, unknown>;
      }>(
        `SELECT "id"::text AS id,
                "fencing_lease_token"::text AS fencing_lease_token,
                "effect_summary_json"
           FROM "outbox_consumer_receipts"
          WHERE "center_id" = $1::uuid
            AND (
              ("consumer_name" = $2 AND "outbox_event_id" = $3::uuid)
              OR "consumer_receipt_key" = $4
            )
          LIMIT 1`,
        [centerId, params.consumerName, params.eventId, params.consumerReceiptKey],
      );
      if (existingReceipt.rows[0]) {
        return {
          consumerName: params.consumerName,
          consumerReceiptKey: params.consumerReceiptKey,
          deduplicated: true,
          fencingLeaseToken: BigInt(existingReceipt.rows[0].fencing_lease_token),
          effectSummary: existingReceipt.rows[0].effect_summary_json ?? {},
        };
      }

      const effectSummary = await params.effectFn(tx);
      if (this.config.nodeEnv === 'test' && params.testFaultAfterStep === 'DOMAIN_EFFECT') {
        throw new Error('SIMULATED_S13_CONSUMER_FAULT_AFTER_DOMAIN_EFFECT');
      }

      const receiptId = crypto.randomUUID();
      await tx.query(
        `INSERT INTO "outbox_consumer_receipts" (
           "id",
           "center_id",
           "outbox_event_id",
           "consumer_name",
           "consumer_receipt_key",
           "fencing_lease_token",
           "effect_summary_json",
           "processed_at_utc"
         ) VALUES (
           $1::uuid,
           $2::uuid,
           $3::uuid,
           $4,
           $5,
           $6::bigint,
           $7::jsonb,
           $8::timestamptz
         )`,
        [
          receiptId,
          centerId,
          params.eventId,
          params.consumerName,
          params.consumerReceiptKey,
          params.leaseToken.toString(10),
          JSON.stringify(effectSummary),
          nowUtc.toISOString(),
        ],
      );

      if (this.config.nodeEnv === 'test' && params.testFaultAfterStep === 'RECEIPT_INSERT') {
        throw new Error('SIMULATED_S13_CONSUMER_FAULT_AFTER_RECEIPT_INSERT');
      }

      return {
        consumerName: params.consumerName,
        consumerReceiptKey: params.consumerReceiptKey,
        deduplicated: false,
        fencingLeaseToken: params.leaseToken,
        effectSummary,
      };
    });
  }

  private async runFencedDeliveryMutation<T>(
    event: LeasedOutboxEventRow,
    fn: (tx: WorkerQueryExecutor) => Promise<T>,
  ): Promise<T> {
    return this.db.runInTransaction(async (tx) => {
      const fenceCheck = await tx.query<{ id: string }>(
        `SELECT "id"::text AS id
           FROM "outbox_events"
          WHERE "id" = $1::uuid
            AND "center_id" = $2::uuid
            AND "status" = 'LEASED'
            AND "lease_token" = $3::bigint
          FOR UPDATE`,
        [event.id, event.center_id, event.lease_token.toString(10)],
      );
      if (fenceCheck.rows.length === 0) {
        throw new StaleLeaseTokenError(event.id, event.lease_token);
      }
      return fn(tx);
    });
  }

  /**
   * Resolves live notification policy for `PromiseDue` send-time verification (`T03`).
   */
  private async resolveLiveCenterPromiseNotificationPolicy(
    centerId: string,
    asOfLocalDate: string,
  ): Promise<{
    readonly status: 'UNCONFIGURED' | 'CONFIRMED';
    readonly channelPolicy: PromiseReminderChannelPolicy;
    readonly policyVersionId: string | null;
  }> {
    const res = await this.db.query<{
      id: string;
      notification_policy_status?: string | null;
      promise_reminder_channel_policy?: string | null;
      effective_from_date?: unknown;
      notification_policy_effective_until?: unknown;
    }>(
      `SELECT "id"::text AS id,
              "notification_policy_status"::text AS notification_policy_status,
              "promise_reminder_channel_policy"::text AS promise_reminder_channel_policy,
              "effective_from_date"::text AS effective_from_date,
              "notification_policy_effective_until"::text AS notification_policy_effective_until
         FROM "billing_policy_versions"
        WHERE "center_id" = $1::uuid
        ORDER BY "version_number" DESC
        LIMIT 1`,
      [centerId],
    );
    const latest = res.rows[0];
    if (!latest) {
      return {
        status: 'UNCONFIGURED',
        channelPolicy: 'UNCONFIGURED_CHANNEL_POLICY',
        policyVersionId: null,
      };
    }
    const notifStatus =
      latest.notification_policy_status === 'CONFIRMED' ? 'CONFIRMED' : 'UNCONFIGURED';
    const rawPolicy = latest.promise_reminder_channel_policy;
    const channelPolicy: PromiseReminderChannelPolicy =
      rawPolicy === 'CONFIRMED_GUARDIAN_ONLY' || rawPolicy === 'CONFIRMED_ADMIN_AND_GUARDIAN'
        ? rawPolicy
        : 'UNCONFIGURED_CHANNEL_POLICY';
    const effFrom = formatPgDate(latest.effective_from_date);
    const effUntil = formatPgDate(latest.notification_policy_effective_until);

    if (
      notifStatus !== 'CONFIRMED' ||
      channelPolicy === 'UNCONFIGURED_CHANNEL_POLICY' ||
      !effFrom ||
      effFrom > asOfLocalDate ||
      (effUntil !== null && effUntil < asOfLocalDate)
    ) {
      return {
        status: 'UNCONFIGURED',
        channelPolicy: 'UNCONFIGURED_CHANNEL_POLICY',
        policyVersionId: latest.id,
      };
    }

    return {
      status: 'CONFIRMED',
      channelPolicy,
      policyVersionId: latest.id,
    };
  }

  /**
   * Stages and processes `notification_deliveries` rows for a leased event with:
   * - `S03`: `lease_token` fencing on EVERY delivery state transition.
   * - `S03`: Durable pre-send attempt persistence (`last_lease_token = event.lease_token, attempt_count = attempt_count + 1`
   *   committed BEFORE `transportAdapter.sendNotification(...)`).
   * - `T03`: Send-time `PromiseDue` notification policy re-verification (suppresses old queued deliveries if
   *   center notification policy is unconfigured, revoked, expired, or narrowed from `CONFIRMED_ADMIN_AND_GUARDIAN`
   *   to `CONFIRMED_GUARDIAN_ONLY`).
   * - `T04`: Exact guardian–student child scope verification and per-recipient payload projection:
   *   - Never uses `NULL -> any active child` fallback.
   *   - Re-queries live `guardian_students` for the specific target student ID(s) of the event.
   *   - If the target child was unlinked before send (even if another sibling remains active on the same guardian!),
   *     suppresses the delivery (`SKIPPED_UNLINKED`).
   *   - Projects only the guardian's currently permitted child(ren) into `request.payload` so no other child's
   *     UUID, attendance status, grade, or debt is ever leaked.
   */
  public async processNotificationDeliveriesForEvent(
    event: LeasedOutboxEventRow,
    nowUtc: Date = this.clock(),
  ): Promise<{
    readonly allTerminal: boolean;
    readonly hasRetryPending: boolean;
    readonly deferredWithoutAttemptBurn: boolean;
    readonly earliestNextAttemptAt: Date | null;
    readonly ambiguousAfterSendCount: number;
  }> {
    await this.ensureNotificationDeliveriesStagedFenced(event, nowUtc);

    const deliveriesRes = await this.db.query<{
      id: string;
      recipient_type: NotificationRecipientType;
      recipient_id: string;
      target_student_id: string | null;
      payload_projection_json: Record<string, unknown> | null;
      policy_version_id: string | null;
      telegram_chat_id: string | null;
      delivery_status: NotificationDeliveryStatus;
      attempt_count: number;
      next_attempt_at: Date;
      last_lease_token: string;
      version: number;
    }>(
      `SELECT "id"::text AS id,
              "recipient_type"::text AS recipient_type,
              "recipient_id"::text AS recipient_id,
              "target_student_id"::text AS target_student_id,
              "payload_projection_json",
              "policy_version_id"::text AS policy_version_id,
              "telegram_chat_id"::text AS telegram_chat_id,
              "delivery_status"::text AS delivery_status,
              "attempt_count",
              "next_attempt_at",
              "last_lease_token"::text AS last_lease_token,
              "version"
         FROM "notification_deliveries"
        WHERE "center_id" = $1::uuid
          AND "outbox_event_id" = $2::uuid
        ORDER BY "created_at" ASC, "id" ASC`,
      [event.center_id, event.id],
    );

    if (deliveriesRes.rows.length === 0) {
      return {
        allTerminal: true,
        hasRetryPending: false,
        deferredWithoutAttemptBurn: false,
        earliestNextAttemptAt: null,
        ambiguousAfterSendCount: 0,
      };
    }

    if (!this.config.botOutboundEnabled) {
      const anyNonTerminal = deliveriesRes.rows.some(
        (d) => d.delivery_status === 'QUEUED' || d.delivery_status === 'RETRY_429',
      );
      return {
        allTerminal: !anyNonTerminal,
        hasRetryPending: anyNonTerminal,
        deferredWithoutAttemptBurn: anyNonTerminal,
        earliestNextAttemptAt: anyNonTerminal
          ? new Date(nowUtc.getTime() + 60_000)
          : null,
        ambiguousAfterSendCount: 0,
      };
    }

    let allTerminal = true;
    let hasRetryPending = false;
    let deferredWithoutAttemptBurn = false;
    let earliestNextAttemptAt: Date | null = null;
    let ambiguousAfterSendCount = 0;

    const localParts = formatCenterLocalDateParts(nowUtc, this.config.centerTimezone);

    for (const deliv of deliveriesRes.rows) {
      if (
        deliv.delivery_status === 'API_ACCEPTED' ||
        deliv.delivery_status === 'SKIPPED_UNLINKED' ||
        deliv.delivery_status === 'FAILED_403_BLOCKED' ||
        deliv.delivery_status === 'DEAD_LETTER'
      ) {
        continue;
      }

      if (new Date(deliv.next_attempt_at).getTime() > nowUtc.getTime()) {
        allTerminal = false;
        hasRetryPending = true;
        if (!earliestNextAttemptAt || new Date(deliv.next_attempt_at) < earliestNextAttemptAt) {
          earliestNextAttemptAt = new Date(deliv.next_attempt_at);
        }
        continue;
      }

      // Live Pre-Send Verification (S04, S06, T03, T04):
      // 1. If event is PromiseDue:
      //    a) Re-verify live center notification policy (T03): if unconfigured, revoked, expired, or narrowed
      //       from CONFIRMED_ADMIN_AND_GUARDIAN to CONFIRMED_GUARDIAN_ONLY (for ADMIN recipient), suppress!
      //    b) Re-verify live promises_to_pay & invoices.remaining_debt_uzs > 0.
      if (event.event_name === 'PromiseDue') {
        const liveNotifPolicy = await this.resolveLiveCenterPromiseNotificationPolicy(
          event.center_id,
          localParts.localDate,
        );
        const policyAllowsRecipient =
          liveNotifPolicy.status === 'CONFIRMED' &&
          (deliv.recipient_type === 'GUARDIAN'
            ? liveNotifPolicy.channelPolicy === 'CONFIRMED_GUARDIAN_ONLY' ||
              liveNotifPolicy.channelPolicy === 'CONFIRMED_ADMIN_AND_GUARDIAN'
            : deliv.recipient_type === 'ADMIN'
              ? liveNotifPolicy.channelPolicy === 'CONFIRMED_ADMIN_AND_GUARDIAN'
              : false);

        const promiseId = String(event.payload_json.promise_id ?? event.aggregate_id ?? '');
        const invoiceId = String(event.payload_json.invoice_id ?? '');
        const livePromiseCheck = await this.db.query<{
          promise_status: string;
          superseded_by_promise_id: string | null;
          remaining_debt_uzs: string;
          invoice_status: string;
        }>(
          `SELECT p."status"::text AS promise_status,
                  p."superseded_by_promise_id"::text AS superseded_by_promise_id,
                  i."remaining_debt_uzs"::text AS remaining_debt_uzs,
                  i."status"::text AS invoice_status
             FROM "promises_to_pay" p
             JOIN "invoices" i
               ON i."id" = p."invoice_id"
              AND i."center_id" = p."center_id"
            WHERE p."id" = $1::uuid
              AND p."center_id" = $2::uuid
              AND ($3 = '' OR i."id" = $3::uuid)
            LIMIT 1`,
          [promiseId, event.center_id, invoiceId],
        );
        const livePromise = livePromiseCheck.rows[0];
        const isPromiseStillActionable =
          policyAllowsRecipient &&
          Boolean(livePromise) &&
          (livePromise.promise_status === 'ACTIVE' ||
            livePromise.promise_status === 'OVERDUE_NOTIFIED') &&
          livePromise.superseded_by_promise_id === null &&
          BigInt(livePromise.remaining_debt_uzs) > 0n &&
          livePromise.invoice_status !== 'PAID' &&
          livePromise.invoice_status !== 'GRANT_ZERO';

        if (!isPromiseStillActionable) {
          await this.runFencedDeliveryMutation(event, async (tx) => {
            await tx.query(
              `UPDATE "notification_deliveries"
                  SET "delivery_status" = 'SKIPPED_UNLINKED',
                      "last_lease_token" = $3::bigint,
                      "version" = "version" + 1,
                      "updated_at" = $4::timestamptz
                WHERE "id" = $1::uuid AND "center_id" = $2::uuid`,
              [deliv.id, event.center_id, event.lease_token.toString(10), nowUtc.toISOString()],
            );
          });
          continue;
        }
      }

      // 2. If event is TeacherPingDue (S06), re-verify live lesson state and effective teacher authority right before send!
      if (event.event_name === 'TeacherPingDue') {
        const lessonId = String(event.payload_json.lesson_id ?? event.aggregate_id ?? '');
        const escalationStage = String(event.payload_json.escalation_stage ?? 'STAGE_20M_PING');
        const liveLessonRes = await this.db.query<{
          status: string;
          attendance_submitted_at: Date | null;
          attendance_version: number;
          group_status: string;
          primary_teacher_id: string;
          sub_teacher_id: string | null;
          att_cnt: string;
        }>(
          `SELECT lo."status"::text AS status,
                  lo."attendance_submitted_at",
                  lo."attendance_version",
                  cg."status"::text AS group_status,
                  cg."primary_teacher_id"::text AS primary_teacher_id,
                  sa."substitute_teacher_id"::text AS sub_teacher_id,
                  (SELECT COUNT(*)::text
                     FROM "attendance_records" ar
                    WHERE ar."center_id" = lo."center_id"
                      AND ar."lesson_id" = lo."id") AS att_cnt
             FROM "lesson_occurrences" lo
             JOIN "course_groups" cg
               ON cg."id" = lo."group_id"
              AND cg."center_id" = lo."center_id"
             LEFT JOIN "substitute_assignments" sa
               ON sa."lesson_id" = lo."id"
              AND sa."center_id" = lo."center_id"
              AND sa."status" = 'ACTIVE'
            WHERE lo."id" = $1::uuid
              AND lo."center_id" = $2::uuid
            LIMIT 1`,
          [lessonId, event.center_id],
        );
        const liveLesson = liveLessonRes.rows[0];
        const liveEffectiveTeacherId = liveLesson
          ? (liveLesson.sub_teacher_id ?? liveLesson.primary_teacher_id)
          : null;
        const lessonStillUnsubmittedAndScheduled =
          Boolean(liveLesson) &&
          liveLesson.status === 'SCHEDULED' &&
          liveLesson.group_status === 'ACTIVE' &&
          liveLesson.attendance_submitted_at === null &&
          Number(liveLesson.attendance_version) === 0 &&
          Number(liveLesson.att_cnt) === 0 &&
          (escalationStage !== 'STAGE_20M_PING' ||
            deliv.recipient_type !== 'TEACHER' ||
            deliv.recipient_id === liveEffectiveTeacherId);

        if (!lessonStillUnsubmittedAndScheduled) {
          await this.runFencedDeliveryMutation(event, async (tx) => {
            await tx.query(
              `UPDATE "notification_deliveries"
                  SET "delivery_status" = 'SKIPPED_UNLINKED',
                      "last_lease_token" = $3::bigint,
                      "version" = "version" + 1,
                      "updated_at" = $4::timestamptz
                WHERE "id" = $1::uuid AND "center_id" = $2::uuid`,
              [deliv.id, event.center_id, event.lease_token.toString(10), nowUtc.toISOString()],
            );
          });
          continue;
        }
      }

      // 3. Re-verify live recipient authority, linked Telegram chat ID, and exact Guardian–Student scope (T04):
      let resolvedChatId: bigint | null =
        deliv.telegram_chat_id !== null ? BigInt(deliv.telegram_chat_id) : null;
      let outboundPayload: Record<string, unknown> = event.payload_json;
      let verifiedTargetStudentId: string | null = deliv.target_student_id ?? null;

      if (deliv.recipient_type === 'GUARDIAN') {
        const candidateStudentIds = extractEventTargetStudentIds(
          event.payload_json,
          deliv.target_student_id,
        );

        // T04: NEVER fall back to "any active child" when candidateStudentIds is empty!
        if (candidateStudentIds.length === 0) {
          await this.runFencedDeliveryMutation(event, async (tx) => {
            await tx.query(
              `UPDATE "notification_deliveries"
                  SET "delivery_status" = 'SKIPPED_UNLINKED',
                      "last_lease_token" = $3::bigint,
                      "version" = "version" + 1,
                      "updated_at" = $4::timestamptz
                WHERE "id" = $1::uuid AND "center_id" = $2::uuid`,
              [deliv.id, event.center_id, event.lease_token.toString(10), nowUtc.toISOString()],
            );
          });
          continue;
        }

        const liveScopeRes = await this.db.query<{
          guardian_status: string;
          link_status: string | null;
          telegram_chat_id: string | null;
          permitted_student_ids: string[] | null;
        }>(
          `SELECT g."status"::text AS guardian_status,
                  gtl."status"::text AS link_status,
                  gtl."telegram_chat_id"::text AS telegram_chat_id,
                  ARRAY(
                    SELECT gs."student_id"::text
                      FROM "guardian_students" gs
                      JOIN "students" s
                        ON s."id" = gs."student_id"
                       AND s."center_id" = gs."center_id"
                     WHERE gs."center_id" = g."center_id"
                       AND gs."guardian_id" = g."id"
                       AND gs."active" = TRUE
                       AND s."status" = 'ACTIVE'
                       AND gs."student_id" = ANY($3::uuid[])
                     ORDER BY gs."student_id" ASC
                  ) AS permitted_student_ids
             FROM "guardians" g
             LEFT JOIN "guardian_telegram_links" gtl
               ON gtl."center_id" = g."center_id"
              AND gtl."guardian_id" = g."id"
              AND gtl."status" = 'ACTIVE'
            WHERE g."center_id" = $1::uuid
              AND g."id" = $2::uuid
            LIMIT 1`,
          [event.center_id, deliv.recipient_id, candidateStudentIds],
        );

        const liveScope = liveScopeRes.rows[0];
        const permittedIds = Array.isArray(liveScope?.permitted_student_ids)
          ? liveScope.permitted_student_ids.filter((id) => Boolean(id))
          : [];

        if (
          !liveScope ||
          liveScope.guardian_status !== 'ACTIVE' ||
          liveScope.link_status !== 'ACTIVE' ||
          !liveScope.telegram_chat_id ||
          permittedIds.length === 0
        ) {
          await this.runFencedDeliveryMutation(event, async (tx) => {
            await tx.query(
              `UPDATE "notification_deliveries"
                  SET "delivery_status" = 'SKIPPED_UNLINKED',
                      "last_lease_token" = $3::bigint,
                      "version" = "version" + 1,
                      "updated_at" = $4::timestamptz
                WHERE "id" = $1::uuid AND "center_id" = $2::uuid`,
              [deliv.id, event.center_id, event.lease_token.toString(10), nowUtc.toISOString()],
            );
          });
          continue;
        }

        resolvedChatId = BigInt(liveScope.telegram_chat_id);
        verifiedTargetStudentId = permittedIds[0] ?? null;
        outboundPayload = buildGuardianScopedPayloadProjection(
          event.payload_json,
          permittedIds,
        );
      } else {
        const staffRes = await this.db.query<{
          status: string;
          role: string;
          telegram_user_id: string | null;
        }>(
          `SELECT "status"::text AS status,
                  "role"::text AS role,
                  "telegram_user_id"::text AS telegram_user_id
             FROM "staff_users"
            WHERE "center_id" = $1::uuid
              AND "id" = $2::uuid
            LIMIT 1`,
          [event.center_id, deliv.recipient_id],
        );
        const liveStaff = staffRes.rows[0];
        const roleAllowed =
          Boolean(liveStaff) &&
          (liveStaff.role === deliv.recipient_type ||
            (deliv.recipient_type === 'ADMIN' && liveStaff.role === 'DIRECTOR'));

        if (
          !liveStaff ||
          liveStaff.status !== 'ACTIVE' ||
          !roleAllowed ||
          !liveStaff.telegram_user_id
        ) {
          await this.runFencedDeliveryMutation(event, async (tx) => {
            await tx.query(
              `UPDATE "notification_deliveries"
                  SET "delivery_status" = 'SKIPPED_UNLINKED',
                      "last_lease_token" = $3::bigint,
                      "version" = "version" + 1,
                      "updated_at" = $4::timestamptz
                WHERE "id" = $1::uuid AND "center_id" = $2::uuid`,
              [deliv.id, event.center_id, event.lease_token.toString(10), nowUtc.toISOString()],
            );
          });
          continue;
        }
        resolvedChatId = BigInt(liveStaff.telegram_user_id);
      }

      // S03: Check if a previous leaseholder already persisted a pre-send attempt marker (`priorLeaseToken > 0n`)
      const priorLeaseToken = BigInt(deliv.last_lease_token);
      if (
        priorLeaseToken > 0n &&
        priorLeaseToken < event.lease_token &&
        deliv.delivery_status === 'QUEUED'
      ) {
        ambiguousAfterSendCount += 1;
        await this.runFencedDeliveryMutation(event, async (tx) => {
          const existingAmbig = await tx.query<{ id: string }>(
            `SELECT "id"::text AS id
               FROM "audit_logs"
              WHERE "center_id" = $1::uuid
                AND "action" = 'EXTERNAL_DELIVERY_AMBIGUOUS_AFTER_SEND'
                AND "entity_id" = $2::uuid
              LIMIT 1`,
            [event.center_id, deliv.id],
          );
          if (existingAmbig.rows.length === 0) {
            await tx.query(
              `INSERT INTO "audit_logs" (
                 "id", "center_id", "actor_type", "actor_id", "actor_role",
                 "action", "entity_type", "entity_id", "severity",
                 "before_redacted_json", "after_redacted_json", "request_id", "created_at"
               ) VALUES (
                 $1::uuid, $2::uuid, 'SYSTEM_WORKER', NULL, NULL,
                 'EXTERNAL_DELIVERY_AMBIGUOUS_AFTER_SEND', 'NotificationDelivery', $3::uuid, 'WARN',
                 NULL, $4::jsonb, $5, $6::timestamptz
               )`,
              [
                crypto.randomUUID(),
                event.center_id,
                deliv.id,
                JSON.stringify({
                  outbox_event_id: event.id,
                  delivery_id: deliv.id,
                  prior_lease_token: priorLeaseToken.toString(10),
                  recovery_lease_token: event.lease_token.toString(10),
                  possible_duplicate_delivery: true,
                  reason:
                    'Recovered QUEUED delivery with durable prior last_lease_token > 0 after prior worker crash/lease expiry',
                }),
                `wrk-ambig-rec-${deliv.id.slice(0, 8)}`,
                nowUtc.toISOString(),
              ],
            );
          }
        });
      }

      // S02: If the default fail-closed adapter is active, defer without marking a pre-send attempt or burning attempt_count!
      if (this.transportAdapter instanceof UnboundFailClosedNotificationTransportAdapter) {
        allTerminal = false;
        hasRetryPending = true;
        deferredWithoutAttemptBurn = true;
        const deferUntil = new Date(nowUtc.getTime() + 60_000);
        if (!earliestNextAttemptAt || deferUntil < earliestNextAttemptAt) {
          earliestNextAttemptAt = deferUntil;
        }
        continue;
      }

      const nextAttemptNumber = Number(deliv.attempt_count) + 1;

      // S03 & T04: Durably persist pre-send attempt state + recipient-scoped payload projection BEFORE calling sendNotification!
      await this.runFencedDeliveryMutation(event, async (tx) => {
        await tx.query(
          `UPDATE "notification_deliveries"
              SET "last_lease_token" = $3::bigint,
                  "attempt_count" = $4::int,
                  "target_student_id" = COALESCE($5::uuid, "target_student_id"),
                  "payload_projection_json" = $6::jsonb,
                  "telegram_chat_id" = COALESCE($7::bigint, "telegram_chat_id"),
                  "version" = "version" + 1,
                  "updated_at" = $8::timestamptz
            WHERE "id" = $1::uuid AND "center_id" = $2::uuid`,
          [
            deliv.id,
            event.center_id,
            event.lease_token.toString(10),
            nextAttemptNumber,
            verifiedTargetStudentId,
            JSON.stringify(outboundPayload),
            resolvedChatId !== null ? resolvedChatId.toString(10) : null,
            nowUtc.toISOString(),
          ],
        );
      });

      try {
        const sendOutcome = await this.transportAdapter.sendNotification({
          centerId: event.center_id,
          outboxEventId: event.id,
          eventName: event.event_name,
          deliveryId: deliv.id,
          recipientType: deliv.recipient_type,
          recipientId: deliv.recipient_id,
          telegramChatId: resolvedChatId,
          leaseToken: event.lease_token,
          attemptNumber: nextAttemptNumber,
          payload: outboundPayload,
        });

        if (sendOutcome.status === 'DEFERRED_TRANSPORT_NOT_BOUND') {
          allTerminal = false;
          hasRetryPending = true;
          deferredWithoutAttemptBurn = true;
          const deferUntil = new Date(nowUtc.getTime() + 60_000);
          if (!earliestNextAttemptAt || deferUntil < earliestNextAttemptAt) {
            earliestNextAttemptAt = deferUntil;
          }
          await this.runFencedDeliveryMutation(event, async (tx) => {
            await tx.query(
              `UPDATE "notification_deliveries"
                  SET "last_lease_token" = $3::bigint,
                      "attempt_count" = $4::int,
                      "version" = "version" + 1,
                      "updated_at" = $5::timestamptz
                WHERE "id" = $1::uuid AND "center_id" = $2::uuid`,
              [
                deliv.id,
                event.center_id,
                priorLeaseToken.toString(10),
                Number(deliv.attempt_count),
                nowUtc.toISOString(),
              ],
            );
          });
          continue;
        }

        if (sendOutcome.status === 'API_ACCEPTED') {
          await this.runFencedDeliveryMutation(event, async (tx) => {
            await tx.query(
              `UPDATE "notification_deliveries"
                  SET "delivery_status" = 'API_ACCEPTED',
                      "telegram_chat_id" = COALESCE($3::bigint, "telegram_chat_id"),
                      "telegram_message_id" = $4::bigint,
                      "attempt_count" = $5::int,
                      "last_lease_token" = $6::bigint,
                      "retry_after_seconds" = NULL,
                      "version" = "version" + 1,
                      "updated_at" = $7::timestamptz
                WHERE "id" = $1::uuid AND "center_id" = $2::uuid`,
              [
                deliv.id,
                event.center_id,
                resolvedChatId !== null ? resolvedChatId.toString(10) : null,
                sendOutcome.telegramMessageId.toString(10),
                nextAttemptNumber,
                event.lease_token.toString(10),
                nowUtc.toISOString(),
              ],
            );
          });
        } else if (sendOutcome.status === 'RETRY_429') {
          allTerminal = false;
          hasRetryPending = true;
          const retryAt = new Date(nowUtc.getTime() + sendOutcome.retryAfterSeconds * 1000);
          if (!earliestNextAttemptAt || retryAt < earliestNextAttemptAt) {
            earliestNextAttemptAt = retryAt;
          }
          await this.runFencedDeliveryMutation(event, async (tx) => {
            await tx.query(
              `UPDATE "notification_deliveries"
                  SET "delivery_status" = 'RETRY_429',
                      "attempt_count" = $3::int,
                      "retry_after_seconds" = $4::int,
                      "next_attempt_at" = $5::timestamptz,
                      "last_lease_token" = $6::bigint,
                      "version" = "version" + 1,
                      "updated_at" = $7::timestamptz
                WHERE "id" = $1::uuid AND "center_id" = $2::uuid`,
              [
                deliv.id,
                event.center_id,
                nextAttemptNumber,
                sendOutcome.retryAfterSeconds,
                retryAt.toISOString(),
                event.lease_token.toString(10),
                nowUtc.toISOString(),
              ],
            );
          });
        } else if (sendOutcome.status === 'FAILED_403_BLOCKED') {
          await this.runFencedDeliveryMutation(event, async (tx) => {
            await tx.query(
              `UPDATE "notification_deliveries"
                  SET "delivery_status" = 'FAILED_403_BLOCKED',
                      "attempt_count" = $3::int,
                      "last_lease_token" = $4::bigint,
                      "version" = "version" + 1,
                      "updated_at" = $5::timestamptz
                WHERE "id" = $1::uuid AND "center_id" = $2::uuid`,
              [
                deliv.id,
                event.center_id,
                nextAttemptNumber,
                event.lease_token.toString(10),
                nowUtc.toISOString(),
              ],
            );
            if (deliv.recipient_type === 'GUARDIAN') {
              await tx.query(
                `UPDATE "guardian_telegram_links"
                    SET "status" = 'BOT_BLOCKED_403',
                        "last_delivery_status" = 'FAILED_403_BLOCKED',
                        "last_error_at" = $3::timestamptz,
                        "version" = "version" + 1,
                        "updated_at" = $3::timestamptz
                  WHERE "center_id" = $1::uuid
                    AND "guardian_id" = $2::uuid
                    AND "status" = 'ACTIVE'`,
                [event.center_id, deliv.recipient_id, nowUtc.toISOString()],
              );
            }
          });
        } else {
          allTerminal = false;
          hasRetryPending = true;
          const backoffSec = computeOutboxBackoffDelaySeconds(nextAttemptNumber);
          const retryAt = new Date(nowUtc.getTime() + backoffSec * 1000);
          if (!earliestNextAttemptAt || retryAt < earliestNextAttemptAt) {
            earliestNextAttemptAt = retryAt;
          }
          const nextStatus: NotificationDeliveryStatus =
            nextAttemptNumber >= OUTBOX_MAX_ATTEMPTS ? 'DEAD_LETTER' : 'QUEUED';
          if (nextStatus === 'DEAD_LETTER') {
            hasRetryPending = false;
          }
          await this.runFencedDeliveryMutation(event, async (tx) => {
            await tx.query(
              `UPDATE "notification_deliveries"
                  SET "delivery_status" = $3,
                      "attempt_count" = $4::int,
                      "next_attempt_at" = $5::timestamptz,
                      "last_lease_token" = $6::bigint,
                      "version" = "version" + 1,
                      "updated_at" = $7::timestamptz
                WHERE "id" = $1::uuid AND "center_id" = $2::uuid`,
              [
                deliv.id,
                event.center_id,
                nextStatus,
                nextAttemptNumber,
                retryAt.toISOString(),
                event.lease_token.toString(10),
                nowUtc.toISOString(),
              ],
            );
          });
        }
      } catch (err: unknown) {
        if (err instanceof StaleLeaseTokenError) {
          throw err;
        }
        const rawMsg = err instanceof Error ? err.message : String(err ?? '');
        const isCrashBeforeExternalSend = rawMsg.includes('CRASH_BEFORE_EXTERNAL_SEND');

        await this.runFencedDeliveryMutation(event, async (tx) => {
          if (isCrashBeforeExternalSend) {
            await tx.query(
              `UPDATE "notification_deliveries"
                  SET "last_lease_token" = $3::bigint,
                      "version" = "version" + 1,
                      "updated_at" = $4::timestamptz
                WHERE "id" = $1::uuid AND "center_id" = $2::uuid`,
              [deliv.id, event.center_id, priorLeaseToken.toString(10), nowUtc.toISOString()],
            );
          } else {
            ambiguousAfterSendCount += 1;
            await tx.query(
              `INSERT INTO "audit_logs" (
                 "id", "center_id", "actor_type", "actor_id", "actor_role",
                 "action", "entity_type", "entity_id", "severity",
                 "before_redacted_json", "after_redacted_json", "request_id", "created_at"
               ) VALUES (
                 $1::uuid, $2::uuid, 'SYSTEM_WORKER', NULL, NULL,
                 'EXTERNAL_DELIVERY_AMBIGUOUS_AFTER_SEND', 'NotificationDelivery', $3::uuid, 'WARN',
                 NULL, $4::jsonb, $5, $6::timestamptz
               )`,
              [
                crypto.randomUUID(),
                event.center_id,
                deliv.id,
                JSON.stringify({
                  outbox_event_id: event.id,
                  delivery_id: deliv.id,
                  lease_token: event.lease_token.toString(10),
                  possible_duplicate_delivery: true,
                  reason: sanitizeWorkerErrorMessage(err),
                }),
                `wrk-ambig-${event.id.slice(0, 8)}`,
                nowUtc.toISOString(),
              ],
            );
          }
        });
        throw err;
      }
    }

    return {
      allTerminal,
      hasRetryPending,
      deferredWithoutAttemptBurn,
      earliestNextAttemptAt,
      ambiguousAfterSendCount,
    };
  }

  public async completeOutboxEventFenced(params: {
    readonly eventId: string;
    readonly centerId?: string;
    readonly leaseToken: bigint;
    readonly nowUtc?: Date;
  }): Promise<void> {
    const centerId = params.centerId ?? this.config.centerId;
    const nowUtc = params.nowUtc ?? this.clock();

    const res = await this.db.query(
      `UPDATE "outbox_events"
          SET "status" = 'COMPLETED',
              "lease_until" = NULL,
              "last_error" = NULL,
              "processed_at_utc" = $4::timestamptz,
              "updated_at" = $4::timestamptz
        WHERE "id" = $1::uuid
          AND "center_id" = $2::uuid
          AND "status" = 'LEASED'
          AND "lease_token" = $3::bigint`,
      [params.eventId, centerId, params.leaseToken.toString(10), nowUtc.toISOString()],
    );
    if ((res.rowCount ?? 0) === 0) {
      throw new StaleLeaseTokenError(params.eventId, params.leaseToken);
    }
  }

  public async failOrRetryOutboxEventFenced(params: {
    readonly eventId: string;
    readonly centerId?: string;
    readonly leaseToken: bigint;
    readonly attemptCount: number;
    readonly error: unknown;
    readonly forceDeadLetter?: boolean;
    readonly preserveAttemptBudget?: boolean;
    readonly nextAttemptAtOverride?: Date;
    readonly nowUtc?: Date;
  }): Promise<{
    readonly newStatus: 'PENDING' | 'DEAD_LETTER';
    readonly nextAttemptAt: Date;
    readonly redactedError: string;
  }> {
    const centerId = params.centerId ?? this.config.centerId;
    const nowUtc = params.nowUtc ?? this.clock();
    const redactedError = sanitizeWorkerErrorMessage(params.error);
    const effectiveAttemptCount = params.preserveAttemptBudget
      ? Math.max(0, params.attemptCount - 1)
      : params.attemptCount;
    const shouldDeadLetter =
      !params.preserveAttemptBudget &&
      (Boolean(params.forceDeadLetter) ||
        params.error instanceof NonRetryablePoisonEventError ||
        effectiveAttemptCount >= OUTBOX_MAX_ATTEMPTS);

    const backoffSeconds = computeOutboxBackoffDelaySeconds(Math.max(1, effectiveAttemptCount));
    const nextAttemptAt =
      params.nextAttemptAtOverride ?? new Date(nowUtc.getTime() + backoffSeconds * 1000);
    const newStatus: 'PENDING' | 'DEAD_LETTER' = shouldDeadLetter ? 'DEAD_LETTER' : 'PENDING';

    return this.db.runInTransaction(async (tx) => {
      const updRes = await tx.query(
        `UPDATE "outbox_events"
            SET "status" = $4,
                "attempt_count" = $5::int,
                "lease_until" = NULL,
                "next_attempt_at" = $6::timestamptz,
                "last_error" = $7,
                "updated_at" = $8::timestamptz
          WHERE "id" = $1::uuid
            AND "center_id" = $2::uuid
            AND "status" = 'LEASED'
            AND "lease_token" = $3::bigint`,
        [
          params.eventId,
          centerId,
          params.leaseToken.toString(10),
          newStatus,
          effectiveAttemptCount,
          nextAttemptAt.toISOString(),
          redactedError,
          nowUtc.toISOString(),
        ],
      );
      if ((updRes.rowCount ?? 0) === 0) {
        throw new StaleLeaseTokenError(params.eventId, params.leaseToken);
      }

      if (newStatus === 'DEAD_LETTER') {
        await tx.query(
          `INSERT INTO "audit_logs" (
             "id", "center_id", "actor_type", "actor_id", "actor_role",
             "action", "entity_type", "entity_id", "severity",
             "before_redacted_json", "after_redacted_json", "request_id", "created_at"
           ) VALUES (
             $1::uuid, $2::uuid, 'SYSTEM_WORKER', NULL, NULL,
             'OUTBOX_EVENT_DEAD_LETTERED', 'OutboxEvent', $3::uuid, 'WARN',
             NULL, $4::jsonb, $5, $6::timestamptz
           )`,
          [
            crypto.randomUUID(),
            centerId,
            params.eventId,
            JSON.stringify({
              event_id: params.eventId,
              attempt_count: effectiveAttemptCount,
              lease_token: params.leaseToken.toString(10),
              last_error: redactedError,
            }),
            `wrk-dlq-${params.eventId.slice(0, 8)}`,
            nowUtc.toISOString(),
          ],
        );
      }

      return { newStatus, nextAttemptAt, redactedError };
    });
  }

  public async processLeasedEvent(
    event: LeasedOutboxEventRow,
    nowUtc: Date = this.clock(),
  ): Promise<{
    readonly eventId: string;
    readonly finalStatus: OutboxEventStatus;
    readonly receiptsProcessed: number;
  }> {
    try {
      const canonicalSpec = CANONICAL_OUTBOX_EVENT_REGISTRY.get(event.event_name);
      const customConsumers = this.internalConsumers.get(event.event_name) ?? [];

      if (!canonicalSpec && customConsumers.length === 0) {
        throw new NonRetryablePoisonEventError(
          'UNKNOWN_OUTBOX_EVENT_NAME',
          `Unregistered outbox event '${event.event_name}' (schema_version=${event.schema_version}) cannot be silently marked COMPLETED (S02)`,
        );
      }
      if (canonicalSpec && !canonicalSpec.supportedSchemaVersions.has(event.schema_version)) {
        throw new NonRetryablePoisonEventError(
          'UNSUPPORTED_OUTBOX_SCHEMA_VERSION',
          `Outbox event '${event.event_name}' has unsupported schema_version=${event.schema_version} (S02)`,
        );
      }

      let receiptsProcessed = 0;

      for (const spec of customConsumers) {
        await this.executeInternalConsumerWithReceipt({
          eventId: event.id,
          centerId: event.center_id,
          leaseToken: event.lease_token,
          consumerName: spec.consumerName,
          consumerReceiptKey: spec.buildReceiptKey(event),
          nowUtc,
          effectFn: (tx) => spec.handler(tx, event, nowUtc),
        });
        receiptsProcessed += 1;
      }

      const fanoutResult = await this.processNotificationDeliveriesForEvent(event, nowUtc);
      if (fanoutResult.allTerminal) {
        await this.completeOutboxEventFenced({
          eventId: event.id,
          centerId: event.center_id,
          leaseToken: event.lease_token,
          nowUtc,
        });
        return {
          eventId: event.id,
          finalStatus: 'COMPLETED',
          receiptsProcessed,
        };
      }

      const retryOut = await this.failOrRetryOutboxEventFenced({
        eventId: event.id,
        centerId: event.center_id,
        leaseToken: event.lease_token,
        attemptCount: event.attempt_count,
        error: new Error(
          !this.config.botOutboundEnabled
            ? 'BOT_OUTBOUND_DISABLED_RESTORE_GUARD'
            : fanoutResult.deferredWithoutAttemptBurn
              ? 'TELEGRAM_TRANSPORT_NOT_BOUND_DEFERRED'
              : 'NOTIFICATION_DELIVERY_RETRY_PENDING',
        ),
        forceDeadLetter: false,
        preserveAttemptBudget: fanoutResult.deferredWithoutAttemptBurn,
        nextAttemptAtOverride:
          fanoutResult.earliestNextAttemptAt ?? new Date(nowUtc.getTime() + 30_000),
        nowUtc,
      });

      return {
        eventId: event.id,
        finalStatus: retryOut.newStatus,
        receiptsProcessed,
      };
    } catch (err: unknown) {
      if (err instanceof StaleLeaseTokenError) {
        throw err;
      }
      const outcome = await this.failOrRetryOutboxEventFenced({
        eventId: event.id,
        centerId: event.center_id,
        leaseToken: event.lease_token,
        attemptCount: event.attempt_count,
        error: err,
        nowUtc,
      });
      return {
        eventId: event.id,
        finalStatus: outcome.newStatus,
        receiptsProcessed: 0,
      };
    }
  }

  public async runOutboxTick(options: {
    readonly batchSize?: number;
    readonly leaseDurationSeconds?: number;
    readonly nowUtc?: Date;
  } = {}): Promise<{
    readonly claimedCount: number;
    readonly completedCount: number;
    readonly pendingRetryCount: number;
    readonly deadLetterCount: number;
  }> {
    if (this.db.isClosing()) {
      return {
        claimedCount: 0,
        completedCount: 0,
        pendingRetryCount: 0,
        deadLetterCount: 0,
      };
    }
    const nowUtc = options.nowUtc ?? this.clock();
    const claimed = await this.claimOutboxBatch({
      batchSize: options.batchSize,
      leaseDurationSeconds: options.leaseDurationSeconds,
      nowUtc,
    });

    let completedCount = 0;
    let pendingRetryCount = 0;
    let deadLetterCount = 0;

    for (const ev of claimed) {
      if (this.db.isClosing()) {
        break;
      }
      const res = await this.processLeasedEvent(ev, nowUtc);
      if (res.finalStatus === 'COMPLETED') completedCount += 1;
      else if (res.finalStatus === 'DEAD_LETTER') deadLetterCount += 1;
      else pendingRetryCount += 1;
    }

    return {
      claimedCount: claimed.length,
      completedCount,
      pendingRetryCount,
      deadLetterCount,
    };
  }

  public async replayDeadLetterEvent(params: {
    readonly centerId?: string;
    readonly eventId: string;
    readonly actorStaffId: string;
    readonly actorRole: 'DIRECTOR' | 'ADMIN' | 'TEACHER';
    readonly reason: string;
    readonly nowUtc?: Date;
  }): Promise<{ readonly replayed: boolean; readonly status: OutboxEventStatus }> {
    if (params.actorRole !== 'DIRECTOR' && params.actorRole !== 'ADMIN') {
      throw new Error('FORBIDDEN_ROLE: Only DIRECTOR or ADMIN can replay DEAD_LETTER outbox events');
    }
    const cleanReason = (params.reason ?? '').trim();
    if (cleanReason.length < 5) {
      throw new Error('VALIDATION_ERROR: DLQ replay reason must be at least 5 characters');
    }
    const centerId = params.centerId ?? this.config.centerId;
    const nowUtc = params.nowUtc ?? this.clock();

    return this.db.runInTransaction(async (tx) => {
      const staffRes = await tx.query<{ status: string; role: string }>(
        `SELECT "status"::text AS status, "role"::text AS role
           FROM "staff_users"
          WHERE "id" = $1::uuid AND "center_id" = $2::uuid
          LIMIT 1`,
        [params.actorStaffId, centerId],
      );
      const staff = staffRes.rows[0];
      if (!staff || staff.status !== 'ACTIVE' || (staff.role !== 'DIRECTOR' && staff.role !== 'ADMIN')) {
        throw new Error(
          'FORBIDDEN_ROLE: Live staff user must be ACTIVE with DIRECTOR or ADMIN role to replay DEAD_LETTER events',
        );
      }

      const updRes = await tx.query<{ status: OutboxEventStatus }>(
        `UPDATE "outbox_events"
            SET "status" = 'PENDING',
                "attempt_count" = 0,
                "lease_until" = NULL,
                "next_attempt_at" = $3::timestamptz,
                "updated_at" = $3::timestamptz
          WHERE "id" = $1::uuid
            AND "center_id" = $2::uuid
            AND "status" = 'DEAD_LETTER'
          RETURNING "status"::text AS status`,
        [params.eventId, centerId, nowUtc.toISOString()],
      );
      if (updRes.rows.length === 0) {
        throw new Error(`NOT_FOUND_OR_NOT_DEAD_LETTER: Event ${params.eventId} is not in DEAD_LETTER state`);
      }

      await tx.query(
        `INSERT INTO "audit_logs" (
           "id", "center_id", "actor_type", "actor_id", "actor_role",
           "action", "entity_type", "entity_id", "severity",
           "before_redacted_json", "after_redacted_json", "request_id", "created_at"
         ) VALUES (
           $1::uuid, $2::uuid, 'STAFF', $3::uuid, $4,
           'OUTBOX_DEAD_LETTER_REPLAYED', 'OutboxEvent', $5::uuid, 'WARN',
           '{"status":"DEAD_LETTER"}'::jsonb, $6::jsonb, $7, $8::timestamptz
         )`,
        [
          crypto.randomUUID(),
          centerId,
          params.actorStaffId,
          staff.role,
          params.eventId,
          JSON.stringify({ status: 'PENDING', reason: cleanReason }),
          `dlq-replay-${params.eventId.slice(0, 8)}`,
          nowUtc.toISOString(),
        ],
      );

      return { replayed: true, status: 'PENDING' };
    });
  }

  public async reconcileRestoredOutbox(params: {
    readonly centerId?: string;
    readonly cutoffUtc: Date;
    readonly reason: string;
    readonly nowUtc?: Date;
  }): Promise<{ readonly supersededCount: number; readonly preservedInternalCount: number }> {
    if (this.config.botOutboundEnabled) {
      throw new Error(
        'RESTORE_RECONCILE_REQUIRES_BOT_OUTBOUND_DISABLED: BOT_OUTBOUND_ENABLED must be false during restore reconciliation (B14)',
      );
    }
    const centerId = params.centerId ?? this.config.centerId;
    const nowUtc = params.nowUtc ?? this.clock();

    const supersedableEventNames = [...CANONICAL_OUTBOX_EVENT_REGISTRY.values()]
      .filter((spec) => spec.supersededOnRestore)
      .map((spec) => spec.eventName);

    return this.db.runInTransaction(async (tx) => {
      const preservedRes = await tx.query<{ cnt: string }>(
        `SELECT COUNT(*)::text AS cnt
           FROM "outbox_events"
          WHERE "center_id" = $1::uuid
            AND "status" IN ('PENDING', 'LEASED')
            AND "occurred_at_utc" <= $2::timestamptz
            AND NOT ("event_name" = ANY($3::text[]))`,
        [centerId, params.cutoffUtc.toISOString(), supersedableEventNames],
      );

      const res = await tx.query<{ id: string }>(
        `UPDATE "outbox_events"
            SET "status" = 'SUPERSEDED_BY_RESTORE',
                "lease_until" = NULL,
                "updated_at" = $3::timestamptz
          WHERE "center_id" = $1::uuid
            AND "status" IN ('PENDING', 'LEASED')
            AND "occurred_at_utc" <= $2::timestamptz
            AND "event_name" = ANY($4::text[])
          RETURNING "id"::text AS id`,
        [centerId, params.cutoffUtc.toISOString(), nowUtc.toISOString(), supersedableEventNames],
      );

      if (res.rows.length > 0) {
        await tx.query(
          `UPDATE "notification_deliveries"
              SET "delivery_status" = 'SKIPPED_UNLINKED',
                  "version" = "version" + 1,
                  "updated_at" = $3::timestamptz
            WHERE "center_id" = $1::uuid
              AND "outbox_event_id" = ANY($2::uuid[])
              AND "delivery_status" IN ('QUEUED', 'RETRY_429')`,
          [
            centerId,
            res.rows.map((r) => r.id),
            nowUtc.toISOString(),
          ],
        );
      }

      for (const row of res.rows) {
        await tx.query(
          `INSERT INTO "audit_logs" (
             "id", "center_id", "actor_type", "actor_id", "actor_role",
             "action", "entity_type", "entity_id", "severity",
             "before_redacted_json", "after_redacted_json", "request_id", "created_at"
           ) VALUES (
             $1::uuid, $2::uuid, 'SYSTEM_WORKER', NULL, NULL,
             'OUTBOX_SUPERSEDED_BY_RESTORE', 'OutboxEvent', $3::uuid, 'WARN',
             NULL, $4::jsonb, $5, $6::timestamptz
           )`,
          [
            crypto.randomUUID(),
            centerId,
            row.id,
            JSON.stringify({ reason: params.reason, cutoff_utc: params.cutoffUtc.toISOString() }),
            `restore-${row.id.slice(0, 8)}`,
            nowUtc.toISOString(),
          ],
        );
      }

      return {
        supersededCount: res.rows.length,
        preservedInternalCount: Number(preservedRes.rows[0]?.cnt ?? '0'),
      };
    });
  }
}
