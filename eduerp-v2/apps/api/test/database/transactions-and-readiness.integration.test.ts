import * as assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { createApiApplication } from '../../src/application';
import { loadApiEnv } from '../../src/config/env';
import { PUBLIC_READINESS_FAILURE_MESSAGE } from '../../src/database/database.service';
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
        res.setEncoding('utf8');
        let rawBody = '';
        res.on('data', (chunk: string) => {
          rawBody += chunk;
        });
        res.on('end', () => {
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

describe('PostgreSQL Financial Transaction Rollback, Bounded Retry, Scoped Idempotency & /api/v1/ready (DB-IT-11..13, DB-IT-18, F04, F06, F07, F10)', () => {
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

  it('DB-IT-11 (F07 / T04.03): multi-table financial transaction (payment + allocation + invoice + ledger + audit + outbox) rolls back completely on mid-transaction fault', async () => {
    const enrollmentId = crypto.randomUUID();
    const cycleId = crypto.randomUUID();
    const invoiceId = crypto.randomUUID();
    const shiftId = crypto.randomUUID();

    await env.apiPoolA.query(
      `INSERT INTO "enrollments" ("id", "center_id", "student_id", "group_id", "status", "enrolled_at_date")
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'ACTIVE', '2026-11-01')`,
      [enrollmentId, C.centerId, C.studentId, C.groupId],
    );
    await env.apiPoolA.query(
      `INSERT INTO "billing_cycles" ("id", "center_id", "enrollment_id", "cycle_type", "cycle_key", "cycle_seq", "period_start_date", "period_end_date", "planned_lessons", "billable_lessons", "policy_version_id")
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'CALENDAR_MONTH', '2026-11-TX', 1, '2026-11-01', '2026-11-30', 12, 12, $4::uuid)`,
      [cycleId, C.centerId, enrollmentId, C.billingPolicyId],
    );
    await env.apiPoolA.query(
      `INSERT INTO "invoices" ("id", "center_id", "invoice_number", "student_id", "enrollment_id", "billing_cycle_id", "policy_version_id", "tariff_snapshot_uzs", "base_pro_rata_charge_uzs", "approved_discount_uzs", "credit_note_adjustments_uzs", "effective_net_charge_uzs", "allocated_paid_uzs", "remaining_debt_uzs", "billed_lessons", "status", "due_date")
       VALUES ($1::uuid, $2::uuid, 'INV-TX-ROLLBACK-01', $3::uuid, $4::uuid, $5::uuid, $6::uuid, 480000, 480000, 0, 0, 480000, 0, 480000, 12, 'ISSUED_OPEN', '2026-11-05')`,
      [invoiceId, C.centerId, C.studentId, enrollmentId, cycleId, C.billingPolicyId],
    );
    await env.apiPoolA.query(
      `INSERT INTO "cash_shifts" ("id", "center_id", "shift_date", "opened_by_admin_id", "opening_cash_uzs", "expected_closing_cash_uzs", "status")
       VALUES ($1::uuid, $2::uuid, '2026-11-04', $3::uuid, 0, 0, 'OPEN')`,
      [shiftId, C.centerId, C.adminId],
    );

    const paymentId = crypto.randomUUID();
    const allocationId = crypto.randomUUID();
    const ledgerId = crypto.randomUUID();
    const auditId = crypto.randomUUID();
    const outboxId = crypto.randomUUID();

    await assert.rejects(
      () =>
        runInTransaction(env.apiPoolA, async (tx) => {
          await tx.query(
            `INSERT INTO "payments" ("id", "center_id", "student_id", "cash_shift_id", "amount_uzs", "payment_method", "recorded_by_admin_id", "idempotency_key", "request_hash")
             VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 300000, 'CASH', $5::uuid, 'idem-fin-rollback-01', $6)`,
            [paymentId, C.centerId, C.studentId, shiftId, C.adminId, 'e'.repeat(64)],
          );
          await tx.query(
            `INSERT INTO "payment_allocations" ("id", "center_id", "payment_id", "invoice_id", "allocated_amount_uzs")
             VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 300000)`,
            [allocationId, C.centerId, paymentId, invoiceId],
          );
          await tx.query(
            `UPDATE "invoices"
                SET "allocated_paid_uzs" = 300000,
                    "remaining_debt_uzs" = 180000,
                    "status" = 'PARTIALLY_PAID',
                    "version" = "version" + 1
              WHERE "id" = $1::uuid`,
            [invoiceId],
          );
          await tx.query(
            `INSERT INTO "ledger_entries" ("id", "center_id", "entry_type", "student_id", "invoice_id", "payment_id", "direction", "amount_uzs", "payment_method", "actor_type", "actor_staff_id")
             VALUES ($1::uuid, $2::uuid, 'PAYMENT_RECEIVED', $3::uuid, $4::uuid, $5::uuid, 'CREDIT', 300000, 'CASH', 'STAFF', $6::uuid)`,
            [ledgerId, C.centerId, C.studentId, invoiceId, paymentId, C.adminId],
          );
          await tx.query(
            `INSERT INTO "audit_logs" ("id", "center_id", "actor_type", "actor_id", "actor_role", "action", "entity_type", "entity_id", "severity", "request_id")
             VALUES ($1::uuid, $2::uuid, 'STAFF', $3::uuid, 'ADMIN', 'PAYMENT_RECORDED', 'Payment', $4::uuid, 'INFO', 'req-fin-rollback-01')`,
            [auditId, C.centerId, C.adminId, paymentId],
          );
          await tx.query(
            `INSERT INTO "outbox_events" ("id", "center_id", "event_name", "schema_version", "aggregate_type", "aggregate_id", "aggregate_version", "dedup_key", "payload_json", "status")
             VALUES ($1::uuid, $2::uuid, 'PaymentRecorded', 1, 'Payment', $3::uuid, 1, 'rollback-fin-outbox-1', '{}'::jsonb, 'PENDING')`,
            [outboxId, C.centerId, paymentId],
          );

          throw new Error('SIMULATED_FINANCIAL_OUTBOX_COMMIT_FAULT');
        }),
      /SIMULATED_FINANCIAL_OUTBOX_COMMIT_FAULT/,
    );

    const [pCnt, aCnt, lCnt, auCnt, oCnt, invCheck] = await Promise.all([
      env.apiPoolA.query(`SELECT "id" FROM "payments" WHERE "id" = $1::uuid`, [paymentId]),
      env.apiPoolA.query(`SELECT "id" FROM "payment_allocations" WHERE "id" = $1::uuid`, [allocationId]),
      env.apiPoolA.query(`SELECT "id" FROM "ledger_entries" WHERE "id" = $1::uuid`, [ledgerId]),
      env.apiPoolA.query(`SELECT "id" FROM "audit_logs" WHERE "id" = $1::uuid`, [auditId]),
      env.apiPoolA.query(`SELECT "id" FROM "outbox_events" WHERE "id" = $1::uuid`, [outboxId]),
      env.apiPoolA.query<{ allocated_paid_uzs: string; remaining_debt_uzs: string; status: string; version: number }>(
        `SELECT "allocated_paid_uzs"::text AS allocated_paid_uzs, "remaining_debt_uzs"::text AS remaining_debt_uzs, "status", "version"
           FROM "invoices" WHERE "id" = $1::uuid`,
        [invoiceId],
      ),
    ]);

    assert.equal(pCnt.rowCount, 0);
    assert.equal(aCnt.rowCount, 0);
    assert.equal(lCnt.rowCount, 0);
    assert.equal(auCnt.rowCount, 0);
    assert.equal(oCnt.rowCount, 0);
    assert.equal(invCheck.rows[0]?.allocated_paid_uzs, '0');
    assert.equal(invCheck.rows[0]?.remaining_debt_uzs, '480000');
    assert.equal(invCheck.rows[0]?.status, 'ISSUED_OPEN');
    assert.equal(invCheck.rows[0]?.version, 1);
  });

  it('DB-IT-12 (F07): concurrent optimistic version update, SERIALIZABLE 40001 retry success, and bounded 40001 retry exhaustion', async () => {
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

    // Real PostgreSQL SERIALIZABLE 40001 write-skew retry verification
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

    // F07: Bounded retry exhaustion on real PostgreSQL SQLSTATE 40001
    let exhaustedAttempts = 0;
    await assert.rejects(
      () =>
        runInTransaction(
          env.apiPoolA,
          async (tx) => {
            exhaustedAttempts += 1;
            await tx.query(`DO $$ BEGIN RAISE EXCEPTION 'simulated_serialization_failure' USING ERRCODE = '40001'; END $$;`);
          },
          { maxRetries: 2, baseBackoffMs: 5 },
        ),
      (err: unknown) => {
        assert.equal((err as { code?: string }).code, '40001');
        return true;
      },
    );
    assert.equal(exhaustedAttempts, 3, 'Must execute initial attempt + 2 bounded retries = 3 attempts');
  });

  it('DB-IT-13 (F10): scoped UUID idempotency prevents cross-operation/cross-actor 23505 collisions, replays identical payload with 1 persisted DB row, and rejects changed payload with 409', async () => {
    const sharedUuidKey = crypto.randomUUID();
    const courseIdA = crypto.randomUUID();
    const courseIdB = crypto.randomUUID();

    // F10 Regression (exact MANAGER_S04_PROBES reproducer): same UUID key across PROBE_A and PROBE_B must both succeed without 23505!
    const probeA1 = await executeIdempotentOperation(env.apiPoolA, {
      centerId: C.centerId,
      actorStaffId: C.directorId,
      operationType: 'PROBE_A',
      idempotencyKey: sharedUuidKey,
      requestPayload: { name: 'Idempotent Course A', fee: 400000 },
      handler: async (tx) => {
        await tx.query(
          `INSERT INTO "courses" ("id", "center_id", "name", "default_monthly_fee_uzs", "default_lessons_per_cycle", "status")
           VALUES ($1::uuid, $2::uuid, 'Idempotent Course A', 400000, 12, 'ACTIVE')`,
          [courseIdA, C.centerId],
        );
        return { statusCode: 201, body: { course_id: courseIdA } };
      },
    });
    assert.equal(probeA1.replayed, false);

    const probeB1 = await executeIdempotentOperation(env.apiPoolA, {
      centerId: C.centerId,
      actorStaffId: C.directorId,
      operationType: 'PROBE_B',
      idempotencyKey: sharedUuidKey,
      requestPayload: { name: 'Idempotent Course B', fee: 450000 },
      handler: async (tx) => {
        await tx.query(
          `INSERT INTO "courses" ("id", "center_id", "name", "default_monthly_fee_uzs", "default_lessons_per_cycle", "status")
           VALUES ($1::uuid, $2::uuid, 'Idempotent Course B', 450000, 12, 'ACTIVE')`,
          [courseIdB, C.centerId],
        );
        return { statusCode: 201, body: { course_id: courseIdB } };
      },
    });
    assert.equal(probeB1.replayed, false);
    assert.equal(probeB1.body.course_id, courseIdB);

    // Same key on PROBE_A with different actorStaffId also succeeds without collision
    const probeAdmin = await executeIdempotentOperation(env.apiPoolA, {
      centerId: C.centerId,
      actorStaffId: C.adminId,
      operationType: 'PROBE_A',
      idempotencyKey: sharedUuidKey,
      requestPayload: { name: 'Admin Probe A' },
      handler: async () => ({ statusCode: 200, body: { actor: 'admin' } }),
    });
    assert.equal(probeAdmin.replayed, false);

    // Replaying PROBE_A with same actor + same payload returns stored response and does not duplicate DB row
    const probeA2 = await executeIdempotentOperation(env.apiPoolA, {
      centerId: C.centerId,
      actorStaffId: C.directorId,
      operationType: 'PROBE_A',
      idempotencyKey: sharedUuidKey,
      requestPayload: { fee: 400000, name: 'Idempotent Course A' },
      handler: async () => {
        throw new Error('Handler must not execute on idempotent replay');
      },
    });
    assert.equal(probeA2.replayed, true);
    assert.deepEqual(probeA2.body, probeA1.body);

    const persistedCourses = await env.apiPoolA.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM "courses" WHERE "id" IN ($1::uuid, $2::uuid)`,
      [courseIdA, courseIdB],
    );
    assert.equal(Number(persistedCourses.rows[0]?.cnt), 2);

    // Same scope + changed payload -> 409 IDEMPOTENCY_PAYLOAD_MISMATCH
    await assert.rejects(
      () =>
        executeIdempotentOperation(env.apiPoolA, {
          centerId: C.centerId,
          actorStaffId: C.directorId,
          operationType: 'PROBE_A',
          idempotencyKey: sharedUuidKey,
          requestPayload: { name: 'Idempotent Course A', fee: 999999 },
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

  it('DB-IT-18 (F06): GET /api/v1/ready returns 200 READY only for least-privilege runtime role and returns static safe 503 for migrator/superuser/down DB while /api/v1/health stays 200 OK', async () => {
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

    // 1. Least-privilege runtime role -> 200 READY
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

    // 2. Schema-owner migrator role -> rejected with 503 (F06: runtime must not use schema owner)
    const appMigrator = await createApiApplication(
      loadApiEnv({
        ...baseEnv,
        DATABASE_URL: env.migratorCenterAUrl,
      }),
    );
    await appMigrator.listen(0, '127.0.0.1');
    try {
      const port = ((appMigrator.getHttpServer() as http.Server).address() as AddressInfo).port;
      const migRes = await httpGetJson(port, '/api/v1/ready');
      assert.equal(migRes.statusCode, 503);
      assert.equal(migRes.json.error_code, 'DATABASE_UNAVAILABLE');
      assert.equal(migRes.json.message, PUBLIC_READINESS_FAILURE_MESSAGE);
    } finally {
      await appMigrator.close();
    }

    // 3. Unreachable DB -> 503 static safe message without leaking credentials, while /api/v1/health stays 200 OK
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
      assert.equal(downRes.json.message, PUBLIC_READINESS_FAILURE_MESSAGE);
      assert.equal(downRes.rawBody.includes(secretDbPass), false);
      assert.equal(downRes.rawBody.includes('postgresql://'), false);
    } finally {
      await appDown.close();
    }
  });
});
