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
import { resolveGroupTariffState } from './price-resolver';

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
  readonly attendance_version: number;
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

  public async assertGroupAccess(
    executor: QueryExecutor,
    principal: AuthenticatedStaffPrincipal,
    rawGroupId: string,
    options: {
      readonly requireTodayForSubstitute?: boolean;
      readonly lockGroup?: boolean;
      readonly asOfDate?: string;
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

    const effectiveTimezone = group.timezone || this.config.centerTimezone;
    const todayCenterDate = formatCenterLocalDate(this.clock.now(), effectiveTimezone);
    const resolvedAsOfDate = options.asOfDate ?? todayCenterDate;

    const resolvedTariff = await resolveGroupTariffState(executor, {
      centerId: principal.centerId,
      courseId: group.course_id,
      groupId: group.id,
      storedCurrentFeeUzs: group.current_fee_uzs,
      asOfDate: resolvedAsOfDate,
    });

    if (principal.role === 'DIRECTOR' || principal.role === 'ADMIN') {
      return Object.freeze({
        ...group,
        current_fee_uzs: resolvedTariff.effective_fee_as_of_uzs,
        fixed_due_day: group.fixed_due_day !== null ? Number(group.fixed_due_day) : null,
        lessons_per_cycle: Number(group.lessons_per_cycle),
        duration_minutes: Number(group.duration_minutes),
        schedule_days_json: Array.isArray(group.schedule_days_json) ? group.schedule_days_json : [],
        version: Number(group.version),
        access_mode: 'ADMIN_OR_DIRECTOR',
        active_substitute_lesson_ids: [],
      });
    }

    await this.verifyActiveTeacherInCenter(executor, principal.centerId, principal.staffId, 'staff_id');

    if (group.primary_teacher_id === principal.staffId) {
      return Object.freeze({
        ...group,
        current_fee_uzs: resolvedTariff.effective_fee_as_of_uzs,
        fixed_due_day: group.fixed_due_day !== null ? Number(group.fixed_due_day) : null,
        lessons_per_cycle: Number(group.lessons_per_cycle),
        duration_minutes: Number(group.duration_minutes),
        schedule_days_json: Array.isArray(group.schedule_days_json) ? group.schedule_days_json : [],
        version: Number(group.version),
        access_mode: 'PRIMARY_TEACHER',
        active_substitute_lesson_ids: [],
      });
    }

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
      current_fee_uzs: resolvedTariff.effective_fee_as_of_uzs,
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
   * Shared single-lesson authorization resolver (07.03, 07.04, I03):
   * - Step 1: Locks `lesson_occurrences` (`FOR UPDATE` when `lockLesson` is true).
   * - Step 2: Queries `course_groups` and active `substitute_assignments` in a subsequent SQL statement
   *   so that in PostgreSQL `READ COMMITTED`, if Step 1 waited on a concurrent revoke/reassignment/group-update
   *   transaction to commit, Step 2 takes a fresh post-lock statement snapshot and sees the committed revocation!
   * - Enforces that `PRIMARY_TEACHER` entitlement requires `group.primary_teacher_id === principal.staffId`
   *   (and when `forExclusiveTeacherWrite` is true, that no other teacher holds an `ACTIVE` substitute assignment on this lesson).
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
    const lockSql = options.lockLesson ? 'FOR UPDATE' : '';

    // Step 1: Fetch (and lock if requested) lesson_occurrences row first
    const lessonRes = await executor.query<{
      lesson_id: string;
      group_id: string;
      lesson_date: unknown;
      occurrence_seq: number;
      starts_at_utc: Date;
      ends_at_utc: Date;
      status: LessonStatus;
      rescheduled_from_lesson_id: string | null;
      primary_teacher_snapshot_id: string;
      pay_recipient_teacher_id: string;
      attendance_version: number;
      version: number;
    }>(
      `SELECT "id"::text AS lesson_id,
              "group_id"::text AS group_id,
              "lesson_date",
              "occurrence_seq",
              "starts_at_utc",
              "ends_at_utc",
              "status"::text AS status,
              "rescheduled_from_lesson_id"::text AS rescheduled_from_lesson_id,
              "primary_teacher_snapshot_id"::text AS primary_teacher_snapshot_id,
              "pay_recipient_teacher_id"::text AS pay_recipient_teacher_id,
              "attendance_version",
              "version"
         FROM "lesson_occurrences"
        WHERE "id" = $1::uuid
          AND "center_id" = $2::uuid
        ${lockSql}`,
      [lessonId, principal.centerId],
    );

    const lesson = lessonRes.rows[0];
    if (!lesson) {
      throw new ApiHttpException({
        statusCode: 404,
        errorCode: 'NOT_FOUND',
        message: 'Lesson occurrence not found in this center',
      });
    }

    // Step 2: Query group and active substitute assignment in a fresh statement snapshot AFTER lesson lock is held
    const metaRes = await executor.query<{
      group_name: string;
      group_primary_teacher_id: string;
      group_timezone: string;
      group_status: 'ACTIVE' | 'ARCHIVED';
      active_sub_id: string | null;
      active_sub_teacher_id: string | null;
    }>(
      `SELECT cg."name" AS group_name,
              cg."primary_teacher_id"::text AS group_primary_teacher_id,
              cg."timezone" AS group_timezone,
              cg."status"::text AS group_status,
              sa."id"::text AS active_sub_id,
              sa."substitute_teacher_id"::text AS active_sub_teacher_id
         FROM "course_groups" cg
         LEFT JOIN "substitute_assignments" sa
           ON sa."lesson_id" = $3::uuid
          AND sa."center_id" = cg."center_id"
          AND sa."status" = 'ACTIVE'
        WHERE cg."id" = $1::uuid
          AND cg."center_id" = $2::uuid
        LIMIT 1`,
      [lesson.group_id, principal.centerId, lesson.lesson_id],
    );

    const meta = metaRes.rows[0];
    if (!meta) {
      throw new ApiHttpException({
        statusCode: 404,
        errorCode: 'NOT_FOUND',
        message: 'Course group for lesson occurrence not found in this center',
      });
    }

    if (principal.role === 'DIRECTOR' || principal.role === 'ADMIN') {
      return Object.freeze({
        lesson_id: lesson.lesson_id,
        group_id: lesson.group_id,
        group_name: meta.group_name,
        group_primary_teacher_id: meta.group_primary_teacher_id,
        group_timezone: meta.group_timezone || this.config.centerTimezone,
        group_status: meta.group_status,
        lesson_date: formatPgDateString(lesson.lesson_date),
        occurrence_seq: Number(lesson.occurrence_seq),
        starts_at_utc: new Date(lesson.starts_at_utc),
        ends_at_utc: new Date(lesson.ends_at_utc),
        status: lesson.status,
        rescheduled_from_lesson_id: lesson.rescheduled_from_lesson_id,
        primary_teacher_snapshot_id: lesson.primary_teacher_snapshot_id,
        pay_recipient_teacher_id: lesson.pay_recipient_teacher_id,
        attendance_version: Number(lesson.attendance_version ?? 0),
        version: Number(lesson.version),
        access_mode: 'ADMIN_OR_DIRECTOR',
        active_substitute_assignment_id: meta.active_sub_id,
      });
    }

    // Re-verify live teacher status & role in DB inside the current transaction
    await this.verifyActiveTeacherInCenter(executor, principal.centerId, principal.staffId, 'staff_id');

    const isActiveSubForThisLesson =
      meta.active_sub_id !== null && meta.active_sub_teacher_id === principal.staffId;
    const isCurrentPrimaryForGroup = meta.group_primary_teacher_id === principal.staffId;

    if (isActiveSubForThisLesson) {
      return Object.freeze({
        lesson_id: lesson.lesson_id,
        group_id: lesson.group_id,
        group_name: meta.group_name,
        group_primary_teacher_id: meta.group_primary_teacher_id,
        group_timezone: meta.group_timezone || this.config.centerTimezone,
        group_status: meta.group_status,
        lesson_date: formatPgDateString(lesson.lesson_date),
        occurrence_seq: Number(lesson.occurrence_seq),
        starts_at_utc: new Date(lesson.starts_at_utc),
        ends_at_utc: new Date(lesson.ends_at_utc),
        status: lesson.status,
        rescheduled_from_lesson_id: lesson.rescheduled_from_lesson_id,
        primary_teacher_snapshot_id: lesson.primary_teacher_snapshot_id,
        pay_recipient_teacher_id: lesson.pay_recipient_teacher_id,
        attendance_version: Number(lesson.attendance_version ?? 0),
        version: Number(lesson.version),
        access_mode: 'SUBSTITUTE_TEACHER',
        active_substitute_assignment_id: meta.active_sub_id,
      });
    }

    if (isCurrentPrimaryForGroup) {
      if (
        options.forExclusiveTeacherWrite &&
        meta.active_sub_id !== null &&
        meta.active_sub_teacher_id !== principal.staffId
      ) {
        throw new ApiHttpException({
          statusCode: 403,
          errorCode: 'FORBIDDEN_OBJECT_SCOPE',
          message:
            'An active substitute teacher is currently assigned as pay and execution recipient for this lesson occurrence',
        });
      }
      return Object.freeze({
        lesson_id: lesson.lesson_id,
        group_id: lesson.group_id,
        group_name: meta.group_name,
        group_primary_teacher_id: meta.group_primary_teacher_id,
        group_timezone: meta.group_timezone || this.config.centerTimezone,
        group_status: meta.group_status,
        lesson_date: formatPgDateString(lesson.lesson_date),
        occurrence_seq: Number(lesson.occurrence_seq),
        starts_at_utc: new Date(lesson.starts_at_utc),
        ends_at_utc: new Date(lesson.ends_at_utc),
        status: lesson.status,
        rescheduled_from_lesson_id: lesson.rescheduled_from_lesson_id,
        primary_teacher_snapshot_id: lesson.primary_teacher_snapshot_id,
        pay_recipient_teacher_id: lesson.pay_recipient_teacher_id,
        attendance_version: Number(lesson.attendance_version ?? 0),
        version: Number(lesson.version),
        access_mode: 'PRIMARY_TEACHER',
        active_substitute_assignment_id: meta.active_sub_id,
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
