import { Inject, Injectable } from '@nestjs/common';
import type {
  AttendanceSourceChannel,
  AttendanceStatus,
} from '@eduerp/contracts';
import * as crypto from 'node:crypto';
import { isLessonEligibleForOperationalTriggers } from '../academics/academic-validation';
import { AcademicAccessService } from '../academics/academic-access.service';
import { ApiHttpException } from '../auth/auth.errors';
import { ClockService } from '../auth/clock.service';
import { AuthenticatedStaffPrincipal } from '../auth/permissions.guard';
import { formatCenterLocalDate } from '../auth/staff.service';
import {
  assertValidUuid,
  requireIdempotencyKeyHeader,
} from '../auth/validation';
import { TrialConversionService } from '../billing/trial-conversion';
import { RequestWithCorrelationId, resolveRequestId } from '../common/request-id.middleware';
import { ApiEnvConfig } from '../config/env';
import { API_CONFIG_TOKEN } from '../config/tokens';
import { DatabaseService } from '../database/database.service';
import {
  computeCanonicalPayloadHash,
  executeIdempotentOperation,
} from '../database/idempotency';
import { runInTransaction, TransactionContext } from '../database/transaction';
import {
  emitAttendanceCorrectedOutboxEventInTx,
  emitAttendanceSubmittedOutboxEventInTx,
} from './attendance.events';
import {
  ConflictsService,
  ExistingAttendanceRecordSnapshot,
} from './conflicts.service';
import {
  AttendanceDraftStudentItemDto,
  AttendanceFaultInjectionStep,
  AttendanceRevisionItemDto,
  AttendanceSubmitResponseDto,
  AttendanceSubmittedRecordItemDto,
  LessonAttendanceDraftResponseDto,
  ValidatedSubmitAttendanceInput,
  validateSubmitAttendanceInput,
} from './dto';

@Injectable()
export class AttendanceService {
  constructor(
    @Inject(API_CONFIG_TOKEN) private readonly config: ApiEnvConfig,
    @Inject(DatabaseService) private readonly databaseService: DatabaseService,
    @Inject(ClockService) private readonly clock: ClockService,
    @Inject(AcademicAccessService)
    private readonly academicAccess: AcademicAccessService,
    @Inject(ConflictsService)
    private readonly conflictsService: ConflictsService,
    @Inject(TrialConversionService)
    private readonly trialConversionService: TrialConversionService,
  ) {}

  private maybeInjectTestFault(
    targetStep: AttendanceFaultInjectionStep,
    configuredFault?: AttendanceFaultInjectionStep,
  ): void {
    if (this.config.nodeEnv === 'test' && configuredFault === targetStep) {
      throw new Error(`SIMULATED_S12_ATTENDANCE_FAULT_AFTER_${targetStep}`);
    }
  }

  public async getLessonAttendanceDraftOrSubmitted(
    principal: AuthenticatedStaffPrincipal,
    rawLessonId: unknown,
  ): Promise<LessonAttendanceDraftResponseDto> {
    const lessonId = assertValidUuid(rawLessonId, 'lesson_id');

    const { result } = await runInTransaction(
      this.databaseService,
      async (tx) => {
        const lessonCtx = await this.academicAccess.assertLessonAccess(
          tx,
          principal,
          lessonId,
          { lockLesson: false },
        );

        const enrollmentsRes = await tx.query<{
          enrollment_id: string;
          student_id: string;
          student_code: string;
          full_name: string;
          enrollment_status: 'TRIAL' | 'ACTIVE' | 'FROZEN';
          is_frozen_for_lesson: boolean;
        }>(
          `SELECT e."id"::text AS enrollment_id,
                  s."id"::text AS student_id,
                  s."student_code",
                  s."full_name",
                  e."status"::text AS enrollment_status,
                  (
                    e."status" = 'FROZEN'
                    OR EXISTS (
                      SELECT 1
                        FROM "freeze_lesson_links" fll
                       WHERE fll."center_id" = e."center_id"
                         AND fll."enrollment_id" = e."id"
                         AND fll."lesson_id" = $3::uuid
                    )
                    OR EXISTS (
                      SELECT 1
                        FROM "freeze_records" fr
                       WHERE fr."center_id" = e."center_id"
                         AND fr."enrollment_id" = e."id"
                         AND fr."freeze_start_date" <= $4::date
                         AND fr."freeze_end_date" >= $4::date
                    )
                  ) AS is_frozen_for_lesson
             FROM "enrollments" e
             JOIN "students" s
               ON s."id" = e."student_id"
              AND s."center_id" = e."center_id"
            WHERE e."center_id" = $1::uuid
              AND e."group_id" = $2::uuid
              AND e."status" IN ('TRIAL', 'ACTIVE', 'FROZEN')
              AND e."enrolled_at_date" <= $4::date
              AND (e."left_at_date" IS NULL OR e."left_at_date" > $4::date)
              AND s."status" = 'ACTIVE'
            ORDER BY s."normalized_name" ASC, s."id" ASC`,
          [principal.centerId, lessonCtx.group_id, lessonId, lessonCtx.lesson_date],
        );

        const recordsRes = await tx.query<{
          id: string;
          student_id: string;
          enrollment_id: string;
          status: AttendanceStatus;
          is_excused_frozen: boolean;
          source_channel: AttendanceSourceChannel;
          version: number;
        }>(
          `SELECT "id"::text AS id,
                  "student_id"::text AS student_id,
                  "enrollment_id"::text AS enrollment_id,
                  "status"::text AS status,
                  "is_excused_frozen",
                  "source_channel"::text AS source_channel,
                  "version"
             FROM "attendance_records"
            WHERE "center_id" = $1::uuid
              AND "lesson_id" = $2::uuid
            ORDER BY "student_id" ASC`,
          [principal.centerId, lessonId],
        );

        const recordByStudentId = new Map(
          recordsRes.rows.map((r) => [r.student_id, r]),
        );

        const roster: AttendanceDraftStudentItemDto[] = enrollmentsRes.rows.map((enr) => {
          const rec = recordByStudentId.get(enr.student_id);
          return Object.freeze({
            student_id: enr.student_id,
            enrollment_id: enr.enrollment_id,
            student_code: enr.student_code,
            full_name: enr.full_name,
            enrollment_status: enr.enrollment_status,
            is_frozen_for_lesson: Boolean(enr.is_frozen_for_lesson),
            draft_default_status: 'PRESENT' as const,
            submitted_status: rec ? rec.status : null,
            is_excused_frozen: rec ? Boolean(rec.is_excused_frozen) : Boolean(enr.is_frozen_for_lesson),
            attendance_record_id: rec ? rec.id : null,
            record_version: rec ? Number(rec.version) : null,
            source_channel: rec ? rec.source_channel : null,
          });
        });

        const revisionsRes = await tx.query<{
          id: string;
          attendance_record_id: string;
          student_id: string;
          revision_version: number;
          previous_status: AttendanceStatus | null;
          new_status: AttendanceStatus;
          source_channel: AttendanceSourceChannel;
          actor_staff_id: string;
          reason: string | null;
          client_operation_uuid: string;
          created_at: Date;
        }>(
          `SELECT ar_rev."id"::text AS id,
                  ar_rev."attendance_record_id"::text AS attendance_record_id,
                  ar."student_id"::text AS student_id,
                  ar_rev."revision_version",
                  ar_rev."previous_status"::text AS previous_status,
                  ar_rev."new_status"::text AS new_status,
                  ar_rev."source_channel"::text AS source_channel,
                  ar_rev."actor_staff_id"::text AS actor_staff_id,
                  ar_rev."reason",
                  ar_rev."client_operation_uuid"::text AS client_operation_uuid,
                  ar_rev."created_at"
             FROM "attendance_revisions" ar_rev
             JOIN "attendance_records" ar
               ON ar."id" = ar_rev."attendance_record_id"
              AND ar."center_id" = ar_rev."center_id"
            WHERE ar_rev."center_id" = $1::uuid
              AND ar."lesson_id" = $2::uuid
            ORDER BY ar_rev."revision_version" ASC, ar_rev."created_at" ASC, ar_rev."id" ASC`,
          [principal.centerId, lessonId],
        );

        const revisions: AttendanceRevisionItemDto[] = revisionsRes.rows.map((rev) =>
          Object.freeze({
            revision_id: rev.id,
            attendance_record_id: rev.attendance_record_id,
            student_id: rev.student_id,
            revision_version: Number(rev.revision_version),
            previous_status: rev.previous_status,
            new_status: rev.new_status,
            source_channel: rev.source_channel,
            actor_staff_id: rev.actor_staff_id,
            reason: rev.reason,
            client_operation_uuid: rev.client_operation_uuid,
            created_at_utc: new Date(rev.created_at).toISOString(),
          }),
        );

        const isSubmitted = recordsRes.rows.length > 0;
        const currentVersion = isSubmitted
          ? Math.max(...recordsRes.rows.map((r) => Number(r.version)))
          : 1;

        return Object.freeze({
          lesson_id: lessonCtx.lesson_id,
          group_id: lessonCtx.group_id,
          lesson_date: lessonCtx.lesson_date,
          occurrence_seq: lessonCtx.occurrence_seq,
          lesson_status: lessonCtx.status,
          is_submitted: isSubmitted,
          current_version: currentVersion,
          roster: Object.freeze(roster),
          revisions: Object.freeze(revisions),
        });
      },
      { isolationLevel: 'REPEATABLE READ' },
    );

    return result;
  }

  public async submitLessonAttendance(
    req: RequestWithCorrelationId,
    principal: AuthenticatedStaffPrincipal,
    rawLessonId: unknown,
    rawBody: unknown,
    options?: { readonly testFaultAfterStep?: AttendanceFaultInjectionStep },
  ): Promise<AttendanceSubmitResponseDto> {
    const idempotencyKey = requireIdempotencyKeyHeader(req);
    const requestId = req.requestId ?? resolveRequestId(req.headers['x-request-id']);
    const parsed = validateSubmitAttendanceInput(req, rawLessonId, rawBody);

    const outcome = await this.executeValidatedAttendanceOperation(
      principal,
      parsed,
      {
        httpIdempotencyKey: idempotencyKey,
        requestId,
        testFaultAfterStep: options?.testFaultAfterStep,
      },
    );

    return outcome.body;
  }

  public async executeValidatedAttendanceOperation(
    principal: AuthenticatedStaffPrincipal,
    parsed: ValidatedSubmitAttendanceInput,
    options: {
      readonly httpIdempotencyKey: string;
      readonly requestId: string;
      readonly testFaultAfterStep?: AttendanceFaultInjectionStep;
    },
  ): Promise<{
    readonly statusCode: number;
    readonly body: AttendanceSubmitResponseDto;
    readonly replayed: boolean;
  }> {
    const canonicalPayload = {
      lesson_id: parsed.lessonId,
      client_operation_uuid: parsed.clientOperationUuid,
      expected_version: parsed.expectedVersion,
      source_channel: parsed.sourceChannel,
      override_reason: parsed.overrideReason,
      records: parsed.records.map((r) => ({
        student_id: r.studentId,
        status: r.status,
      })),
    };
    const payloadHash = computeCanonicalPayloadHash(canonicalPayload);

    return executeIdempotentOperation<AttendanceSubmitResponseDto>(
      this.databaseService,
      {
        centerId: principal.centerId,
        actorStaffId: principal.staffId,
        operationType: 'SUBMIT_LESSON_ATTENDANCE',
        idempotencyKey: options.httpIdempotencyKey,
        requestPayload: canonicalPayload,
        authorizeBeforeReplayOrExecute: async (tx: TransactionContext) => {
          const staffRes = await tx.query<{ role: string; status: string }>(
            `SELECT "role"::text AS role, "status"::text AS status
               FROM "staff_users"
              WHERE "id" = $1::uuid
                AND "center_id" = $2::uuid
              LIMIT 1`,
            [principal.staffId, principal.centerId],
          );
          const staffRow = staffRes.rows[0];
          if (!staffRow || staffRow.status !== 'ACTIVE') {
            throw new ApiHttpException({
              statusCode: 401,
              errorCode: 'UNAUTHORIZED',
              message: 'Staff user is no longer active',
            });
          }

          const licRes = await tx.query<{ license_mode: string }>(
            `SELECT "license_mode"::text AS license_mode
               FROM "center_licenses"
              WHERE "center_id" = $1::uuid
              LIMIT 1`,
            [principal.centerId],
          );
          if (
            principal.licenseMode === 'READ_ONLY' ||
            licRes.rows[0]?.license_mode === 'READ_ONLY'
          ) {
            throw new ApiHttpException({
              statusCode: 403,
              errorCode: 'LICENSE_READ_ONLY_MODE',
              message: 'Attendance submission is blocked while center license is in READ_ONLY mode',
            });
          }

          if (staffRow.role === 'TEACHER') {
            if (
              parsed.sourceChannel === 'ADMIN_OVERRIDE' ||
              parsed.sourceChannel === 'ADMIN_EXCEL' ||
              (parsed.overrideReason !== null && parsed.overrideReason.trim().length > 0)
            ) {
              throw new ApiHttpException({
                statusCode: 403,
                errorCode: 'FORBIDDEN_ROLE',
                message:
                  'TEACHER role is not permitted to perform ADMIN_OVERRIDE or ADMIN_EXCEL attendance operations',
              });
            }
          } else if (staffRow.role === 'ADMIN' || staffRow.role === 'DIRECTOR') {
            if (
              parsed.sourceChannel === 'TEACHER_WEB' ||
              parsed.sourceChannel === 'TEACHER_MOBILE'
            ) {
              throw new ApiHttpException({
                statusCode: 403,
                errorCode: 'FORBIDDEN_ROLE',
                message:
                  'ADMIN/DIRECTOR cannot impersonate TEACHER_WEB or TEACHER_MOBILE attendance source channels',
              });
            }
          }

          await this.academicAccess.assertLessonAccess(tx, principal, parsed.lessonId, {
            lockLesson: true,
            forExclusiveTeacherWrite: staffRow.role === 'TEACHER',
          });

          const otherActorOpRes = await tx.query<{ actor_id: string }>(
            `SELECT "actor_id"::text AS actor_id
               FROM "client_operation_logs"
              WHERE "center_id" = $1::uuid
                AND "operation_type" = 'ATTENDANCE_CLIENT_OP_UUID'
                AND "client_operation_uuid" = $2::uuid
                AND "actor_id" <> $3::uuid
              LIMIT 1`,
            [principal.centerId, parsed.clientOperationUuid, principal.staffId],
          );
          if (otherActorOpRes.rows[0]) {
            throw new ApiHttpException({
              statusCode: 409,
              errorCode: 'VERSION_CONFLICT',
              message: 'client_operation_uuid is already bound to another staff actor in this center',
            });
          }
        },
        handler: async (tx: TransactionContext) => {
          await tx.query(
            `SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`,
            [
              `${principal.centerId}:${principal.staffId}:ATTENDANCE_CLIENT_OP_UUID`,
              parsed.clientOperationUuid,
            ],
          );

          const existingClientOpRes = await tx.query<{
            request_body_sha256: string;
            response_status_code: number;
            response_payload_json: AttendanceSubmitResponseDto;
          }>(
            `SELECT "request_body_sha256",
                    "response_status_code",
                    "response_payload_json"
               FROM "client_operation_logs"
              WHERE "center_id" = $1::uuid
                AND "actor_id" = $2::uuid
                AND "operation_type" = 'ATTENDANCE_CLIENT_OP_UUID'
                AND "client_operation_uuid" = $3::uuid
              LIMIT 1`,
            [principal.centerId, principal.staffId, parsed.clientOperationUuid],
          );

          const existingClientOp = existingClientOpRes.rows[0];
          if (existingClientOp) {
            if (existingClientOp.request_body_sha256 !== payloadHash) {
              throw new ApiHttpException({
                statusCode: 409,
                errorCode: 'IDEMPOTENCY_PAYLOAD_MISMATCH',
                message:
                  'client_operation_uuid was already used with a different attendance request payload (12.02)',
              });
            }
            return {
              statusCode: Number(existingClientOp.response_status_code),
              body: existingClientOp.response_payload_json,
            };
          }

          const lessonCtx = await this.academicAccess.assertLessonAccess(
            tx,
            principal,
            parsed.lessonId,
            {
              lockLesson: true,
              forExclusiveTeacherWrite: principal.role === 'TEACHER',
            },
          );

          const triggerElig = isLessonEligibleForOperationalTriggers(lessonCtx.status);
          if (!triggerElig.eligible_for_trial_conversion) {
            throw new ApiHttpException({
              statusCode: 422,
              errorCode: 'VALIDATION_ERROR',
              message: `Cannot submit attendance for lesson ${parsed.lessonId} in status ${lessonCtx.status} (12.01)`,
            });
          }

          const nowUtc = this.clock.now();
          const todayCenterDate = formatCenterLocalDate(nowUtc, lessonCtx.group_timezone);
          if (lessonCtx.lesson_date > todayCenterDate) {
            throw new ApiHttpException({
              statusCode: 422,
              errorCode: 'VALIDATION_ERROR',
              message: `Cannot submit confirmed attendance for future lesson date ${lessonCtx.lesson_date} (today is ${todayCenterDate}) (12.01)`,
            });
          }

          const existingRecsRes = await tx.query<{
            id: string;
            student_id: string;
            enrollment_id: string;
            status: AttendanceStatus;
            is_excused_frozen: boolean;
            source_channel: AttendanceSourceChannel;
            recorded_by_staff_id: string;
            override_reason: string | null;
            version: number;
          }>(
            `SELECT "id"::text AS id,
                    "student_id"::text AS student_id,
                    "enrollment_id"::text AS enrollment_id,
                    "status"::text AS status,
                    "is_excused_frozen",
                    "source_channel"::text AS source_channel,
                    "recorded_by_staff_id"::text AS recorded_by_staff_id,
                    "override_reason",
                    "version"
               FROM "attendance_records"
              WHERE "center_id" = $1::uuid
                AND "lesson_id" = $2::uuid
              ORDER BY "student_id" ASC
              FOR UPDATE`,
            [principal.centerId, parsed.lessonId],
          );

          const existingSnapshots: ExistingAttendanceRecordSnapshot[] =
            existingRecsRes.rows.map((r) => ({
              id: r.id,
              studentId: r.student_id,
              enrollmentId: r.enrollment_id,
              status: r.status,
              isExcusedFrozen: Boolean(r.is_excused_frozen),
              sourceChannel: r.source_channel,
              recordedByStaffId: r.recorded_by_staff_id,
              overrideReason: r.override_reason,
              version: Number(r.version),
            }));

          const writePlan = this.conflictsService.evaluateWriteConflict({
            lessonId: parsed.lessonId,
            actorRole: principal.role,
            requestedSourceChannel: parsed.sourceChannel,
            overrideReason: parsed.overrideReason,
            expectedVersion: parsed.expectedVersion,
            existingRecords: existingSnapshots,
            incomingRecords: parsed.records,
          });

          const eligibleEnrollmentsRes = await tx.query<{
            enrollment_id: string;
            student_id: string;
            enrollment_status: 'TRIAL' | 'ACTIVE' | 'FROZEN';
            is_frozen_for_lesson: boolean;
          }>(
            `SELECT e."id"::text AS enrollment_id,
                    e."student_id"::text AS student_id,
                    e."status"::text AS enrollment_status,
                    (
                      e."status" = 'FROZEN'
                      OR EXISTS (
                        SELECT 1
                          FROM "freeze_lesson_links" fll
                         WHERE fll."center_id" = e."center_id"
                           AND fll."enrollment_id" = e."id"
                           AND fll."lesson_id" = $3::uuid
                      )
                      OR EXISTS (
                        SELECT 1
                          FROM "freeze_records" fr
                         WHERE fr."center_id" = e."center_id"
                           AND fr."enrollment_id" = e."id"
                           AND fr."freeze_start_date" <= $4::date
                           AND fr."freeze_end_date" >= $4::date
                      )
                    ) AS is_frozen_for_lesson
               FROM "enrollments" e
               JOIN "students" s
                 ON s."id" = e."student_id"
                AND s."center_id" = e."center_id"
              WHERE e."center_id" = $1::uuid
                AND e."group_id" = $2::uuid
                AND e."status" IN ('TRIAL', 'ACTIVE', 'FROZEN')
                AND e."enrolled_at_date" <= $4::date
                AND (e."left_at_date" IS NULL OR e."left_at_date" > $4::date)
                AND s."status" = 'ACTIVE'
              ORDER BY e."id" ASC
              FOR UPDATE OF e`,
            [
              principal.centerId,
              lessonCtx.group_id,
              parsed.lessonId,
              lessonCtx.lesson_date,
            ],
          );

          const enrollmentByStudentId = new Map(
            eligibleEnrollmentsRes.rows.map((e) => [e.student_id, e]),
          );

          for (const rec of parsed.records) {
            if (!enrollmentByStudentId.has(rec.studentId)) {
              throw new ApiHttpException({
                statusCode: 422,
                errorCode: 'VALIDATION_ERROR',
                message: `Student ${rec.studentId} does not have an active/trial/frozen enrollment in group ${lessonCtx.group_id} on lesson date ${lessonCtx.lesson_date} (T12.01)`,
              });
            }
          }

          if (writePlan.mode === 'INITIAL_SUBMIT') {
            if (parsed.records.length !== eligibleEnrollmentsRes.rows.length) {
              throw new ApiHttpException({
                statusCode: 422,
                errorCode: 'VALIDATION_ERROR',
                message: `Initial attendance submission must include all ${eligibleEnrollmentsRes.rows.length} eligible enrolled students for lesson ${parsed.lessonId} (got ${parsed.records.length}) (T12.01)`,
              });
            }
          }

          const submittedRecordDtos: AttendanceSubmittedRecordItemDto[] = [];
          const absentStudentIds: string[] = [];
          const lateStudentIds: string[] = [];
          const presentTrialEnrollmentIds: string[] = [];
          const overriddenRecordsForEvents: Array<{
            attendanceRecordId: string;
            revisionVersion: number;
            studentId: string;
            enrollmentId: string;
            previousStatus: AttendanceStatus;
            newStatus: AttendanceStatus;
            overrideReason: string;
            requiresTrialCompensationReview: boolean;
          }> = [];

          if (writePlan.mode === 'INITIAL_SUBMIT') {
            for (const rec of parsed.records) {
              const enr = enrollmentByStudentId.get(rec.studentId)!;
              const recordId = crypto.randomUUID();
              const isExcusedFrozen = Boolean(enr.is_frozen_for_lesson);

              await tx.query(
                `INSERT INTO "attendance_records" (
                   "id",
                   "center_id",
                   "lesson_id",
                   "student_id",
                   "enrollment_id",
                   "status",
                   "is_excused_frozen",
                   "source_channel",
                   "recorded_by_staff_id",
                   "override_reason",
                   "client_operation_uuid",
                   "version",
                   "submitted_at",
                   "updated_at"
                 ) VALUES (
                   $1::uuid,
                   $2::uuid,
                   $3::uuid,
                   $4::uuid,
                   $5::uuid,
                   $6,
                   $7::boolean,
                   $8,
                   $9::uuid,
                   NULL,
                   $10::uuid,
                   1,
                   $11::timestamptz,
                   $11::timestamptz
                 )`,
                [
                  recordId,
                  principal.centerId,
                  parsed.lessonId,
                  rec.studentId,
                  enr.enrollment_id,
                  rec.status,
                  isExcusedFrozen,
                  writePlan.resolvedSourceChannel,
                  principal.staffId,
                  parsed.clientOperationUuid,
                  nowUtc.toISOString(),
                ],
              );

              if (rec.status === 'ABSENT' && !isExcusedFrozen) {
                absentStudentIds.push(rec.studentId);
              } else if (rec.status === 'LATE') {
                lateStudentIds.push(rec.studentId);
              }
              if (
                enr.enrollment_status === 'TRIAL' &&
                (rec.status === 'PRESENT' || rec.status === 'LATE')
              ) {
                presentTrialEnrollmentIds.push(enr.enrollment_id);
              }

              submittedRecordDtos.push(
                Object.freeze({
                  attendance_record_id: recordId,
                  student_id: rec.studentId,
                  enrollment_id: enr.enrollment_id,
                  status: rec.status,
                  is_excused_frozen: isExcusedFrozen,
                  source_channel: writePlan.resolvedSourceChannel,
                  recorded_by_staff_id: principal.staffId,
                  override_reason: null,
                  version: 1,
                }),
              );
            }

            this.maybeInjectTestFault(
              'ATTENDANCE_RECORD_WRITE',
              options.testFaultAfterStep,
            );

            for (const dto of submittedRecordDtos) {
              await tx.query(
                `INSERT INTO "attendance_revisions" (
                   "id",
                   "center_id",
                   "attendance_record_id",
                   "revision_version",
                   "previous_status",
                   "new_status",
                   "source_channel",
                   "actor_staff_id",
                   "reason",
                   "client_operation_uuid",
                   "created_at"
                 ) VALUES (
                   $1::uuid,
                   $2::uuid,
                   $3::uuid,
                   1,
                   NULL,
                   $4,
                   $5,
                   $6::uuid,
                   NULL,
                   $7::uuid,
                   $8::timestamptz
                 )`,
                [
                  crypto.randomUUID(),
                  principal.centerId,
                  dto.attendance_record_id,
                  dto.status,
                  writePlan.resolvedSourceChannel,
                  principal.staffId,
                  parsed.clientOperationUuid,
                  nowUtc.toISOString(),
                ],
              );
            }

            this.maybeInjectTestFault(
              'ATTENDANCE_REVISION_INSERT',
              options.testFaultAfterStep,
            );

            await tx.query(
              `UPDATE "lesson_occurrences"
                  SET "status" = 'COMPLETED',
                      "attendance_submitted_at" = COALESCE("attendance_submitted_at", $1::timestamptz),
                      "attendance_submitted_by" = COALESCE("attendance_submitted_by", $2::uuid),
                      "version" = "version" + 1,
                      "updated_at" = $1::timestamptz
                WHERE "id" = $3::uuid
                  AND "center_id" = $4::uuid`,
              [
                nowUtc.toISOString(),
                principal.staffId,
                parsed.lessonId,
                principal.centerId,
              ],
            );
          } else {
            const incomingByStudentId = new Map(
              parsed.records.map((r) => [r.studentId, r]),
            );

            for (const existing of existingSnapshots) {
              const incoming = incomingByStudentId.get(existing.studentId);
              const newStatus = incoming ? incoming.status : existing.status;
              const enr = enrollmentByStudentId.get(existing.studentId);
              const isExcusedFrozen = enr
                ? Boolean(enr.is_frozen_for_lesson)
                : existing.isExcusedFrozen;

              await tx.query(
                `UPDATE "attendance_records"
                    SET "status" = $1,
                        "is_excused_frozen" = $2::boolean,
                        "source_channel" = 'ADMIN_OVERRIDE',
                        "recorded_by_staff_id" = $3::uuid,
                        "override_reason" = $4,
                        "client_operation_uuid" = $5::uuid,
                        "version" = $6::int,
                        "updated_at" = $7::timestamptz
                  WHERE "id" = $8::uuid
                    AND "center_id" = $9::uuid
                    AND "version" = $10::int`,
                [
                  newStatus,
                  isExcusedFrozen,
                  principal.staffId,
                  writePlan.normalizedOverrideReason,
                  parsed.clientOperationUuid,
                  writePlan.nextRecordVersion,
                  nowUtc.toISOString(),
                  existing.id,
                  principal.centerId,
                  existing.version,
                ],
              );

              if (
                enr?.enrollment_status === 'TRIAL' &&
                (newStatus === 'PRESENT' || newStatus === 'LATE') &&
                existing.status === 'ABSENT'
              ) {
                presentTrialEnrollmentIds.push(existing.enrollmentId);
              }

              let requiresTrialCompensationReview = false;
              if (
                (existing.status === 'PRESENT' || existing.status === 'LATE') &&
                newStatus === 'ABSENT'
              ) {
                const actCheck = await tx.query<{ id: string }>(
                  `SELECT "id"::text AS id
                     FROM "trial_activations"
                    WHERE "center_id" = $1::uuid
                      AND "enrollment_id" = $2::uuid
                      AND "second_trigger_lesson_id" = $3::uuid
                      AND "status" = 'ACTIVE_ACTIVATION'
                    LIMIT 1`,
                  [principal.centerId, existing.enrollmentId, parsed.lessonId],
                );
                requiresTrialCompensationReview = Boolean(actCheck.rows[0]);
              }

              if (incoming !== undefined) {
                overriddenRecordsForEvents.push({
                  attendanceRecordId: existing.id,
                  revisionVersion: writePlan.nextRecordVersion,
                  studentId: existing.studentId,
                  enrollmentId: existing.enrollmentId,
                  previousStatus: existing.status,
                  newStatus,
                  overrideReason: writePlan.normalizedOverrideReason!,
                  requiresTrialCompensationReview,
                });
              }

              submittedRecordDtos.push(
                Object.freeze({
                  attendance_record_id: existing.id,
                  student_id: existing.studentId,
                  enrollment_id: existing.enrollmentId,
                  status: newStatus,
                  is_excused_frozen: isExcusedFrozen,
                  source_channel: 'ADMIN_OVERRIDE',
                  recorded_by_staff_id: principal.staffId,
                  override_reason: writePlan.normalizedOverrideReason,
                  version: writePlan.nextRecordVersion,
                }),
              );
            }

            this.maybeInjectTestFault(
              'ATTENDANCE_RECORD_WRITE',
              options.testFaultAfterStep,
            );

            for (const ov of overriddenRecordsForEvents) {
              await tx.query(
                `INSERT INTO "attendance_revisions" (
                   "id",
                   "center_id",
                   "attendance_record_id",
                   "revision_version",
                   "previous_status",
                   "new_status",
                   "source_channel",
                   "actor_staff_id",
                   "reason",
                   "client_operation_uuid",
                   "created_at"
                 ) VALUES (
                   $1::uuid,
                   $2::uuid,
                   $3::uuid,
                   $4::int,
                   $5,
                   $6,
                   'ADMIN_OVERRIDE',
                   $7::uuid,
                   $8,
                   $9::uuid,
                   $10::timestamptz
                 )`,
                [
                  crypto.randomUUID(),
                  principal.centerId,
                  ov.attendanceRecordId,
                  ov.revisionVersion,
                  ov.previousStatus,
                  ov.newStatus,
                  principal.staffId,
                  ov.overrideReason,
                  parsed.clientOperationUuid,
                  nowUtc.toISOString(),
                ],
              );
            }

            this.maybeInjectTestFault(
              'ATTENDANCE_REVISION_INSERT',
              options.testFaultAfterStep,
            );
          }

          let trialActivationsTriggered = 0;
          const activatedInvoiceIds: string[] = [];

          for (const trialEnrollmentId of presentTrialEnrollmentIds) {
            const evalRes =
              await this.trialConversionService.evaluateTrialEnrollmentWithinTransaction(
                tx,
                {
                  centerId: principal.centerId,
                  enrollmentId: trialEnrollmentId,
                  actorType: 'STAFF',
                  actorStaffId: principal.staffId,
                  actorRole: principal.role,
                  requestId: options.requestId,
                },
              );
            if (evalRes.outcome === 'ACTIVATED_AND_INVOICED') {
              trialActivationsTriggered += 1;
              if (evalRes.generated_invoice) {
                activatedInvoiceIds.push(evalRes.generated_invoice.invoice_id);
              }
            }
          }

          this.maybeInjectTestFault(
            'TRIAL_EVALUATION',
            options.testFaultAfterStep,
          );

          await tx.query(
            `INSERT INTO "audit_logs" (
               "id",
               "center_id",
               "actor_type",
               "actor_id",
               "actor_role",
               "action",
               "entity_type",
               "entity_id",
               "severity",
               "before_redacted_json",
               "after_redacted_json",
               "request_id",
               "created_at"
             ) VALUES (
               $1::uuid,
               $2::uuid,
               'STAFF',
               $3::uuid,
               $4,
               $5,
               'LessonOccurrence',
               $6::uuid,
               $7,
               $8::jsonb,
               $9::jsonb,
               $10,
               $11::timestamptz
             )`,
            [
              crypto.randomUUID(),
              principal.centerId,
              principal.staffId,
              principal.role,
              writePlan.mode === 'INITIAL_SUBMIT'
                ? 'LESSON_ATTENDANCE_SUBMITTED'
                : 'LESSON_ATTENDANCE_OVERRIDDEN',
              parsed.lessonId,
              writePlan.mode === 'INITIAL_SUBMIT' ? 'INFO' : 'WARN',
              writePlan.mode === 'INITIAL_SUBMIT'
                ? null
                : JSON.stringify({
                    previous_version: parsed.expectedVersion,
                    overridden_students: overriddenRecordsForEvents.map((o) => ({
                      student_id: o.studentId,
                      previous_status: o.previousStatus,
                      new_status: o.newStatus,
                    })),
                  }),
              JSON.stringify({
                lesson_id: parsed.lessonId,
                client_operation_uuid: parsed.clientOperationUuid,
                source_channel: writePlan.resolvedSourceChannel,
                new_version: writePlan.nextRecordVersion,
                override_reason: writePlan.normalizedOverrideReason,
                trial_activations_triggered: trialActivationsTriggered,
              }),
              options.requestId,
              nowUtc.toISOString(),
            ],
          );

          this.maybeInjectTestFault('AUDIT_LOG', options.testFaultAfterStep);

          if (writePlan.mode === 'INITIAL_SUBMIT') {
            await emitAttendanceSubmittedOutboxEventInTx(tx, {
              centerId: principal.centerId,
              lessonId: parsed.lessonId,
              groupId: lessonCtx.group_id,
              lessonDate: lessonCtx.lesson_date,
              occurrenceSeq: lessonCtx.occurrence_seq,
              aggregateVersion: writePlan.nextRecordVersion,
              clientOperationUuid: parsed.clientOperationUuid,
              submittedByStaffId: principal.staffId,
              absentStudentIds,
              lateStudentIds,
              presentTrialEnrollmentIds,
              occurredAtUtc: nowUtc,
            });
          } else {
            for (const ov of overriddenRecordsForEvents) {
              await emitAttendanceCorrectedOutboxEventInTx(tx, {
                centerId: principal.centerId,
                attendanceRecordId: ov.attendanceRecordId,
                revisionVersion: ov.revisionVersion,
                lessonId: parsed.lessonId,
                studentId: ov.studentId,
                enrollmentId: ov.enrollmentId,
                previousStatus: ov.previousStatus,
                newStatus: ov.newStatus,
                overrideReason: ov.overrideReason,
                actorStaffId: principal.staffId,
                requiresTrialCompensationReview: ov.requiresTrialCompensationReview,
                occurredAtUtc: nowUtc,
              });
            }
          }

          this.maybeInjectTestFault('OUTBOX_EVENT', options.testFaultAfterStep);

          const responseBody: AttendanceSubmitResponseDto = Object.freeze({
            lesson_id: parsed.lessonId,
            client_operation_uuid: parsed.clientOperationUuid,
            new_version: writePlan.nextRecordVersion,
            submitted_at_utc: nowUtc.toISOString(),
            trial_activations_triggered: trialActivationsTriggered,
            activated_invoice_ids: Object.freeze(activatedInvoiceIds),
            records: Object.freeze(submittedRecordDtos),
          });

          await tx.query(
            `INSERT INTO "client_operation_logs" (
               "client_operation_uuid",
               "center_id",
               "actor_id",
               "operation_type",
               "request_body_sha256",
               "response_status_code",
               "response_payload_json"
             ) VALUES ($1::uuid, $2::uuid, $3::uuid, 'ATTENDANCE_CLIENT_OP_UUID', $4, 200, $5::jsonb)`,
            [
              parsed.clientOperationUuid,
              principal.centerId,
              principal.staffId,
              payloadHash,
              JSON.stringify(responseBody),
            ],
          );

          return {
            statusCode: 200,
            body: responseBody,
          };
        },
      },
    );
  }
}
