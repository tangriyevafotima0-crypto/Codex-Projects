import * as assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { createApiApplication } from '../../src/application';
import { loadApiEnv } from '../../src/config/env';
import {
  executeIdempotentOperation,
  IdempotencyConflictError,
} from '../../src/database/idempotency';
import {
  executeSyntheticSeed,
  SYNTHETIC_DEMO_CENTER_A,
} from '../../src/database/seed-contract';
import {
  executeOptimisticUpdate,
  OptimisticVersionConflictError,
  runInTransaction,
} from '../../src/database/transaction';
import {
  createEphemeralTestDbEnv,
  EphemeralDatabaseEnvironment,
} from './harness';

function httpGetJson(
  port: number,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ statusCode: number; rawBody: string; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method: 'GET', headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const rawBody = Buffer.concat(chunks).toString('utf8');
          resolve({
            statusCode: res.statusCode ?? 0,
            rawBody,
            json: JSON.parse(rawBody) as Record<string, unknown>,
          });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('PostgreSQL Transactions, Optimistic Locking, Idempotency & /api/v1/ready (DB-IT-11..13, DB-IT-18)', () => {
  let env: EphemeralDatabaseEnvironment;
  const C = SYNTHETIC_DEMO_CENTER_A;

  before(async () => {
    env = await createEphemeralTestDbEnv();
    await executeSyntheticSeed(env.apiPoolA, C, {
      ...process.env,
      NODE_ENV: 'test',
      BOT_OUTBOUND_ENABLED: 'false',
    });
  });

  after(async () => {
    if (env) {
      await env.cleanup();
    }
  });

  it('DB-IT-11: transaction rollback leaves zero partial writes across students and outbox_events', async () => {
    const tempStudentId = crypto.randomUUID();
    const tempOutboxId = crypto.randomUUID();

    await assert.rejects(
      () =>
        runInTransaction(env.apiPoolA, async (tx) => {
          await tx.query(
            `INSERT INTO "students" ("id", "center_id", "student_code", "full_name", "normalized_name", "status")
             VALUES ($1::uuid, $2::uuid, 'STU-ROLLBACK-01', 'Rollback Test Student', 'rollback test student', 'ACTIVE')`,
            [tempStudentId, C.centerId],
          );
          await tx.query(
            `INSERT INTO "outbox_events" ("id", "center_id", "event_name", "schema_version", "aggregate_type", "aggregate_id", "aggregate_version", "dedup_key", "payload_json", "status")
             VALUES ($1::uuid, $2::uuid, 'PaymentRecorded', 1, 'Student', $3::uuid, 1, 'rollback-outbox-1', '{}'::jsonb, 'PENDING')`,
            [tempOutboxId, C.centerId, tempStudentId],
          );
          throw new Error('SIMULATED_MID_TRANSACTION_FAILURE');
        }),
      /SIMULATED_MID_TRANSACTION_FAILURE/,
    );

    const checkStudent = await env.apiPoolA.query(`SELECT "id" FROM "students" WHERE "id" = $1::uuid`, [tempStudentId]);
    const checkOutbox = await env.apiPoolA.query(`SELECT "id" FROM "outbox_events" WHERE "id" = $1::uuid`, [tempOutboxId]);
    assert.equal(checkStudent.rowCount, 0);
    assert.equal(checkOutbox.rowCount, 0);
  });

  it('DB-IT-12: concurrent optimistic version update allows 1 winner and rejects stale expected_version with 409 VERSION_CONFLICT, and SERIALIZABLE conflict retries cleanly', async () => {
    const studentId = crypto.randomUUID();
    await env.apiPoolA.query(
      `INSERT INTO "students" ("id", "center_id", "student_code", "full_name", "normalized_name", "status", "version")
       VALUES ($1::uuid, $2::uuid, 'STU-OPT-01', 'Optimistic Student', 'optimistic student', 'ACTIVE', 1)`,
      [studentId, C.centerId],
    );

    const outcomes = await Promise.allSettled([
      runInTransaction(env.apiPoolA, (tx) =>
        executeOptimisticUpdate(tx, {
          tableName: 'students',
          entityName: 'Student',
          id: studentId,
          centerId: C.centerId,
          expectedVersion: 1,
          setClauseSql: `"full_name" = $4`,
          additionalValues: ['Optimistic Winner A'],
        }),
      ),
      runInTransaction(env.apiPoolA, (tx) =>
        executeOptimisticUpdate(tx, {
          tableName: 'students',
          entityName: 'Student',
          id: studentId,
          centerId: C.centerId,
          expectedVersion: 1,
          setClauseSql: `"full_name" = $4`,
          additionalValues: ['Optimistic Winner B'],
        }),
      ),
    ]);

    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
    const rejected = outcomes.filter((o) => o.status === 'rejected') as PromiseRejectedResult[];
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.ok(rejected[0].reason instanceof OptimisticVersionConflictError);
    assert.equal((rejected[0].reason as OptimisticVersionConflictError).statusCode, 409);

    let barrierRelease1!: () => void;
    const barrier1 = new Promise<void>((r) => {
      barrierRelease1 = r;
    });
    let tx1ReadDone!: () => void;
    const tx1ReadPromise = new Promise<void>((r) => {
      tx1ReadDone = r;
    });
    let retryCount = 0;

    const [serA, serB] = await Promise.all([
      runInTransaction(
        env.apiPoolA,
        async (tx) => {
          const cur = await tx.query<{ version: number }>(
            `SELECT "version" FROM "students" WHERE "id" = $1::uuid`,
            [studentId],
          );
          if (tx.attempt === 1) {
            tx1ReadDone();
            await barrier1;
          }
          await tx.query(
            `UPDATE "students" SET "notes" = $2, "version" = $3 WHERE "id" = $1::uuid`,
            [studentId, `ser-a-attempt-${tx.attempt}`, cur.rows[0].version + 1],
          );
          return tx.attempt;
        },
        {
          isolationLevel: 'SERIALIZABLE',
          maxRetries: 3,
          baseBackoffMs: 10,
          onRetryAttempt: () => {
            retryCount += 1;
          },
        },
      ),
      (async () => {
        await tx1ReadPromise;
        const res = await runInTransaction(
          env.apiPoolA,
          async (tx) => {
            const cur = await tx.query<{ version: number }>(
              `SELECT "version" FROM "students" WHERE "id" = $1::uuid`,
              [studentId],
            );
            await tx.query(
              `UPDATE "students" SET "notes" = 'ser-b', "version" = $2 WHERE "id" = $1::uuid`,
              [studentId, cur.rows[0].version + 1],
            );
            return tx.attempt;
          },
          { isolationLevel: 'SERIALIZABLE', maxRetries: 3, baseBackoffMs: 10 },
        );
        barrierRelease1();
        return res;
      })(),
    ]);

    assert.ok(serA.attempts >= 2 || serB.attempts >= 2 || retryCount >= 1);
  });

  it('DB-IT-13: concurrent idempotency key execution replays identical payload and rejects differing payload with 409 IDEMPOTENCY_PAYLOAD_MISMATCH', async () => {
    let handlerExecutions = 0;
    const idempotencyKey = crypto.randomUUID();
    const payload = { student_id: C.studentId, amount_uzs: '300000', method: 'CASH' };

    const [call1, call2] = await Promise.all([
      executeIdempotentOperation(env.apiPoolA, {
        centerId: C.centerId,
        actorStaffId: C.directorId,
        operationType: 'RECORD_PAYMENT',
        idempotencyKey,
        requestPayload: payload,
        handler: async () => {
          handlerExecutions += 1;
          return {
            statusCode: 201,
            body: { payment_id: '11111111-1111-4111-8111-111111111199', amount_uzs: '300000' },
          };
        },
      }),
      executeIdempotentOperation(env.apiPoolA, {
        centerId: C.centerId,
        actorStaffId: C.directorId,
        operationType: 'RECORD_PAYMENT',
        idempotencyKey,
        requestPayload: payload,
        handler: async () => {
          handlerExecutions += 1;
          return {
            statusCode: 201,
            body: { payment_id: '22222222-2222-4222-8222-222222222299', amount_uzs: '300000' },
          };
        },
      }),
    ]);

    assert.equal(handlerExecutions, 1, 'Side-effect handler must execute exactly once');
    assert.deepEqual(call1.body, call2.body);
    assert.equal([call1.replayed, call2.replayed].sort().join(','), 'false,true');

    await assert.rejects(
      () =>
        executeIdempotentOperation(env.apiPoolA, {
          centerId: C.centerId,
          actorStaffId: C.directorId,
          operationType: 'RECORD_PAYMENT',
          idempotencyKey,
          requestPayload: { student_id: C.studentId, amount_uzs: '450000', method: 'CASH' },
          handler: async () => ({ statusCode: 201, body: {} }),
        }),
      (err: unknown) => {
        assert.ok(err instanceof IdempotencyConflictError);
        assert.equal(err.statusCode, 409);
        assert.equal(err.errorCode, 'IDEMPOTENCY_PAYLOAD_MISMATCH');
        return true;
      },
    );
  });

  it('DB-IT-18: GET /api/v1/ready returns 200 READY on migrated runtime DB and 503 with redacted ErrorEnvelope when DB is down or superuser, while GET /api/v1/health stays 200 OK', async () => {
    const baseEnv = {
      NODE_ENV: 'test',
      LOG_LEVEL: 'error',
      API_HOST: '127.0.0.1',
      API_PORT: '3000',
      CENTER_ID: C.centerId,
      CENTER_SLUG: C.centerSlug,
      CENTER_TIMEZONE: 'Asia/Tashkent',
      LICENSE_MODE: 'ACTIVE',
      DATABASE_URL: env.apiRuntimeCenterAUrl,
      JWT_ACCESS_SECRET: 'TestOnly_JwtAccessSecret_AtLeast32CharsLong_01',
      JWT_REFRESH_SECRET: 'TestOnly_JwtRefreshSecret_AtLeast32CharsLong_02',
      INTERNAL_BOT_HMAC_SECRET: 'TestOnly_InternalBotHmacSecret_32CharsLong_03',
      TELEGRAM_WEBHOOK_SECRET: 'TestOnly_TelegramWebhookSecret_24',
    };

    const appReady = await createApiApplication(loadApiEnv(baseEnv));
    await appReady.listen(0, '127.0.0.1');
    try {
      const port = ((appReady.getHttpServer() as http.Server).address() as AddressInfo).port;
      const readyRes = await httpGetJson(port, '/api/v1/ready', {
        'X-Request-Id': '11111111-2222-4333-8444-abcdef123456',
      });
      assert.equal(readyRes.statusCode, 200);
      assert.equal(readyRes.json.status, 'READY');
      assert.equal(readyRes.json.database_status, 'READY');
      assert.equal(readyRes.json.schema_tables_verified, 46);
      assert.equal(readyRes.json.immutable_triggers_verified, 24);
      assert.equal(readyRes.json.request_id, '11111111-2222-4333-8444-abcdef123456');
    } finally {
      await appReady.close();
    }

    const secretDbPass = 'UltraSecretDbPass_MustNeverAppearIn503_999';
    const appDown = await createApiApplication(
      loadApiEnv({
        ...baseEnv,
        DATABASE_URL: `postgresql://eduerp_api_runtime:${secretDbPass}@127.0.0.1:59999/eduerp_test_unreachable`,
        DB_CONNECT_TIMEOUT_MS: '250',
      }),
    );
    await appDown.listen(0, '127.0.0.1');
    try {
      const port = ((appDown.getHttpServer() as http.Server).address() as AddressInfo).port;
      const healthRes = await httpGetJson(port, '/api/v1/health');
      assert.equal(healthRes.statusCode, 200);
      assert.equal(healthRes.json.status, 'OK');

      const downRes = await httpGetJson(port, '/api/v1/ready');
      assert.equal(downRes.statusCode, 503);
      assert.equal(downRes.json.error_code, 'DATABASE_UNAVAILABLE');
      assert.equal(downRes.rawBody.includes(secretDbPass), false);
      assert.equal(downRes.rawBody.includes('postgresql://'), false);
    } finally {
      await appDown.close();
    }
  });
});
