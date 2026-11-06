import { types as pgTypes, Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';
import { WorkerEnvConfig, WorkerLicenseMode } from './config/env';

export interface WorkerQueryExecutor {
  query<R extends QueryResultRow = QueryResultRow>(
    queryText: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<R>>;
}

export function sanitizeWorkerErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err ?? 'Unknown worker error');
  const redacted = raw
    .replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, '[REDACTED_DATABASE_URL]')
    .replace(/password\s*=\s*[^\s;]+/gi, 'password=[REDACTED]')
    .replace(/:[^:@/\s]{3,}@/g, ':[REDACTED]@')
    .replace(/\+[1-9][0-9]{7,14}/g, '[REDACTED_PHONE]')
    .replace(/\b[0-9]{8,10}:AA[A-Za-z0-9_-]{33}\b/g, '[REDACTED_BOT_TOKEN]');
  return redacted.length > 240 ? `${redacted.slice(0, 240)}...` : redacted;
}

export function formatCenterLocalDateParts(
  utcDate: Date,
  timeZone: string,
): {
  readonly localDate: string;
  readonly localHour: number;
  readonly localMinute: number;
  readonly year: number;
  readonly month: number;
  readonly day: number;
} {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const parts = formatter.formatToParts(utcDate);
  const map: Record<string, string> = {};
  for (const p of parts) {
    if (p.type !== 'literal') {
      map[p.type] = p.value;
    }
  }
  const year = Number(map.year);
  const month = Number(map.month);
  const day = Number(map.day);
  const localHour = Number(map.hour ?? '0') % 24;
  const localMinute = Number(map.minute ?? '0');
  const localDate = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return { localDate, localHour, localMinute, year, month, day };
}

export class WorkerDatabase {
  private pool: Pool | null = null;
  private readonly externalPool: Pool | null;

  constructor(
    private readonly config: WorkerEnvConfig,
    customPool?: Pool,
  ) {
    this.externalPool = customPool ?? null;
  }

  public getPool(): Pool {
    if (this.externalPool) {
      return this.externalPool;
    }
    if (!this.pool) {
      this.pool = new Pool({
        connectionString: this.config.databaseUrl,
        types: {
          getTypeParser: (oid, format) => {
            if (format === 'binary') return pgTypes.getTypeParser(oid, 'binary');
            if (oid === 1082) return (val: string) => val;
            return pgTypes.getTypeParser(oid, 'text');
          },
        },
        max: 6,
        connectionTimeoutMillis: 5000,
        idleTimeoutMillis: 10000,
        application_name: `eduerp-worker-${this.config.workerId}`,
      });
      this.pool.on('error', () => {
        // Prevent unhandled idle error crash
      });
    }
    return this.pool;
  }

  public async query<R extends QueryResultRow = QueryResultRow>(
    queryText: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<R>> {
    return this.getPool().query<R>(queryText, values ? [...values] : undefined);
  }

  public async withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.getPool().connect();
    try {
      return await fn(client);
    } finally {
      client.release();
    }
  }

  public async runInTransaction<T>(
    fn: (tx: WorkerQueryExecutor) => Promise<T>,
    isolationLevel: 'READ COMMITTED' | 'REPEATABLE READ' = 'READ COMMITTED',
  ): Promise<T> {
    return this.withClient(async (client) => {
      await client.query(`BEGIN ISOLATION LEVEL ${isolationLevel}`);
      try {
        const result = await fn({
          query: <R extends QueryResultRow = QueryResultRow>(
            sql: string,
            vals?: readonly unknown[],
          ) => client.query<R>(sql, vals ? [...vals] : undefined),
        });
        await client.query('COMMIT');
        return result;
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // Ignore rollback failure
        }
        throw err;
      }
    });
  }

  /**
   * Resolves the live center license mode from PostgreSQL (`center_licenses`), failing closed
   * to `'READ_ONLY'` whenever `config.licenseMode === 'READ_ONLY'`, when the `center_licenses`
   * row is missing, or when its status is not `'ACTIVE'` or `'GRACE_PERIOD'` (`BR-15`, `S05`).
   */
  public async resolveLiveCenterLicenseMode(
    executor: WorkerQueryExecutor = this,
  ): Promise<WorkerLicenseMode> {
    if (this.config.licenseMode === 'READ_ONLY') {
      return 'READ_ONLY';
    }
    const res = await executor.query<{ license_status: WorkerLicenseMode }>(
      `SELECT "license_status"::text AS license_status
         FROM "center_licenses"
        WHERE "center_id" = $1::uuid
        LIMIT 1`,
      [this.config.centerId],
    );
    const liveStatus = res.rows[0]?.license_status;
    if (liveStatus !== 'ACTIVE' && liveStatus !== 'GRACE_PERIOD') {
      return 'READ_ONLY';
    }
    return liveStatus;
  }

  public async close(): Promise<void> {
    if (this.pool) {
      const p = this.pool;
      this.pool = null;
      await p.end();
    }
  }
}
