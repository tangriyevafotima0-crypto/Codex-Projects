import { Injectable } from '@nestjs/common';
import type {
  AttendanceSourceChannel,
  AttendanceStatus,
  StaffRole,
} from '@eduerp/contracts';
import { ApiHttpException } from '../auth/auth.errors';
import { AttendanceRecordInputItem } from './dto';

export interface ExistingAttendanceRecordSnapshot {
  readonly id: string;
  readonly studentId: string;
  readonly enrollmentId: string;
  readonly status: AttendanceStatus;
  readonly isExcusedFrozen: boolean;
  readonly sourceChannel: AttendanceSourceChannel;
  readonly recordedByStaffId: string;
  readonly overrideReason: string | null;
  readonly version: number;
}

export interface EvaluatedAttendanceWritePlan {
  readonly mode: 'INITIAL_SUBMIT' | 'ADMIN_OVERRIDE';
  readonly resolvedSourceChannel: AttendanceSourceChannel;
  readonly normalizedOverrideReason: string | null;
  readonly nextRecordVersion: number;
}

export function evaluateAttendanceWriteConflict(params: {
  readonly lessonId: string;
  readonly actorRole: StaffRole;
  readonly requestedSourceChannel: AttendanceSourceChannel | null;
  readonly overrideReason: string | null;
  readonly expectedVersion: number;
  readonly currentLessonAttendanceVersion?: number;
  readonly existingRecords: readonly ExistingAttendanceRecordSnapshot[];
  readonly incomingRecords: readonly AttendanceRecordInputItem[];
}): EvaluatedAttendanceWritePlan {
  const {
    lessonId,
    actorRole,
    requestedSourceChannel,
    overrideReason,
    expectedVersion,
    existingRecords,
    incomingRecords,
  } = params;

  const cleanReason =
    overrideReason !== null && overrideReason.trim().length > 0
      ? overrideReason.trim()
      : null;

  let resolvedSourceChannel: AttendanceSourceChannel;

  if (actorRole === 'TEACHER') {
    if (
      requestedSourceChannel === 'ADMIN_OVERRIDE' ||
      requestedSourceChannel === 'ADMIN_EXCEL' ||
      cleanReason !== null
    ) {
      throw new ApiHttpException({
        statusCode: 403,
        errorCode: 'FORBIDDEN_ROLE',
        message:
          'TEACHER role is not permitted to perform ADMIN_OVERRIDE or ADMIN_EXCEL attendance operations (T12.03)',
      });
    }
    resolvedSourceChannel = requestedSourceChannel ?? 'TEACHER_WEB';
  } else if (actorRole === 'ADMIN' || actorRole === 'DIRECTOR') {
    if (
      requestedSourceChannel === 'TEACHER_WEB' ||
      requestedSourceChannel === 'TEACHER_MOBILE'
    ) {
      throw new ApiHttpException({
        statusCode: 403,
        errorCode: 'FORBIDDEN_ROLE',
        message:
          'ADMIN/DIRECTOR cannot impersonate TEACHER_WEB or TEACHER_MOBILE attendance source channels (12.01 / 12.03)',
      });
    }
    resolvedSourceChannel = requestedSourceChannel ?? 'ADMIN_OVERRIDE';
  } else {
    throw new ApiHttpException({
      statusCode: 403,
      errorCode: 'FORBIDDEN_ROLE',
      message: 'Unsupported staff role for attendance submission',
    });
  }

  const maxRecordVersion =
    existingRecords.length > 0
      ? Math.max(...existingRecords.map((r) => r.version))
      : 0;
  const currentVersion =
    existingRecords.length > 0
      ? Math.max(params.currentLessonAttendanceVersion ?? 0, maxRecordVersion)
      : 0;

  if (resolvedSourceChannel === 'ADMIN_EXCEL') {
    if (existingRecords.length > 0 || expectedVersion !== 1) {
      const existingByStudent = new Map(
        existingRecords.map((r) => [r.studentId, r]),
      );
      const staleRows = incomingRecords.map((inc) => {
        const srv = existingByStudent.get(inc.studentId);
        return {
          student_id: inc.studentId,
          excel_status: inc.status,
          server_status: srv?.status ?? null,
          server_source_channel: srv?.sourceChannel ?? null,
          server_record_version: srv?.version ?? null,
        };
      });

      const effectiveServerVersion =
        existingRecords.length > 0 ? currentVersion : 0;

      throw new ApiHttpException({
        statusCode: 409,
        errorCode: 'STALE_EXCEL_CONFLICT',
        message: `Stale Excel attendance payload (excel_version=${expectedVersion}) rejected because server attendance is at version ${effectiveServerVersion}; confirmed Teacher attendance cannot be overwritten by Excel import (CASE-21, BR-11, T12.03)`,
        conflictDetails: {
          lesson_id: lessonId,
          excel_version: expectedVersion,
          server_version: effectiveServerVersion,
          current_record_version: currentVersion,
          stale_rows: staleRows,
        },
      });
    }

    return Object.freeze({
      mode: 'INITIAL_SUBMIT',
      resolvedSourceChannel: 'ADMIN_EXCEL',
      normalizedOverrideReason: null,
      nextRecordVersion: 1,
    });
  }

  if (existingRecords.length === 0) {
    if (actorRole !== 'TEACHER') {
      throw new ApiHttpException({
        statusCode: 422,
        errorCode: 'VALIDATION_ERROR',
        message:
          'ADMIN_OVERRIDE requires existing confirmed Teacher attendance on the lesson; Admin cannot bypass initial Teacher attendance confirmation (12.01 / 12.03)',
      });
    }

    if (expectedVersion !== 1) {
      throw new ApiHttpException({
        statusCode: 409,
        errorCode: 'VERSION_CONFLICT',
        message: `Initial attendance submission requires expected_version = 1 (got ${expectedVersion})`,
        conflictDetails: {
          lesson_id: lessonId,
          expected_version: expectedVersion,
          server_version: 1,
        },
      });
    }

    return Object.freeze({
      mode: 'INITIAL_SUBMIT',
      resolvedSourceChannel,
      normalizedOverrideReason: null,
      nextRecordVersion: 1,
    });
  }

  if (actorRole === 'TEACHER') {
    throw new ApiHttpException({
      statusCode: 409,
      errorCode: 'VERSION_CONFLICT',
      message: `Attendance for lesson ${lessonId} is already confirmed (version ${currentVersion}); post-confirmation modifications require an ADMIN_OVERRIDE with reason (T12.03)`,
      conflictDetails: {
        lesson_id: lessonId,
        expected_version: expectedVersion,
        server_version: currentVersion,
      },
    });
  }

  if (!cleanReason || cleanReason.length < 3) {
    throw new ApiHttpException({
      statusCode: 422,
      errorCode: 'VALIDATION_ERROR',
      message:
        'override_reason (at least 3 characters) is mandatory when overriding confirmed Teacher attendance (BR-11, T12.03)',
    });
  }

  if (expectedVersion !== currentVersion) {
    throw new ApiHttpException({
      statusCode: 409,
      errorCode: 'VERSION_CONFLICT',
      message: `Optimistic version conflict on lesson ${lessonId} attendance override: expected_version=${expectedVersion}, server_version=${currentVersion}`,
      conflictDetails: {
        lesson_id: lessonId,
        expected_version: expectedVersion,
        server_version: currentVersion,
      },
    });
  }

  return Object.freeze({
    mode: 'ADMIN_OVERRIDE',
    resolvedSourceChannel: 'ADMIN_OVERRIDE',
    normalizedOverrideReason: cleanReason,
    nextRecordVersion: currentVersion + 1,
  });
}

@Injectable()
export class ConflictsService {
  public evaluateWriteConflict(
    params: Parameters<typeof evaluateAttendanceWriteConflict>[0],
  ): EvaluatedAttendanceWritePlan {
    return evaluateAttendanceWriteConflict(params);
  }
}
