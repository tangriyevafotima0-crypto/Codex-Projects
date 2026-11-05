import type {
  AttendanceSourceChannel,
  AttendanceStatus,
  OfflineAttendanceAckStatus,
} from '@eduerp/contracts';
import { ApiHttpException } from '../auth/auth.errors';
import {
  assertPlainObject,
  assertValidUuid,
  resolveExpectedVersion,
} from '../auth/validation';
import { RequestWithCorrelationId } from '../common/request-id.middleware';
import { parseOptionalStrictBoolean } from '../students/normalization';

const FORBIDDEN_ACTOR_KEYS: ReadonlySet<string> = new Set([
  'role', 'actor_role', 'actor_id', 'actor_staff_id', 'staff_id',
  'recorded_by_staff_id', 'center_id', 'principal', 'license_mode',
]);

function assertNoActorSpoofingKeys(body: Record<string, unknown>): void {
  for (const key of Object.keys(body)) {
    if (FORBIDDEN_ACTOR_KEYS.has(key.toLowerCase())) {
      throw new ApiHttpException({
        statusCode: 403,
        errorCode: 'FORBIDDEN_ROLE',
        message: 'Actor identity and permissions must come from the authenticated session',
      });
    }
  }
}

export type AttendanceFaultInjectionStep =
  | 'ATTENDANCE_RECORD_WRITE'
  | 'ATTENDANCE_REVISION_INSERT'
  | 'TRIAL_EVALUATION'
  | 'AUDIT_LOG'
  | 'OUTBOX_EVENT';

export const ALLOWED_ATTENDANCE_STATUSES: ReadonlySet<AttendanceStatus> =
  new Set<AttendanceStatus>(['PRESENT', 'LATE', 'ABSENT']);

export const ALLOWED_ATTENDANCE_CHANNELS: ReadonlySet<AttendanceSourceChannel> =
  new Set<AttendanceSourceChannel>([
    'TEACHER_MOBILE',
    'TEACHER_WEB',
    'ADMIN_EXCEL',
    'ADMIN_OVERRIDE',
  ]);

export interface AttendanceRecordInputItem {
  readonly studentId: string;
  readonly status: AttendanceStatus;
}

export interface ValidatedSubmitAttendanceInput {
  readonly lessonId: string;
  readonly clientOperationUuid: string;
  readonly expectedVersion: number;
  readonly sourceChannel: AttendanceSourceChannel | null;
  readonly overrideReason: string | null;
  readonly records: readonly AttendanceRecordInputItem[];
}

export interface ValidatedOfflineSyncOperationInput {
  readonly lessonId: string;
  readonly clientOperationUuid: string;
  readonly expectedVersion: number;
  readonly sourceChannel: AttendanceSourceChannel | null;
  readonly overrideReason: string | null;
  readonly records: readonly AttendanceRecordInputItem[];
}

export interface ValidatedOfflineSyncBatchInput {
  readonly operations: readonly ValidatedOfflineSyncOperationInput[];
}

export interface AttendanceSubmittedRecordItemDto {
  readonly attendance_record_id: string;
  readonly student_id: string;
  readonly enrollment_id: string;
  readonly status: AttendanceStatus;
  readonly is_excused_frozen: boolean;
  readonly source_channel: AttendanceSourceChannel;
  readonly recorded_by_staff_id: string;
  readonly override_reason: string | null;
  readonly version: number;
}

export interface AttendanceRevisionItemDto {
  readonly revision_id: string;
  readonly attendance_record_id: string;
  readonly student_id: string;
  readonly revision_version: number;
  readonly previous_status: AttendanceStatus | null;
  readonly new_status: AttendanceStatus;
  readonly source_channel: AttendanceSourceChannel;
  readonly actor_staff_id: string;
  readonly reason: string | null;
  readonly client_operation_uuid: string;
  readonly created_at_utc: string;
}

export interface AttendanceDraftStudentItemDto {
  readonly student_id: string;
  readonly enrollment_id: string;
  readonly student_code: string;
  readonly full_name: string;
  readonly enrollment_status: 'TRIAL' | 'ACTIVE' | 'FROZEN';
  readonly is_frozen_for_lesson: boolean;
  readonly draft_default_status: 'PRESENT';
  readonly submitted_status: AttendanceStatus | null;
  readonly is_excused_frozen: boolean;
  readonly attendance_record_id: string | null;
  readonly record_version: number | null;
  readonly source_channel: AttendanceSourceChannel | null;
}

export interface LessonAttendanceDraftResponseDto {
  readonly lesson_id: string;
  readonly group_id: string;
  readonly lesson_date: string;
  readonly occurrence_seq: number;
  readonly lesson_status: string;
  readonly is_submitted: boolean;
  readonly current_version: number;
  readonly roster: readonly AttendanceDraftStudentItemDto[];
  readonly revisions: readonly AttendanceRevisionItemDto[];
}

export interface AttendanceSubmitResponseDto {
  readonly lesson_id: string;
  readonly client_operation_uuid: string;
  readonly new_version: number;
  readonly submitted_at_utc: string;
  readonly trial_activations_triggered: number;
  readonly records: readonly AttendanceSubmittedRecordItemDto[];
}

export interface OfflineAttendanceSyncItemResultDto {
  readonly client_operation_uuid: string;
  readonly lesson_id: string;
  readonly ack_status: OfflineAttendanceAckStatus;
  readonly server_version: number | null;
  readonly error_code: string | null;
  readonly conflict_details?: Record<string, unknown> | null;
}

export interface OfflineAttendanceBatchSyncResponseDto {
  readonly results: readonly OfflineAttendanceSyncItemResultDto[];
}

function parseAttendanceRecordsArray(
  rawRecords: unknown,
  fieldPrefix = 'records',
): readonly AttendanceRecordInputItem[] {
  if (!Array.isArray(rawRecords) || rawRecords.length === 0) {
    throw new ApiHttpException({
      statusCode: 400,
      errorCode: 'VALIDATION_ERROR',
      message: `${fieldPrefix} must be a non-empty array of { student_id, status } items`,
    });
  }
  if (rawRecords.length > 200) {
    throw new ApiHttpException({
      statusCode: 400,
      errorCode: 'VALIDATION_ERROR',
      message: `${fieldPrefix} cannot exceed 200 student items per lesson`,
    });
  }

  const seenStudentIds = new Set<string>();
  const parsedItems: AttendanceRecordInputItem[] = [];

  for (let i = 0; i < rawRecords.length; i += 1) {
    if (typeof rawRecords[i] === 'object' && rawRecords[i] !== null && !Array.isArray(rawRecords[i])) {
      assertNoActorSpoofingKeys(rawRecords[i] as Record<string, unknown>);
    }
    const item = assertPlainObject(
      rawRecords[i],
      ['student_id', 'status'],
    );
    const studentId = assertValidUuid(item.student_id, `${fieldPrefix}[${i}].student_id`);
    if (seenStudentIds.has(studentId)) {
      throw new ApiHttpException({
        statusCode: 422,
        errorCode: 'VALIDATION_ERROR',
        message: `Duplicate student_id ${studentId} in ${fieldPrefix} (T12.01)`,
      });
    }
    seenStudentIds.add(studentId);

    const statusRaw =
      typeof item.status === 'string' ? item.status.trim().toUpperCase() : '';
    if (!ALLOWED_ATTENDANCE_STATUSES.has(statusRaw as AttendanceStatus)) {
      throw new ApiHttpException({
        statusCode: 400,
        errorCode: 'VALIDATION_ERROR',
        message: `${fieldPrefix}[${i}].status must be PRESENT, LATE, or ABSENT`,
      });
    }

    parsedItems.push(
      Object.freeze({
        studentId,
        status: statusRaw as AttendanceStatus,
      }),
    );
  }

  parsedItems.sort((a, b) => (a.studentId < b.studentId ? -1 : a.studentId > b.studentId ? 1 : 0));
  return Object.freeze(parsedItems);
}

export function validateSubmitAttendanceInput(
  req: RequestWithCorrelationId,
  rawLessonId: unknown,
  rawBody: unknown,
): ValidatedSubmitAttendanceInput {
  const lessonId = assertValidUuid(rawLessonId, 'lesson_id');
  if (typeof rawBody === 'object' && rawBody !== null && !Array.isArray(rawBody)) {
    assertNoActorSpoofingKeys(rawBody as Record<string, unknown>);
  }
  const obj = assertPlainObject(rawBody, [
    'client_operation_uuid',
    'expected_version',
    'override_reason',
    'source_channel',
    'records',
    'auto_compensate_trial_invoice',
    'void_activated_trial_invoice',
  ]);

  const autoCompensateTrial = parseOptionalStrictBoolean(
    obj.auto_compensate_trial_invoice,
    'auto_compensate_trial_invoice',
    false,
  );
  const voidTrialInvoice = parseOptionalStrictBoolean(
    obj.void_activated_trial_invoice,
    'void_activated_trial_invoice',
    false,
  );
  if (autoCompensateTrial || voidTrialInvoice) {
    throw new ApiHttpException({
      statusCode: 403,
      errorCode: 'POLICY_DECISION_NOT_CONFIRMED',
      message:
        'Automatic financial voiding or compensation of an already-activated trial invoice on attendance correction is not confirmed; historical invoices and ledger entries remain immutable (12.04)',
    });
  }

  const clientOperationUuid = assertValidUuid(
    obj.client_operation_uuid,
    'client_operation_uuid',
  );
  const expectedVersion = resolveExpectedVersion(req, obj.expected_version);

  let sourceChannel: AttendanceSourceChannel | null = null;
  if (obj.source_channel !== undefined && obj.source_channel !== null) {
    const chRaw =
      typeof obj.source_channel === 'string' ? obj.source_channel.trim().toUpperCase() : '';
    if (!ALLOWED_ATTENDANCE_CHANNELS.has(chRaw as AttendanceSourceChannel)) {
      throw new ApiHttpException({
        statusCode: 400,
        errorCode: 'VALIDATION_ERROR',
        message:
          'source_channel must be TEACHER_MOBILE, TEACHER_WEB, ADMIN_EXCEL, or ADMIN_OVERRIDE',
      });
    }
    sourceChannel = chRaw as AttendanceSourceChannel;
  }

  let overrideReason: string | null = null;
  if (obj.override_reason !== undefined && obj.override_reason !== null) {
    if (typeof obj.override_reason !== 'string' || obj.override_reason.length > 500) {
      throw new ApiHttpException({
        statusCode: 400,
        errorCode: 'VALIDATION_ERROR',
        message: 'override_reason must be a string up to 500 characters',
      });
    }
    overrideReason = obj.override_reason.trim() || null;
  }

  const records = parseAttendanceRecordsArray(obj.records, 'records');

  return Object.freeze({
    lessonId,
    clientOperationUuid,
    expectedVersion,
    sourceChannel,
    overrideReason,
    records,
  });
}

export function validateOfflineSyncBatchInput(rawBody: unknown): ValidatedOfflineSyncBatchInput {
  if (typeof rawBody === 'object' && rawBody !== null && !Array.isArray(rawBody)) {
    assertNoActorSpoofingKeys(rawBody as Record<string, unknown>);
  }
  const obj = assertPlainObject(rawBody, ['operations']);
  if (!Array.isArray(obj.operations) || obj.operations.length === 0 || obj.operations.length > 100) {
    throw new ApiHttpException({
      statusCode: 400,
      errorCode: 'VALIDATION_ERROR',
      message: 'operations must be an array of 1 to 100 offline attendance operations',
    });
  }

  const operations: ValidatedOfflineSyncOperationInput[] = [];
  for (let i = 0; i < obj.operations.length; i += 1) {
    if (typeof obj.operations[i] === 'object' && obj.operations[i] !== null && !Array.isArray(obj.operations[i])) {
      assertNoActorSpoofingKeys(obj.operations[i] as Record<string, unknown>);
    }
    const opObj = assertPlainObject(
      obj.operations[i],
      [
        'lesson_id',
        'client_operation_uuid',
        'expected_version',
        'source_channel',
        'override_reason',
        'records',
      ],
    );
    const lessonId = assertValidUuid(opObj.lesson_id, `operations[${i}].lesson_id`);
    const clientOperationUuid = assertValidUuid(
      opObj.client_operation_uuid,
      `operations[${i}].client_operation_uuid`,
    );

    if (
      typeof opObj.expected_version !== 'number' ||
      !Number.isInteger(opObj.expected_version) ||
      opObj.expected_version < 1
    ) {
      throw new ApiHttpException({
        statusCode: 400,
        errorCode: 'VALIDATION_ERROR',
        message: `operations[${i}].expected_version must be an integer >= 1`,
      });
    }

    let sourceChannel: AttendanceSourceChannel | null = null;
    if (opObj.source_channel !== undefined && opObj.source_channel !== null) {
      const chRaw =
        typeof opObj.source_channel === 'string'
          ? opObj.source_channel.trim().toUpperCase()
          : '';
      if (!ALLOWED_ATTENDANCE_CHANNELS.has(chRaw as AttendanceSourceChannel)) {
        throw new ApiHttpException({
          statusCode: 400,
          errorCode: 'VALIDATION_ERROR',
          message: `operations[${i}].source_channel must be TEACHER_MOBILE, TEACHER_WEB, ADMIN_EXCEL, or ADMIN_OVERRIDE`,
        });
      }
      sourceChannel = chRaw as AttendanceSourceChannel;
    }

    let overrideReason: string | null = null;
    if (opObj.override_reason !== undefined && opObj.override_reason !== null) {
      if (typeof opObj.override_reason !== 'string' || opObj.override_reason.length > 500) {
        throw new ApiHttpException({
          statusCode: 400,
          errorCode: 'VALIDATION_ERROR',
          message: `operations[${i}].override_reason must be a string up to 500 characters`,
        });
      }
      overrideReason = opObj.override_reason.trim() || null;
    }

    const records = parseAttendanceRecordsArray(
      opObj.records,
      `operations[${i}].records`,
    );

    operations.push(
      Object.freeze({
        lessonId,
        clientOperationUuid,
        expectedVersion: opObj.expected_version,
        sourceChannel,
        overrideReason,
        records,
      }),
    );
  }

  return Object.freeze({
    operations: Object.freeze(operations),
  });
}
