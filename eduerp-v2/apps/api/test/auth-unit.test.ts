import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ClockService } from '../src/auth/clock.service';
import {
  DEFAULT_SCRYPT_N,
  hashPassword,
  isValidScryptParams,
  verifyPassword,
  verifyPasswordConstantTime,
} from '../src/auth/password';
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

describe('Stage 05 Auth, Scrypt Password, CSRF/Origin Transport & RBAC Validation Unit Tests (05.01..05.04)', () => {
  it('hashes passwords with async crypto.scrypt, generates unique salts, and rejects wrong or hostile parameter hashes (AUTH-UNIT-01)', async () => {
    const pw = 'StrongUnitPass_2026!';
    const hash1 = await hashPassword(pw, { N: 16384 });
    const hash2 = await hashPassword(pw, { N: 16384 });

    assert.notEqual(hash1, hash2, 'Random salt must produce distinct hashes for identical password');
    assert.match(hash1, /^\$scrypt\$v=1\$n=16384,r=8,p=1\$/);
    assert.equal(DEFAULT_SCRYPT_N, 131072);

    assert.equal(await verifyPassword(pw, hash1), true);
    assert.equal(await verifyPassword(pw, hash2), true);
    assert.equal(await verifyPassword('WrongPassword_2026!', hash1), false);
    assert.equal(await verifyPasswordConstantTime(pw, null), false);

    // Rejects hostile scrypt parameters (non-power-of-two N, excessive N=1073741824, r=99, non-scrypt $argon2id$) safely without crashing
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
    assert.equal(
      await verifyPassword(pw, '$argon2id$v=19$m=65536,t=3,p=4$FAKE_HASH'),
      false,
    );
  });

  it('verifies opaque refresh token hashing, timing-safe CSRF token verification, and controllable ClockService (AUTH-UNIT-02)', () => {
    const refresh = generateOpaqueRefreshToken();
    assert.ok(refresh.length >= 60);
    assert.equal(hashOpaqueToken(refresh).length, 64);

    const csrf = generateCsrfToken();
    const csrfHash = hashOpaqueToken(csrf);
    assert.equal(verifyCsrfTokenHash(csrf, csrfHash), true);
    assert.equal(verifyCsrfTokenHash('wrong-csrf-token', csrfHash), false);
    assert.equal(verifyCsrfTokenHash(undefined, csrfHash), false);

    const clock = new ClockService();
    const fixed = new Date('2026-11-04T10:00:00.000Z');
    clock.setTestNow(fixed);
    assert.equal(clock.now().toISOString(), '2026-11-04T10:00:00.000Z');
    clock.advanceMs(60_000);
    assert.equal(clock.now().toISOString(), '2026-11-04T10:01:00.000Z');
  });

  it('validates cookie vs bearer transport headers, trusted Origin allowlist, and strict request DTO schemas (AUTH-UNIT-03)', () => {
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

    // Migration database URL is never exposed on ApiEnvConfig (F06)
    assert.equal('migrationDatabaseUrl' in config, false);

    const cookies = parseCookies('eduerp_refresh_token=tok123; eduerp_csrf_token=csrf456');
    assert.equal(cookies.eduerp_refresh_token, 'tok123');
    assert.equal(cookies.eduerp_csrf_token, 'csrf456');

    assert.equal(
      resolveTransportModeHeader({ headers: { 'x-auth-transport': 'cookie' } } as never),
      'COOKIE',
    );
    assert.equal(
      resolveTransportModeHeader({ headers: {} } as never),
      'BEARER',
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

    // Rejects extra fields (mass-assignment protection)
    assert.throws(() =>
      validateLoginRequest({
        username: 'director.demo',
        password: 'ValidPassword_1!',
        is_admin: true,
      }),
    );

    // Rejects If-Match-Version mismatch with expected_version
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
  });
});
