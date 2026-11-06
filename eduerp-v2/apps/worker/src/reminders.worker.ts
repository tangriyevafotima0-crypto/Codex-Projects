/**
 * EduERP v2.0 — Stage 13, Step 13.02 (`T13.02`, `BR-05`, `CASE-11`, `CASE-22`, `OPEN_CHANNEL_02`, `S04`):
 * Center-Local `09:00` Promise-to-Pay Reminder Job, Explicit Confirmed Channel Policy Enforcement
 * (`OPEN_CHANNEL_02`), Live `remaining_debt_uzs > 0` & Active Guardian/Admin Authority Re-Verification,
 * Settled/Superseded Promise Suppression (`CASE-22`), and Bounded Same-Day Catch-Up.
 */

import * as crypto from 'node:crypto';
import { NotificationDeliveryStatus } from '@eduerp/contracts';
import { WorkerEnvConfig } from './config/env';
import {
  formatCenterLocalDateParts,
  WorkerDatabase,
} from './database';

export type PromiseReminderCatchUpPolicy =
  | 'SAME_LOCAL_DAY_ONLY'
  | 'BOUNDED_1_DAY_CATCHUP'
  | 'UNBOUNDED_HISTORICAL_SPAM';

export type AdminReminderChannelPolicy =
  | 'CONFIRMED_ADMIN_AND_GUARDIAN'
  | 'CONFIRMED_GUARDIAN_ONLY'
  | 'UNCONFIGURED_CHANNEL_POLICY';

export interface PromiseReminderTickResult {
  readonly centerLocalDate: string;
  readonly centerLocalHour: number;
  readonly skippedBeforeNineAm: boolean;
  readonly remindersEmittedCount: number;
  readonly autoFulfilledSettledCount: number;
  readonly suppressedSupersededOrNotifiedCount: number;
  readonly emittedPromiseIds: readonly string[];
  readonly autoFulfilledPromiseIds: readonly string[];
}

export class RemindersWorker {
  constructor(
    private readonly config: WorkerEnvConfig,
    private readonly db: WorkerDatabase,
    private readonly clock: () => Date = () => new Date(),
    private readonly defaultChannelPolicy?: AdminReminderChannelPolicy,
  ) {}

  private async resolveEffectiveChannelPolicy(
    explicitOption?: AdminReminderChannelPolicy,
  ): Promise<AdminReminderChannelPolicy> {
    if (explicitOption !== undefined) {
      return explicitOption;
    }
    if (this.defaultChannelPolicy !== undefined) {
      return this.defaultChannelPolicy;
    }
    const envPolicy = (process.env.PROMISE_REMINDER_CHANNEL_POLICY ?? '').trim();
    if (
      envPolicy === 'CONFIRMED_ADMIN_AND_GUARDIAN' ||
      envPolicy === 'CONFIRMED_GUARDIAN_ONLY' ||
      envPolicy === 'UNCONFIGURED_CHANNEL_POLICY'
    ) {
      return envPolicy;
    }
    const polRes = await this.db.query<{ policy_confirmation_status: string }>(
      `SELECT "policy_confirmation_status"::text AS policy_confirmation_status
         FROM "billing_policy_versions"
        WHERE "center_id" = $1::uuid
        ORDER BY "version_number" DESC
        LIMIT 1`,
      [this.config.centerId],
    );
    if (polRes.rows[0]?.policy_confirmation_status === 'CONFIRMED') {
      return 'CONFIRMED_ADMIN_AND_GUARDIAN';
    }
    return 'UNCONFIGURED_CHANNEL_POLICY';
  }

  /**
   * Executes the `09:00` center-local `PromiseReminderJob` (`13.02`, `S04`):
   * - Never emits reminders before `09:00` in `config.centerTimezone`.
   * - Rejects unconfirmed multi-day spam catch-up policies (`UNBOUNDED_HISTORICAL_SPAM`) and
   *   unconfigured channel policies (`UNCONFIGURED_CHANNEL_POLICY`) with `POLICY_DECISION_NOT_CONFIRMED`
   *   before mutating any `promises_to_pay`, `outbox_events`, or `notification_deliveries`.
   * - Re-reads live `invoices.remaining_debt_uzs` and `promises_to_pay` status inside a locked transaction:
   *   - If `remaining_debt_uzs == 0`, transitions `ACTIVE` promise to `FULFILLED` and emits `PromiseFulfilled` (`CASE-22`).
   *   - If `status == 'ACTIVE'` and `superseded_by_promise_id IS NULL` and `reminder_sent_at IS NULL` and `remaining_debt_uzs > 0`,
   *     emits `PromiseDue` (`v1`) with `dedup_key = "PromiseDue:${promise_id}:${promise_date}"`, stages `notification_deliveries`
   *     only for actively linked guardians (`gs.active = TRUE AND g.status = 'ACTIVE'`) and (when `CONFIRMED_ADMIN_AND_GUARDIAN`)
   *     center Admins (`SKIPPED_UNLINKED` when `telegram_user_id IS NULL`), and marks `status = 'OVERDUE_NOTIFIED'`.
   */
  public async runPromiseReminderTick(options: {
    readonly nowUtc?: Date;
    readonly catchUpPolicy?: PromiseReminderCatchUpPolicy;
    readonly channelPolicy?: AdminReminderChannelPolicy;
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

    const channelPolicy = await this.resolveEffectiveChannelPolicy(options.channelPolicy);
    if (channelPolicy === 'UNCONFIGURED_CHANNEL_POLICY') {
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
        if (remainingDebtUzs <= 0n || row.invoice_status === 'PAID' || row.invoice_status === 'GRANT_ZERO') {
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
            JSON.stringify({
              promise_id: row.id,
              student_id: row.student_id,
              invoice_id: row.invoice_id,
              promise_date: promiseDateStr,
              verified_remaining_debt_uzs: remainingDebtUzs.toString(10),
            }),
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

        // Stage notification_deliveries ONLY for ACTIVE guardians with gs.active = TRUE
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
             LEFT JOIN "guardian_telegram_links" gtl
               ON gtl."center_id" = gs."center_id"
              AND gtl."guardian_id" = gs."guardian_id"
              AND gtl."status" = 'ACTIVE'
            WHERE gs."center_id" = $1::uuid
              AND gs."student_id" = $2::uuid
              AND gs."active" = TRUE
              AND g."status" = 'ACTIVE'`,
          [this.config.centerId, row.student_id],
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
              this.config.centerId,
              outboxEventId,
              g.guardian_id,
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
                 "telegram_chat_id", "delivery_status", "attempt_count",
                 "next_attempt_at", "last_lease_token", "version", "created_at", "updated_at"
               ) VALUES (
                 $1::uuid, $2::uuid, $3::uuid, 'ADMIN', $4::uuid,
                 $5::bigint, $6, 0,
                 $7::timestamptz, 0, 1, $7::timestamptz, $7::timestamptz
               )
               ON CONFLICT ("outbox_event_id", "recipient_type", "recipient_id") DO NOTHING`,
              [
                crypto.randomUUID(),
                this.config.centerId,
                outboxEventId,
                adm.id,
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
      remindersEmittedCount: emittedPromiseIds.length,
      autoFulfilledSettledCount: autoFulfilledPromiseIds.length,
      suppressedSupersededOrNotifiedCount: suppressedCount,
      emittedPromiseIds,
      autoFulfilledPromiseIds,
    };
  }
}
