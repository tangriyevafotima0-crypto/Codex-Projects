/**
 * EduERP v2.0 — Stage 13, Step 13.04 (`T13.04`, `BR-03`, `BR-08`, `BR-09`, `BR-15`, `D14`, `OWNER-20261104-03`, `OWNER-20261105-04`, `S13FIX-T` / `T02`):
 * Idempotent Scheduled Jobs Runner & Shared Canonical Billing Cycle Engine (`CanonicalSqlBillingCycleWorkerPort`):
 * 1. `CanonicalSqlBillingCycleWorkerPort`: Thin adapter delegating directly to the single shared canonical
 *    `executeCanonicalBillingCycleIssuanceInTx` in `@eduerp/contracts` (the exact same engine called by
 *    `apps/api/src/billing/invoice-generator.ts`), eliminating any duplicated worker billing math or SQL.
 * 2. `runBillingCycleCutoffAndCatchUpJob`: Enforces durable DB-backed bounded catch-up eligibility windows:
 *    - `CURRENT_CYCLE_ONLY`: Issues ONLY cycles whose service period covers the current cutoff reference date
 *      (`nextStart <= referenceDate && referenceDate <= nextEnd`). Never drains or issues historical past cycles
 *      (`nextEnd < referenceDate`) across repeated polls, concurrent workers, or restarts (`0` extra cycles/debt).
 *    - `PREVIOUS_AND_CURRENT_CYCLE`: Issues at most the `[previous, current]` 2-cycle window covering `referenceDate`.
 *      Enrollments with unconfirmed first cycles older than the permissible catch-up window are gated and logged via
 *      idempotent `BILLING_HISTORICAL_RECONCILIATION_DEFERRED`.
 * 3. `runUnclosedCashShiftReminderJob`: Enforces live `center_licenses` (`READ_ONLY` blocked) and flags `OPEN`
 *    cash shifts without ever fabricating `counted_closing_cash_uzs` or auto-closing a shift (`BR-09`, `13.04`).
 * 4. `runTrialNoShowFollowUpJob`: Enforces live `center_licenses` (`READ_ONLY` blocked) and explicit confirmed
 *    center policy (`CONFIRMED_SECOND_ABSENCE_ADMIN_FOLLOWUP`); creates idempotent Admin follow-up alerts
 *    without converting `TRIAL` to `ACTIVE`, creating invoices, or mutating attendance.
 */

import * as crypto from 'node:crypto';
import {
  addCanonicalCalendarDaysToIsoDate,
  BillingCycleWorkerIssueParams,
  BillingCycleWorkerIssueResult,
  BillingCycleWorkerPort,
  computeCanonicalNextRollingRenewalDate,
  daysInCanonicalGregorianMonth,
  executeCanonicalBillingCycleIssuanceInTx,
  formatCanonicalIsoDateParts,
  formatCanonicalPgDate,
  isCanonicalGregorianLeapYear,
  parseCanonicalIsoDateParts,
  RollingMonthEndMode,
} from '@eduerp/contracts';
import { WorkerEnvConfig } from './config/env';
import {
  formatCenterLocalDateParts,
  WorkerDatabase,
} from './database';

export type BillingCatchUpPolicyMode =
  | 'CURRENT_CYCLE_ONLY'
  | 'PREVIOUS_AND_CURRENT_CYCLE'
  | 'UNCONFIRMED_ALL_HISTORICAL_PERIODS';

export type TrialNoShowFollowUpPolicyMode =
  | 'UNCONFIGURED'
  | 'CONFIRMED_SECOND_ABSENCE_ADMIN_FOLLOWUP';

export interface BillingScheduleRunResult {
  readonly jobIdentityKey: string;
  readonly deduplicatedJobWindow: boolean;
  readonly invoicesIssuedCount: number;
  readonly invoicesReplayedCount: number;
  readonly skippedTrialOrIneligibleCount: number;
  readonly issuedInvoiceIds: readonly string[];
}

export interface UnclosedShiftReminderRunResult {
  readonly jobIdentityKey: string;
  readonly flaggedShiftIds: readonly string[];
  readonly shiftsAutoClosedCount: 0;
}

export interface TrialNoShowFollowUpRunResult {
  readonly jobIdentityKey: string;
  readonly followUpEnrollmentsFlagged: readonly string[];
  readonly invoicesCreatedCount: 0;
}

export const parseIsoDateParts = parseCanonicalIsoDateParts;
export const formatIsoDateParts = formatCanonicalIsoDateParts;
export const isGregorianLeapYear = isCanonicalGregorianLeapYear;
export const daysInGregorianMonth = daysInCanonicalGregorianMonth;
export const addCalendarDaysToIsoDate = addCanonicalCalendarDaysToIsoDate;
export const computeNextRollingRenewalDate = computeCanonicalNextRollingRenewalDate;

/**
 * T02 Single Canonical BillingCycleWorkerPort:
 * Delegates directly to `executeCanonicalBillingCycleIssuanceInTx` from `@eduerp/contracts` — the exact same
 * transactional SQL billing engine used by `apps/api/src/billing/invoice-generator.ts`.
 */
export class CanonicalSqlBillingCycleWorkerPort implements BillingCycleWorkerPort {
  constructor(
    private readonly db: WorkerDatabase,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  public async issueWorkerInvoiceForCycle(
    params: BillingCycleWorkerIssueParams,
  ): Promise<BillingCycleWorkerIssueResult> {
    const nowUtc = this.clock();

    return this.db.runInTransaction(async (tx) => {
      const { invoice, replayedByCycleIdentity } =
        await executeCanonicalBillingCycleIssuanceInTx(tx, {
          centerId: params.centerId,
          enrollmentId: params.enrollmentId,
          cycleType: params.cycleType,
          cycleKey: params.cycleKey,
          periodStartDate: params.periodStartDate,
          periodEndDate: params.periodEndDate ?? null,
          applyAvailableCreditNotes: true,
          actorType: 'SYSTEM_WORKER',
          actorStaffId: null,
          actorRole: null,
          systemJobName: params.systemJobName,
          requestId: `wrk-bill-${crypto.randomUUID().slice(0, 12)}`,
          now: nowUtc,
          requireActiveEnrollment: true,
          enableTestFaultInjection: true,
          testFaultAfterStep: params.testFaultAfterStep,
        });

      return {
        invoice: {
          invoice_id: invoice.invoice_id,
          invoice_number: invoice.invoice_number,
          student_id: invoice.student_id,
          enrollment_id: invoice.enrollment_id,
          billing_cycle_id: invoice.billing_cycle_id,
          effective_net_charge_uzs: invoice.effective_net_charge_uzs,
          remaining_debt_uzs: invoice.remaining_debt_uzs,
          status: invoice.status,
        },
        replayedByCycleIdentity,
      };
    });
  }
}

export class SchedulesWorker {
  private readonly billingCyclePort: BillingCycleWorkerPort;

  constructor(
    private readonly config: WorkerEnvConfig,
    private readonly db: WorkerDatabase,
    billingCyclePort?: BillingCycleWorkerPort,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.billingCyclePort =
      billingCyclePort ?? new CanonicalSqlBillingCycleWorkerPort(this.db, this.clock);
  }

  /**
   * Resolves the calendar month window (`YYYY-MM`, `YYYY-MM-01`, `YYYY-MM-<lastDay>`) from `cycleKey`
   * or `periodStartDate`, computing `lastDay` from the target cycle's year and month (including leap-year Feb 29).
   */
  private resolveCalendarMonthWindow(params: {
    readonly cycleKey?: string;
    readonly periodStartDate?: string;
    readonly periodEndDate?: string;
    readonly defaultYear: number;
    readonly defaultMonth: number;
  }): {
    readonly cycleKey: string;
    readonly periodStartDate: string;
    readonly periodEndDate: string;
    readonly year: number;
    readonly month: number;
  } {
    let year = params.defaultYear;
    let month = params.defaultMonth;
    const rawKey = params.cycleKey?.trim();

    if (params.periodStartDate) {
      const p = parseCanonicalIsoDateParts(params.periodStartDate);
      year = p.year;
      month = p.month;
    } else if (rawKey) {
      const m = /^(?:CAL:)?(\d{4})-(\d{2})$/.exec(rawKey);
      if (m) {
        year = Number(m[1]);
        month = Number(m[2]);
      }
    }

    const ym = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`;
    const cycleKey = rawKey ?? ym;
    const periodStartDate = params.periodStartDate ?? `${ym}-01`;
    const lastDay = daysInCanonicalGregorianMonth(year, month);
    const periodEndDate = params.periodEndDate ?? formatCanonicalIsoDateParts(year, month, lastDay);

    return { cycleKey, periodStartDate, periodEndDate, year, month };
  }

  private async recordDeferredHistoricalReconciliationAudit(params: {
    readonly enrollmentId: string;
    readonly billingMode: string;
    readonly enrolledAtDate: string;
    readonly nextCandidateStartDate: string;
    readonly nextCandidateEndDate: string | null;
    readonly referenceDate: string;
    readonly catchUpPolicy: BillingCatchUpPolicyMode;
    readonly nowUtc: Date;
  }): Promise<void> {
    const reqId = `hist-defer-${params.enrollmentId.slice(0, 8)}-${params.referenceDate}`.slice(
      0,
      64,
    );
    await this.db.runInTransaction(async (tx) => {
      const existing = await tx.query<{ id: string }>(
        `SELECT "id"::text AS id
           FROM "audit_logs"
          WHERE "center_id" = $1::uuid
            AND "action" = 'BILLING_HISTORICAL_RECONCILIATION_DEFERRED'
            AND "entity_id" = $2::uuid
            AND "request_id" = $3
          LIMIT 1`,
        [this.config.centerId, params.enrollmentId, reqId],
      );
      if (existing.rows.length > 0) {
        return;
      }
      await tx.query(
        `INSERT INTO "audit_logs" (
           "id", "center_id", "actor_type", "actor_id", "actor_role",
           "action", "entity_type", "entity_id", "severity",
           "before_redacted_json", "after_redacted_json", "request_id", "created_at"
         ) VALUES (
           $1::uuid, $2::uuid, 'SYSTEM_WORKER', NULL, NULL,
           'BILLING_HISTORICAL_RECONCILIATION_DEFERRED', 'Enrollment', $3::uuid, 'WARN',
           NULL, $4::jsonb, $5, $6::timestamptz
         )`,
        [
          crypto.randomUUID(),
          this.config.centerId,
          params.enrollmentId,
          JSON.stringify({
            enrollment_id: params.enrollmentId,
            billing_mode: params.billingMode,
            enrolled_at_date: params.enrolledAtDate,
            candidate_period_start_date: params.nextCandidateStartDate,
            candidate_period_end_date: params.nextCandidateEndDate,
            reference_date: params.referenceDate,
            catch_up_policy: params.catchUpPolicy,
            reason: 'OUTSIDE_BOUNDED_CATCHUP_WINDOW',
          }),
          reqId,
          params.nowUtc.toISOString(),
        ],
      );
    });
  }

  /**
   * 13.04 Billing Cycle Cutoff & Bounded Catch-Up Job (`S05`, `S13FIX-T` / `T02`):
   * - Serializes via `pg_advisory_xact_lock` on `(center_id, jobIdentityKey)` and per-enrollment `FOR UPDATE`
   *   so two concurrent workers never duplicate cycle generation.
   * - Rejects `READ_ONLY` (or missing) center licenses and unconfirmed `UNCONFIRMED_ALL_HISTORICAL_PERIODS` catch-up policies.
   * - Enforces durable DB-backed bounded catch-up eligibility horizon:
   *   * `CURRENT_CYCLE_ONLY`: Only issues a cycle whose service period covers `referenceDate`
   *     (`candidateStart <= referenceDate && referenceDate <= candidateEnd`). Past unissued cycles
   *     (`candidateEnd < referenceDate`) are NEVER drained or issued incrementally across polls or restarts!
   *   * `PREVIOUS_AND_CURRENT_CYCLE`: Issues at most `[previous, current]` covering `referenceDate`.
   *   * Unconfirmed first-cycle enrollments whose `enrolled_at_date` precedes the permissible catch-up window
   *     are blocked from automatic catch-up and logged once via `BILLING_HISTORICAL_RECONCILIATION_DEFERRED`.
   */
  public async runBillingCycleCutoffAndCatchUpJob(options: {
    readonly nowUtc?: Date;
    readonly cycleKey?: string;
    readonly periodStartDate?: string;
    readonly periodEndDate?: string;
    readonly catchUpPolicy?: BillingCatchUpPolicyMode;
  } = {}): Promise<BillingScheduleRunResult> {
    const nowUtc = options.nowUtc ?? this.clock();
    const catchUpPolicy = options.catchUpPolicy ?? 'CURRENT_CYCLE_ONLY';

    if (catchUpPolicy === 'UNCONFIRMED_ALL_HISTORICAL_PERIODS') {
      throw new Error(
        'POLICY_DECISION_NOT_CONFIRMED: Unbounded retroactive billing catch-up across all historical periods is not confirmed (13.04)',
      );
    }

    const liveLicenseMode = await this.db.resolveLiveCenterLicenseMode();
    if (liveLicenseMode === 'READ_ONLY') {
      throw new Error(
        'LICENSE_READ_ONLY_MODE: Scheduled financial billing mutations are blocked while center license is in READ_ONLY mode (BR-15, 13.04)',
      );
    }

    const localParts = formatCenterLocalDateParts(nowUtc, this.config.centerTimezone);
    const currentCalWindow = this.resolveCalendarMonthWindow({
      cycleKey: options.cycleKey,
      periodStartDate: options.periodStartDate,
      periodEndDate: options.periodEndDate,
      defaultYear: localParts.year,
      defaultMonth: localParts.month,
    });

    const calendarWindowsToRun: Array<{
      readonly cycleKey: string;
      readonly periodStartDate: string;
      readonly periodEndDate: string;
    }> = [];

    if (catchUpPolicy === 'PREVIOUS_AND_CURRENT_CYCLE') {
      const prevYear =
        currentCalWindow.month === 1 ? currentCalWindow.year - 1 : currentCalWindow.year;
      const prevMonth = currentCalWindow.month === 1 ? 12 : currentCalWindow.month - 1;
      const prevWindow = this.resolveCalendarMonthWindow({
        defaultYear: prevYear,
        defaultMonth: prevMonth,
      });
      calendarWindowsToRun.push(prevWindow);
    }
    calendarWindowsToRun.push(currentCalWindow);

    const earliestPermissibleCalStart = calendarWindowsToRun[0].periodStartDate;
    const referenceDate =
      options.periodStartDate ??
      (localParts.localDate >= currentCalWindow.periodStartDate &&
      localParts.localDate <= currentCalWindow.periodEndDate
        ? localParts.localDate
        : currentCalWindow.periodStartDate);

    const jobIdentityKey = `ScheduledJob:${this.config.centerId}:BILLING_CUTOFF:${currentCalWindow.cycleKey}`;

    // Verify confirmed billing policy exists for center before scanning enrollments
    const policyRes = await this.db.query<{
      id: string;
      policy_confirmation_status: string;
      first_partial_charge_mode: string;
      rolling_month_end_mode: RollingMonthEndMode;
      effective_from_date: string | null;
    }>(
      `SELECT "id"::text AS id,
              "policy_confirmation_status"::text AS policy_confirmation_status,
              "first_partial_charge_mode"::text AS first_partial_charge_mode,
              "rolling_month_end_mode"::text AS rolling_month_end_mode,
              "effective_from_date"::text AS effective_from_date
         FROM "billing_policy_versions"
        WHERE "center_id" = $1::uuid
          AND "policy_confirmation_status" = 'CONFIRMED'
          AND "effective_from_date" IS NOT NULL
          AND "effective_from_date" <= $2::date
        ORDER BY "version_number" DESC
        LIMIT 1`,
      [this.config.centerId, currentCalWindow.periodStartDate],
    );
    const activePolicy = policyRes.rows[0];
    if (!activePolicy) {
      throw new Error(
        'POLICY_DECISION_NOT_CONFIRMED: Center billing policy is not CONFIRMED or effective for the requested billing cycle window (13.04)',
      );
    }

    const enrollmentsRes = await this.db.query<{
      enrollment_id: string;
      enrollment_status: string;
      enrolled_at_date: string;
      first_trial_date: string | null;
      left_at_date: string | null;
      package_lessons_remaining: number | null;
      billing_mode: string;
    }>(
      `SELECT e."id"::text AS enrollment_id,
              e."status"::text AS enrollment_status,
              e."enrolled_at_date"::text AS enrolled_at_date,
              e."first_trial_date"::text AS first_trial_date,
              e."left_at_date"::text AS left_at_date,
              e."package_lessons_remaining",
              cg."billing_mode"::text AS billing_mode
         FROM "enrollments" e
         JOIN "course_groups" cg
           ON cg."id" = e."group_id"
          AND cg."center_id" = e."center_id"
         JOIN "students" s
           ON s."id" = e."student_id"
          AND s."center_id" = e."center_id"
        WHERE e."center_id" = $1::uuid
          AND cg."status" = 'ACTIVE'
          AND s."status" = 'ACTIVE'
        ORDER BY e."id" ASC`,
      [this.config.centerId],
    );

    const issuedInvoiceIds: string[] = [];
    let invoicesIssuedCount = 0;
    let invoicesReplayedCount = 0;
    let skippedTrialOrIneligibleCount = 0;

    for (const enr of enrollmentsRes.rows) {
      const enrolledAtStr = String(enr.first_trial_date ?? enr.enrolled_at_date).slice(0, 10);
      const leftAtStr = formatCanonicalPgDate(enr.left_at_date);

      if (enr.enrollment_status !== 'ACTIVE') {
        skippedTrialOrIneligibleCount += 1;
        continue;
      }

      if (enr.billing_mode === 'ROLLING_MONTH') {
        const prevRolRes = await this.db.query<{
          cycle_key: string;
          cycle_seq: number;
          period_start_date: unknown;
          period_end_date: unknown;
        }>(
          `SELECT "cycle_key", "cycle_seq", "period_start_date", "period_end_date"
             FROM "billing_cycles"
            WHERE "center_id" = $1::uuid
              AND "enrollment_id" = $2::uuid
              AND "cycle_type" = 'ROLLING_MONTH'
            ORDER BY "cycle_seq" DESC`,
          [this.config.centerId, enr.enrollment_id],
        );

        if (enrolledAtStr > referenceDate) {
          skippedTrialOrIneligibleCount += 1;
          continue;
        }

        const latestRow = prevRolRes.rows[0] ?? null;
        const latestEnd = latestRow ? formatCanonicalPgDate(latestRow.period_end_date) : null;

        // If the latest issued rolling cycle already covers referenceDate, replay it idempotently
        if (latestRow && latestEnd && latestEnd >= referenceDate) {
          const latestStart = formatCanonicalPgDate(latestRow.period_start_date) ?? enrolledAtStr;
          if (latestStart <= referenceDate) {
            const issueRes = await this.billingCyclePort.issueWorkerInvoiceForCycle({
              centerId: this.config.centerId,
              enrollmentId: enr.enrollment_id,
              cycleType: 'ROLLING_MONTH',
              cycleKey: latestRow.cycle_key,
              periodStartDate: latestStart,
              periodEndDate: latestEnd,
              systemJobName: `SchedulesWorker:${jobIdentityKey}`.slice(0, 64),
            });
            if (issueRes.replayedByCycleIdentity) {
              invoicesReplayedCount += 1;
            }
            continue;
          }
        }

        // Determine the next unissued cycle in the rolling chain
        const nextCandidateStart = latestEnd
          ? addCanonicalCalendarDaysToIsoDate(latestEnd, 1)
          : enrolledAtStr;

        if (leftAtStr && nextCandidateStart > leftAtStr) {
          skippedTrialOrIneligibleCount += 1;
          continue;
        }

        const firstCandidate = computeCanonicalNextRollingRenewalDate(
          nextCandidateStart,
          activePolicy.rolling_month_end_mode,
        );
        const firstCandidateEnd = firstCandidate.inclusivePeriodEndDate;

        // Case 1: The next unissued cycle covers referenceDate -> it IS the current cycle!
        if (nextCandidateStart <= referenceDate && referenceDate <= firstCandidateEnd) {
          const rolKey = `ROL:${nextCandidateStart}`;
          const issueRes = await this.billingCyclePort.issueWorkerInvoiceForCycle({
            centerId: this.config.centerId,
            enrollmentId: enr.enrollment_id,
            cycleType: 'ROLLING_MONTH',
            cycleKey: rolKey,
            periodStartDate: nextCandidateStart,
            periodEndDate: firstCandidateEnd,
            systemJobName: `SchedulesWorker:${jobIdentityKey}`.slice(0, 64),
          });
          if (issueRes.replayedByCycleIdentity) {
            invoicesReplayedCount += 1;
          } else {
            invoicesIssuedCount += 1;
            issuedInvoiceIds.push(issueRes.invoice.invoice_id);
          }
          continue;
        }

        // Case 2: firstCandidateEnd < referenceDate -> the next unissued cycle is in the past!
        if (firstCandidateEnd < referenceDate) {
          if (catchUpPolicy === 'PREVIOUS_AND_CURRENT_CYCLE') {
            const secondStart = firstCandidate.nextRenewalDate;
            const secondCandidate = computeCanonicalNextRollingRenewalDate(
              secondStart,
              activePolicy.rolling_month_end_mode,
            );
            const secondEnd = secondCandidate.inclusivePeriodEndDate;

            // Only eligible under PREVIOUS_AND_CURRENT_CYCLE if the second cycle IS the current cycle covering referenceDate!
            if (secondStart <= referenceDate && referenceDate <= secondEnd) {
              for (const win of [
                { start: nextCandidateStart, end: firstCandidateEnd },
                { start: secondStart, end: secondEnd },
              ]) {
                if (leftAtStr && win.start > leftAtStr) break;
                const issueRes = await this.billingCyclePort.issueWorkerInvoiceForCycle({
                  centerId: this.config.centerId,
                  enrollmentId: enr.enrollment_id,
                  cycleType: 'ROLLING_MONTH',
                  cycleKey: `ROL:${win.start}`,
                  periodStartDate: win.start,
                  periodEndDate: win.end,
                  systemJobName: `SchedulesWorker:${jobIdentityKey}`.slice(0, 64),
                });
                if (issueRes.replayedByCycleIdentity) {
                  invoicesReplayedCount += 1;
                } else {
                  invoicesIssuedCount += 1;
                  issuedInvoiceIds.push(issueRes.invoice.invoice_id);
                }
              }
              continue;
            }
          }

          // Historical cycle outside the permissible catch-up window: NEVER issue or drain incrementally!
          await this.recordDeferredHistoricalReconciliationAudit({
            enrollmentId: enr.enrollment_id,
            billingMode: enr.billing_mode,
            enrolledAtDate: enrolledAtStr,
            nextCandidateStartDate: nextCandidateStart,
            nextCandidateEndDate: firstCandidateEnd,
            referenceDate,
            catchUpPolicy,
            nowUtc,
          });
          skippedTrialOrIneligibleCount += 1;
          continue;
        }

        skippedTrialOrIneligibleCount += 1;
        continue;
      }

      if (enr.billing_mode === 'LESSON_PACKAGE_12') {
        const prevPkgRes = await this.db.query<{
          cycle_key: string;
          cycle_seq: number;
          period_start_date: unknown;
        }>(
          `SELECT "cycle_key", "cycle_seq", "period_start_date"
             FROM "billing_cycles"
            WHERE "center_id" = $1::uuid
              AND "enrollment_id" = $2::uuid
              AND "cycle_type" = 'LESSON_PACKAGE_12'
            ORDER BY "cycle_seq" DESC`,
          [this.config.centerId, enr.enrollment_id],
        );
        const latestPkg = prevPkgRes.rows[0] ?? null;

        // Block automatic catch-up for unconfirmed old first-cycle package enrollments outside the window
        if (!latestPkg && enrolledAtStr < earliestPermissibleCalStart) {
          await this.recordDeferredHistoricalReconciliationAudit({
            enrollmentId: enr.enrollment_id,
            billingMode: enr.billing_mode,
            enrolledAtDate: enrolledAtStr,
            nextCandidateStartDate: enrolledAtStr,
            nextCandidateEndDate: null,
            referenceDate,
            catchUpPolicy,
            nowUtc,
          });
          skippedTrialOrIneligibleCount += 1;
          continue;
        }

        const pkgRem =
          enr.package_lessons_remaining !== null ? Number(enr.package_lessons_remaining) : null;
        const targetSeq = !latestPkg
          ? 1
          : pkgRem !== null && pkgRem <= 0
            ? Number(latestPkg.cycle_seq) + 1
            : Number(latestPkg.cycle_seq);
        const pkgKey = `PKG:${targetSeq}`;
        const pkgStart =
          targetSeq === 1
            ? enrolledAtStr
            : !latestPkg || targetSeq > Number(latestPkg.cycle_seq)
              ? referenceDate
              : (formatCanonicalPgDate(latestPkg.period_start_date) ?? enrolledAtStr);

        if (pkgStart > currentCalWindow.periodEndDate || (leftAtStr && pkgStart > leftAtStr)) {
          skippedTrialOrIneligibleCount += 1;
          continue;
        }

        const issueRes = await this.billingCyclePort.issueWorkerInvoiceForCycle({
          centerId: this.config.centerId,
          enrollmentId: enr.enrollment_id,
          cycleType: 'LESSON_PACKAGE_12',
          cycleKey: pkgKey,
          periodStartDate: pkgStart,
          periodEndDate: null,
          systemJobName: `SchedulesWorker:${jobIdentityKey}`.slice(0, 64),
        });
        if (issueRes.replayedByCycleIdentity) {
          invoicesReplayedCount += 1;
        } else {
          invoicesIssuedCount += 1;
          issuedInvoiceIds.push(issueRes.invoice.invoice_id);
        }
        continue;
      }

      // CALENDAR_PRO_RATA -> CALENDAR_MONTH across calendarWindowsToRun
      const prevCalRes = await this.db.query<{
        cycle_key: string;
        cycle_seq: number;
      }>(
        `SELECT "cycle_key", "cycle_seq"
           FROM "billing_cycles"
          WHERE "center_id" = $1::uuid
            AND "enrollment_id" = $2::uuid
            AND "cycle_type" = 'CALENDAR_MONTH'
          ORDER BY "cycle_seq" DESC
          LIMIT 1`,
        [this.config.centerId, enr.enrollment_id],
      );
      const hasPriorCalCycle = prevCalRes.rows.length > 0;

      // If enrollment has 0 prior cycles and its start date precedes the permissible catch-up window,
      // block automatic catch-up until its historical first cycle is explicitly reconciled!
      if (!hasPriorCalCycle && enrolledAtStr < earliestPermissibleCalStart) {
        await this.recordDeferredHistoricalReconciliationAudit({
          enrollmentId: enr.enrollment_id,
          billingMode: enr.billing_mode,
          enrolledAtDate: enrolledAtStr,
          nextCandidateStartDate: enrolledAtStr,
          nextCandidateEndDate: null,
          referenceDate,
          catchUpPolicy,
          nowUtc,
        });
        skippedTrialOrIneligibleCount += 1;
        continue;
      }

      let eligibleInAnyWindow = false;
      for (const calWin of calendarWindowsToRun) {
        if (enrolledAtStr > calWin.periodEndDate) {
          continue;
        }
        if (leftAtStr && calWin.periodStartDate > leftAtStr) {
          continue;
        }
        eligibleInAnyWindow = true;
        const issueRes: BillingCycleWorkerIssueResult =
          await this.billingCyclePort.issueWorkerInvoiceForCycle({
            centerId: this.config.centerId,
            enrollmentId: enr.enrollment_id,
            cycleType: 'CALENDAR_MONTH',
            cycleKey: calWin.cycleKey,
            periodStartDate: calWin.periodStartDate,
            periodEndDate: calWin.periodEndDate,
            systemJobName: `SchedulesWorker:${jobIdentityKey}`.slice(0, 64),
          });

        if (issueRes.replayedByCycleIdentity) {
          invoicesReplayedCount += 1;
        } else {
          invoicesIssuedCount += 1;
          issuedInvoiceIds.push(issueRes.invoice.invoice_id);
        }
      }
      if (!eligibleInAnyWindow) {
        skippedTrialOrIneligibleCount += 1;
      }
    }

    return {
      jobIdentityKey,
      deduplicatedJobWindow: invoicesIssuedCount === 0 && invoicesReplayedCount > 0,
      invoicesIssuedCount,
      invoicesReplayedCount,
      skippedTrialOrIneligibleCount,
      issuedInvoiceIds,
    };
  }

  /**
   * 13.04 Unclosed Cash Shift Reminder Job (`S05`):
   * - Enforces live `center_licenses` check (`READ_ONLY` or missing license row returns 0 flagged shifts without writing).
   * - Flags `OPEN` cash shifts for Admin/Director review without EVER fabricating `counted_closing_cash_uzs`
   *   or auto-closing the shift (`shiftsAutoClosedCount: 0`).
   */
  public async runUnclosedCashShiftReminderJob(options: {
    readonly nowUtc?: Date;
  } = {}): Promise<UnclosedShiftReminderRunResult> {
    const nowUtc = options.nowUtc ?? this.clock();
    const localParts = formatCenterLocalDateParts(nowUtc, this.config.centerTimezone);
    const jobIdentityKey = `ScheduledJob:${this.config.centerId}:UNCLOSED_SHIFT_REMINDER:${localParts.localDate}`;

    const liveLicenseMode = await this.db.resolveLiveCenterLicenseMode();
    if (liveLicenseMode === 'READ_ONLY') {
      return {
        jobIdentityKey,
        flaggedShiftIds: [],
        shiftsAutoClosedCount: 0,
      };
    }

    const flaggedShiftIds = await this.db.runInTransaction(async (tx) => {
      await tx.query(
        `SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`,
        [this.config.centerId, jobIdentityKey],
      );

      const openShiftsRes = await tx.query<{
        id: string;
        shift_date: string;
        expected_closing_cash_uzs: string;
      }>(
        `SELECT "id"::text AS id,
                "shift_date"::text AS shift_date,
                "expected_closing_cash_uzs"::text AS expected_closing_cash_uzs
           FROM "cash_shifts"
          WHERE "center_id" = $1::uuid
            AND "status" = 'OPEN'
            AND "shift_date" <= $2::date
          ORDER BY "shift_date" ASC, "id" ASC`,
        [this.config.centerId, localParts.localDate],
      );

      const flagged: string[] = [];
      for (const sh of openShiftsRes.rows) {
        const reqId = `unclosed-shift-${sh.id.slice(0, 8)}-${localParts.localDate}`;
        const existingAudit = await tx.query<{ id: string }>(
          `SELECT "id"::text AS id
             FROM "audit_logs"
            WHERE "center_id" = $1::uuid
              AND "action" = 'CASH_SHIFT_UNCLOSED_REMINDER'
              AND "entity_id" = $2::uuid
              AND "request_id" = $3
            LIMIT 1`,
          [this.config.centerId, sh.id, reqId],
        );
        if (existingAudit.rows.length > 0) {
          continue;
        }

        await tx.query(
          `INSERT INTO "audit_logs" (
             "id", "center_id", "actor_type", "actor_id", "actor_role",
             "action", "entity_type", "entity_id", "severity",
             "before_redacted_json", "after_redacted_json", "request_id", "created_at"
           ) VALUES (
             $1::uuid, $2::uuid, 'SYSTEM_WORKER', NULL, NULL,
             'CASH_SHIFT_UNCLOSED_REMINDER', 'CashShift', $3::uuid, 'WARN',
             NULL, $4::jsonb, $5, $6::timestamptz
           )`,
          [
            crypto.randomUUID(),
            this.config.centerId,
            sh.id,
            JSON.stringify({
              shift_id: sh.id,
              shift_date: String(sh.shift_date).slice(0, 10),
              status: 'OPEN',
              auto_closed: false,
              expected_closing_cash_uzs: sh.expected_closing_cash_uzs,
            }),
            reqId,
            nowUtc.toISOString(),
          ],
        );
        flagged.push(sh.id);
      }
      return flagged;
    });

    return {
      jobIdentityKey,
      flaggedShiftIds,
      shiftsAutoClosedCount: 0,
    };
  }

  /**
   * 13.04 Trial No-Show Follow-Up Job (`S05`):
   * - Requires explicit `CONFIRMED_SECOND_ABSENCE_ADMIN_FOLLOWUP` policy (fails closed on `UNCONFIGURED`).
   * - Enforces live `center_licenses` check (`READ_ONLY` or missing license row fails closed).
   * - Records an idempotent Admin follow-up task in `audit_logs` for `TRIAL` enrollments with `>= 2`
   *   distinct `ABSENT` attendance records on eligible lessons, WITHOUT converting `TRIAL` to `ACTIVE`
   *   and WITHOUT creating any invoice or debt (`invoicesCreatedCount: 0`).
   */
  public async runTrialNoShowFollowUpJob(options: {
    readonly nowUtc?: Date;
    readonly trialNoShowPolicy?: TrialNoShowFollowUpPolicyMode;
  } = {}): Promise<TrialNoShowFollowUpRunResult> {
    const nowUtc = options.nowUtc ?? this.clock();
    const policy = options.trialNoShowPolicy ?? 'UNCONFIGURED';

    if (policy !== 'CONFIRMED_SECOND_ABSENCE_ADMIN_FOLLOWUP') {
      throw new Error(
        'POLICY_DECISION_NOT_CONFIRMED: Trial no-show follow-up policy is UNCONFIGURED; automatic action is blocked until center confirms policy (D14, 13.04)',
      );
    }

    const liveLicenseMode = await this.db.resolveLiveCenterLicenseMode();
    if (liveLicenseMode === 'READ_ONLY') {
      throw new Error(
        'LICENSE_READ_ONLY_MODE: Scheduled trial no-show follow-up mutations are blocked while center license is in READ_ONLY mode (BR-15, 13.04)',
      );
    }

    const localParts = formatCenterLocalDateParts(nowUtc, this.config.centerTimezone);
    const jobIdentityKey = `ScheduledJob:${this.config.centerId}:TRIAL_NO_SHOW:${localParts.localDate}`;

    const flaggedEnrollments = await this.db.runInTransaction(async (tx) => {
      await tx.query(
        `SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`,
        [this.config.centerId, jobIdentityKey],
      );

      const candidatesRes = await tx.query<{
        enrollment_id: string;
        student_id: string;
        absent_lessons_cnt: string;
      }>(
        `SELECT e."id"::text AS enrollment_id,
                e."student_id"::text AS student_id,
                COUNT(DISTINCT ar."lesson_id")::text AS absent_lessons_cnt
           FROM "enrollments" e
           JOIN "attendance_records" ar
             ON ar."enrollment_id" = e."id"
            AND ar."center_id" = e."center_id"
           JOIN "lesson_occurrences" lo
             ON lo."id" = ar."lesson_id"
            AND lo."center_id" = ar."center_id"
          WHERE e."center_id" = $1::uuid
            AND e."status" = 'TRIAL'
            AND ar."status" = 'ABSENT'
            AND lo."status" IN ('SCHEDULED', 'COMPLETED')
          GROUP BY e."id", e."student_id"
         HAVING COUNT(DISTINCT ar."lesson_id") >= 2
          ORDER BY e."id" ASC`,
        [this.config.centerId],
      );

      const flagged: string[] = [];
      for (const row of candidatesRes.rows) {
        const reqId = `trial-noshow-${row.enrollment_id.slice(0, 12)}`;
        const existingAudit = await tx.query<{ id: string }>(
          `SELECT "id"::text AS id
             FROM "audit_logs"
            WHERE "center_id" = $1::uuid
              AND "action" = 'TRIAL_NO_SHOW_ADMIN_FOLLOWUP'
              AND "entity_id" = $2::uuid
              AND "request_id" = $3
            LIMIT 1`,
          [this.config.centerId, row.enrollment_id, reqId],
        );
        if (existingAudit.rows.length > 0) {
          continue;
        }

        await tx.query(
          `INSERT INTO "audit_logs" (
             "id", "center_id", "actor_type", "actor_id", "actor_role",
             "action", "entity_type", "entity_id", "severity",
             "before_redacted_json", "after_redacted_json", "request_id", "created_at"
           ) VALUES (
             $1::uuid, $2::uuid, 'SYSTEM_WORKER', NULL, NULL,
             'TRIAL_NO_SHOW_ADMIN_FOLLOWUP', 'Enrollment', $3::uuid, 'INFO',
             NULL, $4::jsonb, $5, $6::timestamptz
           )`,
          [
            crypto.randomUUID(),
            this.config.centerId,
            row.enrollment_id,
            JSON.stringify({
              enrollment_id: row.enrollment_id,
              student_id: row.student_id,
              enrollment_status: 'TRIAL',
              distinct_absent_lessons: Number(row.absent_lessons_cnt),
              policy: policy,
              invoice_created: false,
            }),
            reqId,
            nowUtc.toISOString(),
          ],
        );
        flagged.push(row.enrollment_id);
      }

      return flagged;
    });

    return {
      jobIdentityKey,
      followUpEnrollmentsFlagged: flaggedEnrollments,
      invoicesCreatedCount: 0,
    };
  }
}
