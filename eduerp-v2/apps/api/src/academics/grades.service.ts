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
import { sanitizePlainTextGradeComment, validateGradeScore } from './academic-validation';

export interface GradeEntryItemDto {
  readonly grade_entry_id: string;
  readonly lesson_id: string;
  readonly enrollment_id: string;
  readonly student_id: string;
  readonly score: number;
  readonly comment_sanitized: string | null;
  readonly recorded_by_teacher_id: string;
  readonly version: number;
  readonly updated_at_utc: string;
}

export interface GradeRevisionHistoryItemDto {
  readonly audit_id: string;
  readonly grade_entry_id: string;
  readonly lesson_id: string;
  readonly enrollment_id: string;
  readonly student_id: string;
  readonly action: 'GRADE_ENTRY_CREATED' | 'GRADE_ENTRY_UPDATED';
  readonly revision_version: number;
  readonly previous_score: number | null;
  readonly new_score: number;
  readonly previous_comment_sanitized: string | null;
  readonly new_comment_sanitized: string | null;
  readonly actor_staff_id: string | null;
  readonly actor_role: string | null;
  readonly recorded_by_teacher_id: string;
  readonly reason: string | null;
  readonly request_id: string;
  readonly created_at_utc: string;
}

export interface SubmitGradesResponseDto {
  readonly lesson_id: string;
  readonly saved_count: number;
  readonly version: number;
  readonly entries: readonly GradeEntryItemDto[];
}

export interface LessonGradesAndHistoryResponseDto {
  readonly lesson_id: string;
  readonly group_id: string;
  readonly lesson_version: number;
  readonly items: readonly GradeEntryItemDto[];
  readonly revisions: readonly GradeRevisionHistoryItemDto[];
  readonly next_cursor: string | null;
}

@Injectable()
export class GradesService {
  constructor(
    @Inject(API_CONFIG_TOKEN) private readonly config: ApiEnvConfig,
    @Inject(DatabaseService) private readonly databaseService: DatabaseService,
    @Inject(ClockService) private readonly clock: ClockService,
    @Inject(AcademicAccessService) private readonly academicAccess: AcademicAccessService,
  ) {}

  public async submitLessonGrades(
    req: RequestWithCorrelationId,
    principal: AuthenticatedStaffPrincipal,
    rawLessonId: string,
    rawBody: unknown,
  ): Promise<SubmitGradesResponseDto> {
    const idempotencyKey = requireIdempotencyKeyHeader(req);
    const lessonId = assertValidUuid(rawLessonId, 'lesson_id');
    const obj = assertPlainObject(rawBody, [
      'expected_version',
      'reason',
      'grades',
      'debug_fail_after_first_grade_write',
    ]);

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

    if (!Array.isArray(obj.grades) || obj.grades.length === 0 || obj.grades.length > 200) {
      throw new ApiHttpException({
        statusCode: 400,
        errorCode: 'VALIDATION_ERROR',
        message: 'grades must be a non-empty array of 1..200 student grade items',
      });
    }

    const seenStudentIds = new Set<string>();
    const validatedItems: Array<{
      readonly studentId: string;
      readonly enrollmentId: string | null;
      readonly score: number;
      readonly commentSanitized: string | null;
      readonly expectedGradeVersion: number | null;
    }> = [];

    for (let i = 0; i < obj.grades.length; i += 1) {
      const itemObj = assertPlainObject(
        obj.grades[i],
        ['student_id', 'enrollment_id', 'score', 'comment', 'expected_grade_version'],
      );
      const studentId = assertValidUuid(itemObj.student_id, `grades[${i}].student_id`);
      if (seenStudentIds.has(studentId)) {
        throw new ApiHttpException({
          statusCode: 400,
          errorCode: 'VALIDATION_ERROR',
          message: `Duplicate student_id (${studentId}) in grades batch at index ${i}`,
        });
      }
      seenStudentIds.add(studentId);

      const enrollmentId =
        itemObj.enrollment_id !== undefined && itemObj.enrollment_id !== null
          ? assertValidUuid(itemObj.enrollment_id, `grades[${i}].enrollment_id`)
          : null;
      const score = validateGradeScore(itemObj.score, `grades[${i}].score`);
      const commentSanitized = sanitizePlainTextGradeComment(
        itemObj.comment,
        `grades[${i}].comment`,
      );
      let expectedGradeVersion: number | null = null;
      if (itemObj.expected_grade_version !== undefined && itemObj.expected_grade_version !== null) {
        const vNum = Number(itemObj.expected_grade_version);
        if (!Number.isInteger(vNum) || vNum < 1) {
          throw new ApiHttpException({
            statusCode: 400,
            errorCode: 'VALIDATION_ERROR',
            message: `grades[${i}].expected_grade_version must be a positive integer`,
          });
        }
        expectedGradeVersion = vNum;
      }

      validatedItems.push({
        studentId,
        enrollmentId,
        score,
        commentSanitized,
        expectedGradeVersion,
      });
    }

    const debugFail =
      this.config.nodeEnv === 'test' &&
      parseOptionalStrictBoolean(
        obj.debug_fail_after_first_grade_write,
        'debug_fail_after_first_grade_write',
        false,
      );
    const now = this.clock.now();
    const requestId = req.requestId ?? resolveRequestId(req.headers['x-request-id']);

    const idemOutcome = await executeIdempotentOperation<SubmitGradesResponseDto>(
      this.databaseService,
      {
        centerId: principal.centerId,
        actorStaffId: principal.staffId,
        operationType: 'SUBMIT_LESSON_GRADES',
        idempotencyKey,
        requestPayload: {
          lesson_id: lessonId,
          expected_version: expectedVersion,
          reason,
          grades: validatedItems.map((it) => ({
            student_id: it.studentId,
            enrollment_id: it.enrollmentId,
            score: it.score,
            comment_sanitized: it.commentSanitized,
            expected_grade_version: it.expectedGradeVersion,
          })),
        },
        handler: async (tx) => {
          // 1. Verify single-lesson entitlement and lock the lesson_occurrences row FOR UPDATE
          const lessonCtx = await this.academicAccess.assertLessonAccess(tx, principal, lessonId, {
            lockLesson: true,
            forExclusiveTeacherWrite: true,
          });

          if (lessonCtx.status === 'CANCELLED_BY_CENTER' || lessonCtx.status === 'RESCHEDULED') {
            throw new ApiHttpException({
              statusCode: 422,
              errorCode: 'VALIDATION_ERROR',
              message: `Cannot submit grades for a ${lessonCtx.status} lesson occurrence`,
            });
          }

          // 2. Optimistically increment lesson_occurrences.version so concurrent grade submissions
          //    with the same expected_version serialize and only 1 winner succeeds!
          const updatedLesson = await executeOptimisticUpdate<{
            id: string;
            version: number;
          }>(tx, {
            tableName: 'lesson_occurrences',
            entityName: 'LessonOccurrence',
            id: lessonId,
            centerId: principal.centerId,
            expectedVersion,
            // The optimistic helper owns updated_at/version; keep lesson state intact.
            setClauseSql: `"status" = "status"`,
            additionalValues: [],
          });

          const recordedByTeacherId =
            principal.role === 'TEACHER'
              ? principal.staffId
              : lessonCtx.pay_recipient_teacher_id;

          const savedEntries: GradeEntryItemDto[] = [];

          for (let i = 0; i < validatedItems.length; i += 1) {
            const item = validatedItems[i];

            // Verify student enrollment lineage in lessonCtx.group_id within principal.centerId
            const enrRes = await tx.query<{
              id: string;
              student_id: string;
              group_id: string;
              status: string;
            }>(
              `SELECT e."id"::text AS id,
                      e."student_id"::text AS student_id,
                      e."group_id"::text AS group_id,
                      e."status"::text AS status
                 FROM "enrollments" e
                 JOIN "students" s
                   ON s."id" = e."student_id"
                  AND s."center_id" = e."center_id"
                WHERE e."center_id" = $1::uuid
                  AND e."group_id" = $2::uuid
                  AND e."student_id" = $3::uuid
                  AND ($4::uuid IS NULL OR e."id" = $4::uuid)
                ORDER BY
                  CASE e."status"
                    WHEN 'ACTIVE' THEN 1
                    WHEN 'TRIAL' THEN 2
                    WHEN 'FROZEN' THEN 3
                    ELSE 4
                  END ASC,
                  e."created_at" DESC
                LIMIT 1`,
              [principal.centerId, lessonCtx.group_id, item.studentId, item.enrollmentId],
            );

            const enrollment = enrRes.rows[0];
            if (!enrollment) {
              throw new ApiHttpException({
                statusCode: 422,
                errorCode: 'VALIDATION_ERROR',
                message: `Student ${item.studentId} does not have a valid enrollment in group ${lessonCtx.group_id} for this lesson`,
              });
            }

            // Check if a grade_entries row already exists for (lesson_id, student_id)
            const existingGradeRes = await tx.query<{
              id: string;
              enrollment_id: string;
              score: string;
              comment_sanitized: string | null;
              recorded_by_teacher_id: string;
              version: number;
            }>(
              `SELECT "id"::text AS id,
                      "enrollment_id"::text AS enrollment_id,
                      "score"::text AS score,
                      "comment_sanitized",
                      "recorded_by_teacher_id"::text AS recorded_by_teacher_id,
                      "version"
                 FROM "grade_entries"
                WHERE "center_id" = $1::uuid
                  AND "lesson_id" = $2::uuid
                  AND "student_id" = $3::uuid
                FOR UPDATE`,
              [principal.centerId, lessonId, item.studentId],
            );

            const existingGrade = existingGradeRes.rows[0];
            if (!existingGrade) {
              const gradeEntryId = crypto.randomUUID();
              const ins = await tx.query<{
                id: string;
                lesson_id: string;
                enrollment_id: string;
                student_id: string;
                score: string;
                comment_sanitized: string | null;
                recorded_by_teacher_id: string;
                version: number;
                updated_at: Date;
              }>(
                `INSERT INTO "grade_entries" (
                   "id", "center_id", "lesson_id", "enrollment_id", "student_id",
                   "score", "comment_sanitized", "recorded_by_teacher_id",
                   "version", "created_at", "updated_at"
                 ) VALUES (
                   $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
                   $6::numeric(5,2), $7, $8::uuid,
                   1, $9::timestamptz, $9::timestamptz
                 )
                 RETURNING "id"::text AS id,
                           "lesson_id"::text AS lesson_id,
                           "enrollment_id"::text AS enrollment_id,
                           "student_id"::text AS student_id,
                           "score"::text AS score,
                           "comment_sanitized",
                           "recorded_by_teacher_id"::text AS recorded_by_teacher_id,
                           "version",
                           "updated_at"`,
                [
                  gradeEntryId,
                  principal.centerId,
                  lessonId,
                  enrollment.id,
                  item.studentId,
                  item.score.toFixed(2),
                  item.commentSanitized,
                  recordedByTeacherId,
                  now.toISOString(),
                ],
              );

              const created = ins.rows[0];

              // Append-only grade creation revision record in canonical audit_logs (07.04)
              await tx.query(
                `INSERT INTO "audit_logs" (
                   "id", "center_id", "actor_type", "actor_id", "actor_role",
                   "action", "entity_type", "entity_id", "severity",
                   "before_redacted_json", "after_redacted_json", "request_id", "created_at"
                 ) VALUES (
                   $1::uuid, $2::uuid, 'STAFF', $3::uuid, $4,
                   'GRADE_ENTRY_CREATED', 'GradeEntry', $5::uuid, 'INFO',
                   NULL, $6::jsonb, $7, $8::timestamptz
                 )`,
                [
                  crypto.randomUUID(),
                  principal.centerId,
                  principal.staffId,
                  principal.role,
                  gradeEntryId,
                  JSON.stringify({
                    grade_entry_id: gradeEntryId,
                    lesson_id: lessonId,
                    enrollment_id: enrollment.id,
                    student_id: item.studentId,
                    revision_version: 1,
                    previous_score: null,
                    new_score: Number(created.score),
                    previous_comment_sanitized: null,
                    new_comment_sanitized: created.comment_sanitized ?? null,
                    recorded_by_teacher_id: recordedByTeacherId,
                    reason,
                    lesson_version: Number(updatedLesson.version),
                  }),
                  requestId,
                  now.toISOString(),
                ],
              );

              savedEntries.push(
                Object.freeze({
                  grade_entry_id: created.id,
                  lesson_id: created.lesson_id,
                  enrollment_id: created.enrollment_id,
                  student_id: created.student_id,
                  score: Number(created.score),
                  comment_sanitized: created.comment_sanitized ?? null,
                  recorded_by_teacher_id: created.recorded_by_teacher_id,
                  version: Number(created.version),
                  updated_at_utc: new Date(created.updated_at).toISOString(),
                }),
              );
            } else {
              const targetGradeExpectedVer =
                item.expectedGradeVersion ?? Number(existingGrade.version);
              const updatedGrade = await executeOptimisticUpdate<{
                id: string;
                lesson_id: string;
                enrollment_id: string;
                student_id: string;
                score: string;
                comment_sanitized: string | null;
                recorded_by_teacher_id: string;
                version: number;
                updated_at: Date;
              }>(tx, {
                tableName: 'grade_entries',
                entityName: 'GradeEntry',
                id: existingGrade.id,
                centerId: principal.centerId,
                expectedVersion: targetGradeExpectedVer,
                setClauseSql: `"score" = $4::numeric(5,2), "comment_sanitized" = $5, "recorded_by_teacher_id" = $6::uuid, "enrollment_id" = $7::uuid`,
                additionalValues: [
                  item.score.toFixed(2),
                  item.commentSanitized,
                  recordedByTeacherId,
                  enrollment.id,
                ],
              });

              // Append-only grade update revision record in canonical audit_logs preserving old & new values (07.04)
              await tx.query(
                `INSERT INTO "audit_logs" (
                   "id", "center_id", "actor_type", "actor_id", "actor_role",
                   "action", "entity_type", "entity_id", "severity",
                   "before_redacted_json", "after_redacted_json", "request_id", "created_at"
                 ) VALUES (
                   $1::uuid, $2::uuid, 'STAFF', $3::uuid, $4,
                   'GRADE_ENTRY_UPDATED', 'GradeEntry', $5::uuid, 'INFO',
                   $6::jsonb, $7::jsonb, $8, $9::timestamptz
                 )`,
                [
                  crypto.randomUUID(),
                  principal.centerId,
                  principal.staffId,
                  principal.role,
                  existingGrade.id,
                  JSON.stringify({
                    grade_entry_id: existingGrade.id,
                    lesson_id: lessonId,
                    enrollment_id: existingGrade.enrollment_id,
                    student_id: item.studentId,
                    score: Number(existingGrade.score),
                    comment_sanitized: existingGrade.comment_sanitized ?? null,
                    recorded_by_teacher_id: existingGrade.recorded_by_teacher_id,
                    version: Number(existingGrade.version),
                  }),
                  JSON.stringify({
                    grade_entry_id: existingGrade.id,
                    lesson_id: lessonId,
                    enrollment_id: enrollment.id,
                    student_id: item.studentId,
                    revision_version: Number(updatedGrade.version),
                    previous_score: Number(existingGrade.score),
                    new_score: Number(updatedGrade.score),
                    previous_comment_sanitized: existingGrade.comment_sanitized ?? null,
                    new_comment_sanitized: updatedGrade.comment_sanitized ?? null,
                    recorded_by_teacher_id: recordedByTeacherId,
                    reason,
                    lesson_version: Number(updatedLesson.version),
                  }),
                  requestId,
                  now.toISOString(),
                ],
              );

              savedEntries.push(
                Object.freeze({
                  grade_entry_id: updatedGrade.id,
                  lesson_id: updatedGrade.lesson_id,
                  enrollment_id: updatedGrade.enrollment_id,
                  student_id: updatedGrade.student_id,
                  score: Number(updatedGrade.score),
                  comment_sanitized: updatedGrade.comment_sanitized ?? null,
                  recorded_by_teacher_id: updatedGrade.recorded_by_teacher_id,
                  version: Number(updatedGrade.version),
                  updated_at_utc: new Date(updatedGrade.updated_at).toISOString(),
                }),
              );
            }

            if (debugFail && i === 0) {
              throw new Error('INJECTED_FAULT_AFTER_FIRST_GRADE_WRITE');
            }
          }

          return {
            statusCode: 200,
            body: Object.freeze({
              lesson_id: lessonId,
              saved_count: savedEntries.length,
              version: Number(updatedLesson.version),
              entries: Object.freeze(savedEntries),
            }),
          };
        },
      },
    );

    return idemOutcome.body;
  }

  public async listLessonGradesAndHistory(
    principal: AuthenticatedStaffPrincipal,
    rawLessonId: string,
    query: {
      student_id?: string;
      cursor?: string;
      limit?: string;
    } = {},
  ): Promise<LessonGradesAndHistoryResponseDto> {
    const lessonCtx = await this.academicAccess.assertLessonAccess(
      this.databaseService,
      principal,
      rawLessonId,
    );

    let limit = 100;
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

    const studentIdFilter =
      query.student_id !== undefined && query.student_id !== ''
        ? assertValidUuid(query.student_id, 'student_id')
        : null;

    const gradesRes = await this.databaseService.query<{
      id: string;
      lesson_id: string;
      enrollment_id: string;
      student_id: string;
      score: string;
      comment_sanitized: string | null;
      recorded_by_teacher_id: string;
      version: number;
      updated_at: Date;
    }>(
      `SELECT "id"::text AS id,
              "lesson_id"::text AS lesson_id,
              "enrollment_id"::text AS enrollment_id,
              "student_id"::text AS student_id,
              "score"::text AS score,
              "comment_sanitized",
              "recorded_by_teacher_id"::text AS recorded_by_teacher_id,
              "version",
              "updated_at"
         FROM "grade_entries"
        WHERE "center_id" = $1::uuid
          AND "lesson_id" = $2::uuid
          AND ($3::uuid IS NULL OR "student_id" = $3::uuid)
          AND ($4::uuid IS NULL OR "id" > $4::uuid)
        ORDER BY "id" ASC
        LIMIT $5::int`,
      [principal.centerId, lessonCtx.lesson_id, studentIdFilter, cursorUuid, limit + 1],
    );

    const hasMore = gradesRes.rows.length > limit;
    const slice = hasMore ? gradesRes.rows.slice(0, limit) : gradesRes.rows;
    const nextCursor = hasMore ? slice[slice.length - 1]?.id ?? null : null;

    const items: GradeEntryItemDto[] = slice.map((r) =>
      Object.freeze({
        grade_entry_id: r.id,
        lesson_id: r.lesson_id,
        enrollment_id: r.enrollment_id,
        student_id: r.student_id,
        score: Number(r.score),
        comment_sanitized: r.comment_sanitized ?? null,
        recorded_by_teacher_id: r.recorded_by_teacher_id,
        version: Number(r.version),
        updated_at_utc: new Date(r.updated_at).toISOString(),
      }),
    );

    const gradeEntryIds = items.map((g) => g.grade_entry_id);
    let revisions: GradeRevisionHistoryItemDto[] = [];
    if (gradeEntryIds.length > 0) {
      const revRes = await this.databaseService.query<{
        id: string;
        entity_id: string;
        action: 'GRADE_ENTRY_CREATED' | 'GRADE_ENTRY_UPDATED';
        actor_id: string | null;
        actor_role: string | null;
        before_redacted_json: Record<string, unknown> | null;
        after_redacted_json: Record<string, unknown>;
        request_id: string;
        created_at: Date;
      }>(
        `SELECT "id"::text AS id,
                "entity_id"::text AS entity_id,
                "action"::text AS action,
                "actor_id"::text AS actor_id,
                "actor_role"::text AS actor_role,
                "before_redacted_json",
                "after_redacted_json",
                "request_id",
                "created_at"
           FROM "audit_logs"
          WHERE "center_id" = $1::uuid
            AND "entity_type" = 'GradeEntry'
            AND "entity_id" = ANY($2::uuid[])
          ORDER BY "created_at" ASC, "id" ASC`,
        [principal.centerId, gradeEntryIds],
      );

      revisions = revRes.rows.map((rev) => {
        const after = rev.after_redacted_json ?? {};
        const before = rev.before_redacted_json ?? null;
        const prevScore =
          after.previous_score !== undefined && after.previous_score !== null
            ? Number(after.previous_score)
            : before && before.score !== undefined && before.score !== null
              ? Number(before.score)
              : null;
        const prevComment =
          after.previous_comment_sanitized !== undefined
            ? (after.previous_comment_sanitized as string | null)
            : before && before.comment_sanitized !== undefined
              ? (before.comment_sanitized as string | null)
              : null;
        return Object.freeze({
          audit_id: rev.id,
          grade_entry_id: rev.entity_id,
          lesson_id: String(after.lesson_id ?? lessonCtx.lesson_id),
          enrollment_id: String(after.enrollment_id ?? ''),
          student_id: String(after.student_id ?? ''),
          action: rev.action,
          revision_version: Number(after.revision_version ?? 1),
          previous_score: prevScore,
          new_score: Number(after.new_score ?? 0),
          previous_comment_sanitized: prevComment,
          new_comment_sanitized: (after.new_comment_sanitized as string | null) ?? null,
          actor_staff_id: rev.actor_id,
          actor_role: rev.actor_role,
          recorded_by_teacher_id: String(after.recorded_by_teacher_id ?? rev.actor_id ?? ''),
          reason: (after.reason as string | null) ?? null,
          request_id: rev.request_id,
          created_at_utc: new Date(rev.created_at).toISOString(),
        });
      });
    }

    return Object.freeze({
      lesson_id: lessonCtx.lesson_id,
      group_id: lessonCtx.group_id,
      lesson_version: lessonCtx.version,
      items: Object.freeze(items),
      revisions: Object.freeze(revisions),
      next_cursor: nextCursor,
    });
  }
}
