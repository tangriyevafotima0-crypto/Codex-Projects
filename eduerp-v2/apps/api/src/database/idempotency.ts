import * as crypto from 'node:crypto';
import type { Pool } from 'pg';
import { DatabaseService } from './database.service';
import { runInTransaction, TransactionContext, TransactionIsolationLevel } from './transaction';

const UUID_REGEX = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
export const SYSTEM_ACTOR_UUID = '00000000-0000-4000-8000-000000000000';

/**
 * G01 Security Boundary: Authentication credential/token issuance endpoints
 * must never be cached or replayed from generic persistent `client_operation_logs`.
 */
const FORBIDDEN_AUTH_IDEMPOTENCY_OPERATIONS: ReadonlySet<string> = new Set([
  'LOGIN_STAFF',
  'REFRESH_STAFF_SESSION',
  'LOGIN_VENDOR_WITH_MFA',
]);

const FORBIDDEN_SECRET_JSON_KEYS: readonly string[] = Object.freeze([
  '"access_token"',
  '"refresh_token"',
  '"csrf_token"',
  '"rawRefreshToken"',
  '"rawCsrfToken"',
  '"password_hash"',
  '"initial_password"',
  '"current_password"',
  '"new_password"',
  '$scrypt$',
]);

export class IdempotencyConflictError extends Error {
  public readonly statusCode = 409;
  public readonly errorCode = 'IDEMPOTENCY_PAYLOAD_MISMATCH';
  public readonly idempotencyKey: string;
  public readonly operationType: string;

  constructor(operationType: string, idempotencyKey: string) {
    super(
      `Idempotency key '${idempotencyKey}' for operation '${operationType}' was already used with a different request payload`,
    );
    this.name = 'IdempotencyConflictError';
    this.operationType = operationType;
    this.idempotencyKey = idempotencyKey;
  }
}

export interface IdempotentHandlerResult<T> {
  readonly statusCode: number;
  readonly body: T;
}

export interface IdempotentOperationParams<T> {
  readonly centerId: string;
  readonly actorStaffId: string | null;
  readonly operationType: string;
  readonly idempotencyKey: string;
  readonly requestPayload: unknown;
  readonly isolationLevel?: TransactionIsolationLevel;
  readonly handler: (tx: TransactionContext) => Promise<IdempotentHandlerResult<T>>;
}

export interface IdempotentExecutionResult<T> {
  readonly statusCode: number;
  readonly body: T;
  readonly replayed: boolean;
  readonly clientOperationUuid: string;
  readonly requestPayloadHash: string;
  readonly attempts: number;
}

function canonicalizeJson(value: unknown): string {
  if (value === null || value === undefined) {
    return 'null';
  }
  if (typeof value === 'bigint') {
    return JSON.stringify(value.toString(10));
  }
  if (typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalizeJson(item)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const sortedKeys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  const pairs = sortedKeys.map((k) => `${JSON.stringify(k)}:${canonicalizeJson(obj[k])}`);
  return `{${pairs.join(',')}}`;
}

export function computeCanonicalPayloadHash(payload: unknown): string {
  const canonical = canonicalizeJson(payload);
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * G05: Computes a versioned server-keyed HMAC-SHA256 digest for sensitive request fields
 * (such as passwords or phone numbers) so idempotency payload hashes detect any change in
 * semantic input (409 IDEMPOTENCY_PAYLOAD_MISMATCH) without storing raw secrets or unkeyed
 * password digests in persistent logs.
 */
export function computeKeyedFieldDigest(
  hmacSecret: string,
  domainTag: string,
  value: string | null | undefined,
): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (!hmacSecret || hmacSecret.length < 16) {
    throw new Error('Server HMAC secret of at least 16 chars is required for keyed field digest');
  }
  return `hmac-sha256:v1:${crypto
    .createHmac('sha256', hmacSecret)
    .update(`${domainTag}:${value}`, 'utf8')
    .digest('hex')}`;
}

export function assertNoSecretMaterialInIdempotencyPayload(serializedJson: string): void {
  for (const forbidden of FORBIDDEN_SECRET_JSON_KEYS) {
    if (serializedJson.includes(forbidden)) {
      throw new Error(
        `SECURITY_BOUNDARY_G01: Refusing to persist secret/token material (${forbidden}) in client_operation_logs`,
      );
    }
  }
}

export function deriveClientOperationUuid(
  centerId: string,
  actorId: string,
  operationType: string,
  idempotencyKey: string,
): string {
  const trimmed = idempotencyKey.trim();
  if (UUID_REGEX.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  const digest = crypto
    .createHash('sha256')
    .update(`${centerId}:${actorId}:${operationType}:${trimmed}`, 'utf8')
    .digest('hex');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

export async function executeIdempotentOperation<T>(
  poolOrService: Pool | DatabaseService,
  params: IdempotentOperationParams<T>,
): Promise<IdempotentExecutionResult<T>> {
  if (FORBIDDEN_AUTH_IDEMPOTENCY_OPERATIONS.has(params.operationType)) {
    throw new Error(
      `SECURITY_BOUNDARY_G01: Operation '${params.operationType}' must verify live credentials/tokens and cannot use generic persistent replay cache`,
    );
  }
  const idempotencyKey = params.idempotencyKey.trim();
  if (idempotencyKey.length < 8 || idempotencyKey.length > 128) {
    throw new Error('Idempotency-Key must be between 8 and 128 characters');
  }
  const actorId = params.actorStaffId ?? SYSTEM_ACTOR_UUID;
  const clientOperationUuid = deriveClientOperationUuid(
    params.centerId,
    actorId,
    params.operationType,
    idempotencyKey,
  );
  const payloadHash = computeCanonicalPayloadHash(params.requestPayload);
  const lockNamespace = `${params.centerId}:${actorId}:${params.operationType}`;

  const txOutcome = await runInTransaction(
    poolOrService,
    async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [
        lockNamespace,
        clientOperationUuid,
      ]);

      const existingRes = await tx.query<{
        request_body_sha256: string;
        response_status_code: number;
        response_payload_json: T;
      }>(
        `SELECT "request_body_sha256",
                "response_status_code",
                "response_payload_json"
           FROM "client_operation_logs"
          WHERE "center_id" = $1::uuid
            AND "actor_id" = $2::uuid
            AND "operation_type" = $3
            AND "client_operation_uuid" = $4::uuid
          LIMIT 1`,
        [params.centerId, actorId, params.operationType, clientOperationUuid],
      );

      const existing = existingRes.rows[0];
      if (existing) {
        if (existing.request_body_sha256.trim() !== payloadHash) {
          throw new IdempotencyConflictError(params.operationType, idempotencyKey);
        }
        return {
          statusCode: existing.response_status_code,
          body: existing.response_payload_json,
          replayed: true,
        };
      }

      const fresh = await params.handler(tx);
      const serializedResponse = JSON.stringify(fresh.body);
      assertNoSecretMaterialInIdempotencyPayload(serializedResponse);

      await tx.query(
        `INSERT INTO "client_operation_logs" (
           "client_operation_uuid",
           "center_id",
           "actor_id",
           "operation_type",
           "request_body_sha256",
           "response_status_code",
           "response_payload_json",
           "created_at"
         ) VALUES (
           $1::uuid,
           $2::uuid,
           $3::uuid,
           $4,
           $5,
           $6::int,
           $7::jsonb,
           NOW()
         )`,
        [
          clientOperationUuid,
          params.centerId,
          actorId,
          params.operationType,
          payloadHash,
          fresh.statusCode,
          serializedResponse,
        ],
      );

      return {
        statusCode: fresh.statusCode,
        body: fresh.body,
        replayed: false,
      };
    },
    {
      isolationLevel: params.isolationLevel ?? 'READ COMMITTED',
    },
  );

  return {
    statusCode: txOutcome.result.statusCode,
    body: txOutcome.result.body,
    replayed: txOutcome.result.replayed,
    clientOperationUuid,
    requestPayloadHash: payloadHash,
    attempts: txOutcome.attempts,
  };
}
