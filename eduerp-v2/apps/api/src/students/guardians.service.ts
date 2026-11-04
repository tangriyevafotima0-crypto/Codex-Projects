import { Inject, Injectable } from '@nestjs/common';
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
import { executeOptimisticUpdate } from '../database/transaction';
import { API_CONFIG_TOKEN } from '../config/tokens';
import { normalizePersonName, normalizePhoneE164 } from './normalization';

export type GuardianRelationship = 'MOTHER' | 'FATHER' | 'GUARDIAN' | 'SELF';
export type TelegramLinkStatus = 'INVITED' | 'ACTIVE' | 'BOT_BLOCKED_403' | 'UNLINKED_REVOKED';

const ALLOWED_RELATIONSHIPS: ReadonlySet<string> = new Set([
  'MOTHER',
  'FATHER',
  'GUARDIAN',
  'SELF',
]);

export interface GuardianSummaryViewDto {
  readonly guardian_id: string;
  readonly full_name: string;
  readonly phone_e164: string;
  readonly relationship: GuardianRelationship;
  readonly is_primary_payer: boolean;
  readonly active: boolean;
  readonly telegram_link_status: TelegramLinkStatus;
  readonly link_version: number;
  readonly guardian_version: number;
}

export interface GuardianInviteResponseDto {
  readonly guardian_id: string;
  readonly single_use_invite_deeplink: string | null;
  readonly relink_required: true;
  readonly expires_at_utc: string;
  readonly revoked_old_links_count: number;
  readonly version: number;
}

export interface UnlinkGuardianResponseDto {
  readonly student_id: string;
  readonly guardian_id: string;
  readonly active: false;
  readonly unlinked_at_utc: string;
  readonly preserved_sibling_active_links_count: number;
  readonly preserved_student_remaining_debt_uzs: string;
}

@Injectable()
export class GuardiansService {
  constructor(
    @Inject(API_CONFIG_TOKEN) private readonly config: ApiEnvConfig,
    @Inject(DatabaseService) private readonly databaseService: DatabaseService,
    @Inject(ClockService) private readonly clock: ClockService,
  ) {}

  public async linkGuardianToStudent(
    req: RequestWithCorrelationId,
    principal: AuthenticatedStaffPrincipal,
    rawStudentId: string,
    rawBody: unknown,
  ): Promise<GuardianSummaryViewDto> {
    const idempotencyKey = requireIdempotencyKeyHeader(req);
    const studentId = assertValidUuid(rawStudentId, 'student_id');
    const obj = assertPlainObject(rawBody, [
      'guardian_id',
      'guardian_full_name',
      'guardian_phone_e164',
      'relationship',
      'is_primary_payer',
      'reuse_existing_guardian',
    ]);

    const explicitGuardianId =
      obj.guardian_id !== undefined && obj.guardian_id !== null
        ? assertValidUuid(obj.guardian_id, 'guardian_id')
        : null;
    const { fullName: guardianFullName } = normalizePersonName(
      obj.guardian_full_name,
      'guardian_full_name',
    );
    const guardianPhoneE164 = normalizePhoneE164(obj.guardian_phone_e164, 'guardian_phone_e164');
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
    const isPrimaryPayer =
      obj.is_primary_payer === undefined ? false : Boolean(obj.is_primary_payer);
    if (obj.is_primary_payer !== undefined && typeof obj.is_primary_payer !== 'boolean') {
      throw new ApiHttpException({
        statusCode: 400,
        errorCode: 'VALIDATION_ERROR',
        message: 'is_primary_payer must be a boolean',
      });
    }
    const reuseExistingGuardian = Boolean(obj.reuse_existing_guardian);
    const requestId = req.requestId ?? resolveRequestId(req.headers['x-request-id']);
    const now = this.clock.now();

    const phoneHmac = computeKeyedFieldDigest(
      this.config.internalBotHmacSecret,
      'link-guardian-phone-v1',
      guardianPhoneE164,
    );

    const idemOutcome = await executeIdempotentOperation<GuardianSummaryViewDto>(
      this.databaseService,
      {
        centerId: principal.centerId,
        actorStaffId: principal.staffId,
        operationType: 'LINK_GUARDIAN_TO_STUDENT',
        idempotencyKey,
        requestPayload: {
          student_id: studentId,
          guardian_id: explicitGuardianId,
          guardian_full_name: guardianFullName,
          guardian_phone_hmac: phoneHmac,
          relationship,
          is_primary_payer: isPrimaryPayer,
          reuse_existing_guardian: reuseExistingGuardian,
        },
        handler: async (tx) => {
          const stuRes = await tx.query<{ id: string }>(
            `SELECT "id"::text AS id
               FROM "students"
              WHERE "id" = $1::uuid
                AND "center_id" = $2::uuid
              FOR UPDATE`,
            [studentId, principal.centerId],
          );
          if (!stuRes.rows[0]) {
            throw new ApiHttpException({
              statusCode: 404,
              errorCode: 'NOT_FOUND',
              message: 'Student not found in this center',
            });
          }

          const existingByPhoneRes = await tx.query<{
            id: string;
            full_name: string;
            phone_e164: string;
            version: number;
          }>(
            `SELECT "id"::text AS id, "full_name", "phone_e164", "version"
               FROM "guardians"
              WHERE "center_id" = $1::uuid
                AND "phone_e164" = $2
              FOR UPDATE`,
            [principal.centerId, guardianPhoneE164],
          );

          let guardianId: string;
          let resolvedFullName: string;
          let guardianVersion: number;

          const existingByPhone = existingByPhoneRes.rows[0];
          if (existingByPhone) {
            if (
              (explicitGuardianId && explicitGuardianId !== existingByPhone.id) ||
              (!explicitGuardianId && !reuseExistingGuardian)
            ) {
              throw new ApiHttpException({
                statusCode: 409,
                errorCode: 'VALIDATION_ERROR',
                message:
                  'A guardian with this phone_e164 already exists in this center; pass explicit guardian_id or reuse_existing_guardian=true to link this guardian',
                conflictDetails: {
                  conflict_type: 'EXISTING_GUARDIAN_PHONE_REQUIRES_CONFIRMATION',
                },
              });
            }
            guardianId = existingByPhone.id;
            resolvedFullName = existingByPhone.full_name;
            guardianVersion = Number(existingByPhone.version);
          } else {
            if (explicitGuardianId) {
              const checkId = await tx.query<{ id: string }>(
                `SELECT "id"::text AS id FROM "guardians" WHERE "id" = $1::uuid AND "center_id" = $2::uuid`,
                [explicitGuardianId, principal.centerId],
              );
              if (checkId.rows[0]) {
                throw new ApiHttpException({
                  statusCode: 409,
                  errorCode: 'VALIDATION_ERROR',
                  message: 'Specified guardian_id has a different phone_e164 than provided',
                });
              }
            }

            guardianId = explicitGuardianId ?? crypto.randomUUID();
            resolvedFullName = guardianFullName;
            guardianVersion = 1;

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
                 $6, 'UNLINKED_REVOKED', 1, $7::timestamptz, $7::timestamptz, $7::timestamptz, 'RELINK_REQUIRED'
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

          const existingPairRes = await tx.query<{
            id: string;
            active: boolean;
            version: number;
          }>(
            `SELECT "id"::text AS id, "active", "version"
               FROM "guardian_students"
              WHERE "center_id" = $1::uuid
                AND "guardian_id" = $2::uuid
                AND "student_id" = $3::uuid
              FOR UPDATE`,
            [principal.centerId, guardianId, studentId],
          );

          let linkVersion = 1;
          const existingPair = existingPairRes.rows[0];
          if (existingPair) {
            if (existingPair.active) {
              throw new ApiHttpException({
                statusCode: 409,
                errorCode: 'VALIDATION_ERROR',
                message: 'Guardian is already actively linked to this student',
              });
            }
            linkVersion = Number(existingPair.version) + 1;
            await tx.query(
              `UPDATE "guardian_students"
                  SET "active" = TRUE,
                      "unlinked_at" = NULL,
                      "relationship" = $4,
                      "is_primary_payer" = $5,
                      "version" = $6::int,
                      "updated_at" = $7::timestamptz
                WHERE "id" = $1::uuid
                  AND "center_id" = $2::uuid
                  AND "student_id" = $3::uuid`,
              [
                existingPair.id,
                principal.centerId,
                studentId,
                relationship,
                isPrimaryPayer,
                linkVersion,
                now.toISOString(),
              ],
            );
          } else {
            await tx.query(
              `INSERT INTO "guardian_students" (
                 "id", "center_id", "guardian_id", "student_id", "relationship",
                 "is_primary_payer", "active", "version", "created_at", "updated_at"
               ) VALUES (
                 $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5,
                 $6, TRUE, 1, $7::timestamptz, $7::timestamptz
               )`,
              [
                crypto.randomUUID(),
                principal.centerId,
                guardianId,
                studentId,
                relationship,
                isPrimaryPayer,
                now.toISOString(),
              ],
            );
          }

          const tgRes = await tx.query<{ status: TelegramLinkStatus }>(
            `SELECT "status"::text AS status
               FROM "guardian_telegram_links"
              WHERE "center_id" = $1::uuid
                AND "guardian_id" = $2::uuid
              ORDER BY "updated_at" DESC
              LIMIT 1`,
            [principal.centerId, guardianId],
          );
          const tgStatus: TelegramLinkStatus = tgRes.rows[0]?.status ?? 'UNLINKED_REVOKED';

          await tx.query(
            `INSERT INTO "audit_logs" (
               "id", "center_id", "actor_type", "actor_id", "actor_role",
               "action", "entity_type", "entity_id", "severity",
               "after_redacted_json", "request_id", "created_at"
             ) VALUES (
               $1::uuid, $2::uuid, 'STAFF', $3::uuid, $4,
               'GUARDIAN_LINKED_TO_STUDENT', 'GuardianStudent', $5::uuid, 'INFO',
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
                guardian_id: guardianId,
                relationship,
                is_primary_payer: isPrimaryPayer,
                reused_existing_guardian: Boolean(existingByPhone),
              }),
              requestId,
              now.toISOString(),
            ],
          );

          return {
            statusCode: 201,
            body: Object.freeze({
              guardian_id: guardianId,
              full_name: resolvedFullName,
              phone_e164: guardianPhoneE164,
              relationship,
              is_primary_payer: isPrimaryPayer,
              active: true,
              telegram_link_status: tgStatus,
              link_version: linkVersion,
              guardian_version: guardianVersion,
            }),
          };
        },
      },
    );

    return idemOutcome.body;
  }

  public async unlinkGuardianFromStudent(
    req: RequestWithCorrelationId,
    principal: AuthenticatedStaffPrincipal,
    rawStudentId: string,
    rawGuardianId: string,
    rawBody: unknown,
  ): Promise<UnlinkGuardianResponseDto> {
    const idempotencyKey = requireIdempotencyKeyHeader(req);
    const studentId = assertValidUuid(rawStudentId, 'student_id');
    const guardianId = assertValidUuid(rawGuardianId, 'guardian_id');
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
    const requestId = req.requestId ?? resolveRequestId(req.headers['x-request-id']);
    const now = this.clock.now();

    const idemOutcome = await executeIdempotentOperation<UnlinkGuardianResponseDto>(
      this.databaseService,
      {
        centerId: principal.centerId,
        actorStaffId: principal.staffId,
        operationType: 'UNLINK_GUARDIAN_FROM_STUDENT',
        idempotencyKey,
        requestPayload: {
          student_id: studentId,
          guardian_id: guardianId,
          reason,
          expected_version: expectedVersion,
        },
        handler: async (tx) => {
          const linkRes = await tx.query<{
            id: string;
            active: boolean;
            version: number;
          }>(
            `SELECT "id"::text AS id, "active", "version"
               FROM "guardian_students"
              WHERE "center_id" = $1::uuid
                AND "student_id" = $2::uuid
                AND "guardian_id" = $3::uuid
              FOR UPDATE`,
            [principal.centerId, studentId, guardianId],
          );

          const link = linkRes.rows[0];
          if (!link) {
            throw new ApiHttpException({
              statusCode: 404,
              errorCode: 'NOT_FOUND',
              message: 'Guardian-student relationship not found in this center',
            });
          }

          await executeOptimisticUpdate(tx, {
            tableName: 'guardian_students',
            entityName: 'GuardianStudent',
            id: link.id,
            centerId: principal.centerId,
            expectedVersion,
            setClauseSql: `"active" = FALSE, "unlinked_at" = $4::timestamptz`,
            additionalValues: [now.toISOString()],
          });

          // Verify sibling links for this guardian remain intact (06.02)
          const siblingRes = await tx.query<{ cnt: string }>(
            `SELECT COUNT(*)::text AS cnt
               FROM "guardian_students"
              WHERE "center_id" = $1::uuid
                AND "guardian_id" = $2::uuid
                AND "active" = TRUE`,
            [principal.centerId, guardianId],
          );
          const preservedSiblingCount = Number(siblingRes.rows[0]?.cnt ?? '0');

          // Verify student financial history (remaining debt) is preserved untouched
          const debtRes = await tx.query<{ total_debt: string }>(
            `SELECT COALESCE(SUM("remaining_debt_uzs"), 0)::text AS total_debt
               FROM "invoices"
              WHERE "center_id" = $1::uuid
                AND "student_id" = $2::uuid
                AND "status" IN ('ISSUED_OPEN', 'PARTIALLY_PAID')`,
            [principal.centerId, studentId],
          );
          const preservedDebtUzs = BigInt(debtRes.rows[0]?.total_debt ?? '0').toString(10);

          await tx.query(
            `INSERT INTO "audit_logs" (
               "id", "center_id", "actor_type", "actor_id", "actor_role",
               "action", "entity_type", "entity_id", "severity",
               "before_redacted_json", "after_redacted_json", "request_id", "created_at"
             ) VALUES (
               $1::uuid, $2::uuid, 'STAFF', $3::uuid, $4,
               'GUARDIAN_UNLINKED_FROM_STUDENT', 'GuardianStudent', $5::uuid, 'WARN',
               $6::jsonb, $7::jsonb, $8, $9::timestamptz
             )`,
            [
              crypto.randomUUID(),
              principal.centerId,
              principal.staffId,
              principal.role,
              link.id,
              JSON.stringify({
                student_id: studentId,
                guardian_id: guardianId,
                active: link.active,
                version: link.version,
              }),
              JSON.stringify({
                student_id: studentId,
                guardian_id: guardianId,
                active: false,
                preserved_sibling_active_links_count: preservedSiblingCount,
                preserved_student_remaining_debt_uzs: preservedDebtUzs,
                reason,
              }),
              requestId,
              now.toISOString(),
            ],
          );

          return {
            statusCode: 200,
            body: Object.freeze({
              student_id: studentId,
              guardian_id: guardianId,
              active: false as const,
              unlinked_at_utc: now.toISOString(),
              preserved_sibling_active_links_count: preservedSiblingCount,
              preserved_student_remaining_debt_uzs: preservedDebtUzs,
            }),
          };
        },
      },
    );

    return idemOutcome.body;
  }

  public async updateGuardianPhoneAndRevokeBot(
    req: RequestWithCorrelationId,
    principal: AuthenticatedStaffPrincipal,
    rawGuardianId: string,
    rawBody: unknown,
  ): Promise<GuardianInviteResponseDto> {
    const idempotencyKey = requireIdempotencyKeyHeader(req);
    const guardianId = assertValidUuid(rawGuardianId, 'guardian_id');
    const obj = assertPlainObject(rawBody, [
      'new_phone_e164',
      'reason',
      'revoke_existing_telegram_links',
      'expected_version',
      'debug_fail_after_phone_update',
    ]);

    const normalizedNewPhone = normalizePhoneE164(obj.new_phone_e164, 'new_phone_e164');
    const reason = typeof obj.reason === 'string' ? obj.reason.trim() : '';
    if (reason.length < 3 || reason.length > 255) {
      throw new ApiHttpException({
        statusCode: 400,
        errorCode: 'VALIDATION_ERROR',
        message: 'reason must be between 3 and 255 characters',
      });
    }
    if (obj.revoke_existing_telegram_links !== true) {
      throw new ApiHttpException({
        statusCode: 400,
        errorCode: 'VALIDATION_ERROR',
        message: 'revoke_existing_telegram_links must be true when updating guardian phone (D18, T06.02)',
      });
    }
    const expectedVersion = resolveExpectedVersion(req, obj.expected_version);
    const debugFail =
      this.config.nodeEnv === 'test' && obj.debug_fail_after_phone_update === true;
    const requestId = req.requestId ?? resolveRequestId(req.headers['x-request-id']);
    const now = this.clock.now();

    const newPhoneHmac = computeKeyedFieldDigest(
      this.config.internalBotHmacSecret,
      'update-guardian-phone-v1',
      normalizedNewPhone,
    );

    const idemOutcome = await executeIdempotentOperation<GuardianInviteResponseDto>(
      this.databaseService,
      {
        centerId: principal.centerId,
        actorStaffId: principal.staffId,
        operationType: 'UPDATE_GUARDIAN_PHONE_AND_REVOKE_BOT',
        idempotencyKey,
        requestPayload: {
          guardian_id: guardianId,
          new_phone_hmac: newPhoneHmac,
          reason,
          revoke_existing_telegram_links: true,
          expected_version: expectedVersion,
        },
        handler: async (tx) => {
          const guardianRes = await tx.query<{
            id: string;
            full_name: string;
            phone_e164: string;
            version: number;
          }>(
            `SELECT "id"::text AS id, "full_name", "phone_e164", "version"
               FROM "guardians"
              WHERE "id" = $1::uuid
                AND "center_id" = $2::uuid
              FOR UPDATE`,
            [guardianId, principal.centerId],
          );

          const before = guardianRes.rows[0];
          if (!before) {
            throw new ApiHttpException({
              statusCode: 404,
              errorCode: 'NOT_FOUND',
              message: 'Guardian not found in this center',
            });
          }

          if (before.phone_e164 === normalizedNewPhone) {
            throw new ApiHttpException({
              statusCode: 422,
              errorCode: 'VALIDATION_ERROR',
              message: 'new_phone_e164 must be different from the current guardian phone_e164',
            });
          }

          const collisionRes = await tx.query<{ id: string }>(
            `SELECT "id"::text AS id
               FROM "guardians"
              WHERE "center_id" = $1::uuid
                AND "phone_e164" = $2
                AND "id" <> $3::uuid
              LIMIT 1`,
            [principal.centerId, normalizedNewPhone, guardianId],
          );
          if (collisionRes.rows[0]) {
            throw new ApiHttpException({
              statusCode: 409,
              errorCode: 'VALIDATION_ERROR',
              message: 'Another guardian in this center already uses the specified phone_e164',
            });
          }

          const updatedGuardian = await executeOptimisticUpdate<{
            id: string;
            version: number;
          }>(tx, {
            tableName: 'guardians',
            entityName: 'Guardian',
            id: guardianId,
            centerId: principal.centerId,
            expectedVersion,
            setClauseSql: `"phone_e164" = $4`,
            additionalValues: [normalizedNewPhone],
          });

          // Find all non-revoked Telegram links/invites for this guardian in this center
          const oldLinksRes = await tx.query<{
            id: string;
            telegram_chat_id: string | null;
            status: string;
            version: number;
          }>(
            `SELECT "id"::text AS id,
                    "telegram_chat_id"::text AS telegram_chat_id,
                    "status"::text AS status,
                    "version"
               FROM "guardian_telegram_links"
              WHERE "center_id" = $1::uuid
                AND "guardian_id" = $2::uuid
                AND ("status" <> 'UNLINKED_REVOKED' OR "revoked_at" IS NULL)
              FOR UPDATE`,
            [principal.centerId, guardianId],
          );

          let revokedCount = 0;
          for (const link of oldLinksRes.rows) {
            const nextLinkVersion = Number(link.version) + 1;
            await tx.query(
              `UPDATE "guardian_telegram_links"
                  SET "status" = 'UNLINKED_REVOKED',
                      "revoked_at" = $3::timestamptz,
                      "revoke_reason" = 'GUARDIAN_PHONE_CHANGED',
                      "version" = $4::int,
                      "updated_at" = $3::timestamptz
                WHERE "id" = $1::uuid
                  AND "center_id" = $2::uuid`,
              [link.id, principal.centerId, now.toISOString(), nextLinkVersion],
            );
            revokedCount += 1;

            // Emit canonical GuardianLinkRevoked outbox event (events.md #14: ZERO raw phone numbers in payload!)
            const dedupKey = `GuardianLinkRevoked:${link.id}:v${nextLinkVersion}`;
            const eventPayload = {
              link_id: link.id,
              guardian_id: guardianId,
              revoked_telegram_chat_id:
                link.telegram_chat_id !== null ? Number(link.telegram_chat_id) : null,
              revoke_reason: 'GUARDIAN_PHONE_CHANGED',
              revoked_at_utc: now.toISOString(),
            };

            await tx.query(
              `INSERT INTO "outbox_events" (
                 "id", "center_id", "event_name", "schema_version",
                 "aggregate_type", "aggregate_id", "aggregate_version",
                 "dedup_key", "payload_json", "status", "occurred_at_utc", "updated_at"
               ) VALUES (
                 $1::uuid, $2::uuid, 'GuardianLinkRevoked', 1,
                 'GuardianTelegramLink', $3::uuid, $4::int,
                 $5, $6::jsonb, 'PENDING', $7::timestamptz, $7::timestamptz
               )`,
              [
                crypto.randomUUID(),
                principal.centerId,
                link.id,
                nextLinkVersion,
                dedupKey,
                JSON.stringify(eventPayload),
                now.toISOString(),
              ],
            );
          }

          // Record a revoked relink placeholder. Real invite issuance is deferred to S14; no fake bearer URL is returned or cached.
          const newLinkId = crypto.randomUUID();
          const rawInviteReference = crypto.randomBytes(32).toString('base64url');
          const inviteTokenHash = hashOpaqueToken(rawInviteReference);
          const expiresAtIso = new Date(now.getTime() + 7 * 86400 * 1000).toISOString();

          await tx.query(
            `INSERT INTO "guardian_telegram_links" (
               "id", "center_id", "guardian_id", "invite_token_hash", "invite_expires_at",
               "linked_phone_e164", "status", "version", "created_at", "updated_at", "revoked_at", "revoke_reason"
             ) VALUES (
               $1::uuid, $2::uuid, $3::uuid, $4, $5::timestamptz,
               $6, 'UNLINKED_REVOKED', 1, $7::timestamptz, $7::timestamptz, $7::timestamptz, 'RELINK_REQUIRED'
             )`,
            [
              newLinkId,
              principal.centerId,
              guardianId,
              inviteTokenHash,
              expiresAtIso,
              normalizedNewPhone,
              now.toISOString(),
            ],
          );

          // If no prior link row existed yet, still queue a GuardianLinkRevoked outbox event on the new link aggregate (v1)
          // so downstream bot session caches flush any pending state for this guardian_id.
          if (revokedCount === 0) {
            const dedupKey = `GuardianLinkRevoked:${newLinkId}:v1`;
            const eventPayload = {
              link_id: newLinkId,
              guardian_id: guardianId,
              revoked_telegram_chat_id: null,
              revoke_reason: 'GUARDIAN_PHONE_CHANGED',
              revoked_at_utc: now.toISOString(),
            };
            await tx.query(
              `INSERT INTO "outbox_events" (
                 "id", "center_id", "event_name", "schema_version",
                 "aggregate_type", "aggregate_id", "aggregate_version",
                 "dedup_key", "payload_json", "status", "occurred_at_utc", "updated_at"
               ) VALUES (
                 $1::uuid, $2::uuid, 'GuardianLinkRevoked', 1,
                 'GuardianTelegramLink', $3::uuid, 1,
                 $4, $5::jsonb, 'PENDING', $6::timestamptz, $6::timestamptz
               )`,
              [
                crypto.randomUUID(),
                principal.centerId,
                newLinkId,
                dedupKey,
                JSON.stringify(eventPayload),
                now.toISOString(),
              ],
            );
          }

          if (debugFail) {
            throw new Error('INJECTED_FAULT_AFTER_GUARDIAN_PHONE_UPDATE');
          }

          const beforePhoneHmac = computeKeyedFieldDigest(
            this.config.internalBotHmacSecret,
            'audit-guardian-phone-v1',
            before.phone_e164,
          );

          await tx.query(
            `INSERT INTO "audit_logs" (
               "id", "center_id", "actor_type", "actor_id", "actor_role",
               "action", "entity_type", "entity_id", "severity",
               "before_redacted_json", "after_redacted_json", "request_id", "created_at"
             ) VALUES (
               $1::uuid, $2::uuid, 'STAFF', $3::uuid, $4,
               'GUARDIAN_PHONE_UPDATED_AND_BOT_REVOKED', 'Guardian', $5::uuid, 'WARN',
               $6::jsonb, $7::jsonb, $8, $9::timestamptz
             )`,
            [
              crypto.randomUUID(),
              principal.centerId,
              principal.staffId,
              principal.role,
              guardianId,
              JSON.stringify({
                phone_hmac: beforePhoneHmac,
                version: before.version,
              }),
              JSON.stringify({
                phone_hmac: newPhoneHmac,
                revoked_old_links_count: revokedCount,
                new_invite_link_id: newLinkId,
                reason,
                version: Number(updatedGuardian.version),
              }),
              requestId,
              now.toISOString(),
            ],
          );

          return {
            statusCode: 200,
            body: Object.freeze({
              guardian_id: guardianId,
              single_use_invite_deeplink: null,
              relink_required: true,
              expires_at_utc: expiresAtIso,
              revoked_old_links_count: revokedCount,
              version: Number(updatedGuardian.version),
            }),
          };
        },
      },
    );

    return idemOutcome.body;
  }
}
