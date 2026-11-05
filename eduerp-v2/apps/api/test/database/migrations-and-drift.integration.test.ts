import * as assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import { URL } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { Pool } from 'pg';
import { loadApiEnv } from '../../src/config/env';
import {
  CANONICAL_ALL_46_TABLES,
  CANONICAL_IMMUTABILITY_TRIGGERS,
  CANONICAL_IMMUTABLE_TABLES,
  CANONICAL_LINEAGE_TRIGGERS,
  CANONICAL_MUTABLE_TABLES,
  DatabaseService,
} from '../../src/database/database.service';
import {
  executeSyntheticSeed,
  SYNTHETIC_DEMO_CENTER_A,
} from '../../src/database/seed-contract';
import {
  buildRoleUrl,
  createEphemeralTestDbEnv,
  EphemeralDatabaseEnvironment,
  resolveMigrationSqlPath,
  runPrismaMigrateDeploy,
} from './harness';

describe('PostgreSQL Migrations, Real PrismaClient ORM, Additive Upgrade & Drift Detection (DB-IT-01..04, DB-IT-20, F01, F02, F06, F07)', () => {
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

  it('DB-IT-01 & DB-IT-02 (F06): real Prisma CLI migrate deploy records checksum history, second run is idempotent no-op, and faulty migration rolls back atomically', async () => {
    const migRowsBefore = await env.apiPoolA.query<{
      migration_name: string;
      checksum: string;
      finished_at: Date | null;
      rolled_back_at: Date | null;
    }>(
      `SELECT "migration_name", "checksum", "finished_at", "rolled_back_at"
         FROM "_prisma_migrations"
        ORDER BY "migration_name" ASC`,
    );
    assert.equal(migRowsBefore.rows.length, 7);
    assert.equal(migRowsBefore.rows[0].migration_name, '20261104000100_initial_foundation');
    assert.equal(migRowsBefore.rows[1].migration_name, '20261104000200_s05_auth_and_rbac_foundation');
    assert.equal(migRowsBefore.rows[2].migration_name, '20261104000300_s06_auth_fixes_and_student_foundation');
    assert.equal(migRowsBefore.rows[3].migration_name, '20261104000400_s07_academics_schedule_substitutes_grades');
    assert.equal(migRowsBefore.rows[4].migration_name, '20261104000500_s08_billing_policy_cycles_trials_invoices');
    assert.equal(migRowsBefore.rows[5].migration_name, '20261105000600_s10_payments_allocations_reversals_receipts');
    assert.equal(migRowsBefore.rows[6].migration_name, '20261105000700_s11_cash_shifts_expenses_promises_reconciliation');
    for (const row of migRowsBefore.rows) {
      assert.equal(row.checksum.length, 64);
      assert.notEqual(row.finished_at, null);
      assert.equal(row.rolled_back_at, null);
    }

    // Second run via real Prisma CLI must be an idempotent no-op
    await runPrismaMigrateDeploy(env.migratorCenterAUrl);
    const migRowsAfter = await env.apiPoolA.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM "_prisma_migrations"`,
    );
    assert.equal(Number(migRowsAfter.rows[0]?.count), 7);

    // Fault injection: a migration batch that fails mid-script in a transaction leaves zero partial tables
    const client = await env.migratorPoolA.connect();
    try {
      await client.query('BEGIN');
      await client.query('CREATE TABLE "partial_fault_test_table" ("id" UUID PRIMARY KEY)');
      await assert.rejects(() => client.query('SELECT * FROM "non_existent_fault_table"'));
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    const partialCheck = await env.apiPoolA.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'partial_fault_test_table'`,
    );
    assert.equal(Number(partialCheck.rows[0]?.cnt), 0);
  });

  it('DB-IT-02-UPGRADE (F07): old S04 snapshot upgrades additively to S05 while preserving existing rows', async () => {
    const adminUrl = new URL(env.superuserCenterAUrl);
    const upgradeDb = `eduerp_test_upgrade_${env.runId}`;
    await env.adminPool.query(`CREATE DATABASE "${upgradeDb}" OWNER "${env.roleMigrator}"`);
    const upgradeMigratorUrl = buildRoleUrl(
      adminUrl,
      env.roleMigrator,
      `TestPass_${env.runId}_Safe!99`,
      upgradeDb,
    );
    const upgradePool = new Pool({ connectionString: upgradeMigratorUrl, max: 2 });

    try {
      const m1Sql = fs.readFileSync(resolveMigrationSqlPath('20261104000100_initial_foundation'), 'utf8');
      const m2Sql = fs.readFileSync(resolveMigrationSqlPath('20261104000200_s05_auth_and_rbac_foundation'), 'utf8');
      const m3Sql = fs.readFileSync(resolveMigrationSqlPath('20261104000300_s06_auth_fixes_and_student_foundation'), 'utf8');
      const m4Sql = fs.readFileSync(resolveMigrationSqlPath('20261104000400_s07_academics_schedule_substitutes_grades'), 'utf8');
      const m5Sql = fs.readFileSync(resolveMigrationSqlPath('20261104000500_s08_billing_policy_cycles_trials_invoices'), 'utf8');
      const m6Sql = fs.readFileSync(resolveMigrationSqlPath('20261105000600_s10_payments_allocations_reversals_receipts'), 'utf8');
      const m7Sql = fs.readFileSync(resolveMigrationSqlPath('20261105000700_s11_cash_shifts_expenses_promises_reconciliation'), 'utf8');

      // 1. Apply initial S04 foundation snapshot
      await upgradePool.query(m1Sql);

      // 2. Insert pre-upgrade rows into staff_users, staff_sessions, and students
      const staffId = crypto.randomUUID();
      const sessionId = crypto.randomUUID();
      const studentId = crypto.randomUUID();
      await upgradePool.query(
        `INSERT INTO "staff_users" ("id", "center_id", "role", "full_name", "login_username", "password_hash", "status")
         VALUES ($1::uuid, $2::uuid, 'DIRECTOR', 'Pre-Upgrade Director', 'pre.director', '$scrypt$v=1$n=16384,r=8,p=1$aaaaaaaaaaaaaaaaaaaaaa$bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'ACTIVE')`,
        [staffId, SYNTHETIC_DEMO_CENTER_A.centerId],
      );
      await upgradePool.query(
        `INSERT INTO "staff_sessions" ("id", "center_id", "staff_id", "refresh_token_hash", "role_snapshot", "expires_at")
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'DIRECTOR', NOW() + INTERVAL '7 days')`,
        [sessionId, SYNTHETIC_DEMO_CENTER_A.centerId, staffId, 'c'.repeat(64)],
      );
      await upgradePool.query(
        `INSERT INTO "students" ("id", "center_id", "student_code", "full_name", "normalized_name", "status")
         VALUES ($1::uuid, $2::uuid, 'STU-UPG-1', 'Pre-Upgrade Student', 'pre-upgrade student', 'ACTIVE')`,
        [studentId, SYNTHETIC_DEMO_CENTER_A.centerId],
      );

      // 3. Apply additive S05 and S06 migrations
      await upgradePool.query(m2Sql);
      await upgradePool.query(m3Sql);
      await upgradePool.query(m4Sql);
      await upgradePool.query(m5Sql);
      await upgradePool.query(m6Sql);
      await upgradePool.query(m7Sql);

      // 4. Verify pre-existing rows are intact and have valid S05 default columns
      const checkSession = await upgradePool.query<{
        id: string;
        family_id: string;
        transport_mode: string;
        staff_version_snapshot: number;
      }>(
        `SELECT "id"::text AS id, "family_id"::text AS family_id, "transport_mode", "staff_version_snapshot"
           FROM "staff_sessions" WHERE "id" = $1::uuid`,
        [sessionId],
      );
      assert.equal(checkSession.rows.length, 1);
      assert.equal(checkSession.rows[0].transport_mode, 'BEARER');
      assert.equal(checkSession.rows[0].staff_version_snapshot, 1);
      assert.ok(checkSession.rows[0].family_id.length === 36);

      const checkStudent = await upgradePool.query<{ full_name: string }>(
        `SELECT "full_name" FROM "students" WHERE "id" = $1::uuid`,
        [studentId],
      );
      assert.equal(checkStudent.rows[0]?.full_name, 'Pre-Upgrade Student');
    } finally {
      await upgradePool.end();
      await env.adminPool.query(`DROP DATABASE IF EXISTS "${upgradeDb}"`);
    }
  });

  it('DB-IT-03 & F01/F02: synthetic seed is idempotent and real generated PrismaClient executes create, findUnique, and $transaction queries', async () => {
    const firstSeed = await executeSyntheticSeed(env.apiPoolA, SYNTHETIC_DEMO_CENTER_A, {
      ...process.env,
      NODE_ENV: 'test',
      BOT_OUTBOUND_ENABLED: 'false',
    });
    assert.ok(firstSeed.insertedRowCount >= 11);
    assert.equal(firstSeed.idempotentNoOp, false);

    const secondSeed = await executeSyntheticSeed(env.apiPoolA, SYNTHETIC_DEMO_CENTER_A, {
      ...process.env,
      NODE_ENV: 'test',
      BOT_OUTBOUND_ENABLED: 'false',
    });
    assert.equal(secondSeed.insertedRowCount, 0);
    assert.equal(secondSeed.idempotentNoOp, true);

    // F01 & F02: Verify real generated PrismaClient + PrismaPg adapter roundtrip and $transaction
    const prisma = dbService.getPrismaClient();
    const ormCourseId = crypto.randomUUID();
    const createdCourse = await prisma.$transaction(async (tx) => {
      return tx.course.create({
        data: {
          id: ormCourseId,
          centerId: SYNTHETIC_DEMO_CENTER_A.centerId,
          name: 'Prisma 7 Real ORM Physics Course',
          defaultMonthlyFeeUzs: 520000n,
          defaultLessonsPerCycle: 12,
          status: 'ACTIVE',
        },
      });
    });
    assert.equal(createdCourse.id, ormCourseId);
    assert.equal(createdCourse.defaultMonthlyFeeUzs, 520000n);

    const fetchedCourse = await prisma.course.findUnique({
      where: { id: ormCourseId },
    });
    assert.ok(fetchedCourse);
    assert.equal(fetchedCourse.name, 'Prisma 7 Real ORM Physics Course');
    assert.equal(fetchedCourse.defaultMonthlyFeeUzs, 520000n);
  });

  it('DB-IT-04 (F07): catalog drift check verifies healthy 46-table/24+11-trigger schema and actively detects disabled triggers or dropped constraints', async () => {
    const healthy = await dbService.inspectSchemaCatalogDrift();
    assert.equal(healthy.totalTablesFound, CANONICAL_ALL_46_TABLES.length);
    assert.deepEqual(healthy.missingTables, []);
    assert.equal(healthy.mutableTablesWithConcurrencyColumn, CANONICAL_MUTABLE_TABLES.length);
    assert.deepEqual(healthy.immutableTablesWithForbiddenVersionColumn, []);
    assert.deepEqual(healthy.nonRestrictForeignKeys, []);
    assert.equal(healthy.immutabilityTriggersFound, CANONICAL_IMMUTABILITY_TRIGGERS.length);
    assert.deepEqual(healthy.missingTriggers, []);
    assert.deepEqual(healthy.disabledTriggers, []);
    assert.deepEqual(healthy.missingLineageTriggers, []);
    assert.deepEqual(healthy.missingCheckConstraints, []);
    assert.deepEqual(healthy.missingPartialUniqueIndexes, []);
    assert.equal(CANONICAL_MUTABLE_TABLES.length + CANONICAL_IMMUTABLE_TABLES.length, 46);
    assert.equal(CANONICAL_LINEAGE_TRIGGERS.length, 11);

    // F07 Negative mutation proof: disable trg_immutable_payments and prove drift + readiness detect it!
    await env.migratorPoolA.query(`ALTER TABLE "payments" DISABLE TRIGGER "trg_immutable_payments"`);
    try {
      const mutatedDrift = await dbService.inspectSchemaCatalogDrift();
      assert.ok(mutatedDrift.disabledTriggers.includes('trg_immutable_payments'));
      assert.ok(mutatedDrift.missingTriggers.includes('trg_immutable_payments'));

      const mutatedReadiness = await dbService.checkReadiness();
      assert.equal(mutatedReadiness.ready, false);
      assert.equal(mutatedReadiness.error_code, 'DATABASE_SCHEMA_INCOMPLETE');
    } finally {
      await env.migratorPoolA.query(`ALTER TABLE "payments" ENABLE TRIGGER "trg_immutable_payments"`);
    }

    const restoredReadiness = await dbService.checkReadiness();
    assert.equal(restoredReadiness.ready, true);
  });

  it('DB-IT-20 (F05): ephemeral test database environment isolates and cleans up only its own eduerp_test_* databases and roles', async () => {
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

  it('DB-IT-21 (O03): upgrades populated 6-migration predecessor database with duplicate ACTIVE promises on the same invoice and proves idempotent re-execution of migration 000700', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const crypto = await import('node:crypto');
    const { Pool } = await import('pg');

    const migrationsRoot = path.dirname(path.dirname(resolveMigrationSqlPath()));
    const allMigrationDirs = fs
      .readdirSync(migrationsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    assert.equal(allMigrationDirs.length, 8);

    const predecessorDirs = allMigrationDirs.slice(0, 6);
    const s11Dir = allMigrationDirs[6];
    assert.ok(s11Dir.includes('000700_s11_cash_shifts_expenses_promises_reconciliation'));

    const upgDbName = `eduerp_test_upg07_${crypto.randomBytes(4).toString('hex')}`;
    await env.adminPool.query(`CREATE DATABASE ${upgDbName}`);
    const upgUrl = new URL(env.superuserCenterAUrl);
    upgUrl.pathname = `/${upgDbName}`;
    const upgPool = new Pool({ connectionString: upgUrl.toString(), max: 4 });

    try {
      for (const dir of predecessorDirs) {
        const sql = fs.readFileSync(path.join(migrationsRoot, dir, 'migration.sql'), 'utf8');
        await upgPool.query(sql);
      }

      await executeSyntheticSeed(upgPool, SYNTHETIC_DEMO_CENTER_A, {
        ...process.env,
        NODE_ENV: 'test',
        BOT_OUTBOUND_ENABLED: 'false',
      });

      const enrollmentId = crypto.randomUUID();
      const cycleId = crypto.randomUUID();
      const invoiceId = crypto.randomUUID();
      const shiftId = crypto.randomUUID();
      const payment1Id = crypto.randomUUID();
      const payment2Id = crypto.randomUUID();
      const olderPromiseId = crypto.randomUUID();
      const newerPromiseId = crypto.randomUUID();

      await upgPool.query(
        `INSERT INTO "enrollments" ("id", "center_id", "student_id", "group_id", "status", "enrolled_at_date")
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'ACTIVE', '2026-11-01')`,
        [
          enrollmentId,
          SYNTHETIC_DEMO_CENTER_A.centerId,
          SYNTHETIC_DEMO_CENTER_A.studentId,
          SYNTHETIC_DEMO_CENTER_A.groupId,
        ],
      );

      await upgPool.query(
        `INSERT INTO "billing_cycles" (
           "id", "center_id", "enrollment_id", "cycle_type", "cycle_key", "cycle_seq",
           "period_start_date", "period_end_date", "planned_lessons", "billable_lessons", "policy_version_id"
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, 'CALENDAR_MONTH', '2026-11', 1,
           '2026-11-01', '2026-11-30', 12, 12, $4::uuid
         )`,
        [
          cycleId,
          SYNTHETIC_DEMO_CENTER_A.centerId,
          enrollmentId,
          SYNTHETIC_DEMO_CENTER_A.billingPolicyId,
        ],
      );

      await upgPool.query(
        `INSERT INTO "invoices" (
           "id", "center_id", "invoice_number", "student_id", "enrollment_id",
           "billing_cycle_id", "policy_version_id", "tariff_snapshot_uzs",
           "base_pro_rata_charge_uzs", "approved_discount_uzs", "credit_note_adjustments_uzs",
           "effective_net_charge_uzs", "allocated_paid_uzs", "remaining_debt_uzs",
           "billed_lessons", "status", "due_date", "version"
         ) VALUES (
           $1::uuid, $2::uuid, 'INV-UPG-000700', $3::uuid, $4::uuid,
           $5::uuid, $6::uuid, 500000,
           500000, 0, 0,
           500000, 200000, 300000,
           12, 'PARTIALLY_PAID', '2026-11-10', 1
         )`,
        [
          invoiceId,
          SYNTHETIC_DEMO_CENTER_A.centerId,
          SYNTHETIC_DEMO_CENTER_A.studentId,
          enrollmentId,
          cycleId,
          SYNTHETIC_DEMO_CENTER_A.billingPolicyId,
        ],
      );

      await upgPool.query(
        `INSERT INTO "cash_shifts" (
           "id", "center_id", "shift_date", "opened_by_admin_id",
           "opening_cash_uzs", "cash_receipts_uzs", "expected_closing_cash_uzs", "status", "version"
         ) VALUES ($1::uuid, $2::uuid, '2026-11-05', $3::uuid, 0, 200000, 200000, 'OPEN', 1)`,
        [shiftId, SYNTHETIC_DEMO_CENTER_A.centerId, SYNTHETIC_DEMO_CENTER_A.adminId],
      );

      await upgPool.query(
        `INSERT INTO "payments" (
           "id", "center_id", "student_id", "cash_shift_id", "amount_uzs",
           "currency", "payment_method", "recorded_by_admin_id", "idempotency_key", "request_hash"
         ) VALUES
         ($1::uuid, $3::uuid, $4::uuid, $5::uuid, 100000, 'UZS', 'CASH', $6::uuid, 'idem-upg-pay-1', repeat('a',64)),
         ($2::uuid, $3::uuid, $4::uuid, $5::uuid, 100000, 'UZS', 'CASH', $6::uuid, 'idem-upg-pay-2', repeat('b',64))`,
        [
          payment1Id,
          payment2Id,
          SYNTHETIC_DEMO_CENTER_A.centerId,
          SYNTHETIC_DEMO_CENTER_A.studentId,
          shiftId,
          SYNTHETIC_DEMO_CENTER_A.adminId,
        ],
      );

      // In 6-migration predecessor schema, idx_promises_active_invoice did not exist yet
      await upgPool.query(
        `INSERT INTO "promises_to_pay" (
           "id", "center_id", "student_id", "invoice_id", "trigger_payment_id",
           "promised_amount_uzs", "promise_date", "status", "version", "created_at", "updated_at"
         ) VALUES
         ($1::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, 400000, '2026-11-12', 'ACTIVE', 1, '2026-11-05T07:00:00Z', '2026-11-05T07:00:00Z'),
         ($2::uuid, $3::uuid, $4::uuid, $5::uuid, $7::uuid, 300000, '2026-11-15', 'ACTIVE', 1, '2026-11-05T08:00:00Z', '2026-11-05T08:00:00Z')`,
        [
          olderPromiseId,
          newerPromiseId,
          SYNTHETIC_DEMO_CENTER_A.centerId,
          SYNTHETIC_DEMO_CENTER_A.studentId,
          invoiceId,
          payment1Id,
          payment2Id,
        ],
      );

      // Baseline the six scripts actually applied above through Prisma's own CLI.
      // Never fabricate _prisma_migrations rows or checksums.
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const runCli = promisify(execFile);
      const apiRoot = path.resolve(migrationsRoot, '../..');
      const prismaCli = require.resolve('prisma/build/index.js', { paths: [apiRoot] });
      for (const dir of predecessorDirs) {
        await runCli(process.execPath, [prismaCli, 'migrate', 'resolve', '--applied', dir,
          '--config', 'prisma.config.ts'], {
          cwd: apiRoot, timeout: 60000,
          env: { ...process.env, MIGRATION_DATABASE_URL: upgUrl.toString(), DATABASE_URL: upgUrl.toString() },
        });
      }
      await runPrismaMigrateDeploy(upgUrl.toString());
      await runPrismaMigrateDeploy(upgUrl.toString());
      const migrationHistory = await upgPool.query<{ migration_name: string }>(
        'SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name');
      assert.deepEqual(migrationHistory.rows.map(row => row.migration_name), allMigrationDirs);

      const promisesAfter = await upgPool.query<{
        id: string;
        status: string;
        cancel_reason: string | null;
        superseded_by_promise_id: string | null;
      }>(
        `SELECT "id"::text AS id, "status"::text AS status, "cancel_reason", "superseded_by_promise_id"::text AS superseded_by_promise_id
           FROM "promises_to_pay"
          WHERE "invoice_id" = $1::uuid
          ORDER BY "created_at" ASC`,
        [invoiceId],
      );
      assert.equal(promisesAfter.rows.length, 2);
      assert.equal(promisesAfter.rows[0].id, olderPromiseId);
      assert.equal(promisesAfter.rows[0].status, 'CANCELLED');
      assert.equal(
        promisesAfter.rows[0].cancel_reason,
        'SUPERSEDED_BY_NEW_PARTIAL_PAYMENT_PROMISE',
      );
      assert.equal(promisesAfter.rows[0].superseded_by_promise_id, newerPromiseId);

      assert.equal(promisesAfter.rows[1].id, newerPromiseId);
      assert.equal(promisesAfter.rows[1].status, 'ACTIVE');
    } finally {
      await upgPool.end();
      await env.adminPool.query(`DROP DATABASE IF EXISTS ${upgDbName} WITH (FORCE)`);
    }
  });
});
