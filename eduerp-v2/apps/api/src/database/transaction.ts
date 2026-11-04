import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { DatabaseService } from './database.service';

export type TransactionIsolationLevel = 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE';

const ALLOWED_ISOLATION_LEVELS: ReadonlySet<string> = new Set([
  'READ COMMITTED',
  'REPEATABLE READ',
  'SERIALIZABLE',
]);

export interface TransactionOptions {
  readonly isolationLevel?: TransactionIsolationLevel;
  readonly maxRetries?: number;
  readonly baseBackoffMs?: number;
  readonly statementTimeoutMs?: number;
  readonly lockTimeoutMs?: number;
  readonly retryOnLockTimeout?: boolean;
  readonly onRetryAttempt?: (attempt: number, error: unknown) => Promise<void> | void;
}

export interface TransactionContext {
  readonly client: PoolClient;
  readonly attempt: number;
  query<R extends QueryResultRow = QueryResultRow>(
    queryText: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<R>>;
}

export interface TransactionExecutionResult<T> {
  readonly result: T;
  readonly attempts: number;
}

export class OptimisticVersionConflictError extends Error {
  public readonly statusCode = 409;
  public readonly errorCode = 'VERSION_CONFLICT';
  public readonly entityName: string;
  public readonly entityId: string;
  public readonly expectedVersion: number;

  constructor(entityName: string, entityId: string, expectedVersion: number) {
    super(
      `Optimistic concurrency conflict on ${entityName}(${entityId}) at expected_version=${expectedVersion}`,
    );
    this.name = 'OptimisticVersionConflictError';
    this.entityName = entityName;
    this.entityId = entityId;
    this.expectedVersion = expectedVersion;
  }
}

const RETRYABLE_PG_SQLSTATES: ReadonlySet<string> = new Set([
  '40001', // serialization_failure
  '40P01', // deadlock_detected
]);

const RETRYABLE_PRISMA_CODES: ReadonlySet<string> = new Set([
  'P2034', // Transaction failed due to a write conflict or a deadlock
]);

export function isRetryableTransactionError(
  err: unknown,
  retryOnLockTimeout: boolean = false,
): boolean {
  if (!err || typeof err !== 'object') {
    return false;
  }
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string') {
    if (RETRYABLE_PG_SQLSTATES.has(code) || RETRYABLE_PRISMA_CODES.has(code)) {
      return true;
    }
    if (retryOnLockTimeout && code === '55P03') {
      return true;
    }
  }
  return false;
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolvePool(poolOrService: Pool | DatabaseService): Pool {
  if ('getPool' in poolOrService && typeof poolOrService.getPool === 'function') {
    return poolOrService.getPool();
  }
  return poolOrService as Pool;
}

export async function runInTransaction<T>(
  poolOrService: Pool | DatabaseService,
  work: (tx: TransactionContext) => Promise<T>,
  options: TransactionOptions = {},
): Promise<TransactionExecutionResult<T>> {
  const pool = resolvePool(poolOrService);
  const isolationLevel = options.isolationLevel ?? 'READ COMMITTED';
  const maxRetries = options.maxRetries ?? 3;
  const baseBackoffMs = options.baseBackoffMs ?? 15;
  const statementTimeoutMs = options.statementTimeoutMs ?? 10000;
  const lockTimeoutMs = options.lockTimeoutMs ?? 1500;
  const retryOnLockTimeout = options.retryOnLockTimeout ?? false;

  if (!ALLOWED_ISOLATION_LEVELS.has(isolationLevel)) {
    throw new Error(`Invalid TransactionOptions.isolationLevel: ${String(isolationLevel)}`);
  }
  if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 10) {
    throw new Error('TransactionOptions.maxRetries must be an integer between 0 and 10');
  }
  if (!Number.isInteger(baseBackoffMs) || baseBackoffMs < 0 || baseBackoffMs > 10000) {
    throw new Error('TransactionOptions.baseBackoffMs must be an integer between 0 and 10000 ms');
  }
  if (!Number.isInteger(statementTimeoutMs) || statementTimeoutMs < 50 || statementTimeoutMs > 60000) {
    throw new Error('TransactionOptions.statementTimeoutMs must be an integer between 50 and 60000 ms');
  }
  if (!Number.isInteger(lockTimeoutMs) || lockTimeoutMs < 20 || lockTimeoutMs > 30000) {
    throw new Error('TransactionOptions.lockTimeoutMs must be an integer between 20 and 30000 ms');
  }

  for (let attempt = 1; attempt <= maxRetries + 1; attempt += 1) {
    const client = await pool.connect();
    let releaseWithError = false;
    try {
      await client.query(`BEGIN ISOLATION LEVEL ${isolationLevel}`);
      await client.query(`SET LOCAL statement_timeout = ${statementTimeoutMs}`);
      await client.query(`SET LOCAL lock_timeout = ${lockTimeoutMs}`);

      const txContext: TransactionContext = {
        client,
        attempt,
        query: <R extends QueryResultRow = QueryResultRow>(
          queryText: string,
          values?: readonly unknown[],
        ) => client.query<R>(queryText, values),
      };

      const result = await work(txContext);
      await client.query('COMMIT');
      return { result, attempts: attempt };
    } catch (err: unknown) {
      try {
        await client.query('ROLLBACK');
      } catch {
        releaseWithError = true;
      }

      if (attempt <= maxRetries && isRetryableTransactionError(err, retryOnLockTimeout)) {
        if (options.onRetryAttempt) {
          await options.onRetryAttempt(attempt, err);
        }
        const backoff = baseBackoffMs * attempt;
        if (backoff > 0) {
          await sleepMs(backoff);
        }
        continue;
      }
      throw err;
    } finally {
      client.release(releaseWithError);
    }
  }

  throw new Error('Transaction retry loop exhausted unexpectedly');
}

export async function executeOptimisticUpdate<R extends QueryResultRow = QueryResultRow>(
  tx: TransactionContext,
  params: {
    readonly tableName: string;
    readonly entityName: string;
    readonly id: string;
    readonly centerId: string;
    readonly expectedVersion: number;
    readonly setClauseSql: string;
    readonly additionalValues?: readonly unknown[];
  },
): Promise<R> {
  if (!/^[a-z_][a-z0-9_]*$/.test(params.tableName)) {
    throw new Error(`Invalid SQL table identifier: ${params.tableName}`);
  }
  const extra = params.additionalValues ?? [];
  const sql = `
    UPDATE "${params.tableName}"
       SET ${params.setClauseSql},
           "version" = "version" + 1,
           "updated_at" = NOW()
     WHERE "id" = $1::uuid
       AND "center_id" = $2::uuid
       AND "version" = $3::int
    RETURNING *
  `;
  const res = await tx.query<R>(sql, [params.id, params.centerId, params.expectedVersion, ...extra]);
  if (res.rowCount !== 1 || !res.rows[0]) {
    throw new OptimisticVersionConflictError(params.entityName, params.id, params.expectedVersion);
  }
  return res.rows[0];
}
