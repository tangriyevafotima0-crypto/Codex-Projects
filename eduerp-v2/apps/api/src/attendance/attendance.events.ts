import * as crypto from 'node:crypto';
import type { AttendanceStatus } from '@eduerp/contracts';
import { TransactionContext } from '../database/transaction';

export interface EmitAttendanceSubmittedParams {
  readonly centerId: string;
  readonly lessonId: string;
  readonly groupId: string;
  readonly lessonDate: string;
  readonly occurrenceSeq: number;
  readonly aggregateVersion: number;
  readonly clientOperationUuid: string;
  readonly submittedByStaffId: string;
  readonly absentStudentIds: readonly string[];
  readonly lateStudentIds: readonly string[];
  readonly presentTrialEnrollmentIds: readonly string[];
  readonly occurredAtUtc: Date;
}

export interface EmitAttendanceCorrectedParams {
  readonly centerId: string;
  readonly attendanceRecordId: string;
  readonly revisionVersion: number;
  readonly lessonId: string;
  readonly studentId: string;
  readonly enrollmentId: string;
  readonly previousStatus: AttendanceStatus;
  readonly newStatus: AttendanceStatus;
  readonly overrideReason: string;
  readonly actorStaffId: string;
  readonly requiresTrialCompensationReview: boolean;
  readonly occurredAtUtc: Date;
}

export async function emitAttendanceSubmittedOutboxEventInTx(
  tx: TransactionContext,
  params: EmitAttendanceSubmittedParams,
): Promise<string> {
  const eventId = crypto.randomUUID();
  const dedupKey = `AttendanceSubmitted:${params.lessonId}:v${params.aggregateVersion}`;

  await tx.query(
    `INSERT INTO "outbox_events" (
       "id",
       "center_id",
       "event_name",
       "schema_version",
       "aggregate_type",
       "aggregate_id",
       "aggregate_version",
       "dedup_key",
       "payload_json",
       "status",
       "lease_token",
       "occurred_at_utc",
       "next_attempt_at",
       "updated_at"
     ) VALUES (
       $1::uuid,
       $2::uuid,
       'AttendanceSubmitted',
       1,
       'LessonOccurrence',
       $3::uuid,
       $4::int,
       $5,
       $6::jsonb,
       'PENDING',
       0,
       $7::timestamptz,
       $7::timestamptz,
       $7::timestamptz
     )`,
    [
      eventId,
      params.centerId,
      params.lessonId,
      params.aggregateVersion,
      dedupKey,
      JSON.stringify({
        lesson_id: params.lessonId,
        group_id: params.groupId,
        lesson_date: params.lessonDate,
        occurrence_seq: params.occurrenceSeq,
        client_operation_uuid: params.clientOperationUuid,
        submitted_by_staff_id: params.submittedByStaffId,
        absent_student_ids: params.absentStudentIds,
        late_student_ids: params.lateStudentIds,
        present_trial_enrollment_ids: params.presentTrialEnrollmentIds,
      }),
      params.occurredAtUtc.toISOString(),
    ],
  );

  return eventId;
}

export async function emitAttendanceCorrectedOutboxEventInTx(
  tx: TransactionContext,
  params: EmitAttendanceCorrectedParams,
): Promise<string> {
  const eventId = crypto.randomUUID();
  const dedupKey = `AttendanceCorrected:${params.attendanceRecordId}:v${params.revisionVersion}`;

  await tx.query(
    `INSERT INTO "outbox_events" (
       "id",
       "center_id",
       "event_name",
       "schema_version",
       "aggregate_type",
       "aggregate_id",
       "aggregate_version",
       "dedup_key",
       "payload_json",
       "status",
       "lease_token",
       "occurred_at_utc",
       "next_attempt_at",
       "updated_at"
     ) VALUES (
       $1::uuid,
       $2::uuid,
       'AttendanceCorrected',
       1,
       'AttendanceRecord',
       $3::uuid,
       $4::int,
       $5,
       $6::jsonb,
       'PENDING',
       0,
       $7::timestamptz,
       $7::timestamptz,
       $7::timestamptz
     )`,
    [
      eventId,
      params.centerId,
      params.attendanceRecordId,
      params.revisionVersion,
      dedupKey,
      JSON.stringify({
        attendance_record_id: params.attendanceRecordId,
        revision_version: params.revisionVersion,
        lesson_id: params.lessonId,
        student_id: params.studentId,
        enrollment_id: params.enrollmentId,
        previous_status: params.previousStatus,
        new_status: params.newStatus,
        override_reason: params.overrideReason,
        actor_staff_id: params.actorStaffId,
        requires_trial_compensation_review: params.requiresTrialCompensationReview,
      }),
      params.occurredAtUtc.toISOString(),
    ],
  );

  return eventId;
}
