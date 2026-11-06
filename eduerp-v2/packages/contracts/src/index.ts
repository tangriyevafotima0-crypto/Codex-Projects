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

export type AttendanceStatus = 'PRESENT' | 'LATE' | 'ABSENT';

export type AttendanceSourceChannel =
  | 'TEACHER_MOBILE'
  | 'TEACHER_WEB'
  | 'ADMIN_EXCEL'
  | 'ADMIN_OVERRIDE';

export type OfflineAttendanceAckStatus =
  | 'ACK_COMMITTED'
  | 'ACK_IDEMPOTENT_REPLAY'
  | 'CONFLICT_409'
  | 'FORBIDDEN_PERMISSION_REVOKED'
  | 'BLOCKED_LICENSE_READ_ONLY';

export type OfflineQueueOperationState = 'PENDING' | 'SYNCED' | 'CONFLICT' | 'REJECTED';

export interface OfflineAttendanceQueueItemContract {
  readonly client_operation_uuid: string;
  readonly lesson_id: string;
  readonly expected_version: number;
  readonly payload_sha256: string;
  readonly state: OfflineQueueOperationState;
  readonly synced_server_version: number | null;
  readonly last_ack_status: OfflineAttendanceAckStatus | null;
  readonly last_error_code: string | null;
  readonly conflict_details_json: Record<string, unknown> | null;
}

export interface OfflineAttendanceAckResultContract {
  readonly client_operation_uuid: string;
  readonly lesson_id: string;
  readonly ack_status: OfflineAttendanceAckStatus;
  readonly server_version: number | null;
  readonly error_code: string | null;
  readonly conflict_details?: Record<string, unknown> | null;
}

export function applyOfflineAttendanceSyncAck(
  queueItems: readonly OfflineAttendanceQueueItemContract[],
  ackResults: readonly OfflineAttendanceAckResultContract[],
): readonly OfflineAttendanceQueueItemContract[] {
  const ackByUuid = new Map<string, OfflineAttendanceAckResultContract>();
  for (const res of ackResults) {
    if (!ackByUuid.has(res.client_operation_uuid)) {
      ackByUuid.set(res.client_operation_uuid, res);
    }
  }

  return Object.freeze(
    queueItems.map((item) => {
      if (item.state === 'SYNCED') {
        return item;
      }
      const ack = ackByUuid.get(item.client_operation_uuid);
      if (!ack || ack.lesson_id !== item.lesson_id) {
        return item;
      }
      if (
        ack.ack_status === 'ACK_COMMITTED' ||
        ack.ack_status === 'ACK_IDEMPOTENT_REPLAY'
      ) {
        if (
          typeof ack.server_version !== 'number' ||
          !Number.isInteger(ack.server_version) ||
          ack.server_version < 1
        ) {
          return Object.freeze({
            ...item,
            state: 'PENDING' as const,
            synced_server_version: null,
            last_ack_status: ack.ack_status,
            last_error_code: ack.error_code ?? 'INVALID_ACK_SERVER_VERSION',
            conflict_details_json: ack.conflict_details ?? null,
          });
        }
        return Object.freeze({
          ...item,
          state: 'SYNCED' as const,
          synced_server_version: ack.server_version,
          last_ack_status: ack.ack_status,
          last_error_code: null,
          conflict_details_json: null,
        });
      }
      if (ack.ack_status === 'CONFLICT_409') {
        return Object.freeze({
          ...item,
          state: 'CONFLICT' as const,
          synced_server_version: ack.server_version,
          last_ack_status: ack.ack_status,
          last_error_code: ack.error_code ?? 'VERSION_CONFLICT',
          conflict_details_json: ack.conflict_details ?? null,
        });
      }
      return Object.freeze({
        ...item,
        state: 'REJECTED' as const,
        synced_server_version: ack.server_version,
        last_ack_status: ack.ack_status,
        last_error_code: ack.error_code ?? ack.ack_status,
        conflict_details_json: ack.conflict_details ?? null,
      });
    }),
  );
}

export type OutboxEventStatus =
  | 'PENDING'
  | 'LEASED'
  | 'COMPLETED'
  | 'DEAD_LETTER'
  | 'SUPERSEDED_BY_RESTORE';

export type NotificationRecipientType = 'GUARDIAN' | 'DIRECTOR' | 'TEACHER' | 'ADMIN';

export type NotificationDeliveryStatus =
  | 'QUEUED'
  | 'API_ACCEPTED'
  | 'RETRY_429'
  | 'FAILED_403_BLOCKED'
  | 'SKIPPED_UNLINKED'
  | 'DEAD_LETTER';

export type PromiseReminderChannelPolicy =
  | 'UNCONFIGURED_CHANNEL_POLICY'
  | 'CONFIRMED_GUARDIAN_ONLY'
  | 'CONFIRMED_ADMIN_AND_GUARDIAN';

export interface BillingCycleWorkerIssueParams {
  readonly centerId: string;
  readonly enrollmentId: string;
  readonly cycleType: BillingCycleType;
  readonly cycleKey: string;
  readonly periodStartDate: string;
  readonly periodEndDate?: string | null;
  readonly systemJobName: string;
  readonly testFaultAfterStep?: import('./billing-engine').CanonicalFaultInjectionStep;
}

export interface BillingCycleWorkerIssueResult {
  readonly invoice: {
    readonly invoice_id: string;
    readonly invoice_number: string;
    readonly student_id: string;
    readonly enrollment_id: string;
    readonly billing_cycle_id: string;
    readonly effective_net_charge_uzs: string;
    readonly remaining_debt_uzs: string;
    readonly status: string;
  };
  readonly replayedByCycleIdentity: boolean;
}

export interface BillingCycleWorkerPort {
  issueWorkerInvoiceForCycle(
    params: BillingCycleWorkerIssueParams,
  ): Promise<BillingCycleWorkerIssueResult>;
}

export const OUTBOX_MAX_ATTEMPTS = 8;

export function computeOutboxBackoffDelaySeconds(
  attemptCount: number,
  jitterSeconds = 0,
): number {
  const clampedAttempt = Math.max(1, Math.min(20, Math.trunc(attemptCount)));
  const baseDelay = Math.min(3600, Math.pow(2, clampedAttempt) * 5);
  const safeJitter = Math.max(0, Math.min(5, Math.trunc(jitterSeconds)));
  return Math.min(3600, baseDelay + safeJitter);
}

export * from './billing-engine';
