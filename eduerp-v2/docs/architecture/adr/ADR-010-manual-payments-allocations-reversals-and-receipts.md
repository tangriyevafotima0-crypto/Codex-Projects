# ADR-010: Manual External Payment Recording, Multi-Invoice Allocations, Promise-to-Pay Seam, Append-Only Reversals, and Internal Electronic Receipts (Stage 10)

- **Status:** Accepted (Candidate `IN_REVIEW` under `S10FULL-N`)
- **Stage:** 10 (`10.01`–`10.05`)
- **Owner Decisions Applied:** `OWNER-20261105-05` (Manual external payment recording only; no payment gateways or automated bank refunds; `D22` service-cancellation credit-note refund gated)

## 1. Context & Problem Statement

Stage 10 implements the payment, allocation, correction/reversal, and internal electronic receipt layer on top of Stage 08–09 invoices, billing cycles, discounts, and freeze credits:
1. **`OWNER-20261105-05` Boundary:** EduERP is not a payment gateway or money transmitter. Cash (`CASH`), terminal card (`CARD`), `CLICK`, `PAYME`, and bank transfer (`TRANSFER`) are external payment methods manually recorded by center staff (`DIRECTOR` or `ADMIN`). There are no checkout links, provider webhooks, auto-charging, or automated bank refund APIs.
2. **Dual Timestamps (`paid_at` vs `recorded_at`):** Late manual entries preserve both `paid_at` (actual external payment time, validated `<= recorded_at`) and `recorded_at` (server entry time from `ClockService`) on both `payments` and `receipts`.
3. **S11 Cash Shift Guard & Promise-to-Pay Seams:** Recording a payment or executing a reversal requires an active `OPEN` `CashShift` in the same center (`409 SHIFT_CLOSED` when closed; `403 POLICY_DECISION_NOT_CONFIRMED` if attempting to backfill/reopen a closed shift). Partial payments leaving `remaining_debt_uzs > 0` require a valid `promise_date >= centerTodayDate` (`422 PROMISE_DATE_REQUIRED_FOR_PARTIAL_PAYMENT`) and atomically create `PromiseToPay(status = 'ACTIVE')`, while subsequent payments that clear an invoice's remaining debt to `0` automatically transition active `PromiseToPay` rows on that invoice to `FULFILLED` and emit `PromiseFulfilled` (`CASE-22`, `T11.03`).
4. **Immutable Table Locking Rule (`L45`):** Because `eduerp_api_runtime` holds `SELECT, INSERT` (no `UPDATE`) on append-only tables (`payments`, `payment_allocations`, `payment_allocation_reversals`, `reversal_or_refund_executions`, `receipts`, `ledger_entries`), `SELECT ... FOR UPDATE` is never executed on immutable tables. Concurrency serialization uses `FOR UPDATE` on mutable owner tables (`students`, `cash_shifts`, `invoices`, `unapplied_credits`, `reversal_or_refund_requests`, `promises_to_pay`) combined with transaction-scoped advisory locks (`pg_advisory_xact_lock`).

## 2. Key Architectural Decisions

### 2.1 Manual Payment Recording & Open Cash Shift Seam (`10.01`)
- `PaymentService.recordPaymentWithRequiredPromise` (`POST /api/v1/payments`) validates lossless `BigInt` integer UZS (`amount_uzs > 0`), verifies live actor status/role inside `authorizeBeforeReplayOrExecute`, locks the mutable `students` and `cash_shifts` rows `FOR UPDATE`, and rejects closed shifts with `409 SHIFT_CLOSED`.
- Optional `external_reference` is uniquely scoped per `(center_id, payment_method, external_reference)` via partial unique index `idx_payments_center_method_ext_ref`.
- Only `CASH` payments increment `cash_shifts.cash_receipts_uzs` and `expected_closing_cash_uzs`; `CARD`, `CLICK`, `PAYME`, and `TRANSFER` increment `non_cash_receipts_uzs` (`C03`).

### 2.2 Partial, Overpaid (`UnappliedCredit`), and Multi-Invoice Allocations (`10.02`)
- `AllocationService` locks target `invoices` rows in deterministic UUID order (`ORDER BY "id" ASC FOR UPDATE`), verifies center and student ownership (`403 FORBIDDEN_OBJECT_SCOPE` on cross-student invoices), and computes canonical `allocated_paid_uzs` from `payment_allocations` minus `payment_allocation_reversals`.
- Supports both ordered `target_invoice_ids` (greedy allocation) and explicit `allocations` (`[{ invoice_id, allocated_amount_uzs }]`).
- Excess payment above targeted invoice debt creates a mutable `UnappliedCredit` row (`unapplied_credits`).
- Any remaining open invoice debt after allocation requires `promise_date >= centerTodayDate` (`422 PROMISE_DATE_REQUIRED_FOR_PARTIAL_PAYMENT`) and creates `PromiseToPay` (`ACTIVE`).

### 2.3 Reason-Required Reversal Requests & Director-Only Append-Only Execution (`10.03`)
- `ReversalService.requestPaymentReversalOrRefund` (`POST /api/v1/payments/reversals`) allows `ADMIN` or `DIRECTOR` to create a `PENDING_DIRECTOR_APPROVAL` request with a mandatory reason (`5..500` chars) and `CRITICAL_RED` `RefundRecorded` outbox notification, without mutating any financial balances.
- `ReversalService.decidePaymentReversalOrRefund` (`POST /api/v1/payments/reversals/{reversal_id}/decision`) is restricted strictly to `DIRECTOR` (`403 FORBIDDEN_ROLE` for `ADMIN`/`TEACHER`).
- Under `OWNER-20261105-05` and `D22`, `REOPEN_INVOICE_DEBT` is supported while `CLOSE_WITH_CREDIT_NOTE` (service-cancellation credit-note refund) is gated fail-closed with `403 POLICY_DECISION_NOT_CONFIRMED`.
- Approval unwinds `UnappliedCredit` first, then inserts `PaymentAllocationReversal` rows and restores `Invoice.remaining_debt_uzs` by the exact reversed allocation amount, updates the active `OPEN` `CashShift` (`cash_refunds_uzs` for `CASH`, `non_cash_refunds_uzs` for non-cash), and appends `ReversalOrRefundExecution` + `LedgerEntry` (`PAYMENT_REVERSED` or `REFUND_PAID`, `DEBIT`).

### 2.4 Internal Electronic Receipts (`10.04`)
- `ReceiptsService.issueReceiptInTx` allocates center-scoped sequential receipt numbers (`RCP-YYYYMM-NNNNNN`) serialized via `pg_advisory_xact_lock(hashtext(centerId), hashtext('S10_CENTER_RECEIPT_NUMBER_SEQ'))` and sets `is_fiscal_tax_receipt = false` (`D13`).
- `GET /api/v1/receipts/{receipt_id}` returns the immutable receipt snapshot together with any linked append-only reversal history (`reversed_total_uzs`, `net_effective_payment_uzs`, `reversal_status`, `reversals`).
