# ADR-009: Discounts, Center-Configurable Stacking, Grants, Freeze Next-Cycle Credits, and Withdrawals (Stage 09)

- **Status:** Accepted (Candidate `IN_REVIEW` under `S08FIX-S09FULL-M`)
- **Stage:** 09 (`09.01`–`09.05`)
- **Owner Decisions Applied:** `OWNER-20261105-03` (`HALF_UP` integer UZS rounding), `OWNER-20261105-04` (Separate S09 policy confirmation boundary for `discount_stacking_mode` and `freeze_credit_basis`)

## 1. Context & Problem Statement

Stage 09 introduces financial adjustments on top of Stage 08 billing cycles and invoices:
1. **09.01 — Discount & Grant Requests (`POST /api/v1/discounts/requests`):** Requesting percentage (`PERCENT`), fixed UZS (`FIXED_UZS`), or `FULL_GRANT_100` scholarships without mutating invoices or ledger balances before Director decision.
2. **09.02 — Director Approval & Center-Configurable Stacking (`POST /api/v1/discounts/requests/{discount_request_id}/decision`):** Director-only approval/rejection, atomic invoice recalculation, `HALF_UP` integer UZS math, and center-selected stacking (`MAX_SINGLE` vs `SEQUENTIAL` / `PERCENT_THEN_FIXED` / `FIXED_THEN_PERCENT`).
3. **09.03 — Freeze Interval Union & Next-Cycle Credit (`POST /api/v1/freezes`):** Recording temporary absence windows, preventing overlapping double-credits at both service and DB constraint levels (`UNIQUE (enrollment_id, lesson_id)` on `freeze_lesson_links`), and issuing next-cycle `CreditNote` (`FREEZE_NEXT_PERIOD_CREDIT`) without cash refunds.
4. **09.04 — Withdrawal & Debt Preservation (`POST /api/v1/students/{student_id}/enrollments/{enrollment_id}/withdraw`):** Mandatory churn reason codes (`1..5`), lossless `BigInt` debt preservation, automatic revocation of pending discount requests, and blocking post-exit billing while allowing re-enrollment via a new `Enrollment` record.
5. **`OWNER-20261105-04` Policy Boundary:** A general S08 `CONFIRMED` billing policy does not implicitly confirm S09 discount stacking or freeze credit rules.

## 2. Key Architectural Decisions

### 2.1 Separate S09 Policy Confirmation Boundary (`OWNER-20261105-04`)
- `center_billing_policies` carries explicit `discount_policy_status` (`UNCONFIGURED` | `CONFIRMED`) and `freeze_policy_status` (`UNCONFIGURED` | `CONFIRMED`).
- Director approval of a discount (`09.02`) requires `discount_policy_status = 'CONFIRMED'`, an explicit `discount_stacking_mode`, and `effective_from_date <= billing_cycle.period_start_date`, failing closed with `403 POLICY_DECISION_NOT_CONFIRMED` and zero writes otherwise.
- Freeze creation (`09.03`) requires `freeze_policy_status = 'CONFIRMED'`, an explicit `freeze_credit_basis`, and `effective_from_date <= billing_cycle.period_start_date`, failing closed with `403 POLICY_DECISION_NOT_CONFIRMED` and zero writes otherwise.
- Both `discount_approvals` and `freeze_records` snapshot the active `billing_policy_id` and confirmed mode/basis at execution time.

### 2.2 Discount Request Isolation (`09.01`)
- `DiscountRequestsService.createDiscountRequest` validates exact basis-point percentages (`0.01..100`), caps `FIXED_UZS <= base_pro_rata_charge_uzs`, verifies guardian family offer eligibility (`SIBLING` >= 2 active/frozen students linked to an authenticated guardian; `MULTI_COURSE` >= 2 active/frozen enrollments for the student), and writes only `DiscountRequest` + `AuditLog` + `OutboxEvent` (`DiscountRequested`).
- Invoice and ledger balances remain completely unchanged until Director approval.

### 2.3 Director Approval, Stacking & Retroactive Safety Gate (`09.02`)
- `DiscountApprovalsService.decideDiscountRequest` locks the `Enrollment`, `DiscountRequest`, and `Invoice` rows `FOR UPDATE` inside a single DB transaction.
- **Stacking Modes:**
  - `MAX_SINGLE`: Selects the single approved adjustment yielding the highest UZS discount; tie-breaks deterministically by earliest `approved_at`, then lexical `discount_request_id`.
  - `SEQUENTIAL` / `PERCENT_THEN_FIXED`: Applies percentage discounts sequentially with `HALF_UP` integer UZS rounding on each step (`320,000 -> -10% = 288,000 -> -20,000 = 268,000`), then subtracts fixed UZS discounts capped at remaining charge.
  - `FIXED_THEN_PERCENT`: Subtracts fixed UZS discounts first, then applies percentage discounts sequentially with `HALF_UP` rounding.
  - `FULL_GRANT_100`: Sets `discount_total_uzs = base_pro_rata_charge_uzs`, `net_charge_uzs = 0`, `balance_due_uzs = 0`, and `invoice.status = 'GRANT_ZERO'` with no fake payment or refund records.
- **Retroactive Overpaid / Post-Freeze Safety Gate:** If applying a discount would drop `payable_after_credits_uzs` below `paid_total_uzs` (requiring an unconfirmed refund/credit conversion) or if a freeze credit has already been issued against the invoice (`freeze_records` count > 0), approval fails closed with `403 POLICY_DECISION_NOT_CONFIRMED` and zero writes.

### 2.4 Freeze Interval Union & Next-Cycle Credit Consumption (`09.03`)
- `FreezeCreditService.createFreeze` locks the `Enrollment` and `Invoice` rows `FOR UPDATE`, identifies eligible scheduled lessons in `[freeze_start_date, freeze_end_date]` (excluding cancelled/rescheduled lessons, lessons with `PRESENT`/`LATE`/`EXCUSED` attendance, and lessons already linked in `freeze_lesson_links`), and inserts `freeze_lesson_links` (`UNIQUE (enrollment_id, lesson_id)`).
- Under `NET_PROPORTIONAL_LESSON`, credit is computed as `roundHalfUp(basis_net_charge_uzs * newly_covered_lessons, total_billable_lessons)` (`384,000 * 3 / 12 = 96,000`), capped so cumulative freeze credits on the cycle never exceed `basis_net_charge_uzs`. On `GRANT_ZERO` (`net_charge_uzs = 0`), freeze is recorded with `0` UZS credit.
- Writes `FreezeRecord`, `FreezeLessonLink`, `CreditNote` (`FREEZE_NEXT_PERIOD_CREDIT`), `LedgerEntry` (`CREDIT_NOTE_ISSUED`), `AuditLog`, and `OutboxEvent` (`FreezeCreditIssued`) atomically.
- On next-cycle invoice issuance (`InvoiceGeneratorService.issueInvoice`), available `ISSUED` credit notes for the student/enrollment are locked `FOR UPDATE`, applied up to `afterDiscountUzs`, recorded as `PRIOR_FREEZE_CREDIT` invoice lines, and updated to `APPLIED` (`remaining_amount_uzs = 0`) so concurrent issuances cannot double-consume a credit note.

### 2.5 Withdrawal, Debt Preservation & Pending Discount Revocation (`09.04`)
- `EnrollmentsService.withdrawEnrollment` requires churn reason codes `1..5` (`PRICE`, `TEACHER`, `SCHEDULE`, `RELOCATION`, `OTHER` with non-empty `reason_note`), transitions enrollment status to `LEFT`, revokes any `PENDING_APPROVAL` discount requests for the enrollment, and preserves all unpaid invoices and `BigInt` balances unchanged.
- Subsequent billing (`issueInvoice`) on a `LEFT` enrollment is rejected (`422 ENROLLMENT_NOT_BILLABLE`), while re-enrollment creates a fresh `Enrollment` UUID with independent cycle history.
