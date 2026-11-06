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
  private readonly activeClients = new Set<PoolClient>();
  private closing = false;

  constructor(
    private readonly config: WorkerEnvConfig,
    customPool?: Pool,
  ) {
    this.externalPool = customPool ?? null;
  }

  public isClosing(): boolean {
    return this.closing;
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
    if (this.closing) {
      throw new Error('WORKER_DATABASE_CLOSING: Refusing new query during shutdown');
    }
    const p = this.getPool();
    if (typeof p.connect === 'function' && !this.externalPool) {
      return this.withClient((client) =>
        client.query<R>(queryText, values ? [...values] : undefined),
      );
    }
    return p.query<R>(queryText, values ? [...values] : undefined);
  }

  public async withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    if (this.closing) {
      throw new Error('WORKER_DATABASE_CLOSING: Refusing new client checkout during shutdown');
    }
    const client = await this.getPool().connect();
    this.activeClients.add(client);
    let released = false;
    try {
      return await fn(client);
    } finally {
      if (this.activeClients.has(client)) {
        this.activeClients.delete(client);
        released = true;
        try {
          client.release();
        } catch {
          // Ignore double-release if forcibly aborted during bounded shutdown
        }
      } else if (!released) {
        // Client was already forcibly released by bounded close()
      }
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

  private forceAbortTrackedClients(): void {
    for (const client of [...this.activeClients]) {
      this.activeClients.delete(client);
      try {
        const rawConn = (
          client as unknown as {
            connection?: { stream?: { destroy?: (err?: Error) => void } };
          }
        ).connection;
        if (rawConn?.stream && typeof rawConn.stream.destroy === 'function') {
          rawConn.stream.destroy(new Error('WORKER_SHUTDOWN_ABORT_ACTIVE_QUERY'));
        }
      } catch {
        // Ignore stream destroy error
      }
      try {
        client.release(new Error('WORKER_SHUTDOWN_ABORT_ACTIVE_QUERY'));
      } catch {
        // Ignore release error
      }
    }
  }

  /**
   * Bounded pool close (`T05`):
   * - Marks database as closing so no new queries/claims can start.
   * - If `forceAbortActive` is true (e.g. `inFlightTick` timed out during `stop()`),
   *   immediately destroys/releases any hung active `PoolClient` sockets before calling `pool.end()`.
   * - Races `pool.end()` against `timeoutMs` so a hung or slow PostgreSQL connection can NEVER
   *   block `WorkerRuntimeSkeleton.stop()` indefinitely.
   */
  public async close(timeoutMs = 500, forceAbortActive = false): Promise<void> {
    this.closing = true;
    if (forceAbortActive) {
      this.forceAbortTrackedClients();
    }
    if (this.pool) {
      const p = this.pool;
      this.pool = null;
      const boundedMs = Math.max(50, Math.min(5000, timeoutMs));
      let timer: NodeJS.Timeout | null = null;
      const endOutcome = await Promise.race([
        p
          .end()
          .then(() => 'ENDED' as const)
          .catch(() => 'ENDED' as const),
        new Promise<'TIMED_OUT'>((resolve) => {
          timer = setTimeout(() => resolve('TIMED_OUT'), boundedMs);
        }),
      ]);
      if (timer) {
        clearTimeout(timer);
      }
      if (endOutcome === 'TIMED_OUT') {
        this.forceAbortTrackedClients();
      }
    } else if (this.externalPool && forceAbortActive) {
      this.forceAbortTrackedClients();
    }
  }
}
