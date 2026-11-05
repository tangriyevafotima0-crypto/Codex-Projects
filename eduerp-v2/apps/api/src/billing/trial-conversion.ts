/**
 * EduERP v2.0 — Stage 08, Step 08.03 (`T08.03`):
 * Trial Enrollment Conversion on 2nd Distinct Eligible Attendance (`TrialConversionService`).
 *
 * Key Invariants:
 * 1. Source of truth is canonical PostgreSQL `attendance_records` joined with `lesson_occurrences` and `enrollments`
 *    (never an unverified HTTP body count!).
 * 2. Only `attendance_records` with `status IN ('PRESENT', 'LATE')` on lessons where
 *    `isLessonEligibleForOperationalTriggers(lesson.status).eligible_for_trial_conversion === true`
 *    (`SCHEDULED` or `COMPLETED` — never `CANCELLED_BY_CENTER` or `RESCHEDULED`) count as eligible trial attendance.
 * 3. 1st distinct attended lesson records `first_trial_lesson_id` and `first_trial_date` on `enrollments` while keeping
 *    `enrollments.status = 'TRIAL'` and creating ZERO `trial_activations`, ZERO `billing_cycles`, and ZERO `invoices` (`0` debt).
 * 4. 2nd distinct attended lesson (`secondLesson.lesson_id !== firstLesson.lesson_id`) atomically in a single transaction:
 *    - Activates `enrollments` (`status = 'ACTIVE'`, `activated_at = now`).
 *    - Issues exactly one `BillingCycle` + `Invoice` + `InvoiceLine` + `LedgerEntry` (`INVOICE_ISSUED`) starting from
 *      `first_trial_date` (`firstLesson.lesson_date`, NOT the 2nd lesson date!).
 *    - Inserts `TrialActivation` (`status = 'ACTIVE_ACTIVATION'`, `trial_activation_seq = COALESCE(MAX(seq), 0) + 1`)
 *      and `OutboxEvent` (`TrialActivated` v1).
 * 5. Retrying the same attendance event, submitting two commands on the same `lesson_id`, or racing two concurrent
 *    2nd-attendance evaluations produces at most ONE `ACTIVE_ACTIVATION` and ONE `Invoice`.
 * 6. Trial correction/compensation preserves immutable historical `invoices` / `ledger_entries` (never `DELETE`s them)
 *    and gates unconfirmed financial compensation formulas with `403 POLICY_DECISION_NOT_CONFIRMED` while providing
 *    deterministic `trial_activation_seq` progression (`seq + 1` after `COMPENSATED_VOID`).
 */

import { Inject, Injectable } from '@nestjs/common';
import type { BillingCycleType, BillingMode } from '@eduerp/contracts';
import * as crypto from 'node:crypto';
import { ApiHttpException } from '../auth/auth.errors';
import { ClockService } from '../auth/clock.service';
import { DatabaseService } from '../database/database.service';
import { runInTransaction, TransactionContext } from '../database/transaction';
import { isLessonEligibleForOperationalTriggers } from '../academics/academic-validation';
import {
  FaultInjectionStep,
  InvoiceGeneratorService,
  InvoiceResponseDto,
} from './invoice-generator';

export interface EligibleTrialAttendanceLesson {
  readonly lesson_id: string;
  readonly lesson_date: string;
  readonly occurrence_seq: number;
  readonly lesson_status: string;
  readonly attendance_id: string;
  readonly attendance_status: 'PRESENT' | 'LATE';
}

export type TrialConversionOutcomeStatus =
  | 'NO_ELIGIBLE_ATTENDANCE'
  | 'FIRST_TRIAL_RECORDED_NO_DEBT'
  | 'ACTIVATED_AND_INVOICED'
  | 'ALREADY_ACTIVE_NO_OP';

export interface TrialConversionEvaluationResult {
  readonly outcome: TrialConversionOutcomeStatus;
  readonly enrollment_id: string;
  readonly enrollment_status: string;
  readonly distinct_eligible_attended_count: number;
  readonly first_trial_lesson_id: string | null;
  readonly first_trial_date: string | null;
  readonly second_trigger_lesson_id: string | null;
  readonly trial_activation_id: string | null;
  readonly trial_activation_seq: number | null;
  readonly generated_invoice: InvoiceResponseDto | null;
}

export interface TrialActivationSequencePlan {
  readonly nextTrialActivationSeq: number;
  readonly hasActiveActivation: boolean;
  readonly activeActivationId: string | null;
  readonly compensatedVoidCount: number;
}

function formatPgDate(val: unknown): string {
  if (val instanceof Date) return val.toISOString().slice(0, 10);
  return String(val).slice(0, 10);
}

/**
 * Pure helper that deduplicates and orders candidate attendance records by `(lesson_date ASC, occurrence_seq ASC, lesson_id ASC)`,
 * keeping only `PRESENT`/`LATE` records on lessons eligible for trial conversion (`SCHEDULED` or `COMPLETED`).
 */
export function selectDistinctEligibleTrialLessons(
  candidates: readonly {
    readonly lesson_id: string;
    readonly lesson_date: string;
    readonly occurrence_seq: number;
    readonly lesson_status: string;
    readonly attendance_id: string;
    readonly attendance_status: string;
  }[],
): readonly EligibleTrialAttendanceLesson[] {
  const filtered = candidates.filter((c) => {
    if (c.attendance_status !== 'PRESENT' && c.attendance_status !== 'LATE') {
      return false;
    }
    const elig = isLessonEligibleForOperationalTriggers(
      c.lesson_status as 'SCHEDULED' | 'COMPLETED' | 'CANCELLED_BY_CENTER' | 'RESCHEDULED',
    );
    return elig.eligible_for_trial_conversion;
  });

  const sorted = [...filtered].sort((a, b) => {
    if (a.lesson_date !== b.lesson_date) {
      return a.lesson_date < b.lesson_date ? -1 : 1;
    }
    if (a.occurrence_seq !== b.occurrence_seq) {
      return a.occurrence_seq - b.occurrence_seq;
    }
    return a.lesson_id < b.lesson_id ? -1 : a.lesson_id > b.lesson_id ? 1 : 0;
  });

  const distinctByLesson: EligibleTrialAttendanceLesson[] = [];
  const seenLessonIds = new Set<string>();
  for (const item of sorted) {
    if (seenLessonIds.has(item.lesson_id)) continue;
    seenLessonIds.add(item.lesson_id);
    distinctByLesson.push(
      Object.freeze({
        lesson_id: item.lesson_id,
        lesson_date: item.lesson_date,
        occurrence_seq: item.occurrence_seq,
        lesson_status: item.lesson_status,
        attendance_id: item.attendance_id,
        attendance_status: item.attendance_status as 'PRESENT' | 'LATE',
      }),
    );
  }

  return Object.freeze(distinctByLesson);
}

/**
 * Pure sequence planner for `TrialActivation` (`ACTIVE_ACTIVATION` vs `COMPENSATED_VOID`),
 * ensuring reactivation after a compensated void increments `trial_activation_seq = max_seq + 1` (`CASE-06`).
 */
export function planNextTrialActivationSequence(
  existingActivations: readonly {
    readonly id: string;
    readonly trial_activation_seq: number;
    readonly status: 'ACTIVE_ACTIVATION' | 'COMPENSATED_VOID';
  }[],
): TrialActivationSequencePlan {
  let maxSeq = 0;
  let activeId: string | null = null;
  let compensatedCount = 0;

  for (const act of existingActivations) {
    if (act.trial_activation_seq > maxSeq) {
      maxSeq = act.trial_activation_seq;
    }
    if (act.status === 'ACTIVE_ACTIVATION') {
      activeId = act.id;
    } else if (act.status === 'COMPENSATED_VOID') {
      compensatedCount += 1;
    }
  }

  return Object.freeze({
    nextTrialActivationSeq: maxSeq + 1,
    hasActiveActivation: activeId !== null,
    activeActivationId: activeId,
    compensatedVoidCount: compensatedCount,
  });
}

function buildInitialCycleIdentityFromFirstTrialDate(
  billingMode: BillingMode,
  firstTrialDate: string,
): {
  readonly cycleType: BillingCycleType;
  readonly cycleKey: string;
  readonly periodStartDate: string;
} {
  if (billingMode === 'CALENDAR_PRO_RATA') {
    const ym = firstTrialDate.slice(0, 7);
    return {
      cycleType: 'CALENDAR_MONTH',
      cycleKey: `CAL:${ym}`,
      periodStartDate: `${ym}-01`,
    };
  }
  if (billingMode === 'ROLLING_MONTH') {
    return {
      cycleType: 'ROLLING_MONTH',
      cycleKey: `ROL:${firstTrialDate}`,
      periodStartDate: firstTrialDate,
    };
  }
  return {
    cycleType: 'LESSON_PACKAGE_12',
    cycleKey: 'PKG:1',
    periodStartDate: firstTrialDate,
  };
}

@Injectable()
export class TrialConversionService {
  constructor(
    @Inject(DatabaseService) private readonly databaseService: DatabaseService,
    @Inject(ClockService) private readonly clock: ClockService,
    @Inject(InvoiceGeneratorService)
    private readonly invoiceGenerator: InvoiceGeneratorService,
  ) {}

  public async evaluateTrialEnrollmentWithinTransaction(
    tx: TransactionContext,
    params: {
      readonly centerId: string;
      readonly enrollmentId: string;
      readonly actorType?: 'STAFF' | 'SYSTEM_WORKER';
      readonly actorStaffId?: string | null;
      readonly actorRole?: string | null;
      readonly systemJobName?: string | null;
      readonly requestId?: string;
      readonly testFaultAfterStep?: FaultInjectionStep | 'TRIAL_ACTIVATION';
    },
  ): Promise<TrialConversionEvaluationResult> {
    const now = this.clock.now();
    const actorType = params.actorType ?? 'SYSTEM_WORKER';
    const actorStaffId = params.actorStaffId ?? null;
    const actorRole = params.actorRole ?? null;
    const systemJobName =
      params.systemJobName ?? (actorType === 'SYSTEM_WORKER' ? 'TrialConversionConsumer' : null);
    const requestId = params.requestId ?? `trial-conv-${crypto.randomUUID()}`;

    // 1. Lock enrollment row FOR UPDATE so concurrent 2nd-attendance evaluations serialize cleanly
    const enrRes = await tx.query<{
      id: string;
      center_id: string;
      student_id: string;
      group_id: string;
      status: string;
      first_trial_lesson_id: string | null;
      first_trial_date: unknown;
      version: number;
    }>(
      `SELECT "id"::text AS id,
              "center_id"::text AS center_id,
              "student_id"::text AS student_id,
              "group_id"::text AS group_id,
              "status"::text AS status,
              "first_trial_lesson_id"::text AS first_trial_lesson_id,
              "first_trial_date"::text AS first_trial_date,
              "version"
         FROM "enrollments"
        WHERE "id" = $1::uuid
          AND "center_id" = $2::uuid
        FOR UPDATE`,
      [params.enrollmentId, params.centerId],
    );

    const enrollment = enrRes.rows[0];
    if (!enrollment) {
      throw new ApiHttpException({
        statusCode: 404,
        errorCode: 'NOT_FOUND',
        message: 'Enrollment not found in center scope',
      });
    }

    // 2. Check existing trial_activations for this enrollment
    const existingActRes = await tx.query<{
      id: string;
      trial_activation_seq: number;
      first_trial_lesson_id: string;
      second_trigger_lesson_id: string;
      generated_invoice_id: string;
      status: 'ACTIVE_ACTIVATION' | 'COMPENSATED_VOID';
    }>(
      `SELECT "id"::text AS id,
              "trial_activation_seq",
              "first_trial_lesson_id"::text AS first_trial_lesson_id,
              "second_trigger_lesson_id"::text AS second_trigger_lesson_id,
              "generated_invoice_id"::text AS generated_invoice_id,
              "status"::text AS status
         FROM "trial_activations"
        WHERE "center_id" = $1::uuid
          AND "enrollment_id" = $2::uuid
        ORDER BY "trial_activation_seq" ASC`,
      [params.centerId, params.enrollmentId],
    );

    const seqPlan = planNextTrialActivationSequence(existingActRes.rows);
    const activeActivation = existingActRes.rows.find((a) => a.status === 'ACTIVE_ACTIVATION');

    if (activeActivation || enrollment.status === 'ACTIVE') {
      const existingInv = activeActivation
        ? await this.invoiceGenerator.loadInvoiceResponseInTx(
            tx,
            params.centerId,
            activeActivation.generated_invoice_id,
          )
        : null;

      return Object.freeze({
        outcome: 'ALREADY_ACTIVE_NO_OP',
        enrollment_id: enrollment.id,
        enrollment_status: enrollment.status,
        distinct_eligible_attended_count: 2,
        first_trial_lesson_id:
          activeActivation?.first_trial_lesson_id ?? enrollment.first_trial_lesson_id,
        first_trial_date: enrollment.first_trial_date
          ? formatPgDate(enrollment.first_trial_date)
          : null,
        second_trigger_lesson_id: activeActivation?.second_trigger_lesson_id ?? null,
        trial_activation_id: activeActivation?.id ?? null,
        trial_activation_seq: activeActivation ? Number(activeActivation.trial_activation_seq) : null,
        generated_invoice: existingInv,
      });
    }

    if (enrollment.status !== 'TRIAL') {
      throw new ApiHttpException({
        statusCode: 422,
        errorCode: 'VALIDATION_ERROR',
        message: `Cannot evaluate trial conversion for enrollment in status '${enrollment.status}'`,
      });
    }

    // 3. Query canonical attendance_records joined with lesson_occurrences in the enrollment's group
    const attRes = await tx.query<{
      lesson_id: string;
      lesson_date: unknown;
      occurrence_seq: number;
      lesson_status: string;
      attendance_id: string;
      attendance_status: string;
    }>(
      `SELECT lo."id"::text AS lesson_id,
              lo."lesson_date"::text AS lesson_date,
              lo."occurrence_seq",
              lo."status"::text AS lesson_status,
              ar."id"::text AS attendance_id,
              ar."status"::text AS attendance_status
         FROM "attendance_records" ar
         JOIN "lesson_occurrences" lo
           ON lo."id" = ar."lesson_id"
          AND lo."center_id" = ar."center_id"
        WHERE ar."center_id" = $1::uuid
          AND ar."enrollment_id" = $2::uuid
          AND ar."student_id" = $3::uuid
          AND lo."group_id" = $4::uuid
        ORDER BY lo."lesson_date" ASC, lo."occurrence_seq" ASC, lo."starts_at_utc" ASC, lo."id" ASC`,
      [params.centerId, enrollment.id, enrollment.student_id, enrollment.group_id],
    );

    const eligibleLessons = selectDistinctEligibleTrialLessons(
      attRes.rows.map((r) => ({
        lesson_id: r.lesson_id,
        lesson_date: formatPgDate(r.lesson_date),
        occurrence_seq: Number(r.occurrence_seq),
        lesson_status: r.lesson_status,
        attendance_id: r.attendance_id,
        attendance_status: r.attendance_status,
      })),
    );

    if (eligibleLessons.length === 0) {
      return Object.freeze({
        outcome: 'NO_ELIGIBLE_ATTENDANCE',
        enrollment_id: enrollment.id,
        enrollment_status: 'TRIAL',
        distinct_eligible_attended_count: 0,
        first_trial_lesson_id: enrollment.first_trial_lesson_id,
        first_trial_date: enrollment.first_trial_date
          ? formatPgDate(enrollment.first_trial_date)
          : null,
        second_trigger_lesson_id: null,
        trial_activation_id: null,
        trial_activation_seq: null,
        generated_invoice: null,
      });
    }

    const firstLesson = eligibleLessons[0];

    // 4. Only 1 distinct eligible attended lesson -> record first_trial_lesson_id & first_trial_date, ZERO debt/invoice!
    if (eligibleLessons.length === 1) {
      if (
        enrollment.first_trial_lesson_id !== firstLesson.lesson_id ||
        (enrollment.first_trial_date ? formatPgDate(enrollment.first_trial_date) : null) !==
          firstLesson.lesson_date
      ) {
        await tx.query(
          `UPDATE "enrollments"
              SET "first_trial_lesson_id" = $1::uuid,
                  "first_trial_date" = $2::date,
                  "version" = "version" + 1,
                  "updated_at" = $3::timestamptz
            WHERE "id" = $4::uuid
              AND "center_id" = $5::uuid`,
          [
            firstLesson.lesson_id,
            firstLesson.lesson_date,
            now.toISOString(),
            enrollment.id,
            params.centerId,
          ],
        );
      }

      return Object.freeze({
        outcome: 'FIRST_TRIAL_RECORDED_NO_DEBT',
        enrollment_id: enrollment.id,
        enrollment_status: 'TRIAL',
        distinct_eligible_attended_count: 1,
        first_trial_lesson_id: firstLesson.lesson_id,
        first_trial_date: firstLesson.lesson_date,
        second_trigger_lesson_id: null,
        trial_activation_id: null,
        trial_activation_seq: null,
        generated_invoice: null,
      });
    }

    // 5. 2nd distinct eligible attended lesson -> activate enrollment & issue invoice from first_trial_date!
    const secondLesson = eligibleLessons[1];

    const grpRes = await tx.query<{ billing_mode: BillingMode }>(
      `SELECT "billing_mode"::text AS billing_mode
         FROM "course_groups"
        WHERE "id" = $1::uuid
          AND "center_id" = $2::uuid
        LIMIT 1`,
      [enrollment.group_id, params.centerId],
    );
    const groupBillingMode = grpRes.rows[0]?.billing_mode ?? 'CALENDAR_PRO_RATA';

    // Update enrollment to ACTIVE with first_trial_lesson_id and first_trial_date BEFORE issuing invoice
    await tx.query(
      `UPDATE "enrollments"
          SET "status" = 'ACTIVE',
              "first_trial_lesson_id" = $1::uuid,
              "first_trial_date" = $2::date,
              "activated_at" = $3::timestamptz,
              "version" = "version" + 1,
              "updated_at" = $3::timestamptz
        WHERE "id" = $4::uuid
          AND "center_id" = $5::uuid`,
      [
        firstLesson.lesson_id,
        firstLesson.lesson_date,
        now.toISOString(),
        enrollment.id,
        params.centerId,
      ],
    );

    const initialCycle = buildInitialCycleIdentityFromFirstTrialDate(
      groupBillingMode,
      firstLesson.lesson_date,
    );

    const { invoice } = await this.invoiceGenerator.issueCycleInvoiceWithinTransaction(tx, {
      centerId: params.centerId,
      enrollmentId: enrollment.id,
      cycleType: initialCycle.cycleType,
      cycleKey: initialCycle.cycleKey,
      periodStartDate: initialCycle.periodStartDate,
      periodEndDate: null,
      applyAvailableCreditNotes: true,
      actorType,
      actorStaffId,
      actorRole,
      systemJobName,
      requestId,
      now,
      overrideBillingStartDate: firstLesson.lesson_date,
      testFaultAfterStep:
        params.testFaultAfterStep && params.testFaultAfterStep !== 'TRIAL_ACTIVATION'
          ? params.testFaultAfterStep
          : undefined,
    });

    const trialActivationId = crypto.randomUUID();
    const activationSeq = seqPlan.nextTrialActivationSeq;

    await tx.query(
      `INSERT INTO "trial_activations" (
         "id", "center_id", "enrollment_id", "trial_activation_seq",
         "first_trial_lesson_id", "second_trigger_lesson_id",
         "generated_invoice_id", "status", "version",
         "created_at", "updated_at"
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::int,
         $5::uuid, $6::uuid,
         $7::uuid, 'ACTIVE_ACTIVATION', 1,
         $8::timestamptz, $8::timestamptz
       )`,
      [
        trialActivationId,
        params.centerId,
        enrollment.id,
        activationSeq,
        firstLesson.lesson_id,
        secondLesson.lesson_id,
        invoice.invoice_id,
        now.toISOString(),
      ],
    );

    if (params.testFaultAfterStep === 'TRIAL_ACTIVATION') {
      throw new Error('SIMULATED_S08_FAULT_AFTER_TRIAL_ACTIVATION');
    }

    // Queue canonical TrialActivated v1 outbox event (docs/architecture/events.md#evt-TrialActivated)
    await tx.query(
      `INSERT INTO "outbox_events" (
         "id", "center_id", "event_name", "schema_version",
         "aggregate_type", "aggregate_id", "aggregate_version",
         "dedup_key", "payload_json", "status",
         "next_attempt_at", "occurred_at_utc", "updated_at"
       ) VALUES (
         $1::uuid, $2::uuid, 'TrialActivated', 1,
         'TrialActivation', $3::uuid, $4::int,
         $5, $6::jsonb, 'PENDING',
         $7::timestamptz, $7::timestamptz, $7::timestamptz
       )`,
      [
        crypto.randomUUID(),
        params.centerId,
        trialActivationId,
        activationSeq,
        `TrialActivated:${enrollment.id}:seq:${activationSeq}`,
        JSON.stringify({
          trial_activation_id: trialActivationId,
          enrollment_id: enrollment.id,
          student_id: enrollment.student_id,
          group_id: enrollment.group_id,
          trial_activation_seq: activationSeq,
          first_trial_lesson_id: firstLesson.lesson_id,
          first_trial_date: firstLesson.lesson_date,
          second_trigger_lesson_id: secondLesson.lesson_id,
          generated_invoice_id: invoice.invoice_id,
        }),
        now.toISOString(),
      ],
    );

    await tx.query(
      `INSERT INTO "audit_logs" (
         "id", "center_id", "actor_type", "actor_id", "actor_role",
         "action", "entity_type", "entity_id", "severity",
         "after_redacted_json", "request_id", "created_at"
       ) VALUES (
         $1::uuid, $2::uuid, $3, $4::uuid, $5,
         'TRIAL_ENROLLMENT_ACTIVATED', 'TrialActivation', $6::uuid, 'INFO',
         $7::jsonb, $8, $9::timestamptz
       )`,
      [
        crypto.randomUUID(),
        params.centerId,
        actorType,
        actorStaffId,
        actorRole,
        trialActivationId,
        JSON.stringify({
          trial_activation_id: trialActivationId,
          enrollment_id: enrollment.id,
          trial_activation_seq: activationSeq,
          first_trial_lesson_id: firstLesson.lesson_id,
          first_trial_date: firstLesson.lesson_date,
          second_trigger_lesson_id: secondLesson.lesson_id,
          generated_invoice_id: invoice.invoice_id,
        }),
        requestId,
        now.toISOString(),
      ],
    );

    return Object.freeze({
      outcome: 'ACTIVATED_AND_INVOICED',
      enrollment_id: enrollment.id,
      enrollment_status: 'ACTIVE',
      distinct_eligible_attended_count: eligibleLessons.length,
      first_trial_lesson_id: firstLesson.lesson_id,
      first_trial_date: firstLesson.lesson_date,
      second_trigger_lesson_id: secondLesson.lesson_id,
      trial_activation_id: trialActivationId,
      trial_activation_seq: activationSeq,
      generated_invoice: invoice,
    });
  }

  public async evaluateTrialEnrollmentAttendance(params: {
    readonly centerId: string;
    readonly enrollmentId: string;
    readonly actorType?: 'STAFF' | 'SYSTEM_WORKER';
    readonly actorStaffId?: string | null;
    readonly actorRole?: string | null;
    readonly systemJobName?: string | null;
    readonly requestId?: string;
    readonly testFaultAfterStep?: FaultInjectionStep | 'TRIAL_ACTIVATION';
  }): Promise<TrialConversionEvaluationResult> {
    const { result } = await runInTransaction(this.databaseService, async (tx) => {
      return this.evaluateTrialEnrollmentWithinTransaction(tx, params);
    });
    return result;
  }

  /**
   * Trial Correction / Compensation Boundary (08.03):
   * - Never deletes or overwrites historical `invoices` or `ledger_entries`.
   * - Since Stage 09 (`09.02`/`09.03`) compensation/credit-note adjustment formulas are still open (`DECISION_REQUIRED`),
   *   requesting an unconfirmed financial trial compensation mutation fails closed with `403 POLICY_DECISION_NOT_CONFIRMED`
   *   and zero financial side effects.
   */
  public async requestTrialActivationCompensation(params: {
    readonly centerId: string;
    readonly enrollmentId: string;
    readonly reason: string;
  }): Promise<never> {
    void params;
    throw new ApiHttpException({
      statusCode: 403,
      errorCode: 'POLICY_DECISION_NOT_CONFIRMED',
      message:
        'Financial trial activation compensation / CreditNote voiding formula is gated by unconfirmed policy decisions (D14 / Stage 09); historical invoices and ledger entries remain immutable',
    });
  }
}
