import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import type { LicenseMode, StaffRole } from '@eduerp/contracts';
import { ApiEnvConfig } from '../config/env';
import { RequestWithCorrelationId } from '../common/request-id.middleware';
import { DatabaseService } from '../database/database.service';
import { API_CONFIG_TOKEN } from '../health/health.controller';
import { ApiHttpException } from './auth.errors';
import { ClockService } from './clock.service';
import { TokenService } from './token.service';
import { AuthTransportMode, enforceCookieCsrfAndOrigin } from './transport';

export const AUTH_ROUTE_POLICY_METADATA = 'EDUERP_AUTH_ROUTE_POLICY';
export const PUBLIC_BOOTSTRAP_ROUTE_METADATA = 'EDUERP_PUBLIC_BOOTSTRAP_ROUTE';

export interface AuthenticatedStaffPrincipal {
  readonly staffId: string;
  readonly sessionId: string;
  readonly familyId: string;
  readonly centerId: string;
  readonly centerSlug: string;
  readonly role: StaffRole;
  readonly staffVersion: number;
  readonly mustChangePassword: boolean;
  readonly transportMode: AuthTransportMode;
  readonly csrfTokenHash: string | null;
  readonly licenseMode: LicenseMode;
}

export interface RequestWithAuthPrincipal extends RequestWithCorrelationId {
  principal?: AuthenticatedStaffPrincipal;
}

export interface RoutePolicyConfig {
  readonly actionId: string;
  readonly allowedRoles: readonly StaffRole[];
  readonly allowWhenMustChangePassword?: boolean;
  readonly readOnlyLicensePolicy:
    | 'ALLOWED_IN_READ_ONLY'
    | 'ALLOWED_SYSTEM_OPERATION'
    | 'BLOCKED_403_LICENSE_READ_ONLY_MODE';
  readonly unconfirmedRolesDeniedWithPolicyGate?: readonly StaffRole[];
}

export function RequireRoutePolicy(policy: RoutePolicyConfig): MethodDecorator {
  return SetMetadata(AUTH_ROUTE_POLICY_METADATA, policy);
}

export function PublicBootstrap(actionId: string): MethodDecorator {
  return SetMetadata(PUBLIC_BOOTSTRAP_ROUTE_METADATA, actionId);
}

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    @Inject(API_CONFIG_TOKEN) private readonly config: ApiEnvConfig,
    @Inject(DatabaseService) private readonly databaseService: DatabaseService,
    @Inject(TokenService) private readonly tokenService: TokenService,
    @Inject(ClockService) private readonly clock: ClockService,
  ) {}

  public async canActivate(context: ExecutionContext): Promise<boolean> {
    const handler = context.getHandler();
    const isPublicBootstrap = Reflect.getMetadata(
      PUBLIC_BOOTSTRAP_ROUTE_METADATA,
      handler,
    ) as string | undefined;

    if (isPublicBootstrap) {
      return true;
    }

    const policy = Reflect.getMetadata(AUTH_ROUTE_POLICY_METADATA, handler) as
      | RoutePolicyConfig
      | undefined;

    // Default-deny (G07): any registered endpoint without @PublicBootstrap or @RequireRoutePolicy fails closed.
    if (!policy) {
      throw new ApiHttpException({
        statusCode: 403,
        errorCode: 'FORBIDDEN_ROLE',
        message: 'Endpoint access denied: route policy metadata is not configured (default-deny)',
      });
    }

    const req = context.switchToHttp().getRequest<RequestWithAuthPrincipal>();
    if (req.principal) {
      return true;
    }

    const authHeader = req.headers.authorization;
    const rawAuth = Array.isArray(authHeader) ? authHeader[0] : authHeader;
    if (!rawAuth || typeof rawAuth !== 'string' || !rawAuth.startsWith('Bearer ')) {
      throw new ApiHttpException({
        statusCode: 401,
        errorCode: 'UNAUTHORIZED',
        message: 'Missing or invalid Bearer Authorization header',
      });
    }

    const rawToken = rawAuth.slice('Bearer '.length).trim();
    const claims = await this.tokenService.verifyStaffAccessToken(rawToken);
    const now = this.clock.now();

    // Verify live session (including absolute family_expires_at deadline — G05), live staff status/role/version, and center license mode
    const dbRes = await this.databaseService.query<{
      session_id: string;
      family_id: string;
      session_revoked_at: Date | null;
      session_expires_at: Date;
      family_expires_at: Date | null;
      transport_mode: AuthTransportMode;
      csrf_token_hash: string | null;
      staff_id: string;
      staff_role: StaffRole;
      staff_status: string;
      staff_version: number;
      must_change_password: boolean;
      license_status: LicenseMode | null;
    }>(
      `SELECT s."id"::text AS session_id,
              s."family_id"::text AS family_id,
              s."revoked_at" AS session_revoked_at,
              s."expires_at" AS session_expires_at,
              COALESCE(s."family_expires_at", s."expires_at") AS family_expires_at,
              s."transport_mode"::text AS transport_mode,
              s."csrf_token_hash"::text AS csrf_token_hash,
              u."id"::text AS staff_id,
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
        WHERE s."id" = $1::uuid
          AND s."staff_id" = $2::uuid
          AND s."center_id" = $3::uuid
        LIMIT 1`,
      [claims.sid, claims.sub, this.config.centerId],
    );

    const row = dbRes.rows[0];
    if (!row) {
      throw new ApiHttpException({
        statusCode: 401,
        errorCode: 'UNAUTHORIZED',
        message: 'Session or staff account not found in center scope',
      });
    }

    const effectiveFamilyDeadlineMs = row.family_expires_at
      ? new Date(row.family_expires_at).getTime()
      : new Date(row.session_expires_at).getTime();

    if (
      row.session_revoked_at !== null ||
      new Date(row.session_expires_at).getTime() <= now.getTime() ||
      effectiveFamilyDeadlineMs <= now.getTime() ||
      row.staff_status !== 'ACTIVE' ||
      row.staff_role !== claims.role ||
      Number(row.staff_version) !== claims.sv
    ) {
      throw new ApiHttpException({
        statusCode: 401,
        errorCode: 'UNAUTHORIZED',
        message: 'Session has been revoked, expired, or staff privileges changed',
      });
    }

    const effectiveLicenseMode: LicenseMode = row.license_status ?? this.config.licenseMode;

    // Enforce browser cookie CSRF + Origin protection on unsafe state-changing HTTP methods
    const method = (req.method ?? 'GET').toUpperCase();
    if (
      row.transport_mode === 'COOKIE' &&
      (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE')
    ) {
      enforceCookieCsrfAndOrigin(req, this.config, row.csrf_token_hash);
    }

    // Enforce first-login must_change_password restriction (05.01)
    if (row.must_change_password && !policy.allowWhenMustChangePassword) {
      throw new ApiHttpException({
        statusCode: 403,
        errorCode: 'FORBIDDEN_ROLE',
        message: 'Initial password change is required before accessing protected center operations',
      });
    }

    // Enforce unconfirmed policy gate (OPEN_RBAC_01 non-create actions remain fail-closed)
    if (
      policy.unconfirmedRolesDeniedWithPolicyGate &&
      policy.unconfirmedRolesDeniedWithPolicyGate.includes(row.staff_role)
    ) {
      throw new ApiHttpException({
        statusCode: 403,
        errorCode: 'POLICY_DECISION_NOT_CONFIRMED',
        message: `Role ${row.staff_role} is not permitted for ${policy.actionId} (OPEN_RBAC_01 policy decision not confirmed)`,
      });
    }

    // Enforce RBAC role check
    if (!policy.allowedRoles.includes(row.staff_role)) {
      throw new ApiHttpException({
        statusCode: 403,
        errorCode: 'FORBIDDEN_ROLE',
        message: `Role ${row.staff_role} is forbidden from performing ${policy.actionId}`,
      });
    }

    // Enforce Read-Only Kill-Switch license mode gate
    if (
      effectiveLicenseMode === 'READ_ONLY' &&
      policy.readOnlyLicensePolicy === 'BLOCKED_403_LICENSE_READ_ONLY_MODE'
    ) {
      throw new ApiHttpException({
        statusCode: 403,
        errorCode: 'LICENSE_READ_ONLY_MODE',
        message: 'Center is currently in LICENSE_READ_ONLY_MODE; write operations are disabled',
      });
    }

    req.principal = Object.freeze({
      staffId: row.staff_id,
      sessionId: row.session_id,
      familyId: row.family_id,
      centerId: this.config.centerId,
      centerSlug: this.config.centerSlug,
      role: row.staff_role,
      staffVersion: Number(row.staff_version),
      mustChangePassword: Boolean(row.must_change_password),
      transportMode: row.transport_mode,
      csrfTokenHash: row.csrf_token_hash,
      licenseMode: effectiveLicenseMode,
    });

    return true;
  }
}
