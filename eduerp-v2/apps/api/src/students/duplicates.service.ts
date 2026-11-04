import { Inject, Injectable } from '@nestjs/common';
import { ApiHttpException } from '../auth/auth.errors';
import { AuthenticatedStaffPrincipal } from '../auth/permissions.guard';
import { assertValidUuid } from '../auth/validation';
import { DatabaseService } from '../database/database.service';
import { TransactionContext } from '../database/transaction';
import { normalizePersonName, normalizePhoneE164 } from './normalization';

export type DuplicateMatchReason =
  | 'EXACT_NORMALIZED_NAME_AND_GUARDIAN_PHONE'
  | 'SAME_NORMALIZED_NAME_DIFFERENT_PHONE'
  | 'SHARED_GUARDIAN_PHONE_SIBLING';

export interface DuplicateCandidateWarningDto {
  readonly student_id: string;
  readonly student_code: string;
  readonly full_name: string;
  readonly status: 'ACTIVE' | 'ARCHIVED';
  readonly match_reason: DuplicateMatchReason;
  readonly is_blocking_without_confirmation: boolean;
}

export interface DuplicateCheckResponseDto {
  readonly normalized_student_name: string;
  readonly normalized_guardian_phone_e164: string | null;
  readonly has_blocking_duplicate: boolean;
  readonly sibling_shared_phone_detected: boolean;
  readonly candidates: readonly DuplicateCandidateWarningDto[];
}

type QueryExecutor = Pick<DatabaseService, 'query'> | Pick<TransactionContext, 'query'>;

@Injectable()
export class DuplicatesService {
  constructor(@Inject(DatabaseService) private readonly databaseService: DatabaseService) {}

  public async findDuplicateCandidates(
    executor: QueryExecutor,
    params: {
      readonly centerId: string;
      readonly normalizedStudentName: string;
      readonly guardianPhoneE164?: string | null;
      readonly excludeStudentId?: string | null;
    },
  ): Promise<DuplicateCheckResponseDto> {
    const phone = params.guardianPhoneE164 ?? null;
    const excludeId = params.excludeStudentId ?? null;

    const res = await executor.query<{
      student_id: string;
      student_code: string;
      full_name: string;
      normalized_name: string;
      status: 'ACTIVE' | 'ARCHIVED';
      shares_phone: boolean;
    }>(
      `SELECT s."id"::text AS student_id,
              s."student_code" AS student_code,
              s."full_name" AS full_name,
              s."normalized_name" AS normalized_name,
              s."status"::text AS status,
              EXISTS (
                SELECT 1
                  FROM "guardian_students" gs
                  JOIN "guardians" g
                    ON g."id" = gs."guardian_id"
                   AND g."center_id" = gs."center_id"
                 WHERE gs."center_id" = s."center_id"
                   AND gs."student_id" = s."id"
                   AND gs."active" = TRUE
                   AND ($3::text IS NOT NULL AND g."phone_e164" = $3::text)
              ) AS shares_phone
         FROM "students" s
        WHERE s."center_id" = $1::uuid
          AND ($4::uuid IS NULL OR s."id" <> $4::uuid)
          AND (
            s."normalized_name" = $2::text
            OR (
              $3::text IS NOT NULL
              AND EXISTS (
                SELECT 1
                  FROM "guardian_students" gs
                  JOIN "guardians" g
                    ON g."id" = gs."guardian_id"
                   AND g."center_id" = gs."center_id"
                 WHERE gs."center_id" = s."center_id"
                   AND gs."student_id" = s."id"
                   AND gs."active" = TRUE
                   AND g."phone_e164" = $3::text
              )
            )
          )
        ORDER BY s."id" ASC
        LIMIT 25`,
      [params.centerId, params.normalizedStudentName, phone, excludeId],
    );

    let hasBlockingDuplicate = false;
    let siblingSharedPhoneDetected = false;
    const candidates: DuplicateCandidateWarningDto[] = [];

    for (const row of res.rows) {
      const sameName = row.normalized_name === params.normalizedStudentName;
      const samePhone = Boolean(row.shares_phone);

      let matchReason: DuplicateMatchReason;
      let isBlocking = false;

      if (sameName && samePhone) {
        matchReason = 'EXACT_NORMALIZED_NAME_AND_GUARDIAN_PHONE';
        isBlocking = true;
        hasBlockingDuplicate = true;
      } else if (samePhone) {
        matchReason = 'SHARED_GUARDIAN_PHONE_SIBLING';
        isBlocking = false;
        siblingSharedPhoneDetected = true;
      } else {
        matchReason = 'SAME_NORMALIZED_NAME_DIFFERENT_PHONE';
        isBlocking = false;
      }

      candidates.push(
        Object.freeze({
          student_id: row.student_id,
          student_code: row.student_code,
          full_name: row.full_name,
          status: row.status,
          match_reason: matchReason,
          is_blocking_without_confirmation: isBlocking,
        }),
      );
    }

    return Object.freeze({
      normalized_student_name: params.normalizedStudentName,
      normalized_guardian_phone_e164: phone,
      has_blocking_duplicate: hasBlockingDuplicate,
      sibling_shared_phone_detected: siblingSharedPhoneDetected,
      candidates: Object.freeze(candidates),
    });
  }

  public async checkDuplicatesForStaff(
    principal: AuthenticatedStaffPrincipal,
    query: {
      full_name?: string;
      guardian_phone_e164?: string;
      exclude_student_id?: string;
    },
  ): Promise<DuplicateCheckResponseDto> {
    if (!query.full_name || query.full_name.trim().length === 0) {
      throw new ApiHttpException({
        statusCode: 400,
        errorCode: 'VALIDATION_ERROR',
        message: 'full_name query parameter is required',
      });
    }
    const { normalizedName } = normalizePersonName(query.full_name, 'full_name');
    const normalizedPhone =
      query.guardian_phone_e164 && query.guardian_phone_e164.trim().length > 0
        ? normalizePhoneE164(query.guardian_phone_e164, 'guardian_phone_e164')
        : null;
    const excludeId =
      query.exclude_student_id && query.exclude_student_id.trim().length > 0
        ? assertValidUuid(query.exclude_student_id, 'exclude_student_id')
        : null;

    return this.findDuplicateCandidates(this.databaseService, {
      centerId: principal.centerId,
      normalizedStudentName: normalizedName,
      guardianPhoneE164: normalizedPhone,
      excludeStudentId: excludeId,
    });
  }
}
