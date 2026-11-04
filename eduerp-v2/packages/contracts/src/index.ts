import * as fs from 'node:fs';
import * as path from 'node:path';

export const OPENAPI_CONTRACT_RELATIVE_PATH = 'docs/architecture/openapi.yaml';
export const OPERATION_INVENTORY_RELATIVE_PATH = 'docs/architecture/operation-inventory.csv';
export const OPENAPI_CONTRACT_VERSION = '2.0.0-draft.s05-rev1';

export type LicenseMode = 'ACTIVE' | 'GRACE_PERIOD' | 'READ_ONLY';
export type StaffRole = 'DIRECTOR' | 'ADMIN' | 'TEACHER';
export type HealthStatus = 'OK' | 'DEGRADED';

export interface HealthResponseContract {
  status: HealthStatus;
  center_slug: string;
  license_mode: LicenseMode;
  request_id: string;
  timestamp_utc: string;
}

export interface DatabaseReadinessResponseContract {
  status: 'READY';
  center_slug: string;
  license_mode: LicenseMode;
  database_status: 'READY';
  schema_tables_verified: number;
  immutable_triggers_verified: number;
  request_id: string;
  timestamp_utc: string;
}

export type ErrorCodeContract =
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN_ROLE'
  | 'FORBIDDEN_OBJECT_SCOPE'
  | 'PASSWORD_CHANGE_REQUIRED'
  | 'INVALID_CURRENT_PASSWORD'
  | 'LICENSE_READ_ONLY_MODE'
  | 'NOT_FOUND'
  | 'VERSION_CONFLICT'
  | 'STALE_EXCEL_CONFLICT'
  | 'IDEMPOTENCY_KEY_REQUIRED'
  | 'IDEMPOTENCY_PAYLOAD_MISMATCH'
  | 'IF_MATCH_REQUIRED'
  | 'DUPLICATE_STAFF_USERNAME'
  | 'DUPLICATE_STUDENT_DETECTED'
  | 'SHIFT_CLOSED'
  | 'PROMISE_DATE_REQUIRED_FOR_PARTIAL_PAYMENT'
  | 'INVALID_SCHEDULE_ZERO_LESSONS'
  | 'REFUND_CAP_EXCEEDED'
  | 'FREEZE_CREDIT_CAP_EXCEEDED'
  | 'LAST_DIRECTOR_CANNOT_BE_DEACTIVATED'
  | 'POLICY_DECISION_NOT_CONFIRMED'
  | 'RATE_LIMITED'
  | 'DATABASE_UNAVAILABLE';

export interface ErrorEnvelopeContract {
  error_code: ErrorCodeContract;
  message: string;
  request_id: string;
  timestamp_utc: string;
  retry_after_seconds?: number | null;
  conflict_details?: Record<string, unknown> | null;
}

export function resolveOpenApiContractPath(projectRoot?: string): string {
  const root = projectRoot ?? path.resolve(__dirname, '../../../../');
  const candidate = path.resolve(root, OPENAPI_CONTRACT_RELATIVE_PATH);
  if (fs.existsSync(candidate)) {
    return candidate;
  }
  const fallback = path.resolve(process.cwd(), OPENAPI_CONTRACT_RELATIVE_PATH);
  return fallback;
}

export function resolveOperationInventoryPath(projectRoot?: string): string {
  const root = projectRoot ?? path.resolve(__dirname, '../../../../');
  const candidate = path.resolve(root, OPERATION_INVENTORY_RELATIVE_PATH);
  if (fs.existsSync(candidate)) {
    return candidate;
  }
  return path.resolve(process.cwd(), OPERATION_INVENTORY_RELATIVE_PATH);
}

export function loadOpenApiContractDocument(projectRoot?: string): Record<string, unknown> {
  const contractPath = resolveOpenApiContractPath(projectRoot);
  const raw = fs.readFileSync(contractPath, 'utf-8');
  return JSON.parse(raw) as Record<string, unknown>;
}
