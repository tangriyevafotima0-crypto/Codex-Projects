import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ApiConfigValidationError, loadApiEnv, redactApiConfig } from '../src/config/env';

const VALID_BASE_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'info',
  API_HOST: '127.0.0.1',
  API_PORT: '3000',
  CENTER_ID: '11111111-2222-4333-8444-555555555555',
  CENTER_SLUG: 'guliston-ilm',
  CENTER_TIMEZONE: 'Asia/Tashkent',
  LICENSE_MODE: 'ACTIVE',
  DATABASE_URL: 'postgresql://eduerp_app_dev:SuperSecretDbPass_DoNotLeak_99@postgres:5432/eduerp_guliston_ilm_dev',
  JWT_ACCESS_SECRET: 'TestOnly_JwtAccessSecret_AtLeast32CharsLong_01',
  JWT_REFRESH_SECRET: 'TestOnly_JwtRefreshSecret_AtLeast32CharsLong_02',
  INTERNAL_BOT_HMAC_SECRET: 'TestOnly_InternalBotHmacSecret_32CharsLong_03',
  TELEGRAM_WEBHOOK_SECRET: 'TestOnly_TelegramWebhookSecret_24',
};

describe('API Typed Config Validation & Secret Redaction (T03.02)', () => {
  it('loads valid environment variables into a frozen ApiEnvConfig object', () => {
    const config = loadApiEnv(VALID_BASE_ENV);
    assert.equal(config.nodeEnv, 'test');
    assert.equal(config.apiHost, '127.0.0.1');
    assert.equal(config.apiPort, 3000);
    assert.equal(config.centerId, '11111111-2222-4333-8444-555555555555');
    assert.equal(config.centerSlug, 'guliston-ilm');
    assert.equal(config.licenseMode, 'ACTIVE');
    assert.ok(Object.isFrozen(config));
  });

  it('fails fast with ApiConfigValidationError when required variables are missing', () => {
    assert.throws(
      () => loadApiEnv({ NODE_ENV: 'development' }),
      (err: unknown) => {
        assert.ok(err instanceof ApiConfigValidationError);
        assert.ok(err.invalidFields.includes('CENTER_ID'));
        assert.ok(err.invalidFields.includes('CENTER_SLUG'));
        assert.ok(err.invalidFields.includes('DATABASE_URL'));
        assert.ok(err.invalidFields.includes('JWT_ACCESS_SECRET'));
        return true;
      },
    );
  });

  it('rejects non-PostgreSQL DATABASE_URL, invalid port, invalid UUID, and identical JWT secrets without leaking secret values', () => {
    const leakedDbPass = 'LeakedPassword_ShouldNeverAppearInError_777';
    const leakedJwtSecret = 'IdenticalSecretValue_ShouldNeverAppearInError_888';

    assert.throws(
      () =>
        loadApiEnv({
          ...VALID_BASE_ENV,
          API_PORT: '99999',
          CENTER_ID: 'not-a-uuid',
          CENTER_SLUG: 'Invalid Uppercase Slug!',
          DATABASE_URL: `http://user:${leakedDbPass}@localhost:5432/db`,
          JWT_ACCESS_SECRET: leakedJwtSecret,
          JWT_REFRESH_SECRET: leakedJwtSecret,
        }),
      (err: unknown) => {
        assert.ok(err instanceof ApiConfigValidationError);
        assert.ok(err.invalidFields.includes('API_PORT'));
        assert.ok(err.invalidFields.includes('CENTER_ID'));
        assert.ok(err.invalidFields.includes('CENTER_SLUG'));
        assert.ok(err.invalidFields.includes('DATABASE_URL'));
        assert.ok(err.invalidFields.includes('JWT_REFRESH_SECRET'));
        assert.equal(err.message.includes(leakedDbPass), false, 'Error message must never leak DB password');
        assert.equal(err.message.includes(leakedJwtSecret), false, 'Error message must never leak JWT secret');
        return true;
      },
    );
  });

  it('redacts all secret and credential fields in redactApiConfig()', () => {
    const config = loadApiEnv(VALID_BASE_ENV);
    const redacted = JSON.stringify(redactApiConfig(config));
    assert.equal(redacted.includes('SuperSecretDbPass_DoNotLeak_99'), false);
    assert.equal(redacted.includes('TestOnly_JwtAccessSecret'), false);
    assert.equal(redacted.includes('TestOnly_JwtRefreshSecret'), false);
    assert.equal(redacted.includes('TestOnly_InternalBotHmacSecret'), false);
    assert.equal(redacted.includes('TestOnly_TelegramWebhookSecret'), false);
    assert.equal(redacted.includes('guliston-ilm'), true);
  });
});

it('rejects an invalid IANA timezone', () => {
  assert.throws(() => loadApiEnv({ ...VALID_BASE_ENV, CENTER_TIMEZONE: 'Not/AZone' }), /CENTER_TIMEZONE/);
});
