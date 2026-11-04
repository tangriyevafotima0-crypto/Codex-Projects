import { Inject, Injectable } from '@nestjs/common';
import type { BillingMode } from '@eduerp/contracts';
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
import { DatabaseService } from '../database/database.service';
import { executeIdempotentOperation } from '../database/idempotency';
import { executeOptimisticUpdate, TransactionContext } from '../database/transaction';
import { API_CONFIG_TOKEN } from '../health/health.controller';
import { validateIsoDate } from './normalization';

export type EnrollmentStatus = 'TRIAL' | 'ACTIVE' | 'FROZEN' | 'LEFT';
export type ChurnReasonCode = 1 | 2 | 3 | 4 | 5;

const ALLOWED_INITIAL_STATUSES: ReadonlySet<string> = new Set(['TRIAL', 'ACTIVE']);
const ALLOWED_CHURN_REASONS: ReadonlySet<number> = new Set([1, 2, 3, 4, 5]);

export interface EnrollmentResponseDto {
  readonly enrollment_id: string;
  readonly student_id: string;
  readonly group_id: string;
  readonly status: EnrollmentStatus;
  readonly enrolled_at_date: string;
  readonly left_at_date: string | null;
  readonly churn_reason_code: ChurnReasonCode | null;
  readonly package_lessons_remaining: number | null;
  readonly transferred_from_enrollment_id: string | null;
  readonly preserved_debt_snapshot_uzs?: string;
  readonly version: number;
}

export interface TransferEnrollmentResponseDto {
  readonly closed_enrollment: EnrollmentResponseDto;
  readonly new_enrollment: EnrollmentResponseDto;
  readonly preserved_debt_snapshot_uzs: string;
}

function formatPgDate(val: unknown): string | null {
  if (val === null || val === undefined) {
    return null;
  }
  if (val instanceof Date) {
    return val.toISOString().slice(0, 10);
  }
  const str = String(val);
  return str.slice(0, 10);
}

export function mapEnrollmentRowToDto(
  row: {
    id: string;
    student_id: string;
    group_id: string;
    status: EnrollmentStatus;
    enrolled_at_date: unknown;
    left_at_date: unknown;
    churn_reason_code: number | null;
    package_lessons_remaining: number | null;
    transferred_from_enrollment_id?: string | null;
    version: number;
  },
  preservedDebtSnapshotUzs?: string,
): EnrollmentResponseDto {
  return Object.freeze({
    enrollment_id: row.id,
    student_id: row.student_id,
    group_id: row.group_id,
    status: row.status,
    enrolled_at_date: formatPgDate(row.enrolled_at_date) ?? '1970-01-01',
    left_at_date: formatPgDate(row.left_at_date),
    churn_reason_code:
      row.churn_reason_code !== null ? (Number(row.churn_reason_code) as ChurnReasonCode) : null,
    package_lessons_remaining:
      row.package_lessons_remaining !== null ? Number(row.package_lessons_remaining) : null,
    transferred_from_enrollment_id: row.transferred_from_enrollment_id ?? null,
    ...(preservedDebtSnapshotUzs !== undefined
      ? { preserved_debt_snapshot_uzs: preservedDebtSnapshotUzs }
      : {}),
    version: Number(row.version),
  });
}

@Injectable()
export class EnrollmentsService {
  constructor(
    @Inject(API_CONFIG_TOKEN) private readonly config: ApiEnvConfig,
    @Inject(DatabaseService) private readonly databaseService: DatabaseService,
    @Inject(ClockService) private readonly clock: ClockService,
  ) {}

  private async queryStudentRemainingDebtSnapshotUzs(
    tx: TransactionContext,
    centerId: string,
    studentId: string,
  ): Promise<string> {
    const res = await tx.query<{ total_debt: string }>(
      `SELECT COALESCE(SUM("remaining_debt_uzs"), 0)::text AS total_debt
         FROM "invoices"
        WHERE "center_id" = $1::uuid
          AND "student_id" = $2::uuid
          AND "status" IN ('ISSUED_OPEN', 'PARTIALLY_PAID')`,
      [centerId, studentId],
    );
    return BigInt(res.rows[0]?.total_debt ?? '0').toString(10);
  }

  public async createStudentEnrollment(
    req: RequestWithCorrelationId,
    principal: AuthenticatedStaffPrincipal,
    rawBody: unknown,
  ): Promise<EnrollmentResponseDto> {
    const idempotencyKey = requireIdempotencyKeyHeader(req);
    const obj = assertPlainObject(rawBody, [
      'student_id',
      'group_id',
      'initial_status',
      'enrolled_at_date',
      'auto_issue_pro_rata_invoice',
    ]);

    const studentId = assertValidUuid(obj.student_id, 'student_id');
    const groupId = assertValidUuid(obj.group_id, 'group_id');
    const initialStatusRaw =
      typeof obj.initial_status === 'string' ? obj.initial_status.trim().toUpperCase() : '';
    if (!ALLOWED_INITIAL_STATUSES.has(initialStatusRaw)) {
      throw new ApiHttpException({
        statusCode: 400,
        errorCode: 'VALIDATION_ERROR',
        message: 'initial_status must be TRIAL or ACTIVE',
      });
    }
    const initialStatus = initialStatusRaw as 'TRIAL' | 'ACTIVE';
    const enrolledAtDate = validateIsoDate(obj.enrolled_at_date, 'enrolled_at_date');

    // 06.03 Policy Gate: billing/pro-rata invoice calculation belongs to Stage 08 and requires confirmed D01-D04 policy
    if (obj.auto_issue_pro_rata_invoice === true) {
      throw new ApiHttpException({
        statusCode: 403,
        errorCode: 'POLICY_DECISION_NOT_CONFIRMED',
        message:
          'Automatic pro-rata invoice calculation during enrollment is gated by unconfirmed billing policy decisions (D01-D04 / Stage 08)',
      });
    }

    const requestId = req.requestId ?? resolveRequestId(req.headers['x-request-id']);
    const now = this.clock.now();

    const idemOutcome = await executeIdempotentOperation<EnrollmentResponseDto>(
      this.databaseService,
      {
        centerId: principal.centerId,
        actorStaffId: principal.staffId,
        operationType: 'CREATE_STUDENT_ENROLLMENT',
        idempotencyKey,
        requestPayload: {
          student_id: studentId,
          group_id: groupId,
          initial_status: initialStatus,
          enrolled_at_date: enrolledAtDate,
        },
        handler: async (tx) => {
          const stuRes = await tx.query<{ id: string; status: string }>(
            `SELECT "id"::text AS id, "status"::text AS status
               FROM "students"
              WHERE "id" = $1::uuid
                AND "center_id" = $2::uuid
              FOR UPDATE`,
            [studentId, principal.centerId],
          );
          const student = stuRes.rows[0];
          if (!student) {
            throw new ApiHttpException({
              statusCode: 404,
              errorCode: 'NOT_FOUND',
              message: 'Student not found in this center',
            });
          }
          if (student.status !== 'ACTIVE') {
            throw new ApiHttpException({
              statusCode: 422,
              errorCode: 'VALIDATION_ERROR',
              message: 'Cannot enroll an ARCHIVED student without restoring status to ACTIVE first',
            });
          }

          const grpRes = await tx.query<{
            id: string;
            status: string;
            billing_mode: BillingMode;
            lessons_per_cycle: number;
          }>(
            `SELECT "id"::text AS id,
                    "status"::text AS status,
                    "billing_mode"::text AS billing_mode,
                    "lessons_per_cycle"
               FROM "course_groups"
              WHERE "id" = $1::uuid
                AND "center_id" = $2::uuid
              FOR UPDATE`,
            [groupId, principal.centerId],
          );
          const group = grpRes.rows[0];
          if (!group) {
            throw new ApiHttpException({
              statusCode: 404,
              errorCode: 'NOT_FOUND',
              message: 'Course group not found in this center',
            });
          }
          if (group.status !== 'ACTIVE') {
            throw new ApiHttpException({
              statusCode: 422,
              errorCode: 'VALIDATION_ERROR',
              message: 'Cannot enroll into an ARCHIVED course group',
            });
          }

          const enrollmentId = crypto.randomUUID();
          const packageLessonsRemaining =
            group.billing_mode === 'LESSON_PACKAGE_12' ? Number(group.lessons_per_cycle) : null;
          const activatedAtIso = initialStatus === 'ACTIVE' ? now.toISOString() : null;

          try {
            const ins = await tx.query<{
              id: string;
              student_id: string;
              group_id: string;
              status: EnrollmentStatus;
              enrolled_at_date: unknown;
              left_at_date: unknown;
              churn_reason_code: number | null;
              package_lessons_remaining: number | null;
              transferred_from_enrollment_id: string | null;
              version: number;
            }>(
              `INSERT INTO "enrollments" (
                 "id", "center_id", "student_id", "group_id", "status",
                 "enrolled_at_date", "activated_at", "package_lessons_remaining",
                 "version", "created_at", "updated_at"
               ) VALUES (
                 $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5,
                 $6::date, $7::timestamptz, $8::int,
                 1, $9::timestamptz, $9::timestamptz
               )
               RETURNING "id"::text AS id,
                         "student_id"::text AS student_id,
                         "group_id"::text AS group_id,
                         "status"::text AS status,
                         "enrolled_at_date",
                         "left_at_date",
                         "churn_reason_code",
                         "package_lessons_remaining",
                         "transferred_from_enrollment_id"::text AS transferred_from_enrollment_id,
                         "version"`,
              [
                enrollmentId,
                principal.centerId,
                studentId,
                groupId,
                initialStatus,
                enrolledAtDate,
                activatedAtIso,
                packageLessonsRemaining,
                now.toISOString(),
              ],
            );

            const created = ins.rows[0];

            await tx.query(
              `INSERT INTO "audit_logs" (
                 "id", "center_id", "actor_type", "actor_id", "actor_role",
                 "action", "entity_type", "entity_id", "severity",
                 "after_redacted_json", "request_id", "created_at"
               ) VALUES (
                 $1::uuid, $2::uuid, 'STAFF', $3::uuid, $4,
                 'ENROLLMENT_CREATED', 'Enrollment', $5::uuid, 'INFO',
                 $6::jsonb, $7, $8::timestamptz
               )`,
              [
                crypto.randomUUID(),
                principal.centerId,
                principal.staffId,
                principal.role,
                created.id,
                JSON.stringify({
                  enrollment_id: created.id,
                  student_id: studentId,
                  group_id: groupId,
                  status: initialStatus,
                  enrolled_at_date: enrolledAtDate,
                }),
                requestId,
                now.toISOString(),
              ],
            );

            return {
              statusCode: 201,
              body: mapEnrollmentRowToDto(created),
            };
          } catch (err: unknown) {
            if ((err as { code?: string }).code === '23505') {
              throw new ApiHttpException({
                statusCode: 409,
                errorCode: 'VALIDATION_ERROR',
                message: 'Student already has an active (TRIAL, ACTIVE, or FROZEN) enrollment in this group',
              });
            }
            throw err;
          }
        },
      },
    );

    return idemOutcome.body;
  }

  public async withdrawEnrollmentWithChurnReason(
    req: RequestWithCorrelationId,
    principal: AuthenticatedStaffPrincipal,
    rawEnrollmentId: string,
    rawBody: unknown,
  ): Promise<EnrollmentResponseDto> {
    const idempotencyKey = requireIdempotencyKeyHeader(req);
    const enrollmentId = assertValidUuid(rawEnrollmentId, 'enrollment_id');
    const obj = assertPlainObject(rawBody, [
      'left_at_date',
      'churn_reason_code',
      'churn_notes',
      'expected_version',
      'apply_retroactive_prorata_adjustment',
      'forgive_remaining_debt',
    ]);

    const leftAtDate = validateIsoDate(obj.left_at_date, 'left_at_date');
    const churnReasonCode = Number(obj.churn_reason_code);
    if (!Number.isInteger(churnReasonCode) || !ALLOWED_CHURN_REASONS.has(churnReasonCode)) {
      throw new ApiHttpException({
        statusCode: 400,
        errorCode: 'VALIDATION_ERROR',
        message: 'churn_reason_code is required and must be an integer in 1..5',
      });
    }
    let churnNotes: string | null = null;
    if (obj.churn_notes !== undefined && obj.churn_notes !== null) {
      if (typeof obj.churn_notes !== 'string' || obj.churn_notes.length > 500) {
        throw new ApiHttpException({
          statusCode: 400,
          errorCode: 'VALIDATION_ERROR',
          message: 'churn_notes must be a string up to 500 characters',
        });
      }
      churnNotes = obj.churn_notes.trim() || null;
    }
    const expectedVersion = resolveExpectedVersion(req, obj.expected_version);

    // 06.03 Policy Gate: retroactive invoice pro-rata/refund or automatic debt forgiveness is forbidden
    if (obj.apply_retroactive_prorata_adjustment === true || obj.forgive_remaining_debt === true) {
      throw new ApiHttpException({
        statusCode: 403,
        errorCode: 'POLICY_DECISION_NOT_CONFIRMED',
        message:
          'Retroactive invoice pro-rata adjustment or automatic debt forgiveness on withdrawal is gated by unconfirmed policy decisions (D03/D21/D22)',
      });
    }

    const requestId = req.requestId ?? resolveRequestId(req.headers['x-request-id']);
    const now = this.clock.now();

    const idemOutcome = await executeIdempotentOperation<EnrollmentResponseDto>(
      this.databaseService,
      {
        centerId: principal.centerId,
        actorStaffId: principal.staffId,
        operationType: 'WITHDRAW_ENROLLMENT',
        idempotencyKey,
        requestPayload: {
          enrollment_id: enrollmentId,
          left_at_date: leftAtDate,
          churn_reason_code: churnReasonCode,
          churn_notes: churnNotes,
          expected_version: expectedVersion,
        },
        handler: async (tx) => {
          const enrRes = await tx.query<{
            id: string;
            student_id: string;
            group_id: string;
            status: EnrollmentStatus;
            enrolled_at_date: unknown;
            primary_teacher_id: string;
            version: number;
          }>(
            `SELECT e."id"::text AS id,
                    e."student_id"::text AS student_id,
                    e."group_id"::text AS group_id,
                    e."status"::text AS status,
                    e."enrolled_at_date",
                    g."primary_teacher_id"::text AS primary_teacher_id,
                    e."version"
               FROM "enrollments" e
               JOIN "course_groups" g
                 ON g."id" = e."group_id"
                AND g."center_id" = e."center_id"
              WHERE e."id" = $1::uuid
                AND e."center_id" = $2::uuid
              FOR UPDATE OF e`,
            [enrollmentId, principal.centerId],
          );

          const before = enrRes.rows[0];
          if (!before) {
            throw new ApiHttpException({
              statusCode: 404,
              errorCode: 'NOT_FOUND',
              message: 'Enrollment not found in this center',
            });
          }

          if (before.status === 'LEFT') {
            throw new ApiHttpException({
              statusCode: 422,
              errorCode: 'VALIDATION_ERROR',
              message: 'Enrollment is already in LEFT status and cannot be withdrawn again',
            });
          }

          const enrolledDateStr = formatPgDate(before.enrolled_at_date) ?? '1970-01-01';
          if (leftAtDate < enrolledDateStr) {
            throw new ApiHttpException({
              statusCode: 422,
              errorCode: 'VALIDATION_ERROR',
              message: `left_at_date (${leftAtDate}) cannot be earlier than enrolled_at_date (${enrolledDateStr})`,
            });
          }

          const updated = await executeOptimisticUpdate<{
            id: string;
            student_id: string;
            group_id: string;
            status: EnrollmentStatus;
            enrolled_at_date: unknown;
            left_at_date: unknown;
            churn_reason_code: number | null;
            package_lessons_remaining: number | null;
            transferred_from_enrollment_id: string | null;
            version: number;
          }>(tx, {
            tableName: 'enrollments',
            entityName: 'Enrollment',
            id: enrollmentId,
            centerId: principal.centerId,
            expectedVersion,
            setClauseSql: `"status" = 'LEFT', "left_at_date" = $4::date, "churn_reason_code" = $5::smallint, "churn_attributed_teacher_id" = $6::uuid, "churn_notes" = $7`,
            additionalValues: [
              leftAtDate,
              churnReasonCode,
              before.primary_teacher_id,
              churnNotes,
            ],
          });

          // Snapshot student's lossless BigInt remaining debt without modifying or forgiving any invoice/ledger
          const debtSnapshotUzs = await this.queryStudentRemainingDebtSnapshotUzs(
            tx,
            principal.centerId,
            before.student_id,
          );

          await tx.query(
            `INSERT INTO "audit_logs" (
               "id", "center_id", "actor_type", "actor_id", "actor_role",
               "action", "entity_type", "entity_id", "severity",
               "before_redacted_json", "after_redacted_json", "request_id", "created_at"
             ) VALUES (
               $1::uuid, $2::uuid, 'STAFF', $3::uuid, $4,
               'ENROLLMENT_WITHDRAWN', 'Enrollment', $5::uuid, 'WARN',
               $6::jsonb, $7::jsonb, $8, $9::timestamptz
             )`,
            [
              crypto.randomUUID(),
              principal.centerId,
              principal.staffId,
              principal.role,
              enrollmentId,
              JSON.stringify({
                status: before.status,
                version: before.version,
              }),
              JSON.stringify({
                status: 'LEFT',
                left_at_date: leftAtDate,
                churn_reason_code: churnReasonCode,
                preserved_debt_snapshot_uzs: debtSnapshotUzs,
                version: Number(updated.version),
              }),
              requestId,
              now.toISOString(),
            ],
          );

          return {
            statusCode: 200,
            body: mapEnrollmentRowToDto(updated, debtSnapshotUzs),
          };
        },
      },
    );

    return idemOutcome.body;
  }

  public async transferStudentEnrollment(
    req: RequestWithCorrelationId,
    principal: AuthenticatedStaffPrincipal,
    rawEnrollmentId: string,
    rawBody: unknown,
  ): Promise<TransferEnrollmentResponseDto> {
    const idempotencyKey = requireIdempotencyKeyHeader(req);
    const sourceEnrollmentId = assertValidUuid(rawEnrollmentId, 'enrollment_id');
    const obj = assertPlainObject(rawBody, [
      'target_group_id',
      'effective_date',
      'target_status',
      'reason',
      'expected_version',
      'apply_unconfirmed_fee_adjustment',
      'debug_fail_after_close_old',
    ]);

    const targetGroupId = assertValidUuid(obj.target_group_id, 'target_group_id');
    const effectiveDate = validateIsoDate(obj.effective_date, 'effective_date');
    const targetStatusRaw =
      typeof obj.target_status === 'string' ? obj.target_status.trim().toUpperCase() : 'ACTIVE';
    if (!ALLOWED_INITIAL_STATUSES.has(targetStatusRaw)) {
      throw new ApiHttpException({
        statusCode: 400,
        errorCode: 'VALIDATION_ERROR',
        message: 'target_status must be TRIAL or ACTIVE',
      });
    }
    const targetStatus = targetStatusRaw as 'TRIAL' | 'ACTIVE';
    const reason = typeof obj.reason === 'string' ? obj.reason.trim() : '';
    if (reason.length < 3 || reason.length > 255) {
      throw new ApiHttpException({
        statusCode: 400,
        errorCode: 'VALIDATION_ERROR',
        message: 'reason must be between 3 and 255 characters',
      });
    }
    const expectedVersion = resolveExpectedVersion(req, obj.expected_version);

    if (obj.apply_unconfirmed_fee_adjustment === true) {
      throw new ApiHttpException({
        statusCode: 403,
        errorCode: 'POLICY_DECISION_NOT_CONFIRMED',
        message:
          'Automatic mid-cycle fee delta calculation on group transfer is gated by unconfirmed billing policy decisions (Stage 08)',
      });
    }

    const debugFail =
      this.config.nodeEnv === 'test' && obj.debug_fail_after_close_old === true;
    const requestId = req.requestId ?? resolveRequestId(req.headers['x-request-id']);
    const now = this.clock.now();

    const idemOutcome = await executeIdempotentOperation<TransferEnrollmentResponseDto>(
      this.databaseService,
      {
        centerId: principal.centerId,
        actorStaffId: principal.staffId,
        operationType: 'TRANSFER_STUDENT_ENROLLMENT',
        idempotencyKey,
        requestPayload: {
          source_enrollment_id: sourceEnrollmentId,
          target_group_id: targetGroupId,
          effective_date: effectiveDate,
          target_status: targetStatus,
          reason,
          expected_version: expectedVersion,
        },
        handler: async (tx) => {
          const srcRes = await tx.query<{
            id: string;
            student_id: string;
            group_id: string;
            status: EnrollmentStatus;
            enrolled_at_date: unknown;
            primary_teacher_id: string;
            version: number;
          }>(
            `SELECT e."id"::text AS id,
                    e."student_id"::text AS student_id,
                    e."group_id"::text AS group_id,
                    e."status"::text AS status,
                    e."enrolled_at_date",
                    g."primary_teacher_id"::text AS primary_teacher_id,
                    e."version"
               FROM "enrollments" e
               JOIN "course_groups" g
                 ON g."id" = e."group_id"
                AND g."center_id" = e."center_id"
              WHERE e."id" = $1::uuid
                AND e."center_id" = $2::uuid
              FOR UPDATE OF e`,
            [sourceEnrollmentId, principal.centerId],
          );

          const src = srcRes.rows[0];
          if (!src) {
            throw new ApiHttpException({
              statusCode: 404,
              errorCode: 'NOT_FOUND',
              message: 'Source enrollment not found in this center',
            });
          }

          if (src.status === 'LEFT') {
            throw new ApiHttpException({
              statusCode: 422,
              errorCode: 'VALIDATION_ERROR',
              message: 'Cannot transfer an enrollment that is already in LEFT status',
            });
          }

          if (src.group_id === targetGroupId) {
            throw new ApiHttpException({
              statusCode: 422,
              errorCode: 'VALIDATION_ERROR',
              message: 'target_group_id must be distinct from the current group_id',
            });
          }

          const srcEnrolledDate = formatPgDate(src.enrolled_at_date) ?? '1970-01-01';
          if (effectiveDate < srcEnrolledDate) {
            throw new ApiHttpException({
              statusCode: 422,
              errorCode: 'VALIDATION_ERROR',
              message: `effective_date (${effectiveDate}) cannot be earlier than source enrolled_at_date (${srcEnrolledDate})`,
            });
          }

          const tgtGrpRes = await tx.query<{
            id: string;
            status: string;
            billing_mode: BillingMode;
            lessons_per_cycle: number;
          }>(
            `SELECT "id"::text AS id,
                    "status"::text AS status,
                    "billing_mode"::text AS billing_mode,
                    "lessons_per_cycle"
               FROM "course_groups"
              WHERE "id" = $1::uuid
                AND "center_id" = $2::uuid
              FOR UPDATE`,
            [targetGroupId, principal.centerId],
          );
          const targetGroup = tgtGrpRes.rows[0];
          if (!targetGroup) {
            throw new ApiHttpException({
              statusCode: 404,
              errorCode: 'NOT_FOUND',
              message: 'Target course group not found in this center',
            });
          }
          if (targetGroup.status !== 'ACTIVE') {
            throw new ApiHttpException({
              statusCode: 422,
              errorCode: 'VALIDATION_ERROR',
              message: 'Target course group is ARCHIVED',
            });
          }

          // 1. Close old enrollment (status='LEFT', churn_reason_code=3 for schedule/group transfer), preserving all invoice/ledger references
          const closedRow = await executeOptimisticUpdate<{
            id: string;
            student_id: string;
            group_id: string;
            status: EnrollmentStatus;
            enrolled_at_date: unknown;
            left_at_date: unknown;
            churn_reason_code: number | null;
            package_lessons_remaining: number | null;
            transferred_from_enrollment_id: string | null;
            version: number;
          }>(tx, {
            tableName: 'enrollments',
            entityName: 'Enrollment',
            id: sourceEnrollmentId,
            centerId: principal.centerId,
            expectedVersion,
            setClauseSql: `"status" = 'LEFT', "left_at_date" = $4::date, "churn_reason_code" = 3, "churn_attributed_teacher_id" = $5::uuid, "churn_notes" = $6`,
            additionalValues: [effectiveDate, src.primary_teacher_id, `TRANSFER:${reason}`],
          });

          if (debugFail) {
            throw new Error('INJECTED_FAULT_AFTER_CLOSING_SOURCE_ENROLLMENT');
          }

          // 2. Create new linked enrollment in target group
          const newEnrollmentId = crypto.randomUUID();
          const packageLessonsRemaining =
            targetGroup.billing_mode === 'LESSON_PACKAGE_12'
              ? Number(targetGroup.lessons_per_cycle)
              : null;
          const activatedAtIso = targetStatus === 'ACTIVE' ? now.toISOString() : null;

          try {
            const newIns = await tx.query<{
              id: string;
              student_id: string;
              group_id: string;
              status: EnrollmentStatus;
              enrolled_at_date: unknown;
              left_at_date: unknown;
              churn_reason_code: number | null;
              package_lessons_remaining: number | null;
              transferred_from_enrollment_id: string | null;
              version: number;
            }>(
              `INSERT INTO "enrollments" (
                 "id", "center_id", "student_id", "group_id", "status",
                 "enrolled_at_date", "activated_at", "package_lessons_remaining",
                 "transferred_from_enrollment_id", "version", "created_at", "updated_at"
               ) VALUES (
                 $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5,
                 $6::date, $7::timestamptz, $8::int,
                 $9::uuid, 1, $10::timestamptz, $10::timestamptz
               )
               RETURNING "id"::text AS id,
                         "student_id"::text AS student_id,
                         "group_id"::text AS group_id,
                         "status"::text AS status,
                         "enrolled_at_date",
                         "left_at_date",
                         "churn_reason_code",
                         "package_lessons_remaining",
                         "transferred_from_enrollment_id"::text AS transferred_from_enrollment_id,
                         "version"`,
              [
                newEnrollmentId,
                principal.centerId,
                src.student_id,
                targetGroupId,
                targetStatus,
                effectiveDate,
                activatedAtIso,
                packageLessonsRemaining,
                sourceEnrollmentId,
                now.toISOString(),
              ],
            );

            const createdRow = newIns.rows[0];
            const debtSnapshotUzs = await this.queryStudentRemainingDebtSnapshotUzs(
              tx,
              principal.centerId,
              src.student_id,
            );

            await tx.query(
              `INSERT INTO "audit_logs" (
                 "id", "center_id", "actor_type", "actor_id", "actor_role",
                 "action", "entity_type", "entity_id", "severity",
                 "before_redacted_json", "after_redacted_json", "request_id", "created_at"
               ) VALUES (
                 $1::uuid, $2::uuid, 'STAFF', $3::uuid, $4,
                 'ENROLLMENT_TRANSFERRED', 'Enrollment', $5::uuid, 'INFO',
                 $6::jsonb, $7::jsonb, $8, $9::timestamptz
               )`,
              [
                crypto.randomUUID(),
                principal.centerId,
                principal.staffId,
                principal.role,
                newEnrollmentId,
                JSON.stringify({
                  closed_enrollment_id: sourceEnrollmentId,
                  from_group_id: src.group_id,
                  previous_status: src.status,
                }),
                JSON.stringify({
                  closed_enrollment_id: sourceEnrollmentId,
                  new_enrollment_id: newEnrollmentId,
                  to_group_id: targetGroupId,
                  effective_date: effectiveDate,
                  preserved_debt_snapshot_uzs: debtSnapshotUzs,
                }),
                requestId,
                now.toISOString(),
              ],
            );

            return {
              statusCode: 200,
              body: Object.freeze({
                closed_enrollment: mapEnrollmentRowToDto(closedRow, debtSnapshotUzs),
                new_enrollment: mapEnrollmentRowToDto(createdRow, debtSnapshotUzs),
                preserved_debt_snapshot_uzs: debtSnapshotUzs,
              }),
            };
          } catch (err: unknown) {
            if ((err as { code?: string }).code === '23505') {
              throw new ApiHttpException({
                statusCode: 409,
                errorCode: 'VALIDATION_ERROR',
                message: 'Student already has an active enrollment in target_group_id',
              });
            }
            throw err;
          }
        },
      },
    );

    return idemOutcome.body;
  }
}
