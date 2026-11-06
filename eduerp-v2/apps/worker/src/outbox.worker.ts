/**
 * EduERP v2.0 — Stage 13, Step 13.01 (`T13.01`, `S2F04`, `B13`, `B14`, `BR-15`, `BR-17`, `D09`, `D17`, `S02`, `S03`, `S04`, `S06`):
 * Transactional Outbox Lease Acquisition (`FOR UPDATE SKIP LOCKED`), Monotonic `lease_token` Fencing,
 * Predecessor `aggregate_version` Ordering Gate, Versioned Event Registry (`CANONICAL_OUTBOX_EVENT_REGISTRY`),
 * Atomic `OutboxConsumerReceipt` Deduplication, Fail-Closed Default Production Transport Adapter
 * (`UnboundFailClosedNotificationTransportAdapter`), Durable Pre-Send Attempt Persistence & Fenced Delivery Transitions,
 * Live Pre-Send Authority & Promise/Lesson Re-Verification, Selective Restore Reconciliation,
 * Bounded Exponential Backoff (`attempt_count <= 8`) with Deferred-Wait Budget Preservation, and `DEAD_LETTER` Handling.
 */

import * as crypto from 'node:crypto';
import {
  computeOutboxBackoffDelaySeconds,
  NotificationDeliveryStatus,
  NotificationRecipientType,
  OUTBOX_MAX_ATTEMPTS,
  OutboxEventStatus,
} from '@eduerp/contracts';
import { WorkerEnvConfig } from './config/env';
import {
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
    });

    if (this.mode === 'CRASH_AFTER_SEND_BEFORE_ACK') {
      const err = new Error(
        `SIMULATED_CRASH_AFTER_EXTERNAL_SEND: message_id=${msgId.toString(10)} sent to external provider before local DB ACK commit (at-least-once ambiguity window)`,
      );
      (err as { externalSendAlreadyOccurred?: boolean }).externalSendAlreadyOccurred = true;
      throw err;
    }

    if (this.mode === 'CRASH_AFTER_SEND_NO_MEMORY_FLAG') {
      // Simulates abrupt process kill (SIGKILL / power loss) after external send where no in-memory error property survives
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
    // 1. AllocationAdjusted -> PromiseLifecycleConsumer + ReportProjectionConsumer
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

    // 2. GuardianLinkRevoked -> BotSessionCacheConsumer (marks queued guardian deliveries as SKIPPED_UNLINKED)
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

    // 3. PromiseFulfilled -> SchedulerCancelConsumer (cancels/skips any queued PromiseDue deliveries for that promise)
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

    // 4. PromiseDue -> AdminTaskConsumer (records durable receipt for promise reminder audit/task tracking)
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
   * canonical `notification_deliveries` rows staged inside a fenced transaction before delivery fanout.
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
        const studentIds = new Set<string>();
        if (typeof event.payload_json.student_id === 'string' && event.payload_json.student_id) {
          studentIds.add(event.payload_json.student_id);
        }
        if (Array.isArray(event.payload_json.absent_student_ids)) {
          for (const sid of event.payload_json.absent_student_ids) {
            if (typeof sid === 'string' && sid) studentIds.add(sid);
          }
        }
        if (Array.isArray(event.payload_json.late_student_ids)) {
          for (const sid of event.payload_json.late_student_ids) {
            if (typeof sid === 'string' && sid) studentIds.add(sid);
          }
        }

        const studentIdList = [...studentIds];
        if (studentIdList.length > 0) {
          const guardiansRes = await tx.query<{
            guardian_id: string;
            telegram_chat_id: string | null;
          }>(
            `SELECT DISTINCT gs."guardian_id"::text AS guardian_id,
                    gtl."telegram_chat_id"::text AS telegram_chat_id
               FROM "guardian_students" gs
               JOIN "guardians" g
                 ON g."id" = gs."guardian_id"
                AND g."center_id" = gs."center_id"
               LEFT JOIN "guardian_telegram_links" gtl
                 ON gtl."center_id" = gs."center_id"
                AND gtl."guardian_id" = gs."guardian_id"
                AND gtl."status" = 'ACTIVE'
              WHERE gs."center_id" = $1::uuid
                AND gs."student_id" = ANY($2::uuid[])
                AND gs."active" = TRUE
                AND g."status" = 'ACTIVE'`,
            [event.center_id, studentIdList],
          );

          for (const g of guardiansRes.rows) {
            const delivStatus: NotificationDeliveryStatus = g.telegram_chat_id
              ? 'QUEUED'
              : 'SKIPPED_UNLINKED';
            await tx.query(
              `INSERT INTO "notification_deliveries" (
                 "id", "center_id", "outbox_event_id", "recipient_type", "recipient_id",
                 "telegram_chat_id", "delivery_status", "attempt_count",
                 "next_attempt_at", "last_lease_token", "version", "created_at", "updated_at"
               ) VALUES (
                 $1::uuid, $2::uuid, $3::uuid, 'GUARDIAN', $4::uuid,
                 $5::bigint, $6, 0,
                 $7::timestamptz, 0, 1, $7::timestamptz, $7::timestamptz
               )
               ON CONFLICT ("outbox_event_id", "recipient_type", "recipient_id") DO NOTHING`,
              [
                crypto.randomUUID(),
                event.center_id,
                event.id,
                g.guardian_id,
                g.telegram_chat_id,
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
      // 1. Late ACK Fencing Check: verify event is still LEASED under exact leaseToken
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

      // 2. Check if this consumer already committed a receipt for this event or receipt key
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

      // 3. Execute internal domain mutation inside the same transaction
      const effectSummary = await params.effectFn(tx);
      if (this.config.nodeEnv === 'test' && params.testFaultAfterStep === 'DOMAIN_EFFECT') {
        throw new Error('SIMULATED_S13_CONSUMER_FAULT_AFTER_DOMAIN_EFFECT');
      }

      // 4. Insert append-only OutboxConsumerReceipt in the same transaction
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

  /**
   * Helper to fence any `notification_deliveries` state transition against `(outbox_events.id, center_id, status='LEASED', lease_token)`
   * inside a single PostgreSQL transaction (`S03`). If a slow worker's lease expired while `transportAdapter.sendNotification`
   * was in flight, this throws `StaleLeaseTokenError` and prevents overwriting the new leaseholder's state.
   */
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
   * Stages and processes `notification_deliveries` rows for a leased event with:
   * - `S03`: `lease_token` fencing on EVERY delivery state transition (`API_ACCEPTED`, `RETRY_429`,
   *   `FAILED_403_BLOCKED`, `SKIPPED_UNLINKED`, transient retry, and pre-send attempt persistence).
   * - `S03`: Durable pre-send attempt persistence (`last_lease_token = event.lease_token, attempt_count = attempt_count + 1`
   *   committed BEFORE `transportAdapter.sendNotification(...)`) so that even an abrupt process crash (`SIGKILL`)
   *   after external send is detected from durable PostgreSQL state (`priorLeaseToken > 0n`) and audited with
   *   `EXTERNAL_DELIVERY_AMBIGUOUS_AFTER_SEND` (`possible_duplicate_delivery: true`).
   * - `S04` & `S06`: Live pre-send re-verification of:
   *   1) `PromiseDue`: both `invoices.remaining_debt_uzs > 0` AND live `promises_to_pay` row (`status IN ('ACTIVE','OVERDUE_NOTIFIED') AND superseded_by_promise_id IS NULL`),
   *   2) `TeacherPingDue`: live `lesson_occurrences` (`status = 'SCHEDULED'`, `attendance_submitted_at IS NULL`, `0` `attendance_records`) and live effective teacher authority,
   *   3) Recipient authority: `GUARDIAN` (`guardians.status = 'ACTIVE'`, active `guardian_students`, `guardian_telegram_links.status = 'ACTIVE'`),
   *      and `TEACHER`/`ADMIN`/`DIRECTOR` (`staff_users.status = 'ACTIVE'`, matching role, and `telegram_user_id IS NOT NULL`).
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

    // B14 & S02 Restore Guard: When BOT_OUTBOUND_ENABLED is false, never call external network transport,
    // never falsely mark QUEUED deliveries as API_ACCEPTED, and do NOT burn the 8-attempt poison budget!
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

      // Live Pre-Send Verification (S04 & S06):
      // 1. If event is PromiseDue, verify BOTH that invoice still has remaining_debt_uzs > 0 AND
      //    that the specific promises_to_pay row is still ACTIVE/OVERDUE_NOTIFIED and NOT superseded!
      if (event.event_name === 'PromiseDue') {
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

      // 3. Re-verify live recipient authority & linked Telegram chat ID (S04):
      let resolvedChatId: bigint | null =
        deliv.telegram_chat_id !== null ? BigInt(deliv.telegram_chat_id) : null;

      if (deliv.recipient_type === 'GUARDIAN') {
        const targetStudentId =
          typeof event.payload_json.student_id === 'string' && event.payload_json.student_id
            ? event.payload_json.student_id
            : null;
        const linkRes = await this.db.query<{
          status: string;
          telegram_chat_id: string | null;
          guardian_status: string;
          has_active_student_link: boolean;
        }>(
          `SELECT gtl."status"::text AS status,
                  gtl."telegram_chat_id"::text AS telegram_chat_id,
                  g."status"::text AS guardian_status,
                  EXISTS (
                    SELECT 1
                      FROM "guardian_students" gs
                     WHERE gs."center_id" = g."center_id"
                       AND gs."guardian_id" = g."id"
                       AND gs."active" = TRUE
                       AND ($3::uuid IS NULL OR gs."student_id" = $3::uuid)
                  ) AS has_active_student_link
             FROM "guardians" g
             LEFT JOIN "guardian_telegram_links" gtl
               ON gtl."center_id" = g."center_id"
              AND gtl."guardian_id" = g."id"
              AND gtl."status" = 'ACTIVE'
            WHERE g."center_id" = $1::uuid
              AND g."id" = $2::uuid
            LIMIT 1`,
          [event.center_id, deliv.recipient_id, targetStudentId],
        );
        const activeLink = linkRes.rows[0];
        if (
          !activeLink ||
          activeLink.guardian_status !== 'ACTIVE' ||
          !activeLink.has_active_student_link ||
          activeLink.status !== 'ACTIVE' ||
          !activeLink.telegram_chat_id
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
        resolvedChatId = BigInt(activeLink.telegram_chat_id);
      } else {
        // Staff recipient (TEACHER, ADMIN, DIRECTOR): verify live staff_users.status == 'ACTIVE', role authority, and non-null telegram_user_id
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
      // while the delivery remained `QUEUED`, which means an earlier worker crashed or lost its lease after starting external send!
      const priorLeaseToken = BigInt(deliv.last_lease_token);
      if (priorLeaseToken > 0n && priorLeaseToken < event.lease_token && deliv.delivery_status === 'QUEUED') {
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

      // S03: Durably persist pre-send attempt state (`last_lease_token = event.lease_token, attempt_count = nextAttemptNumber`)
      // fenced by `lease_token` BEFORE calling `transportAdapter.sendNotification(...)`!
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
            event.lease_token.toString(10),
            nextAttemptNumber,
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
          payload: event.payload_json,
        });

        if (sendOutcome.status === 'DEFERRED_TRANSPORT_NOT_BOUND') {
          allTerminal = false;
          hasRetryPending = true;
          deferredWithoutAttemptBurn = true;
          const deferUntil = new Date(nowUtc.getTime() + 60_000);
          if (!earliestNextAttemptAt || deferUntil < earliestNextAttemptAt) {
            earliestNextAttemptAt = deferUntil;
          }
          // Roll back pre-send attempt marker since no external send was attempted
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
          // TRANSIENT_NETWORK_ERROR (fenced by lease_token)
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
            // Reset last_lease_token back to priorLeaseToken since send failed before reaching external provider
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

  /**
   * Completes a leased outbox event strictly fenced by `(id, center_id, status='LEASED', lease_token)`.
   * Rejects stale leaseholders with `StaleLeaseTokenError`.
   */
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

  /**
   * Schedules retry with bounded exponential backoff or transitions to `DEAD_LETTER` when
   * `attempt_count >= 8` (or when `forceDeadLetter` is true), strictly fenced by `lease_token`.
   * When `preserveAttemptBudget` is true (e.g. waiting while `BOT_OUTBOUND_ENABLED=false` or
   * unbound transport), decrements `attempt_count` so passive waiting never burns the 8-attempt poison budget (`S02`).
   */
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

  /**
   * Processes a single claimed `LeasedOutboxEventRow` through the versioned event registry,
   * all registered internal DB consumers, and any staged `notification_deliveries` rows (`S02`).
   * Unregistered `event_name` or unsupported `schema_version` is never silently marked `COMPLETED`;
   * it fails closed via `NonRetryablePoisonEventError` -> `DEAD_LETTER`.
   */
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

      // If deliveries are still pending retry (e.g. RETRY_429, BOT_OUTBOUND_ENABLED=false, or unbound transport),
      // release lease back to PENDING with nextAttemptAt (preserving attempt budget on deferred wait!)
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

  /**
   * Claims and processes one batch of eligible outbox events.
   */
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

  /**
   * Administrative DLQ replay seam (`13.01`): requires DIRECTOR or ADMIN role and non-empty reason,
   * resets `DEAD_LETTER` -> `PENDING` (`attempt_count = 0`), writes `audit_logs`, and preserves
   * `outbox_consumer_receipts` so already-committed internal effects are never duplicated.
   */
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
      // S04: Verify live staff_users authority in DB (ACTIVE status and matching DIRECTOR/ADMIN role)
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

  /**
   * Restore safety reconciliation (`B14`, `BR-17`, `T21.02`, `S02`): when `BOT_OUTBOUND_ENABLED = false`
   * after restoring a backup, selectively marks stale pre-restore `PENDING`/`LEASED` outbound notification
   * events as `SUPERSEDED_BY_RESTORE` (and marks their queued `notification_deliveries` as `SKIPPED_UNLINKED`),
   * while preserving unapplied internal domain/financial events (such as `AllocationAdjusted`, `GuardianLinkRevoked`,
   * `PromiseFulfilled`, `LicenseStateChanged`) so their internal DB consumers still execute!
   */
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
