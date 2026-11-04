import * as assert from 'node:assert/strict';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';
import { createApiApplication } from '../src/application';
import { loadApiEnv } from '../src/config/env';
import {
  CANONICAL_ALL_46_TABLES,
  CANONICAL_IMMUTABILITY_TRIGGERS,
  CANONICAL_IMMUTABLE_TABLES,
  CANONICAL_LINEAGE_TRIGGERS,
  CANONICAL_MUTABLE_TABLES,
  PUBLIC_READINESS_FAILURE_MESSAGE,
  sanitizeDatabaseErrorMessage,
} from '../src/database/database.service';
import {
  computeCanonicalPayloadHash,
  deriveClientOperationUuid,
  IdempotencyConflictError,
} from '../src/database/idempotency';
import {
  addMoneyUzs,
  formatMoneyUzs,
  MAX_PG_BIGINT,
  MoneyValidationError,
  parseNonNegativeMoneyUzs,
  parseNonZeroSignedMoneyDeltaUzs,
  parsePositiveMoneyUzs,
  parseSignedMoneyDeltaUzs,
  subtractMoneyUzs,
} from '../src/database/money';
import { validateRestoreSafeSeedEnv } from '../src/database/seed-contract';
import { isRetryableTransactionError, OptimisticVersionConflictError } from '../src/database/transaction';
import {
  assertSafeTestDatabaseUrl,
  resolveApiWorkspaceRoot,
  resolveMigrationSqlPath,
  UnsafeTestDatabaseError,
} from './database/harness';

describe('Stage 04 Database Foundation Offline Unit Tests (F01..F10, Money/BigInt, Retry, Scoped Idempotency, Harness Safety, Readiness 503)', () => {
  it('validates lossless BigInt UZS money above Number.MAX_SAFE_INTEGER and rejects invalid or float values (DB-IT-15)', () => {
    const beyondSafeInt = '9007199254740993';
    const parsed = parsePositiveMoneyUzs(beyondSafeInt);
    assert.equal(parsed, 9007199254740993n);
    assert.equal(formatMoneyUzs(parsed), beyondSafeInt);

    const max18Digit = '999999999999999999';
    assert.equal(formatMoneyUzs(parsePositiveMoneyUzs(max18Digit)), max18Digit);
    assert.equal(parseNonNegativeMoneyUzs('0'), 0n);
    assert.equal(parseSignedMoneyDeltaUzs('-150000'), -150000n);
    assert.equal(parseNonZeroSignedMoneyDeltaUzs('-100000'), -100000n);
    assert.equal(addMoneyUzs(300000n, 200000n), 500000n);
    assert.equal(subtractMoneyUzs(500000n, 300000n), 200000n);

    assert.throws(() => parsePositiveMoneyUzs('0'), MoneyValidationError);
    assert.throws(() => parsePositiveMoneyUzs('-500'), MoneyValidationError);
    assert.throws(() => parsePositiveMoneyUzs('00500'), MoneyValidationError);
    assert.throws(() => parsePositiveMoneyUzs('480000.50'), MoneyValidationError);
    assert.throws(() => parsePositiveMoneyUzs(480000), MoneyValidationError);
    assert.throws(() => parseNonNegativeMoneyUzs('-1'), MoneyValidationError);
    assert.throws(() => parseNonZeroSignedMoneyDeltaUzs('0'), MoneyValidationError);
    assert.throws(() => parsePositiveMoneyUzs('9223372036854775808'), MoneyValidationError);
    assert.throws(() => addMoneyUzs(MAX_PG_BIGINT, 1n), MoneyValidationError);
  });

  it('classifies retryable PostgreSQL serialization/deadlock errors vs non-retryable constraint violations (DB-IT-12)', () => {
    assert.equal(isRetryableTransactionError({ code: '40001' }), true);
    assert.equal(isRetryableTransactionError({ code: '40P01' }), true);
    assert.equal(isRetryableTransactionError({ code: 'P2034' }), true);
    assert.equal(isRetryableTransactionError({ code: '55P03' }, true), true);
    assert.equal(isRetryableTransactionError({ code: '55P03' }, false), false);
    assert.equal(isRetryableTransactionError({ code: '23505' }), false);
    assert.equal(isRetryableTransactionError({ code: '23503' }), false);
    assert.equal(isRetryableTransactionError({ code: '23514' }), false);
    assert.equal(isRetryableTransactionError({ code: '42501' }), false);

    const occErr = new OptimisticVersionConflictError('Invoice', 'inv-1', 2);
    assert.equal(occErr.statusCode, 409);
    assert.equal(occErr.errorCode, 'VERSION_CONFLICT');
  });

  it('computes deterministic canonical payload SHA-256 hashes and preserves client UUIDs in scoped idempotency (F10, DB-IT-13)', () => {
    const h1 = computeCanonicalPayloadHash({ b: 2, a: 'hello', nested: { y: true, x: 1 } });
    const h2 = computeCanonicalPayloadHash({ nested: { x: 1, y: true }, a: 'hello', b: 2 });
    const h3 = computeCanonicalPayloadHash({ nested: { x: 2, y: true }, a: 'hello', b: 2 });
    assert.equal(h1, h2);
    assert.notEqual(h1, h3);

    const rawUuid = '11111111-2222-4333-8444-555555555555';
    assert.equal(
      deriveClientOperationUuid(rawUuid, rawUuid, 'PROBE_A', rawUuid),
      rawUuid,
    );

    const conflict = new IdempotencyConflictError('RECORD_PAYMENT', 'idem-key-12345678');
    assert.equal(conflict.statusCode, 409);
    assert.equal(conflict.errorCode, 'IDEMPOTENCY_PAYLOAD_MISMATCH');
  });

  it('enforces cwd-independent migration path resolution, destructive DB test harness safety guards, and B14 restore seed safety (F05, DB-IT-17)', () => {
    const apiRoot = resolveApiWorkspaceRoot();
    assert.ok(apiRoot.endsWith('apps/api'));
    const m1Path = resolveMigrationSqlPath('20261104000100_initial_foundation');
    const m2Path = resolveMigrationSqlPath('20261104000200_s05_auth_and_rbac_foundation');
    assert.ok(m1Path.endsWith('migration.sql'));
    assert.ok(m2Path.endsWith('migration.sql'));

    assert.throws(
      () =>
        assertSafeTestDatabaseUrl('postgresql://postgres:pass@127.0.0.1:5432/eduerp_test_ci', {
          EDUERP_ALLOW_DESTRUCTIVE_DB_TESTS: 'false',
        }),
      UnsafeTestDatabaseError,
    );

    assert.throws(
      () =>
        assertSafeTestDatabaseUrl('postgresql://postgres:pass@127.0.0.1:5432/eduerp_guliston_ilm_dev', {
          EDUERP_ALLOW_DESTRUCTIVE_DB_TESTS: 'true',
        }),
      UnsafeTestDatabaseError,
    );

    // Rejects remote/production hostnames even if DB name starts with eduerp_test_
    assert.throws(
      () =>
        assertSafeTestDatabaseUrl('postgresql://postgres:pass@prod-db.eduerp.uz:5432/eduerp_test_ci', {
          EDUERP_ALLOW_DESTRUCTIVE_DB_TESTS: 'true',
        }),
      UnsafeTestDatabaseError,
    );

    const valid = assertSafeTestDatabaseUrl('postgresql://postgres:pass@127.0.0.1:5432/eduerp_test_ci', {
      EDUERP_ALLOW_DESTRUCTIVE_DB_TESTS: 'true',
    });
    assert.equal(valid.dbName, 'eduerp_test_ci');

    assert.throws(
      () => validateRestoreSafeSeedEnv({ NODE_ENV: 'test', BOT_OUTBOUND_ENABLED: 'true' }),
      /BOT_OUTBOUND_ENABLED/,
    );
  });

  it('verifies 46 canonical tables, 24 immutability + 11 lineage triggers, and returns static safe 503 message on GET /api/v1/ready when DB is down (F06, DB-IT-18)', async () => {
    assert.equal(CANONICAL_MUTABLE_TABLES.length, 25);
    assert.equal(CANONICAL_IMMUTABLE_TABLES.length, 21);
    assert.equal(CANONICAL_ALL_46_TABLES.length, 46);
    assert.equal(CANONICAL_IMMUTABILITY_TRIGGERS.length, 24);
    assert.equal(CANONICAL_LINEAGE_TRIGGERS.length, 11);

    const leaked = sanitizeDatabaseErrorMessage(
      new Error('connect ECONNREFUSED postgresql://eduerp_api:MyTopSecretPass123@db.internal:5432/eduerp_center_a'),
    );
    assert.equal(leaked.includes('MyTopSecretPass123'), false);
    assert.equal(leaked.includes('[REDACTED_DATABASE_URL]'), true);

    const config = loadApiEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'error',
      API_HOST: '127.0.0.1',
      API_PORT: '3000',
      CENTER_ID: '11111111-2222-4333-8444-555555555555',
      CENTER_SLUG: 'guliston-ilm',
      CENTER_TIMEZONE: 'Asia/Tashkent',
      LICENSE_MODE: 'ACTIVE',
      DATABASE_URL: 'postgresql://eduerp_api_runtime:SecretPassNeverLeak99@127.0.0.1:59998/eduerp_unreachable',
      DB_CONNECT_TIMEOUT_MS: '150',
      JWT_ACCESS_SECRET: 'TestOnly_JwtAccessSecret_AtLeast32CharsLong_01',
      JWT_REFRESH_SECRET: 'TestOnly_JwtRefreshSecret_AtLeast32CharsLong_02',
      INTERNAL_BOT_HMAC_SECRET: 'TestOnly_InternalBotHmacSecret_32CharsLong_03',
      TELEGRAM_WEBHOOK_SECRET: 'TestOnly_TelegramWebhookSecret_24',
    });

    const app = await createApiApplication(config);
    await app.listen(0, '127.0.0.1');
    try {
      const port = ((app.getHttpServer() as http.Server).address() as AddressInfo).port;
      const readyRes = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = http.request({ hostname: '127.0.0.1', port, path: '/api/v1/ready', method: 'GET' }, (res) => {
          res.setEncoding('utf8');
          let raw = '';
          res.on('data', (chunk: string) => {
            raw += chunk;
          });
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: raw }));
        });
        req.on('error', reject);
        req.end();
      });
      assert.equal(readyRes.status, 503);
      assert.equal(readyRes.body.includes('SecretPassNeverLeak99'), false);
      const parsed = JSON.parse(readyRes.body) as Record<string, unknown>;
      assert.equal(parsed.error_code, 'DATABASE_UNAVAILABLE');
      assert.equal(parsed.message, PUBLIC_READINESS_FAILURE_MESSAGE);
    } finally {
      await app.close();
    }
  });
});
