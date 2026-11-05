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

export type BillingMode = 'CALENDAR_PRO_RATA' | 'ROLLING_MONTH' | 'LESSON_PACKAGE_12';

export type DueDateRule = 'ENROLLMENT_ANNIVERSARY' | 'CENTER_FIXED_DAY';
export type CollectionTiming = 'ADVANCE' | 'ARREARS';

export type BillingCycleType = 'CALENDAR_MONTH' | 'ROLLING_MONTH' | 'LESSON_PACKAGE_12';
export type FirstPartialChargeMode = 'UNCONFIGURED' | 'PRORATE_REMAINING_LESSONS' | 'FULL_CYCLE';
export type RoundingMode = 'HALF_UP_UZS_INT';
export type RollingMonthEndMode = 'CLAMP_LAST_DAY' | 'CONTINUE_FROM_CLAMPED_DAY' | 'RESTORE_ANCHOR_31' | 'UNCONFIGURED';
export type PackageCancelMode = 'PRESERVE_BALANCE' | 'CREDIT_NEXT_CYCLE' | 'UNCONFIGURED';
export type CancelledLessonProrationMode = 'UNCONFIGURED' | 'EXCLUDE_CANCELLED_FROM_PLANNED' | 'COUNT_SCHEDULED_BASELINE';
export type PolicyConfirmationStatus = 'UNCONFIGURED' | 'CONFIRMED';
export type InvoiceStatus = 'ISSUED_OPEN' | 'PARTIALLY_PAID' | 'PAID' | 'GRANT_ZERO' | 'VOID_COMPENSATED';

export type DiscountKind =
  | 'FAMILY_DISCOUNT'
  | 'SPECIAL_50_PERCENT'
  | 'CUSTOM_PERCENT'
  | 'CUSTOM_FIXED'
  | 'FULL_GRANT_100';

export type DiscountRequestStatus =
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'REJECTED'
  | 'EXPIRED'
  | 'REVOKED';

export type DiscountDecision = 'APPROVED' | 'REJECTED';

export type DiscountStackingMode =
  | 'UNCONFIGURED'
  | 'MAX_SINGLE'
  | 'MAX_SINGLE_DISCOUNT'
  | 'HIGHEST_ONLY'
  | 'SEQUENTIAL'
  | 'SEQUENTIAL_APPROVAL_ORDER'
  | 'PERCENT_THEN_FIXED'
  | 'SEQUENTIAL_PERCENT_THEN_FIXED'
  | 'FIXED_THEN_PERCENT'
  | 'SEQUENTIAL_FIXED_THEN_PERCENT';

export type FreezeReasonType = 'MEDICAL_CERTIFICATE' | 'PRIOR_NOTICE';

export type FreezeCreditBasis =
  | 'UNCONFIGURED'
  | 'NET_PROPORTIONAL_LESSON'
  | 'NET_EARNED_PROPORTIONAL'
  | 'LESSON_PROPORTIONAL'
  | 'DISABLED'
  | 'NO_FREEZE_CREDIT'
  | 'GROSS_PROPORTIONAL'
  | 'CALENDAR_DAY_PROPORTIONAL'
  | 'CASH_REFUND';

export type PaymentMethod = 'CASH' | 'CARD' | 'CLICK' | 'PAYME' | 'TRANSFER';

export type PaymentSourceChannel = 'ADMIN_MANUAL_ENTRY' | 'DIRECTOR_MANUAL_ENTRY';

export type CashShiftStatus = 'OPEN' | 'CLOSED';

export type PromiseToPayStatus = 'ACTIVE' | 'FULFILLED' | 'CANCELLED' | 'OVERDUE_NOTIFIED';

export type ReversalOrRefundKind = 'ERROR_STORNO_REVERSAL' | 'PARTIAL_REFUND' | 'FULL_REFUND';

export type ReversalOrRefundStatus =
  | 'PENDING_DIRECTOR_APPROVAL'
  | 'APPROVED_EXECUTED'
  | 'REJECTED';

export type ReversalDecision = 'APPROVED_EXECUTED' | 'REJECTED';

export type DebtEffectPolicy = 'REOPEN_INVOICE_DEBT' | 'CLOSE_WITH_CREDIT_NOTE';
