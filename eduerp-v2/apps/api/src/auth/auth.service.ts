import { Inject, Injectable } from '@nestjs/common';
import type { LicenseMode, StaffRole } from '@eduerp/contracts';
import * as crypto from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { ApiEnvConfig } from '../config/env';
import { RequestWithCorrelationId, resolveRequestId } from '../common/request-id.middleware';
import { DatabaseService } from '../database/database.service';
import { executeIdempotentOperation } from '../database/idempotency';
import { executeOptimisticUpdate, runInTransaction } from '../database/transaction';
import { API_CONFIG_TOKEN } from '../health/health.controller';
import { ApiHttpException } from './auth.errors';
import { ClockService } from './clock.service';
import { hashPassword, verifyPassword, verifyPasswordConstantTime } from './password';
import { AuthenticatedStaffPrincipal } from './permissions.guard';
import {
  generateCsrfToken,
  generateOpaqueRefreshToken,
  hashOpaqueToken,
  TokenService,
} from './token.service';
import {
  AuthTransportMode,
  clearBrowserSessionCookies,
  enforceCookieCsrfAndOrigin,
  parseCookies,
  REDACTED_COOKIE_REFRESH_PLACEHOLDER,
  REFRESH_COOKIE_NAME,
  resolveClientIp,
  resolveTransportModeHeader,
  setBrowserSessionCookies,
  verifyTrustedOrigin,
} from './transport';
import {
  requireIdempotencyKeyHeader,
  validateChangePasswordRequest,
  validateLoginRequest,
  validateRefreshRequest,
} from './validation';

export interface StaffAuthResponseDto {
  readonly access_token: string;
  readonly refresh_token: string;
  readonly staff_id: string;
  readonly role: StaffRole;
  readonly must_change_password: boolean;
  readonly license_mode: LicenseMode;
}

export interface StaffUserResponseDto {
  readonly id: string;
  readonly full_name: string;
  readonly login_username: string;
  readonly role: StaffRole;
  readonly status: 'ACTIVE' | 'DEACTIVATED';
  readonly version: number;
}

export interface StaffLogoutResponseDto {
  readonly session_id: string;
  readonly revoked: boolean;
  readonly revoked_at_utc: string;
}

interface RateLimitBucket {
  count: number;
  windowStartMs: number;
}

@Injectable()
export class AuthService {
  private readonly loginBuckets = new Map<string, RateLimitBucket>();

  constructor(
    @Inject(API_CONFIG_TOKEN) private readonly config: ApiEnvConfig,
    @Inject(DatabaseService) private readonly databaseService: DatabaseService,
    @Inject(TokenService) private readonly tokenService: TokenService,
    @Inject(ClockService) private readonly clock: ClockService,
  ) {}

  public clearRateLimitBucketsForTest(): void {
    this.loginBuckets.clear();
  }

  private checkAndIncrementIpRateLimit(username: string, clientIp: string, nowMs: number): void {
    const windowMs = this.config.authRateLimitWindowSeconds * 1000;
    const key = `${this.config.centerSlug}:${username.toLowerCase()}:${clientIp}`;
    const bucket = this.loginBuckets.get(key);
    if (!bucket || nowMs - bucket.windowStartMs >= windowMs) {
      this.loginBuckets.set(key, { count: 1, windowStartMs: nowMs });
      return;
    }
    if (bucket.count >= this.config.authRateLimitMaxRequests) {
      const retryAfter = Math.max(1, Math.ceil((bucket.windowStartMs + windowMs - nowMs) / 1000));
      throw new ApiHttpException({
        statusCode: 429,
        errorCode: 'RATE_LIMITED',
        message: 'Too many login attempts; please try again later',
        retryAfterSeconds: retryAfter,
      });
    }
    bucket.count += 1;
  }

  public async loginStaff(
    req: RequestWithCorrelationId,
    res: ServerResponse,
    rawBody: unknown,
  ): Promise<StaffAuthResponseDto> {
    const idempotencyKey = requireIdempotencyKeyHeader(req);
    const transportMode: AuthTransportMode = resolveTransportModeHeader(req);
    if (transportMode === 'COOKIE') {
      verifyTrustedOrigin(req, this.config);
    }

    const dto = validateLoginRequest(rawBody);
    const requestId = req.requestId ?? resolveRequestId(req.headers['x-request-id']);
    const clientIp = resolveClientIp(req, this.config);
    const now = this.clock.now();

    // Check if this exact idempotency key was already completed before incrementing rate limits
    const idemOutcome = await executeIdempotentOperation<{
      authResponse: StaffAuthResponseDto;
      rawRefreshToken: string;
      rawCsrfToken: string;
      transportMode: AuthTransportMode;
    }>(this.databaseService, {
      centerId: this.config.centerId,
      actorStaffId: null,
      operationType: 'LOGIN_STAFF',
      idempotencyKey,
      requestPayload: {
        username: dto.username,
        device_info: dto.deviceInfo,
        transport_mode: transportMode,
      },
      handler: async (tx) => {
        this.checkAndIncrementIpRateLimit(dto.username, clientIp, now.getTime());

        const staffRes = await tx.query<{
          id: string;
          role: StaffRole;
          status: 'ACTIVE' | 'DEACTIVATED';
          password_hash: string;
          must_change_password: boolean;
          failed_login_count: number;
          locked_until: Date | null;
          version: number;
        }>(
          `SELECT "id"::text AS id,
                  "role"::text AS role,
                  "status"::text AS status,
                  "password_hash",
                  "must_change_password",
                  "failed_login_count",
                  "locked_until",
                  "version"
             FROM "staff_users"
            WHERE "center_id" = $1::uuid
              AND "login_username" = $2
            FOR UPDATE`,
          [this.config.centerId, dto.username],
        );

        const staff = staffRes.rows[0];

        // Always execute constant-time scrypt verification to prevent timing account enumeration
        const passwordValid = await verifyPasswordConstantTime(dto.password, staff?.password_hash);

        if (staff && staff.locked_until && new Date(staff.locked_until).getTime() > now.getTime()) {
          const retryAfter = Math.max(
            1,
            Math.ceil((new Date(staff.locked_until).getTime() - now.getTime()) / 1000),
          );
          throw new ApiHttpException({
            statusCode: 429,
            errorCode: 'RATE_LIMITED',
            message: 'Account temporarily locked due to repeated failed login attempts',
            retryAfterSeconds: retryAfter,
          });
        }

        if (!staff || staff.status !== 'ACTIVE' || !passwordValid) {
          // Record failed login count in an autonomous connection so rolling back via throw preserves the counter
          if (staff && staff.status === 'ACTIVE') {
            await this.recordFailedLoginAttemptAtomically(staff.id, now, requestId);
          }
          throw new ApiHttpException({
            statusCode: 401,
            errorCode: 'UNAUTHORIZED',
            message: 'Invalid username or password',
          });
        }

        await tx.query(
          `UPDATE "staff_users"
              SET "failed_login_count" = 0,
                  "locked_until" = NULL,
                  "updated_at" = $2::timestamptz
            WHERE "id" = $1::uuid`,
          [staff.id, now.toISOString()],
        );

        const licRes = await tx.query<{ license_status: LicenseMode }>(
          `SELECT "license_status"::text AS license_status
             FROM "center_licenses"
            WHERE "center_id" = $1::uuid
            LIMIT 1`,
          [this.config.centerId],
        );
        const licenseMode: LicenseMode = licRes.rows[0]?.license_status ?? this.config.licenseMode;

        const sessionId = crypto.randomUUID();
        const rawRefreshToken = generateOpaqueRefreshToken();
        const refreshTokenHash = hashOpaqueToken(rawRefreshToken);
        const rawCsrfToken = generateCsrfToken();
        const csrfTokenHash = hashOpaqueToken(rawCsrfToken);
        const expiresAt = new Date(
          now.getTime() + this.config.sessionRefreshTtlSeconds * 1000,
        ).toISOString();

        await tx.query(
          `INSERT INTO "staff_sessions" (
             "id",
             "center_id",
             "staff_id",
             "refresh_token_hash",
             "role_snapshot",
             "device_info",
             "expires_at",
             "family_id",
             "csrf_token_hash",
             "transport_mode",
             "staff_version_snapshot",
             "version",
             "created_at",
             "updated_at"
           ) VALUES (
             $1::uuid,
             $2::uuid,
             $3::uuid,
             $4,
             $5,
             $6,
             $7::timestamptz,
             $1::uuid,
             $8,
             $9,
             $10::int,
             1,
             $11::timestamptz,
             $11::timestamptz
           )`,
          [
            sessionId,
            this.config.centerId,
            staff.id,
            refreshTokenHash,
            staff.role,
            dto.deviceInfo,
            expiresAt,
            csrfTokenHash,
            transportMode,
            staff.version,
            now.toISOString(),
          ],
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
             'STAFF_LOGIN_SUCCEEDED',
             'StaffSession',
             $5::uuid,
             'INFO',
             NULL,
             $6::jsonb,
             $7,
             $8::timestamptz
           )`,
          [
            crypto.randomUUID(),
            this.config.centerId,
            staff.id,
            staff.role,
            sessionId,
            JSON.stringify({
              session_id: sessionId,
              transport_mode: transportMode,
              must_change_password: staff.must_change_password,
            }),
            requestId,
            now.toISOString(),
          ],
        );

        const { accessToken } = await this.tokenService.issueStaffAccessToken({
          staffId: staff.id,
          sessionId,
          role: staff.role,
          staffVersion: staff.version,
          mustChangePassword: staff.must_change_password,
        });

        const authResponse: StaffAuthResponseDto = {
          access_token: accessToken,
          refresh_token:
            transportMode === 'COOKIE' ? REDACTED_COOKIE_REFRESH_PLACEHOLDER : rawRefreshToken,
          staff_id: staff.id,
          role: staff.role,
          must_change_password: Boolean(staff.must_change_password),
          license_mode: licenseMode,
        };

        return {
          statusCode: 200,
          body: {
            authResponse,
            rawRefreshToken,
            rawCsrfToken,
            transportMode,
          },
        };
      },
    });

    if (idemOutcome.body.transportMode === 'COOKIE') {
      setBrowserSessionCookies(
        res,
        this.config,
        idemOutcome.body.rawRefreshToken,
        idemOutcome.body.rawCsrfToken,
      );
    }

    return idemOutcome.body.authResponse;
  }

  private async recordFailedLoginAttemptAtomically(
    staffId: string,
    now: Date,
    requestId: string,
  ): Promise<void> {
    const maxAttempts = this.config.authLockoutMaxAttempts;
    const lockDurationSec = this.config.authLockoutDurationSeconds;

    await runInTransaction(this.databaseService, async (tx) => {
      const upd = await tx.query<{
        failed_login_count: number;
        locked_until: Date | null;
      }>(
        `UPDATE "staff_users"
            SET "failed_login_count" = "failed_login_count" + 1,
                "last_failed_login_at" = $2::timestamptz,
                "locked_until" = CASE
                  WHEN "failed_login_count" + 1 >= $3::int
                  THEN $2::timestamptz + ($4::int * INTERVAL '1 second')
                  ELSE "locked_until"
                END,
                "updated_at" = $2::timestamptz
          WHERE "id" = $1::uuid
            AND "center_id" = $5::uuid
        RETURNING "failed_login_count", "locked_until"`,
        [staffId, now.toISOString(), maxAttempts, lockDurationSec, this.config.centerId],
      );

      const row = upd.rows[0];
      if (row && row.failed_login_count >= maxAttempts) {
        await tx.query(
          `INSERT INTO "audit_logs" (
             "id", "center_id", "actor_type", "actor_id", "action",
             "entity_type", "entity_id", "severity", "after_redacted_json", "request_id", "created_at"
           ) VALUES (
             $1::uuid, $2::uuid, 'STAFF', $3::uuid, 'STAFF_LOGIN_LOCKED',
             'StaffUser', $3::uuid, 'WARN', $4::jsonb, $5, $6::timestamptz
           )`,
          [
            crypto.randomUUID(),
            this.config.centerId,
            staffId,
            JSON.stringify({
              failed_login_count: row.failed_login_count,
              locked_until_utc: row.locked_until ? new Date(row.locked_until).toISOString() : null,
            }),
            requestId,
            now.toISOString(),
          ],
        );
      }
    });
  }

  public async refreshStaffSession(
    req: RequestWithCorrelationId,
    res: ServerResponse,
    rawBody: unknown,
  ): Promise<StaffAuthResponseDto> {
    const explicitMode = req.headers['x-auth-transport']
      ? resolveTransportModeHeader(req)
      : null;
    const cookies = parseCookies(req.headers.cookie);
    const hasRefreshCookie = Boolean(cookies[REFRESH_COOKIE_NAME]);
    const isCookieMode = explicitMode === 'COOKIE' || (explicitMode === null && hasRefreshCookie);

    const dto = validateRefreshRequest(rawBody, isCookieMode);
    const requestId = req.requestId ?? resolveRequestId(req.headers['x-request-id']);
    const now = this.clock.now();

    let rawRefreshToken: string;
    if (isCookieMode) {
      if (!cookies[REFRESH_COOKIE_NAME]) {
        throw new ApiHttpException({
          statusCode: 401,
          errorCode: 'UNAUTHORIZED',
          message: 'Missing refresh token cookie',
        });
      }
      rawRefreshToken = cookies[REFRESH_COOKIE_NAME];
    } else {
      if (!dto.refreshToken) {
        throw new ApiHttpException({
          statusCode: 400,
          errorCode: 'VALIDATION_ERROR',
          message: 'refresh_token is required',
        });
      }
      rawRefreshToken = dto.refreshToken;
    }

    const tokenHash = hashOpaqueToken(rawRefreshToken);

    const txOutcome = await runInTransaction(this.databaseService, async (tx) => {
      const sessRes = await tx.query<{
        id: string;
        staff_id: string;
        family_id: string;
        expires_at: Date;
        revoked_at: Date | null;
        rotated_at: Date | null;
        csrf_token_hash: string | null;
        transport_mode: AuthTransportMode;
        staff_role: StaffRole;
        staff_status: 'ACTIVE' | 'DEACTIVATED';
        staff_version: number;
        must_change_password: boolean;
        license_status: LicenseMode | null;
      }>(
        `SELECT s."id"::text AS id,
                s."staff_id"::text AS staff_id,
                s."family_id"::text AS family_id,
                s."expires_at" AS expires_at,
                s."revoked_at" AS revoked_at,
                s."rotated_at" AS rotated_at,
                s."csrf_token_hash"::text AS csrf_token_hash,
                s."transport_mode"::text AS transport_mode,
                u."role"::text AS staff_role,
                u."status"::text AS staff_status,
                u."version" AS staff_version,
                u."must_change_password" AS must_change_password,
                l."license_status"::text AS license_status
           FROM "staff_sessions" s
           JOIN "staff_users" u
             ON u."id" = s."staff_id"
            AND u."center_id" = s."center_id"
           LEFT JOIN "center_licenses" l
             ON l."center_id" = s."center_id"
          WHERE s."center_id" = $1::uuid
            AND s."refresh_token_hash" = $2
          FOR UPDATE OF s`,
        [this.config.centerId, tokenHash],
      );

      const session = sessRes.rows[0];
      if (!session) {
        return { kind: 'INVALID' as const };
      }

      // Prevent transport mode confusion: a COOKIE session cannot be refreshed via BEARER mode without CSRF/Origin
      if (session.transport_mode === 'COOKIE' && !isCookieMode) {
        return { kind: 'TRANSPORT_MISMATCH' as const };
      }
      if (session.transport_mode === 'BEARER' && isCookieMode) {
        return { kind: 'TRANSPORT_MISMATCH' as const };
      }

      if (session.transport_mode === 'COOKIE') {
        enforceCookieCsrfAndOrigin(req, this.config, session.csrf_token_hash);
      }

      // Replay detection: if rotated_at is already set, revoke the entire session family immediately!
      if (session.rotated_at !== null) {
        await tx.query(
          `UPDATE "staff_sessions"
              SET "revoked_at" = COALESCE("revoked_at", $3::timestamptz),
                  "revoke_reason" = 'REFRESH_TOKEN_REPLAY_DETECTED',
                  "version" = "version" + 1,
                  "updated_at" = $3::timestamptz
            WHERE "center_id" = $1::uuid
              AND "family_id" = $2::uuid`,
          [this.config.centerId, session.family_id, now.toISOString()],
        );

        await tx.query(
          `INSERT INTO "audit_logs" (
             "id", "center_id", "actor_type", "actor_id", "actor_role",
             "action", "entity_type", "entity_id", "severity",
             "after_redacted_json", "request_id", "created_at"
           ) VALUES (
             $1::uuid, $2::uuid, 'STAFF', $3::uuid, $4,
             'STAFF_SESSION_FAMILY_REVOKED_ON_REPLAY', 'StaffSession', $5::uuid, 'CRITICAL_RED',
             $6::jsonb, $7, $8::timestamptz
           )`,
          [
            crypto.randomUUID(),
            this.config.centerId,
            session.staff_id,
            session.staff_role,
            session.id,
            JSON.stringify({
              family_id: session.family_id,
              replayed_session_id: session.id,
            }),
            requestId,
            now.toISOString(),
          ],
        );

        return { kind: 'REPLAY_REVOKED' as const };
      }

      if (
        session.revoked_at !== null ||
        new Date(session.expires_at).getTime() <= now.getTime() ||
        session.staff_status !== 'ACTIVE'
      ) {
        return { kind: 'REVOKED_OR_EXPIRED' as const };
      }

      const newSessionId = crypto.randomUUID();
      const newRawRefreshToken = generateOpaqueRefreshToken();
      const newRefreshHash = hashOpaqueToken(newRawRefreshToken);
      const newRawCsrfToken = generateCsrfToken();
      const newCsrfHash = hashOpaqueToken(newRawCsrfToken);
      const newExpiresAt = new Date(
        now.getTime() + this.config.sessionRefreshTtlSeconds * 1000,
      ).toISOString();

      await tx.query(
        `UPDATE "staff_sessions"
            SET "rotated_at" = $2::timestamptz,
                "revoked_at" = $2::timestamptz,
                "revoke_reason" = 'ROTATED',
                "replaced_by_session_id" = $3::uuid,
                "version" = "version" + 1,
                "updated_at" = $2::timestamptz
          WHERE "id" = $1::uuid`,
        [session.id, now.toISOString(), newSessionId],
      );

      await tx.query(
        `INSERT INTO "staff_sessions" (
           "id",
           "center_id",
           "staff_id",
           "refresh_token_hash",
           "role_snapshot",
           "device_info",
           "expires_at",
           "family_id",
           "parent_session_id",
           "csrf_token_hash",
           "transport_mode",
           "staff_version_snapshot",
           "version",
           "created_at",
           "updated_at"
         ) VALUES (
           $1::uuid,
           $2::uuid,
           $3::uuid,
           $4,
           $5,
           $6,
           $7::timestamptz,
           $8::uuid,
           $9::uuid,
           $10,
           $11,
           $12::int,
           1,
           $13::timestamptz,
           $13::timestamptz
         )`,
        [
          newSessionId,
          this.config.centerId,
          session.staff_id,
          newRefreshHash,
          session.staff_role,
          dto.deviceInfo,
          newExpiresAt,
          session.family_id,
          session.id,
          newCsrfHash,
          session.transport_mode,
          session.staff_version,
          now.toISOString(),
        ],
      );

      const { accessToken } = await this.tokenService.issueStaffAccessToken({
        staffId: session.staff_id,
        sessionId: newSessionId,
        role: session.staff_role,
        staffVersion: Number(session.staff_version),
        mustChangePassword: Boolean(session.must_change_password),
      });

      const licenseMode: LicenseMode = session.license_status ?? this.config.licenseMode;

      return {
        kind: 'ROTATED' as const,
        transportMode: session.transport_mode,
        rawRefreshToken: newRawRefreshToken,
        rawCsrfToken: newRawCsrfToken,
        response: {
          access_token: accessToken,
          refresh_token:
            session.transport_mode === 'COOKIE'
              ? REDACTED_COOKIE_REFRESH_PLACEHOLDER
              : newRawRefreshToken,
          staff_id: session.staff_id,
          role: session.staff_role,
          must_change_password: Boolean(session.must_change_password),
          license_mode: licenseMode,
        } satisfies StaffAuthResponseDto,
      };
    });

    if (txOutcome.result.kind !== 'ROTATED') {
      if (isCookieMode) {
        clearBrowserSessionCookies(res, this.config);
      }
      throw new ApiHttpException({
        statusCode: 401,
        errorCode: 'UNAUTHORIZED',
        message: 'Invalid, expired, or replayed refresh token',
      });
    }

    if (txOutcome.result.transportMode === 'COOKIE') {
      setBrowserSessionCookies(
        res,
        this.config,
        txOutcome.result.rawRefreshToken,
        txOutcome.result.rawCsrfToken,
      );
    }

    return txOutcome.result.response;
  }

  public async changeStaffPassword(
    req: RequestWithCorrelationId,
    principal: AuthenticatedStaffPrincipal,
    rawBody: unknown,
  ): Promise<StaffUserResponseDto> {
    const idempotencyKey = requireIdempotencyKeyHeader(req);
    const dto = validateChangePasswordRequest(req, rawBody);
    const requestId = req.requestId ?? resolveRequestId(req.headers['x-request-id']);
    const now = this.clock.now();

    if (dto.newPassword === dto.currentPassword) {
      throw new ApiHttpException({
        statusCode: 422,
        errorCode: 'VALIDATION_ERROR',
        message: 'new_password must be distinct from current_password',
      });
    }

    // Payload hash binds to expected_version and a non-reversible digest of new_password
    const newPasswordIntentDigest = hashOpaqueToken(`pw-change:${dto.newPassword}`);
    const newPasswordScryptHash = await hashPassword(dto.newPassword);

    const idemOutcome = await executeIdempotentOperation<StaffUserResponseDto>(
      this.databaseService,
      {
        centerId: this.config.centerId,
        actorStaffId: principal.staffId,
        operationType: 'CHANGE_STAFF_PASSWORD',
        idempotencyKey,
        requestPayload: {
          expected_version: dto.expectedVersion,
          new_password_intent: newPasswordIntentDigest,
        },
        handler: async (tx) => {
          const staffRes = await tx.query<{
            id: string;
            full_name: string;
            login_username: string;
            role: StaffRole;
            status: 'ACTIVE' | 'DEACTIVATED';
            password_hash: string;
            must_change_password: boolean;
            version: number;
          }>(
            `SELECT "id"::text AS id,
                    "full_name",
                    "login_username",
                    "role"::text AS role,
                    "status"::text AS status,
                    "password_hash",
                    "must_change_password",
                    "version"
               FROM "staff_users"
              WHERE "id" = $1::uuid
                AND "center_id" = $2::uuid
              FOR UPDATE`,
            [principal.staffId, this.config.centerId],
          );

          const staff = staffRes.rows[0];
          if (!staff || staff.status !== 'ACTIVE') {
            throw new ApiHttpException({
              statusCode: 401,
              errorCode: 'UNAUTHORIZED',
              message: 'Staff account is not active',
            });
          }

          const currentOk = await verifyPassword(dto.currentPassword, staff.password_hash);
          if (!currentOk) {
            throw new ApiHttpException({
              statusCode: 401,
              errorCode: 'UNAUTHORIZED',
              message: 'Current password is incorrect',
            });
          }

          const updated = await executeOptimisticUpdate<{
            id: string;
            full_name: string;
            login_username: string;
            role: StaffRole;
            status: 'ACTIVE' | 'DEACTIVATED';
            version: number;
          }>(tx, {
            tableName: 'staff_users',
            entityName: 'StaffUser',
            id: principal.staffId,
            centerId: this.config.centerId,
            expectedVersion: dto.expectedVersion,
            setClauseSql: `"password_hash" = $4, "must_change_password" = FALSE, "password_changed_at" = $5::timestamptz`,
            additionalValues: [newPasswordScryptHash, now.toISOString()],
          });

          // Revoke all active sessions for this staff user so old tokens cannot be reused
          await tx.query(
            `UPDATE "staff_sessions"
                SET "revoked_at" = $3::timestamptz,
                    "revoke_reason" = 'PASSWORD_CHANGED',
                    "version" = "version" + 1,
                    "updated_at" = $3::timestamptz
              WHERE "center_id" = $1::uuid
                AND "staff_id" = $2::uuid
                AND "revoked_at" IS NULL`,
            [this.config.centerId, principal.staffId, now.toISOString()],
          );

          await tx.query(
            `INSERT INTO "audit_logs" (
               "id", "center_id", "actor_type", "actor_id", "actor_role",
               "action", "entity_type", "entity_id", "severity",
               "before_redacted_json", "after_redacted_json", "request_id", "created_at"
             ) VALUES (
               $1::uuid, $2::uuid, 'STAFF', $3::uuid, $4,
               'STAFF_PASSWORD_CHANGED', 'StaffUser', $3::uuid, 'INFO',
               $5::jsonb, $6::jsonb, $7, $8::timestamptz
             )`,
            [
              crypto.randomUUID(),
              this.config.centerId,
              principal.staffId,
              principal.role,
              JSON.stringify({
                must_change_password: staff.must_change_password,
                version: staff.version,
              }),
              JSON.stringify({
                must_change_password: false,
                version: Number(updated.version),
              }),
              requestId,
              now.toISOString(),
            ],
          );

          return {
            statusCode: 200,
            body: {
              id: updated.id,
              full_name: updated.full_name,
              login_username: updated.login_username,
              role: updated.role,
              status: updated.status,
              version: Number(updated.version),
            },
          };
        },
      },
    );

    return idemOutcome.body;
  }

  public async logoutStaffSession(
    req: RequestWithCorrelationId,
    res: ServerResponse,
    principal: AuthenticatedStaffPrincipal,
  ): Promise<StaffLogoutResponseDto> {
    const requestId = req.requestId ?? resolveRequestId(req.headers['x-request-id']);
    const now = this.clock.now();

    const { result } = await runInTransaction(this.databaseService, async (tx) => {
      const upd = await tx.query<{ revoked_at: Date }>(
        `UPDATE "staff_sessions"
            SET "revoked_at" = COALESCE("revoked_at", $3::timestamptz),
                "revoke_reason" = COALESCE("revoke_reason", 'USER_LOGOUT'),
                "version" = "version" + 1,
                "updated_at" = $3::timestamptz
          WHERE "id" = $1::uuid
            AND "center_id" = $2::uuid
        RETURNING "revoked_at"`,
        [principal.sessionId, this.config.centerId, now.toISOString()],
      );

      await tx.query(
        `INSERT INTO "audit_logs" (
           "id", "center_id", "actor_type", "actor_id", "actor_role",
           "action", "entity_type", "entity_id", "severity",
           "after_redacted_json", "request_id", "created_at"
         ) VALUES (
           $1::uuid, $2::uuid, 'STAFF', $3::uuid, $4,
           'STAFF_LOGOUT', 'StaffSession', $5::uuid, 'INFO',
           $6::jsonb, $7, $8::timestamptz
         )`,
        [
          crypto.randomUUID(),
          this.config.centerId,
          principal.staffId,
          principal.role,
          principal.sessionId,
          JSON.stringify({ session_id: principal.sessionId, revoked: true }),
          requestId,
          now.toISOString(),
        ],
      );

      return upd.rows[0]?.revoked_at ? new Date(upd.rows[0].revoked_at).toISOString() : now.toISOString();
    });

    if (principal.transportMode === 'COOKIE') {
      clearBrowserSessionCookies(res, this.config);
    }

    return {
      session_id: principal.sessionId,
      revoked: true,
      revoked_at_utc: result,
    };
  }
}
