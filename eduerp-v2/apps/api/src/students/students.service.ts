import { Inject, Injectable } from '@nestjs/common';
import type { BillingMode } from '@eduerp/contracts';
import * as crypto from 'node:crypto';
import { ApiHttpException } from '../auth/auth.errors';
import { ClockService } from '../auth/clock.service';
import { AuthenticatedStaffPrincipal } from '../auth/permissions.guard';
import { hashOpaqueToken } from '../auth/token.service';
import {
  assertPlainObject,
  assertValidUuid,
  requireIdempotencyKeyHeader,
  resolveExpectedVersion,
} from '../auth/validation';
import { RequestWithCorrelationId, resolveRequestId } from '../common/request-id.middleware';
import { ApiEnvConfig } from '../config/env';
import { DatabaseService } from '../database/database.service';
import { computeKeyedFieldDigest, executeIdempotentOperation } from '../database/idempotency';
import { executeOptimisticUpdate, TransactionContext } from '../database/transaction';
import { API_CONFIG_TOKEN } from '../health/health.controller';
import {
  DuplicateCandidateWarningDto,
  DuplicatesService,
} from './duplicates.service';
import {
  EnrollmentResponseDto,
  EnrollmentStatus,
  mapEnrollmentRowToDto,
} from './enrollments.service';
import {
  GuardianRelationship,
  TelegramLinkStatus,
} from './guardians.service';
import {
  escapeSqlLikePattern,
  generateUniqueStudentCode,
  normalizePersonName,
  normalizePhoneE164,
  normalizeSearchQueryText,
  validateIsoDate,
} from './normalization';

const ALLOWED_RELATIONSHIPS: ReadonlySet<string> = new Set([
  'MOTHER',
  'FATHER',
  'GUARDIAN',
  'SELF',
]);
const ALLOWED_INITIAL_ENROLLMENT_STATUSES: ReadonlySet<string> = new Set(['TRIAL', 'ACTIVE']);
const ALLOWED_STUDENT_STATUSES: ReadonlySet<string> = new Set(['ACTIVE', 'ARCHIVED']);
const UUID_EXACT_REGEX = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export interface AdminStudentGuardianViewDto {
  readonly guardian_id: string;
  readonly full_name: string;
  readonly phone_e164: string;
  readonly relationship?: GuardianRelationship;
  readonly is_primary_payer?: boolean;
  readonly telegram_link_status: TelegramLinkStatus;
  readonly version?: number;
  readonly link_version?: number;
}

export interface AdminStudentViewDto {
  readonly student_id: string;
  readonly student_code: string;
  readonly full_name: string;
  readonly birth_date: string | null;
  readonly notes: string | null;
  readonly status: 'ACTIVE' | 'ARCHIVED';
  readonly guardians: readonly AdminStudentGuardianViewDto[];
  readonly enrollments: readonly EnrollmentResponseDto[];
  readonly family_discount_eligible: boolean;
  readonly total_remaining_debt_uzs: string;
  readonly unapplied_credit_uzs: string;
  readonly bot_delivery_warning: boolean;
  readonly duplicate_warnings: readonly DuplicateCandidateWarningDto[];
  readonly version: number;
}

export interface AdminStudentListResponseDto {
  readonly items: readonly AdminStudentViewDto[];
  readonly next_cursor: string | null;
}

type QueryExecutor = Pick<DatabaseService, 'query'> | Pick<TransactionContext, 'query'>;

function formatPgDate(val: unknown): string | null {
  if (val === null || val === undefined) {
    return null;
  }
  if (val instanceof Date) {
    return val.toISOString().slice(0, 10);
  }
  return String(val).slice(0, 10);
}

@Injectable()
export class StudentsService {
  constructor(
    @Inject(API_CONFIG_TOKEN) private readonly config: ApiEnvConfig,
    @Inject(DatabaseService) private readonly databaseService: DatabaseService,
    @Inject(ClockService) private readonly clock: ClockService,
    @Inject(DuplicatesService) private readonly duplicatesService: DuplicatesService,
  ) {}

  public async buildAdminStudentView(
    executor: QueryExecutor,
    centerId: string,
    studentRow: {
      id: string;
      student_code: string;
      full_name: string;
      normalized_name: string;
      birth_date: unknown;
      notes: string | null;
      status: 'ACTIVE' | 'ARCHIVED';
      version: number;
    },
    duplicateWarningsOverride?: readonly DuplicateCandidateWarningDto[],
  ): Promise<AdminStudentViewDto> {
    const guardiansRes = await executor.query<{
      guardian_id: string;
      full_name: string;
      phone_e164: string;
      relationship: GuardianRelationship;
      is_primary_payer: boolean;
      guardian_version: number;
      link_version: number;
      telegram_link_status: TelegramLinkStatus | null;
      sibling_count: string;
    }>(
      `SELECT g."id"::text AS guardian_id,
              g."full_name" AS full_name,
              g."phone_e164" AS phone_e164,
              gs."relationship"::text AS relationship,
              gs."is_primary_payer" AS is_primary_payer,
              g."version" AS guardian_version,
              gs."version" AS link_version,
              (
                SELECT gtl."status"::text
                  FROM "guardian_telegram_links" gtl
                 WHERE gtl."center_id" = g."center_id"
                   AND gtl."guardian_id" = g."id"
                 ORDER BY
                   CASE gtl."status"
                     WHEN 'ACTIVE' THEN 1
                     WHEN 'INVITED' THEN 2
                     WHEN 'BOT_BLOCKED_403' THEN 3
                     ELSE 4
                   END ASC,
                   gtl."updated_at" DESC
                 LIMIT 1
              ) AS telegram_link_status,
              (
                SELECT COUNT(DISTINCT gs2."student_id")::text
                  FROM "guardian_students" gs2
                 WHERE gs2."center_id" = g."center_id"
                   AND gs2."guardian_id" = g."id"
                   AND gs2."active" = TRUE
              ) AS sibling_count
         FROM "guardian_students" gs
         JOIN "guardians" g
           ON g."id" = gs."guardian_id"
          AND g."center_id" = gs."center_id"
        WHERE gs."center_id" = $1::uuid
          AND gs."student_id" = $2::uuid
          AND gs."active" = TRUE
        ORDER BY gs."is_primary_payer" DESC, g."id" ASC`,
      [centerId, studentRow.id],
    );

    const guardians: AdminStudentGuardianViewDto[] = guardiansRes.rows.map((r) =>
      Object.freeze({
        guardian_id: r.guardian_id,
        full_name: r.full_name,
        phone_e164: r.phone_e164,
        relationship: r.relationship,
        is_primary_payer: Boolean(r.is_primary_payer),
        telegram_link_status: (r.telegram_link_status ?? 'UNLINKED_REVOKED') as TelegramLinkStatus,
        version: Number(r.guardian_version),
        link_version: Number(r.link_version),
      }),
    );

    const familyDiscountEligible = guardiansRes.rows.some(
      (r) => Number(r.sibling_count ?? '1') >= 2,
    );

    const botDeliveryWarning =
      guardians.length === 0 ||
      guardians.some((g) => g.telegram_link_status !== 'ACTIVE');

    const enrollmentsRes = await executor.query<{
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
      `SELECT "id"::text AS id,
              "student_id"::text AS student_id,
              "group_id"::text AS group_id,
              "status"::text AS status,
              "enrolled_at_date",
              "left_at_date",
              "churn_reason_code",
              "package_lessons_remaining",
              "transferred_from_enrollment_id"::text AS transferred_from_enrollment_id,
              "version"
         FROM "enrollments"
        WHERE "center_id" = $1::uuid
          AND "student_id" = $2::uuid
        ORDER BY "enrolled_at_date" DESC, "created_at" DESC, "id" ASC`,
      [centerId, studentRow.id],
    );

    const enrollments = enrollmentsRes.rows.map((e) => mapEnrollmentRowToDto(e));

    const debtRes = await executor.query<{ total_debt: string }>(
      `SELECT COALESCE(SUM("remaining_debt_uzs"), 0)::text AS total_debt
         FROM "invoices"
        WHERE "center_id" = $1::uuid
          AND "student_id" = $2::uuid
          AND "status" IN ('ISSUED_OPEN', 'PARTIALLY_PAID')`,
      [centerId, studentRow.id],
    );
    const totalRemainingDebtUzs = BigInt(debtRes.rows[0]?.total_debt ?? '0').toString(10);

    const creditRes = await executor.query<{ total_credit: string }>(
      `SELECT COALESCE(SUM("remaining_amount_uzs"), 0)::text AS total_credit
         FROM "unapplied_credits"
        WHERE "center_id" = $1::uuid
          AND "student_id" = $2::uuid
          AND "status" = 'AVAILABLE'`,
      [centerId, studentRow.id],
    );
    const unappliedCreditUzs = BigInt(creditRes.rows[0]?.total_credit ?? '0').toString(10);

    let duplicateWarnings: readonly DuplicateCandidateWarningDto[] =
      duplicateWarningsOverride ?? [];
    if (!duplicateWarningsOverride) {
      const primaryPhone = guardians[0]?.phone_e164 ?? null;
      const dupCheck = await this.duplicatesService.findDuplicateCandidates(executor, {
        centerId,
        normalizedStudentName: studentRow.normalized_name,
        guardianPhoneE164: primaryPhone,
        excludeStudentId: studentRow.id,
      });
      duplicateWarnings = dupCheck.candidates;
    }

    return Object.freeze({
      student_id: studentRow.id,
      student_code: studentRow.student_code,
      full_name: studentRow.full_name,
      birth_date: formatPgDate(studentRow.birth_date),
      notes: studentRow.notes ?? null,
      status: studentRow.status,
      guardians: Object.freeze(guardians),
      enrollments: Object.freeze(enrollments),
      family_discount_eligible: familyDiscountEligible,
      total_remaining_debt_uzs: totalRemainingDebtUzs,
      unapplied_credit_uzs: unappliedCreditUzs,
      bot_delivery_warning: botDeliveryWarning,
      duplicate_warnings: Object.freeze([...duplicateWarnings]),
      version: Number(studentRow.version),
    });
  }

  public async registerStudentQuick15s(
    req: RequestWithCorrelationId,
    principal: AuthenticatedStaffPrincipal,
    rawBody: unknown,
  ): Promise<AdminStudentViewDto> {
    const idempotencyKey = requireIdempotencyKeyHeader(req);
    const obj = assertPlainObject(rawBody, [
      'student_full_name',
      'birth_date',
      'notes',
      'guardian_id',
      'guardian_full_name',
      'guardian_phone_e164',
      'relationship',
      'group_id',
      'initial_status',
      'enrolled_at_date',
      'confirm_sibling_or_similar_name',
      'reuse_existing_guardian',
      'debug_fail_after_student_insert',
    ]);

    const { fullName: studentFullName, normalizedName: studentNormalizedName } =
      normalizePersonName(obj.student_full_name, 'student_full_name');
    const birthDate =
      obj.birth_date !== undefined && obj.birth_date !== null
        ? validateIsoDate(obj.birth_date, 'birth_date')
        : null;
    let notes: string | null = null;
    if (obj.notes !== undefined && obj.notes !== null) {
      if (typeof obj.notes !== 'string' || obj.notes.length > 500) {
        throw new ApiHttpException({
          statusCode: 400,
          errorCode: 'VALIDATION_ERROR',
          message: 'notes must be a string up to 500 characters',
        });
      }
      notes = obj.notes.trim() || null;
    }

    const explicitGuardianId =
      obj.guardian_id !== undefined && obj.guardian_id !== null
        ? assertValidUuid(obj.guardian_id, 'guardian_id')
        : null;
    const { fullName: guardianFullName } = normalizePersonName(
      obj.guardian_full_name,
      'guardian_full_name',
    );
    const guardianPhoneE164 = normalizePhoneE164(
      obj.guardian_phone_e164,
      'guardian_phone_e164',
    );
    const relationshipRaw =
      typeof obj.relationship === 'string' ? obj.relationship.trim().toUpperCase() : 'GUARDIAN';
    if (!ALLOWED_RELATIONSHIPS.has(relationshipRaw)) {
      throw new ApiHttpException({
        statusCode: 400,
        errorCode: 'VALIDATION_ERROR',
        message: 'relationship must be MOTHER, FATHER, GUARDIAN, or SELF',
      });
    }
    const relationship = relationshipRaw as GuardianRelationship;

    const groupId =
      obj.group_id !== undefined && obj.group_id !== null
        ? assertValidUuid(obj.group_id, 'group_id')
        : null;
    let initialStatus: 'TRIAL' | 'ACTIVE' | null = null;
    let enrolledAtDate: string | null = null;
    if (groupId !== null) {
      const statusRaw =
        typeof obj.initial_status === 'string'
          ? obj.initial_status.trim().toUpperCase()
          : 'TRIAL';
      if (!ALLOWED_INITIAL_ENROLLMENT_STATUSES.has(statusRaw)) {
        throw new ApiHttpException({
          statusCode: 400,
          errorCode: 'VALIDATION_ERROR',
          message: 'initial_status must be TRIAL or ACTIVE',
        });
      }
      initialStatus = statusRaw as 'TRIAL' | 'ACTIVE';
      enrolledAtDate = validateIsoDate(obj.enrolled_at_date, 'enrolled_at_date');
    }

    if (
      obj.confirm_sibling_or_similar_name !== undefined &&
      typeof obj.confirm_sibling_or_similar_name !== 'boolean'
    ) {
      throw new ApiHttpException({
        statusCode: 400,
        errorCode: 'VALIDATION_ERROR',
        message: 'confirm_sibling_or_similar_name must be a boolean',
      });
    }
    const confirmSiblingOrSimilarName = Boolean(obj.confirm_sibling_or_similar_name);
    const reuseExistingGuardian = Boolean(obj.reuse_existing_guardian);
    const debugFail =
      this.config.nodeEnv === 'test' && obj.debug_fail_after_student_insert === true;
    const requestId = req.requestId ?? resolveRequestId(req.headers['x-request-id']);
    const now = this.clock.now();

    const phoneHmac = computeKeyedFieldDigest(
      this.config.internalBotHmacSecret,
      'quick-reg-guardian-phone-v1',
      guardianPhoneE164,
    );

    const idemOutcome = await executeIdempotentOperation<AdminStudentViewDto>(
      this.databaseService,
      {
        centerId: principal.centerId,
        actorStaffId: principal.staffId,
        operationType: 'REGISTER_STUDENT_QUICK',
        idempotencyKey,
        requestPayload: {
          student_full_name: studentFullName,
          birth_date: birthDate,
          notes,
          guardian_id: explicitGuardianId,
          guardian_full_name: guardianFullName,
          guardian_phone_hmac: phoneHmac,
          relationship,
          group_id: groupId,
          initial_status: initialStatus,
          enrolled_at_date: enrolledAtDate,
          confirm_sibling_or_similar_name: confirmSiblingOrSimilarName,
          reuse_existing_guardian: reuseExistingGuardian,
        },
        handler: async (tx) => {
          // 1. Check duplicate candidates (06.04)
          const dupCheck = await this.duplicatesService.findDuplicateCandidates(tx, {
            centerId: principal.centerId,
            normalizedStudentName: studentNormalizedName,
            guardianPhoneE164,
          });

          if (dupCheck.has_blocking_duplicate && !confirmSiblingOrSimilarName) {
            throw new ApiHttpException({
              statusCode: 409,
              errorCode: 'DUPLICATE_STUDENT_DETECTED',
              message:
                'A student with the same normalized name and guardian phone already exists in this center; pass confirm_sibling_or_similar_name=true after verifying this is a distinct student',
              conflictDetails: {
                duplicate_warnings: dupCheck.candidates,
              },
            });
          }

          // 2. Resolve or create Guardian without silently merging different people (06.01, 06.02)
          const existingGuardianRes = await tx.query<{
            id: string;
            full_name: string;
            phone_e164: string;
          }>(
            `SELECT "id"::text AS id, "full_name", "phone_e164"
               FROM "guardians"
              WHERE "center_id" = $1::uuid
                AND "phone_e164" = $2
              FOR UPDATE`,
            [principal.centerId, guardianPhoneE164],
          );

          let guardianId: string;
          const existingGuardian = existingGuardianRes.rows[0];
          if (existingGuardian) {
            const sameGuardianName =
              normalizePersonName(existingGuardian.full_name).normalizedName ===
              normalizePersonName(guardianFullName).normalizedName;
            const authorizedToReuse =
              (explicitGuardianId !== null && explicitGuardianId === existingGuardian.id) ||
              reuseExistingGuardian ||
              confirmSiblingOrSimilarName ||
              sameGuardianName;

            if (
              (explicitGuardianId !== null && explicitGuardianId !== existingGuardian.id) ||
              !authorizedToReuse
            ) {
              throw new ApiHttpException({
                statusCode: 409,
                errorCode: 'DUPLICATE_STUDENT_DETECTED',
                message:
                  'A guardian with this phone_e164 already exists under a different name; pass explicit guardian_id, reuse_existing_guardian=true, or confirm_sibling_or_similar_name=true to link this guardian',
                conflictDetails: {
                  conflict_type: 'EXISTING_GUARDIAN_PHONE_REQUIRES_CONFIRMATION',
                },
              });
            }
            guardianId = existingGuardian.id;
          } else {
            guardianId = explicitGuardianId ?? crypto.randomUUID();
            await tx.query(
              `INSERT INTO "guardians" (
                 "id", "center_id", "full_name", "phone_e164", "status", "version", "created_at", "updated_at"
               ) VALUES (
                 $1::uuid, $2::uuid, $3, $4, 'ACTIVE', 1, $5::timestamptz, $5::timestamptz
               )`,
              [guardianId, principal.centerId, guardianFullName, guardianPhoneE164, now.toISOString()],
            );

            const inviteLinkId = crypto.randomUUID();
            const rawInviteToken = `inv-${crypto.randomUUID()}-${crypto.randomBytes(16).toString('hex')}`;
            const inviteTokenHash = hashOpaqueToken(rawInviteToken);
            const inviteExpiresIso = new Date(now.getTime() + 7 * 86400 * 1000).toISOString();

            await tx.query(
              `INSERT INTO "guardian_telegram_links" (
                 "id", "center_id", "guardian_id", "invite_token_hash", "invite_expires_at",
                 "linked_phone_e164", "status", "version", "created_at", "updated_at"
               ) VALUES (
                 $1::uuid, $2::uuid, $3::uuid, $4, $5::timestamptz,
                 $6, 'INVITED', 1, $7::timestamptz, $7::timestamptz
               )`,
              [
                inviteLinkId,
                principal.centerId,
                guardianId,
                inviteTokenHash,
                inviteExpiresIso,
                guardianPhoneE164,
                now.toISOString(),
              ],
            );
          }

          // 3. Create Student
          const studentId = crypto.randomUUID();
          const studentCode = await generateUniqueStudentCode(tx, principal.centerId);

          const stuIns = await tx.query<{
            id: string;
            student_code: string;
            full_name: string;
            normalized_name: string;
            birth_date: unknown;
            notes: string | null;
            status: 'ACTIVE' | 'ARCHIVED';
            version: number;
          }>(
            `INSERT INTO "students" (
               "id", "center_id", "student_code", "full_name", "normalized_name",
               "birth_date", "status", "notes", "version", "created_at", "updated_at"
             ) VALUES (
               $1::uuid, $2::uuid, $3, $4, $5,
               $6::date, 'ACTIVE', $7, 1, $8::timestamptz, $8::timestamptz
             )
             RETURNING "id"::text AS id,
                       "student_code",
                       "full_name",
                       "normalized_name",
                       "birth_date",
                       "notes",
                       "status"::text AS status,
                       "version"`,
            [
              studentId,
              principal.centerId,
              studentCode,
              studentFullName,
              studentNormalizedName,
              birthDate,
              notes,
              now.toISOString(),
            ],
          );
          const createdStudent = stuIns.rows[0];

          // 4. Link Guardian -> Student
          await tx.query(
            `INSERT INTO "guardian_students" (
               "id", "center_id", "guardian_id", "student_id", "relationship",
               "is_primary_payer", "active", "version", "created_at", "updated_at"
             ) VALUES (
               $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5,
               TRUE, TRUE, 1, $6::timestamptz, $6::timestamptz
             )`,
            [
              crypto.randomUUID(),
              principal.centerId,
              guardianId,
              studentId,
              relationship,
              now.toISOString(),
            ],
          );

          // 5. Optional atomic initial group enrollment
          if (groupId && initialStatus && enrolledAtDate) {
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
            const grp = grpRes.rows[0];
            if (!grp) {
              throw new ApiHttpException({
                statusCode: 404,
                errorCode: 'NOT_FOUND',
                message: 'Course group not found in this center',
              });
            }
            if (grp.status !== 'ACTIVE') {
              throw new ApiHttpException({
                statusCode: 422,
                errorCode: 'VALIDATION_ERROR',
                message: 'Cannot enroll into an ARCHIVED course group',
              });
            }

            const packageLessons =
              grp.billing_mode === 'LESSON_PACKAGE_12' ? Number(grp.lessons_per_cycle) : null;
            const activatedAtIso = initialStatus === 'ACTIVE' ? now.toISOString() : null;

            await tx.query(
              `INSERT INTO "enrollments" (
                 "id", "center_id", "student_id", "group_id", "status",
                 "enrolled_at_date", "activated_at", "package_lessons_remaining",
                 "version", "created_at", "updated_at"
               ) VALUES (
                 $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5,
                 $6::date, $7::timestamptz, $8::int,
                 1, $9::timestamptz, $9::timestamptz
               )`,
              [
                crypto.randomUUID(),
                principal.centerId,
                studentId,
                groupId,
                initialStatus,
                enrolledAtDate,
                activatedAtIso,
                packageLessons,
                now.toISOString(),
              ],
            );
          }

          if (debugFail) {
            throw new Error('INJECTED_FAULT_AFTER_QUICK_REGISTER_STUDENT');
          }

          await tx.query(
            `INSERT INTO "audit_logs" (
               "id", "center_id", "actor_type", "actor_id", "actor_role",
               "action", "entity_type", "entity_id", "severity",
               "after_redacted_json", "request_id", "created_at"
             ) VALUES (
               $1::uuid, $2::uuid, 'STAFF', $3::uuid, $4,
               'STUDENT_QUICK_REGISTERED', 'Student', $5::uuid, 'INFO',
               $6::jsonb, $7, $8::timestamptz
             )`,
            [
              crypto.randomUUID(),
              principal.centerId,
              principal.staffId,
              principal.role,
              studentId,
              JSON.stringify({
                student_id: studentId,
                student_code: studentCode,
                guardian_id: guardianId,
                group_id: groupId,
                initial_status: initialStatus,
                reused_existing_guardian: Boolean(existingGuardian),
              }),
              requestId,
              now.toISOString(),
            ],
          );

          const view = await this.buildAdminStudentView(
            tx,
            principal.centerId,
            createdStudent,
            dupCheck.candidates,
          );

          // Redact raw phone_e164 inside client_operation_logs by storing the student ID & metadata,
          // or note that phone_e164 in AdminStudentView is allowed (not an auth secret), while
          // requestPayload uses phone_hmac.
          return {
            statusCode: 201,
            body: view,
          };
        },
      },
    );

    return idemOutcome.body;
  }

  public async listStudentsForAdmin(
    principal: AuthenticatedStaffPrincipal,
    query: {
      search?: string;
      status?: string;
      include_archived?: string;
      only_debtors?: string;
      cursor?: string;
      limit?: string;
    },
  ): Promise<AdminStudentListResponseDto> {
    let limit = 50;
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

    let statusFilter: 'ACTIVE' | 'ARCHIVED' | null = 'ACTIVE';
    if (query.status !== undefined && query.status !== '') {
      const sUpper = query.status.trim().toUpperCase();
      if (!ALLOWED_STUDENT_STATUSES.has(sUpper)) {
        throw new ApiHttpException({
          statusCode: 400,
          errorCode: 'VALIDATION_ERROR',
          message: 'status filter must be ACTIVE or ARCHIVED',
        });
      }
      statusFilter = sUpper as 'ACTIVE' | 'ARCHIVED';
    } else if (query.include_archived === 'true') {
      statusFilter = null;
    } else if (
      query.include_archived !== undefined &&
      query.include_archived !== 'false' &&
      query.include_archived !== ''
    ) {
      throw new ApiHttpException({
        statusCode: 400,
        errorCode: 'VALIDATION_ERROR',
        message: 'include_archived must be true or false',
      });
    }

    const onlyDebtors = query.only_debtors === 'true';

    let searchUuid: string | null = null;
    let searchLikePattern: string | null = null;
    let searchPhoneDigitsPattern: string | null = null;
    if (query.search !== undefined && query.search.trim().length > 0) {
      const rawSearch = query.search.trim();
      if (rawSearch.length > 120) {
        throw new ApiHttpException({
          statusCode: 400,
          errorCode: 'VALIDATION_ERROR',
          message: 'search query must not exceed 120 characters',
        });
      }
      if (UUID_EXACT_REGEX.test(rawSearch)) {
        searchUuid = rawSearch.toLowerCase();
      } else {
        const normalizedText = normalizeSearchQueryText(rawSearch);
        searchLikePattern = `%${escapeSqlLikePattern(normalizedText)}%`;
        const digitsOnly = rawSearch.replace(/[^0-9+]/g, '');
        if (digitsOnly.length >= 4) {
          searchPhoneDigitsPattern = `%${escapeSqlLikePattern(digitsOnly)}%`;
        }
      }
    }

    const rowsRes = await this.databaseService.query<{
      id: string;
      student_code: string;
      full_name: string;
      normalized_name: string;
      birth_date: unknown;
      notes: string | null;
      status: 'ACTIVE' | 'ARCHIVED';
      version: number;
    }>(
      `SELECT s."id"::text AS id,
              s."student_code",
              s."full_name",
              s."normalized_name",
              s."birth_date",
              s."notes",
              s."status"::text AS status,
              s."version"
         FROM "students" s
        WHERE s."center_id" = $1::uuid
          AND ($2::text IS NULL OR s."status" = $2::text)
          AND ($3::uuid IS NULL OR s."id" > $3::uuid)
          AND (
            ($4::uuid IS NULL AND $5::text IS NULL)
            OR ($4::uuid IS NOT NULL AND s."id" = $4::uuid)
            OR (
              $5::text IS NOT NULL
              AND (
                s."normalized_name" LIKE $5::text ESCAPE '\\'
                OR LOWER(s."student_code") LIKE $5::text ESCAPE '\\'
                OR (
                  $6::text IS NOT NULL
                  AND EXISTS (
                    SELECT 1
                      FROM "guardian_students" gs
                      JOIN "guardians" g
                        ON g."id" = gs."guardian_id"
                       AND g."center_id" = gs."center_id"
                     WHERE gs."center_id" = s."center_id"
                       AND gs."student_id" = s."id"
                       AND gs."active" = TRUE
                       AND g."phone_e164" LIKE $6::text ESCAPE '\\'
                  )
                )
              )
            )
          )
          AND (
            $7::boolean = FALSE
            OR EXISTS (
              SELECT 1
                FROM "invoices" inv
               WHERE inv."center_id" = s."center_id"
                 AND inv."student_id" = s."id"
                 AND inv."status" IN ('ISSUED_OPEN', 'PARTIALLY_PAID')
                 AND inv."remaining_debt_uzs" > 0
            )
          )
        ORDER BY s."id" ASC
        LIMIT $8::int`,
      [
        principal.centerId,
        statusFilter,
        cursorUuid,
        searchUuid,
        searchLikePattern,
        searchPhoneDigitsPattern,
        onlyDebtors,
        limit + 1,
      ],
    );

    const hasMore = rowsRes.rows.length > limit;
    const slice = hasMore ? rowsRes.rows.slice(0, limit) : rowsRes.rows;
    const nextCursor = hasMore ? slice[slice.length - 1]?.id ?? null : null;

    const items: AdminStudentViewDto[] = [];
    for (const row of slice) {
      items.push(await this.buildAdminStudentView(this.databaseService, principal.centerId, row));
    }

    return Object.freeze({
      items: Object.freeze(items),
      next_cursor: nextCursor,
    });
  }

  public async getStudentProfileForStaff(
    principal: AuthenticatedStaffPrincipal,
    rawStudentId: string,
  ): Promise<AdminStudentViewDto> {
    const studentId = assertValidUuid(rawStudentId, 'student_id');

    const res = await this.databaseService.query<{
      id: string;
      student_code: string;
      full_name: string;
      normalized_name: string;
      birth_date: unknown;
      notes: string | null;
      status: 'ACTIVE' | 'ARCHIVED';
      version: number;
    }>(
      `SELECT "id"::text AS id,
              "student_code",
              "full_name",
              "normalized_name",
              "birth_date",
              "notes",
              "status"::text AS status,
              "version"
         FROM "students"
        WHERE "id" = $1::uuid
          AND "center_id" = $2::uuid
        LIMIT 1`,
      [studentId, principal.centerId],
    );

    const student = res.rows[0];
    if (!student) {
      throw new ApiHttpException({
        statusCode: 404,
        errorCode: 'NOT_FOUND',
        message: 'Student not found in this center',
      });
    }

    return this.buildAdminStudentView(this.databaseService, principal.centerId, student);
  }

  public async updateOrArchiveStudent(
    req: RequestWithCorrelationId,
    principal: AuthenticatedStaffPrincipal,
    rawStudentId: string,
    rawBody: unknown,
  ): Promise<AdminStudentViewDto> {
    const idempotencyKey = requireIdempotencyKeyHeader(req);
    const studentId = assertValidUuid(rawStudentId, 'student_id');
    const obj = assertPlainObject(rawBody, [
      'full_name',
      'birth_date',
      'notes',
      'status',
      'reason',
      'expected_version',
    ]);

    const expectedVersion = resolveExpectedVersion(req, obj.expected_version);
    const hasFullName = obj.full_name !== undefined;
    const parsedName = hasFullName ? normalizePersonName(obj.full_name, 'full_name') : null;

    const hasBirthDate = obj.birth_date !== undefined;
    const parsedBirthDate =
      hasBirthDate && obj.birth_date !== null
        ? validateIsoDate(obj.birth_date, 'birth_date')
        : null;

    const hasNotes = obj.notes !== undefined;
    let parsedNotes: string | null = null;
    if (hasNotes && obj.notes !== null) {
      if (typeof obj.notes !== 'string' || obj.notes.length > 500) {
        throw new ApiHttpException({
          statusCode: 400,
          errorCode: 'VALIDATION_ERROR',
          message: 'notes must be a string up to 500 characters',
        });
      }
      parsedNotes = obj.notes.trim() || null;
    }

    const hasStatus = obj.status !== undefined;
    let parsedStatus: 'ACTIVE' | 'ARCHIVED' | null = null;
    if (hasStatus) {
      const sRaw = typeof obj.status === 'string' ? obj.status.trim().toUpperCase() : '';
      if (!ALLOWED_STUDENT_STATUSES.has(sRaw)) {
        throw new ApiHttpException({
          statusCode: 400,
          errorCode: 'VALIDATION_ERROR',
          message: 'status must be ACTIVE or ARCHIVED',
        });
      }
      parsedStatus = sRaw as 'ACTIVE' | 'ARCHIVED';
    }

    if (!hasFullName && !hasBirthDate && !hasNotes && !hasStatus) {
      throw new ApiHttpException({
        statusCode: 400,
        errorCode: 'VALIDATION_ERROR',
        message: 'At least one updatable field (full_name, birth_date, notes, status) must be provided',
      });
    }

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

    const requestId = req.requestId ?? resolveRequestId(req.headers['x-request-id']);
    const now = this.clock.now();

    const idemOutcome = await executeIdempotentOperation<AdminStudentViewDto>(
      this.databaseService,
      {
        centerId: principal.centerId,
        actorStaffId: principal.staffId,
        operationType: 'UPDATE_OR_ARCHIVE_STUDENT',
        idempotencyKey,
        requestPayload: {
          student_id: studentId,
          full_name: parsedName?.fullName ?? undefined,
          birth_date: hasBirthDate ? parsedBirthDate : undefined,
          notes: hasNotes ? parsedNotes : undefined,
          status: parsedStatus ?? undefined,
          reason,
          expected_version: expectedVersion,
        },
        handler: async (tx) => {
          const existingRes = await tx.query<{
            id: string;
            student_code: string;
            full_name: string;
            normalized_name: string;
            birth_date: unknown;
            notes: string | null;
            status: 'ACTIVE' | 'ARCHIVED';
            version: number;
          }>(
            `SELECT "id"::text AS id,
                    "student_code",
                    "full_name",
                    "normalized_name",
                    "birth_date",
                    "notes",
                    "status"::text AS status,
                    "version"
               FROM "students"
              WHERE "id" = $1::uuid
                AND "center_id" = $2::uuid
              FOR UPDATE`,
            [studentId, principal.centerId],
          );

          const before = existingRes.rows[0];
          if (!before) {
            throw new ApiHttpException({
              statusCode: 404,
              errorCode: 'NOT_FOUND',
              message: 'Student not found in this center',
            });
          }

          const nextFullName = parsedName ? parsedName.fullName : before.full_name;
          const nextNormalizedName = parsedName
            ? parsedName.normalizedName
            : before.normalized_name;
          const nextBirthDate = hasBirthDate
            ? parsedBirthDate
            : formatPgDate(before.birth_date);
          const nextNotes = hasNotes ? parsedNotes : before.notes;
          const nextStatus = parsedStatus ?? before.status;

          const updated = await executeOptimisticUpdate<{
            id: string;
            student_code: string;
            full_name: string;
            normalized_name: string;
            birth_date: unknown;
            notes: string | null;
            status: 'ACTIVE' | 'ARCHIVED';
            version: number;
          }>(tx, {
            tableName: 'students',
            entityName: 'Student',
            id: studentId,
            centerId: principal.centerId,
            expectedVersion,
            setClauseSql: `"full_name" = $4, "normalized_name" = $5, "birth_date" = $6::date, "notes" = $7, "status" = $8`,
            additionalValues: [
              nextFullName,
              nextNormalizedName,
              nextBirthDate,
              nextNotes,
              nextStatus,
            ],
          });

          const auditAction =
            before.status !== 'ARCHIVED' && nextStatus === 'ARCHIVED'
              ? 'STUDENT_ARCHIVED'
              : 'STUDENT_UPDATED';

          await tx.query(
            `INSERT INTO "audit_logs" (
               "id", "center_id", "actor_type", "actor_id", "actor_role",
               "action", "entity_type", "entity_id", "severity",
               "before_redacted_json", "after_redacted_json", "request_id", "created_at"
             ) VALUES (
               $1::uuid, $2::uuid, 'STAFF', $3::uuid, $4,
               $5, 'Student', $6::uuid, 'INFO',
               $7::jsonb, $8::jsonb, $9, $10::timestamptz
             )`,
            [
              crypto.randomUUID(),
              principal.centerId,
              principal.staffId,
              principal.role,
              auditAction,
              studentId,
              JSON.stringify({
                status: before.status,
                version: before.version,
              }),
              JSON.stringify({
                status: updated.status,
                version: Number(updated.version),
                reason,
              }),
              requestId,
              now.toISOString(),
            ],
          );

          const view = await this.buildAdminStudentView(tx, principal.centerId, updated);
          return {
            statusCode: 200,
            body: view,
          };
        },
      },
    );

    return idemOutcome.body;
  }
}
