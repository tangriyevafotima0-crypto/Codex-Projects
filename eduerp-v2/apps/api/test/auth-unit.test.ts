import ts from 'typescript';
import 'reflect-metadata';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { AuthController } from '../src/auth/auth.controller';
import { ApiHttpException } from '../src/auth/auth.errors';
import { ClockService } from '../src/auth/clock.service';
import {
  configurePasswordHasher,
  DEFAULT_SCRYPT_N,
  DEFAULT_SCRYPT_P,
  DEFAULT_SCRYPT_R,
  DUMMY_SCRYPT_HASH,
  getPasswordHasherConfig,
  hashPassword,
  isValidScryptParams,
  parseScryptEnvelopeParams,
  verifyPassword,
  verifyPasswordConstantTime,
} from '../src/auth/password';
import {
  AUTH_ROUTE_POLICY_METADATA,
  PUBLIC_BOOTSTRAP_ROUTE_METADATA,
  RoutePolicyConfig,
} from '../src/auth/permissions.guard';
import { RosterController } from '../src/auth/roster.controller';
import { StaffController } from '../src/auth/staff.controller';
import { formatCenterLocalDate } from '../src/auth/staff.service';
import {
  generateCsrfToken,
  generateOpaqueRefreshToken,
  hashOpaqueToken,
  verifyCsrfTokenHash,
} from '../src/auth/token.service';
import {
  parseCookies,
  resolveTransportModeHeader,
  verifyTrustedOrigin,
} from '../src/auth/transport';
import {
  validateChangePasswordRequest,
  validateCreateStaffRequest,
  validateLoginRequest,
} from '../src/auth/validation';
import { loadApiEnv } from '../src/config/env';
import {
  assertNoSecretMaterialInIdempotencyPayload,
  computeKeyedFieldDigest,
  executeIdempotentOperation,
} from '../src/database/idempotency';
import { CoursesController } from '../src/academics/courses.controller';
import { GradesController } from '../src/academics/grades.controller';
import { GroupsController } from '../src/academics/groups.controller';
import { LessonsController } from '../src/academics/lessons.controller';
import { SubstitutionsController } from '../src/academics/substitutions.controller';
import { AuthService } from '../src/auth/auth.service';
import { HealthController } from '../src/health/health.controller';
import { ReadinessController } from '../src/health/readiness.controller';
import { StudentsController } from '../src/students/students.controller';

describe('Stage 05 Auth, Scrypt Cost Parity (G06), Keyed Idempotency (G01/G05), Timezone Scope (G04) & Default-Deny Inventory (G07)', () => {
  it('hashes passwords with async crypto.scrypt, enforces production DUMMY_SCRYPT_HASH cost parity (N=131072), and returns 429 when queue saturates (AUTH-UNIT-01 / G06)', async () => {
    const pw = 'StrongUnitPass_2026!';
    const hash1 = await hashPassword(pw, { N: 16384 });
    const hash2 = await hashPassword(pw, { N: 16384 });

    assert.notEqual(hash1, hash2, 'Random salt must produce distinct hashes for identical password');
    assert.match(hash1, /^\$scrypt\$v=1\$n=16384,r=8,p=1\$/);
    assert.equal(DEFAULT_SCRYPT_N, 131072);

    // G06: Verify DUMMY_SCRYPT_HASH uses exact production cost N=131072, r=8, p=1 and password.ts never imports seed-contract
    const dummyParams = parseScryptEnvelopeParams(DUMMY_SCRYPT_HASH);
    assert.deepEqual(dummyParams, {
      N: DEFAULT_SCRYPT_N,
      r: DEFAULT_SCRYPT_R,
      p: DEFAULT_SCRYPT_P,
    });

    const passwordSourcePath = path.resolve(__dirname, '../../src/auth/password.ts');
    const fallbackSourcePath = path.resolve(__dirname, '../src/auth/password.ts');
    const actualPasswordSource = fs.existsSync(passwordSourcePath)
      ? fs.readFileSync(passwordSourcePath, 'utf8')
      : fs.existsSync(fallbackSourcePath)
        ? fs.readFileSync(fallbackSourcePath, 'utf8')
        : '';
    if (actualPasswordSource) {
      assert.equal(
        ts.createSourceFile('password.ts', actualPasswordSource, ts.ScriptTarget.Latest, true).statements.some((node) => ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text.includes('seed-contract')),
        false,
        'Production password.ts must not import seed-contract (G06)',
      );
    }

    assert.equal(await verifyPassword(pw, hash1), true);
    assert.equal(await verifyPassword(pw, hash2), true);
    assert.equal(await verifyPassword('WrongPassword_2026!', hash1), false);
    assert.equal(await verifyPasswordConstantTime(pw, null), false);

    // Rejects hostile scrypt parameters safely
    assert.equal(isValidScryptParams(15000, 8, 1), false);
    assert.equal(isValidScryptParams(1073741824, 8, 1), false);
    assert.equal(isValidScryptParams(16384, 99, 1), false);
    assert.equal(
      await verifyPassword(
        pw,
        '$scrypt$v=1$n=1073741824,r=8,p=1$aaaaaaaaaaaaaaaaaaaaaa$bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      ),
      false,
    );

    // G06: Bounded concurrency/queue throws safe 429 RATE_LIMITED (ApiHttpException) when saturated
    const prevCfg = getPasswordHasherConfig();
    configurePasswordHasher({ maxConcurrency: 1, maxQueueDepth: 1 });
    try {
      const p1 = hashPassword(pw, { N: 16384 });
      const p2 = hashPassword(pw, { N: 16384 });
      const p3 = hashPassword(pw, { N: 16384 });
      await assert.rejects(
        () => p3,
        (err: unknown) =>
          err instanceof ApiHttpException &&
          err.statusCode === 429 &&
          err.errorCode === 'RATE_LIMITED',
      );
      await Promise.all([p1, p2]);
    } finally {
      configurePasswordHasher(prevCfg);
    }
  });

  it('enforces G01/G05 idempotency secret guards, keyed HMAC field digests, and G04 center-timezone date formatting (AUTH-UNIT-02)', async () => {
    const refresh = generateOpaqueRefreshToken();
    assert.ok(refresh.length >= 60);
    assert.equal(hashOpaqueToken(refresh).length, 64);

    const csrf = generateCsrfToken();
    const csrfHash = hashOpaqueToken(csrf);
    assert.equal(verifyCsrfTokenHash(csrf, csrfHash), true);
    assert.equal(verifyCsrfTokenHash('wrong-csrf-token', csrfHash), false);

    const clock = new ClockService();
    const fixed = new Date('2026-11-03T20:30:00.000Z'); // 2026-11-04 01:30:00+05:00 in Asia/Tashkent!
    clock.setTestNow(fixed);
    assert.equal(formatCenterLocalDate(clock.now(), 'Asia/Tashkent'), '2026-11-04');
    assert.equal(formatCenterLocalDate(clock.now(), 'UTC'), '2026-11-03');

    // G01: executeIdempotentOperation forbids LOGIN_STAFF and rejects secret token payloads
    await assert.rejects(
      () =>
        executeIdempotentOperation({} as never, {
          centerId: '11111111-2222-4333-8444-555555555555',
          actorStaffId: null,
          operationType: 'LOGIN_STAFF',
          idempotencyKey: 'idem-forbidden-login',
          requestPayload: {},
          handler: async () => ({ statusCode: 200, body: {} }),
        }),
      /SECURITY_BOUNDARY_G01/,
    );
    assert.throws(
      () => assertNoSecretMaterialInIdempotencyPayload(JSON.stringify({ access_token: 'jwt' })),
      /SECURITY_BOUNDARY_G01/,
    );
    assert.throws(
      () => assertNoSecretMaterialInIdempotencyPayload(JSON.stringify({ refresh_token: 'ref' })),
      /SECURITY_BOUNDARY_G01/,
    );

    // G05: Keyed HMAC field digest differentiates distinct phones/passwords without exposing raw values
    const secret = 'TestOnly_InternalBotHmacSecret_32CharsLong_03';
    const d1 = computeKeyedFieldDigest(secret, 'staff-phone-v1', '+998901112233');
    const d2 = computeKeyedFieldDigest(secret, 'staff-phone-v1', '+998901112244');
    assert.ok(d1 && d2 && d1 !== d2);
    assert.equal(d1.includes('901112233'), false);
  });

  it('validates cookie vs bearer transport, DTO schemas, and verifies 100% controller route policy coverage under default-deny (AUTH-UNIT-03 / G07)', () => {
    const config = loadApiEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'error',
      API_HOST: '127.0.0.1',
      API_PORT: '3000',
      CENTER_ID: '11111111-2222-4333-8444-555555555555',
      CENTER_SLUG: 'guliston-ilm',
      CENTER_TIMEZONE: 'Asia/Tashkent',
      LICENSE_MODE: 'ACTIVE',
      DATABASE_URL: 'postgresql://eduerp_api:pass@127.0.0.1:5432/eduerp_guliston_ilm_dev',
      JWT_ACCESS_SECRET: 'TestOnly_JwtAccessSecret_AtLeast32CharsLong_01',
      JWT_REFRESH_SECRET: 'TestOnly_JwtRefreshSecret_AtLeast32CharsLong_02',
      INTERNAL_BOT_HMAC_SECRET: 'TestOnly_InternalBotHmacSecret_32CharsLong_03',
      TELEGRAM_WEBHOOK_SECRET: 'TestOnly_TelegramWebhookSecret_24',
    });

    assert.equal('migrationDatabaseUrl' in config, false);

    const cookies = parseCookies('eduerp_refresh_token=tok123; eduerp_csrf_token=csrf456');
    assert.equal(cookies.eduerp_refresh_token, 'tok123');
    assert.equal(
      resolveTransportModeHeader({ headers: { 'x-auth-transport': 'cookie' } } as never),
      'COOKIE',
    );
    verifyTrustedOrigin({ headers: { origin: 'https://guliston-ilm.eduerp.uz' } } as never, config);
    assert.throws(() =>
      verifyTrustedOrigin({ headers: { origin: 'https://untrusted.example.com' } } as never, config),
    );

    const validCreate = validateCreateStaffRequest({
      full_name: 'New Teacher',
      login_username: 'new.teacher',
      role: 'TEACHER',
      phone_e164: '+998901234567',
      initial_password: 'ValidInitialPassword_1!',
    });
    assert.equal(validCreate.role, 'TEACHER');

    assert.throws(() =>
      validateLoginRequest({
        username: 'director.demo',
        password: 'ValidPassword_1!',
        is_admin: true,
      }),
    );

    assert.throws(() =>
      validateChangePasswordRequest(
        { headers: { 'if-match-version': '2' } } as never,
        {
          current_password: 'OldPassword_1!',
          new_password: 'NewPassword_2!',
          expected_version: 1,
        },
      ),
    );

    // G07: Inspect all registered controllers and verify every route handler declares either
    // @PublicBootstrap or @RequireRoutePolicy (zero unprotected endpoints!)
    const controllers = [
      HealthController,
      ReadinessController,
      AuthController,
      StaffController,
      RosterController,
      StudentsController,
      CoursesController,
      GroupsController,
      LessonsController,
      SubstitutionsController,
      GradesController,
    ];
    const publicActions: string[] = [];
    const protectedPolicies: RoutePolicyConfig[] = [];

    for (const ctrl of controllers) {
      const proto = ctrl.prototype;
      for (const propName of Object.getOwnPropertyNames(proto)) {
        if (propName === 'constructor') continue;
        const fn: unknown = Reflect.get(proto, propName);
        if (typeof fn !== 'function') continue;

        const pubAction = Reflect.getMetadata(PUBLIC_BOOTSTRAP_ROUTE_METADATA, fn) as
          | string
          | undefined;
        const routePolicy = Reflect.getMetadata(AUTH_ROUTE_POLICY_METADATA, fn) as
          | RoutePolicyConfig
          | undefined;

        assert.ok(
          Boolean(pubAction) !== Boolean(routePolicy),
          `Controller ${ctrl.name}.${propName} must have exactly one of @PublicBootstrap or @RequireRoutePolicy (G07)`,
        );
        if (pubAction) {
          publicActions.push(pubAction);
        }
        if (routePolicy) {
          protectedPolicies.push(routePolicy);
        }
      }
    }

    assert.deepEqual(publicActions.sort(), [
      'getDatabaseReadiness',
      'getSystemHealth',
      'loginStaff',
      'refreshStaffSession',
    ]);
    assert.equal(protectedPolicies.length, 33);
  });

  it('fails closed with 503 DATABASE_UNAVAILABLE and zero secret leakage when shared rate-limit store is unavailable (AUTH-UNIT-04 / R1)', async () => {
    const config = loadApiEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'error',
      API_HOST: '127.0.0.1',
      API_PORT: '3000',
      CENTER_ID: '11111111-2222-4333-8444-555555555555',
      CENTER_SLUG: 'guliston-ilm',
      CENTER_TIMEZONE: 'Asia/Tashkent',
      LICENSE_MODE: 'ACTIVE',
      DATABASE_URL: 'postgresql://eduerp_api:SuperSecretDbPassword_999@127.0.0.1:5432/eduerp_guliston_ilm_dev',
      JWT_ACCESS_SECRET: 'TestOnly_JwtAccessSecret_AtLeast32CharsLong_01',
      JWT_REFRESH_SECRET: 'TestOnly_JwtRefreshSecret_AtLeast32CharsLong_02',
      INTERNAL_BOT_HMAC_SECRET: 'TestOnly_InternalBotHmacSecret_32CharsLong_03',
      TELEGRAM_WEBHOOK_SECRET: 'TestOnly_TelegramWebhookSecret_24',
    });

    const failingDbService = {
      query: async () => {
        throw new Error(
          'permission denied for table auth_rate_limit_buckets (postgresql://eduerp_api:SuperSecretDbPassword_999@127.0.0.1:5432/db)',
        );
      },
    };
    const svc = new AuthService(
      config,
      failingDbService as never,
      {} as never,
      new ClockService(),
    );

    await assert.rejects(
      () => svc.checkAndIncrementSharedIpRateLimit('203.0.113.55', new Date()),
      (err: unknown) => {
        assert.ok(err instanceof ApiHttpException);
        assert.equal(err.statusCode, 503);
        assert.equal(err.errorCode, 'DATABASE_UNAVAILABLE');
        assert.equal(err.message.includes('SuperSecretDbPassword_999'), false);
        assert.equal(err.message.includes('postgresql://'), false);
        return true;
      },
    );
  });
});
