import * as assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { loadApiEnv } from '../../src/config/env';
import {
  CANONICAL_ALL_46_TABLES,
  CANONICAL_IMMUTABILITY_TRIGGERS,
  CANONICAL_IMMUTABLE_TABLES,
  CANONICAL_MUTABLE_TABLES,
  DatabaseService,
} from '../../src/database/database.service';
import {
  executeSyntheticSeed,
  SYNTHETIC_DEMO_CENTER_A,
} from '../../src/database/seed-contract';
import {
  applyInitialMigrationSql,
  createEphemeralTestDbEnv,
  EphemeralDatabaseEnvironment,
} from './harness';

describe('PostgreSQL Migrations, Idempotent Seed & 46-Table Schema Drift (DB-IT-01..04, DB-IT-20)', () => {
  let env: EphemeralDatabaseEnvironment;
  let dbService: DatabaseService;

  before(async () => {
    env = await createEphemeralTestDbEnv();
    const apiConfig = loadApiEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'error',
      API_HOST: '127.0.0.1',
      API_PORT: '3000',
      CENTER_ID: SYNTHETIC_DEMO_CENTER_A.centerId,
      CENTER_SLUG: SYNTHETIC_DEMO_CENTER_A.centerSlug,
      CENTER_TIMEZONE: 'Asia/Tashkent',
      LICENSE_MODE: 'ACTIVE',
      DATABASE_URL: env.apiRuntimeCenterAUrl,
      JWT_ACCESS_SECRET: 'TestOnly_JwtAccessSecret_AtLeast32CharsLong_01',
      JWT_REFRESH_SECRET: 'TestOnly_JwtRefreshSecret_AtLeast32CharsLong_02',
      INTERNAL_BOT_HMAC_SECRET: 'TestOnly_InternalBotHmacSecret_32CharsLong_03',
      TELEGRAM_WEBHOOK_SECRET: 'TestOnly_TelegramWebhookSecret_24',
    });
    dbService = new DatabaseService(apiConfig);
  });

  after(async () => {
    if (dbService) {
      await dbService.close();
    }
    if (env) {
      await env.cleanup();
    }
  });

  it('DB-IT-01 & DB-IT-02: initial migration applies cleanly on empty DB and second run is an idempotent no-op', async () => {
    const secondRun = await applyInitialMigrationSql(env.migratorPoolA);
    assert.equal(secondRun.applied, false, 'Second migration run must be an idempotent no-op');

    const migRows = await env.apiPoolA.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "_prisma_migrations" WHERE "migration_name" = '20261104000100_initial_foundation'`,
    );
    assert.equal(Number(migRows.rows[0]?.count), 1);
  });

  it('DB-IT-03: synthetic seed contract applies baseline records and second run is idempotent with 0 duplicate inserts', async () => {
    const firstSeed = await executeSyntheticSeed(env.apiPoolA, SYNTHETIC_DEMO_CENTER_A, {
      ...process.env,
      NODE_ENV: 'test',
      BOT_OUTBOUND_ENABLED: 'false',
    });
    assert.ok(firstSeed.insertedRowCount >= 11, `Expected >=11 seeded rows, got ${firstSeed.insertedRowCount}`);
    assert.equal(firstSeed.idempotentNoOp, false);

    const secondSeed = await executeSyntheticSeed(env.apiPoolA, SYNTHETIC_DEMO_CENTER_A, {
      ...process.env,
      NODE_ENV: 'test',
      BOT_OUTBOUND_ENABLED: 'false',
    });
    assert.equal(secondSeed.insertedRowCount, 0);
    assert.equal(secondSeed.idempotentNoOp, true);
  });

  it('DB-IT-04: catalog drift check confirms 46 canonical tables, 25 mutable concurrency columns, 21 immutable tables without version, ON DELETE RESTRICT FKs, and 24 triggers', async () => {
    const inspection = await dbService.inspectSchemaCatalogDrift();
    assert.equal(inspection.totalTablesFound, CANONICAL_ALL_46_TABLES.length);
    assert.deepEqual(inspection.missingTables, []);
    assert.equal(inspection.mutableTablesWithConcurrencyColumn, CANONICAL_MUTABLE_TABLES.length);
    assert.deepEqual(inspection.immutableTablesWithForbiddenVersionColumn, []);
    assert.deepEqual(inspection.nonRestrictForeignKeys, []);
    assert.equal(inspection.immutabilityTriggersFound, CANONICAL_IMMUTABILITY_TRIGGERS.length);
    assert.deepEqual(inspection.missingTriggers, []);
    assert.equal(CANONICAL_MUTABLE_TABLES.length + CANONICAL_IMMUTABLE_TABLES.length, 46);
  });

  it('DB-IT-20: ephemeral test database environment isolates and cleans up only its own eduerp_test_* databases', async () => {
    const tempEnv = await createEphemeralTestDbEnv();
    const dbNameA = tempEnv.dbCenterA;
    assert.ok(dbNameA.startsWith('eduerp_test_'));

    const beforeDrop = await env.adminPool.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM pg_database WHERE datname = $1`,
      [dbNameA],
    );
    assert.equal(Number(beforeDrop.rows[0]?.cnt), 1);

    await tempEnv.cleanup();

    const afterDrop = await env.adminPool.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM pg_database WHERE datname = $1`,
      [dbNameA],
    );
    assert.equal(Number(afterDrop.rows[0]?.cnt), 0);
  });
});
