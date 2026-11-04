import { Inject, Injectable } from '@nestjs/common';
import type { BillingMode, CollectionTiming, DueDateRule } from '@eduerp/contracts';
import * as crypto from 'node:crypto';
import { ApiHttpException } from '../auth/auth.errors';
import { ClockService } from '../auth/clock.service';
import { AuthenticatedStaffPrincipal } from '../auth/permissions.guard';
import { formatCenterLocalDate, SafeTeacherStudentViewDto } from '../auth/staff.service';
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
import { executeOptimisticUpdate } from '../database/transaction';
import {
  escapeSqlLikePattern,
  normalizePersonName,
  normalizeSearchQueryText,
  parseOptionalBooleanQueryParam,
  parseOptionalStrictBoolean,
} from '../students/normalization';
import { AcademicAccessService } from './academic-access.service';
import {
  ALLOWED_BILLING_MODES,
  ALLOWED_COLLECTION_TIMINGS,
  ALLOWED_DUE_DATE_RULES,
  parseNonNegativeMoneyUzs,
  ScheduleDayCode,
  validateIanaTimezone,
  validateScheduleDays,
  validateWallTimeHhMm,
} from './academic-validation';

export interface CourseGroupSummaryDto {
  readonly id: string;
  readonly course_id: string;
  readonly name: string;
  readonly primary_teacher_id: string;
  readonly billing_mode: BillingMode;
  readonly due_date_rule?: DueDateRule;
  readonly fixed_due_day?: number | null;
  readonly collection_timing?: CollectionTiming;
  readonly current_fee_uzs?: string;
  readonly lessons_per_cycle: number;
  readonly schedule_days: readonly ScheduleDayCode[];
  readonly starts_time: string;
  readonly duration_minutes: number;
  readonly timezone: string;
  readonly status: 'ACTIVE' | 'ARCHIVED';
  readonly version: number;
}

export interface CourseGroupListResponseDto {
  readonly items: readonly CourseGroupSummaryDto[];
  readonly next_cursor: string | null;
}

export interface GroupDetailResponseDto {
  readonly group_id: string;
  readonly course_id: string;
  readonly name: string;
  readonly primary_teacher_id: string;
  readonly billing_mode: BillingMode;
  readonly due_date_rule: DueDateRule;
  readonly fixed_due_day: number | null;
  readonly collection_timing: CollectionTiming;
  readonly current_fee_uzs: string;
  readonly lessons_per_cycle: number;
  readonly schedule_days: readonly ScheduleDayCode[];
  readonly starts_time: string;
  readonly duration_minutes: number;
  readonly timezone: string;
  readonly status: 'ACTIVE' | 'ARCHIVED';
  readonly roster: readonly SafeTeacherStudentViewDto[];
  readonly version: number;
}

function validateDueDateAndCollectionTiming(params: {
  readonly rawDueDateRule: unknown;
  readonly rawFixedDueDay: unknown;
  readonly rawCollectionTiming: unknown;
}): {
  readonly dueDateRule: DueDateRule;
  readonly fixedDueDay: number | null;
  readonly collectionTiming: CollectionTiming;
} {
  const dueDateRuleRaw =
    params.rawDueDateRule === undefined || params.rawDueDateRule === null
      ? 'ENROLLMENT_ANNIVERSARY'
      : typeof params.rawDueDateRule === 'string'
        ? params.rawDueDateRule.trim().toUpperCase()
        : '';
  if (!ALLOWED_DUE_DATE_RULES.has(dueDateRuleRaw as DueDateRule)) {
    throw new ApiHttpException({
      statusCode: 400,
      errorCode: 'VALIDATION_ERROR',
      message: 'due_date_rule must be ENROLLMENT_ANNIVERSARY or CENTER_FIXED_DAY (OWNER-20261104-02)',
    });
  }
  const dueDateRule = dueDateRuleRaw as DueDateRule;

  let fixedDueDay: number | null = null;
  if (dueDateRule === 'CENTER_FIXED_DAY') {
    const dayNum = Number(params.rawFixedDueDay);
    if (!Number.isInteger(dayNum) || dayNum < 1 || dayNum > 31) {
      throw new ApiHttpException({
        statusCode: 400,
        errorCode: 'VALIDATION_ERROR',
        message: 'fixed_due_day is required (integer 1..31) when due_date_rule is CENTER_FIXED_DAY (OWNER-20261104-02)',
      });
    }
    fixedDueDay = dayNum;
  } else if (params.rawFixedDueDay !== undefined && params.rawFixedDueDay !== null) {
    throw new ApiHttpException({
      statusCode: 400,
      errorCode: 'VALIDATION_ERROR',
      message: 'fixed_due_day must be null or omitted when due_date_rule is ENROLLMENT_ANNIVERSARY',
    });
  }

  const timingRaw =
    params.rawCollectionTiming === undefined || params.rawCollectionTiming === null
      ? 'ARREARS'
      : typeof params.rawCollectionTiming === 'string'
        ? params.rawCollectionTiming.trim().toUpperCase()
        : '';
  if (!ALLOWED_COLLECTION_TIMINGS.has(timingRaw as CollectionTiming)) {
    throw new ApiHttpException({
      statusCode: 400,
      errorCode: 'VALIDATION_ERROR',
      message: 'collection_timing must be ADVANCE or ARREARS (OWNER-20261104-02)',
    });
  }

  return {
    dueDateRule,
    fixedDueDay,
    collectionTiming: timingRaw as CollectionTiming,
  };
}

@Injectable()
export class GroupsService {
  constructor(
    @Inject(API_CONFIG_TOKEN) private readonly config: ApiEnvConfig,
    @Inject(DatabaseService) private readonly databaseService: DatabaseService,
    @Inject(ClockService) private readonly clock: ClockService,
    @Inject(AcademicAccessService) private readonly academicAccess: AcademicAccessService,
  ) {}

  public async createCourseGroup(
    req: RequestWithCorrelationId,
    principal: AuthenticatedStaffPrincipal,
    rawBody: unknown,
  ): Promise<GroupDetailResponseDto> {
    const idempotencyKey = requireIdempotencyKeyHeader(req);
    const obj = assertPlainObject(rawBody, [
      'course_id',
      'name',
      'primary_teacher_id',
      'billing_mode',
      'due_date_rule',
      'fixed_due_day',
      'collection_timing',
      'current_fee_uzs',
      'lessons_per_cycle',
      'schedule_days',
      'starts_time',
      'duration_minutes',
      'timezone',
      'auto_generate_initial_cycle_invoices',
    ]);

    if (
      parseOptionalStrictBoolean(
        obj.auto_generate_initial_cycle_invoices,
        'auto_generate_initial_cycle_invoices',
        false,
      )
    ) {
      throw new ApiHttpException({
        statusCode: 403,
        errorCode: 'POLICY_DECISION_NOT_CONFIRMED',
        message:
          'Automatic billing cycle and invoice generation belongs to Stage 08 and is gated by open monetary formula decisions (D03/D21)',
      });
    }

    const courseId = assertValidUuid(obj.course_id, 'course_id');
    const { fullName: groupName } = normalizePersonName(obj.name, 'name');
    if (groupName.length > 100) {
      throw new ApiHttpException({
        statusCode: 400,
        errorCode: 'VALIDATION_ERROR',
        message: 'name must be between 2 and 100 characters',
      });
    }
    const primaryTeacherId = assertValidUuid(obj.primary_teacher_id, 'primary_teacher_id');

    const billingModeRaw =
      typeof obj.billing_mode === 'string' ? obj.billing_mode.trim().toUpperCase() : '';
    if (!ALLOWED_BILLING_MODES.has(billingModeRaw as BillingMode)) {
      throw new ApiHttpException({
        statusCode: 400,
        errorCode: 'VALIDATION_ERROR',
        message: 'billing_mode must be CALENDAR_PRO_RATA, ROLLING_MONTH, or LESSON_PACKAGE_12',
      });
    }
    const billingMode = billingModeRaw as BillingMode;

    const { dueDateRule, fixedDueDay, collectionTiming } = validateDueDateAndCollectionTiming({
      rawDueDateRule: obj.due_date_rule,
      rawFixedDueDay: obj.fixed_due_day,
      rawCollectionTiming: obj.collection_timing,
    });

    const currentFeeUzs = parseNonNegativeMoneyUzs(obj.current_fee_uzs, 'current_fee_uzs');
    const lessonsPerCycle =
      obj.lessons_per_cycle === undefined ? 12 : Number(obj.lessons_per_cycle);
    if (!Number.isInteger(lessonsPerCycle) || lessonsPerCycle < 1 || lessonsPerCycle > 60) {
      throw new ApiHttpException({
        statusCode: 400,
        errorCode: 'VALIDATION_ERROR',
        message: 'lessons_per_cycle must be an integer between 1 and 60',
      });
    }

    const scheduleDays = validateScheduleDays(obj.schedule_days, 'schedule_days');
    const { formatted: startsTime } = validateWallTimeHhMm(obj.starts_time, 'starts_time');
    const durationMinutes = Number(obj.duration_minutes);
    if (!Number.isInteger(durationMinutes) || durationMinutes < 15 || durationMinutes > 360) {
      throw new ApiHttpException({
        statusCode: 400,
        errorCode: 'VALIDATION_ERROR',
        message: 'duration_minutes must be an integer between 15 and 360',
      });
    }

    const timezone =
      obj.timezone !== undefined && obj.timezone !== null
        ? validateIanaTimezone(obj.timezone, 'timezone')
        : this.config.centerTimezone;

    const now = this.clock.now();
    const todayCenterDate = formatCenterLocalDate(now, timezone);
    const requestId = req.requestId ?? resolveRequestId(req.headers['x-request-id']);

    const idemOutcome = await executeIdempotentOperation<GroupDetailResponseDto>(
      this.databaseService,
      {
        centerId: principal.centerId,
        actorStaffId: principal.staffId,
        operationType: 'CREATE_COURSE_GROUP',
        idempotencyKey,
        requestPayload: {
          course_id: courseId,
          name: groupName,
          primary_teacher_id: primaryTeacherId,
          billing_mode: billingMode,
          due_date_rule: dueDateRule,
          fixed_due_day: fixedDueDay,
          collection_timing: collectionTiming,
          current_fee_uzs: currentFeeUzs.toString(10),
          lessons_per_cycle: lessonsPerCycle,
          schedule_days: scheduleDays,
          starts_time: startsTime,
          duration_minutes: durationMinutes,
          timezone,
        },
        handler: async (tx) => {
          const courseRes = await tx.query<{ id: string; status: string }>(
            `SELECT "id"::text AS id, "status"::text AS status
               FROM "courses"
              WHERE "id" = $1::uuid
                AND "center_id" = $2::uuid
              FOR UPDATE`,
            [courseId, principal.centerId],
          );
          const course = courseRes.rows[0];
          if (!course) {
            throw new ApiHttpException({
              statusCode: 404,
              errorCode: 'NOT_FOUND',
              message: 'Course not found in this center',
            });
          }
          if (course.status !== 'ACTIVE') {
            throw new ApiHttpException({
              statusCode: 422,
              errorCode: 'VALIDATION_ERROR',
              message: 'Cannot create a group under an ARCHIVED course',
            });
          }

          await this.academicAccess.verifyActiveTeacherInCenter(
            tx,
            principal.centerId,
            primaryTeacherId,
            'primary_teacher_id',
            true,
          );

          const groupId = crypto.randomUUID();
          const ins = await tx.query<{
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
            schedule_days_json: ScheduleDayCode[];
            starts_time: string;
            duration_minutes: number;
            timezone: string;
            status: 'ACTIVE' | 'ARCHIVED';
            version: number;
          }>(
            `INSERT INTO "course_groups" (
               "id", "center_id", "course_id", "name", "primary_teacher_id",
               "billing_mode", "due_date_rule", "fixed_due_day", "collection_timing",
               "current_fee_uzs", "lessons_per_cycle", "schedule_days_json",
               "starts_time", "duration_minutes", "timezone", "status",
               "version", "created_at", "updated_at"
             ) VALUES (
               $1::uuid, $2::uuid, $3::uuid, $4, $5::uuid,
               $6, $7, $8::smallint, $9,
               $10::bigint, $11::int, $12::jsonb,
               $13, $14::int, $15, 'ACTIVE',
               1, $16::timestamptz, $16::timestamptz
             )
             RETURNING "id"::text AS id,
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
                       "version"`,
            [
              groupId,
              principal.centerId,
              courseId,
              groupName,
              primaryTeacherId,
              billingMode,
              dueDateRule,
              fixedDueDay,
              collectionTiming,
              currentFeeUzs.toString(10),
              lessonsPerCycle,
              JSON.stringify(scheduleDays),
              startsTime,
              durationMinutes,
              timezone,
              now.toISOString(),
            ],
          );

          const created = ins.rows[0];

          await tx.query(
            `INSERT INTO "course_price_history" (
               "id", "center_id", "course_id", "group_id",
               "previous_fee_uzs", "new_fee_uzs", "effective_from",
               "changed_by_staff_id", "change_reason", "target_version_snapshot", "created_at"
             ) VALUES (
               $1::uuid, $2::uuid, $3::uuid, $4::uuid,
               $5::bigint, $5::bigint, $6::date,
               $7::uuid, 'INITIAL_GROUP_TARIFF', 1, $8::timestamptz
             )`,
            [
              crypto.randomUUID(),
              principal.centerId,
              courseId,
              groupId,
              currentFeeUzs.toString(10),
              todayCenterDate,
              principal.staffId,
              now.toISOString(),
            ],
          );

          await tx.query(
            `INSERT INTO "audit_logs" (
               "id", "center_id", "actor_type", "actor_id", "actor_role",
               "action", "entity_type", "entity_id", "severity",
               "after_redacted_json", "request_id", "created_at"
             ) VALUES (
               $1::uuid, $2::uuid, 'STAFF', $3::uuid, $4,
               'COURSE_GROUP_CREATED', 'CourseGroup', $5::uuid, 'INFO',
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
                course_id: courseId,
                name: groupName,
                primary_teacher_id: primaryTeacherId,
                billing_mode: billingMode,
                due_date_rule: dueDateRule,
                fixed_due_day: fixedDueDay,
                collection_timing: collectionTiming,
                current_fee_uzs: currentFeeUzs.toString(10),
                lessons_per_cycle: lessonsPerCycle,
                schedule_days: scheduleDays,
                starts_time: startsTime,
                duration_minutes: durationMinutes,
                timezone,
              }),
              requestId,
              now.toISOString(),
            ],
          );

          return {
            statusCode: 201,
            body: Object.freeze({
              group_id: created.id,
              course_id: created.course_id,
              name: created.name,
              primary_teacher_id: created.primary_teacher_id,
              billing_mode: created.billing_mode,
              due_date_rule: created.due_date_rule,
              fixed_due_day: created.fixed_due_day !== null ? Number(created.fixed_due_day) : null,
              collection_timing: created.collection_timing,
              current_fee_uzs: BigInt(created.current_fee_uzs).toString(10),
              lessons_per_cycle: Number(created.lessons_per_cycle),
              schedule_days: Object.freeze(scheduleDays),
              starts_time: created.starts_time,
              duration_minutes: Number(created.duration_minutes),
              timezone: created.timezone,
              status: created.status,
              roster: Object.freeze([]),
              version: Number(created.version),
            }),
          };
        },
      },
    );

    return idemOutcome.body;
  }

  public async listCourseGroups(
    principal: AuthenticatedStaffPrincipal,
    query: {
      course_id?: string;
      search?: string;
      status?: string;
      include_archived?: string;
      cursor?: string;
      limit?: string;
    } = {},
  ): Promise<CourseGroupListResponseDto> {
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

    const courseIdFilter =
      query.course_id !== undefined && query.course_id !== ''
        ? assertValidUuid(query.course_id, 'course_id')
        : null;

    const includeArchived = parseOptionalBooleanQueryParam(
      query.include_archived,
      'include_archived',
      false,
    );
    let statusFilter: 'ACTIVE' | 'ARCHIVED' | null = includeArchived ? null : 'ACTIVE';
    if (query.status !== undefined && query.status !== '') {
      const sUpper = query.status.trim().toUpperCase();
      if (sUpper !== 'ACTIVE' && sUpper !== 'ARCHIVED') {
        throw new ApiHttpException({
          statusCode: 400,
          errorCode: 'VALIDATION_ERROR',
          message: 'status filter must be ACTIVE or ARCHIVED',
        });
      }
      statusFilter = sUpper as 'ACTIVE' | 'ARCHIVED';
    }

    let searchPattern: string | null = null;
    if (query.search !== undefined && query.search.trim().length > 0) {
      const normalized = normalizeSearchQueryText(query.search.trim());
      searchPattern = `%${escapeSqlLikePattern(normalized)}%`;
    }

    const isTeacher = principal.role === 'TEACHER';
    const todayCenterDate = formatCenterLocalDate(this.clock.now(), this.config.centerTimezone);

    const res = await this.databaseService.query<{
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
      schedule_days_json: ScheduleDayCode[];
      starts_time: string;
      duration_minutes: number;
      timezone: string;
      status: 'ACTIVE' | 'ARCHIVED';
      version: number;
    }>(
      `SELECT cg."id"::text AS id,
              cg."course_id"::text AS course_id,
              cg."name",
              cg."primary_teacher_id"::text AS primary_teacher_id,
              cg."billing_mode"::text AS billing_mode,
              cg."due_date_rule"::text AS due_date_rule,
              cg."fixed_due_day",
              cg."collection_timing"::text AS collection_timing,
              cg."current_fee_uzs"::text AS current_fee_uzs,
              cg."lessons_per_cycle",
              cg."schedule_days_json",
              cg."starts_time",
              cg."duration_minutes",
              cg."timezone",
              cg."status"::text AS status,
              cg."version"
         FROM "course_groups" cg
        WHERE cg."center_id" = $1::uuid
          AND ($2::uuid IS NULL OR cg."course_id" = $2::uuid)
          AND ($3::text IS NULL OR cg."status" = $3::text)
          AND ($4::uuid IS NULL OR cg."id" > $4::uuid)
          AND ($5::text IS NULL OR LOWER(cg."name") LIKE $5::text ESCAPE '\\')
          AND (
            $6::boolean = FALSE
            OR cg."primary_teacher_id" = $7::uuid
            OR EXISTS (
              SELECT 1
                FROM "substitute_assignments" sa
                JOIN "lesson_occurrences" lo
                  ON lo."id" = sa."lesson_id"
                 AND lo."center_id" = sa."center_id"
               WHERE sa."center_id" = cg."center_id"
                 AND lo."group_id" = cg."id"
                 AND sa."substitute_teacher_id" = $7::uuid
                 AND sa."status" = 'ACTIVE'
                 AND lo."status" IN ('SCHEDULED', 'COMPLETED')
                 AND lo."lesson_date" = $8::date
            )
          )
        ORDER BY cg."id" ASC
        LIMIT $9::int`,
      [
        principal.centerId,
        courseIdFilter,
        statusFilter,
        cursorUuid,
        searchPattern,
        isTeacher,
        principal.staffId,
        todayCenterDate,
        limit + 1,
      ],
    );

    const hasMore = res.rows.length > limit;
    const slice = hasMore ? res.rows.slice(0, limit) : res.rows;
    const nextCursor = hasMore ? slice[slice.length - 1]?.id ?? null : null;

    // 07.01 Role-Safe Projection: Teacher responses NEVER include financial fee fields (current_fee_uzs, due_date_rule, etc.)
    const items: CourseGroupSummaryDto[] = slice.map((r) => {
      const base: CourseGroupSummaryDto = {
        id: r.id,
        course_id: r.course_id,
        name: r.name,
        primary_teacher_id: r.primary_teacher_id,
        billing_mode: r.billing_mode,
        lessons_per_cycle: Number(r.lessons_per_cycle),
        schedule_days: Array.isArray(r.schedule_days_json) ? r.schedule_days_json : [],
        starts_time: r.starts_time,
        duration_minutes: Number(r.duration_minutes),
        timezone: r.timezone,
        status: r.status,
        version: Number(r.version),
      };
      if (isTeacher) {
        return Object.freeze(base);
      }
      return Object.freeze({
        ...base,
        due_date_rule: r.due_date_rule,
        fixed_due_day: r.fixed_due_day !== null ? Number(r.fixed_due_day) : null,
        collection_timing: r.collection_timing,
        current_fee_uzs: BigInt(r.current_fee_uzs).toString(10),
      });
    });

    return Object.freeze({
      items: Object.freeze(items),
      next_cursor: nextCursor,
    });
  }

  public async updateOrArchiveCourseGroup(
    req: RequestWithCorrelationId,
    principal: AuthenticatedStaffPrincipal,
    rawGroupId: string,
    rawBody: unknown,
  ): Promise<GroupDetailResponseDto> {
    const idempotencyKey = requireIdempotencyKeyHeader(req);
    const groupId = assertValidUuid(rawGroupId, 'group_id');
    const obj = assertPlainObject(rawBody, [
      'name',
      'primary_teacher_id',
      'due_date_rule',
      'fixed_due_day',
      'collection_timing',
      'schedule_days',
      'starts_time',
      'duration_minutes',
      'timezone',
      'status',
      'reason',
      'expected_version',
    ]);

    const expectedVersion = resolveExpectedVersion(req, obj.expected_version);
    const hasName = obj.name !== undefined;
    const parsedName = hasName ? normalizePersonName(obj.name, 'name').fullName : null;
    if (parsedName !== null && parsedName.length > 100) {
      throw new ApiHttpException({
        statusCode: 400,
        errorCode: 'VALIDATION_ERROR',
        message: 'name must be between 2 and 100 characters',
      });
    }

    const hasTeacher = obj.primary_teacher_id !== undefined;
    const parsedTeacherId = hasTeacher
      ? assertValidUuid(obj.primary_teacher_id, 'primary_teacher_id')
      : null;

    const hasScheduleDays = obj.schedule_days !== undefined;
    const parsedScheduleDays = hasScheduleDays
      ? validateScheduleDays(obj.schedule_days, 'schedule_days')
      : null;

    const hasStartsTime = obj.starts_time !== undefined;
    const parsedStartsTime = hasStartsTime
      ? validateWallTimeHhMm(obj.starts_time, 'starts_time').formatted
      : null;

    const hasDuration = obj.duration_minutes !== undefined;
    let parsedDuration: number | null = null;
    if (hasDuration) {
      parsedDuration = Number(obj.duration_minutes);
      if (!Number.isInteger(parsedDuration) || parsedDuration < 15 || parsedDuration > 360) {
        throw new ApiHttpException({
          statusCode: 400,
          errorCode: 'VALIDATION_ERROR',
          message: 'duration_minutes must be an integer between 15 and 360',
        });
      }
    }

    const hasTimezone = obj.timezone !== undefined;
    const parsedTimezone = hasTimezone ? validateIanaTimezone(obj.timezone, 'timezone') : null;

    const hasStatus = obj.status !== undefined;
    let parsedStatus: 'ACTIVE' | 'ARCHIVED' | null = null;
    if (hasStatus) {
      const sRaw = typeof obj.status === 'string' ? obj.status.trim().toUpperCase() : '';
      if (sRaw !== 'ACTIVE' && sRaw !== 'ARCHIVED') {
        throw new ApiHttpException({
          statusCode: 400,
          errorCode: 'VALIDATION_ERROR',
          message: 'status must be ACTIVE or ARCHIVED',
        });
      }
      parsedStatus = sRaw as 'ACTIVE' | 'ARCHIVED';
    }

    const hasBillingTimingUpdate =
      obj.due_date_rule !== undefined ||
      obj.fixed_due_day !== undefined ||
      obj.collection_timing !== undefined;

    if (
      !hasName &&
      !hasTeacher &&
      !hasScheduleDays &&
      !hasStartsTime &&
      !hasDuration &&
      !hasTimezone &&
      !hasStatus &&
      !hasBillingTimingUpdate
    ) {
      throw new ApiHttpException({
        statusCode: 400,
        errorCode: 'VALIDATION_ERROR',
        message: 'At least one updatable group field must be provided',
      });
    }

    let reason: string | null = null;
    if (obj.reason !== undefined && obj.reason !== null) {
      if (typeof obj.reason !== 'string' || obj.reason.trim().length < 3 || obj.reason.trim().length > 255) {
        throw new ApiHttpException({
          statusCode: 400,
          errorCode: 'VALIDATION_ERROR',
          message: 'reason must be between 3 and 255 characters when provided',
        });
      }
      reason = obj.reason.trim();
    }

    const now = this.clock.now();
    const requestId = req.requestId ?? resolveRequestId(req.headers['x-request-id']);

    const idemOutcome = await executeIdempotentOperation<GroupDetailResponseDto>(
      this.databaseService,
      {
        centerId: principal.centerId,
        actorStaffId: principal.staffId,
        operationType: 'UPDATE_OR_ARCHIVE_COURSE_GROUP',
        idempotencyKey,
        requestPayload: {
          group_id: groupId,
          name: parsedName ?? undefined,
          primary_teacher_id: parsedTeacherId ?? undefined,
          due_date_rule: obj.due_date_rule ?? undefined,
          fixed_due_day: obj.fixed_due_day ?? undefined,
          collection_timing: obj.collection_timing ?? undefined,
          schedule_days: parsedScheduleDays ?? undefined,
          starts_time: parsedStartsTime ?? undefined,
          duration_minutes: parsedDuration ?? undefined,
          timezone: parsedTimezone ?? undefined,
          status: parsedStatus ?? undefined,
          reason,
          expected_version: expectedVersion,
        },
        handler: async (tx) => {
          const before = await this.academicAccess.assertGroupAccess(tx, principal, groupId, {
            lockGroup: true,
          });

          if (parsedTeacherId !== null && parsedTeacherId !== before.primary_teacher_id) {
            await this.academicAccess.verifyActiveTeacherInCenter(
              tx,
              principal.centerId,
              parsedTeacherId,
              'primary_teacher_id',
              true,
            );
          }

          const { dueDateRule, fixedDueDay, collectionTiming } = validateDueDateAndCollectionTiming({
            rawDueDateRule:
              obj.due_date_rule !== undefined ? obj.due_date_rule : before.due_date_rule,
            rawFixedDueDay:
              obj.fixed_due_day !== undefined
                ? obj.fixed_due_day
                : (obj.due_date_rule === 'ENROLLMENT_ANNIVERSARY' ? null : before.fixed_due_day),
            rawCollectionTiming:
              obj.collection_timing !== undefined
                ? obj.collection_timing
                : before.collection_timing,
          });

          const nextName = parsedName ?? before.name;
          const nextTeacherId = parsedTeacherId ?? before.primary_teacher_id;
          const nextScheduleDays =
            parsedScheduleDays ?? (before.schedule_days_json as readonly ScheduleDayCode[]);
          const nextStartsTime = parsedStartsTime ?? before.starts_time;
          const nextDuration = parsedDuration ?? before.duration_minutes;
          const nextTimezone = parsedTimezone ?? before.timezone;
          const nextStatus = parsedStatus ?? before.status;

          const updated = await executeOptimisticUpdate<{
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
            schedule_days_json: ScheduleDayCode[];
            starts_time: string;
            duration_minutes: number;
            timezone: string;
            status: 'ACTIVE' | 'ARCHIVED';
            version: number;
          }>(tx, {
            tableName: 'course_groups',
            entityName: 'CourseGroup',
            id: groupId,
            centerId: principal.centerId,
            expectedVersion,
            setClauseSql: `"name" = $4, "primary_teacher_id" = $5::uuid, "due_date_rule" = $6, "fixed_due_day" = $7::smallint, "collection_timing" = $8, "schedule_days_json" = $9::jsonb, "starts_time" = $10, "duration_minutes" = $11::int, "timezone" = $12, "status" = $13`,
            additionalValues: [
              nextName,
              nextTeacherId,
              dueDateRule,
              fixedDueDay,
              collectionTiming,
              JSON.stringify(nextScheduleDays),
              nextStartsTime,
              nextDuration,
              nextTimezone,
              nextStatus,
            ],
          });

          // 07.01 & 07.03: Changing group's primary_teacher_id NEVER alters historical COMPLETED, CANCELLED_BY_CENTER, or RESCHEDULED lessons!
          const actionName =
            before.status !== 'ARCHIVED' && nextStatus === 'ARCHIVED'
              ? 'COURSE_GROUP_ARCHIVED'
              : 'COURSE_GROUP_UPDATED';

          await tx.query(
            `INSERT INTO "audit_logs" (
               "id", "center_id", "actor_type", "actor_id", "actor_role",
               "action", "entity_type", "entity_id", "severity",
               "before_redacted_json", "after_redacted_json", "request_id", "created_at"
             ) VALUES (
               $1::uuid, $2::uuid, 'STAFF', $3::uuid, $4,
               $5, 'CourseGroup', $6::uuid, 'INFO',
               $7::jsonb, $8::jsonb, $9, $10::timestamptz
             )`,
            [
              crypto.randomUUID(),
              principal.centerId,
              principal.staffId,
              principal.role,
              actionName,
              groupId,
              JSON.stringify({
                name: before.name,
                primary_teacher_id: before.primary_teacher_id,
                due_date_rule: before.due_date_rule,
                fixed_due_day: before.fixed_due_day,
                collection_timing: before.collection_timing,
                status: before.status,
                version: before.version,
              }),
              JSON.stringify({
                name: updated.name,
                primary_teacher_id: updated.primary_teacher_id,
                due_date_rule: updated.due_date_rule,
                fixed_due_day: updated.fixed_due_day !== null ? Number(updated.fixed_due_day) : null,
                collection_timing: updated.collection_timing,
                status: updated.status,
                reason,
                version: Number(updated.version),
              }),
              requestId,
              now.toISOString(),
            ],
          );

          return {
            statusCode: 200,
            body: Object.freeze({
              group_id: updated.id,
              course_id: updated.course_id,
              name: updated.name,
              primary_teacher_id: updated.primary_teacher_id,
              billing_mode: updated.billing_mode,
              due_date_rule: updated.due_date_rule,
              fixed_due_day: updated.fixed_due_day !== null ? Number(updated.fixed_due_day) : null,
              collection_timing: updated.collection_timing,
              current_fee_uzs: BigInt(updated.current_fee_uzs).toString(10),
              lessons_per_cycle: Number(updated.lessons_per_cycle),
              schedule_days: Object.freeze(nextScheduleDays),
              starts_time: updated.starts_time,
              duration_minutes: Number(updated.duration_minutes),
              timezone: updated.timezone,
              status: updated.status,
              roster: Object.freeze([]),
              version: Number(updated.version),
            }),
          };
        },
      },
    );

    return idemOutcome.body;
  }
}
