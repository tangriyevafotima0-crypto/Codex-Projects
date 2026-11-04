import * as assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { SignJWT } from 'jose';
import { createApiApplication } from '../../src/application';
import { AuthService } from '../../src/auth/auth.service';
import { ClockService } from '../../src/auth/clock.service';
import { hashPassword } from '../../src/auth/password';
import {
  CSRF_COOKIE_NAME,
  REDACTED_COOKIE_REFRESH_PLACEHOLDER,
  REFRESH_COOKIE_NAME,
} from '../../src/auth/transport';
import { loadApiEnv } from '../../src/config/env';
import {
  executeSyntheticSeed,
  SYNTHETIC_DEMO_CENTER_A,
  SYNTHETIC_TEST_ONLY_PASSWORD,
} from '../../src/database/seed-contract';
import {
  createEphemeralTestDbEnv,
  EphemeralDatabaseEnvironment,
} from '../database/harness';

interface HttpCallResult {
  readonly statusCode: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly rawBody: string;
  readonly json: Record<string, unknown>;
}

function httpJsonRequest(params: {
  readonly port: number;
  readonly method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  readonly path: string;
  readonly headers?: Record<string, string>;
  readonly body?: unknown;
}): Promise<HttpCallResult> {
  return new Promise((resolve, reject) => {
    const rawPayload =
      params.body === undefined
        ? undefined
        : typeof params.body === 'string'
          ? params.body
          : JSON.stringify(params.body);

    const headers: Record<string, string> = {
      ...(rawPayload !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(params.headers ?? {}),
    };
    if (rawPayload !== undefined) {
      headers['Content-Length'] = String(Buffer.byteLength(rawPayload, 'utf8'));
    }

    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: params.port,
        path: params.path,
        method: params.method,
        headers,
      },
      (res) => {
        res.setEncoding('utf8');
        let rawBody = '';
        res.on('data', (chunk: string) => {
          rawBody += chunk;
        });
        res.on('end', () => {
          let parsed: Record<string, unknown> = {};
          try {
            parsed = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
          } catch {
            parsed = { _raw: rawBody };
          }
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers,
            rawBody,
            json: parsed,
          });
        });
      },
    );
    req.on('error', reject);
    if (rawPayload !== undefined) {
      req.write(rawPayload);
    }
    req.end();
  });
}

function extractCookieMap(setCookieHeader: string | string[] | undefined): Record<string, string> {
  const list = Array.isArray(setCookieHeader)
    ? setCookieHeader
    : setCookieHeader
      ? [setCookieHeader]
      : [];
  const map: Record<string, string> = {};
  for (const item of list) {
    const firstPart = item.split(';')[0] ?? '';
    const idx = firstPart.indexOf('=');
    if (idx > 0) {
      map[firstPart.slice(0, idx).trim()] = decodeURIComponent(firstPart.slice(idx + 1).trim());
    }
  }
  return map;
}

describe('Stage 05 Staff Auth, G01 No-Replay Credential Check, G02 Atomic Counter & Shared Rate Limit, G05 Family Deadline & Browser CSRF (AUTH-IT-01..06, 14..16)', () => {
  let env: EphemeralDatabaseEnvironment;
  let app: Awaited<ReturnType<typeof createApiApplication>>;
  let port: number;
  let clock: ClockService;
  let authService: AuthService;
  const C = SYNTHETIC_DEMO_CENTER_A;
  const JWT_ACCESS_SECRET = 'TestOnly_JwtAccessSecret_AtLeast32CharsLong_01';

  before(async () => {
    env = await createEphemeralTestDbEnv();
    await executeSyntheticSeed(env.apiPoolA, C, {
      ...process.env,
      NODE_ENV: 'test',
      BOT_OUTBOUND_ENABLED: 'false',
    });

    const config = loadApiEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'error',
      API_HOST: '127.0.0.1',
      API_PORT: '3000',
      CENTER_ID: C.centerId,
      CENTER_SLUG: C.centerSlug,
      CENTER_TIMEZONE: 'Asia/Tashkent',
      LICENSE_MODE: 'ACTIVE',
      DATABASE_URL: env.apiRuntimeCenterAUrl,
      JWT_ACCESS_SECRET,
      JWT_REFRESH_SECRET: 'TestOnly_JwtRefreshSecret_AtLeast32CharsLong_02',
      INTERNAL_BOT_HMAC_SECRET: 'TestOnly_InternalBotHmacSecret_32CharsLong_03',
      TELEGRAM_WEBHOOK_SECRET: 'TestOnly_TelegramWebhookSecret_24',
      ALLOWED_ORIGINS: 'https://guliston-ilm.eduerp.uz,http://127.0.0.1:3000',
      AUTH_RATE_LIMIT_MAX_REQUESTS: '30',
      TRUST_PROXY: 'true',
    });

    app = await createApiApplication(config);
    clock = app.get(ClockService);
    authService = app.get(AuthService);
    await app.listen(0, '127.0.0.1');
    port = ((app.getHttpServer() as http.Server).address() as AddressInfo).port;
  });

  after(async () => {
    if (app) {
      await app.close();
    }
    if (env) {
      await env.cleanup();
    }
  });

  it('AUTH-IT-01 (G01): public /health and /ready remain open, valid login issues tokens without caching in client_operation_logs, and same Idempotency-Key with WRONG password fails 401 and increments failed_login_count', async () => {
    await authService.clearRateLimitBucketsForTest();

    const healthRes = await httpJsonRequest({ port, method: 'GET', path: '/api/v1/health' });
    assert.equal(healthRes.statusCode, 200);
    assert.equal(healthRes.json.status, 'OK');

    const readyRes = await httpJsonRequest({ port, method: 'GET', path: '/api/v1/ready' });
    assert.equal(readyRes.statusCode, 200);
    assert.equal(readyRes.json.status, 'READY');

    const unknownRoute = await httpJsonRequest({ port, method: 'GET', path: '/api/v1/nonexistent-endpoint' });
    assert.equal(unknownRoute.statusCode, 404);
    assert.equal(unknownRoute.json.error_code, 'NOT_FOUND');

    // G01 Reproduction Test:
    // 1. Valid login with Idempotency-Key: sharedKey -> 200 OK
    const sharedKey = crypto.randomUUID();
    const goodLogin = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/auth/login',
      headers: { 'Idempotency-Key': sharedKey },
      body: { username: 'director.demo', password: SYNTHETIC_TEST_ONLY_PASSWORD },
    });
    assert.equal(goodLogin.statusCode, 200);
    assert.equal(typeof goodLogin.json.access_token, 'string');
    assert.equal(typeof goodLogin.json.refresh_token, 'string');

    // 2. Same Idempotency-Key: sharedKey with WRONG password -> MUST fail 401 UNAUTHORIZED (never replay 200!)
    //    and MUST increment failed_login_count to 1!
    const wrongReplay = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/auth/login',
      headers: { 'Idempotency-Key': sharedKey },
      body: { username: 'director.demo', password: 'WRONG_PASSWORD_1234567!' },
    });
    assert.equal(wrongReplay.statusCode, 401);
    assert.equal(wrongReplay.json.error_code, 'UNAUTHORIZED');
    assert.equal('access_token' in wrongReplay.json, false);

    const countAfterWrongReplay = await env.apiPoolA.query<{ failed_login_count: number }>(
      `SELECT "failed_login_count" FROM "staff_users" WHERE "id" = $1::uuid`,
      [C.directorId],
    );
    assert.equal(Number(countAfterWrongReplay.rows[0]?.failed_login_count), 1);

    // 3. Verify zero LOGIN_STAFF rows or raw tokens exist in client_operation_logs (G01)
    const opLogScan = await env.apiPoolA.query<{ cnt: string; dump: string }>(
      `SELECT COUNT(*) FILTER (WHERE "operation_type" = 'LOGIN_STAFF')::text AS cnt,
              COALESCE(json_agg(row_to_json(c))::text, '') AS dump
         FROM "client_operation_logs" c`,
    );
    assert.equal(Number(opLogScan.rows[0]?.cnt), 0);
    assert.equal(opLogScan.rows[0]?.dump.includes(goodLogin.json.refresh_token as string), false);
    assert.equal(opLogScan.rows[0]?.dump.includes(goodLogin.json.access_token as string), false);

    // Reset director failed_login_count with a valid login
    const resetLogin = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/auth/login',
      body: { username: 'director.demo', password: SYNTHETIC_TEST_ONLY_PASSWORD },
    });
    assert.equal(resetLogin.statusCode, 200);
    const countAfterReset = await env.apiPoolA.query<{ failed_login_count: number }>(
      `SELECT "failed_login_count" FROM "staff_users" WHERE "id" = $1::uuid`,
      [C.directorId],
    );
    assert.equal(Number(countAfterReset.rows[0]?.failed_login_count), 0);
  });

  it('AUTH-IT-02 (G02): wrong password, unknown username, and disabled staff return uniform 401 (never 500 deadlock), commit failed_login_count atomically, and enforce 429 lockout & clock-controlled unlock', async () => {
    await authService.clearRateLimitBucketsForTest();

    const disabledId = crypto.randomUUID();
    const lockTargetId = crypto.randomUUID();
    const validHash = await hashPassword(SYNTHETIC_TEST_ONLY_PASSWORD, { N: 16384 });
    await env.apiPoolA.query(
      `INSERT INTO "staff_users" ("id", "center_id", "role", "full_name", "login_username", "password_hash", "must_change_password", "status")
       VALUES
         ($1::uuid, $3::uuid, 'TEACHER', 'Disabled Teacher', 'disabled.teacher', $4, FALSE, 'DEACTIVATED'),
         ($2::uuid, $3::uuid, 'TEACHER', 'Lockout Target', 'lockout.target', $4, FALSE, 'ACTIVE')`,
      [disabledId, lockTargetId, C.centerId, validHash],
    );

    const wrongPassRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/auth/login',
      body: { username: 'director.demo', password: 'WrongPassword_12345!' },
    });
    const unknownUserRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/auth/login',
      body: { username: 'no.such.user', password: SYNTHETIC_TEST_ONLY_PASSWORD },
    });
    const disabledUserRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/auth/login',
      body: { username: 'disabled.teacher', password: SYNTHETIC_TEST_ONLY_PASSWORD },
    });

    assert.equal(wrongPassRes.statusCode, 401);
    assert.equal(unknownUserRes.statusCode, 401);
    assert.equal(disabledUserRes.statusCode, 401);
    assert.equal(wrongPassRes.json.error_code, 'UNAUTHORIZED');
    assert.equal(wrongPassRes.json.message, unknownUserRes.json.message);
    assert.equal(wrongPassRes.json.message, disabledUserRes.json.message);

    // Reset director failed_login_count
    await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/auth/login',
      body: { username: 'director.demo', password: SYNTHETIC_TEST_ONLY_PASSWORD },
    });

    // 5 failed login attempts on lockout.target commit failed_login_count 1..5 and set locked_until
    for (let i = 1; i <= 5; i += 1) {
      const failRes = await httpJsonRequest({
        port,
        method: 'POST',
        path: '/api/v1/auth/login',
        body: { username: 'lockout.target', password: `WrongAttempt_${i}_9999!` },
      });
      assert.equal(failRes.statusCode, 401);

      const checkRow = await env.apiPoolA.query<{ failed_login_count: number }>(
        `SELECT "failed_login_count" FROM "staff_users" WHERE "id" = $1::uuid`,
        [lockTargetId],
      );
      assert.equal(Number(checkRow.rows[0]?.failed_login_count), i);
    }

    const lockedAttempt = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/auth/login',
      body: { username: 'lockout.target', password: SYNTHETIC_TEST_ONLY_PASSWORD },
    });
    assert.equal(lockedAttempt.statusCode, 429);
    assert.equal(lockedAttempt.json.error_code, 'RATE_LIMITED');
    assert.equal(typeof lockedAttempt.json.retry_after_seconds, 'number');

    clock.advanceMs(16 * 60 * 1000);
    try {
      const unlockedRes = await httpJsonRequest({
        port,
        method: 'POST',
        path: '/api/v1/auth/login',
        body: { username: 'lockout.target', password: SYNTHETIC_TEST_ONLY_PASSWORD },
      });
      assert.equal(unlockedRes.statusCode, 200);
      assert.equal(unlockedRes.json.staff_id, lockTargetId);
    } finally {
      clock.setTestNow(null);
    }
  });

  it('AUTH-IT-16 (G02): shared PostgreSQL IP rate limiter blocks unique-username flood across two separate API instances without storing raw IP or password', async () => {
    await authService.clearRateLimitBucketsForTest();

    // Spin up a second independent NestJS API instance with AUTH_RATE_LIMIT_MAX_REQUESTS = 4
    const config2 = loadApiEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'error',
      API_HOST: '127.0.0.1',
      API_PORT: '3000',
      CENTER_ID: C.centerId,
      CENTER_SLUG: C.centerSlug,
      CENTER_TIMEZONE: 'Asia/Tashkent',
      LICENSE_MODE: 'ACTIVE',
      DATABASE_URL: env.apiRuntimeCenterAUrl,
      JWT_ACCESS_SECRET,
      JWT_REFRESH_SECRET: 'TestOnly_JwtRefreshSecret_AtLeast32CharsLong_02',
      INTERNAL_BOT_HMAC_SECRET: 'TestOnly_InternalBotHmacSecret_32CharsLong_03',
      TELEGRAM_WEBHOOK_SECRET: 'TestOnly_TelegramWebhookSecret_24',
      AUTH_RATE_LIMIT_MAX_REQUESTS: '4',
      TRUST_PROXY: 'true',
    });
    const app2 = await createApiApplication(config2);
    await app2.listen(0, '127.0.0.1');
    const port2 = ((app2.getHttpServer() as http.Server).address() as AddressInfo).port;

    try {
      const floodIp = '203.0.113.77';
      // Send 2 attempts via instance 1 (port) and 2 attempts via instance 2 (port2) using 4 DIFFERENT usernames
      for (let i = 1; i <= 4; i += 1) {
        const targetPort = i % 2 === 1 ? port : port2;
        const r = await httpJsonRequest({
          port: targetPort,
          method: 'POST',
          path: '/api/v1/auth/login',
          headers: { 'X-Forwarded-For': floodIp },
          body: { username: `unique.flood.user.${i}`, password: 'WrongPassword_12345!' },
        });
        assert.equal(r.statusCode, 401);
      }

      // 5th attempt on instance 2 with a 5th distinct username from the same IP is blocked with 429 RATE_LIMITED!
      const fifth = await httpJsonRequest({
        port: port2,
        method: 'POST',
        path: '/api/v1/auth/login',
        headers: { 'X-Forwarded-For': floodIp },
        body: { username: 'unique.flood.user.5', password: 'WrongPassword_12345!' },
      });
      assert.equal(fifth.statusCode, 429);
      assert.equal(fifth.json.error_code, 'RATE_LIMITED');

      // Verify auth_rate_limit_buckets stores only keyed HMAC digest (never raw IP or username)
      const bucketDump = await env.apiPoolA.query<{ dump: string }>(
        `SELECT COALESCE(json_agg(row_to_json(b))::text, '') AS dump FROM "auth_rate_limit_buckets" b`,
      );
      assert.equal(bucketDump.rows[0]?.dump.includes(floodIp), false);
      assert.equal(bucketDump.rows[0]?.dump.includes('unique.flood.user'), false);
    } finally {
      await app2.close();
      await authService.clearRateLimitBucketsForTest();
    }
  });

  it('AUTH-IT-03: rejects expired, wrong-signature, wrong-alg, wrong-issuer, wrong-audience, wrong-center, and non-access JWT tokens with 401', async () => {
    const secretBytes = new TextEncoder().encode(JWT_ACCESS_SECRET);
    const wrongSecretBytes = new TextEncoder().encode('WrongSecret_AtLeast32CharactersLong_99999');
    const nowSec = Math.floor(Date.now() / 1000);

    const baseClaims = {
      sid: crypto.randomUUID(),
      cid: C.centerId,
      cslug: C.centerSlug,
      role: 'DIRECTOR',
      sv: 1,
      mcp: false,
      token_use: 'staff_access',
    };

    const expiredJwt = await new SignJWT(baseClaims)
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(C.directorId)
      .setIssuer(`eduerp:center:${C.centerSlug}`)
      .setAudience(`eduerp:center-api:${C.centerId}`)
      .setJti(crypto.randomUUID())
      .setIssuedAt(nowSec - 3600)
      .setExpirationTime(nowSec - 60)
      .sign(secretBytes);

    const wrongSigJwt = await new SignJWT(baseClaims)
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(C.directorId)
      .setIssuer(`eduerp:center:${C.centerSlug}`)
      .setAudience(`eduerp:center-api:${C.centerId}`)
      .setJti(crypto.randomUUID())
      .setIssuedAt(nowSec)
      .setExpirationTime(nowSec + 900)
      .sign(wrongSecretBytes);

    const wrongAlgJwt = await new SignJWT(baseClaims)
      .setProtectedHeader({ alg: 'HS384' })
      .setSubject(C.directorId)
      .setIssuer(`eduerp:center:${C.centerSlug}`)
      .setAudience(`eduerp:center-api:${C.centerId}`)
      .setJti(crypto.randomUUID())
      .setIssuedAt(nowSec)
      .setExpirationTime(nowSec + 900)
      .sign(secretBytes);

    const wrongAudVendorJwt = await new SignJWT(baseClaims)
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(C.directorId)
      .setIssuer(`eduerp:center:${C.centerSlug}`)
      .setAudience('eduerp:vendor-api')
      .setJti(crypto.randomUUID())
      .setIssuedAt(nowSec)
      .setExpirationTime(nowSec + 900)
      .sign(secretBytes);

    const wrongCenterJwt = await new SignJWT({
      ...baseClaims,
      cid: '22222222-3333-4444-8555-666666666666',
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(C.directorId)
      .setIssuer(`eduerp:center:${C.centerSlug}`)
      .setAudience(`eduerp:center-api:${C.centerId}`)
      .setJti(crypto.randomUUID())
      .setIssuedAt(nowSec)
      .setExpirationTime(nowSec + 900)
      .sign(secretBytes);

    const wrongTokenUseJwt = await new SignJWT({
      ...baseClaims,
      token_use: 'refresh_token',
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(C.directorId)
      .setIssuer(`eduerp:center:${C.centerSlug}`)
      .setAudience(`eduerp:center-api:${C.centerId}`)
      .setJti(crypto.randomUUID())
      .setIssuedAt(nowSec)
      .setExpirationTime(nowSec + 900)
      .sign(secretBytes);

    for (const badToken of [
      expiredJwt,
      wrongSigJwt,
      wrongAlgJwt,
      wrongAudVendorJwt,
      wrongCenterJwt,
      wrongTokenUseJwt,
    ]) {
      const res = await httpJsonRequest({
        port,
        method: 'GET',
        path: '/api/v1/staff',
        headers: { Authorization: `Bearer ${badToken}` },
      });
      assert.equal(res.statusCode, 401);
      assert.equal(res.json.error_code, 'UNAUTHORIZED');
    }
  });

  it('AUTH-IT-04 (G02/G05): enforces first-login must_change_password gate, keyed password change idempotency, session revocation, and 401 on old password login', async () => {
    await authService.clearRateLimitBucketsForTest();

    const firstLoginStaffId = crypto.randomUUID();
    const initialPass = 'InitialTempPass_2026!';
    const newPass = 'UpdatedStrongPass_2026!';
    const initHash = await hashPassword(initialPass, { N: 16384 });

    await env.apiPoolA.query(
      `INSERT INTO "staff_users" ("id", "center_id", "role", "full_name", "login_username", "password_hash", "must_change_password", "status", "version")
       VALUES ($1::uuid, $2::uuid, 'DIRECTOR', 'First Login Director', 'first.login.dir', $3, TRUE, 'ACTIVE', 1)`,
      [firstLoginStaffId, C.centerId, initHash],
    );

    const loginRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/auth/login',
      body: { username: 'first.login.dir', password: initialPass },
    });
    assert.equal(loginRes.statusCode, 200);
    assert.equal(loginRes.json.must_change_password, true);
    const oldAccessToken = loginRes.json.access_token as string;

    const blockedList = await httpJsonRequest({
      port,
      method: 'GET',
      path: '/api/v1/staff',
      headers: { Authorization: `Bearer ${oldAccessToken}` },
    });
    assert.equal(blockedList.statusCode, 403);
    assert.equal(blockedList.json.error_code, 'FORBIDDEN_ROLE');

    const stalePwChange = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/auth/password',
      headers: {
        Authorization: `Bearer ${oldAccessToken}`,
        'Idempotency-Key': `idem-fl-stale-${crypto.randomUUID()}`,
      },
      body: {
        current_password: initialPass,
        new_password: newPass,
        expected_version: 99,
      },
    });
    assert.equal(stalePwChange.statusCode, 409);
    assert.equal(stalePwChange.json.error_code, 'VERSION_CONFLICT');

    const pwChangeKey = `idem-fl-ok-${crypto.randomUUID()}`;
    const okPwChange = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/auth/password',
      headers: {
        Authorization: `Bearer ${oldAccessToken}`,
        'Idempotency-Key': pwChangeKey,
        'If-Match-Version': '1',
      },
      body: {
        current_password: initialPass,
        new_password: newPass,
        expected_version: 1,
      },
    });
    assert.equal(okPwChange.statusCode, 200);
    assert.equal(okPwChange.json.version, 2);

    const afterChangeOldToken = await httpJsonRequest({
      port,
      method: 'GET',
      path: '/api/v1/staff',
      headers: { Authorization: `Bearer ${oldAccessToken}` },
    });
    assert.equal(afterChangeOldToken.statusCode, 401);

    const oldPassLogin = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/auth/login',
      body: { username: 'first.login.dir', password: initialPass },
    });
    assert.equal(oldPassLogin.statusCode, 401);

    const newPassLogin = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/auth/login',
      body: { username: 'first.login.dir', password: newPass },
    });
    assert.equal(newPassLogin.statusCode, 200);
    assert.equal(newPassLogin.json.must_change_password, false);

    // G05: Reusing pwChangeKey with a different new_password intent returns 409 IDEMPOTENCY_PAYLOAD_MISMATCH
    const mismatchPwChange = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/auth/password',
      headers: {
        Authorization: `Bearer ${newPassLogin.json.access_token as string}`,
        'Idempotency-Key': pwChangeKey,
      },
      body: {
        current_password: newPass,
        new_password: 'AnotherDifferentPassword_2026!',
        expected_version: 2,
      },
    });
    assert.equal(mismatchPwChange.statusCode, 409);
    assert.equal(mismatchPwChange.json.error_code, 'IDEMPOTENCY_PAYLOAD_MISMATCH');

    await env.apiPoolA.query(
      `UPDATE "staff_users" SET "status" = 'DEACTIVATED', "version" = "version" + 1 WHERE "id" = $1::uuid`,
      [firstLoginStaffId],
    );
  });

  it('AUTH-IT-05 (G05): enforces refresh token rotation, parallel refresh one-winner + family replay revocation, and absolute family_expires_at deadline', async () => {
    await authService.clearRateLimitBucketsForTest();

    const loginRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/auth/login',
      body: { username: 'director.demo', password: SYNTHETIC_TEST_ONLY_PASSWORD },
    });
    assert.equal(loginRes.statusCode, 200);
    const refresh1 = loginRes.json.refresh_token as string;

    // Advance clock by 2 days and rotate -> verify child session family_expires_at is NOT extended beyond original 7-day family deadline (G05)
    clock.advanceMs(2 * 86400 * 1000);
    let refresh2: string;
    try {
      const rot1 = await httpJsonRequest({
        port,
        method: 'POST',
        path: '/api/v1/auth/refresh',
        body: { refresh_token: refresh1 },
      });
      assert.equal(rot1.statusCode, 200);
      refresh2 = rot1.json.refresh_token as string;
      assert.notEqual(refresh2, refresh1);

      const familyRows = await env.apiPoolA.query<{
        expires_at: Date;
        family_expires_at: Date;
      }>(
        `SELECT "expires_at", "family_expires_at"
           FROM "staff_sessions"
          WHERE "staff_id" = $1::uuid
          ORDER BY "created_at" DESC
          LIMIT 2`,
        [C.directorId],
      );
      assert.equal(familyRows.rows.length, 2);
      assert.equal(
        new Date(familyRows.rows[0].family_expires_at).getTime(),
        new Date(familyRows.rows[1].family_expires_at).getTime(),
        'Rotated child session must preserve original family_expires_at deadline (G05)',
      );
      assert.equal(
        new Date(familyRows.rows[0].expires_at).getTime(),
        new Date(familyRows.rows[0].family_expires_at).getTime(),
        'Rotated child session expires_at must be clamped to family_expires_at (G05)',
      );

      // Advance clock past the original 7-day family deadline (e.g. +6 more days = 8 days total) -> refresh fails 401!
      clock.advanceMs(6 * 86400 * 1000);
      const expiredFamilyRefresh = await httpJsonRequest({
        port,
        method: 'POST',
        path: '/api/v1/auth/refresh',
        body: { refresh_token: refresh2 },
      });
      assert.equal(expiredFamilyRefresh.statusCode, 401);
    } finally {
      clock.setTestNow(null);
    }

    // Parallel refresh replay test on a fresh session family
    const freshLogin = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/auth/login',
      body: { username: 'director.demo', password: SYNTHETIC_TEST_ONLY_PASSWORD },
    });
    const freshRefresh = freshLogin.json.refresh_token as string;

    const [parA, parB] = await Promise.all([
      httpJsonRequest({
        port,
        method: 'POST',
        path: '/api/v1/auth/refresh',
        body: { refresh_token: freshRefresh },
      }),
      httpJsonRequest({
        port,
        method: 'POST',
        path: '/api/v1/auth/refresh',
        body: { refresh_token: freshRefresh },
      }),
    ]);

    const statuses = [parA.statusCode, parB.statusCode].sort();
    assert.deepEqual(statuses, [200, 401]);
    const winner = parA.statusCode === 200 ? parA : parB;
    const winnerAccessToken = winner.json.access_token as string;
    const winnerRefreshToken = winner.json.refresh_token as string;

    const winnerAccessCheck = await httpJsonRequest({
      port,
      method: 'GET',
      path: '/api/v1/staff',
      headers: { Authorization: `Bearer ${winnerAccessToken}` },
    });
    assert.equal(winnerAccessCheck.statusCode, 401);

    const winnerRefreshCheck = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/auth/refresh',
      body: { refresh_token: winnerRefreshToken },
    });
    assert.equal(winnerRefreshCheck.statusCode, 401);
  });

  it('AUTH-IT-06: logout revokes caller session immediately and invalidates both access and refresh tokens', async () => {
    await authService.clearRateLimitBucketsForTest();

    const freshLogin = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/auth/login',
      body: { username: 'director.demo', password: SYNTHETIC_TEST_ONLY_PASSWORD },
    });
    assert.equal(freshLogin.statusCode, 200);
    const activeAccess = freshLogin.json.access_token as string;
    const activeRefresh = freshLogin.json.refresh_token as string;

    const logoutRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/auth/logout',
      headers: { Authorization: `Bearer ${activeAccess}` },
    });
    assert.equal(logoutRes.statusCode, 200);
    assert.equal(logoutRes.json.revoked, true);

    const postLogoutAccess = await httpJsonRequest({
      port,
      method: 'GET',
      path: '/api/v1/staff',
      headers: { Authorization: `Bearer ${activeAccess}` },
    });
    assert.equal(postLogoutAccess.statusCode, 401);

    const postLogoutRefresh = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/auth/refresh',
      body: { refresh_token: activeRefresh },
    });
    assert.equal(postLogoutRefresh.statusCode, 401);
  });

  it('AUTH-IT-14: enforces Browser Cookie HttpOnly/SameSite=Strict flags, session-bound X-CSRF-Token + trusted Origin, and blocks bearer transport confusion', async () => {
    await authService.clearRateLimitBucketsForTest();

    const cookieLogin = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/auth/login',
      headers: {
        'X-Auth-Transport': 'cookie',
        Origin: 'https://guliston-ilm.eduerp.uz',
      },
      body: { username: 'director.demo', password: SYNTHETIC_TEST_ONLY_PASSWORD },
    });
    assert.equal(cookieLogin.statusCode, 200);
    assert.equal(cookieLogin.json.refresh_token, REDACTED_COOKIE_REFRESH_PLACEHOLDER);

    const rawSetCookies = cookieLogin.headers['set-cookie'] ?? [];
    const joinedSetCookies = Array.isArray(rawSetCookies) ? rawSetCookies.join(' | ') : rawSetCookies;
    assert.ok(joinedSetCookies.includes(`${REFRESH_COOKIE_NAME}=`));
    assert.ok(joinedSetCookies.includes('HttpOnly'));
    assert.ok(joinedSetCookies.includes('SameSite=Strict'));
    assert.ok(joinedSetCookies.includes(`${CSRF_COOKIE_NAME}=`));

    const cookieMap = extractCookieMap(rawSetCookies);
    const refreshCookieVal = cookieMap[REFRESH_COOKIE_NAME];
    const csrfCookieVal = cookieMap[CSRF_COOKIE_NAME];
    assert.ok(refreshCookieVal && refreshCookieVal.length >= 32);
    assert.ok(csrfCookieVal && csrfCookieVal.length >= 32);

    const cookieHeader = `${REFRESH_COOKIE_NAME}=${encodeURIComponent(refreshCookieVal)}; ${CSRF_COOKIE_NAME}=${encodeURIComponent(csrfCookieVal)}`;

    const missingCsrfRefresh = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/auth/refresh',
      headers: {
        'X-Auth-Transport': 'cookie',
        Origin: 'https://guliston-ilm.eduerp.uz',
        Cookie: cookieHeader,
      },
      body: {},
    });
    assert.equal(missingCsrfRefresh.statusCode, 403);

    const evilOriginRefresh = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/auth/refresh',
      headers: {
        'X-Auth-Transport': 'cookie',
        Origin: 'https://evil-attacker.example.com',
        'X-CSRF-Token': csrfCookieVal,
        Cookie: cookieHeader,
      },
      body: {},
    });
    assert.equal(evilOriginRefresh.statusCode, 403);

    const bearerBypassAttempt = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/auth/refresh',
      headers: { 'X-Auth-Transport': 'bearer' },
      body: { refresh_token: refreshCookieVal },
    });
    assert.equal(bearerBypassAttempt.statusCode, 401);

    const validCookieRefresh = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/auth/refresh',
      headers: {
        'X-Auth-Transport': 'cookie',
        Origin: 'https://guliston-ilm.eduerp.uz',
        'X-CSRF-Token': csrfCookieVal,
        Cookie: cookieHeader,
      },
      body: {},
    });
    assert.equal(validCookieRefresh.statusCode, 200);
    assert.equal(validCookieRefresh.json.refresh_token, REDACTED_COOKIE_REFRESH_PLACEHOLDER);
  });

  it('AUTH-IT-15: rejects unexpected mass-assignment body fields, malformed JSON, and invalid Idempotency-Key formats with 400 VALIDATION_ERROR', async () => {
    const extraFieldRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/auth/login',
      body: {
        username: 'director.demo',
        password: SYNTHETIC_TEST_ONLY_PASSWORD,
        role: 'DIRECTOR',
      },
    });
    assert.equal(extraFieldRes.statusCode, 400);
    assert.equal(extraFieldRes.json.error_code, 'VALIDATION_ERROR');

    const badIdemHeaderRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/auth/login',
      headers: { 'Idempotency-Key': 'short' },
      body: {
        username: 'director.demo',
        password: SYNTHETIC_TEST_ONLY_PASSWORD,
      },
    });
    assert.equal(badIdemHeaderRes.statusCode, 400);
    assert.equal(badIdemHeaderRes.json.error_code, 'VALIDATION_ERROR');
  });
});
