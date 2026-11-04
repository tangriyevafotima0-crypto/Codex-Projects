import * as assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { SignJWT } from 'jose';
import { createApiApplication } from '../../src/application';
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

describe('Stage 05 Staff Auth, Brute-Force Lockout, Session Rotation/Replay, First-Login Password & Browser CSRF (AUTH-IT-01..06, 14..16)', () => {
  let env: EphemeralDatabaseEnvironment;
  let app: Awaited<ReturnType<typeof createApiApplication>>;
  let port: number;
  let clock: ClockService;
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
    });

    app = await createApiApplication(config);
    clock = app.get(ClockService);
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

  it('AUTH-IT-01, AUTH-IT-02 & AUTH-IT-16: public /health and /ready remain open, unimplemented routes return 404 ErrorEnvelope, and valid/invalid/unknown/disabled login returns uniform 401 before atomic brute-force 429 lockout', async () => {
    const healthRes = await httpJsonRequest({ port, method: 'GET', path: '/api/v1/health' });
    assert.equal(healthRes.statusCode, 200);
    assert.equal(healthRes.json.status, 'OK');

    const readyRes = await httpJsonRequest({ port, method: 'GET', path: '/api/v1/ready' });
    assert.equal(readyRes.statusCode, 200);
    assert.equal(readyRes.json.status, 'READY');

    const unknownRoute = await httpJsonRequest({ port, method: 'GET', path: '/api/v1/nonexistent-endpoint' });
    assert.equal(unknownRoute.statusCode, 404);
    assert.equal(unknownRoute.json.error_code, 'NOT_FOUND');

    // Create a deactivated user and a lockout-target user
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

    // Invalid password, unknown username, and disabled staff all return uniform 401 UNAUTHORIZED message
    const wrongPassRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/auth/login',
      headers: { 'Idempotency-Key': `idem-wrong-${crypto.randomUUID()}` },
      body: { username: 'director.demo', password: 'WrongPassword_12345!' },
    });
    const unknownUserRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/auth/login',
      headers: { 'Idempotency-Key': `idem-unk-${crypto.randomUUID()}` },
      body: { username: 'no.such.user', password: SYNTHETIC_TEST_ONLY_PASSWORD },
    });
    const disabledUserRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/auth/login',
      headers: { 'Idempotency-Key': `idem-dis-${crypto.randomUUID()}` },
      body: { username: 'disabled.teacher', password: SYNTHETIC_TEST_ONLY_PASSWORD },
    });

    assert.equal(wrongPassRes.statusCode, 401);
    assert.equal(unknownUserRes.statusCode, 401);
    assert.equal(disabledUserRes.statusCode, 401);
    assert.equal(wrongPassRes.json.error_code, 'UNAUTHORIZED');
    assert.equal(wrongPassRes.json.message, unknownUserRes.json.message);
    assert.equal(wrongPassRes.json.message, disabledUserRes.json.message);

    // 5 failed login attempts trigger atomic account lockout (locked_until) -> 6th attempt with valid password returns 429 RATE_LIMITED
    for (let i = 1; i <= 5; i += 1) {
      const failRes = await httpJsonRequest({
        port,
        method: 'POST',
        path: '/api/v1/auth/login',
        headers: { 'Idempotency-Key': `idem-lock-${i}-${crypto.randomUUID()}` },
        body: { username: 'lockout.target', password: `WrongAttempt_${i}_9999!` },
      });
      assert.equal(failRes.statusCode, 401);
    }

    const lockedAttempt = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/auth/login',
      headers: { 'Idempotency-Key': `idem-locked-${crypto.randomUUID()}` },
      body: { username: 'lockout.target', password: SYNTHETIC_TEST_ONLY_PASSWORD },
    });
    assert.equal(lockedAttempt.statusCode, 429);
    assert.equal(lockedAttempt.json.error_code, 'RATE_LIMITED');
    assert.equal(typeof lockedAttempt.json.retry_after_seconds, 'number');

    // Advance controllable clock past 15-minute lockout window without sleeping -> valid login succeeds!
    clock.advanceMs(16 * 60 * 1000);
    try {
      const unlockedRes = await httpJsonRequest({
        port,
        method: 'POST',
        path: '/api/v1/auth/login',
        headers: { 'Idempotency-Key': `idem-unlocked-${crypto.randomUUID()}` },
        body: { username: 'lockout.target', password: SYNTHETIC_TEST_ONLY_PASSWORD },
      });
      assert.equal(unlockedRes.statusCode, 200);
      assert.equal(unlockedRes.json.staff_id, lockTargetId);
    } finally {
      clock.setTestNow(null);
    }
  });

  it('AUTH-IT-03: rejects expired, wrong-signature, wrong-alg, wrong-issuer, wrong-audience, wrong-center, and non-access JWT tokens with 401', async () => {
    const validLogin = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/auth/login',
      headers: { 'Idempotency-Key': `idem-jwt-test-${crypto.randomUUID()}` },
      body: { username: 'director.demo', password: SYNTHETIC_TEST_ONLY_PASSWORD },
    });
    assert.equal(validLogin.statusCode, 200);

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

  it('AUTH-IT-04: enforces first-login must_change_password gate, expected_version check, password change, and automatic revocation of prior sessions', async () => {
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
      headers: { 'Idempotency-Key': `idem-fl-login-${crypto.randomUUID()}` },
      body: { username: 'first.login.dir', password: initialPass },
    });
    assert.equal(loginRes.statusCode, 200);
    assert.equal(loginRes.json.must_change_password, true);
    const oldAccessToken = loginRes.json.access_token as string;

    // Attempting protected endpoint (GET /api/v1/staff) while must_change_password=true is blocked with 403
    const blockedList = await httpJsonRequest({
      port,
      method: 'GET',
      path: '/api/v1/staff',
      headers: { Authorization: `Bearer ${oldAccessToken}` },
    });
    assert.equal(blockedList.statusCode, 403);
    assert.equal(blockedList.json.error_code, 'FORBIDDEN_ROLE');

    // Stale expected_version (e.g. 99) fails with 409 VERSION_CONFLICT
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

    // Valid password change succeeds, increments version 1 -> 2, sets must_change_password = false, and revokes old session
    const okPwChange = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/auth/password',
      headers: {
        Authorization: `Bearer ${oldAccessToken}`,
        'Idempotency-Key': `idem-fl-ok-${crypto.randomUUID()}`,
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

    // Old access token is immediately rejected (401) because session was revoked and staff version incremented
    const afterChangeOldToken = await httpJsonRequest({
      port,
      method: 'GET',
      path: '/api/v1/staff',
      headers: { Authorization: `Bearer ${oldAccessToken}` },
    });
    assert.equal(afterChangeOldToken.statusCode, 401);

    // Old password login is rejected (401), new password login succeeds with must_change_password = false
    const oldPassLogin = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/auth/login',
      headers: { 'Idempotency-Key': `idem-fl-oldpw-${crypto.randomUUID()}` },
      body: { username: 'first.login.dir', password: initialPass },
    });
    assert.equal(oldPassLogin.statusCode, 401);

    const newPassLogin = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/auth/login',
      headers: { 'Idempotency-Key': `idem-fl-newpw-${crypto.randomUUID()}` },
      body: { username: 'first.login.dir', password: newPass },
    });
    assert.equal(newPassLogin.statusCode, 200);
    assert.equal(newPassLogin.json.must_change_password, false);

    // Clean up extra director so C.directorId remains sole active director for other tests
    await env.apiPoolA.query(
      `UPDATE "staff_users" SET "status" = 'DEACTIVATED', "version" = "version" + 1 WHERE "id" = $1::uuid`,
      [firstLoginStaffId],
    );
  });

  it('AUTH-IT-05 & AUTH-IT-06: refresh token rotation, parallel refresh one-winner + family replay revocation, and idempotent logout', async () => {
    const loginRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/auth/login',
      headers: { 'Idempotency-Key': `idem-rot-login-${crypto.randomUUID()}` },
      body: { username: 'director.demo', password: SYNTHETIC_TEST_ONLY_PASSWORD },
    });
    assert.equal(loginRes.statusCode, 200);
    const refresh1 = loginRes.json.refresh_token as string;

    // Sequential rotation 1 -> 2 succeeds
    const rot1 = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/auth/refresh',
      body: { refresh_token: refresh1 },
    });
    assert.equal(rot1.statusCode, 200);
    const refresh2 = rot1.json.refresh_token as string;
    assert.notEqual(refresh2, refresh1);

    // Parallel refresh using the SAME refresh2 token:
    // Winner rotates refresh2 -> refresh3 (200); Loser sees refresh2 already rotated -> triggers family replay revocation (401)!
    const [parA, parB] = await Promise.all([
      httpJsonRequest({
        port,
        method: 'POST',
        path: '/api/v1/auth/refresh',
        body: { refresh_token: refresh2 },
      }),
      httpJsonRequest({
        port,
        method: 'POST',
        path: '/api/v1/auth/refresh',
        body: { refresh_token: refresh2 },
      }),
    ]);

    const statuses = [parA.statusCode, parB.statusCode].sort();
    assert.deepEqual(statuses, [200, 401]);
    const winner = parA.statusCode === 200 ? parA : parB;
    const winnerAccessToken = winner.json.access_token as string;
    const winnerRefreshToken = winner.json.refresh_token as string;

    // Because the loser replayed refresh2, the ENTIRE session family (including winner's newly issued child session!) is now revoked!
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

    // Fresh login + logout invalidates access token immediately
    const freshLogin = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/auth/login',
      headers: { 'Idempotency-Key': `idem-logout-login-${crypto.randomUUID()}` },
      body: { username: 'director.demo', password: SYNTHETIC_TEST_ONLY_PASSWORD },
    });
    const activeAccess = freshLogin.json.access_token as string;

    const logoutRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/auth/logout',
      headers: { Authorization: `Bearer ${activeAccess}` },
    });
    assert.equal(logoutRes.statusCode, 200);
    assert.equal(logoutRes.json.revoked, true);

    const postLogoutCheck = await httpJsonRequest({
      port,
      method: 'GET',
      path: '/api/v1/staff',
      headers: { Authorization: `Bearer ${activeAccess}` },
    });
    assert.equal(postLogoutCheck.statusCode, 401);
  });

  it('AUTH-IT-14 & AUTH-IT-15: enforces Browser Cookie HttpOnly/SameSite flags, session-bound CSRF + Origin checks, and rejects bearer bypass or extra body fields', async () => {
    // 1. Browser Cookie login with trusted Origin
    const cookieLogin = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/auth/login',
      headers: {
        'Idempotency-Key': `idem-cookie-login-${crypto.randomUUID()}`,
        'X-Auth-Transport': 'cookie',
        Origin: 'https://guliston-ilm.eduerp.uz',
      },
      body: { username: 'director.demo', password: SYNTHETIC_TEST_ONLY_PASSWORD },
    });
    assert.equal(cookieLogin.statusCode, 200);
    // Browser JSON body must NOT contain the raw HttpOnly refresh token
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

    // 2. Refresh in cookie mode WITHOUT X-CSRF-Token is rejected with 403
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

    // 3. Refresh in cookie mode with UNTRUSTED Origin is rejected with 403
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

    // 4. Attempting to refresh a COOKIE session via mobile BEARER mode (to bypass CSRF/Origin) is rejected with 401
    const bearerBypassAttempt = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/auth/refresh',
      headers: { 'X-Auth-Transport': 'bearer' },
      body: { refresh_token: refreshCookieVal },
    });
    assert.equal(bearerBypassAttempt.statusCode, 401);

    // 5. Refresh in cookie mode WITH valid trusted Origin + matching X-CSRF-Token succeeds (200)
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

    // 6. Extra unexpected fields in login body fail with 400 VALIDATION_ERROR
    const extraFieldRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/auth/login',
      headers: { 'Idempotency-Key': `idem-extra-${crypto.randomUUID()}` },
      body: {
        username: 'director.demo',
        password: SYNTHETIC_TEST_ONLY_PASSWORD,
        role: 'DIRECTOR',
      },
    });
    assert.equal(extraFieldRes.statusCode, 400);
    assert.equal(extraFieldRes.json.error_code, 'VALIDATION_ERROR');
  });
});
