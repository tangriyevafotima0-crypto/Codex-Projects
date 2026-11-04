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
import { executeOptimisticUpdate, TransactionContext } from '../database/transaction';
import { parseOptionalStrictBoolean, validateIsoDate } from '../students/normalization';
import { AcademicAccessService } from './academic-access.service';
import {
  ALLOWED_CANCELLATION_SOURCES,
  CancellationSource,
  DstDisambiguationMode,
  enumerateCalendarDatesInclusive,
  formatInstantInTimezone,
  getIsoDateWeekday,
  isLessonEligibleForOperationalTriggers,
  LessonStatus,
  resolveWallTimeToUtcInstant,
  ScheduleDayCode,
  validateIanaTimezone,
  validateWallTimeHhMm,
} from './academic-validation';

export interface LessonOccurrenceResponseDto {
  readonly id: string;
  readonly group_id: string;
  readonly lesson_date: string;
  readonly occurrence_seq: number;
  readonly starts_at_utc: string;
  readonly ends_at_utc: string;
  readonly status: LessonStatus;
  readonly rescheduled_from_lesson_id: string | null;
  readonly primary_teacher_snapshot_id: string;
  readonly pay_recipient_teacher_id: string;
  readonly cancellation_reason: string | null;
  readonly cancellation_source: CancellationSource | null;
  readonly eligible_for_teacher_ping: boolean;
  readonly eligible_for_trial_conversion: boolean;
  readonly eligible_for_package_consumption: boolean;
  readonly version: number;
}

export interface LessonOccurrenceListResponseDto {
  readonly items: readonly LessonOccurrenceResponseDto[];
  readonly next_cursor: string | null;
}

export interface SkippedHolidayRecordDto {
  readonly lesson_date: string;
  readonly reason: string;
  readonly source: 'EXPLICIT_HOLIDAY_INPUT';
  readonly mode: 'SKIP' | 'CREATE_CANCELLED';
  readonly cancelled_lesson_id: string | null;
}

export interface GenerateRecurringLessonsResponseDto {
  readonly group_id: string;
  readonly start_date: string;
  readonly end_date: string;
  readonly timezone: string;
  readonly created_lessons: readonly LessonOccurrenceResponseDto[];
  readonly skipped_holidays: readonly SkippedHolidayRecordDto[];
}

function formatPgDate(val: unknown): string {
  if (val instanceof Date) {
    return val.toISOString().slice(0, 10);
  }
  return String(val).slice(0, 10);
}

export function mapLessonRowToDto(row: {
  id: string;
  group_id: string;
  lesson_date: unknown;
  occurrence_seq: number;
  starts_at_utc: Date | string;
  ends_at_utc: Date | string;
  status: LessonStatus;
  rescheduled_from_lesson_id: string | null;
  primary_teacher_snapshot_id: string;
  pay_recipient_teacher_id: string;
  cancellation_reason?: string | null;
  cancellation_source?: CancellationSource | null;
  version: number;
}): LessonOccurrenceResponseDto {
  const eligibility = isLessonEligibleForOperationalTriggers(row.status);
  return Object.freeze({
    id: row.id,
    group_id: row.group_id,
    lesson_date: formatPgDate(row.lesson_date),
    occurrence_seq: Number(row.occurrence_seq),
    starts_at_utc: new Date(row.starts_at_utc).toISOString(),
    ends_at_utc: new Date(row.ends_at_utc).toISOString(),
    status: row.status,
    rescheduled_from_lesson_id: row.rescheduled_from_lesson_id ?? null,
    primary_teacher_snapshot_id: row.primary_teacher_snapshot_id,
    pay_recipient_teacher_id: row.pay_recipient_teacher_id,
    cancellation_reason: row.cancellation_reason ?? null,
    cancellation_source: row.cancellation_source ?? null,
    eligible_for_teacher_ping: eligibility.eligible_for_teacher_ping,
    eligible_for_trial_conversion: eligibility.eligible_for_trial_conversion,
    eligible_for_package_consumption: eligibility.eligible_for_package_consumption,
    version: Number(row.version),
  });
}

@Injectable()
export class LessonsService {
  constructor(
    @Inject(API_CONFIG_TOKEN) private readonly config: ApiEnvConfig,
    @Inject(DatabaseService) private readonly databaseService: DatabaseService,
    @Inject(ClockService) private readonly clock: ClockService,
    @Inject(AcademicAccessService) private readonly academicAccess: AcademicAccessService,
  ) {}

  private async assertNoTeacherOrGroupTimeConflict(
    tx: TransactionContext,
    params: {
      readonly centerId: string;
      readonly groupId: string;
      readonly teacherId: string;
      readonly startsAtUtcIso: string;
      readonly endsAtUtcIso: string;
      readonly excludeLessonId?: string | null;
    },
  ): Promise<void> {
    const excludeId = params.excludeLessonId ?? null;

    // 1. Check overlapping SCHEDULED/COMPLETED lesson in the same group
    const groupOverlapRes = await tx.query<{ id: string }>(
      `SELECT "id"::text AS id
         FROM "lesson_occurrences"
        WHERE "center_id" = $1::uuid
          AND "group_id" = $2::uuid
          AND "status" IN ('SCHEDULED', 'COMPLETED')
          AND ($3::uuid IS NULL OR "id" <> $3::uuid)
          AND "starts_at_utc" < $5::timestamptz
          AND "ends_at_utc" > $4::timestamptz
        LIMIT 1`,
      [params.centerId, params.groupId, excludeId, params.startsAtUtcIso, params.endsAtUtcIso],
    );
    if (groupOverlapRes.rows[0]) {
      throw new ApiHttpException({
        statusCode: 409,
        errorCode: 'VERSION_CONFLICT',
        message: `GROUP_LESSON_TIME_CONFLICT: Group already has an overlapping lesson (${groupOverlapRes.rows[0].id}) during ${params.startsAtUtcIso}..${params.endsAtUtcIso}`,
      });
    }

    // 2. Check overlapping SCHEDULED/COMPLETED lesson for the same teacher across any group in the center
    const teacherOverlapRes = await tx.query<{ id: string; group_id: string }>(
      `SELECT "id"::text AS id, "group_id"::text AS group_id
         FROM "lesson_occurrences"
        WHERE "center_id" = $1::uuid
          AND "pay_recipient_teacher_id" = $2::uuid
          AND "status" IN ('SCHEDULED', 'COMPLETED')
          AND ($3::uuid IS NULL OR "id" <> $3::uuid)
          AND "starts_at_utc" < $5::timestamptz
          AND "ends_at_utc" > $4::timestamptz
        LIMIT 1`,
      [params.centerId, params.teacherId, excludeId, params.startsAtUtcIso, params.endsAtUtcIso],
    );
    if (teacherOverlapRes.rows[0]) {
      throw new ApiHttpException({
        statusCode: 409,
        errorCode: 'VERSION_CONFLICT',
        message: `TEACHER_SCHEDULE_TIME_CONFLICT: Teacher ${params.teacherId} already has an overlapping lesson (${teacherOverlapRes.rows[0].id}) during ${params.startsAtUtcIso}..${params.endsAtUtcIso}`,
      });
    }
  }

  public async scheduleGroupLessonOccurrence(
    req: RequestWithCorrelationId,
    principal: AuthenticatedStaffPrincipal,
    rawGroupId: string,
    rawBody: unknown,
  ): Promise<LessonOccurrenceResponseDto> {
    const idempotencyKey = requireIdempotencyKeyHeader(req);
    const groupId = assertValidUuid(rawGroupId, 'group_id');
    const obj = assertPlainObject(rawBody, [
      'lesson_date',
      'occurrence_seq',
      'starts_at_utc',
      'ends_at_utc',
      'local_starts_time',
      'duration_minutes',
      'timezone',
      'dst_disambiguation',
      'rescheduled_from_lesson_id',
      'expected_version',
      'debug_fail_after_reschedule_source_update',
    ]);

    const lessonDate = validateIsoDate(obj.lesson_date, 'lesson_date');
    const occurrenceSeq =
      obj.occurrence_seq === undefined ? 1 : Number(obj.occurrence_seq);
    if (!Number.isInteger(occurrenceSeq) || occurrenceSeq < 1 || occurrenceSeq > 10) {
      throw new ApiHttpException({
        statusCode: 400,
        errorCode: 'VALIDATION_ERROR',
        message: 'occurrence_seq must be an integer between 1 and 10',
      });
    }

    const rescheduledFromLessonId =
      obj.rescheduled_from_lesson_id !== undefined && obj.rescheduled_from_lesson_id !== null
        ? assertValidUuid(obj.rescheduled_from_lesson_id, 'rescheduled_from_lesson_id')
        : null;

    let expectedVersion: number | null = null;
    if (obj.expected_version !== undefined || req.headers['if-match-version'] !== undefined) {
      expectedVersion = resolveExpectedVersion(req, obj.expected_version);
    }

    let disambiguation: DstDisambiguationMode = 'REJECT';
    if (obj.dst_disambiguation !== undefined && obj.dst_disambiguation !== null) {
      const dRaw = typeof obj.dst_disambiguation === 'string' ? obj.dst_disambiguation.trim().toUpperCase() : '';
      if (dRaw !== 'REJECT' && dRaw !== 'EARLIER' && dRaw !== 'LATER') {
        throw new ApiHttpException({
          statusCode: 400,
          errorCode: 'VALIDATION_ERROR',
          message: 'dst_disambiguation must be REJECT, EARLIER, or LATER',
        });
      }
      disambiguation = dRaw as DstDisambiguationMode;
    }

    const explicitTz =
      obj.timezone !== undefined && obj.timezone !== null
        ? validateIanaTimezone(obj.timezone, 'timezone')
        : null;

    const hasExplicitUtc = obj.starts_at_utc !== undefined || obj.ends_at_utc !== undefined;
    const hasLocalWallTime = obj.local_starts_time !== undefined;
    if (!hasExplicitUtc && !hasLocalWallTime) {
      throw new ApiHttpException({
        statusCode: 400,
        errorCode: 'VALIDATION_ERROR',
        message: 'Either (starts_at_utc and ends_at_utc) or local_starts_time must be provided',
      });
    }

    let parsedStartsAtUtc: Date | null = null;
    let parsedEndsAtUtc: Date | null = null;
    if (hasExplicitUtc) {
      if (
        typeof obj.starts_at_utc !== 'string' ||
        typeof obj.ends_at_utc !== 'string' ||
        !obj.starts_at_utc.endsWith('Z') ||
        !obj.ends_at_utc.endsWith('Z')
      ) {
        throw new ApiHttpException({
          statusCode: 400,
          errorCode: 'VALIDATION_ERROR',
          message: 'starts_at_utc and ends_at_utc must be explicit UTC ISO-8601 timestamps ending with Z',
        });
      }
      parsedStartsAtUtc = new Date(obj.starts_at_utc);
      parsedEndsAtUtc = new Date(obj.ends_at_utc);
      if (Number.isNaN(parsedStartsAtUtc.getTime()) || Number.isNaN(parsedEndsAtUtc.getTime())) {
        throw new ApiHttpException({
          statusCode: 400,
          errorCode: 'VALIDATION_ERROR',
          message: 'starts_at_utc and ends_at_utc must be valid timestamps',
        });
      }
    }

    let localStartsTime: string | null = null;
    let localDurationMinutes: number | null = null;
    if (hasLocalWallTime) {
      localStartsTime = validateWallTimeHhMm(obj.local_starts_time, 'local_starts_time').formatted;
      if (obj.duration_minutes !== undefined && obj.duration_minutes !== null) {
        localDurationMinutes = Number(obj.duration_minutes);
        if (!Number.isInteger(localDurationMinutes) || localDurationMinutes < 15 || localDurationMinutes > 360) {
          throw new ApiHttpException({
            statusCode: 400,
            errorCode: 'VALIDATION_ERROR',
            message: 'duration_minutes must be an integer between 15 and 360',
          });
        }
      }
    }

    const debugFail =
      this.config.nodeEnv === 'test' &&
      parseOptionalStrictBoolean(
        obj.debug_fail_after_reschedule_source_update,
        'debug_fail_after_reschedule_source_update',
        false,
      );
    const now = this.clock.now();
    const requestId = req.requestId ?? resolveRequestId(req.headers['x-request-id']);

    const idemOutcome = await executeIdempotentOperation<LessonOccurrenceResponseDto>(
      this.databaseService,
      {
        centerId: principal.centerId,
        actorStaffId: principal.staffId,
        operationType: 'SCHEDULE_GROUP_LESSON_OCCURRENCE',
        idempotencyKey,
        requestPayload: {
          group_id: groupId,
          lesson_date: lessonDate,
          occurrence_seq: occurrenceSeq,
          starts_at_utc: parsedStartsAtUtc ? parsedStartsAtUtc.toISOString() : null,
          ends_at_utc: parsedEndsAtUtc ? parsedEndsAtUtc.toISOString() : null,
          local_starts_time: localStartsTime,
          duration_minutes: localDurationMinutes,
          timezone: explicitTz,
          dst_disambiguation: disambiguation,
          rescheduled_from_lesson_id: rescheduledFromLessonId,
          expected_version: expectedVersion,
        },
        handler: async (tx) => {
          // Lock the group row AND the primary teacher row FOR UPDATE so concurrent schedule requests
          // for the same group or the same teacher across different groups are strictly serialized!
          const group = await this.academicAccess.assertGroupAccess(tx, principal, groupId, {
            lockGroup: true,
          });
          if (group.status !== 'ACTIVE') {
            throw new ApiHttpException({
              statusCode: 422,
              errorCode: 'VALIDATION_ERROR',
              message: 'Cannot schedule lessons in an ARCHIVED course group',
            });
          }

          await this.academicAccess.verifyActiveTeacherInCenter(
            tx,
            principal.centerId,
            group.primary_teacher_id,
            'primary_teacher_id',
            true,
          );

          const effectiveTimezone = explicitTz ?? (group.timezone || this.config.centerTimezone);
          validateIanaTimezone(effectiveTimezone, 'timezone');

          let startsAtUtc: Date;
          let endsAtUtc: Date;
          if (localStartsTime !== null) {
            startsAtUtc = resolveWallTimeToUtcInstant({
              lessonDate,
              localTime: localStartsTime,
              timeZone: effectiveTimezone,
              disambiguation,
            });
            const durMin = localDurationMinutes ?? group.duration_minutes;
            endsAtUtc = new Date(startsAtUtc.getTime() + durMin * 60_000);
          } else {
            startsAtUtc = parsedStartsAtUtc!;
            endsAtUtc = parsedEndsAtUtc!;
          }

          const durationMs = endsAtUtc.getTime() - startsAtUtc.getTime();
          if (durationMs <= 0) {
            throw new ApiHttpException({
              statusCode: 422,
              errorCode: 'VALIDATION_ERROR',
              message: 'ends_at_utc must be strictly greater than starts_at_utc',
            });
          }
          if (durationMs < 15 * 60_000 || durationMs > 360 * 60_000) {
            throw new ApiHttpException({
              statusCode: 422,
              errorCode: 'VALIDATION_ERROR',
              message: 'Lesson duration must be between 15 and 360 minutes',
            });
          }

          // Verify starts_at_utc formatted in effectiveTimezone matches lessonDate!
          const startsLocal = formatInstantInTimezone(startsAtUtc, effectiveTimezone);
          if (startsLocal.date !== lessonDate) {
            throw new ApiHttpException({
              statusCode: 422,
              errorCode: 'VALIDATION_ERROR',
              message: `starts_at_utc (${startsAtUtc.toISOString()}) falls on ${startsLocal.date} in timezone ${effectiveTimezone}, which does not match lesson_date (${lessonDate})`,
            });
          }

          // Handle Reschedule lineage (07.02)
          if (rescheduledFromLessonId !== null) {
            const srcRes = await tx.query<{
              id: string;
              group_id: string;
              status: LessonStatus;
              rescheduled_from_lesson_id: string | null;
              version: number;
            }>(
              `SELECT "id"::text AS id,
                      "group_id"::text AS group_id,
                      "status"::text AS status,
                      "rescheduled_from_lesson_id"::text AS rescheduled_from_lesson_id,
                      "version"
                 FROM "lesson_occurrences"
                WHERE "id" = $1::uuid
                  AND "center_id" = $2::uuid
                FOR UPDATE`,
              [rescheduledFromLessonId, principal.centerId],
            );

            const srcLesson = srcRes.rows[0];
            if (!srcLesson) {
              throw new ApiHttpException({
                statusCode: 404,
                errorCode: 'NOT_FOUND',
                message: 'rescheduled_from_lesson_id not found in this center',
              });
            }
            if (srcLesson.group_id !== groupId) {
              throw new ApiHttpException({
                statusCode: 422,
                errorCode: 'VALIDATION_ERROR',
                message: 'rescheduled_from_lesson_id must belong to the same course group',
              });
            }
            if (srcLesson.status === 'COMPLETED') {
              throw new ApiHttpException({
                statusCode: 403,
                errorCode: 'POLICY_DECISION_NOT_CONFIRMED',
                message: 'Completed lessons cannot be rescheduled; historical lesson records are immutable',
              });
            }
            if (srcLesson.status !== 'SCHEDULED') {
              throw new ApiHttpException({
                statusCode: 409,
                errorCode: 'VERSION_CONFLICT',
                message: `Cannot reschedule a lesson that is already in ${srcLesson.status} status`,
              });
            }

            const srcExpectedVersion = expectedVersion ?? Number(srcLesson.version);
            await executeOptimisticUpdate(tx, {
              tableName: 'lesson_occurrences',
              entityName: 'LessonOccurrence',
              id: rescheduledFromLessonId,
              centerId: principal.centerId,
              expectedVersion: srcExpectedVersion,
              setClauseSql: `"status" = 'RESCHEDULED'`,
              additionalValues: [],
            });

            // Revoke any active substitute assignment on the old rescheduled slot
            await tx.query(
              `UPDATE "substitute_assignments"
                  SET "status" = 'REVOKED',
                      "revoked_at" = $3::timestamptz,
                      "revoke_reason" = 'LESSON_RESCHEDULED',
                      "version" = "version" + 1,
                      "updated_at" = $3::timestamptz
                WHERE "center_id" = $1::uuid
                  AND "lesson_id" = $2::uuid
                  AND "status" = 'ACTIVE'`,
              [principal.centerId, rescheduledFromLessonId, now.toISOString()],
            );

            if (debugFail) {
              throw new Error('INJECTED_FAULT_AFTER_RESCHEDULE_SOURCE_UPDATE');
            }
          }

          await this.assertNoTeacherOrGroupTimeConflict(tx, {
            centerId: principal.centerId,
            groupId,
            teacherId: group.primary_teacher_id,
            startsAtUtcIso: startsAtUtc.toISOString(),
            endsAtUtcIso: endsAtUtc.toISOString(),
            excludeLessonId: rescheduledFromLessonId,
          });

          const lessonId = crypto.randomUUID();
          try {
            const ins = await tx.query<{
              id: string;
              group_id: string;
              lesson_date: unknown;
              occurrence_seq: number;
              starts_at_utc: Date;
              ends_at_utc: Date;
              status: LessonStatus;
              rescheduled_from_lesson_id: string | null;
              primary_teacher_snapshot_id: string;
              pay_recipient_teacher_id: string;
              cancellation_reason: string | null;
              cancellation_source: CancellationSource | null;
              version: number;
            }>(
              `INSERT INTO "lesson_occurrences" (
                 "id", "center_id", "group_id", "lesson_date", "occurrence_seq",
                 "starts_at_utc", "ends_at_utc", "status", "rescheduled_from_lesson_id",
                 "primary_teacher_snapshot_id", "pay_recipient_teacher_id",
                 "version", "created_at", "updated_at"
               ) VALUES (
                 $1::uuid, $2::uuid, $3::uuid, $4::date, $5::smallint,
                 $6::timestamptz, $7::timestamptz, 'SCHEDULED', $8::uuid,
                 $9::uuid, $9::uuid,
                 1, $10::timestamptz, $10::timestamptz
               )
               RETURNING "id"::text AS id,
                         "group_id"::text AS group_id,
                         "lesson_date",
                         "occurrence_seq",
                         "starts_at_utc",
                         "ends_at_utc",
                         "status"::text AS status,
                         "rescheduled_from_lesson_id"::text AS rescheduled_from_lesson_id,
                         "primary_teacher_snapshot_id"::text AS primary_teacher_snapshot_id,
                         "pay_recipient_teacher_id"::text AS pay_recipient_teacher_id,
                         "cancellation_reason",
                         "cancellation_source"::text AS cancellation_source,
                         "version"`,
              [
                lessonId,
                principal.centerId,
                groupId,
                lessonDate,
                occurrenceSeq,
                startsAtUtc.toISOString(),
                endsAtUtc.toISOString(),
                rescheduledFromLessonId,
                group.primary_teacher_id,
                now.toISOString(),
              ],
            );

            const created = ins.rows[0];
            const auditAction =
              rescheduledFromLessonId !== null
                ? 'LESSON_OCCURRENCE_RESCHEDULED'
                : 'LESSON_OCCURRENCE_SCHEDULED';

            await tx.query(
              `INSERT INTO "audit_logs" (
                 "id", "center_id", "actor_type", "actor_id", "actor_role",
                 "action", "entity_type", "entity_id", "severity",
                 "after_redacted_json", "request_id", "created_at"
               ) VALUES (
                 $1::uuid, $2::uuid, 'STAFF', $3::uuid, $4,
                 $5, 'LessonOccurrence', $6::uuid, 'INFO',
                 $7::jsonb, $8, $9::timestamptz
               )`,
              [
                crypto.randomUUID(),
                principal.centerId,
                principal.staffId,
                principal.role,
                auditAction,
                lessonId,
                JSON.stringify({
                  lesson_id: lessonId,
                  group_id: groupId,
                  lesson_date: lessonDate,
                  occurrence_seq: occurrenceSeq,
                  starts_at_utc: startsAtUtc.toISOString(),
                  ends_at_utc: endsAtUtc.toISOString(),
                  timezone: effectiveTimezone,
                  rescheduled_from_lesson_id: rescheduledFromLessonId,
                  primary_teacher_snapshot_id: group.primary_teacher_id,
                  pay_recipient_teacher_id: group.primary_teacher_id,
                }),
                requestId,
                now.toISOString(),
              ],
            );

            return {
              statusCode: 201,
              body: mapLessonRowToDto(created),
            };
          } catch (err: unknown) {
            if ((err as { code?: string }).code === '23505') {
              throw new ApiHttpException({
                statusCode: 409,
                errorCode: 'VERSION_CONFLICT',
                message:
                  'Duplicate lesson occurrence (group_id + lesson_date + occurrence_seq or starts_at_utc already exists, or source lesson was already rescheduled)',
              });
            }
            throw err;
          }
        },
      },
    );

    return idemOutcome.body;
  }

  public async generateRecurringGroupLessons(
    req: RequestWithCorrelationId,
    principal: AuthenticatedStaffPrincipal,
    rawGroupId: string,
    rawBody: unknown,
  ): Promise<GenerateRecurringLessonsResponseDto> {
    const idempotencyKey = requireIdempotencyKeyHeader(req);
    const groupId = assertValidUuid(rawGroupId, 'group_id');
    const obj = assertPlainObject(rawBody, [
      'start_date',
      'end_date',
      'occurrence_seq',
      'holidays',
      'dst_disambiguation',
    ]);

    const startDate = validateIsoDate(obj.start_date, 'start_date');
    const endDate = validateIsoDate(obj.end_date, 'end_date');
    const allDates = enumerateCalendarDatesInclusive(startDate, endDate, 62);

    const occurrenceSeq = obj.occurrence_seq === undefined ? 1 : Number(obj.occurrence_seq);
    if (!Number.isInteger(occurrenceSeq) || occurrenceSeq < 1 || occurrenceSeq > 10) {
      throw new ApiHttpException({
        statusCode: 400,
        errorCode: 'VALIDATION_ERROR',
        message: 'occurrence_seq must be an integer between 1 and 10',
      });
    }

    let disambiguation: DstDisambiguationMode = 'REJECT';
    if (obj.dst_disambiguation !== undefined && obj.dst_disambiguation !== null) {
      const dRaw = typeof obj.dst_disambiguation === 'string' ? obj.dst_disambiguation.trim().toUpperCase() : '';
      if (dRaw !== 'REJECT' && dRaw !== 'EARLIER' && dRaw !== 'LATER') {
        throw new ApiHttpException({
          statusCode: 400,
          errorCode: 'VALIDATION_ERROR',
          message: 'dst_disambiguation must be REJECT, EARLIER, or LATER',
        });
      }
      disambiguation = dRaw as DstDisambiguationMode;
    }

    const holidayMap = new Map<
      string,
      { readonly reason: string; readonly mode: 'SKIP' | 'CREATE_CANCELLED' }
    >();
    if (obj.holidays !== undefined && obj.holidays !== null) {
      if (!Array.isArray(obj.holidays) || obj.holidays.length > 62) {
        throw new ApiHttpException({
          statusCode: 400,
          errorCode: 'VALIDATION_ERROR',
          message: 'holidays must be an array of explicit holiday definitions',
        });
      }
      for (const hRaw of obj.holidays) {
        const hObj = assertPlainObject(hRaw, ['date', 'reason', 'mode']);
        const hDate = validateIsoDate(hObj.date, 'holidays[].date');
        const hReason = typeof hObj.reason === 'string' ? hObj.reason.trim() : '';
        if (hReason.length < 3 || hReason.length > 255) {
          throw new ApiHttpException({
            statusCode: 400,
            errorCode: 'VALIDATION_ERROR',
            message: 'holidays[].reason must be between 3 and 255 characters',
          });
        }
        const hModeRaw =
          hObj.mode === undefined || hObj.mode === null
            ? 'SKIP'
            : typeof hObj.mode === 'string'
              ? hObj.mode.trim().toUpperCase()
              : '';
        if (hModeRaw !== 'SKIP' && hModeRaw !== 'CREATE_CANCELLED') {
          throw new ApiHttpException({
            statusCode: 400,
            errorCode: 'VALIDATION_ERROR',
            message: 'holidays[].mode must be SKIP or CREATE_CANCELLED',
          });
        }
        if (holidayMap.has(hDate)) {
          throw new ApiHttpException({
            statusCode: 400,
            errorCode: 'VALIDATION_ERROR',
            message: `Duplicate holiday date '${hDate}' in holidays[]`,
          });
        }
        holidayMap.set(hDate, {
          reason: hReason,
          mode: hModeRaw as 'SKIP' | 'CREATE_CANCELLED',
        });
      }
    }

    const now = this.clock.now();
    const requestId = req.requestId ?? resolveRequestId(req.headers['x-request-id']);

    const idemOutcome = await executeIdempotentOperation<GenerateRecurringLessonsResponseDto>(
      this.databaseService,
      {
        centerId: principal.centerId,
        actorStaffId: principal.staffId,
        operationType: 'GENERATE_RECURRING_GROUP_LESSONS',
        idempotencyKey,
        requestPayload: {
          group_id: groupId,
          start_date: startDate,
          end_date: endDate,
          occurrence_seq: occurrenceSeq,
          dst_disambiguation: disambiguation,
          holidays: [...holidayMap.entries()].map(([date, info]) => ({
            date,
            reason: info.reason,
            mode: info.mode,
          })),
        },
        handler: async (tx) => {
          const group = await this.academicAccess.assertGroupAccess(tx, principal, groupId, {
            lockGroup: true,
          });
          if (group.status !== 'ACTIVE') {
            throw new ApiHttpException({
              statusCode: 422,
              errorCode: 'VALIDATION_ERROR',
              message: 'Cannot generate lessons for an ARCHIVED course group',
            });
          }

          await this.academicAccess.verifyActiveTeacherInCenter(
            tx,
            principal.centerId,
            group.primary_teacher_id,
            'primary_teacher_id',
            true,
          );

          const scheduleDaySet = new Set<ScheduleDayCode>(
            group.schedule_days_json as readonly ScheduleDayCode[],
          );
          const effectiveTz = validateIanaTimezone(
            group.timezone || this.config.centerTimezone,
            'timezone',
          );

          const createdLessons: LessonOccurrenceResponseDto[] = [];
          const skippedHolidays: SkippedHolidayRecordDto[] = [];

          for (const dateStr of allDates) {
            const weekday = getIsoDateWeekday(dateStr);
            if (!scheduleDaySet.has(weekday)) {
              continue;
            }

            const startsAtUtc = resolveWallTimeToUtcInstant({
              lessonDate: dateStr,
              localTime: group.starts_time,
              timeZone: effectiveTz,
              disambiguation,
            });
            const endsAtUtc = new Date(startsAtUtc.getTime() + group.duration_minutes * 60_000);

            const holidayInfo = holidayMap.get(dateStr);
            if (holidayInfo) {
              if (holidayInfo.mode === 'SKIP') {
                skippedHolidays.push(
                  Object.freeze({
                    lesson_date: dateStr,
                    reason: holidayInfo.reason,
                    source: 'EXPLICIT_HOLIDAY_INPUT',
                    mode: 'SKIP',
                    cancelled_lesson_id: null,
                  }),
                );
                continue;
              }

              // mode === 'CREATE_CANCELLED': insert a CANCELLED_BY_CENTER occurrence with explicit holiday reason/source
              const cancelledLessonId = crypto.randomUUID();
              const cancelIns = await tx.query<{
                id: string;
                group_id: string;
                lesson_date: unknown;
                occurrence_seq: number;
                starts_at_utc: Date;
                ends_at_utc: Date;
                status: LessonStatus;
                rescheduled_from_lesson_id: string | null;
                primary_teacher_snapshot_id: string;
                pay_recipient_teacher_id: string;
                cancellation_reason: string | null;
                cancellation_source: CancellationSource | null;
                version: number;
              }>(
                `INSERT INTO "lesson_occurrences" (
                   "id", "center_id", "group_id", "lesson_date", "occurrence_seq",
                   "starts_at_utc", "ends_at_utc", "status",
                   "primary_teacher_snapshot_id", "pay_recipient_teacher_id",
                   "cancellation_reason", "cancellation_source",
                   "version", "created_at", "updated_at"
                 ) VALUES (
                   $1::uuid, $2::uuid, $3::uuid, $4::date, $5::smallint,
                   $6::timestamptz, $7::timestamptz, 'CANCELLED_BY_CENTER',
                   $8::uuid, $8::uuid,
                   $9, 'HOLIDAY_CALENDAR_INPUT',
                   1, $10::timestamptz, $10::timestamptz
                 )
                 RETURNING "id"::text AS id,
                           "group_id"::text AS group_id,
                           "lesson_date",
                           "occurrence_seq",
                           "starts_at_utc",
                           "ends_at_utc",
                           "status"::text AS status,
                           "rescheduled_from_lesson_id"::text AS rescheduled_from_lesson_id,
                           "primary_teacher_snapshot_id"::text AS primary_teacher_snapshot_id,
                           "pay_recipient_teacher_id"::text AS pay_recipient_teacher_id,
                           "cancellation_reason",
                           "cancellation_source"::text AS cancellation_source,
                           "version"`,
                [
                  cancelledLessonId,
                  principal.centerId,
                  groupId,
                  dateStr,
                  occurrenceSeq,
                  startsAtUtc.toISOString(),
                  endsAtUtc.toISOString(),
                  group.primary_teacher_id,
                  holidayInfo.reason,
                  now.toISOString(),
                ],
              );

              createdLessons.push(mapLessonRowToDto(cancelIns.rows[0]));
              skippedHolidays.push(
                Object.freeze({
                  lesson_date: dateStr,
                  reason: holidayInfo.reason,
                  source: 'EXPLICIT_HOLIDAY_INPUT',
                  mode: 'CREATE_CANCELLED',
                  cancelled_lesson_id: cancelledLessonId,
                }),
              );
              continue;
            }

            await this.assertNoTeacherOrGroupTimeConflict(tx, {
              centerId: principal.centerId,
              groupId,
              teacherId: group.primary_teacher_id,
              startsAtUtcIso: startsAtUtc.toISOString(),
              endsAtUtcIso: endsAtUtc.toISOString(),
            });

            const lessonId = crypto.randomUUID();
            const ins = await tx.query<{
              id: string;
              group_id: string;
              lesson_date: unknown;
              occurrence_seq: number;
              starts_at_utc: Date;
              ends_at_utc: Date;
              status: LessonStatus;
              rescheduled_from_lesson_id: string | null;
              primary_teacher_snapshot_id: string;
              pay_recipient_teacher_id: string;
              cancellation_reason: string | null;
              cancellation_source: CancellationSource | null;
              version: number;
            }>(
              `INSERT INTO "lesson_occurrences" (
                 "id", "center_id", "group_id", "lesson_date", "occurrence_seq",
                 "starts_at_utc", "ends_at_utc", "status",
                 "primary_teacher_snapshot_id", "pay_recipient_teacher_id",
                 "version", "created_at", "updated_at"
               ) VALUES (
                 $1::uuid, $2::uuid, $3::uuid, $4::date, $5::smallint,
                 $6::timestamptz, $7::timestamptz, 'SCHEDULED',
                 $8::uuid, $8::uuid,
                 1, $9::timestamptz, $9::timestamptz
               )
               RETURNING "id"::text AS id,
                         "group_id"::text AS group_id,
                         "lesson_date",
                         "occurrence_seq",
                         "starts_at_utc",
                         "ends_at_utc",
                         "status"::text AS status,
                         "rescheduled_from_lesson_id"::text AS rescheduled_from_lesson_id,
                         "primary_teacher_snapshot_id"::text AS primary_teacher_snapshot_id,
                         "pay_recipient_teacher_id"::text AS pay_recipient_teacher_id,
                         "cancellation_reason",
                         "cancellation_source"::text AS cancellation_source,
                         "version"`,
              [
                lessonId,
                principal.centerId,
                groupId,
                dateStr,
                occurrenceSeq,
                startsAtUtc.toISOString(),
                endsAtUtc.toISOString(),
                group.primary_teacher_id,
                now.toISOString(),
              ],
            );

            createdLessons.push(mapLessonRowToDto(ins.rows[0]));
          }

          await tx.query(
            `INSERT INTO "audit_logs" (
               "id", "center_id", "actor_type", "actor_id", "actor_role",
               "action", "entity_type", "entity_id", "severity",
               "after_redacted_json", "request_id", "created_at"
             ) VALUES (
               $1::uuid, $2::uuid, 'STAFF', $3::uuid, $4,
               'GROUP_RECURRING_LESSONS_GENERATED', 'CourseGroup', $5::uuid, 'INFO',
               $6::jsonb, $7, $8::timestamptz
             )`,
            [
              crypto.randomUUID(),
              principal.centerId,
              principal.staffId,
              principal.role,
              groupId,
              JSON.stringify({
                group_id: groupId,
                start_date: startDate,
                end_date: endDate,
                timezone: effectiveTz,
                created_count: createdLessons.length,
                skipped_holidays: skippedHolidays,
              }),
              requestId,
              now.toISOString(),
            ],
          );

          return {
            statusCode: 201,
            body: Object.freeze({
              group_id: groupId,
              start_date: startDate,
              end_date: endDate,
              timezone: effectiveTz,
              created_lessons: Object.freeze(createdLessons),
              skipped_holidays: Object.freeze(skippedHolidays),
            }),
          };
        },
      },
    );

    return idemOutcome.body;
  }

  public async cancelLessonOccurrence(
    req: RequestWithCorrelationId,
    principal: AuthenticatedStaffPrincipal,
    rawLessonId: string,
    rawBody: unknown,
  ): Promise<LessonOccurrenceResponseDto> {
    const idempotencyKey = requireIdempotencyKeyHeader(req);
    const lessonId = assertValidUuid(rawLessonId, 'lesson_id');
    const obj = assertPlainObject(rawBody, [
      'reason',
      'cancellation_source',
      'expected_version',
      'apply_unconfirmed_package_credit_or_extension',
    ]);

    if (
      parseOptionalStrictBoolean(
        obj.apply_unconfirmed_package_credit_or_extension,
        'apply_unconfirmed_package_credit_or_extension',
        false,
      )
    ) {
      throw new ApiHttpException({
        statusCode: 403,
        errorCode: 'POLICY_DECISION_NOT_CONFIRMED',
        message:
          'Automatic 12-lesson package credit or extension formula on cancelled lessons is gated by unconfirmed policy decision D21 (Stage 08)',
      });
    }

    const reason = typeof obj.reason === 'string' ? obj.reason.trim() : '';
    if (reason.length < 3 || reason.length > 255) {
      throw new ApiHttpException({
        statusCode: 400,
        errorCode: 'VALIDATION_ERROR',
        message: 'reason must be between 3 and 255 characters',
      });
    }

    const sourceRaw =
      obj.cancellation_source === undefined || obj.cancellation_source === null
        ? 'ADMIN_MANUAL'
        : typeof obj.cancellation_source === 'string'
          ? obj.cancellation_source.trim().toUpperCase()
          : '';
    if (!ALLOWED_CANCELLATION_SOURCES.has(sourceRaw as CancellationSource)) {
      throw new ApiHttpException({
        statusCode: 400,
        errorCode: 'VALIDATION_ERROR',
        message:
          'cancellation_source must be ADMIN_MANUAL, PUBLIC_HOLIDAY, WEATHER_EMERGENCY, or HOLIDAY_CALENDAR_INPUT',
      });
    }
    const cancellationSource = sourceRaw as CancellationSource;
    const expectedVersion = resolveExpectedVersion(req, obj.expected_version);
    const now = this.clock.now();
    const requestId = req.requestId ?? resolveRequestId(req.headers['x-request-id']);

    const idemOutcome = await executeIdempotentOperation<LessonOccurrenceResponseDto>(
      this.databaseService,
      {
        centerId: principal.centerId,
        actorStaffId: principal.staffId,
        operationType: 'CANCEL_LESSON_OCCURRENCE',
        idempotencyKey,
        requestPayload: {
          lesson_id: lessonId,
          reason,
          cancellation_source: cancellationSource,
          expected_version: expectedVersion,
        },
        handler: async (tx) => {
          const lessonCtx = await this.academicAccess.assertLessonAccess(tx, principal, lessonId, {
            lockLesson: true,
          });

          if (lessonCtx.status === 'COMPLETED') {
            throw new ApiHttpException({
              statusCode: 403,
              errorCode: 'POLICY_DECISION_NOT_CONFIRMED',
              message: 'Completed lessons cannot be cancelled retroactively',
            });
          }
          if (lessonCtx.status !== 'SCHEDULED') {
            throw new ApiHttpException({
              statusCode: 422,
              errorCode: 'VALIDATION_ERROR',
              message: `Lesson is already in ${lessonCtx.status} status and cannot be cancelled`,
            });
          }

          const updated = await executeOptimisticUpdate<{
            id: string;
            group_id: string;
            lesson_date: unknown;
            occurrence_seq: number;
            starts_at_utc: Date;
            ends_at_utc: Date;
            status: LessonStatus;
            rescheduled_from_lesson_id: string | null;
            primary_teacher_snapshot_id: string;
            pay_recipient_teacher_id: string;
            cancellation_reason: string | null;
            cancellation_source: CancellationSource | null;
            version: number;
          }>(tx, {
            tableName: 'lesson_occurrences',
            entityName: 'LessonOccurrence',
            id: lessonId,
            centerId: principal.centerId,
            expectedVersion,
            setClauseSql: `"status" = 'CANCELLED_BY_CENTER', "cancellation_reason" = $4, "cancellation_source" = $5`,
            additionalValues: [reason, cancellationSource],
          });

          // Revoke any active substitute assignment on the cancelled lesson
          await tx.query(
            `UPDATE "substitute_assignments"
                SET "status" = 'REVOKED',
                    "revoked_at" = $3::timestamptz,
                    "revoke_reason" = 'LESSON_CANCELLED',
                    "version" = "version" + 1,
                    "updated_at" = $3::timestamptz
              WHERE "center_id" = $1::uuid
                AND "lesson_id" = $2::uuid
                AND "status" = 'ACTIVE'`,
            [principal.centerId, lessonId, now.toISOString()],
          );

          await tx.query(
            `INSERT INTO "audit_logs" (
               "id", "center_id", "actor_type", "actor_id", "actor_role",
               "action", "entity_type", "entity_id", "severity",
               "before_redacted_json", "after_redacted_json", "request_id", "created_at"
             ) VALUES (
               $1::uuid, $2::uuid, 'STAFF', $3::uuid, $4,
               'LESSON_OCCURRENCE_CANCELLED', 'LessonOccurrence', $5::uuid, 'WARN',
               $6::jsonb, $7::jsonb, $8, $9::timestamptz
             )`,
            [
              crypto.randomUUID(),
              principal.centerId,
              principal.staffId,
              principal.role,
              lessonId,
              JSON.stringify({
                status: lessonCtx.status,
                version: lessonCtx.version,
              }),
              JSON.stringify({
                status: 'CANCELLED_BY_CENTER',
                cancellation_reason: reason,
                cancellation_source: cancellationSource,
                eligible_for_teacher_ping: false,
                eligible_for_trial_conversion: false,
                eligible_for_package_consumption: false,
                version: Number(updated.version),
              }),
              requestId,
              now.toISOString(),
            ],
          );

          return {
            statusCode: 200,
            body: mapLessonRowToDto(updated),
          };
        },
      },
    );

    return idemOutcome.body;
  }

  public async listGroupLessons(
    principal: AuthenticatedStaffPrincipal,
    rawGroupId: string,
    query: {
      status?: string;
      from_date?: string;
      to_date?: string;
      cursor?: string;
      limit?: string;
    } = {},
  ): Promise<LessonOccurrenceListResponseDto> {
    const groupCtx = await this.academicAccess.assertGroupAccess(
      this.databaseService,
      principal,
      rawGroupId,
      { requireTodayForSubstitute: false },
    );

    let limit = 50;
    if (query.limit !== undefined && query.limit !== '') {
      limit = Number(query.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
        throw new ApiHttpException({
          statusCode: 400,
          errorCode: 'VALIDATION_ERROR',
          message: 'limit must be an integer between 1 and 200',
        });
      }
    }

    let cursorUuid: string | null = null;
    if (query.cursor !== undefined && query.cursor !== '') {
      cursorUuid = assertValidUuid(query.cursor, 'cursor');
    }

    let statusFilter: LessonStatus | null = null;
    if (query.status !== undefined && query.status !== '') {
      const sUpper = query.status.trim().toUpperCase();
      if (
        sUpper !== 'SCHEDULED' &&
        sUpper !== 'COMPLETED' &&
        sUpper !== 'CANCELLED_BY_CENTER' &&
        sUpper !== 'RESCHEDULED'
      ) {
        throw new ApiHttpException({
          statusCode: 400,
          errorCode: 'VALIDATION_ERROR',
          message: 'status filter must be SCHEDULED, COMPLETED, CANCELLED_BY_CENTER, or RESCHEDULED',
        });
      }
      statusFilter = sUpper as LessonStatus;
    }

    const fromDate =
      query.from_date !== undefined && query.from_date !== ''
        ? validateIsoDate(query.from_date, 'from_date')
        : null;
    const toDate =
      query.to_date !== undefined && query.to_date !== ''
        ? validateIsoDate(query.to_date, 'to_date')
        : null;

    // 07.03 Single-Lesson Substitute Boundary:
    // If the caller is a SUBSTITUTE_TEACHER (not the group's primary_teacher_id),
    // restrict the returned lessons strictly to `groupCtx.active_substitute_lesson_ids`!
    const restrictToSubLessons = groupCtx.access_mode === 'SUBSTITUTE_TEACHER';
    const allowedSubLessonIds = groupCtx.active_substitute_lesson_ids;

    const res = await this.databaseService.query<{
      id: string;
      group_id: string;
      lesson_date: unknown;
      occurrence_seq: number;
      starts_at_utc: Date;
      ends_at_utc: Date;
      status: LessonStatus;
      rescheduled_from_lesson_id: string | null;
      primary_teacher_snapshot_id: string;
      pay_recipient_teacher_id: string;
      cancellation_reason: string | null;
      cancellation_source: CancellationSource | null;
      version: number;
    }>(
      `SELECT "id"::text AS id,
              "group_id"::text AS group_id,
              "lesson_date",
              "occurrence_seq",
              "starts_at_utc",
              "ends_at_utc",
              "status"::text AS status,
              "rescheduled_from_lesson_id"::text AS rescheduled_from_lesson_id,
              "primary_teacher_snapshot_id"::text AS primary_teacher_snapshot_id,
              "pay_recipient_teacher_id"::text AS pay_recipient_teacher_id,
              "cancellation_reason",
              "cancellation_source"::text AS cancellation_source,
              "version"
         FROM "lesson_occurrences"
        WHERE "center_id" = $1::uuid
          AND "group_id" = $2::uuid
          AND ($3::text IS NULL OR "status" = $3::text)
          AND ($4::date IS NULL OR "lesson_date" >= $4::date)
          AND ($5::date IS NULL OR "lesson_date" <= $5::date)
          AND ($6::uuid IS NULL OR "id" > $6::uuid)
          AND ($7::boolean = FALSE OR "id" = ANY($8::uuid[]))
        ORDER BY "lesson_date" ASC, "occurrence_seq" ASC, "id" ASC
        LIMIT $9::int`,
      [
        principal.centerId,
        groupCtx.id,
        statusFilter,
        fromDate,
        toDate,
        cursorUuid,
        restrictToSubLessons,
        allowedSubLessonIds,
        limit + 1,
      ],
    );

    const hasMore = res.rows.length > limit;
    const slice = hasMore ? res.rows.slice(0, limit) : res.rows;
    const nextCursor = hasMore ? slice[slice.length - 1]?.id ?? null : null;

    return Object.freeze({
      items: Object.freeze(slice.map(mapLessonRowToDto)),
      next_cursor: nextCursor,
    });
  }
}
