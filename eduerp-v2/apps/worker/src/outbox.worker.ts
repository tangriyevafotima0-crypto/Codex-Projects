/**
 * EduERP v2.0 — Stage 13, Step 13.01 (`T13.01`, `S2F04`, `B13`, `B14`, `BR-15`, `BR-17`, `D09`, `D17`):
 * Transactional Outbox Lease Acquisition (`FOR UPDATE SKIP LOCKED`), Monotonic `lease_token` Fencing,
 * Predecessor `aggregate_version` Ordering Gate, Atomic `OutboxConsumerReceipt` Deduplication,
 * Per-Recipient `NotificationDelivery` Fanout with Honest Send-Crash Ambiguity Observability,
 * Bounded Exponential Backoff (`attempt_count <= 8`), and `DEAD_LETTER` Handling.
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
    };

export interface ExternalNotificationTransportAdapter {
  sendNotification(
    request: ExternalNotificationSendRequest,
  ): Promise<ExternalNotificationSendOutcome>;
}

export type SyntheticAdapterMode =
  | 'ACCEPT_OK'
  | 'CRASH_BEFORE_SEND'
  | 'CRASH_AFTER_SEND_BEFORE_ACK'
  | 'RATE_LIMIT_429'
  | 'BLOCKED_403'
  | 'TRANSIENT_TIMEOUT';

export class SyntheticNotificationTransportAdapter
  implements ExternalNotificationTransportAdapter
{
  private mode: SyntheticAdapterMode = 'ACCEPT_OK';
  private nextMessageId = 900_000n;
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
    private readonly transportAdapter: ExternalNotificationTransportAdapter = new SyntheticNotificationTransportAdapter(),
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
    // 1. AllocationAdjusted -> PromiseLifecycleConsumer (auto-fulfills/cancels open PromiseToPay when remaining_debt_uzs == 0)
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
   * Stages and processes `notification_deliveries` rows for a leased event with
   * live `guardian_telegram_links.status = 'ACTIVE'` and `invoices.remaining_debt_uzs > 0`
   * checks and honest send-crash ambiguity tracking (`13.01`, `13.02`, `S2F04`).
   */
  public async processNotificationDeliveriesForEvent(
    event: LeasedOutboxEventRow,
    nowUtc: Date = this.clock(),
  ): Promise<{
    readonly allTerminal: boolean;
    readonly hasRetryPending: boolean;
    readonly earliestNextAttemptAt: Date | null;
    readonly ambiguousAfterSendCount: number;
  }> {
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
        earliestNextAttemptAt: null,
        ambiguousAfterSendCount: 0,
      };
    }

    // B14 Restore Guard: When BOT_OUTBOUND_ENABLED is false, never call external network transport
    // and never falsely mark QUEUED deliveries as API_ACCEPTED!
    if (!this.config.botOutboundEnabled) {
      const anyNonTerminal = deliveriesRes.rows.some(
        (d) => d.delivery_status === 'QUEUED' || d.delivery_status === 'RETRY_429',
      );
      return {
        allTerminal: !anyNonTerminal,
        hasRetryPending: anyNonTerminal,
        earliestNextAttemptAt: anyNonTerminal
          ? new Date(nowUtc.getTime() + 60_000)
          : null,
        ambiguousAfterSendCount: 0,
      };
    }

    let allTerminal = true;
    let hasRetryPending = false;
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

      // Live Pre-Send Verification:
      // 1. If event is PromiseDue, verify invoice still has remaining_debt_uzs > 0
      if (event.event_name === 'PromiseDue' && event.payload_json.invoice_id) {
        const invCheck = await this.db.query<{ remaining_debt_uzs: string }>(
          `SELECT "remaining_debt_uzs"::text AS remaining_debt_uzs
             FROM "invoices"
            WHERE "id" = $1::uuid AND "center_id" = $2::uuid
            LIMIT 1`,
          [String(event.payload_json.invoice_id), event.center_id],
        );
        if (!invCheck.rows[0] || BigInt(invCheck.rows[0].remaining_debt_uzs) <= 0n) {
          await this.db.query(
            `UPDATE "notification_deliveries"
                SET "delivery_status" = 'SKIPPED_UNLINKED',
                    "last_lease_token" = $3::bigint,
                    "version" = "version" + 1,
                    "updated_at" = $4::timestamptz
              WHERE "id" = $1::uuid AND "center_id" = $2::uuid`,
            [deliv.id, event.center_id, event.lease_token.toString(10), nowUtc.toISOString()],
          );
          continue;
        }
      }

      // 2. If recipient_type is GUARDIAN, verify guardian_telegram_links.status == 'ACTIVE'
      let resolvedChatId: bigint | null =
        deliv.telegram_chat_id !== null ? BigInt(deliv.telegram_chat_id) : null;
      if (deliv.recipient_type === 'GUARDIAN') {
        const linkRes = await this.db.query<{
          status: string;
          telegram_chat_id: string | null;
        }>(
          `SELECT "status"::text AS status, "telegram_chat_id"::text AS telegram_chat_id
             FROM "guardian_telegram_links"
            WHERE "center_id" = $1::uuid
              AND "guardian_id" = $2::uuid
              AND "status" = 'ACTIVE'
            LIMIT 1`,
          [event.center_id, deliv.recipient_id],
        );
        const activeLink = linkRes.rows[0];
        if (!activeLink || !activeLink.telegram_chat_id) {
          await this.db.query(
            `UPDATE "notification_deliveries"
                SET "delivery_status" = 'SKIPPED_UNLINKED',
                    "last_lease_token" = $3::bigint,
                    "version" = "version" + 1,
                    "updated_at" = $4::timestamptz
              WHERE "id" = $1::uuid AND "center_id" = $2::uuid`,
            [deliv.id, event.center_id, event.lease_token.toString(10), nowUtc.toISOString()],
          );
          continue;
        }
        resolvedChatId = BigInt(activeLink.telegram_chat_id);
      }

      // Mark attempt start with current lease_token before external send so that if a crash occurs
      // after external send but before API_ACCEPTED commit, the next worker sees last_lease_token > 0!
      const priorLeaseToken = BigInt(deliv.last_lease_token);
      const nextAttemptNumber = Number(deliv.attempt_count) + 1;

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

        if (sendOutcome.status === 'API_ACCEPTED') {
          await this.db.runInTransaction(async (tx) => {
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
          await this.db.query(
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
        } else if (sendOutcome.status === 'FAILED_403_BLOCKED') {
          await this.db.runInTransaction(async (tx) => {
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
          // TRANSIENT_NETWORK_ERROR
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
          await this.db.query(
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
        }
      } catch (err: unknown) {
        if (err instanceof StaleLeaseTokenError) {
          throw err;
        }
        const wasExternalSendAlreadyDone = Boolean(
          (err as { externalSendAlreadyOccurred?: boolean })?.externalSendAlreadyOccurred,
        );
        if (wasExternalSendAlreadyDone || priorLeaseToken > 0n) {
          ambiguousAfterSendCount += 1;
          await this.db.query(
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
          await this.db.query(
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
        throw err;
      }
    }

    return {
      allTerminal,
      hasRetryPending,
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
   */
  public async failOrRetryOutboxEventFenced(params: {
    readonly eventId: string;
    readonly centerId?: string;
    readonly leaseToken: bigint;
    readonly attemptCount: number;
    readonly error: unknown;
    readonly forceDeadLetter?: boolean;
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
    const shouldDeadLetter =
      Boolean(params.forceDeadLetter) ||
      params.error instanceof NonRetryablePoisonEventError ||
      params.attemptCount >= OUTBOX_MAX_ATTEMPTS;

    const backoffSeconds = computeOutboxBackoffDelaySeconds(params.attemptCount);
    const nextAttemptAt =
      params.nextAttemptAtOverride ?? new Date(nowUtc.getTime() + backoffSeconds * 1000);
    const newStatus: 'PENDING' | 'DEAD_LETTER' = shouldDeadLetter ? 'DEAD_LETTER' : 'PENDING';

    return this.db.runInTransaction(async (tx) => {
      const updRes = await tx.query(
        `UPDATE "outbox_events"
            SET "status" = $4,
                "lease_until" = NULL,
                "next_attempt_at" = $5::timestamptz,
                "last_error" = $6,
                "updated_at" = $7::timestamptz
          WHERE "id" = $1::uuid
            AND "center_id" = $2::uuid
            AND "status" = 'LEASED'
            AND "lease_token" = $3::bigint`,
        [
          params.eventId,
          centerId,
          params.leaseToken.toString(10),
          newStatus,
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
              attempt_count: params.attemptCount,
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
   * Processes a single claimed `LeasedOutboxEventRow` through all registered internal DB consumers
   * and any staged `notification_deliveries` rows.
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
      const consumers = this.internalConsumers.get(event.event_name) ?? [];
      let receiptsProcessed = 0;

      for (const spec of consumers) {
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

      // If deliveries are still pending retry (e.g. RETRY_429 or BOT_OUTBOUND_ENABLED=false),
      // release lease back to PENDING with nextAttemptAt
      const retryOut = await this.failOrRetryOutboxEventFenced({
        eventId: event.id,
        centerId: event.center_id,
        leaseToken: event.lease_token,
        attemptCount: event.attempt_count,
        error: new Error(
          !this.config.botOutboundEnabled
            ? 'BOT_OUTBOUND_DISABLED_RESTORE_GUARD'
            : 'NOTIFICATION_DELIVERY_RETRY_PENDING',
        ),
        forceDeadLetter: false,
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
          params.actorRole,
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
   * Restore safety reconciliation (`B14`, `BR-17`, `T21.02`): when `BOT_OUTBOUND_ENABLED = false`
   * after restoring a backup, marks stale pre-restore `PENDING`/`LEASED` notification events as
   * `SUPERSEDED_BY_RESTORE` before outbound sending is re-enabled.
   */
  public async reconcileRestoredOutbox(params: {
    readonly centerId?: string;
    readonly cutoffUtc: Date;
    readonly reason: string;
    readonly nowUtc?: Date;
  }): Promise<{ readonly supersededCount: number }> {
    if (this.config.botOutboundEnabled) {
      throw new Error(
        'RESTORE_RECONCILE_REQUIRES_BOT_OUTBOUND_DISABLED: BOT_OUTBOUND_ENABLED must be false during restore reconciliation (B14)',
      );
    }
    const centerId = params.centerId ?? this.config.centerId;
    const nowUtc = params.nowUtc ?? this.clock();

    return this.db.runInTransaction(async (tx) => {
      const res = await tx.query<{ id: string }>(
        `UPDATE "outbox_events"
            SET "status" = 'SUPERSEDED_BY_RESTORE',
                "lease_until" = NULL,
                "updated_at" = $3::timestamptz
          WHERE "center_id" = $1::uuid
            AND "status" IN ('PENDING', 'LEASED')
            AND "occurred_at_utc" <= $2::timestamptz
          RETURNING "id"::text AS id`,
        [centerId, params.cutoffUtc.toISOString(), nowUtc.toISOString()],
      );

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

      return { supersededCount: res.rows.length };
    });
  }
}
