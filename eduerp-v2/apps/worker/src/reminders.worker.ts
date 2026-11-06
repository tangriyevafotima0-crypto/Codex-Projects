/**
 * EduERP v2.0 — Stage 13, Step 13.02 (`T13.02`, `BR-05`, `CASE-11`, `CASE-22`, `OPEN_CHANNEL_02`, `OWNER-20261105-04`, `S13FIX-T` / `T03`):
 * Center-Local `09:00` Promise-to-Pay Reminder Job, Feature-Specific Per-Center Notification Policy Enforcement
 * (`OPEN_CHANNEL_02` — default `UNCONFIGURED_CHANNEL_POLICY`; general S08 billing confirmation NEVER implicitly
 * confirms `PromiseDue` reminder channels), Policy Version Provenance, Live `remaining_debt_uzs > 0` & Active
 * Guardian/Admin Authority Re-Verification, Settled/Superseded Promise Suppression (`CASE-22`), and Bounded Same-Day Catch-Up.
 */

import * as crypto from 'node:crypto';
import { NotificationDeliveryStatus, PromiseReminderChannelPolicy } from '@eduerp/contracts';
import { WorkerEnvConfig } from './config/env';
import {
  formatCenterLocalDateParts,
  WorkerDatabase,
} from './database';

export type PromiseReminderCatchUpPolicy =
  | 'SAME_LOCAL_DAY_ONLY'
  | 'BOUNDED_1_DAY_CATCHUP'
  | 'UNBOUNDED_HISTORICAL_SPAM';

export type AdminReminderChannelPolicy = PromiseReminderChannelPolicy;

export interface EffectiveNotificationPolicyResolution {
  readonly channelPolicy: AdminReminderChannelPolicy;
  readonly notificationPolicyStatus: 'UNCONFIGURED' | 'CONFIRMED';
  readonly policyVersionId: string | null;
  readonly policyVersionNumber: number | null;
  readonly effectiveFromDate: string | null;
  readonly effectiveUntilDate: string | null;
}

export interface PromiseReminderTickResult {
  readonly centerLocalDate: string;
  readonly centerLocalHour: number;
  readonly skippedBeforeNineAm: boolean;
  readonly unconfiguredChannelPolicyDeferred?: boolean;
  readonly remindersEmittedCount: number;
  readonly autoFulfilledSettledCount: number;
  readonly suppressedSupersededOrNotifiedCount: number;
  readonly emittedPromiseIds: readonly string[];
  readonly autoFulfilledPromiseIds: readonly string[];
}

function formatPgDate(val: unknown): string | null {
  if (val === null || val === undefined || val === '') return null;
  if (val instanceof Date) return val.toISOString().slice(0, 10);
  const s = String(val).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

export class RemindersWorker {
  constructor(
    private readonly config: WorkerEnvConfig,
    private readonly db: WorkerDatabase,
    private readonly clock: () => Date = () => new Date(),
    private readonly defaultChannelPolicy?: AdminReminderChannelPolicy,
  ) {}

  /**
   * Resolves the center's feature-specific notification policy from `billing_policy_versions` (`T03`).
   * Invariant (`OPEN_CHANNEL_02`, `OWNER-20261105-04`):
   * - General S08 `policy_confirmation_status = 'CONFIRMED'` NEVER implicitly confirms `PromiseDue` reminder channels!
   * - No undocumented environment variable fallback (`PROMISE_REMINDER_CHANNEL_POLICY`) is permitted.
   * - Requires explicit `notification_policy_status = 'CONFIRMED'`, `promise_reminder_channel_policy` in
   *   `('CONFIRMED_GUARDIAN_ONLY', 'CONFIRMED_ADMIN_AND_GUARDIAN')`, `effective_from_date <= localDate`,
   *   and `(notification_policy_effective_until IS NULL OR notification_policy_effective_until >= localDate)`.
   * - Otherwise fails closed to `'UNCONFIGURED_CHANNEL_POLICY'`.
   */
  public async resolveEffectiveChannelPolicyMetadata(
    explicitOption?: AdminReminderChannelPolicy,
    asOfLocalDate?: string,
  ): Promise<EffectiveNotificationPolicyResolution> {
    if (explicitOption !== undefined) {
      return {
        channelPolicy: explicitOption,
        notificationPolicyStatus:
          explicitOption === 'UNCONFIGURED_CHANNEL_POLICY' ? 'UNCONFIGURED' : 'CONFIRMED',
        policyVersionId: null,
        policyVersionNumber: null,
        effectiveFromDate: asOfLocalDate ?? null,
        effectiveUntilDate: null,
      };
    }
    if (this.defaultChannelPolicy !== undefined) {
      return {
        channelPolicy: this.defaultChannelPolicy,
        notificationPolicyStatus:
          this.defaultChannelPolicy === 'UNCONFIGURED_CHANNEL_POLICY'
            ? 'UNCONFIGURED'
            : 'CONFIRMED',
        policyVersionId: null,
        policyVersionNumber: null,
        effectiveFromDate: asOfLocalDate ?? null,
        effectiveUntilDate: null,
      };
    }

    const targetLocalDate =
      asOfLocalDate ??
      formatCenterLocalDateParts(this.clock(), this.config.centerTimezone).localDate;

    const polRes = await this.db.query<{
      id: string;
      version_number: number;
      notification_policy_status?: string | null;
      promise_reminder_channel_policy?: string | null;
      effective_from_date?: unknown;
      notification_policy_effective_until?: unknown;
    }>(
      `SELECT "id"::text AS id,
              "version_number",
              "notification_policy_status"::text AS notification_policy_status,
              "promise_reminder_channel_policy"::text AS promise_reminder_channel_policy,
              "effective_from_date"::text AS effective_from_date,
              "notification_policy_effective_until"::text AS notification_policy_effective_until
         FROM "billing_policy_versions"
        WHERE "center_id" = $1::uuid
        ORDER BY "version_number" DESC
        LIMIT 1`,
      [this.config.centerId],
    );

    const latest = polRes.rows[0];
    if (!latest) {
      return {
        channelPolicy: 'UNCONFIGURED_CHANNEL_POLICY',
        notificationPolicyStatus: 'UNCONFIGURED',
        policyVersionId: null,
        policyVersionNumber: null,
        effectiveFromDate: null,
        effectiveUntilDate: null,
      };
    }

    const notifStatus =
      latest.notification_policy_status === 'CONFIRMED' ? 'CONFIRMED' : 'UNCONFIGURED';
    const rawChannelPolicy = latest.promise_reminder_channel_policy;
    const channelPolicy: AdminReminderChannelPolicy =
      rawChannelPolicy === 'CONFIRMED_GUARDIAN_ONLY' ||
      rawChannelPolicy === 'CONFIRMED_ADMIN_AND_GUARDIAN'
        ? rawChannelPolicy
        : 'UNCONFIGURED_CHANNEL_POLICY';
    const effectiveFromDate = formatPgDate(latest.effective_from_date);
    const effectiveUntilDate = formatPgDate(latest.notification_policy_effective_until);

    const isActiveAndConfirmed =
      notifStatus === 'CONFIRMED' &&
      channelPolicy !== 'UNCONFIGURED_CHANNEL_POLICY' &&
      effectiveFromDate !== null &&
      effectiveFromDate <= targetLocalDate &&
      (effectiveUntilDate === null || effectiveUntilDate >= targetLocalDate);

    if (!isActiveAndConfirmed) {
      return {
        channelPolicy: 'UNCONFIGURED_CHANNEL_POLICY',
        notificationPolicyStatus: 'UNCONFIGURED',
        policyVersionId: latest.id,
        policyVersionNumber: Number(latest.version_number),
        effectiveFromDate,
        effectiveUntilDate,
      };
    }

    return {
      channelPolicy,
      notificationPolicyStatus: 'CONFIRMED',
      policyVersionId: latest.id,
      policyVersionNumber: Number(latest.version_number),
      effectiveFromDate,
      effectiveUntilDate,
    };
  }

  public async resolveEffectiveChannelPolicy(
    explicitOption?: AdminReminderChannelPolicy,
    asOfLocalDate?: string,
  ): Promise<AdminReminderChannelPolicy> {
    const meta = await this.resolveEffectiveChannelPolicyMetadata(explicitOption, asOfLocalDate);
    return meta.channelPolicy;
  }

  /**
   * Executes the `09:00` center-local `PromiseReminderJob` (`13.02`, `S04`, `T03`):
   * - Never emits reminders before `09:00` in `config.centerTimezone`.
   * - Rejects unconfirmed multi-day spam catch-up policies (`UNBOUNDED_HISTORICAL_SPAM`).
   * - Enforces explicit per-center notification policy (`resolveEffectiveChannelPolicyMetadata`):
   *   - When `allowUnconfiguredDefer: true` (automatic runtime poll loop) and center notification policy is
   *     `UNCONFIGURED_CHANNEL_POLICY`, returns a bounded deferred result (`unconfiguredChannelPolicyDeferred: true`,
   *     `0` intents, `0` sends) without flooding error logs every 500ms.
   *   - Otherwise fails closed with `POLICY_DECISION_NOT_CONFIRMED` when `channelPolicy === 'UNCONFIGURED_CHANNEL_POLICY'`.
   * - Records `policy_version_id` and `policy_version_number` provenance on emitted `PromiseDue` outbox payloads
   *   and `notification_deliveries` rows.
   */
  public async runPromiseReminderTick(options: {
    readonly nowUtc?: Date;
    readonly catchUpPolicy?: PromiseReminderCatchUpPolicy;
    readonly channelPolicy?: AdminReminderChannelPolicy;
    readonly allowUnconfiguredDefer?: boolean;
  } = {}): Promise<PromiseReminderTickResult> {
    const nowUtc = options.nowUtc ?? this.clock();
    const catchUpPolicy = options.catchUpPolicy ?? 'SAME_LOCAL_DAY_ONLY';

    if (catchUpPolicy === 'UNBOUNDED_HISTORICAL_SPAM') {
      throw new Error(
        'POLICY_DECISION_NOT_CONFIRMED: Unbounded multi-day historical promise reminder catch-up spam is not permitted (13.02)',
      );
    }
    if (options.channelPolicy === 'UNCONFIGURED_CHANNEL_POLICY') {
      throw new Error(
        'POLICY_DECISION_NOT_CONFIRMED: Recipient channel policy for PromiseDue reminder is unconfigured (OPEN_CHANNEL_02, 13.02)',
      );
    }

    const liveLicenseMode = await this.db.resolveLiveCenterLicenseMode();
    if (liveLicenseMode === 'READ_ONLY') {
      const localParts = formatCenterLocalDateParts(nowUtc, this.config.centerTimezone);
      return {
        centerLocalDate: localParts.localDate,
        centerLocalHour: localParts.localHour,
        skippedBeforeNineAm: false,
        remindersEmittedCount: 0,
        autoFulfilledSettledCount: 0,
        suppressedSupersededOrNotifiedCount: 0,
        emittedPromiseIds: [],
        autoFulfilledPromiseIds: [],
      };
    }

    const localParts = formatCenterLocalDateParts(nowUtc, this.config.centerTimezone);
    if (localParts.localHour < 9) {
      return {
        centerLocalDate: localParts.localDate,
        centerLocalHour: localParts.localHour,
        skippedBeforeNineAm: true,
        remindersEmittedCount: 0,
        autoFulfilledSettledCount: 0,
        suppressedSupersededOrNotifiedCount: 0,
        emittedPromiseIds: [],
        autoFulfilledPromiseIds: [],
      };
    }

    const policyMeta = await this.resolveEffectiveChannelPolicyMetadata(
      options.channelPolicy,
      localParts.localDate,
    );
    const channelPolicy = policyMeta.channelPolicy;
    if (channelPolicy === 'UNCONFIGURED_CHANNEL_POLICY') {
      if (options.allowUnconfiguredDefer) {
        return {
          centerLocalDate: localParts.localDate,
          centerLocalHour: localParts.localHour,
          skippedBeforeNineAm: false,
          unconfiguredChannelPolicyDeferred: true,
          remindersEmittedCount: 0,
          autoFulfilledSettledCount: 0,
          suppressedSupersededOrNotifiedCount: 0,
          emittedPromiseIds: [],
          autoFulfilledPromiseIds: [],
        };
      }
      throw new Error(
        'POLICY_DECISION_NOT_CONFIRMED: Recipient channel policy for PromiseDue reminder is unconfigured (OPEN_CHANNEL_02, 13.02)',
      );
    }

    // Compute earliest eligible promise_date for bounded catch-up
    const todayDateObj = new Date(`${localParts.localDate}T00:00:00.000Z`);
    const minDateObj =
      catchUpPolicy === 'BOUNDED_1_DAY_CATCHUP'
        ? new Date(todayDateObj.getTime() - 24 * 60 * 60 * 1000)
        : todayDateObj;
    const minEligiblePromiseDate = minDateObj.toISOString().slice(0, 10);

    const candidatesRes = await this.db.query<{ id: string }>(
      `SELECT p."id"::text AS id
         FROM "promises_to_pay" p
        WHERE p."center_id" = $1::uuid
          AND p."promise_date" <= $2::date
          AND p."promise_date" >= $3::date
        ORDER BY p."promise_date" ASC, p."created_at" ASC, p."id" ASC`,
      [this.config.centerId, localParts.localDate, minEligiblePromiseDate],
    );

    const emittedPromiseIds: string[] = [];
    const autoFulfilledPromiseIds: string[] = [];
    let suppressedCount = 0;

    for (const cand of candidatesRes.rows) {
      const outcome = await this.db.runInTransaction(async (tx) => {
        const rowRes = await tx.query<{
          id: string;
          student_id: string;
          invoice_id: string;
          trigger_payment_id: string;
          promised_amount_uzs: string;
          promise_date: string;
          status: string;
          superseded_by_promise_id: string | null;
          reminder_sent_at: Date | null;
          version: number;
          invoice_remaining_debt_uzs: string;
          invoice_status: string;
        }>(
          `SELECT p."id"::text AS id,
                  p."student_id"::text AS student_id,
                  p."invoice_id"::text AS invoice_id,
                  p."trigger_payment_id"::text AS trigger_payment_id,
                  p."promised_amount_uzs"::text AS promised_amount_uzs,
                  p."promise_date"::text AS promise_date,
                  p."status"::text AS status,
                  p."superseded_by_promise_id"::text AS superseded_by_promise_id,
                  p."reminder_sent_at",
                  p."version",
                  i."remaining_debt_uzs"::text AS invoice_remaining_debt_uzs,
                  i."status"::text AS invoice_status
             FROM "promises_to_pay" p
             JOIN "invoices" i
               ON i."id" = p."invoice_id"
              AND i."center_id" = p."center_id"
            WHERE p."id" = $1::uuid
              AND p."center_id" = $2::uuid
            FOR UPDATE OF p, i`,
          [cand.id, this.config.centerId],
        );

        const row = rowRes.rows[0];
        if (!row) {
          return 'SUPPRESSED' as const;
        }

        const remainingDebtUzs = BigInt(row.invoice_remaining_debt_uzs);
        const promiseDateStr = String(row.promise_date).slice(0, 10);

        // CASE-22: If debt is already 0, auto-fulfill open promise and suppress any due reminder!
        if (
          remainingDebtUzs <= 0n ||
          row.invoice_status === 'PAID' ||
          row.invoice_status === 'GRANT_ZERO'
        ) {
          if (row.status === 'ACTIVE' || row.status === 'OVERDUE_NOTIFIED') {
            const nextVer = Number(row.version) + 1;
            await tx.query(
              `UPDATE "promises_to_pay"
                  SET "status" = 'FULFILLED',
                      "version" = $3::int,
                      "updated_at" = $4::timestamptz
                WHERE "id" = $1::uuid AND "center_id" = $2::uuid`,
              [row.id, this.config.centerId, nextVer, nowUtc.toISOString()],
            );
            await tx.query(
              `INSERT INTO "outbox_events" (
                 "id", "center_id", "event_name", "schema_version",
                 "aggregate_type", "aggregate_id", "aggregate_version",
                 "dedup_key", "payload_json", "status", "lease_token",
                 "occurred_at_utc", "next_attempt_at", "updated_at"
               ) VALUES (
                 $1::uuid, $2::uuid, 'PromiseFulfilled', 1,
                 'PromiseToPay', $3::uuid, $4::int,
                 $5, $6::jsonb, 'PENDING', 0,
                 $7::timestamptz, $7::timestamptz, $7::timestamptz
               ) ON CONFLICT ("dedup_key") DO NOTHING`,
              [
                crypto.randomUUID(),
                this.config.centerId,
                row.id,
                nextVer,
                `PromiseFulfilled:${row.id}:v${nextVer}`,
                JSON.stringify({
                  promise_id: row.id,
                  student_id: row.student_id,
                  invoice_id: row.invoice_id,
                  fulfilled_by_payment_id: row.trigger_payment_id,
                  fulfilled_at_utc: nowUtc.toISOString(),
                }),
                nowUtc.toISOString(),
              ],
            );
            return 'AUTO_FULFILLED' as const;
          }
          return 'SUPPRESSED' as const;
        }

        if (
          row.status !== 'ACTIVE' ||
          row.superseded_by_promise_id !== null ||
          row.reminder_sent_at !== null
        ) {
          return 'SUPPRESSED' as const;
        }

        const nextVer = Number(row.version) + 1;
        const dedupKey = `PromiseDue:${row.id}:${promiseDateStr}`;
        const outboxEventId = crypto.randomUUID();
        const eventPayload = {
          promise_id: row.id,
          student_id: row.student_id,
          invoice_id: row.invoice_id,
          promise_date: promiseDateStr,
          verified_remaining_debt_uzs: remainingDebtUzs.toString(10),
          channel_policy: channelPolicy,
          policy_version_id: policyMeta.policyVersionId,
          policy_version_number: policyMeta.policyVersionNumber,
        };

        const insEvt = await tx.query<{ id: string }>(
          `INSERT INTO "outbox_events" (
             "id", "center_id", "event_name", "schema_version",
             "aggregate_type", "aggregate_id", "aggregate_version",
             "dedup_key", "payload_json", "status", "lease_token",
             "occurred_at_utc", "next_attempt_at", "updated_at"
           ) VALUES (
             $1::uuid, $2::uuid, 'PromiseDue', 1,
             'PromiseToPay', $3::uuid, $4::int,
             $5, $6::jsonb, 'PENDING', 0,
             $7::timestamptz, $7::timestamptz, $7::timestamptz
           )
           ON CONFLICT ("dedup_key") DO NOTHING
           RETURNING "id"::text AS id`,
          [
            outboxEventId,
            this.config.centerId,
            row.id,
            nextVer,
            dedupKey,
            JSON.stringify(eventPayload),
            nowUtc.toISOString(),
          ],
        );

        if (insEvt.rows.length === 0) {
          return 'SUPPRESSED' as const;
        }

        await tx.query(
          `UPDATE "promises_to_pay"
              SET "status" = 'OVERDUE_NOTIFIED',
                  "reminder_sent_at" = $3::timestamptz,
                  "version" = $4::int,
                  "updated_at" = $3::timestamptz
            WHERE "id" = $1::uuid AND "center_id" = $2::uuid`,
          [row.id, this.config.centerId, nowUtc.toISOString(), nextVer],
        );

        // Stage notification_deliveries ONLY for ACTIVE guardians with gs.active = TRUE and s.status = 'ACTIVE'
        const guardiansRes = await tx.query<{
          guardian_id: string;
          telegram_chat_id: string | null;
        }>(
          `SELECT gs."guardian_id"::text AS guardian_id,
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
              AND gs."student_id" = $2::uuid
              AND gs."active" = TRUE
              AND g."status" = 'ACTIVE'
              AND s."status" = 'ACTIVE'`,
          [this.config.centerId, row.student_id],
        );

        for (const g of guardiansRes.rows) {
          const delivStatus: NotificationDeliveryStatus = g.telegram_chat_id
            ? 'QUEUED'
            : 'SKIPPED_UNLINKED';
          await tx.query(
            `INSERT INTO "notification_deliveries" (
               "id", "center_id", "outbox_event_id", "recipient_type", "recipient_id",
               "target_student_id", "payload_projection_json", "policy_version_id",
               "telegram_chat_id", "delivery_status", "attempt_count",
               "next_attempt_at", "last_lease_token", "version", "created_at", "updated_at"
             ) VALUES (
               $1::uuid, $2::uuid, $3::uuid, 'GUARDIAN', $4::uuid,
               $5::uuid, $6::jsonb, $7::uuid,
               $8::bigint, $9, 0,
               $10::timestamptz, 0, 1, $10::timestamptz, $10::timestamptz
             )
             ON CONFLICT ("outbox_event_id", "recipient_type", "recipient_id") DO NOTHING`,
            [
              crypto.randomUUID(),
              this.config.centerId,
              outboxEventId,
              g.guardian_id,
              row.student_id,
              JSON.stringify(eventPayload),
              policyMeta.policyVersionId,
              g.telegram_chat_id,
              delivStatus,
              nowUtc.toISOString(),
            ],
          );
        }

        if (channelPolicy === 'CONFIRMED_ADMIN_AND_GUARDIAN') {
          const adminsRes = await tx.query<{ id: string; telegram_user_id: string | null }>(
            `SELECT "id"::text AS id, "telegram_user_id"::text AS telegram_user_id
               FROM "staff_users"
              WHERE "center_id" = $1::uuid
                AND "role" = 'ADMIN'
                AND "status" = 'ACTIVE'
              ORDER BY "created_at" ASC`,
            [this.config.centerId],
          );
          for (const adm of adminsRes.rows) {
            const adminDelivStatus: NotificationDeliveryStatus = adm.telegram_user_id
              ? 'QUEUED'
              : 'SKIPPED_UNLINKED';
            await tx.query(
              `INSERT INTO "notification_deliveries" (
                 "id", "center_id", "outbox_event_id", "recipient_type", "recipient_id",
                 "target_student_id", "payload_projection_json", "policy_version_id",
                 "telegram_chat_id", "delivery_status", "attempt_count",
                 "next_attempt_at", "last_lease_token", "version", "created_at", "updated_at"
               ) VALUES (
                 $1::uuid, $2::uuid, $3::uuid, 'ADMIN', $4::uuid,
                 $5::uuid, $6::jsonb, $7::uuid,
                 $8::bigint, $9, 0,
                 $10::timestamptz, 0, 1, $10::timestamptz, $10::timestamptz
               )
               ON CONFLICT ("outbox_event_id", "recipient_type", "recipient_id") DO NOTHING`,
              [
                crypto.randomUUID(),
                this.config.centerId,
                outboxEventId,
                adm.id,
                row.student_id,
                JSON.stringify(eventPayload),
                policyMeta.policyVersionId,
                adm.telegram_user_id,
                adminDelivStatus,
                nowUtc.toISOString(),
              ],
            );
          }
        }

        await tx.query(
          `INSERT INTO "audit_logs" (
             "id", "center_id", "actor_type", "actor_id", "actor_role",
             "action", "entity_type", "entity_id", "severity",
             "before_redacted_json", "after_redacted_json", "request_id", "created_at"
           ) VALUES (
             $1::uuid, $2::uuid, 'SYSTEM_WORKER', NULL, NULL,
             'PROMISE_DUE_REMINDER_EMITTED', 'PromiseToPay', $3::uuid, 'INFO',
             '{"status":"ACTIVE"}'::jsonb, $4::jsonb, $5, $6::timestamptz
           )`,
          [
            crypto.randomUUID(),
            this.config.centerId,
            row.id,
            JSON.stringify({
              promise_id: row.id,
              invoice_id: row.invoice_id,
              promise_date: promiseDateStr,
              verified_remaining_debt_uzs: remainingDebtUzs.toString(10),
              channel_policy: channelPolicy,
              policy_version_id: policyMeta.policyVersionId,
              policy_version_number: policyMeta.policyVersionNumber,
              status: 'OVERDUE_NOTIFIED',
            }),
            `wrk-rem-${row.id.slice(0, 8)}`,
            nowUtc.toISOString(),
          ],
        );

        return 'EMITTED' as const;
      });

      if (outcome === 'EMITTED') {
        emittedPromiseIds.push(cand.id);
      } else if (outcome === 'AUTO_FULFILLED') {
        autoFulfilledPromiseIds.push(cand.id);
      } else {
        suppressedCount += 1;
      }
    }

    return {
      centerLocalDate: localParts.localDate,
      centerLocalHour: localParts.localHour,
      skippedBeforeNineAm: false,
      unconfiguredChannelPolicyDeferred: false,
      remindersEmittedCount: emittedPromiseIds.length,
      autoFulfilledSettledCount: autoFulfilledPromiseIds.length,
      suppressedSupersededOrNotifiedCount: suppressedCount,
      emittedPromiseIds,
      autoFulfilledPromiseIds,
    };
  }
}
