import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { ApiEnvConfig } from '../config/env';
import { API_CONFIG_TOKEN } from '../health/health.controller';

export const CANONICAL_MUTABLE_TABLES: readonly string[] = Object.freeze([
  'staff_users',
  'staff_sessions',
  'students',
  'guardians',
  'guardian_students',
  'guardian_telegram_links',
  'courses',
  'course_groups',
  'enrollments',
  'lesson_occurrences',
  'substitute_assignments',
  'attendance_records',
  'grade_entries',
  'trial_activations',
  'invoices',
  'discount_requests',
  'unapplied_credits',
  'reversal_or_refund_requests',
  'promises_to_pay',
  'cash_shifts',
  'payroll_snapshots',
  'outbox_events',
  'notification_deliveries',
  'import_batches',
  'center_licenses',
]);

export const CANONICAL_IMMUTABLE_TABLES: readonly string[] = Object.freeze([
  'course_price_history',
  'attendance_revisions',
  'client_operation_logs',
  'billing_policy_versions',
  'billing_cycles',
  'invoice_lines',
  'discount_approvals',
  'freeze_records',
  'freeze_lesson_links',
  'credit_notes',
  'credit_note_applications',
  'payments',
  'payment_allocations',
  'payment_allocation_reversals',
  'reversal_or_refund_executions',
  'receipts',
  'cash_expenses',
  'ledger_entries',
  'payroll_adjustments',
  'audit_logs',
  'outbox_consumer_receipts',
]);

export const CANONICAL_ALL_46_TABLES: readonly string[] = Object.freeze([
  ...CANONICAL_MUTABLE_TABLES,
  ...CANONICAL_IMMUTABLE_TABLES,
]);

export const CANONICAL_IMMUTABILITY_TRIGGERS: readonly string[] = Object.freeze([
  ...CANONICAL_IMMUTABLE_TABLES.map((t) => `trg_immutable_${t}`),
  'trg_payroll_snapshots_closed_immutable',
  'trg_cash_shifts_closed_immutable',
  'trg_staff_users_last_active_director',
]);

export interface DatabaseReadinessReport {
  readonly ready: boolean;
  readonly status: 'READY' | 'UNAVAILABLE';
  readonly current_role: string | null;
  readonly is_superuser: boolean | null;
  readonly schema_tables_verified: number;
  readonly immutable_triggers_verified: number;
  readonly error_code: string | null;
  readonly redacted_reason: string | null;
}

export interface SchemaCatalogInspection {
  readonly totalTablesFound: number;
  readonly missingTables: readonly string[];
  readonly mutableTablesWithConcurrencyColumn: number;
  readonly immutableTablesWithForbiddenVersionColumn: readonly string[];
  readonly nonRestrictForeignKeys: readonly string[];
  readonly immutabilityTriggersFound: number;
  readonly missingTriggers: readonly string[];
}

export function sanitizeDatabaseErrorMessage(err: unknown): string {
  if (!(err instanceof Error)) {
    return 'Database connection or readiness check failed';
  }
  const redacted = err.message
    .replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, '[REDACTED_DATABASE_URL]')
    .replace(/password\s*=\s*[^\s;]+/gi, 'password=[REDACTED]')
    .replace(/:[^:@/\s]{3,}@/g, ':[REDACTED]@');
  if (redacted.length > 180) {
    return `${redacted.slice(0, 180)}...`;
  }
  return redacted || 'Database readiness check failed';
}

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private pool: Pool | null = null;
  private prismaClient: unknown = null;

  constructor(@Inject(API_CONFIG_TOKEN) private readonly config: ApiEnvConfig) {}

  public getPool(): Pool {
    if (!this.pool) {
      this.pool = new Pool({
        connectionString: this.config.databaseUrl,
        max: this.config.dbPoolMax,
        connectionTimeoutMillis: this.config.dbConnectTimeoutMs,
        idleTimeoutMillis: 10000,
        application_name: `eduerp-api-${this.config.centerSlug}`,
      });
      this.pool.on('error', () => {
        // Prevent unhandled idle client error crashes; active queries surface errors directly
      });
    }
    return this.pool;
  }

  public getPrismaClient<T = Record<string, unknown>>(): T {
    if (!this.prismaClient) {
      const adapter = new PrismaPg(this.getPool());
      this.prismaClient = Object.freeze({ adapter, pool: this.getPool() });
    }
    return this.prismaClient as T;
  }

  public async withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.getPool().connect();
    try {
      return await fn(client);
    } finally {
      client.release();
    }
  }

  public async query<R extends QueryResultRow = QueryResultRow>(
    queryText: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<R>> {
    return this.getPool().query<R>(queryText, values);
  }

  public async checkReadiness(): Promise<DatabaseReadinessReport> {
    try {
      return await this.withClient(async (client) => {
        const roleRes = await client.query<{
          current_user: string;
          rolsuper: boolean;
        }>(
          `SELECT current_user::text AS current_user, r.rolsuper AS rolsuper
             FROM pg_roles r
            WHERE r.rolname = current_user`,
        );
        const roleRow = roleRes.rows[0];
        if (!roleRow) {
          return {
            ready: false,
            status: 'UNAVAILABLE',
            current_role: null,
            is_superuser: null,
            schema_tables_verified: 0,
            immutable_triggers_verified: 0,
            error_code: 'DATABASE_ROLE_NOT_FOUND',
            redacted_reason: 'Database session role metadata could not be verified',
          };
        }

        if (roleRow.rolsuper) {
          return {
            ready: false,
            status: 'UNAVAILABLE',
            current_role: roleRow.current_user,
            is_superuser: true,
            schema_tables_verified: 0,
            immutable_triggers_verified: 0,
            error_code: 'DATABASE_SUPERUSER_FORBIDDEN',
            redacted_reason: 'Application runtime must not connect using a PostgreSQL superuser role (T04.02)',
          };
        }

        const tableRes = await client.query<{ cnt: string }>(
          `SELECT COUNT(*)::text AS cnt
             FROM information_schema.tables
            WHERE table_schema = 'public'
              AND table_type = 'BASE TABLE'
              AND table_name = ANY($1::text[])`,
          [CANONICAL_ALL_46_TABLES],
        );
        const tablesVerified = Number(tableRes.rows[0]?.cnt ?? '0');

        const triggerRes = await client.query<{ cnt: string }>(
          `SELECT COUNT(DISTINCT tgname)::text AS cnt
             FROM pg_trigger t
             JOIN pg_class c ON c.oid = t.tgrelid
             JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public'
              AND NOT t.tgisinternal
              AND t.tgname = ANY($1::text[])`,
          [CANONICAL_IMMUTABILITY_TRIGGERS],
        );
        const triggersVerified = Number(triggerRes.rows[0]?.cnt ?? '0');

        if (
          tablesVerified !== CANONICAL_ALL_46_TABLES.length ||
          triggersVerified !== CANONICAL_IMMUTABILITY_TRIGGERS.length
        ) {
          return {
            ready: false,
            status: 'UNAVAILABLE',
            current_role: roleRow.current_user,
            is_superuser: false,
            schema_tables_verified: tablesVerified,
            immutable_triggers_verified: triggersVerified,
            error_code: 'DATABASE_SCHEMA_INCOMPLETE',
            redacted_reason: `Database schema incomplete: expected ${CANONICAL_ALL_46_TABLES.length} tables and ${CANONICAL_IMMUTABILITY_TRIGGERS.length} triggers, found ${tablesVerified} tables and ${triggersVerified} triggers`,
          };
        }

        return {
          ready: true,
          status: 'READY',
          current_role: roleRow.current_user,
          is_superuser: false,
          schema_tables_verified: tablesVerified,
          immutable_triggers_verified: triggersVerified,
          error_code: null,
          redacted_reason: null,
        };
      });
    } catch (err: unknown) {
      return {
        ready: false,
        status: 'UNAVAILABLE',
        current_role: null,
        is_superuser: null,
        schema_tables_verified: 0,
        immutable_triggers_verified: 0,
        error_code: 'DATABASE_UNAVAILABLE',
        redacted_reason: sanitizeDatabaseErrorMessage(err),
      };
    }
  }

  public async inspectSchemaCatalogDrift(): Promise<SchemaCatalogInspection> {
    return this.withClient(async (client) => {
      const tablesRes = await client.query<{ table_name: string }>(
        `SELECT table_name::text AS table_name
           FROM information_schema.tables
          WHERE table_schema = 'public'
            AND table_type = 'BASE TABLE'`,
      );
      const foundSet = new Set(tablesRes.rows.map((r) => r.table_name));
      const missingTables = CANONICAL_ALL_46_TABLES.filter((t) => !foundSet.has(t));

      const versionColsRes = await client.query<{ table_name: string; column_name: string }>(
        `SELECT table_name::text AS table_name, column_name::text AS column_name
           FROM information_schema.columns
          WHERE table_schema = 'public'
            AND column_name IN ('version', 'lease_token')`,
      );
      const tablesWithVersion = new Set(
        versionColsRes.rows.filter((r) => r.column_name === 'version').map((r) => r.table_name),
      );
      const tablesWithConcurrencyToken = new Set(versionColsRes.rows.map((r) => r.table_name));
      const mutableWithConcurrency = CANONICAL_MUTABLE_TABLES.filter((t) =>
        tablesWithConcurrencyToken.has(t),
      ).length;
      const immutableWithForbiddenVersion = CANONICAL_IMMUTABLE_TABLES.filter((t) =>
        tablesWithVersion.has(t),
      );

      const fkRes = await client.query<{ conname: string; confdeltype: string }>(
        `SELECT c.conname::text AS conname, c.confdeltype::text AS confdeltype
           FROM pg_constraint c
           JOIN pg_namespace n ON n.oid = c.connamespace
          WHERE n.nspname = 'public'
            AND c.contype = 'f'`,
      );
      const nonRestrictForeignKeys = fkRes.rows
        .filter((r) => r.confdeltype !== 'r')
        .map((r) => `${r.conname}(${r.confdeltype})`);

      const trigRes = await client.query<{ tgname: string }>(
        `SELECT DISTINCT t.tgname::text AS tgname
           FROM pg_trigger t
           JOIN pg_class c ON c.oid = t.tgrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public'
            AND NOT t.tgisinternal`,
      );
      const foundTriggers = new Set(trigRes.rows.map((r) => r.tgname));
      const missingTriggers = CANONICAL_IMMUTABILITY_TRIGGERS.filter((t) => !foundTriggers.has(t));

      return {
        totalTablesFound: CANONICAL_ALL_46_TABLES.length - missingTables.length,
        missingTables,
        mutableTablesWithConcurrencyColumn: mutableWithConcurrency,
        immutableTablesWithForbiddenVersionColumn: immutableWithForbiddenVersion,
        nonRestrictForeignKeys,
        immutabilityTriggersFound: CANONICAL_IMMUTABILITY_TRIGGERS.length - missingTriggers.length,
        missingTriggers,
      };
    });
  }

  public async close(): Promise<void> {
    if (this.pool) {
      const activePool = this.pool;
      this.pool = null;
      this.prismaClient = null;
      await activePool.end();
    }
  }

  public async onModuleDestroy(): Promise<void> {
    await this.close();
  }
}
