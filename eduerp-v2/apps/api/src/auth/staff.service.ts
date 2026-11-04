import { Inject, Injectable } from '@nestjs/common';
import type { BillingMode, StaffRole } from '@eduerp/contracts';
import * as crypto from 'node:crypto';
import { ApiEnvConfig } from '../config/env';
import { RequestWithCorrelationId, resolveRequestId } from '../common/request-id.middleware';
import { DatabaseService } from '../database/database.service';
import { executeIdempotentOperation } from '../database/idempotency';
import { executeOptimisticUpdate, runInTransaction } from '../database/transaction';
import { API_CONFIG_TOKEN } from '../health/health.controller';
import { ApiHttpException } from './auth.errors';
import { ClockService } from './clock.service';
import { hashPassword } from './password';
import { AuthenticatedStaffPrincipal } from './permissions.guard';
import { StaffUserResponseDto } from './auth.service';
import {
  assertValidUuid,
  requireIdempotencyKeyHeader,
  validateCreateStaffRequest,
  validateRevokeSessionsRequest,
  validateUpdateStaffStatusRequest,
} from './validation';

export interface StaffUserListResponseDto {
  readonly items: readonly StaffUserResponseDto[];
  readonly next_cursor: string | null;
}

export interface RevokeStaffSessionsResponseDto {
  readonly staff_id: string;
  readonly revoked_sessions_count: number;
  readonly revoked_at_utc: string;
}

export interface SafeTeacherStudentViewDto {
  readonly student_id: string;
  readonly enrollment_id: string;
  readonly student_code: string;
  readonly full_name: string;
  readonly enrollment_status: 'TRIAL' | 'ACTIVE';
}

export interface SafeGroupRosterResponseDto {
  readonly group_id: string;
  readonly name: string;
  readonly primary_teacher_id: string;
  readonly billing_mode: BillingMode;
  readonly lessons_per_cycle: number;
  readonly roster: readonly SafeTeacherStudentViewDto[];
  readonly version: number;
}

function mapStaffRowToSafeDto(row: {
  id: string;
  full_name: string;
  login_username: string;
  role: StaffRole;
  status: 'ACTIVE' | 'DEACTIVATED';
  version: number;
}): StaffUserResponseDto {
  return Object.freeze({
    id: row.id,
    full_name: row.full_name,
    login_username: row.login_username,
    role: row.role,
    status: row.status,
    version: Number(row.version),
  });
}

@Injectable()
export class StaffService {
  constructor(
    @Inject(API_CONFIG_TOKEN) private readonly config: ApiEnvConfig,
    @Inject(DatabaseService) private readonly databaseService: DatabaseService,
    @Inject(ClockService) private readonly clock: ClockService,
  ) {}

  public async listStaffUsers(
    principal: AuthenticatedStaffPrincipal,
    query: { cursor?: string; limit?: string },
  ): Promise<StaffUserListResponseDto> {
    let limit = 50;
    if (query.limit !== undefined) {
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

    const res = await this.databaseService.query<{
      id: string;
      full_name: string;
      login_username: string;
      role: StaffRole;
      status: 'ACTIVE' | 'DEACTIVATED';
      version: number;
    }>(
      `SELECT "id"::text AS id,
              "full_name",
              "login_username",
              "role"::text AS role,
              "status"::text AS status,
              "version"
         FROM "staff_users"
        WHERE "center_id" = $1::uuid
          AND ($2::uuid IS NULL OR "id" > $2::uuid)
        ORDER BY "id" ASC
        LIMIT $3::int`,
      [principal.centerId, cursorUuid, limit + 1],
    );

    const hasMore = res.rows.length > limit;
    const slice = hasMore ? res.rows.slice(0, limit) : res.rows;
    const nextCursor = hasMore ? slice[slice.length - 1]?.id ?? null : null;

    return {
      items: slice.map(mapStaffRowToSafeDto),
      next_cursor: nextCursor,
    };
  }

  public async createStaffUser(
    req: RequestWithCorrelationId,
    principal: AuthenticatedStaffPrincipal,
    rawBody: unknown,
  ): Promise<StaffUserResponseDto> {
    const idempotencyKey = requireIdempotencyKeyHeader(req);
    const dto = validateCreateStaffRequest(rawBody);
    const requestId = req.requestId ?? resolveRequestId(req.headers['x-request-id']);
    const now = this.clock.now();

    // OWNER-20261104-01: Director creates all staff roles (DIRECTOR, ADMIN, TEACHER);
    // Admin creates TEACHER only; Teacher is rejected by PermissionsGuard + service check.
    if (principal.role === 'ADMIN' && dto.role !== 'TEACHER') {
      throw new ApiHttpException({
        statusCode: 403,
        errorCode: 'FORBIDDEN_ROLE',
        message: 'ADMIN role is only permitted to create TEACHER staff accounts (OWNER-20261104-01)',
      });
    }
    if (principal.role !== 'DIRECTOR' && principal.role !== 'ADMIN') {
      throw new ApiHttpException({
        statusCode: 403,
        errorCode: 'FORBIDDEN_ROLE',
        message: 'Only DIRECTOR or ADMIN may create staff accounts',
      });
    }

    const passwordHash = await hashPassword(dto.initialPassword);

    const idemOutcome = await executeIdempotentOperation<StaffUserResponseDto>(
      this.databaseService,
      {
        centerId: principal.centerId,
        actorStaffId: principal.staffId,
        operationType: 'CREATE_STAFF_USER',
        idempotencyKey,
        requestPayload: {
          full_name: dto.fullName,
          login_username: dto.loginUsername,
          role: dto.role,
          has_phone: dto.phoneE164 !== null,
        },
        handler: async (tx) => {
          const staffId = crypto.randomUUID();
          try {
            const ins = await tx.query<{
              id: string;
              full_name: string;
              login_username: string;
              role: StaffRole;
              status: 'ACTIVE' | 'DEACTIVATED';
              version: number;
            }>(
              `INSERT INTO "staff_users" (
                 "id",
                 "center_id",
                 "role",
                 "full_name",
                 "login_username",
                 "phone_e164",
                 "password_hash",
                 "must_change_password",
                 "status",
                 "version",
                 "created_at",
                 "updated_at"
               ) VALUES (
                 $1::uuid,
                 $2::uuid,
                 $3,
                 $4,
                 $5,
                 $6,
                 $7,
                 TRUE,
                 'ACTIVE',
                 1,
                 $8::timestamptz,
                 $8::timestamptz
               )
               RETURNING "id"::text AS id, "full_name", "login_username", "role"::text AS role, "status"::text AS status, "version"`,
              [
                staffId,
                principal.centerId,
                dto.role,
                dto.fullName,
                dto.loginUsername,
                dto.phoneE164,
                passwordHash,
                now.toISOString(),
              ],
            );

            const created = ins.rows[0];

            await tx.query(
              `INSERT INTO "audit_logs" (
                 "id", "center_id", "actor_type", "actor_id", "actor_role",
                 "action", "entity_type", "entity_id", "severity",
                 "before_redacted_json", "after_redacted_json", "request_id", "created_at"
               ) VALUES (
                 $1::uuid, $2::uuid, 'STAFF', $3::uuid, $4,
                 'STAFF_CREATED', 'StaffUser', $5::uuid, 'INFO',
                 NULL, $6::jsonb, $7, $8::timestamptz
               )`,
              [
                crypto.randomUUID(),
                principal.centerId,
                principal.staffId,
                principal.role,
                created.id,
                JSON.stringify({
                  id: created.id,
                  login_username: created.login_username,
                  role: created.role,
                  status: created.status,
                  must_change_password: true,
                }),
                requestId,
                now.toISOString(),
              ],
            );

            return {
              statusCode: 201,
              body: mapStaffRowToSafeDto(created),
            };
          } catch (err: unknown) {
            if ((err as { code?: string }).code === '23505') {
              throw new ApiHttpException({
                statusCode: 409,
                errorCode: 'VALIDATION_ERROR',
                message: `login_username '${dto.loginUsername}' already exists in this center`,
              });
            }
            throw err;
          }
        },
      },
    );

    return idemOutcome.body;
  }

  public async updateStaffStatus(
    req: RequestWithCorrelationId,
    principal: AuthenticatedStaffPrincipal,
    rawTargetStaffId: string,
    rawBody: unknown,
  ): Promise<StaffUserResponseDto> {
    const idempotencyKey = requireIdempotencyKeyHeader(req);
    const targetStaffId = assertValidUuid(rawTargetStaffId, 'staff_id');
    const dto = validateUpdateStaffStatusRequest(req, rawBody);
    const requestId = req.requestId ?? resolveRequestId(req.headers['x-request-id']);
    const now = this.clock.now();

    const idemOutcome = await executeIdempotentOperation<StaffUserResponseDto>(
      this.databaseService,
      {
        centerId: principal.centerId,
        actorStaffId: principal.staffId,
        operationType: 'UPDATE_STAFF_STATUS',
        idempotencyKey,
        requestPayload: {
          target_staff_id: targetStaffId,
          status: dto.status,
          role: dto.role,
          reason: dto.reason,
          expected_version: dto.expectedVersion,
        },
        handler: async (tx) => {
          const existingRes = await tx.query<{
            id: string;
            full_name: string;
            login_username: string;
            role: StaffRole;
            status: 'ACTIVE' | 'DEACTIVATED';
            version: number;
          }>(
            `SELECT "id"::text AS id,
                    "full_name",
                    "login_username",
                    "role"::text AS role,
                    "status"::text AS status,
                    "version"
               FROM "staff_users"
              WHERE "id" = $1::uuid
                AND "center_id" = $2::uuid
              FOR UPDATE`,
            [targetStaffId, principal.centerId],
          );

          const before = existingRes.rows[0];
          if (!before) {
            throw new ApiHttpException({
              statusCode: 404,
              errorCode: 'NOT_FOUND',
              message: 'Target staff user not found in this center',
            });
          }

          try {
            const updated = await executeOptimisticUpdate<{
              id: string;
              full_name: string;
              login_username: string;
              role: StaffRole;
              status: 'ACTIVE' | 'DEACTIVATED';
              version: number;
            }>(tx, {
              tableName: 'staff_users',
              entityName: 'StaffUser',
              id: targetStaffId,
              centerId: principal.centerId,
              expectedVersion: dto.expectedVersion,
              setClauseSql: `"status" = $4, "role" = $5`,
              additionalValues: [dto.status, dto.role],
            });

            // Atomically revoke all active sessions when staff is deactivated or role changes (T05.03)
            if (dto.status === 'DEACTIVATED' || dto.role !== before.role) {
              const revokeReason =
                dto.status === 'DEACTIVATED' ? 'STAFF_DEACTIVATED' : 'STAFF_ROLE_CHANGED';
              await tx.query(
                `UPDATE "staff_sessions"
                    SET "revoked_at" = $3::timestamptz,
                        "revoke_reason" = $4,
                        "version" = "version" + 1,
                        "updated_at" = $3::timestamptz
                  WHERE "center_id" = $1::uuid
                    AND "staff_id" = $2::uuid
                    AND "revoked_at" IS NULL`,
                [principal.centerId, targetStaffId, now.toISOString(), revokeReason],
              );
            }

            await tx.query(
              `INSERT INTO "audit_logs" (
                 "id", "center_id", "actor_type", "actor_id", "actor_role",
                 "action", "entity_type", "entity_id", "severity",
                 "before_redacted_json", "after_redacted_json", "request_id", "created_at"
               ) VALUES (
                 $1::uuid, $2::uuid, 'STAFF', $3::uuid, $4,
                 'STAFF_STATUS_OR_ROLE_UPDATED', 'StaffUser', $5::uuid, 'WARN',
                 $6::jsonb, $7::jsonb, $8, $9::timestamptz
               )`,
              [
                crypto.randomUUID(),
                principal.centerId,
                principal.staffId,
                principal.role,
                targetStaffId,
                JSON.stringify({
                  role: before.role,
                  status: before.status,
                  version: before.version,
                }),
                JSON.stringify({
                  role: updated.role,
                  status: updated.status,
                  version: Number(updated.version),
                  reason: dto.reason,
                }),
                requestId,
                now.toISOString(),
              ],
            );

            return {
              statusCode: 200,
              body: mapStaffRowToSafeDto(updated),
            };
          } catch (err: unknown) {
            const pgErr = err as { code?: string; message?: string };
            if (
              pgErr.code === '23514' &&
              (pgErr.message ?? '').includes('LAST_DIRECTOR_CANNOT_BE_DEACTIVATED')
            ) {
              throw new ApiHttpException({
                statusCode: 422,
                errorCode: 'LAST_DIRECTOR_CANNOT_BE_DEACTIVATED',
                message: 'Center must retain at least one ACTIVE DIRECTOR account',
              });
            }
            if (pgErr.code === '55P03' || pgErr.code === '40P01') {
              throw new ApiHttpException({
                statusCode: 409,
                errorCode: 'LAST_DIRECTOR_CANNOT_BE_DEACTIVATED',
                message: 'Concurrent director status modification rejected to preserve at least one ACTIVE DIRECTOR',
              });
            }
            throw err;
          }
        },
      },
    );

    return idemOutcome.body;
  }

  public async revokeStaffSessions(
    req: RequestWithCorrelationId,
    principal: AuthenticatedStaffPrincipal,
    rawTargetStaffId: string,
    rawBody: unknown,
  ): Promise<RevokeStaffSessionsResponseDto> {
    const idempotencyKey = requireIdempotencyKeyHeader(req);
    const targetStaffId = assertValidUuid(rawTargetStaffId, 'staff_id');
    const dto = validateRevokeSessionsRequest(rawBody);
    const requestId = req.requestId ?? resolveRequestId(req.headers['x-request-id']);
    const now = this.clock.now();

    const idemOutcome = await executeIdempotentOperation<RevokeStaffSessionsResponseDto>(
      this.databaseService,
      {
        centerId: principal.centerId,
        actorStaffId: principal.staffId,
        operationType: 'REVOKE_STAFF_SESSIONS',
        idempotencyKey,
        requestPayload: {
          target_staff_id: targetStaffId,
          reason: dto.reason,
        },
        handler: async (tx) => {
          const staffCheck = await tx.query<{ id: string }>(
            `SELECT "id"::text AS id
               FROM "staff_users"
              WHERE "id" = $1::uuid
                AND "center_id" = $2::uuid
              LIMIT 1`,
            [targetStaffId, principal.centerId],
          );
          if (!staffCheck.rows[0]) {
            throw new ApiHttpException({
              statusCode: 404,
              errorCode: 'NOT_FOUND',
              message: 'Target staff user not found in this center',
            });
          }

          const revokeRes = await tx.query(
            `UPDATE "staff_sessions"
                SET "revoked_at" = $3::timestamptz,
                    "revoke_reason" = $4,
                    "version" = "version" + 1,
                    "updated_at" = $3::timestamptz
              WHERE "center_id" = $1::uuid
                AND "staff_id" = $2::uuid
                AND "revoked_at" IS NULL`,
            [principal.centerId, targetStaffId, now.toISOString(), `FORCE_REVOKED:${dto.reason.slice(0, 48)}`],
          );

          const revokedCount = revokeRes.rowCount ?? 0;

          await tx.query(
            `INSERT INTO "audit_logs" (
               "id", "center_id", "actor_type", "actor_id", "actor_role",
               "action", "entity_type", "entity_id", "severity",
               "after_redacted_json", "request_id", "created_at"
             ) VALUES (
               $1::uuid, $2::uuid, 'STAFF', $3::uuid, $4,
               'STAFF_SESSIONS_FORCE_REVOKED', 'StaffUser', $5::uuid, 'WARN',
               $6::jsonb, $7, $8::timestamptz
             )`,
            [
              crypto.randomUUID(),
              principal.centerId,
              principal.staffId,
              principal.role,
              targetStaffId,
              JSON.stringify({
                target_staff_id: targetStaffId,
                revoked_sessions_count: revokedCount,
                reason: dto.reason,
              }),
              requestId,
              now.toISOString(),
            ],
          );

          return {
            statusCode: 200,
            body: {
              staff_id: targetStaffId,
              revoked_sessions_count: revokedCount,
              revoked_at_utc: now.toISOString(),
            },
          };
        },
      },
    );

    return idemOutcome.body;
  }

  public async getGroupSafeRoster(
    principal: AuthenticatedStaffPrincipal,
    rawGroupId: string,
    query: { search?: string; cursor?: string; limit?: string } = {},
  ): Promise<SafeGroupRosterResponseDto> {
    const groupId = assertValidUuid(rawGroupId, 'group_id');

    let limit = 200;
    if (query.limit !== undefined) {
      limit = Number(query.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
        throw new ApiHttpException({
          statusCode: 400,
          errorCode: 'VALIDATION_ERROR',
          message: 'limit must be an integer between 1 and 200',
        });
      }
    }

    let cursorEnrollmentId: string | null = null;
    if (query.cursor !== undefined && query.cursor !== '') {
      cursorEnrollmentId = assertValidUuid(query.cursor, 'cursor');
    }

    const searchNormalized =
      typeof query.search === 'string' && query.search.trim().length > 0
        ? `%${query.search.trim().toLowerCase()}%`
        : null;

    const groupRes = await this.databaseService.query<{
      id: string;
      name: string;
      primary_teacher_id: string;
      billing_mode: BillingMode;
      lessons_per_cycle: number;
      version: number;
    }>(
      `SELECT "id"::text AS id,
              "name",
              "primary_teacher_id"::text AS primary_teacher_id,
              "billing_mode"::text AS billing_mode,
              "lessons_per_cycle",
              "version"
         FROM "course_groups"
        WHERE "id" = $1::uuid
          AND "center_id" = $2::uuid
        LIMIT 1`,
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

    // Object-level ownership verification for TEACHER (05.02 / S2F02 / T05.02 / T05.04):
    // Teacher may only access groups where they are primary_teacher_id OR have an ACTIVE substitute assignment.
    if (principal.role === 'TEACHER' && group.primary_teacher_id !== principal.staffId) {
      const subRes = await this.databaseService.query<{ id: string }>(
        `SELECT sa."id"::text AS id
           FROM "substitute_assignments" sa
           JOIN "lesson_occurrences" lo
             ON lo."id" = sa."lesson_id"
            AND lo."center_id" = sa."center_id"
          WHERE sa."center_id" = $1::uuid
            AND lo."group_id" = $2::uuid
            AND sa."substitute_teacher_id" = $3::uuid
            AND sa."status" = 'ACTIVE'
            AND lo."status" IN ('SCHEDULED', 'COMPLETED')
          LIMIT 1`,
        [principal.centerId, groupId, principal.staffId],
      );

      if (!subRes.rows[0]) {
        throw new ApiHttpException({
          statusCode: 403,
          errorCode: 'FORBIDDEN_OBJECT_SCOPE',
          message: 'Teacher is not assigned as primary or active substitute teacher for this group',
        });
      }
    }

    // Explicit allowlist SQL projection: never selects phone_e164, guardians, invoices, or debt columns!
    const rosterRes = await this.databaseService.query<{
      student_id: string;
      enrollment_id: string;
      student_code: string;
      full_name: string;
      enrollment_status: 'TRIAL' | 'ACTIVE';
    }>(
      `SELECT s."id"::text AS student_id,
              e."id"::text AS enrollment_id,
              s."student_code" AS student_code,
              s."full_name" AS full_name,
              e."status"::text AS enrollment_status
         FROM "enrollments" e
         JOIN "students" s
           ON s."id" = e."student_id"
          AND s."center_id" = e."center_id"
        WHERE e."center_id" = $1::uuid
          AND e."group_id" = $2::uuid
          AND e."status" IN ('TRIAL', 'ACTIVE')
          AND s."status" = 'ACTIVE'
          AND ($3::uuid IS NULL OR e."id" > $3::uuid)
          AND ($4::text IS NULL OR s."normalized_name" LIKE $4 OR LOWER(s."student_code") LIKE $4)
        ORDER BY e."id" ASC
        LIMIT $5::int`,
      [principal.centerId, groupId, cursorEnrollmentId, searchNormalized, limit],
    );

    const safeRoster: SafeTeacherStudentViewDto[] = rosterRes.rows.map((r) =>
      Object.freeze({
        student_id: r.student_id,
        enrollment_id: r.enrollment_id,
        student_code: r.student_code,
        full_name: r.full_name,
        enrollment_status: r.enrollment_status,
      }),
    );

    return Object.freeze({
      group_id: group.id,
      name: group.name,
      primary_teacher_id: group.primary_teacher_id,
      billing_mode: group.billing_mode,
      lessons_per_cycle: Number(group.lessons_per_cycle),
      roster: safeRoster,
      version: Number(group.version),
    });
  }
}
