import { Inject, Injectable } from '@nestjs/common';
import * as crypto from 'node:crypto';
import { ApiHttpException } from '../auth/auth.errors';
import { ClockService } from '../auth/clock.service';
import { AuthenticatedStaffPrincipal } from '../auth/permissions.guard';
import { formatCenterLocalDate } from '../auth/staff.service';
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
  validateIsoDate,
} from '../students/normalization';
import { QueryExecutor } from './academic-access.service';
import { parseNonNegativeMoneyUzs } from './academic-validation';

export interface CoursePriceHistoryItemDto {
  readonly id: string;
  readonly course_id: string;
  readonly group_id: string | null;
  readonly previous_fee_uzs: string;
  readonly new_fee_uzs: string;
  readonly effective_from: string;
  readonly changed_by_staff_id: string;
  readonly change_reason: string | null;
  readonly target_version_snapshot: number;
  readonly created_at_utc: string;
}

export interface CourseResponseDto {
  readonly id: string;
  readonly name: string;
  readonly default_monthly_fee_uzs: string;
  readonly effective_fee_as_of_uzs: string;
  readonly as_of_date: string;
  readonly latest_scheduled_fee_uzs: string;
  readonly latest_effective_from: string | null;
  readonly default_lessons_per_cycle: number;
  readonly status: 'ACTIVE' | 'ARCHIVED';
  readonly price_history: readonly CoursePriceHistoryItemDto[];
  readonly version: number;
}

export interface CourseListResponseDto {
  readonly items: readonly CourseResponseDto[];
  readonly next_cursor: string | null;
}

function formatPgDate(val: unknown): string {
  if (val instanceof Date) {
    return val.toISOString().slice(0, 10);
  }
  return String(val).slice(0, 10);
}

@Injectable()
export class CoursesService {
  constructor(
    @Inject(API_CONFIG_TOKEN) private readonly config: ApiEnvConfig,
    @Inject(DatabaseService) private readonly databaseService: DatabaseService,
    @Inject(ClockService) private readonly clock: ClockService,
  ) {}

  public async buildCourseResponse(
    executor: QueryExecutor,
    centerId: string,
    row: {
      id: string;
      name: string;
      default_monthly_fee_uzs: string;
      default_lessons_per_cycle: number;
      status: 'ACTIVE' | 'ARCHIVED';
      version: number;
    },
    asOfDate?: string,
  ): Promise<CourseResponseDto> {
    const resolvedAsOfDate =
      asOfDate ?? formatCenterLocalDate(this.clock.now(), this.config.centerTimezone);

    const histRes = await executor.query<{
      id: string;
      course_id: string;
      group_id: string | null;
      previous_fee_uzs: string;
      new_fee_uzs: string;
      effective_from: unknown;
      changed_by_staff_id: string;
      change_reason: string | null;
      target_version_snapshot: number;
      created_at: Date;
    }>(
      `SELECT "id"::text AS id,
              "course_id"::text AS course_id,
              "group_id"::text AS group_id,
              "previous_fee_uzs"::text AS previous_fee_uzs,
              "new_fee_uzs"::text AS new_fee_uzs,
              "effective_from",
              "changed_by_staff_id"::text AS changed_by_staff_id,
              "change_reason",
              "target_version_snapshot",
              "created_at"
         FROM "course_price_history"
        WHERE "center_id" = $1::uuid
          AND "course_id" = $2::uuid
          AND "group_id" IS NULL
        ORDER BY "effective_from" DESC, "created_at" DESC, "id" DESC`,
      [centerId, row.id],
    );

    const historyItems: CoursePriceHistoryItemDto[] = histRes.rows.map((h) =>
      Object.freeze({
        id: h.id,
        course_id: h.course_id,
        group_id: h.group_id,
        previous_fee_uzs: BigInt(h.previous_fee_uzs).toString(10),
        new_fee_uzs: BigInt(h.new_fee_uzs).toString(10),
        effective_from: formatPgDate(h.effective_from),
        changed_by_staff_id: h.changed_by_staff_id,
        change_reason: h.change_reason ?? null,
        target_version_snapshot: Number(h.target_version_snapshot ?? 1),
        created_at_utc: new Date(h.created_at).toISOString(),
      }),
    );

    // 07.01 Current vs As-Of Tariff Resolution:
    // Any future-dated price row (effective_from > resolvedAsOfDate) is scheduled for the future
    // and does NOT become the active price until its effective_from calendar date arrives.
    const activeAsOfEntry = historyItems.find((h) => h.effective_from <= resolvedAsOfDate);
    const earliestEntry =
      historyItems.length > 0 ? historyItems[historyItems.length - 1] : undefined;
    const effectiveFeeAsOfUzs = activeAsOfEntry
      ? activeAsOfEntry.new_fee_uzs
      : earliestEntry
        ? earliestEntry.previous_fee_uzs
        : BigInt(row.default_monthly_fee_uzs).toString(10);

    const latestScheduledEntry = historyItems[0];
    const latestScheduledFeeUzs = latestScheduledEntry
      ? latestScheduledEntry.new_fee_uzs
      : BigInt(row.default_monthly_fee_uzs).toString(10);
    const latestEffectiveFrom = latestScheduledEntry ? latestScheduledEntry.effective_from : null;

    return Object.freeze({
      id: row.id,
      name: row.name,
      default_monthly_fee_uzs: effectiveFeeAsOfUzs,
      effective_fee_as_of_uzs: effectiveFeeAsOfUzs,
      as_of_date: resolvedAsOfDate,
      latest_scheduled_fee_uzs: latestScheduledFeeUzs,
      latest_effective_from: latestEffectiveFrom,
      default_lessons_per_cycle: Number(row.default_lessons_per_cycle),
      status: row.status,
      price_history: Object.freeze(historyItems),
      version: Number(row.version),
    });
  }

  public async listCourses(
    principal: AuthenticatedStaffPrincipal,
    query: {
      search?: string;
      status?: string;
      include_archived?: string;
      as_of_date?: string;
      cursor?: string;
      limit?: string;
    } = {},
  ): Promise<CourseListResponseDto> {
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

    const asOfDate =
      query.as_of_date !== undefined && query.as_of_date !== ''
        ? validateIsoDate(query.as_of_date, 'as_of_date')
        : formatCenterLocalDate(this.clock.now(), this.config.centerTimezone);

    let searchPattern: string | null = null;
    if (query.search !== undefined && query.search.trim().length > 0) {
      const normalized = normalizeSearchQueryText(query.search.trim());
      searchPattern = `%${escapeSqlLikePattern(normalized)}%`;
    }

    const res = await this.databaseService.query<{
      id: string;
      name: string;
      default_monthly_fee_uzs: string;
      default_lessons_per_cycle: number;
      status: 'ACTIVE' | 'ARCHIVED';
      version: number;
    }>(
      `SELECT "id"::text AS id,
              "name",
              "default_monthly_fee_uzs"::text AS default_monthly_fee_uzs,
              "default_lessons_per_cycle",
              "status"::text AS status,
              "version"
         FROM "courses"
        WHERE "center_id" = $1::uuid
          AND ($2::text IS NULL OR "status" = $2::text)
          AND ($3::uuid IS NULL OR "id" > $3::uuid)
          AND ($4::text IS NULL OR LOWER("name") LIKE $4::text ESCAPE '\\')
        ORDER BY "id" ASC
        LIMIT $5::int`,
      [principal.centerId, statusFilter, cursorUuid, searchPattern, limit + 1],
    );

    const hasMore = res.rows.length > limit;
    const slice = hasMore ? res.rows.slice(0, limit) : res.rows;
    const nextCursor = hasMore ? slice[slice.length - 1]?.id ?? null : null;

    const items: CourseResponseDto[] = [];
    for (const row of slice) {
      items.push(
        await this.buildCourseResponse(this.databaseService, principal.centerId, row, asOfDate),
      );
    }

    return Object.freeze({
      items: Object.freeze(items),
      next_cursor: nextCursor,
    });
  }

  public async createCourse(
    req: RequestWithCorrelationId,
    principal: AuthenticatedStaffPrincipal,
    rawBody: unknown,
  ): Promise<CourseResponseDto> {
    const idempotencyKey = requireIdempotencyKeyHeader(req);
    const obj = assertPlainObject(rawBody, [
      'name',
      'default_monthly_fee_uzs',
      'default_lessons_per_cycle',
      'effective_from',
    ]);

    const { fullName: courseName } = normalizePersonName(obj.name, 'name');
    if (courseName.length > 100) {
      throw new ApiHttpException({
        statusCode: 400,
        errorCode: 'VALIDATION_ERROR',
        message: 'name must be between 2 and 100 characters',
      });
    }
    const feeUzs = parseNonNegativeMoneyUzs(obj.default_monthly_fee_uzs, 'default_monthly_fee_uzs');
    const lessonsPerCycleRaw =
      obj.default_lessons_per_cycle === undefined ? 12 : Number(obj.default_lessons_per_cycle);
    if (
      !Number.isInteger(lessonsPerCycleRaw) ||
      lessonsPerCycleRaw < 1 ||
      lessonsPerCycleRaw > 60
    ) {
      throw new ApiHttpException({
        statusCode: 400,
        errorCode: 'VALIDATION_ERROR',
        message: 'default_lessons_per_cycle must be an integer between 1 and 60',
      });
    }

    const now = this.clock.now();
    const todayCenterDate = formatCenterLocalDate(now, this.config.centerTimezone);
    const effectiveFrom =
      obj.effective_from !== undefined && obj.effective_from !== null
        ? validateIsoDate(obj.effective_from, 'effective_from')
        : todayCenterDate;
    const requestId = req.requestId ?? resolveRequestId(req.headers['x-request-id']);

    const idemOutcome = await executeIdempotentOperation<CourseResponseDto>(
      this.databaseService,
      {
        centerId: principal.centerId,
        actorStaffId: principal.staffId,
        operationType: 'CREATE_COURSE',
        idempotencyKey,
        requestPayload: {
          name: courseName,
          default_monthly_fee_uzs: feeUzs.toString(10),
          default_lessons_per_cycle: lessonsPerCycleRaw,
          effective_from: effectiveFrom,
        },
        handler: async (tx) => {
          const courseId = crypto.randomUUID();
          try {
            const ins = await tx.query<{
              id: string;
              name: string;
              default_monthly_fee_uzs: string;
              default_lessons_per_cycle: number;
              status: 'ACTIVE' | 'ARCHIVED';
              version: number;
            }>(
              `INSERT INTO "courses" (
                 "id", "center_id", "name", "default_monthly_fee_uzs",
                 "default_lessons_per_cycle", "status", "version", "created_at", "updated_at"
               ) VALUES (
                 $1::uuid, $2::uuid, $3, $4::bigint,
                 $5::int, 'ACTIVE', 1, $6::timestamptz, $6::timestamptz
               )
               RETURNING "id"::text AS id,
                         "name",
                         "default_monthly_fee_uzs"::text AS default_monthly_fee_uzs,
                         "default_lessons_per_cycle",
                         "status"::text AS status,
                         "version"`,
              [
                courseId,
                principal.centerId,
                courseName,
                feeUzs.toString(10),
                lessonsPerCycleRaw,
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
                 $1::uuid, $2::uuid, $3::uuid, NULL,
                 $4::bigint, $4::bigint, $5::date,
                 $6::uuid, 'INITIAL_COURSE_TARIFF', 1, $7::timestamptz
               )`,
              [
                crypto.randomUUID(),
                principal.centerId,
                courseId,
                feeUzs.toString(10),
                effectiveFrom,
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
                 'COURSE_CREATED', 'Course', $5::uuid, 'INFO',
                 $6::jsonb, $7, $8::timestamptz
               )`,
              [
                crypto.randomUUID(),
                principal.centerId,
                principal.staffId,
                principal.role,
                courseId,
                JSON.stringify({
                  course_id: courseId,
                  name: courseName,
                  default_monthly_fee_uzs: feeUzs.toString(10),
                  default_lessons_per_cycle: lessonsPerCycleRaw,
                  effective_from: effectiveFrom,
                }),
                requestId,
                now.toISOString(),
              ],
            );

            const responseDto = await this.buildCourseResponse(
              tx,
              principal.centerId,
              created,
              todayCenterDate,
            );
            return {
              statusCode: 201,
              body: responseDto,
            };
          } catch (err: unknown) {
            if ((err as { code?: string }).code === '23505') {
              throw new ApiHttpException({
                statusCode: 409,
                errorCode: 'VALIDATION_ERROR',
                message: `Course name '${courseName}' already exists in this center`,
              });
            }
            throw err;
          }
        },
      },
    );

    return idemOutcome.body;
  }

  public async updateOrArchiveCourse(
    req: RequestWithCorrelationId,
    principal: AuthenticatedStaffPrincipal,
    rawCourseId: string,
    rawBody: unknown,
  ): Promise<CourseResponseDto> {
    const idempotencyKey = requireIdempotencyKeyHeader(req);
    const courseId = assertValidUuid(rawCourseId, 'course_id');
    const obj = assertPlainObject(rawBody, [
      'name',
      'default_lessons_per_cycle',
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

    const hasLessonsPerCycle = obj.default_lessons_per_cycle !== undefined;
    let parsedLessonsPerCycle: number | null = null;
    if (hasLessonsPerCycle) {
      parsedLessonsPerCycle = Number(obj.default_lessons_per_cycle);
      if (
        !Number.isInteger(parsedLessonsPerCycle) ||
        parsedLessonsPerCycle < 1 ||
        parsedLessonsPerCycle > 60
      ) {
        throw new ApiHttpException({
          statusCode: 400,
          errorCode: 'VALIDATION_ERROR',
          message: 'default_lessons_per_cycle must be an integer between 1 and 60',
        });
      }
    }

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

    if (!hasName && !hasLessonsPerCycle && !hasStatus) {
      throw new ApiHttpException({
        statusCode: 400,
        errorCode: 'VALIDATION_ERROR',
        message: 'At least one updatable field (name, default_lessons_per_cycle, status) must be provided',
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
    const todayCenterDate = formatCenterLocalDate(now, this.config.centerTimezone);
    const requestId = req.requestId ?? resolveRequestId(req.headers['x-request-id']);

    const idemOutcome = await executeIdempotentOperation<CourseResponseDto>(
      this.databaseService,
      {
        centerId: principal.centerId,
        actorStaffId: principal.staffId,
        operationType: 'UPDATE_OR_ARCHIVE_COURSE',
        idempotencyKey,
        requestPayload: {
          course_id: courseId,
          name: parsedName ?? undefined,
          default_lessons_per_cycle: parsedLessonsPerCycle ?? undefined,
          status: parsedStatus ?? undefined,
          reason,
          expected_version: expectedVersion,
        },
        handler: async (tx) => {
          const existingRes = await tx.query<{
            id: string;
            name: string;
            default_monthly_fee_uzs: string;
            default_lessons_per_cycle: number;
            status: 'ACTIVE' | 'ARCHIVED';
            version: number;
          }>(
            `SELECT "id"::text AS id,
                    "name",
                    "default_monthly_fee_uzs"::text AS default_monthly_fee_uzs,
                    "default_lessons_per_cycle",
                    "status"::text AS status,
                    "version"
               FROM "courses"
              WHERE "id" = $1::uuid
                AND "center_id" = $2::uuid
              FOR UPDATE`,
            [courseId, principal.centerId],
          );

          const before = existingRes.rows[0];
          if (!before) {
            throw new ApiHttpException({
              statusCode: 404,
              errorCode: 'NOT_FOUND',
              message: 'Course not found in this center',
            });
          }

          const nextName = parsedName ?? before.name;
          const nextLessonsPerCycle =
            parsedLessonsPerCycle ?? Number(before.default_lessons_per_cycle);
          const nextStatus = parsedStatus ?? before.status;

          try {
            const updated = await executeOptimisticUpdate<{
              id: string;
              name: string;
              default_monthly_fee_uzs: string;
              default_lessons_per_cycle: number;
              status: 'ACTIVE' | 'ARCHIVED';
              version: number;
            }>(tx, {
              tableName: 'courses',
              entityName: 'Course',
              id: courseId,
              centerId: principal.centerId,
              expectedVersion,
              setClauseSql: `"name" = $4, "default_lessons_per_cycle" = $5::int, "status" = $6`,
              additionalValues: [nextName, nextLessonsPerCycle, nextStatus],
            });

            const actionName =
              before.status !== 'ARCHIVED' && nextStatus === 'ARCHIVED'
                ? 'COURSE_ARCHIVED'
                : 'COURSE_UPDATED';

            await tx.query(
              `INSERT INTO "audit_logs" (
                 "id", "center_id", "actor_type", "actor_id", "actor_role",
                 "action", "entity_type", "entity_id", "severity",
                 "before_redacted_json", "after_redacted_json", "request_id", "created_at"
               ) VALUES (
                 $1::uuid, $2::uuid, 'STAFF', $3::uuid, $4,
                 $5, 'Course', $6::uuid, 'INFO',
                 $7::jsonb, $8::jsonb, $9, $10::timestamptz
               )`,
              [
                crypto.randomUUID(),
                principal.centerId,
                principal.staffId,
                principal.role,
                actionName,
                courseId,
                JSON.stringify({
                  name: before.name,
                  default_lessons_per_cycle: Number(before.default_lessons_per_cycle),
                  status: before.status,
                  version: Number(before.version),
                }),
                JSON.stringify({
                  name: updated.name,
                  default_lessons_per_cycle: Number(updated.default_lessons_per_cycle),
                  status: updated.status,
                  reason,
                  version: Number(updated.version),
                }),
                requestId,
                now.toISOString(),
              ],
            );

            const body = await this.buildCourseResponse(
              tx,
              principal.centerId,
              updated,
              todayCenterDate,
            );
            return {
              statusCode: 200,
              body,
            };
          } catch (err: unknown) {
            if ((err as { code?: string }).code === '23505') {
              throw new ApiHttpException({
                statusCode: 409,
                errorCode: 'VALIDATION_ERROR',
                message: `Course name '${nextName}' already exists in this center`,
              });
            }
            throw err;
          }
        },
      },
    );

    return idemOutcome.body;
  }

  public async updateCoursePrice(
    req: RequestWithCorrelationId,
    principal: AuthenticatedStaffPrincipal,
    rawCourseId: string,
    rawBody: unknown,
  ): Promise<CourseResponseDto> {
    if (principal.role !== 'DIRECTOR') {
      throw new ApiHttpException({
        statusCode: 403,
        errorCode: 'FORBIDDEN_ROLE',
        message: 'Only DIRECTOR is permitted to update course tariffs (updateCoursePrice)',
      });
    }

    const idempotencyKey = requireIdempotencyKeyHeader(req);
    const courseId = assertValidUuid(rawCourseId, 'course_id');
    const obj = assertPlainObject(rawBody, [
      'new_fee_uzs',
      'effective_from',
      'group_id',
      'reason',
      'expected_version',
      'recalculate_existing_invoices',
    ]);

    if (
      parseOptionalStrictBoolean(
        obj.recalculate_existing_invoices,
        'recalculate_existing_invoices',
        false,
      )
    ) {
      throw new ApiHttpException({
        statusCode: 403,
        errorCode: 'POLICY_DECISION_NOT_CONFIRMED',
        message:
          'Retroactive recalculation of already issued invoices on tariff update is forbidden; past invoice snapshots are immutable (T07.01)',
      });
    }

    const newFeeUzs = parseNonNegativeMoneyUzs(obj.new_fee_uzs, 'new_fee_uzs');
    const effectiveFrom = validateIsoDate(obj.effective_from, 'effective_from');
    const groupId =
      obj.group_id !== undefined && obj.group_id !== null
        ? assertValidUuid(obj.group_id, 'group_id')
        : null;
    const expectedVersion = resolveExpectedVersion(req, obj.expected_version);

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
    const todayCenterDate = formatCenterLocalDate(now, this.config.centerTimezone);
    const requestId = req.requestId ?? resolveRequestId(req.headers['x-request-id']);

    const idemOutcome = await executeIdempotentOperation<CourseResponseDto>(
      this.databaseService,
      {
        centerId: principal.centerId,
        actorStaffId: principal.staffId,
        operationType: 'UPDATE_COURSE_PRICE',
        idempotencyKey,
        requestPayload: {
          course_id: courseId,
          group_id: groupId,
          new_fee_uzs: newFeeUzs.toString(10),
          effective_from: effectiveFrom,
          reason,
          expected_version: expectedVersion,
        },
        handler: async (tx) => {
          const courseRes = await tx.query<{
            id: string;
            name: string;
            default_monthly_fee_uzs: string;
            default_lessons_per_cycle: number;
            status: 'ACTIVE' | 'ARCHIVED';
            version: number;
          }>(
            `SELECT "id"::text AS id,
                    "name",
                    "default_monthly_fee_uzs"::text AS default_monthly_fee_uzs,
                    "default_lessons_per_cycle",
                    "status"::text AS status,
                    "version"
               FROM "courses"
              WHERE "id" = $1::uuid
                AND "center_id" = $2::uuid
              FOR UPDATE`,
            [courseId, principal.centerId],
          );

          const beforeCourse = courseRes.rows[0];
          if (!beforeCourse) {
            throw new ApiHttpException({
              statusCode: 404,
              errorCode: 'NOT_FOUND',
              message: 'Course not found in this center',
            });
          }

          let previousFeeUzs = BigInt(beforeCourse.default_monthly_fee_uzs);
          let targetVersionSnapshot = Number(beforeCourse.version) + 1;

          if (groupId !== null) {
            const grpRes = await tx.query<{
              id: string;
              course_id: string;
              current_fee_uzs: string;
              version: number;
            }>(
              `SELECT "id"::text AS id,
                      "course_id"::text AS course_id,
                      "current_fee_uzs"::text AS current_fee_uzs,
                      "version"
                 FROM "course_groups"
                WHERE "id" = $1::uuid
                  AND "center_id" = $2::uuid
                FOR UPDATE`,
              [groupId, principal.centerId],
            );
            const grp = grpRes.rows[0];
            if (!grp || grp.course_id !== courseId) {
              throw new ApiHttpException({
                statusCode: 404,
                errorCode: 'NOT_FOUND',
                message: 'Specified group_id not found under this course in this center',
              });
            }
            previousFeeUzs = BigInt(grp.current_fee_uzs);
            const nextGroupFee =
              effectiveFrom <= todayCenterDate ? newFeeUzs : BigInt(grp.current_fee_uzs);
            const updatedGroup = await executeOptimisticUpdate<{ id: string; version: number }>(tx, {
              tableName: 'course_groups',
              entityName: 'CourseGroup',
              id: groupId,
              centerId: principal.centerId,
              expectedVersion: Number(grp.version),
              setClauseSql: `"current_fee_uzs" = $4::bigint`,
              additionalValues: [nextGroupFee.toString(10)],
            });
            targetVersionSnapshot = Number(updatedGroup.version);
          }

          // For course-level update: only overwrite default_monthly_fee_uzs immediately if effective_from <= todayCenterDate.
          // If effective_from > todayCenterDate, keep default_monthly_fee_uzs at the current fee so future effective prices
          // do not become today's price prematurely (07.01)!
          const nextCourseImmediateFee =
            groupId === null && effectiveFrom <= todayCenterDate
              ? newFeeUzs
              : BigInt(beforeCourse.default_monthly_fee_uzs);

          const updatedCourse = await executeOptimisticUpdate<{
            id: string;
            name: string;
            default_monthly_fee_uzs: string;
            default_lessons_per_cycle: number;
            status: 'ACTIVE' | 'ARCHIVED';
            version: number;
          }>(tx, {
            tableName: 'courses',
            entityName: 'Course',
            id: courseId,
            centerId: principal.centerId,
            expectedVersion,
            setClauseSql: `"default_monthly_fee_uzs" = $4::bigint`,
            additionalValues: [nextCourseImmediateFee.toString(10)],
          });

          if (groupId === null) {
            targetVersionSnapshot = Number(updatedCourse.version);
          }

          const priceHistoryId = crypto.randomUUID();
          await tx.query(
            `INSERT INTO "course_price_history" (
               "id", "center_id", "course_id", "group_id",
               "previous_fee_uzs", "new_fee_uzs", "effective_from",
               "changed_by_staff_id", "change_reason", "target_version_snapshot", "created_at"
             ) VALUES (
               $1::uuid, $2::uuid, $3::uuid, $4::uuid,
               $5::bigint, $6::bigint, $7::date,
               $8::uuid, $9, $10::int, $11::timestamptz
             )`,
            [
              priceHistoryId,
              principal.centerId,
              courseId,
              groupId,
              previousFeeUzs.toString(10),
              newFeeUzs.toString(10),
              effectiveFrom,
              principal.staffId,
              reason ?? 'TARIFF_SCHEDULE_UPDATE',
              targetVersionSnapshot,
              now.toISOString(),
            ],
          );

          await tx.query(
            `INSERT INTO "audit_logs" (
               "id", "center_id", "actor_type", "actor_id", "actor_role",
               "action", "entity_type", "entity_id", "severity",
               "before_redacted_json", "after_redacted_json", "request_id", "created_at"
             ) VALUES (
               $1::uuid, $2::uuid, 'STAFF', $3::uuid, $4,
               'COURSE_PRICE_UPDATED', 'Course', $5::uuid, 'INFO',
               $6::jsonb, $7::jsonb, $8, $9::timestamptz
             )`,
            [
              crypto.randomUUID(),
              principal.centerId,
              principal.staffId,
              principal.role,
              courseId,
              JSON.stringify({
                course_id: courseId,
                group_id: groupId,
                previous_fee_uzs: previousFeeUzs.toString(10),
                version: Number(beforeCourse.version),
              }),
              JSON.stringify({
                course_id: courseId,
                group_id: groupId,
                price_history_id: priceHistoryId,
                previous_fee_uzs: previousFeeUzs.toString(10),
                new_fee_uzs: newFeeUzs.toString(10),
                effective_from: effectiveFrom,
                reason: reason ?? 'TARIFF_SCHEDULE_UPDATE',
                version: Number(updatedCourse.version),
              }),
              requestId,
              now.toISOString(),
            ],
          );

          const body = await this.buildCourseResponse(
            tx,
            principal.centerId,
            updatedCourse,
            todayCenterDate,
          );
          return {
            statusCode: 200,
            body,
          };
        },
      },
    );

    return idemOutcome.body;
  }
}
