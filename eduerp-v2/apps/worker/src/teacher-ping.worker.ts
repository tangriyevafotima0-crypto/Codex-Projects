/**
 * EduERP v2.0 — Stage 13, Step 13.03 (`T13.03`, `BR-12`, `D11`, `OPEN_CHANNEL_01`, `OPEN_CHANNEL_02`):
 * 20-Minute Unsubmitted Attendance Teacher Ping (`STAGE_20M_PING`) & Lesson-End Admin Escalation
 * (`STAGE_END_ADMIN_ESCALATION`) with Live Primary/Substitute Teacher Resolution and
 * Cancelled/Rescheduled/Submitted Suppression.
 */

import * as crypto from 'node:crypto';
import { WorkerEnvConfig } from './config/env';
import { WorkerDatabase } from './database';

export interface TeacherPingTickResult {
  readonly teacherPingsEmittedCount: number;
  readonly adminEscalationsEmittedCount: number;
  readonly suppressedCancelledOrSubmittedCount: number;
  readonly pingedLessonIds: readonly string[];
  readonly escalatedLessonIds: readonly string[];
}

export class TeacherPingWorker {
  constructor(
    private readonly config: WorkerEnvConfig,
    private readonly db: WorkerDatabase,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /**
   * Scans `lesson_occurrences` in `config.centerId` (`13.03`):
   * - Suppresses `CANCELLED_BY_CENTER`, `RESCHEDULED`, and `COMPLETED` lessons or any lesson where
   *   `attendance_submitted_at IS NOT NULL` or `attendance_records` exist.
   * - Dynamically resolves the live authorized teacher (`ACTIVE` `substitute_assignments.substitute_teacher_id`
   *   for this single lesson, else `course_groups.primary_teacher_id`).
   * - If an old substitute assignment was revoked/reassigned after an earlier `STAGE_20M_PING` was queued,
   *   suppresses any queued delivery to the old teacher (`SKIPPED_UNLINKED`) and pings the current active teacher!
   * - At `starts_at_utc + 20 minutes` (when `nowUtc < ends_at_utc` or when 20m ping has not yet been sent before end),
   *   emits `TeacherPingDue` (`STAGE_20M_PING`) once per `(lesson_id, effective_teacher_id)`.
   * - At `nowUtc >= ends_at_utc`, if attendance is still unsubmitted, emits `TeacherPingDue`
   *   (`STAGE_END_ADMIN_ESCALATION`) once per `lesson_id` to center Admin(s).
   */
  public async runTeacherPingAndEscalationTick(options: {
    readonly nowUtc?: Date;
  } = {}): Promise<TeacherPingTickResult> {
    const nowUtc = options.nowUtc ?? this.clock();

    const liveLicenseMode = await this.db.resolveLiveCenterLicenseMode();
    if (liveLicenseMode === 'READ_ONLY') {
      return {
        teacherPingsEmittedCount: 0,
        adminEscalationsEmittedCount: 0,
        suppressedCancelledOrSubmittedCount: 0,
        pingedLessonIds: [],
        escalatedLessonIds: [],
      };
    }

    const twentyMinThresholdUtc = new Date(nowUtc.getTime() - 20 * 60 * 1000);

    const candidatesRes = await this.db.query<{ id: string }>(
      `SELECT lo."id"::text AS id
         FROM "lesson_occurrences" lo
        WHERE lo."center_id" = $1::uuid
          AND (
            lo."starts_at_utc" <= $2::timestamptz
            OR lo."ends_at_utc" <= $3::timestamptz
          )
        ORDER BY lo."starts_at_utc" ASC, lo."id" ASC`,
      [this.config.centerId, twentyMinThresholdUtc.toISOString(), nowUtc.toISOString()],
    );

    const pingedLessonIds: string[] = [];
    const escalatedLessonIds: string[] = [];
    let suppressedCount = 0;

    for (const cand of candidatesRes.rows) {
      const outcome = await this.db.runInTransaction(async (tx) => {
        const lessonRes = await tx.query<{
          id: string;
          group_id: string;
          starts_at_utc: Date;
          ends_at_utc: Date;
          status: string;
          pay_recipient_teacher_id: string;
          attendance_submitted_at: Date | null;
          attendance_version: number;
          teacher_ping_sent_at: Date | null;
          teacher_ping_recipient_id: string | null;
          admin_escalation_sent_at: Date | null;
          version: number;
        }>(
          `SELECT "id"::text AS id,
                  "group_id"::text AS group_id,
                  "starts_at_utc",
                  "ends_at_utc",
                  "status"::text AS status,
                  "pay_recipient_teacher_id"::text AS pay_recipient_teacher_id,
                  "attendance_submitted_at",
                  "attendance_version",
                  "teacher_ping_sent_at",
                  "teacher_ping_recipient_id"::text AS teacher_ping_recipient_id,
                  "admin_escalation_sent_at",
                  "version"
             FROM "lesson_occurrences"
            WHERE "id" = $1::uuid AND "center_id" = $2::uuid
            FOR UPDATE`,
          [cand.id, this.config.centerId],
        );

        const lesson = lessonRes.rows[0];
        if (!lesson) {
          return { pingEmitted: false, escalationEmitted: false, suppressed: true };
        }

        const attRecCountRes = await tx.query<{ cnt: string }>(
          `SELECT COUNT(*)::text AS cnt
             FROM "attendance_records"
            WHERE "center_id" = $1::uuid AND "lesson_id" = $2::uuid`,
          [this.config.centerId, lesson.id],
        );
        const hasSubmittedAttendance =
          lesson.status === 'COMPLETED' ||
          lesson.attendance_submitted_at !== null ||
          Number(lesson.attendance_version) >= 1 ||
          Number(attRecCountRes.rows[0]?.cnt ?? '0') > 0;

        // If lesson is cancelled, rescheduled, or already has submitted attendance, suppress any queued pings!
        if (
          lesson.status === 'CANCELLED_BY_CENTER' ||
          lesson.status === 'RESCHEDULED' ||
          hasSubmittedAttendance
        ) {
          await tx.query(
            `UPDATE "notification_deliveries" AS nd
                SET "delivery_status" = 'SKIPPED_UNLINKED',
                    "version" = nd."version" + 1,
                    "updated_at" = $3::timestamptz
               FROM "outbox_events" AS oe
              WHERE nd."outbox_event_id" = oe."id"
                AND nd."center_id" = oe."center_id"
                AND oe."center_id" = $1::uuid
                AND oe."aggregate_type" = 'LessonOccurrence'
                AND oe."aggregate_id" = $2::uuid
                AND oe."event_name" = 'TeacherPingDue'
                AND nd."delivery_status" IN ('QUEUED', 'RETRY_429')`,
            [this.config.centerId, lesson.id, nowUtc.toISOString()],
          );
          return { pingEmitted: false, escalationEmitted: false, suppressed: true };
        }

        // Resolve live primary teacher vs ACTIVE single-lesson substitute teacher AFTER locking lesson
        const metaRes = await tx.query<{
          group_status: string;
          primary_teacher_id: string;
          sub_teacher_id: string | null;
        }>(
          `SELECT cg."status"::text AS group_status,
                  cg."primary_teacher_id"::text AS primary_teacher_id,
                  sa."substitute_teacher_id"::text AS sub_teacher_id
             FROM "course_groups" cg
             LEFT JOIN "substitute_assignments" sa
               ON sa."lesson_id" = $3::uuid
              AND sa."center_id" = cg."center_id"
              AND sa."status" = 'ACTIVE'
            WHERE cg."id" = $1::uuid AND cg."center_id" = $2::uuid
            LIMIT 1`,
          [lesson.group_id, this.config.centerId, lesson.id],
        );
        const meta = metaRes.rows[0];
        if (!meta || meta.group_status !== 'ACTIVE') {
          return { pingEmitted: false, escalationEmitted: false, suppressed: true };
        }

        const effectiveTeacherId = meta.sub_teacher_id ?? meta.primary_teacher_id;

        // If a previous ping was sent to a teacher who is no longer the effective teacher (e.g. substitute revoked/reassigned),
        // suppress any queued notification_deliveries for the old teacher so two teachers never receive active pings!
        if (
          lesson.teacher_ping_recipient_id !== null &&
          lesson.teacher_ping_recipient_id !== effectiveTeacherId
        ) {
          await tx.query(
            `UPDATE "notification_deliveries" AS nd
                SET "delivery_status" = 'SKIPPED_UNLINKED',
                    "version" = nd."version" + 1,
                    "updated_at" = $4::timestamptz
               FROM "outbox_events" AS oe
              WHERE nd."outbox_event_id" = oe."id"
                AND nd."center_id" = oe."center_id"
                AND oe."center_id" = $1::uuid
                AND oe."aggregate_type" = 'LessonOccurrence'
                AND oe."aggregate_id" = $2::uuid
                AND oe."event_name" = 'TeacherPingDue'
                AND nd."recipient_type" = 'TEACHER'
                AND nd."recipient_id" = $3::uuid
                AND nd."delivery_status" IN ('QUEUED', 'RETRY_429')`,
            [
              this.config.centerId,
              lesson.id,
              lesson.teacher_ping_recipient_id,
              nowUtc.toISOString(),
            ],
          );
        }

        const startsAtMs = new Date(lesson.starts_at_utc).getTime();
        const endsAtMs = new Date(lesson.ends_at_utc).getTime();
        const nowMs = nowUtc.getTime();
        const durationMs = endsAtMs - startsAtMs;

        let pingEmitted = false;
        let escalationEmitted = false;

        // Stage 1: 20-Minute Teacher Ping (only if lesson duration > 20m and either not yet sent or recipient changed before end)
        const eligibleFor20mPing =
          durationMs > 20 * 60 * 1000 &&
          nowMs >= startsAtMs + 20 * 60 * 1000 &&
          (lesson.teacher_ping_sent_at === null ||
            (lesson.teacher_ping_recipient_id !== effectiveTeacherId && nowMs < endsAtMs));

        if (eligibleFor20mPing) {
          const nextVer = Number(lesson.version) + 1;
          const dedupKey = `TeacherPingDue:${lesson.id}:STAGE_20M_PING:${effectiveTeacherId}`;
          const evtId = crypto.randomUUID();

          const insPing = await tx.query<{ id: string }>(
            `INSERT INTO "outbox_events" (
               "id", "center_id", "event_name", "schema_version",
               "aggregate_type", "aggregate_id", "aggregate_version",
               "dedup_key", "payload_json", "status", "lease_token",
               "occurred_at_utc", "next_attempt_at", "updated_at"
             ) VALUES (
               $1::uuid, $2::uuid, 'TeacherPingDue', 1,
               'LessonOccurrence', $3::uuid, $4::int,
               $5, $6::jsonb, 'PENDING', 0,
               $7::timestamptz, $7::timestamptz, $7::timestamptz
             )
             ON CONFLICT ("dedup_key") DO NOTHING
             RETURNING "id"::text AS id`,
            [
              evtId,
              this.config.centerId,
              lesson.id,
              nextVer,
              dedupKey,
              JSON.stringify({
                lesson_id: lesson.id,
                group_id: lesson.group_id,
                effective_teacher_id: effectiveTeacherId,
                escalation_stage: 'STAGE_20M_PING',
                starts_at_utc: new Date(lesson.starts_at_utc).toISOString(),
                ends_at_utc: new Date(lesson.ends_at_utc).toISOString(),
              }),
              nowUtc.toISOString(),
            ],
          );

          if (insPing.rows.length > 0) {
            pingEmitted = true;
            await tx.query(
              `UPDATE "lesson_occurrences"
                  SET "teacher_ping_sent_at" = $3::timestamptz,
                      "teacher_ping_recipient_id" = $4::uuid,
                      "pay_recipient_teacher_id" = $4::uuid,
                      "version" = $5::int,
                      "updated_at" = $3::timestamptz
                WHERE "id" = $1::uuid AND "center_id" = $2::uuid`,
              [
                lesson.id,
                this.config.centerId,
                nowUtc.toISOString(),
                effectiveTeacherId,
                nextVer,
              ],
            );

            const tchRes = await tx.query<{ telegram_user_id: string | null }>(
              `SELECT "telegram_user_id"::text AS telegram_user_id
                 FROM "staff_users"
                WHERE "id" = $1::uuid AND "center_id" = $2::uuid AND "status" = 'ACTIVE'
                LIMIT 1`,
              [effectiveTeacherId, this.config.centerId],
            );
            await tx.query(
              `INSERT INTO "notification_deliveries" (
                 "id", "center_id", "outbox_event_id", "recipient_type", "recipient_id",
                 "telegram_chat_id", "delivery_status", "attempt_count",
                 "next_attempt_at", "last_lease_token", "version", "created_at", "updated_at"
               ) VALUES (
                 $1::uuid, $2::uuid, $3::uuid, 'TEACHER', $4::uuid,
                 $5::bigint, 'QUEUED', 0,
                 $6::timestamptz, 0, 1, $6::timestamptz, $6::timestamptz
               )
               ON CONFLICT ("outbox_event_id", "recipient_type", "recipient_id") DO NOTHING`,
              [
                crypto.randomUUID(),
                this.config.centerId,
                evtId,
                effectiveTeacherId,
                tchRes.rows[0]?.telegram_user_id ?? null,
                nowUtc.toISOString(),
              ],
            );
          }
        }

        // Stage 2: Lesson-End Admin Escalation (once when nowUtc >= ends_at_utc and still unsubmitted)
        if (nowMs >= endsAtMs && lesson.admin_escalation_sent_at === null) {
          const curVerRes = await tx.query<{ version: number }>(
            `SELECT "version" FROM "lesson_occurrences" WHERE "id" = $1::uuid AND "center_id" = $2::uuid`,
            [lesson.id, this.config.centerId],
          );
          const nextEscVer = Number(curVerRes.rows[0]?.version ?? lesson.version) + 1;
          const escDedupKey = `TeacherPingDue:${lesson.id}:STAGE_END_ADMIN_ESCALATION`;
          const escEvtId = crypto.randomUUID();

          const insEsc = await tx.query<{ id: string }>(
            `INSERT INTO "outbox_events" (
               "id", "center_id", "event_name", "schema_version",
               "aggregate_type", "aggregate_id", "aggregate_version",
               "dedup_key", "payload_json", "status", "lease_token",
               "occurred_at_utc", "next_attempt_at", "updated_at"
             ) VALUES (
               $1::uuid, $2::uuid, 'TeacherPingDue', 1,
               'LessonOccurrence', $3::uuid, $4::int,
               $5, $6::jsonb, 'PENDING', 0,
               $7::timestamptz, $7::timestamptz, $7::timestamptz
             )
             ON CONFLICT ("dedup_key") DO NOTHING
             RETURNING "id"::text AS id`,
            [
              escEvtId,
              this.config.centerId,
              lesson.id,
              nextEscVer,
              escDedupKey,
              JSON.stringify({
                lesson_id: lesson.id,
                group_id: lesson.group_id,
                effective_teacher_id: effectiveTeacherId,
                escalation_stage: 'STAGE_END_ADMIN_ESCALATION',
                starts_at_utc: new Date(lesson.starts_at_utc).toISOString(),
                ends_at_utc: new Date(lesson.ends_at_utc).toISOString(),
              }),
              nowUtc.toISOString(),
            ],
          );

          if (insEsc.rows.length > 0) {
            escalationEmitted = true;
            await tx.query(
              `UPDATE "lesson_occurrences"
                  SET "admin_escalation_sent_at" = $3::timestamptz,
                      "version" = $4::int,
                      "updated_at" = $3::timestamptz
                WHERE "id" = $1::uuid AND "center_id" = $2::uuid`,
              [lesson.id, this.config.centerId, nowUtc.toISOString(), nextEscVer],
            );

            const adminsRes = await tx.query<{ id: string; telegram_user_id: string | null }>(
              `SELECT "id"::text AS id, "telegram_user_id"::text AS telegram_user_id
                 FROM "staff_users"
                WHERE "center_id" = $1::uuid
                  AND "role" IN ('ADMIN', 'DIRECTOR')
                  AND "status" = 'ACTIVE'
                ORDER BY CASE WHEN "role" = 'ADMIN' THEN 0 ELSE 1 END, "created_at" ASC`,
              [this.config.centerId],
            );
            for (const adm of adminsRes.rows) {
              await tx.query(
                `INSERT INTO "notification_deliveries" (
                   "id", "center_id", "outbox_event_id", "recipient_type", "recipient_id",
                   "telegram_chat_id", "delivery_status", "attempt_count",
                   "next_attempt_at", "last_lease_token", "version", "created_at", "updated_at"
                 ) VALUES (
                   $1::uuid, $2::uuid, $3::uuid, 'ADMIN', $4::uuid,
                   $5::bigint, 'QUEUED', 0,
                   $6::timestamptz, 0, 1, $6::timestamptz, $6::timestamptz
                 )
                 ON CONFLICT ("outbox_event_id", "recipient_type", "recipient_id") DO NOTHING`,
                [
                  crypto.randomUUID(),
                  this.config.centerId,
                  escEvtId,
                  adm.id,
                  adm.telegram_user_id,
                  nowUtc.toISOString(),
                ],
              );
            }
          }
        }

        return {
          pingEmitted,
          escalationEmitted,
          suppressed: !pingEmitted && !escalationEmitted,
        };
      });

      if (outcome.pingEmitted) pingedLessonIds.push(cand.id);
      if (outcome.escalationEmitted) escalatedLessonIds.push(cand.id);
      if (outcome.suppressed) suppressedCount += 1;
    }

    return {
      teacherPingsEmittedCount: pingedLessonIds.length,
      adminEscalationsEmittedCount: escalatedLessonIds.length,
      suppressedCancelledOrSubmittedCount: suppressedCount,
      pingedLessonIds,
      escalatedLessonIds,
    };
  }
}
