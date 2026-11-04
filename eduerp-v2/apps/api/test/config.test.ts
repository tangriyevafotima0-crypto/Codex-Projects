import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import {
  API_CANONICAL_ENV_KEYS,
  ApiConfigValidationError,
  FORBIDDEN_LEGACY_API_ENV_ALIASES,
  loadApiEnv,
  redactApiConfig,
} from '../src/config/env';

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

function resolveProjectRoot(): string {
  const candidate = path.resolve(__dirname, '../../../');
  if (fs.existsSync(path.join(candidate, '.env.example'))) {
    return candidate;
  }
  const fallback = path.resolve(__dirname, '../../../../');
  if (fs.existsSync(path.join(fallback, '.env.example'))) {
    return fallback;
  }
  return process.cwd();
}

describe('API Typed Config Validation, Canonical Env Parity (G03) & Secret Redaction (T03.02)', () => {
  it('loads valid environment variables into a frozen ApiEnvConfig object', () => {
    const config = loadApiEnv(VALID_BASE_ENV);
    assert.equal(config.nodeEnv, 'test');
    assert.equal(config.apiHost, '127.0.0.1');
    assert.equal(config.apiPort, 3000);
    assert.equal(config.centerId, '11111111-2222-4333-8444-555555555555');
    assert.equal(config.centerSlug, 'guliston-ilm');
    assert.equal(config.licenseMode, 'ACTIVE');
    assert.equal(config.passwordHashMaxConcurrency, 4);
    assert.equal(config.passwordHashMaxQueue, 64);
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

  it('G03: enforces 1-for-1 canonical environment variable name parity across .env.example, infra/compose.dev.yml, and loadApiEnv() and rejects legacy aliases', () => {
    const root = resolveProjectRoot();
    const envExampleText = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
    const composeText = fs.readFileSync(path.join(root, 'infra/compose.dev.yml'), 'utf8');

    const envExampleKeys = new Set<string>();
    for (const line of envExampleText.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx > 0) {
        envExampleKeys.add(trimmed.slice(0, idx).trim());
      }
    }

    // Extract keys under services.api.environment in infra/compose.dev.yml
    const apiBlockMatch = /\n  api:\n([\s\S]*?)\n  worker:\n/.exec(composeText);
    assert.ok(apiBlockMatch, 'Expected api service block in infra/compose.dev.yml');
    const envBlockMatch = /\n    environment:\n([\s\S]*?)\n    ports:\n/.exec(apiBlockMatch[1]);
    assert.ok(envBlockMatch, 'Expected environment block in api service');

    const composeApiKeys = new Set<string>();
    for (const line of envBlockMatch[1].split(/\r?\n/)) {
      const m = /^\s{6}([A-Z0-9_]+):/.exec(line);
      if (m) {
        composeApiKeys.add(m[1]);
      }
    }

    // Every canonical API key must be present in both .env.example and compose.dev.yml api.environment
    for (const canonicalKey of API_CANONICAL_ENV_KEYS) {
      assert.equal(
        envExampleKeys.has(canonicalKey),
        true,
        `Missing canonical key ${canonicalKey} in .env.example (G03)`,
      );
      assert.equal(
        composeApiKeys.has(canonicalKey),
        true,
        `Missing canonical key ${canonicalKey} in infra/compose.dev.yml api.environment (G03)`,
      );
    }

    // Forbidden legacy/mismatched keys must NOT appear in .env.example or compose.dev.yml api.environment
    for (const legacyKey of Object.keys(FORBIDDEN_LEGACY_API_ENV_ALIASES)) {
      assert.equal(
        composeApiKeys.has(legacyKey),
        false,
        `Forbidden legacy/migration key ${legacyKey} must not be passed to api service in compose.dev.yml (G03)`,
      );
      if (legacyKey !== 'MIGRATION_DATABASE_URL') {
        assert.equal(
          envExampleKeys.has(legacyKey),
          false,
          `Forbidden legacy alias ${legacyKey} must not appear in .env.example (G03)`,
        );
      }
    }

    // Passing a legacy alias to loadApiEnv() fails fast with ApiConfigValidationError instead of silently falling back
    assert.throws(
      () =>
        loadApiEnv({
          ...VALID_BASE_ENV,
          ALLOWED_WEB_ORIGINS: 'https://guliston-ilm.eduerp.uz',
          REFRESH_SESSION_TTL_SECONDS: '7200',
        }),
      (err: unknown) => {
        assert.ok(err instanceof ApiConfigValidationError);
        assert.ok(err.invalidFields.includes('ALLOWED_WEB_ORIGINS'));
        assert.ok(err.invalidFields.includes('REFRESH_SESSION_TTL_SECONDS'));
        return true;
      },
    );

    // Verify Dockerfile defines dedicated migrator and runner targets (G03)
    const dockerfileText = fs.readFileSync(path.join(root, 'apps/api/Dockerfile'), 'utf8');
    assert.ok(dockerfileText.includes('AS migrator'), 'apps/api/Dockerfile must define dedicated AS migrator target');
    assert.ok(dockerfileText.includes('AS runner'), 'apps/api/Dockerfile must define minimal AS runner target');
    assert.ok(composeText.includes('target: migrator'), 'compose.dev.yml migrator service must target migrator stage');
  });
});

it('rejects an invalid IANA timezone', () => {
  assert.throws(() => loadApiEnv({ ...VALID_BASE_ENV, CENTER_TIMEZONE: 'Not/AZone' }), /CENTER_TIMEZONE/);
});
