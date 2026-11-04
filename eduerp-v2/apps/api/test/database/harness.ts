import { execFile } from 'node:child_process';
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
  readonly roleCenterBWorker: string;
  readonly roleCenterBReadonly: string;
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

const APPROVED_TEST_DB_HOSTS: ReadonlySet<string> = new Set([
  '127.0.0.1',
  'localhost',
  '::1',
  '[::1]',
  'postgres',
  'postgres-test',
]);

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
  const hostname = parsed.hostname.toLowerCase();
  const customApprovedHost = rawEnv.EDUERP_APPROVED_TEST_DB_HOST?.trim().toLowerCase();
  if (!APPROVED_TEST_DB_HOSTS.has(hostname) && (!customApprovedHost || hostname !== customApprovedHost)) {
    throw new UnsafeTestDatabaseError(
      `Refusing to run destructive DB tests against untrusted host '${hostname}'; only local/CI test hosts are allowed (DB-IT-17)`,
    );
  }
  const dbName = parsed.pathname.replace(/^\//, '').trim();
  if (!dbName.startsWith('eduerp_test_')) {
    throw new UnsafeTestDatabaseError(
      `Refusing to run destructive DB tests against non-test database '${dbName}'; database name must start with 'eduerp_test_' (DB-IT-17)`,
    );
  }
  return { parsedUrl: parsed, dbName };
}

export function buildRoleUrl(baseAdminUrl: URL, username: string, password: string, dbName: string): string {
  const copy = new URL(baseAdminUrl.toString());
  copy.username = username;
  copy.password = password;
  copy.pathname = `/${dbName}`;
  return copy.toString();
}

/**
 * F05: Resolves `<repo>/eduerp-v2/apps/api` deterministically whether invoked from
 * monorepo root (`eduerp-v2`), workspace root (`apps/api`), source (`apps/api/test/database`),
 * or compiled dist (`apps/api/dist/test/database`).
 */
export function resolveApiWorkspaceRoot(): string {
  const candidates = [
    path.resolve(__dirname, '../../..'),
    path.resolve(__dirname, '../..'),
    process.cwd(),
    path.resolve(process.cwd(), 'apps/api'),
  ];
  for (const dir of candidates) {
    if (
      fs.existsSync(path.join(dir, 'prisma', 'schema.prisma')) &&
      fs.existsSync(path.join(dir, 'prisma.config.ts'))
    ) {
      return dir;
    }
  }
  throw new Error(
    `Unable to locate apps/api workspace root containing prisma/schema.prisma (from __dirname=${__dirname}, cwd=${process.cwd()})`,
  );
}

export function resolveMigrationSqlPath(
  migrationFolder: string = '20261104000100_initial_foundation',
): string {
  const apiRoot = resolveApiWorkspaceRoot();
  const sqlPath = path.join(apiRoot, 'prisma', 'migrations', migrationFolder, 'migration.sql');
  if (!fs.existsSync(sqlPath)) {
    throw new Error(`Migration SQL file not found at ${sqlPath}`);
  }
  return sqlPath;
}

function resolvePrismaCliEntry(apiRoot: string): string {
  const searchPaths = [apiRoot, path.resolve(apiRoot, '../..')];
  return require.resolve('prisma/build/index.js', { paths: searchPaths });
}

/**
 * F06: Canonical migration deployment using the real Prisma 7 CLI (`prisma migrate deploy --config prisma.config.ts`).
 * Manages `_prisma_migrations` checksums and history exclusively via Prisma CLI without manual table fabrication.
 */
export async function runPrismaMigrateDeploy(
  migrationDatabaseUrl: string,
): Promise<{ stdout: string; stderr: string }> {
  const apiRoot = resolveApiWorkspaceRoot();
  const prismaCli = resolvePrismaCliEntry(apiRoot);

  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [prismaCli, 'migrate', 'deploy', '--config', 'prisma.config.ts'],
      {
        cwd: apiRoot,
        env: {
          ...process.env,
          MIGRATION_DATABASE_URL: migrationDatabaseUrl,
          DATABASE_URL: migrationDatabaseUrl,
        },
        timeout: 60000,
      },
      (err, stdout, stderr) => {
        if (err) {
          reject(
            new Error(
              `prisma migrate deploy failed: ${err.message}\nSTDOUT: ${stdout}\nSTDERR: ${stderr}`,
            ),
          );
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
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
  const roleCenterBApi = `eduerp_test_cb_api_${runId}`;
  const roleCenterBWorker = `eduerp_test_cb_worker_${runId}`;
  const roleCenterBReadonly = `eduerp_test_cb_ro_${runId}`;
  const rolePass = `TestPass_${runId}_Safe!99`;

  const adminPool = new Pool({
    connectionString: parsedUrl.toString(),
    max: 4,
  });

  let superPoolA: Pool | null = null;
  let superPoolB: Pool | null = null;
  let migratorPoolA: Pool | null = null;
  let apiPoolA: Pool | null = null;
  let workerPoolA: Pool | null = null;
  let readonlyPoolA: Pool | null = null;
  let apiPoolB: Pool | null = null;

  let cleanedUp = false;
  const cleanup = async (): Promise<void> => {
    if (cleanedUp) return;
    cleanedUp = true;
    await Promise.allSettled([
      superPoolA?.end(),
      superPoolB?.end(),
      migratorPoolA?.end(),
      apiPoolA?.end(),
      workerPoolA?.end(),
      readonlyPoolA?.end(),
      apiPoolB?.end(),
    ]);
    try {
      await adminPool.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname IN ($1, $2) AND pid <> pg_backend_pid()`,
        [dbCenterA, dbCenterB],
      );
      await adminPool.query(`DROP DATABASE IF EXISTS "${dbCenterA}"`);
      await adminPool.query(`DROP DATABASE IF EXISTS "${dbCenterB}"`);
      await adminPool.query(
        `DROP ROLE IF EXISTS "${roleApiRuntime}", "${roleWorkerRuntime}", "${roleReadonly}", "${roleCenterBApi}", "${roleCenterBWorker}", "${roleCenterBReadonly}", "${roleMigrator}"`,
      );
    } finally {
      await adminPool.end();
    }
  };

  try {
    await adminPool.query(`CREATE ROLE "${roleMigrator}" LOGIN PASSWORD '${rolePass}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
    await adminPool.query(`CREATE ROLE "${roleApiRuntime}" LOGIN PASSWORD '${rolePass}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
    await adminPool.query(`CREATE ROLE "${roleWorkerRuntime}" LOGIN PASSWORD '${rolePass}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
    await adminPool.query(`CREATE ROLE "${roleReadonly}" LOGIN PASSWORD '${rolePass}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
    await adminPool.query(`CREATE ROLE "${roleCenterBApi}" LOGIN PASSWORD '${rolePass}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
    await adminPool.query(`CREATE ROLE "${roleCenterBWorker}" LOGIN PASSWORD '${rolePass}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
    await adminPool.query(`CREATE ROLE "${roleCenterBReadonly}" LOGIN PASSWORD '${rolePass}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);

    await adminPool.query(`CREATE DATABASE "${dbCenterA}" OWNER "${roleMigrator}"`);
    await adminPool.query(`CREATE DATABASE "${dbCenterB}" OWNER "${roleMigrator}"`);

    await adminPool.query(`REVOKE CONNECT ON DATABASE "${dbCenterA}" FROM PUBLIC`);
    await adminPool.query(`REVOKE CONNECT ON DATABASE "${dbCenterB}" FROM PUBLIC`);
    await adminPool.query(`GRANT CONNECT, TEMP ON DATABASE "${dbCenterA}" TO "${roleMigrator}"`);
    await adminPool.query(`GRANT CONNECT ON DATABASE "${dbCenterA}" TO "${roleApiRuntime}", "${roleWorkerRuntime}", "${roleReadonly}"`);
    await adminPool.query(`GRANT CONNECT, TEMP ON DATABASE "${dbCenterB}" TO "${roleMigrator}"`);
    await adminPool.query(`GRANT CONNECT ON DATABASE "${dbCenterB}" TO "${roleCenterBApi}", "${roleCenterBWorker}", "${roleCenterBReadonly}"`);

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

    superPoolA = new Pool({ connectionString: superuserCenterAUrl, max: 2 });
    superPoolB = new Pool({ connectionString: superuserCenterBUrl, max: 2 });

    await superPoolA.query(`GRANT USAGE, CREATE ON SCHEMA public TO "${roleMigrator}"`);
    await superPoolB.query(`GRANT USAGE, CREATE ON SCHEMA public TO "${roleMigrator}"`);

    // F06: Apply migrations using the real Prisma CLI (`prisma migrate deploy`)
    await runPrismaMigrateDeploy(migratorCenterAUrl);
    await runPrismaMigrateDeploy(migratorCenterBUrl);

    // F05: Apply distinct role grants on Center A and Center B
    await applyRuntimeGrantsForTestDb(superPoolA, {
      migrator: roleMigrator,
      apiRuntime: roleApiRuntime,
      workerRuntime: roleWorkerRuntime,
      readonlyRole: roleReadonly,
    });
    await applyRuntimeGrantsForTestDb(superPoolB, {
      migrator: roleMigrator,
      apiRuntime: roleCenterBApi,
      workerRuntime: roleCenterBWorker,
      readonlyRole: roleCenterBReadonly,
    });

    await superPoolA.end();
    superPoolA = null;
    await superPoolB.end();
    superPoolB = null;

    migratorPoolA = new Pool({ connectionString: migratorCenterAUrl, max: 4 });
    apiPoolA = new Pool({ connectionString: apiRuntimeCenterAUrl, max: 8 });
    workerPoolA = new Pool({ connectionString: workerRuntimeCenterAUrl, max: 4 });
    readonlyPoolA = new Pool({ connectionString: readonlyCenterAUrl, max: 2 });
    apiPoolB = new Pool({ connectionString: apiRuntimeCenterBUrl, max: 4 });

    return {
      runId,
      dbCenterA,
      dbCenterB,
      roleMigrator,
      roleApiRuntime,
      roleWorkerRuntime,
      roleReadonly,
      roleCenterBApi,
      roleCenterBWorker,
      roleCenterBReadonly,
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
  } catch (setupError) {
    await cleanup();
    throw setupError;
  }
}
