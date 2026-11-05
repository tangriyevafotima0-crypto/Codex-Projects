import { Inject, Injectable } from '@nestjs/common';
import { ApiHttpException } from '../auth/auth.errors';
import { AuthenticatedStaffPrincipal } from '../auth/permissions.guard';
import { requireIdempotencyKeyHeader } from '../auth/validation';
import { RequestWithCorrelationId, resolveRequestId } from '../common/request-id.middleware';
import { DatabaseService } from '../database/database.service';
import { AttendanceService } from './attendance.service';
import {
  OfflineAttendanceBatchSyncResponseDto,
  OfflineAttendanceSyncItemResultDto,
  validateOfflineSyncBatchInput,
} from './dto';

@Injectable()
export class SyncService {
  constructor(
    @Inject(DatabaseService) private readonly databaseService: DatabaseService,
    @Inject(AttendanceService)
    private readonly attendanceService: AttendanceService,
  ) {}

  public async syncOfflineAttendanceBatch(
    req: RequestWithCorrelationId,
    principal: AuthenticatedStaffPrincipal,
    rawBody: unknown,
  ): Promise<OfflineAttendanceBatchSyncResponseDto> {
    const batchIdempotencyKey = requireIdempotencyKeyHeader(req);
    const requestId = req.requestId ?? resolveRequestId(req.headers['x-request-id']);
    const parsedBatch = validateOfflineSyncBatchInput(rawBody);

    const staffRes = await this.databaseService.query<{
      role: string;
      status: string;
    }>(
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

    const results: OfflineAttendanceSyncItemResultDto[] = [];

    for (let i = 0; i < parsedBatch.operations.length; i += 1) {
      const op = parsedBatch.operations[i];
      const itemIdemKey = `offline-op-${op.clientOperationUuid}`;

      const preCheckRes = await this.databaseService.query<{
        request_body_sha256: string;
      }>(
        `SELECT "request_body_sha256"
           FROM "client_operation_logs"
          WHERE "center_id" = $1::uuid
            AND "actor_id" = $2::uuid
            AND "operation_type" = 'ATTENDANCE_CLIENT_OP_UUID'
            AND "client_operation_uuid" = $3::uuid
          LIMIT 1`,
        [principal.centerId, principal.staffId, op.clientOperationUuid],
      );
      const existedBeforeCall = Boolean(preCheckRes.rows[0]);

      try {
        const outcome =
          await this.attendanceService.executeValidatedAttendanceOperation(
            principal,
            {
              lessonId: op.lessonId,
              clientOperationUuid: op.clientOperationUuid,
              expectedVersion: op.expectedVersion,
              sourceChannel:
                op.sourceChannel ??
                (principal.role === 'TEACHER' ? 'TEACHER_MOBILE' : 'ADMIN_OVERRIDE'),
              overrideReason: op.overrideReason,
              records: op.records,
            },
            {
              httpIdempotencyKey: itemIdemKey,
              requestId: `${requestId}:op:${i}:${batchIdempotencyKey.slice(0, 16)}`,
            },
          );

        results.push(
          Object.freeze({
            client_operation_uuid: op.clientOperationUuid,
            lesson_id: op.lessonId,
            ack_status:
              outcome.replayed || existedBeforeCall
                ? ('ACK_IDEMPOTENT_REPLAY' as const)
                : ('ACK_COMMITTED' as const),
            server_version: outcome.body.new_version,
            error_code: null,
            conflict_details: null,
          }),
        );
      } catch (err: unknown) {
        if (err instanceof ApiHttpException) {
          if (err.statusCode === 409) {
            const conflictDetails =
              (err.conflictDetails as Record<string, unknown> | undefined) ?? null;
            const srvVer =
              conflictDetails && typeof conflictDetails.server_version === 'number'
                ? conflictDetails.server_version
                : null;
            results.push(
              Object.freeze({
                client_operation_uuid: op.clientOperationUuid,
                lesson_id: op.lessonId,
                ack_status: 'CONFLICT_409',
                server_version: srvVer,
                error_code: err.errorCode,
                conflict_details: conflictDetails,
              }),
            );
            continue;
          }
          if (err.errorCode === 'LICENSE_READ_ONLY_MODE') {
            results.push(
              Object.freeze({
                client_operation_uuid: op.clientOperationUuid,
                lesson_id: op.lessonId,
                ack_status: 'BLOCKED_LICENSE_READ_ONLY',
                server_version: null,
                error_code: 'LICENSE_READ_ONLY_MODE',
                conflict_details: null,
              }),
            );
            continue;
          }
          if (err.statusCode === 403 || err.statusCode === 404 || err.statusCode === 422) {
            results.push(
              Object.freeze({
                client_operation_uuid: op.clientOperationUuid,
                lesson_id: op.lessonId,
                ack_status: 'FORBIDDEN_PERMISSION_REVOKED',
                server_version: null,
                error_code: err.errorCode,
                conflict_details: null,
              }),
            );
            continue;
          }
        }
        throw err;
      }
    }

    return Object.freeze({
      results: Object.freeze(results),
    });
  }
}
