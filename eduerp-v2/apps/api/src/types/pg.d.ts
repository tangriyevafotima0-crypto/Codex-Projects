declare module 'pg' {
  export interface QueryResultRow {
    [column: string]: unknown;
  }

  export interface QueryResult<R extends QueryResultRow = QueryResultRow> {
    command: string;
    rowCount: number | null;
    oid: number;
    rows: R[];
  }

  export interface PoolConfig {
    connectionString?: string;
    host?: string;
    port?: number;
    user?: string;
    password?: string;
    database?: string;
    max?: number;
    idleTimeoutMillis?: number;
    connectionTimeoutMillis?: number;
    statement_timeout?: number;
    lock_timeout?: number;
    application_name?: string;
  }

  export interface ClientConfig extends PoolConfig {}

  export interface PoolClient {
    query<R extends QueryResultRow = QueryResultRow>(
      queryText: string,
      values?: readonly unknown[],
    ): Promise<QueryResult<R>>;
    release(err?: Error | boolean): void;
  }

  export class Pool {
    constructor(config?: PoolConfig);
    connect(): Promise<PoolClient>;
    query<R extends QueryResultRow = QueryResultRow>(
      queryText: string,
      values?: readonly unknown[],
    ): Promise<QueryResult<R>>;
    end(): Promise<void>;
    readonly totalCount: number;
    readonly idleCount: number;
    readonly waitingCount: number;
    on(event: 'error' | 'connect' | 'acquire' | 'remove', listener: (err: Error) => void): this;
  }

  export class Client {
    constructor(config?: ClientConfig | string);
    connect(): Promise<void>;
    query<R extends QueryResultRow = QueryResultRow>(
      queryText: string,
      values?: readonly unknown[],
    ): Promise<QueryResult<R>>;
    end(): Promise<void>;
  }

  export class DatabaseError extends Error {
    code?: string;
    detail?: string;
    constraint?: string;
    table?: string;
    schema?: string;
    severity?: string;
  }
}

declare module '@prisma/adapter-pg' {
  import type { Pool, PoolConfig } from 'pg';
  export class PrismaPg {
    constructor(poolOrConfig: Pool | PoolConfig, options?: { schema?: string });
  }
}
