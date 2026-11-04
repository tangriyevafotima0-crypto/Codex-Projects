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
import { executeOptimisticUpdate } from '../database/transaction';
import { parseOptionalStrictBoolean } from '../students/normalization';
import { AcademicAccessService } from './academic-access.service';

export interface SubstituteAssignmentResponseDto {
  readonly assignment_id: string;
  readonly lesson_id: string;
  readonly original_teacher_id: string;
  readonly substitute_teacher_id: string;
  readonly pay_recipient_teacher_id: string;
  readonly primary_teacher_snapshot_id: string;
  readonly status: 'ACTIVE' | 'REVOKED';
  readonly reason: string;
  readonly revoke_reason: string | null;
  readonly revoked_at_utc: string | null;
  readonly lesson_version: number;
  readonly version: number;
}

@Injectable()
export class SubstitutionsService {
  constructor(
    @Inject(API_CONFIG_TOKEN) private readonly config: ApiEnvConfig,
    @Inject(DatabaseService) private readonly databaseService: DatabaseService,
    @Inject(ClockService) private readonly clock: ClockService,
    @Inject(AcademicAccessService) private readonly academicAccess: AcademicAccessService,
  ) {}

  public async assignSingleLessonSubstitute(
    req: RequestWithCorrelationId,
    principal: AuthenticatedStaffPrincipal,
    rawLessonId: string,
    rawBody: unknown,
  ): Promise<SubstituteAssignmentResponseDto> {
    const idempotencyKey = requireIdempotencyKeyHeader(req);
    const lessonId = assertValidUuid(rawLessonId, 'lesson_id');
    const obj = assertPlainObject(rawBody, [
      'substitute_teacher_id',
      'reason',
      'expected_version',
      'debug_fail_after_assignment_insert',
    ]);

    const substituteTeacherId = assertValidUuid(
      obj.substitute_teacher_id,
      'substitute_teacher_id',
    );
    const reason = typeof obj.reason === 'string' ? obj.reason.trim() : '';
    if (reason.length < 3 || reason.length > 255) {
      throw new ApiHttpException({
        statusCode: 400,
        errorCode: 'VALIDATION_ERROR',
        message: 'reason must be between 3 and 255 characters',
      });
    }
    const expectedVersion = resolveExpectedVersion(req, obj.expected_version);
    const debugFail =
      this.config.nodeEnv === 'test' &&
      parseOptionalStrictBoolean(
        obj.debug_fail_after_assignment_insert,
        'debug_fail_after_assignment_insert',
        false,
      );
    const now = this.clock.now();
    const requestId = req.requestId ?? resolveRequestId(req.headers['x-request-id']);

    const idemOutcome = await executeIdempotentOperation<SubstituteAssignmentResponseDto>(
      this.databaseService,
      {
        centerId: principal.centerId,
        actorStaffId: principal.staffId,
        operationType: 'ASSIGN_SINGLE_LESSON_SUBSTITUTE',
        idempotencyKey,
        requestPayload: {
          lesson_id: lessonId,
          substitute_teacher_id: substituteTeacherId,
          reason,
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
              message:
                'Completed lesson historical pay_recipient_teacher_id snapshot cannot be reassigned without confirmed payroll adjustment policy (D11)',
            });
          }
          if (lessonCtx.status !== 'SCHEDULED') {
            throw new ApiHttpException({
              statusCode: 422,
              errorCode: 'VALIDATION_ERROR',
              message: `Substitute teacher can only be assigned to a SCHEDULED lesson (got ${lessonCtx.status})`,
            });
          }

          // Verify replacement teacher is an ACTIVE TEACHER in the same center
          await this.academicAccess.verifyActiveTeacherInCenter(
            tx,
            principal.centerId,
            substituteTeacherId,
            'substitute_teacher_id',
            true,
          );

          if (substituteTeacherId === lessonCtx.primary_teacher_snapshot_id) {
            throw new ApiHttpException({
              statusCode: 422,
              errorCode: 'VALIDATION_ERROR',
              message: 'substitute_teacher_id must be distinct from the lesson original primary teacher',
            });
          }

          // Check if the replacement teacher has an overlapping SCHEDULED/COMPLETED lesson in the center
          const conflictRes = await tx.query<{ id: string }>(
            `SELECT "id"::text AS id
               FROM "lesson_occurrences"
              WHERE "center_id" = $1::uuid
                AND "id" <> $2::uuid
                AND "pay_recipient_teacher_id" = $3::uuid
                AND "status" IN ('SCHEDULED', 'COMPLETED')
                AND "starts_at_utc" < $5::timestamptz
                AND "ends_at_utc" > $4::timestamptz
              LIMIT 1`,
            [
              principal.centerId,
              lessonId,
              substituteTeacherId,
              lessonCtx.starts_at_utc.toISOString(),
              lessonCtx.ends_at_utc.toISOString(),
            ],
          );
          if (conflictRes.rows[0]) {
            throw new ApiHttpException({
              statusCode: 409,
              errorCode: 'VERSION_CONFLICT',
              message: `Substitute teacher ${substituteTeacherId} already has an overlapping lesson (${conflictRes.rows[0].id}) during this time window`,
            });
          }

          // Update lesson_occurrences.pay_recipient_teacher_id with optimistic expectedVersion check first!
          // Concurrent substitute assignments on the same lesson serialize on FOR UPDATE OF lo and
          // increment lesson_occurrences.version so only 1 concurrent caller wins!
          const updatedLesson = await executeOptimisticUpdate<{
            id: string;
            primary_teacher_snapshot_id: string;
            pay_recipient_teacher_id: string;
            version: number;
          }>(tx, {
            tableName: 'lesson_occurrences',
            entityName: 'LessonOccurrence',
            id: lessonId,
            centerId: principal.centerId,
            expectedVersion,
            setClauseSql: `"pay_recipient_teacher_id" = $4::uuid`,
            additionalValues: [substituteTeacherId],
          });

          // If a previous ACTIVE substitute assignment existed (when caller supplied the updated lesson expected_version),
          // mark it REVOKED ('REPLACED_BY_NEW_SUBSTITUTE') before inserting the new active row.
          if (lessonCtx.active_substitute_assignment_id !== null) {
            await tx.query(
              `UPDATE "substitute_assignments"
                  SET "status" = 'REVOKED',
                      "revoked_at" = $3::timestamptz,
                      "revoke_reason" = 'REPLACED_BY_NEW_SUBSTITUTE',
                      "version" = "version" + 1,
                      "updated_at" = $3::timestamptz
                WHERE "id" = $1::uuid
                  AND "center_id" = $2::uuid`,
              [lessonCtx.active_substitute_assignment_id, principal.centerId, now.toISOString()],
            );
          }

          const assignmentId = crypto.randomUUID();
          const subIns = await tx.query<{
            id: string;
            lesson_id: string;
            original_teacher_id: string;
            substitute_teacher_id: string;
            status: 'ACTIVE' | 'REVOKED';
            reason: string;
            revoke_reason: string | null;
            revoked_at: Date | null;
            version: number;
          }>(
            `INSERT INTO "substitute_assignments" (
               "id", "center_id", "lesson_id",
               "original_teacher_id", "substitute_teacher_id", "assigned_by_admin_id",
               "reason", "status", "pay_share_policy_snapshot",
               "version", "created_at", "updated_at"
             ) VALUES (
               $1::uuid, $2::uuid, $3::uuid,
               $4::uuid, $5::uuid, $6::uuid,
               $7, 'ACTIVE', 'PER_LESSON_SUBSTITUTE',
               1, $8::timestamptz, $8::timestamptz
             )
             RETURNING "id"::text AS id,
                       "lesson_id"::text AS lesson_id,
                       "original_teacher_id"::text AS original_teacher_id,
                       "substitute_teacher_id"::text AS substitute_teacher_id,
                       "status"::text AS status,
                       "reason",
                       "revoke_reason",
                       "revoked_at",
                       "version"`,
            [
              assignmentId,
              principal.centerId,
              lessonId,
              lessonCtx.primary_teacher_snapshot_id,
              substituteTeacherId,
              principal.staffId,
              reason,
              now.toISOString(),
            ],
          );

          if (debugFail) {
            throw new Error('INJECTED_FAULT_AFTER_SUBSTITUTE_ASSIGNMENT_INSERT');
          }

          await tx.query(
            `INSERT INTO "audit_logs" (
               "id", "center_id", "actor_type", "actor_id", "actor_role",
               "action", "entity_type", "entity_id", "severity",
               "before_redacted_json", "after_redacted_json", "request_id", "created_at"
             ) VALUES (
               $1::uuid, $2::uuid, 'STAFF', $3::uuid, $4,
               'LESSON_SUBSTITUTE_ASSIGNED', 'SubstituteAssignment', $5::uuid, 'INFO',
               $6::jsonb, $7::jsonb, $8, $9::timestamptz
             )`,
            [
              crypto.randomUUID(),
              principal.centerId,
              principal.staffId,
              principal.role,
              assignmentId,
              JSON.stringify({
                lesson_id: lessonId,
                previous_pay_recipient_teacher_id: lessonCtx.pay_recipient_teacher_id,
                lesson_version: lessonCtx.version,
              }),
              JSON.stringify({
                assignment_id: assignmentId,
                lesson_id: lessonId,
                original_teacher_id: lessonCtx.primary_teacher_snapshot_id,
                substitute_teacher_id: substituteTeacherId,
                pay_recipient_teacher_id: updatedLesson.pay_recipient_teacher_id,
                reason,
                lesson_version: Number(updatedLesson.version),
              }),
              requestId,
              now.toISOString(),
            ],
          );

          const createdSub = subIns.rows[0];
          return {
            statusCode: 200,
            body: Object.freeze({
              assignment_id: createdSub.id,
              lesson_id: createdSub.lesson_id,
              original_teacher_id: createdSub.original_teacher_id,
              substitute_teacher_id: createdSub.substitute_teacher_id,
              pay_recipient_teacher_id: updatedLesson.pay_recipient_teacher_id,
              primary_teacher_snapshot_id: updatedLesson.primary_teacher_snapshot_id,
              status: createdSub.status,
              reason: createdSub.reason,
              revoke_reason: createdSub.revoke_reason ?? null,
              revoked_at_utc: createdSub.revoked_at
                ? new Date(createdSub.revoked_at).toISOString()
                : null,
              lesson_version: Number(updatedLesson.version),
              version: Number(createdSub.version),
            }),
          };
        },
      },
    );

    return idemOutcome.body;
  }

  public async revokeSingleLessonSubstitute(
    req: RequestWithCorrelationId,
    principal: AuthenticatedStaffPrincipal,
    rawLessonId: string,
    rawBody: unknown,
  ): Promise<SubstituteAssignmentResponseDto> {
    const idempotencyKey = requireIdempotencyKeyHeader(req);
    const lessonId = assertValidUuid(rawLessonId, 'lesson_id');
    const obj = assertPlainObject(rawBody, ['reason', 'expected_version']);

    const reason = typeof obj.reason === 'string' ? obj.reason.trim() : '';
    if (reason.length < 3 || reason.length > 255) {
      throw new ApiHttpException({
        statusCode: 400,
        errorCode: 'VALIDATION_ERROR',
        message: 'reason must be between 3 and 255 characters',
      });
    }
    const expectedVersion = resolveExpectedVersion(req, obj.expected_version);
    const now = this.clock.now();
    const requestId = req.requestId ?? resolveRequestId(req.headers['x-request-id']);

    const idemOutcome = await executeIdempotentOperation<SubstituteAssignmentResponseDto>(
      this.databaseService,
      {
        centerId: principal.centerId,
        actorStaffId: principal.staffId,
        operationType: 'REVOKE_SINGLE_LESSON_SUBSTITUTE',
        idempotencyKey,
        requestPayload: {
          lesson_id: lessonId,
          reason,
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
              message:
                'Completed lesson historical substitute pay recipient snapshot cannot be retroactively revoked',
            });
          }

          if (!lessonCtx.active_substitute_assignment_id) {
            throw new ApiHttpException({
              statusCode: 404,
              errorCode: 'NOT_FOUND',
              message: 'No active substitute teacher assignment found for this lesson occurrence',
            });
          }

          const updatedLesson = await executeOptimisticUpdate<{
            id: string;
            primary_teacher_snapshot_id: string;
            pay_recipient_teacher_id: string;
            version: number;
          }>(tx, {
            tableName: 'lesson_occurrences',
            entityName: 'LessonOccurrence',
            id: lessonId,
            centerId: principal.centerId,
            expectedVersion,
            setClauseSql: `"pay_recipient_teacher_id" = "primary_teacher_snapshot_id"`,
            additionalValues: [],
          });

          const subUpd = await tx.query<{
            id: string;
            lesson_id: string;
            original_teacher_id: string;
            substitute_teacher_id: string;
            status: 'ACTIVE' | 'REVOKED';
            reason: string;
            revoke_reason: string | null;
            revoked_at: Date;
            version: number;
          }>(
            `UPDATE "substitute_assignments"
                SET "status" = 'REVOKED',
                    "revoked_at" = $3::timestamptz,
                    "revoke_reason" = $4,
                    "version" = "version" + 1,
                    "updated_at" = $3::timestamptz
              WHERE "id" = $1::uuid
                AND "center_id" = $2::uuid
            RETURNING "id"::text AS id,
                      "lesson_id"::text AS lesson_id,
                      "original_teacher_id"::text AS original_teacher_id,
                      "substitute_teacher_id"::text AS substitute_teacher_id,
                      "status"::text AS status,
                      "reason",
                      "revoke_reason",
                      "revoked_at",
                      "version"`,
            [lessonCtx.active_substitute_assignment_id, principal.centerId, now.toISOString(), reason],
          );

          const revokedSub = subUpd.rows[0];

          await tx.query(
            `INSERT INTO "audit_logs" (
               "id", "center_id", "actor_type", "actor_id", "actor_role",
               "action", "entity_type", "entity_id", "severity",
               "before_redacted_json", "after_redacted_json", "request_id", "created_at"
             ) VALUES (
               $1::uuid, $2::uuid, 'STAFF', $3::uuid, $4,
               'LESSON_SUBSTITUTE_REVOKED', 'SubstituteAssignment', $5::uuid, 'WARN',
               $6::jsonb, $7::jsonb, $8, $9::timestamptz
             )`,
            [
              crypto.randomUUID(),
              principal.centerId,
              principal.staffId,
              principal.role,
              revokedSub.id,
              JSON.stringify({
                assignment_id: revokedSub.id,
                lesson_id: lessonId,
                substitute_teacher_id: revokedSub.substitute_teacher_id,
                status: 'ACTIVE',
                lesson_version: lessonCtx.version,
              }),
              JSON.stringify({
                assignment_id: revokedSub.id,
                lesson_id: lessonId,
                restored_pay_recipient_teacher_id: updatedLesson.pay_recipient_teacher_id,
                status: 'REVOKED',
                revoke_reason: reason,
                lesson_version: Number(updatedLesson.version),
              }),
              requestId,
              now.toISOString(),
            ],
          );

          return {
            statusCode: 200,
            body: Object.freeze({
              assignment_id: revokedSub.id,
              lesson_id: revokedSub.lesson_id,
              original_teacher_id: revokedSub.original_teacher_id,
              substitute_teacher_id: revokedSub.substitute_teacher_id,
              pay_recipient_teacher_id: updatedLesson.pay_recipient_teacher_id,
              primary_teacher_snapshot_id: updatedLesson.primary_teacher_snapshot_id,
              status: revokedSub.status,
              reason: revokedSub.reason,
              revoke_reason: revokedSub.revoke_reason ?? null,
              revoked_at_utc: new Date(revokedSub.revoked_at).toISOString(),
              lesson_version: Number(updatedLesson.version),
              version: Number(revokedSub.version),
            }),
          };
        },
      },
    );

    return idemOutcome.body;
  }
}
