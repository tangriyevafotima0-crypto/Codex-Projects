import { Inject, Injectable } from '@nestjs/common';
import type { BillingMode, CollectionTiming, DueDateRule } from '@eduerp/contracts';
import { ApiHttpException } from '../auth/auth.errors';
import { ClockService } from '../auth/clock.service';
import { AuthenticatedStaffPrincipal } from '../auth/permissions.guard';
import { formatCenterLocalDate } from '../auth/staff.service';
import { assertValidUuid } from '../auth/validation';
import { ApiEnvConfig } from '../config/env';
import { API_CONFIG_TOKEN } from '../config/tokens';
import { DatabaseService } from '../database/database.service';
import { TransactionContext } from '../database/transaction';
import { LessonStatus } from './academic-validation';

export type QueryExecutor = Pick<DatabaseService, 'query'> | Pick<TransactionContext, 'query'>;

export interface AuthorizedGroupContext {
  readonly id: string;
  readonly course_id: string;
  readonly name: string;
  readonly primary_teacher_id: string;
  readonly billing_mode: BillingMode;
  readonly due_date_rule: DueDateRule;
  readonly fixed_due_day: number | null;
  readonly collection_timing: CollectionTiming;
  readonly current_fee_uzs: string;
  readonly lessons_per_cycle: number;
  readonly schedule_days_json: readonly string[];
  readonly starts_time: string;
  readonly duration_minutes: number;
  readonly timezone: string;
  readonly status: 'ACTIVE' | 'ARCHIVED';
  readonly version: number;
  readonly access_mode: 'ADMIN_OR_DIRECTOR' | 'PRIMARY_TEACHER' | 'SUBSTITUTE_TEACHER';
  readonly active_substitute_lesson_ids: readonly string[];
}

export interface AuthorizedLessonContext {
  readonly lesson_id: string;
  readonly group_id: string;
  readonly group_name: string;
  readonly group_primary_teacher_id: string;
  readonly group_timezone: string;
  readonly group_status: 'ACTIVE' | 'ARCHIVED';
  readonly lesson_date: string;
  readonly occurrence_seq: number;
  readonly starts_at_utc: Date;
  readonly ends_at_utc: Date;
  readonly status: LessonStatus;
  readonly rescheduled_from_lesson_id: string | null;
  readonly primary_teacher_snapshot_id: string;
  readonly pay_recipient_teacher_id: string;
  readonly version: number;
  readonly access_mode: 'ADMIN_OR_DIRECTOR' | 'PRIMARY_TEACHER' | 'SUBSTITUTE_TEACHER';
  readonly active_substitute_assignment_id: string | null;
}

function formatPgDateString(val: unknown): string {
  if (val instanceof Date) {
    return val.toISOString().slice(0, 10);
  }
  return String(val).slice(0, 10);
}

@Injectable()
export class AcademicAccessService {
  constructor(
    @Inject(API_CONFIG_TOKEN) private readonly config: ApiEnvConfig,
    @Inject(ClockService) private readonly clock: ClockService,
  ) {}

  public async verifyActiveTeacherInCenter(
    executor: QueryExecutor,
    centerId: string,
    teacherId: string,
    fieldName = 'primary_teacher_id',
    lockForUpdate = false,
  ): Promise<{ readonly id: string; readonly full_name: string; readonly version: number }> {
    const validId = assertValidUuid(teacherId, fieldName);
    const lockSql = lockForUpdate ? 'FOR UPDATE' : '';
    const res = await executor.query<{
      id: string;
      role: string;
      status: string;
      full_name: string;
      version: number;
    }>(
      `SELECT "id"::text AS id,
              "role"::text AS role,
              "status"::text AS status,
              "full_name",
              "version"
         FROM "staff_users"
        WHERE "id" = $1::uuid
          AND "center_id" = $2::uuid
        ${lockSql}`,
      [validId, centerId],
    );
    const staff = res.rows[0];
    if (!staff) {
      throw new ApiHttpException({
        statusCode: 404,
        errorCode: 'NOT_FOUND',
        message: `${fieldName} staff user not found in this center`,
      });
    }
    if (staff.role !== 'TEACHER') {
      throw new ApiHttpException({
        statusCode: 422,
        errorCode: 'VALIDATION_ERROR',
        message: `${fieldName} must reference a staff user with role TEACHER (got ${staff.role})`,
      });
    }
    if (staff.status !== 'ACTIVE') {
      throw new ApiHttpException({
        statusCode: 422,
        errorCode: 'VALIDATION_ERROR',
        message: `${fieldName} must reference an ACTIVE teacher account`,
      });
    }
    return {
      id: staff.id,
      full_name: staff.full_name,
      version: Number(staff.version),
    };
  }

  /**
   * Shared group-level authorization resolver (07.01, 07.02, 07.03):
   * - For DIRECTOR/ADMIN: verifies group belongs to principal.centerId.
   * - For TEACHER:
   *   - Re-verifies live ACTIVE TEACHER status in staff_users.
   *   - Allows if `group.primary_teacher_id == principal.staffId`.
   *   - Otherwise allows ONLY if the teacher has an ACTIVE `substitute_assignments` row in this group
   *     (for `requireTodayForSubstitute === true`, strictly restricted to `lesson_date == today_in_center_timezone`),
   *     and returns the exact `active_substitute_lesson_ids` so callers never expose other lessons of the group!
   */
  public async assertGroupAccess(
    executor: QueryExecutor,
    principal: AuthenticatedStaffPrincipal,
    rawGroupId: string,
    options: {
      readonly requireTodayForSubstitute?: boolean;
      readonly lockGroup?: boolean;
    } = {},
  ): Promise<AuthorizedGroupContext> {
    const groupId = assertValidUuid(rawGroupId, 'group_id');
    const lockSql = options.lockGroup ? 'FOR UPDATE' : '';

    const groupRes = await executor.query<{
      id: string;
      course_id: string;
      name: string;
      primary_teacher_id: string;
      billing_mode: BillingMode;
      due_date_rule: DueDateRule;
      fixed_due_day: number | null;
      collection_timing: CollectionTiming;
      current_fee_uzs: string;
      lessons_per_cycle: number;
      schedule_days_json: string[];
      starts_time: string;
      duration_minutes: number;
      timezone: string;
      status: 'ACTIVE' | 'ARCHIVED';
      version: number;
    }>(
      `SELECT "id"::text AS id,
              "course_id"::text AS course_id,
              "name",
              "primary_teacher_id"::text AS primary_teacher_id,
              "billing_mode"::text AS billing_mode,
              "due_date_rule"::text AS due_date_rule,
              "fixed_due_day",
              "collection_timing"::text AS collection_timing,
              "current_fee_uzs"::text AS current_fee_uzs,
              "lessons_per_cycle",
              "schedule_days_json",
              "starts_time",
              "duration_minutes",
              "timezone",
              "status"::text AS status,
              "version"
         FROM "course_groups"
        WHERE "id" = $1::uuid
          AND "center_id" = $2::uuid
        ${lockSql}`,
      [groupId, principal.centerId],
    );

    const group = groupRes.rows[0];
    if (!group) {
      throw new ApiHttpException({
        statusCode: 404,
        errorCode: 'NOT_FOUND',
        message: 'Course group not found in this center',
      });
    }

    if (principal.role === 'DIRECTOR' || principal.role === 'ADMIN') {
      return Object.freeze({
        ...group,
        fixed_due_day: group.fixed_due_day !== null ? Number(group.fixed_due_day) : null,
        lessons_per_cycle: Number(group.lessons_per_cycle),
        duration_minutes: Number(group.duration_minutes),
        schedule_days_json: Array.isArray(group.schedule_days_json) ? group.schedule_days_json : [],
        version: Number(group.version),
        access_mode: 'ADMIN_OR_DIRECTOR',
        active_substitute_lesson_ids: [],
      });
    }

    // Re-verify live teacher status in DB (S05 / 07.03)
    await this.verifyActiveTeacherInCenter(executor, principal.centerId, principal.staffId, 'staff_id');

    if (group.primary_teacher_id === principal.staffId) {
      return Object.freeze({
        ...group,
        fixed_due_day: group.fixed_due_day !== null ? Number(group.fixed_due_day) : null,
        lessons_per_cycle: Number(group.lessons_per_cycle),
        duration_minutes: Number(group.duration_minutes),
        schedule_days_json: Array.isArray(group.schedule_days_json) ? group.schedule_days_json : [],
        version: Number(group.version),
        access_mode: 'PRIMARY_TEACHER',
        active_substitute_lesson_ids: [],
      });
    }

    const effectiveTimezone = group.timezone || this.config.centerTimezone;
    const todayCenterDate = formatCenterLocalDate(this.clock.now(), effectiveTimezone);
    const filterByToday = options.requireTodayForSubstitute !== false;

    const subRes = await executor.query<{ lesson_id: string }>(
      `SELECT lo."id"::text AS lesson_id
         FROM "substitute_assignments" sa
         JOIN "lesson_occurrences" lo
           ON lo."id" = sa."lesson_id"
          AND lo."center_id" = sa."center_id"
        WHERE sa."center_id" = $1::uuid
          AND lo."group_id" = $2::uuid
          AND sa."substitute_teacher_id" = $3::uuid
          AND sa."status" = 'ACTIVE'
          AND lo."status" IN ('SCHEDULED', 'COMPLETED')
          AND ($4::boolean = FALSE OR lo."lesson_date" = $5::date)
        ORDER BY lo."starts_at_utc" ASC, lo."id" ASC`,
      [principal.centerId, groupId, principal.staffId, filterByToday, todayCenterDate],
    );

    if (subRes.rows.length === 0) {
      throw new ApiHttpException({
        statusCode: 403,
        errorCode: 'FORBIDDEN_OBJECT_SCOPE',
        message:
          'Teacher is not assigned as primary teacher or active substitute teacher for this course group',
      });
    }

    return Object.freeze({
      ...group,
      fixed_due_day: group.fixed_due_day !== null ? Number(group.fixed_due_day) : null,
      lessons_per_cycle: Number(group.lessons_per_cycle),
      duration_minutes: Number(group.duration_minutes),
      schedule_days_json: Array.isArray(group.schedule_days_json) ? group.schedule_days_json : [],
      version: Number(group.version),
      access_mode: 'SUBSTITUTE_TEACHER',
      active_substitute_lesson_ids: Object.freeze(subRes.rows.map((r) => r.lesson_id)),
    });
  }

  /**
   * Shared single-lesson authorization resolver (07.03, 07.04):
   * Enforces the strict single-lesson boundary:
   * - If a substitute teacher is assigned ONLY to Lesson A on a given day, calling `assertLessonAccess`
   *   on Lesson B of the same group on the same day fails closed with `403 FORBIDDEN_OBJECT_SCOPE`.
   * - If a substitute assignment was REVOKED (even while the teacher's JWT is still unexpired or queued offline),
   *   live DB inspection sees `sa.status = 'REVOKED'` and denies access with `403 FORBIDDEN_OBJECT_SCOPE`.
   * - If an ACTIVE substitute assignment exists for another teacher on `lessonId` and `forExclusiveTeacherWrite`
   *   is true, the replaced original teacher cannot overwrite the active substitute's lesson grades/attendance.
   */
  public async assertLessonAccess(
    executor: QueryExecutor,
    principal: AuthenticatedStaffPrincipal,
    rawLessonId: string,
    options: {
      readonly lockLesson?: boolean;
      readonly forExclusiveTeacherWrite?: boolean;
    } = {},
  ): Promise<AuthorizedLessonContext> {
    const lessonId = assertValidUuid(rawLessonId, 'lesson_id');
    const lockSql = options.lockLesson ? 'FOR UPDATE OF lo' : '';

    const res = await executor.query<{
      lesson_id: string;
      group_id: string;
      group_name: string;
      group_primary_teacher_id: string;
      group_timezone: string;
      group_status: 'ACTIVE' | 'ARCHIVED';
      lesson_date: unknown;
      occurrence_seq: number;
      starts_at_utc: Date;
      ends_at_utc: Date;
      status: LessonStatus;
      rescheduled_from_lesson_id: string | null;
      primary_teacher_snapshot_id: string;
      pay_recipient_teacher_id: string;
      version: number;
      active_sub_id: string | null;
      active_sub_teacher_id: string | null;
    }>(
      `SELECT lo."id"::text AS lesson_id,
              lo."group_id"::text AS group_id,
              cg."name" AS group_name,
              cg."primary_teacher_id"::text AS group_primary_teacher_id,
              cg."timezone" AS group_timezone,
              cg."status"::text AS group_status,
              lo."lesson_date",
              lo."occurrence_seq",
              lo."starts_at_utc",
              lo."ends_at_utc",
              lo."status"::text AS status,
              lo."rescheduled_from_lesson_id"::text AS rescheduled_from_lesson_id,
              lo."primary_teacher_snapshot_id"::text AS primary_teacher_snapshot_id,
              lo."pay_recipient_teacher_id"::text AS pay_recipient_teacher_id,
              lo."version",
              sa."id"::text AS active_sub_id,
              sa."substitute_teacher_id"::text AS active_sub_teacher_id
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
        ${lockSql}`,
      [lessonId, principal.centerId],
    );

    const row = res.rows[0];
    if (!row) {
      throw new ApiHttpException({
        statusCode: 404,
        errorCode: 'NOT_FOUND',
        message: 'Lesson occurrence not found in this center',
      });
    }

    if (principal.role === 'DIRECTOR' || principal.role === 'ADMIN') {
      return Object.freeze({
        lesson_id: row.lesson_id,
        group_id: row.group_id,
        group_name: row.group_name,
        group_primary_teacher_id: row.group_primary_teacher_id,
        group_timezone: row.group_timezone || this.config.centerTimezone,
        group_status: row.group_status,
        lesson_date: formatPgDateString(row.lesson_date),
        occurrence_seq: Number(row.occurrence_seq),
        starts_at_utc: new Date(row.starts_at_utc),
        ends_at_utc: new Date(row.ends_at_utc),
        status: row.status,
        rescheduled_from_lesson_id: row.rescheduled_from_lesson_id,
        primary_teacher_snapshot_id: row.primary_teacher_snapshot_id,
        pay_recipient_teacher_id: row.pay_recipient_teacher_id,
        version: Number(row.version),
        access_mode: 'ADMIN_OR_DIRECTOR',
        active_substitute_assignment_id: row.active_sub_id,
      });
    }

    // Re-verify live teacher status in DB
    await this.verifyActiveTeacherInCenter(executor, principal.centerId, principal.staffId, 'staff_id');

    const isActiveSubForThisLesson =
      row.active_sub_id !== null && row.active_sub_teacher_id === principal.staffId;
    const isPrimaryForThisLesson =
      row.group_primary_teacher_id === principal.staffId ||
      row.primary_teacher_snapshot_id === principal.staffId;

    if (isActiveSubForThisLesson) {
      return Object.freeze({
        lesson_id: row.lesson_id,
        group_id: row.group_id,
        group_name: row.group_name,
        group_primary_teacher_id: row.group_primary_teacher_id,
        group_timezone: row.group_timezone || this.config.centerTimezone,
        group_status: row.group_status,
        lesson_date: formatPgDateString(row.lesson_date),
        occurrence_seq: Number(row.occurrence_seq),
        starts_at_utc: new Date(row.starts_at_utc),
        ends_at_utc: new Date(row.ends_at_utc),
        status: row.status,
        rescheduled_from_lesson_id: row.rescheduled_from_lesson_id,
        primary_teacher_snapshot_id: row.primary_teacher_snapshot_id,
        pay_recipient_teacher_id: row.pay_recipient_teacher_id,
        version: Number(row.version),
        access_mode: 'SUBSTITUTE_TEACHER',
        active_substitute_assignment_id: row.active_sub_id,
      });
    }

    if (isPrimaryForThisLesson) {
      if (options.forExclusiveTeacherWrite && row.active_sub_id !== null && row.active_sub_teacher_id !== principal.staffId) {
        throw new ApiHttpException({
          statusCode: 403,
          errorCode: 'FORBIDDEN_OBJECT_SCOPE',
          message:
            'An active substitute teacher is currently assigned as pay and execution recipient for this lesson occurrence',
        });
      }
      return Object.freeze({
        lesson_id: row.lesson_id,
        group_id: row.group_id,
        group_name: row.group_name,
        group_primary_teacher_id: row.group_primary_teacher_id,
        group_timezone: row.group_timezone || this.config.centerTimezone,
        group_status: row.group_status,
        lesson_date: formatPgDateString(row.lesson_date),
        occurrence_seq: Number(row.occurrence_seq),
        starts_at_utc: new Date(row.starts_at_utc),
        ends_at_utc: new Date(row.ends_at_utc),
        status: row.status,
        rescheduled_from_lesson_id: row.rescheduled_from_lesson_id,
        primary_teacher_snapshot_id: row.primary_teacher_snapshot_id,
        pay_recipient_teacher_id: row.pay_recipient_teacher_id,
        version: Number(row.version),
        access_mode: 'PRIMARY_TEACHER',
        active_substitute_assignment_id: row.active_sub_id,
      });
    }

    throw new ApiHttpException({
      statusCode: 403,
      errorCode: 'FORBIDDEN_OBJECT_SCOPE',
      message:
        'Teacher is not authorized for this specific lesson occurrence (single-lesson entitlement boundary)',
    });
  }
}
