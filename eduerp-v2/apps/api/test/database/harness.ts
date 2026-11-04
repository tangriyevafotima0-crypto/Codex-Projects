import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { URL } from 'node:url';
import { Pool } from 'pg';

export interface EphemeralDatabaseEnvironment {
  readonly runId: string;
  readonly dbCenterA: string;
  readonly dbCenterB: string;
  readonly roleMigrator: string;
  readonly roleApiRuntime: string;
  readonly roleWorkerRuntime: string;
  readonly roleReadonly: string;
  readonly roleCenterBApi: string;
  readonly superuserCenterAUrl: string;
  readonly migratorCenterAUrl: string;
  readonly migratorCenterBUrl: string;
  readonly apiRuntimeCenterAUrl: string;
  readonly workerRuntimeCenterAUrl: string;
  readonly readonlyCenterAUrl: string;
  readonly apiRuntimeCenterBUrl: string;
  readonly crossCenterForbiddenAtoBUrl: string;
  readonly crossCenterForbiddenBtoAUrl: string;
  readonly adminPool: Pool;
  readonly migratorPoolA: Pool;
  readonly apiPoolA: Pool;
  readonly workerPoolA: Pool;
  readonly readonlyPoolA: Pool;
  readonly apiPoolB: Pool;
  cleanup(): Promise<void>;
}

export class UnsafeTestDatabaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeTestDatabaseError';
  }
}

export function assertSafeTestDatabaseUrl(
  rawUrl: string | undefined,
  rawEnv: NodeJS.ProcessEnv = process.env,
): { parsedUrl: URL; dbName: string } {
  if (rawEnv.EDUERP_ALLOW_DESTRUCTIVE_DB_TESTS !== 'true') {
    throw new UnsafeTestDatabaseError(
      'Refusing to run destructive PostgreSQL integration tests without EDUERP_ALLOW_DESTRUCTIVE_DB_TESTS=true (DB-IT-17)',
    );
  }
  if (!rawUrl || rawUrl.trim().length === 0) {
    throw new UnsafeTestDatabaseError(
      'TEST_DATABASE_ADMIN_URL or DATABASE_URL is required for PostgreSQL integration tests (DB-IT-17)',
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new UnsafeTestDatabaseError('Invalid PostgreSQL URL provided to test harness (DB-IT-17)');
  }
  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    throw new UnsafeTestDatabaseError('Test database URL must use postgresql:// or postgres:// protocol (DB-IT-17)');
  }
  const dbName = parsed.pathname.replace(/^\//, '').trim();
  if (!dbName.startsWith('eduerp_test_')) {
    throw new UnsafeTestDatabaseError(
      `Refusing to run destructive DB tests against non-test database '${dbName}'; database name must start with 'eduerp_test_' (DB-IT-17)`,
    );
  }
  return { parsedUrl: parsed, dbName };
}

function buildRoleUrl(baseAdminUrl: URL, username: string, password: string, dbName: string): string {
  const copy = new URL(baseAdminUrl.toString());
  copy.username = username;
  copy.password = password;
  copy.pathname = `/${dbName}`;
  return copy.toString();
}

export function resolveMigrationSqlPath(): string {
  const candidate = path.resolve(
    __dirname,
    '../../prisma/migrations/20261104000100_initial_foundation/migration.sql',
  );
  if (fs.existsSync(candidate)) {
    return candidate;
  }
  return path.resolve(
    process.cwd(),
    'apps/api/prisma/migrations/20261104000100_initial_foundation/migration.sql',
  );
}

export async function applyInitialMigrationSql(pool: Pool): Promise<{ applied: boolean }> {
  const sqlPath = resolveMigrationSqlPath();
  const migrationSql = fs.readFileSync(sqlPath, 'utf8');
  const checksum = crypto.createHash('sha256').update(migrationSql, 'utf8').digest('hex');
  const migrationName = '20261104000100_initial_foundation';

  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
        "id" VARCHAR(36) PRIMARY KEY NOT NULL,
        "checksum" VARCHAR(64) NOT NULL,
        "finished_at" TIMESTAMPTZ,
        "migration_name" VARCHAR(255) NOT NULL,
        "logs" TEXT,
        "rolled_back_at" TIMESTAMPTZ,
        "started_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "applied_steps_count" INTEGER NOT NULL DEFAULT 0
      )
    `);

    const existing = await client.query<{ id: string }>(
      `SELECT "id" FROM "_prisma_migrations" WHERE "migration_name" = $1 AND "finished_at" IS NOT NULL LIMIT 1`,
      [migrationName],
    );
    if (existing.rowCount && existing.rowCount > 0) {
      return { applied: false };
    }

    await client.query('BEGIN');
    await client.query(migrationSql);
    await client.query(
      `INSERT INTO "_prisma_migrations" (
         "id", "checksum", "finished_at", "migration_name", "applied_steps_count"
       ) VALUES ($1, $2, NOW(), $3, 1)`,
      [crypto.randomUUID(), checksum, migrationName],
    );
    await client.query('COMMIT');
    return { applied: true };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function applyRuntimeGrantsForTestDb(
  adminPoolForDb: Pool,
  roles: {
    migrator: string;
    apiRuntime: string;
    workerRuntime: string;
    readonlyRole: string;
  },
): Promise<void> {
  const { migrator, apiRuntime, workerRuntime, readonlyRole } = roles;
  await adminPoolForDb.query(
    `SELECT eduerp_apply_role_grants($1, $2, $3)`,
    [apiRuntime, workerRuntime, readonlyRole],
  );
  await adminPoolForDb.query(`
    REVOKE CREATE ON SCHEMA public FROM PUBLIC, "${apiRuntime}", "${workerRuntime}", "${readonlyRole}";
    GRANT USAGE, CREATE ON SCHEMA public TO "${migrator}";
    GRANT SELECT ON TABLE "_prisma_migrations" TO "${apiRuntime}", "${workerRuntime}", "${readonlyRole}";
  `);
}

export async function createEphemeralTestDbEnv(
  rawEnv: NodeJS.ProcessEnv = process.env,
): Promise<EphemeralDatabaseEnvironment> {
  const rawAdminUrl = rawEnv.TEST_DATABASE_ADMIN_URL ?? rawEnv.DATABASE_URL;
  const { parsedUrl } = assertSafeTestDatabaseUrl(rawAdminUrl, rawEnv);

  const runId = crypto.randomBytes(4).toString('hex');
  const dbCenterA = `eduerp_test_center_a_${runId}`;
  const dbCenterB = `eduerp_test_center_b_${runId}`;
  const roleMigrator = `eduerp_test_migrator_${runId}`;
  const roleApiRuntime = `eduerp_test_api_${runId}`;
  const roleWorkerRuntime = `eduerp_test_worker_${runId}`;
  const roleReadonly = `eduerp_test_ro_${runId}`;
  const roleCenterBApi = `eduerp_test_center_b_api_${runId}`;
  const rolePass = `TestPass_${runId}_Safe!99`;

  const adminPool = new Pool({
    connectionString: parsedUrl.toString(),
    max: 4,
  });

  await adminPool.query(`CREATE ROLE "${roleMigrator}" LOGIN PASSWORD '${rolePass}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
  await adminPool.query(`CREATE ROLE "${roleApiRuntime}" LOGIN PASSWORD '${rolePass}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
  await adminPool.query(`CREATE ROLE "${roleWorkerRuntime}" LOGIN PASSWORD '${rolePass}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
  await adminPool.query(`CREATE ROLE "${roleReadonly}" LOGIN PASSWORD '${rolePass}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
  await adminPool.query(`CREATE ROLE "${roleCenterBApi}" LOGIN PASSWORD '${rolePass}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);

  await adminPool.query(`CREATE DATABASE "${dbCenterA}" OWNER "${roleMigrator}"`);
  await adminPool.query(`CREATE DATABASE "${dbCenterB}" OWNER "${roleMigrator}"`);

  await adminPool.query(`REVOKE CONNECT ON DATABASE "${dbCenterA}" FROM PUBLIC`);
  await adminPool.query(`REVOKE CONNECT ON DATABASE "${dbCenterB}" FROM PUBLIC`);
  await adminPool.query(`GRANT CONNECT, TEMP ON DATABASE "${dbCenterA}" TO "${roleMigrator}"`);
  await adminPool.query(`GRANT CONNECT ON DATABASE "${dbCenterA}" TO "${roleApiRuntime}", "${roleWorkerRuntime}", "${roleReadonly}"`);
  await adminPool.query(`GRANT CONNECT, TEMP ON DATABASE "${dbCenterB}" TO "${roleMigrator}"`);
  await adminPool.query(`GRANT CONNECT ON DATABASE "${dbCenterB}" TO "${roleCenterBApi}"`);

  const superuserCenterAUrl = buildRoleUrl(
    parsedUrl,
    decodeURIComponent(parsedUrl.username),
    decodeURIComponent(parsedUrl.password),
    dbCenterA,
  );
  const superuserCenterBUrl = buildRoleUrl(
    parsedUrl,
    decodeURIComponent(parsedUrl.username),
    decodeURIComponent(parsedUrl.password),
    dbCenterB,
  );

  const migratorCenterAUrl = buildRoleUrl(parsedUrl, roleMigrator, rolePass, dbCenterA);
  const migratorCenterBUrl = buildRoleUrl(parsedUrl, roleMigrator, rolePass, dbCenterB);
  const apiRuntimeCenterAUrl = buildRoleUrl(parsedUrl, roleApiRuntime, rolePass, dbCenterA);
  const workerRuntimeCenterAUrl = buildRoleUrl(parsedUrl, roleWorkerRuntime, rolePass, dbCenterA);
  const readonlyCenterAUrl = buildRoleUrl(parsedUrl, roleReadonly, rolePass, dbCenterA);
  const apiRuntimeCenterBUrl = buildRoleUrl(parsedUrl, roleCenterBApi, rolePass, dbCenterB);

  const crossCenterForbiddenAtoBUrl = buildRoleUrl(parsedUrl, roleApiRuntime, rolePass, dbCenterB);
  const crossCenterForbiddenBtoAUrl = buildRoleUrl(parsedUrl, roleCenterBApi, rolePass, dbCenterA);

  const superPoolA = new Pool({ connectionString: superuserCenterAUrl, max: 2 });
  const superPoolB = new Pool({ connectionString: superuserCenterBUrl, max: 2 });

  const migratorPoolA = new Pool({ connectionString: migratorCenterAUrl, max: 4 });
  const migratorPoolB = new Pool({ connectionString: migratorCenterBUrl, max: 2 });

  try {
    await superPoolA.query(`GRANT USAGE, CREATE ON SCHEMA public TO "${roleMigrator}"`);
    await superPoolB.query(`GRANT USAGE, CREATE ON SCHEMA public TO "${roleMigrator}"`);

    await applyInitialMigrationSql(migratorPoolA);
    await applyInitialMigrationSql(migratorPoolB);

    await applyRuntimeGrantsForTestDb(superPoolA, {
      migrator: roleMigrator,
      apiRuntime: roleApiRuntime,
      workerRuntime: roleWorkerRuntime,
      readonlyRole: roleReadonly,
    });
    await applyRuntimeGrantsForTestDb(superPoolB, {
      migrator: roleMigrator,
      apiRuntime: roleCenterBApi,
      workerRuntime: roleCenterBApi,
      readonlyRole: roleCenterBApi,
    });
  } finally {
    await superPoolA.end();
    await superPoolB.end();
    await migratorPoolB.end();
  }

  const apiPoolA = new Pool({ connectionString: apiRuntimeCenterAUrl, max: 8 });
  const workerPoolA = new Pool({ connectionString: workerRuntimeCenterAUrl, max: 4 });
  const readonlyPoolA = new Pool({ connectionString: readonlyCenterAUrl, max: 2 });
  const apiPoolB = new Pool({ connectionString: apiRuntimeCenterBUrl, max: 4 });

  let cleanedUp = false;
  const cleanup = async (): Promise<void> => {
    if (cleanedUp) return;
    cleanedUp = true;
    await Promise.allSettled([
      migratorPoolA.end(),
      apiPoolA.end(),
      workerPoolA.end(),
      readonlyPoolA.end(),
      apiPoolB.end(),
    ]);
    try {
      await adminPool.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname IN ($1, $2) AND pid <> pg_backend_pid()`,
        [dbCenterA, dbCenterB],
      );
      await adminPool.query(`DROP DATABASE IF EXISTS "${dbCenterA}"`);
      await adminPool.query(`DROP DATABASE IF EXISTS "${dbCenterB}"`);
      await adminPool.query(`DROP ROLE IF EXISTS "${roleApiRuntime}", "${roleWorkerRuntime}", "${roleReadonly}", "${roleCenterBApi}", "${roleMigrator}"`);
    } finally {
      await adminPool.end();
    }
  };

  return {
    runId,
    dbCenterA,
    dbCenterB,
    roleMigrator,
    roleApiRuntime,
    roleWorkerRuntime,
    roleReadonly,
    roleCenterBApi,
    superuserCenterAUrl,
    migratorCenterAUrl,
    migratorCenterBUrl,
    apiRuntimeCenterAUrl,
    workerRuntimeCenterAUrl,
    readonlyCenterAUrl,
    apiRuntimeCenterBUrl,
    crossCenterForbiddenAtoBUrl,
    crossCenterForbiddenBtoAUrl,
    adminPool,
    migratorPoolA,
    apiPoolA,
    workerPoolA,
    readonlyPoolA,
    apiPoolB,
    cleanup,
  };
}
