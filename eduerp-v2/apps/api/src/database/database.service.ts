import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import { ApiEnvConfig } from '../config/env';
import { API_CONFIG_TOKEN } from '../config/tokens';

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

export const CANONICAL_LINEAGE_TRIGGERS: readonly string[] = Object.freeze([
  'trg_lineage_attendance_records',
  'trg_lineage_grade_entries',
  'trg_lineage_invoices',
  'trg_lineage_discount_requests',
  'trg_lineage_freeze_records',
  'trg_lineage_freeze_lesson_links',
  'trg_lineage_credit_notes',
  'trg_lineage_credit_note_applications',
  'trg_lineage_payment_allocations',
  'trg_lineage_payment_allocation_reversals',
  'trg_lineage_ledger_entries',
]);

export const CANONICAL_NAMED_CHECK_CONSTRAINTS: readonly string[] = Object.freeze([
  'chk_enrollments_left_churn',
  'chk_attendance_records_override_reason',
  'chk_invoices_net_charge_formula',
  'chk_invoices_remaining_debt_formula',
  'chk_credit_notes_actor',
  'chk_cash_shifts_drawer_formula',
  'chk_credit_note_apps_source_xor',
  'chk_credit_note_apps_actor',
  'chk_ledger_entries_actor',
]);

export const CANONICAL_PARTIAL_UNIQUE_INDEXES: readonly string[] = Object.freeze([
  'idx_guardian_telegram_links_active',
  'idx_enrollments_active_student_group',
  'idx_substitute_assignments_active_lesson',
  'idx_trial_activations_active_enrollment',
  'idx_cash_shifts_open_center',
]);

export const PUBLIC_READINESS_FAILURE_MESSAGE =
  'Database readiness check failed or required schema invariants are unavailable';

export interface DatabaseReadinessReport {
  readonly ready: boolean;
  readonly status: 'READY' | 'UNAVAILABLE';
  readonly current_role: string | null;
  readonly is_superuser: boolean | null;
  readonly is_schema_owner: boolean | null;
  readonly schema_tables_verified: number;
  readonly immutable_triggers_verified: number;
  readonly lineage_triggers_verified: number;
  readonly runtime_acl_verified: boolean;
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
  readonly disabledTriggers: readonly string[];
  readonly missingLineageTriggers: readonly string[];
  readonly missingCheckConstraints: readonly string[];
  readonly missingPartialUniqueIndexes: readonly string[];
}

export function sanitizeDatabaseErrorMessage(err: unknown): string {
  if (!(err instanceof Error)) {
    return PUBLIC_READINESS_FAILURE_MESSAGE;
  }
  const redacted = err.message
    .replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, '[REDACTED_DATABASE_URL]')
    .replace(/password\s*=\s*[^\s;]+/gi, 'password=[REDACTED]')
    .replace(/:[^:@/\s]{3,}@/g, ':[REDACTED]@');
  if (redacted.length > 180) {
    return `${redacted.slice(0, 180)}...`;
  }
  return redacted || PUBLIC_READINESS_FAILURE_MESSAGE;
}

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private pool: Pool | null = null;
  private prismaClient: PrismaClient | null = null;

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

  public getPrismaClient(): PrismaClient {
    if (!this.prismaClient) {
      const adapter = new PrismaPg(this.getPool());
      this.prismaClient = new PrismaClient({ adapter });
    }
    return this.prismaClient;
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
    return this.getPool().query<R>(queryText, values ? [...values] : undefined);
  }

  public async checkReadiness(): Promise<DatabaseReadinessReport> {
    try {
      return await this.withClient(async (client) => {
        const roleRes = await client.query<{
          current_user: string;
          rolsuper: boolean;
          rolcreatedb: boolean;
          rolcreaterole: boolean;
        }>(
          `SELECT current_user::text AS current_user,
                  r.rolsuper AS rolsuper,
                  r.rolcreatedb AS rolcreatedb,
                  r.rolcreaterole AS rolcreaterole
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
            is_schema_owner: null,
            schema_tables_verified: 0,
            immutable_triggers_verified: 0,
            lineage_triggers_verified: 0,
            runtime_acl_verified: false,
            error_code: 'DATABASE_ROLE_NOT_FOUND',
            redacted_reason: PUBLIC_READINESS_FAILURE_MESSAGE,
          };
        }

        if (roleRow.rolsuper || roleRow.rolcreatedb || roleRow.rolcreaterole) {
          return {
            ready: false,
            status: 'UNAVAILABLE',
            current_role: roleRow.current_user,
            is_superuser: true,
            is_schema_owner: null,
            schema_tables_verified: 0,
            immutable_triggers_verified: 0,
            lineage_triggers_verified: 0,
            runtime_acl_verified: false,
            error_code: 'DATABASE_SUPERUSER_FORBIDDEN',
            redacted_reason: PUBLIC_READINESS_FAILURE_MESSAGE,
          };
        }

        const ownerRes = await client.query<{ owned_cnt: string }>(
          `SELECT COUNT(*)::text AS owned_cnt
             FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public'
              AND c.relkind = 'r'
              AND c.relname = ANY($1::text[])
              AND pg_get_userbyid(c.relowner) = current_user`,
          [CANONICAL_ALL_46_TABLES],
        );
        const isSchemaOwner = Number(ownerRes.rows[0]?.owned_cnt ?? '0') > 0;
        if (isSchemaOwner) {
          return {
            ready: false,
            status: 'UNAVAILABLE',
            current_role: roleRow.current_user,
            is_superuser: false,
            is_schema_owner: true,
            schema_tables_verified: 0,
            immutable_triggers_verified: 0,
            lineage_triggers_verified: 0,
            runtime_acl_verified: false,
            error_code: 'DATABASE_SCHEMA_OWNER_FORBIDDEN',
            redacted_reason: PUBLIC_READINESS_FAILURE_MESSAGE,
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

        const immTriggerRes = await client.query<{ cnt: string }>(
          `SELECT COUNT(DISTINCT t.tgname)::text AS cnt
             FROM pg_trigger t
             JOIN pg_class c ON c.oid = t.tgrelid
             JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public'
              AND NOT t.tgisinternal
              AND t.tgenabled <> 'D'
              AND t.tgname = ANY($1::text[])`,
          [CANONICAL_IMMUTABILITY_TRIGGERS],
        );
        const triggersVerified = Number(immTriggerRes.rows[0]?.cnt ?? '0');

        const linTriggerRes = await client.query<{ cnt: string }>(
          `SELECT COUNT(DISTINCT t.tgname)::text AS cnt
             FROM pg_trigger t
             JOIN pg_class c ON c.oid = t.tgrelid
             JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public'
              AND NOT t.tgisinternal
              AND t.tgenabled <> 'D'
              AND t.tgname = ANY($1::text[])`,
          [CANONICAL_LINEAGE_TRIGGERS],
        );
        const lineageTriggersVerified = Number(linTriggerRes.rows[0]?.cnt ?? '0');

        let runtimeAclVerified = false;
        if (tablesVerified === CANONICAL_ALL_46_TABLES.length) {
          const aclRes = await client.query<{
            can_rw_mutable: boolean;
            can_del_mutable: boolean;
            can_ins_immutable: boolean;
            can_upd_immutable: boolean;
            can_del_immutable: boolean;
            can_create_schema: boolean;
          }>(
            `SELECT has_table_privilege(current_user, 'public.students', 'SELECT, INSERT, UPDATE') AS can_rw_mutable,
                    has_table_privilege(current_user, 'public.students', 'DELETE') AS can_del_mutable,
                    has_table_privilege(current_user, 'public.payments', 'SELECT, INSERT') AS can_ins_immutable,
                    has_table_privilege(current_user, 'public.payments', 'UPDATE') AS can_upd_immutable,
                    has_table_privilege(current_user, 'public.payments', 'DELETE') AS can_del_immutable,
                    has_schema_privilege(current_user, 'public', 'CREATE') AS can_create_schema`,
          );
          const acl = aclRes.rows[0];
          runtimeAclVerified = Boolean(
            acl &&
              acl.can_rw_mutable &&
              !acl.can_del_mutable &&
              acl.can_ins_immutable &&
              !acl.can_upd_immutable &&
              !acl.can_del_immutable &&
              !acl.can_create_schema,
          );
        }

        if (
          tablesVerified !== CANONICAL_ALL_46_TABLES.length ||
          triggersVerified !== CANONICAL_IMMUTABILITY_TRIGGERS.length ||
          lineageTriggersVerified !== CANONICAL_LINEAGE_TRIGGERS.length ||
          !runtimeAclVerified
        ) {
          return {
            ready: false,
            status: 'UNAVAILABLE',
            current_role: roleRow.current_user,
            is_superuser: false,
            is_schema_owner: false,
            schema_tables_verified: tablesVerified,
            immutable_triggers_verified: triggersVerified,
            lineage_triggers_verified: lineageTriggersVerified,
            runtime_acl_verified: runtimeAclVerified,
            error_code: 'DATABASE_SCHEMA_INCOMPLETE',
            redacted_reason: PUBLIC_READINESS_FAILURE_MESSAGE,
          };
        }

        return {
          ready: true,
          status: 'READY',
          current_role: roleRow.current_user,
          is_superuser: false,
          is_schema_owner: false,
          schema_tables_verified: tablesVerified,
          immutable_triggers_verified: triggersVerified,
          lineage_triggers_verified: lineageTriggersVerified,
          runtime_acl_verified: true,
          error_code: null,
          redacted_reason: null,
        };
      });
    } catch {
      return {
        ready: false,
        status: 'UNAVAILABLE',
        current_role: null,
        is_superuser: null,
        is_schema_owner: null,
        schema_tables_verified: 0,
        immutable_triggers_verified: 0,
        lineage_triggers_verified: 0,
        runtime_acl_verified: false,
        error_code: 'DATABASE_UNAVAILABLE',
        redacted_reason: PUBLIC_READINESS_FAILURE_MESSAGE,
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

      const trigRes = await client.query<{ tgname: string; tgenabled: string }>(
        `SELECT DISTINCT t.tgname::text AS tgname, t.tgenabled::text AS tgenabled
           FROM pg_trigger t
           JOIN pg_class c ON c.oid = t.tgrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public'
            AND NOT t.tgisinternal`,
      );
      const enabledTriggers = new Set(
        trigRes.rows.filter((r) => r.tgenabled !== 'D').map((r) => r.tgname),
      );
      const disabledTriggers = trigRes.rows
        .filter((r) => r.tgenabled === 'D')
        .map((r) => r.tgname);
      const missingTriggers = CANONICAL_IMMUTABILITY_TRIGGERS.filter((t) => !enabledTriggers.has(t));
      const missingLineageTriggers = CANONICAL_LINEAGE_TRIGGERS.filter((t) => !enabledTriggers.has(t));

      const chkRes = await client.query<{ conname: string }>(
        `SELECT c.conname::text AS conname
           FROM pg_constraint c
           JOIN pg_namespace n ON n.oid = c.connamespace
          WHERE n.nspname = 'public'
            AND c.contype = 'c'`,
      );
      const foundCheckSet = new Set(chkRes.rows.map((r) => r.conname));
      const missingCheckConstraints = CANONICAL_NAMED_CHECK_CONSTRAINTS.filter(
        (c) => !foundCheckSet.has(c),
      );

      const idxRes = await client.query<{ indexname: string }>(
        `SELECT indexname::text AS indexname
           FROM pg_indexes
          WHERE schemaname = 'public'`,
      );
      const foundIdxSet = new Set(idxRes.rows.map((r) => r.indexname));
      const missingPartialUniqueIndexes = CANONICAL_PARTIAL_UNIQUE_INDEXES.filter(
        (idx) => !foundIdxSet.has(idx),
      );

      return {
        totalTablesFound: CANONICAL_ALL_46_TABLES.length - missingTables.length,
        missingTables,
        mutableTablesWithConcurrencyColumn: mutableWithConcurrency,
        immutableTablesWithForbiddenVersionColumn: immutableWithForbiddenVersion,
        nonRestrictForeignKeys,
        immutabilityTriggersFound: CANONICAL_IMMUTABILITY_TRIGGERS.length - missingTriggers.length,
        missingTriggers,
        disabledTriggers,
        missingLineageTriggers,
        missingCheckConstraints,
        missingPartialUniqueIndexes,
      };
    });
  }

  public async close(): Promise<void> {
    if (this.prismaClient) {
      const clientToDisconnect = this.prismaClient;
      this.prismaClient = null;
      await clientToDisconnect.$disconnect();
    }
    if (this.pool) {
      const activePool = this.pool;
      this.pool = null;
      await activePool.end();
    }
  }

  public async onModuleDestroy(): Promise<void> {
    await this.close();
  }
}
