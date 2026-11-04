import { Inject, Injectable } from '@nestjs/common';
import type { StaffRole } from '@eduerp/contracts';
import * as crypto from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { ApiEnvConfig } from '../config/env';
import { API_CONFIG_TOKEN } from '../config/tokens';
import { ApiHttpException } from './auth.errors';
import { ClockService } from './clock.service';

const UUID_REGEX = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const ALLOWED_ROLES: ReadonlySet<string> = new Set(['DIRECTOR', 'ADMIN', 'TEACHER']);

export interface StaffAccessTokenClaims {
  readonly sub: string;
  readonly sid: string;
  readonly cid: string;
  readonly cslug: string;
  readonly role: StaffRole;
  readonly sv: number;
  readonly mcp: boolean;
  readonly token_use: 'staff_access';
  readonly jti: string;
  readonly iat: number;
  readonly exp: number;
  readonly iss: string;
  readonly aud: string;
}

export function generateOpaqueRefreshToken(): string {
  return crypto.randomBytes(48).toString('base64url');
}

export function hashOpaqueToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

export function generateCsrfToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function verifyCsrfTokenHash(rawToken: string | undefined, expectedHash: string | null): boolean {
  if (!rawToken || typeof rawToken !== 'string' || !expectedHash || expectedHash.trim().length !== 64) {
    return false;
  }
  const actualHash = Buffer.from(hashOpaqueToken(rawToken.trim()), 'utf8');
  const expectedBuf = Buffer.from(expectedHash.trim(), 'utf8');
  if (actualHash.length !== expectedBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(actualHash, expectedBuf);
}

@Injectable()
export class TokenService {
  private readonly secretKey: Uint8Array;
  private readonly issuer: string;
  private readonly audience: string;

  constructor(
    @Inject(API_CONFIG_TOKEN) private readonly config: ApiEnvConfig,
    @Inject(ClockService) private readonly clock: ClockService,
  ) {
    this.secretKey = new TextEncoder().encode(this.config.jwtAccessSecret);
    this.issuer = `eduerp:center:${this.config.centerSlug}`;
    this.audience = `eduerp:center-api:${this.config.centerId}`;
  }

  public getExpectedIssuer(): string {
    return this.issuer;
  }

  public getExpectedAudience(): string {
    return this.audience;
  }

  public async issueStaffAccessToken(params: {
    readonly staffId: string;
    readonly sessionId: string;
    readonly role: StaffRole;
    readonly staffVersion: number;
    readonly mustChangePassword: boolean;
    readonly ttlSeconds?: number;
  }): Promise<{ accessToken: string; jti: string; expiresAtUtc: string }> {
    const nowSec = Math.floor(this.clock.now().getTime() / 1000);
    const ttl = params.ttlSeconds ?? this.config.jwtAccessTtlSeconds;
    const expSec = nowSec + ttl;
    const jti = crypto.randomUUID();

    const accessToken = await new SignJWT({
      sid: params.sessionId,
      cid: this.config.centerId,
      cslug: this.config.centerSlug,
      role: params.role,
      sv: params.staffVersion,
      mcp: params.mustChangePassword,
      token_use: 'staff_access',
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(params.staffId)
      .setIssuer(this.issuer)
      .setAudience(this.audience)
      .setJti(jti)
      .setIssuedAt(nowSec)
      .setExpirationTime(expSec)
      .sign(this.secretKey);

    return {
      accessToken,
      jti,
      expiresAtUtc: new Date(expSec * 1000).toISOString(),
    };
  }

  public async verifyStaffAccessToken(rawToken: string): Promise<StaffAccessTokenClaims> {
    if (!rawToken || typeof rawToken !== 'string' || rawToken.length > 2048) {
      throw new ApiHttpException({
        statusCode: 401,
        errorCode: 'UNAUTHORIZED',
        message: 'Invalid or missing access token',
      });
    }

    try {
      const { payload, protectedHeader } = await jwtVerify(rawToken, this.secretKey, {
        algorithms: ['HS256'],
        issuer: this.issuer,
        audience: this.audience,
        currentDate: this.clock.now(),
      });

      if (protectedHeader.alg !== 'HS256') {
        throw new Error('Unsupported JWT algorithm');
      }

      const sub = typeof payload.sub === 'string' ? payload.sub : '';
      const sid = typeof payload.sid === 'string' ? payload.sid : '';
      const cid = typeof payload.cid === 'string' ? payload.cid : '';
      const cslug = typeof payload.cslug === 'string' ? payload.cslug : '';
      const role = typeof payload.role === 'string' ? payload.role : '';
      const sv = typeof payload.sv === 'number' ? payload.sv : 0;
      const mcp = typeof payload.mcp === 'boolean' ? payload.mcp : null;
      const tokenUse = payload.token_use;
      const jti = typeof payload.jti === 'string' ? payload.jti : '';
      const iat = typeof payload.iat === 'number' ? payload.iat : 0;
      const exp = typeof payload.exp === 'number' ? payload.exp : 0;

      if (
        !UUID_REGEX.test(sub) ||
        !UUID_REGEX.test(sid) ||
        !UUID_REGEX.test(jti) ||
        cid !== this.config.centerId ||
        cslug !== this.config.centerSlug ||
        !ALLOWED_ROLES.has(role) ||
        !Number.isInteger(sv) ||
        sv < 1 ||
        mcp === null ||
        tokenUse !== 'staff_access' ||
        exp <= iat
      ) {
        throw new Error('Invalid staff access token claim structure');
      }

      return Object.freeze({
        sub,
        sid,
        cid,
        cslug,
        role: role as StaffRole,
        sv,
        mcp,
        token_use: 'staff_access',
        jti,
        iat,
        exp,
        iss: this.issuer,
        aud: this.audience,
      });
    } catch {
      throw new ApiHttpException({
        statusCode: 401,
        errorCode: 'UNAUTHORIZED',
        message: 'Invalid, expired, or untrusted access token',
      });
    }
  }
}
