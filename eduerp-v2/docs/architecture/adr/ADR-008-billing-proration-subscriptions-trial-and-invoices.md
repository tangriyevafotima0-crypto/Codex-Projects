# ADR-008 — Stage 08 Configurable Billing Policies, Rational Integer `HALF_UP` Proration, Rolling/Calendar/Package Cycles, Trial Conversion & Atomic Invoice Generation

- **Status:** `IN_REVIEW`
- **Task ID:** `S08FIX-L` (`K01`–`K08`, stabilizing `08.01`–`08.05`)
- **Base Commit:** `31de5080dbd3a55231fb499cf08f6da7e9ba2c4e` (Candidate Input Commit: `a7d7d0000e4d62ca0341e60314d3eca5940bae64`)
- **Date:** `2026-11-04`

---

## 1. Context & Owner Decisions (`OWNER-20261104-02` & `OWNER-20261104-03`)

Stage 08 (`08.01`–`08.05`) implements the core tariff, subscription cycle, trial conversion, and invoice engine of EduERP v2.0 while enforcing strict boundaries between confirmed owner decisions and open policy gates:

1. **`OWNER-20261104-02` (Orthogonal Billing Axes):**
   - `billing_mode` (`CALENDAR_PRO_RATA | ROLLING_MONTH | LESSON_PACKAGE_12`), `due_date_rule` (`ENROLLMENT_ANNIVERSARY | CENTER_FIXED_DAY`), and `collection_timing` (`ARREARS | ADVANCE`) are independent per-center/per-group parameters.
   - Confirmed examples: `Aug 12 -> Sep 12` (anniversary arrears) and `Aug 12 -> Sep 15` (center-fixed due day `15` arrears).
2. **`OWNER-20261104-03` (First Partial Charge, Rounding & Rolling Short-Month Clamp):**
   - **Decision #1 (`first_partial_charge_mode`):** For mid-period/first partial period enrollment, each center explicitly selects `PRORATE_REMAINING_LESSONS` or `FULL_CYCLE`. Neither is a global platform default; when `first_partial_charge_mode = 'UNCONFIGURED'`, partial-period billing fails closed with `403 POLICY_DECISION_NOT_CONFIRMED` and zero financial side effects.
   - **Decision #2 (`rounding_mode = 'HALF_UP_UZS_INT'`):** UZS `scale = 0`; non-negative charges use pure `BigInt` rational integer division with `HALF_UP` (`0.5` rounds up: `2n * remainder >= denominator ? quotient + 1n : quotient`), never using IEEE-754 floats or `Math.round`.
   - **Decision #3 (`rolling_month_end_mode = 'CONTINUE_FROM_CLAMPED_DAY'` / `'CLAMP_LAST_DAY'`):** When a rolling-month renewal clamps at the end of a shorter month, subsequent renewals **continue from that actual clamped day** (`2026-01-31 -> 2026-02-28 -> 2026-03-28`; leap year `2028-01-31 -> 2028-02-29 -> 2028-03-29`), never restoring the original `31` anchor and never computing `initialStartDate + N months`.

---

## 2. Architectural Decisions

### 2.1. `08.01` — Rational Integer `HALF_UP` Proration & Lesson Snapshot (`apps/api/src/billing/calendar-proration.ts`)
- Reuses `apps/api/src/database/money.ts` (`parseNonNegativeMoneyUzs`, `formatMoneyUzs`, `MAX_PG_BIGINT`) without duplicating money parsers.
- `calculateProRataOrCycleChargeUzs()` validates `plannedLessons > 0` (blocking billing with `422 INVALID_SCHEDULE_ZERO_LESSONS` when `plannedLessons === 0`), rejects `remainingLessons > plannedLessons` or negative/non-integer lesson counts, and computes `480000 * 7 / 12 = 280000` (`T08.01`).
- `selectPeriodLessonSnapshot()` derives `plannedLessons` and `billableLessons` from `lesson_occurrences` in `[period_start_date, period_end_date]` (or from the group's weekday schedule when occurrences are not yet materialized), excluding `RESCHEDULED` originals and `CANCELLED_BY_CENTER` holidays under `EXCLUDE_CANCELLED_FROM_PLANNED` — never substituting calendar day counts for lesson counts.

### 2.2. `08.02` — Subscription Cycle Policies & Due-Date Resolution (`apps/api/src/billing/subscriptions.ts`, `policy.ts`)
- Discriminated cycle builders (`buildCalendarMonthCycleSpec`, `buildRollingMonthCycleSpec`, `buildLessonPackage12CycleSpec`) enforce mode-specific invariants:
  - `CALENDAR_MONTH`: bound to `YYYY-MM-01` .. `YYYY-MM-lastDay`.
  - `ROLLING_MONTH`: chains strictly from the stored previous `period_end_date + 1 day` (`nextRenewalDate`), with zero gap and zero overlap.
  - `LESSON_PACKAGE_12`: uses `PKG:1`, `PKG:2`, etc., deduplicating attendance by `lesson_id` and preserving package balance on `CANCELLED_BY_CENTER` lessons under `PRESERVE_BALANCE`, while gating unconfirmed `CREDIT_NEXT_CYCLE` with `403 POLICY_DECISION_NOT_CONFIRMED`.
- `resolveCycleDueDate()` resolves `due_date` orthogonally from `due_date_rule` and `collection_timing`. Ambiguous fixed due-day short-month (`29/30/31` in Feb) and unconfirmed initial mid-month prepaid fixed-day periods fail closed with `403 POLICY_DECISION_NOT_CONFIRMED`.

### 2.3. `08.03` — Trial Conversion on 2nd Distinct Attendance (`apps/api/src/billing/trial-conversion.ts`)
- `TrialConversionService.evaluateTrialEnrollmentWithinTransaction()` locks `enrollments` (`FOR UPDATE`) and reads canonical `attendance_records` joined with `lesson_occurrences` (`PRESENT` / `LATE` on `SCHEDULED` / `COMPLETED` lessons).
- 1st distinct attended lesson updates `first_trial_lesson_id` and `first_trial_date` on `enrollments` while keeping `status = 'TRIAL'` and creating zero debt.
- 2nd distinct attended lesson atomically activates `enrollments` (`status = 'ACTIVE'`), issues a single `BillingCycle` + `Invoice` starting from `first_trial_date` (via `InvoiceGeneratorService`), inserts `TrialActivation` (`ACTIVE_ACTIVATION`), and queues `TrialActivated` v1 in `outbox_events`.

### 2.4. `08.04` — Idempotent Invoice Generator & Atomic Financial Execution (`apps/api/src/billing/invoice-generator.ts`)
- Enforces durable business identity uniqueness on `(enrollment_id, cycle_type, cycle_key)` inside the `FOR UPDATE` enrollment lock so retries, new `Idempotency-Key`s, different staff actors, or concurrent requests never create duplicate invoices or double debt.
- Resolves historical tariffs via Stage 07's `resolveGroupTariffState` as of `period_start_date` (never recalculating historical periods with today's future tariff).
- Applies existing unconsumed `CreditNote`s capped at `base_pro_rata_charge_uzs` (`effective_net_charge_uzs >= 0`) and commits `BillingCycle` + `Invoice` + `InvoiceLine` + `LedgerEntry` (`INVOICE_ISSUED`) + `AuditLog` + `OutboxEvent` (`AllocationAdjusted` v1) in a single PostgreSQL transaction.

---

## 3. `S08FIX-L` Financial Boundary & Schema Hardening (`K01`–`K08`)

1. **`K02` — Legacy / Unconfigured Policy Fail-Closed (`billing_policy_versions` & `policy.ts`):**
   - `billing_policy_versions.policy_confirmation_status` defaults to `'UNCONFIGURED'`, `first_partial_charge_mode` defaults to `'UNCONFIGURED'`, and `effective_from_date` defaults to `NULL`.
   - `mapBillingPolicyRowToDto()` never fabricates `'CONFIRMED'` or `'2026-01-01'`.
   - `assertConfirmedPolicyForBillingExecution()` and `resolveActivePolicyForGroupPeriod()` require an explicitly `CONFIRMED` policy with `effective_from_date <= periodStartDate` and `first_partial_charge_mode IN ('PRORATE_REMAINING_LESSONS', 'FULL_CYCLE')` on **all** billing executions (full-month, partial-month, rolling, package, worker, and trial conversion).
2. **`K03` — `TRIAL` Enrollment Invoice Bypass Prevention (`invoice-generator.ts` & `trial-conversion.ts`):**
   - `InvoiceGeneratorService.issueCycleInvoiceWithinTransaction()` rejects any enrollment in `status === 'TRIAL'` with `422 VALIDATION_ERROR` and zero financial side effects. Only canonical 2nd distinct attendance conversion in `TrialConversionService.evaluateTrialEnrollmentWithinTransaction()` transitions `TRIAL -> ACTIVE` and issues the initial invoice atomically in one transaction.
3. **`K04` — Service Period Wholly Before Enrollment / Service Begin Rejected (`subscriptions.ts` & `invoice-generator.ts`):**
   - `assertServicePeriodEligibleForEnrollmentBegin()` rejects any `CALENDAR_MONTH` where `periodEndDate < serviceBeginDate` and any `ROLLING_MONTH` / `LESSON_PACKAGE_12` where `periodStartDate < serviceBeginDate` (`422 VALIDATION_ERROR`, zero DB rows), while preserving mid-month partial join in `CALENDAR_MONTH` (`periodStartDate < serviceBeginDate <= periodEndDate`).
4. **`K05` — `VARCHAR(32)` Width Parity for 25-Char `'CONTINUE_FROM_CLAMPED_DAY'` (`20261104000500` & `schema.prisma`):**
   - Widened `billing_policy_versions` mode columns (`rolling_month_end_mode`, etc.) from `VARCHAR(24)` to `VARCHAR(32)` and added SQL `CHECK` constraints so `'CONTINUE_FROM_CLAMPED_DAY'` (25 chars) persists cleanly in PostgreSQL (`201 Created`).
5. **`K07` — `LESSON_PACKAGE_12` Multi-Cycle Lesson Slice Partitioning:**
   - `buildLessonPackage12CycleSpec()` never accepts unknown `attendedLessonIds` when `eligibleSet` is empty and excludes lessons already allocated to prior package cycles (`PKG:1 -> PKG:2`).


## Stage 08 Remediation (`S08FIX-S09FULL-M` — `L01`..`L03`)

- **`L01` (Preserved `K02`..`K05` & Manager SQL Enum Fixes):** Preserved `K02`..`K05` fixes and manager SQL enum literals (`TEACHER_WEB` on `attendance_records.source_channel`, `FREEZE_NEXT_PERIOD_CREDIT` on `credit_notes.credit_reason`, and `PRIOR_FREEZE_CREDIT` on `invoice_lines.line_type`).
- **`L02` (Durable `LESSON_PACKAGE_12` Cycle -> Lesson Ownership):** Added `billing_cycle_lesson_allocations` (`UNIQUE (enrollment_id, lesson_id)`) plus `allocated_lesson_ids_json` and `consumed_lesson_ids_json` on `billing_cycles`, written atomically inside the package issuance transaction. Backdated lesson inserts, attendance retries, or later schedule mutations cannot rewrite prior package cycle ownership or consume prior lessons in `PKG:2`. Legacy package cycles with no durable ownership snapshot fail closed with `403 POLICY_DECISION_NOT_CONFIRMED` on subsequent package issuance while keeping read-only invoice retrieval intact.
- **`L03` (`BILL-IT-11` Calendar Fixture Alignment):** Updated `BILL-IT-11` to verify both the 1-remaining-lesson boundary (`2026-11-29` Sunday before Monday `2026-11-30`) and the true 0-remaining-lesson boundary (`2026-10-31` Saturday after Friday `2026-10-30`).
