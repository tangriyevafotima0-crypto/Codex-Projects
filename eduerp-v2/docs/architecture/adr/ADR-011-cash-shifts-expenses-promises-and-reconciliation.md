# ADR-011: Stage 11 Cash Shifts, Categorized Expenses, Promise-to-Pay Lifecycle & Method-Wise Reconciliation

- **Status:** Proposed (Candidate `IN_REVIEW` under `S11FULL-O`)
- **Date:** 2026-11-05
- **Stage:** `S11` (`11.01`–`11.05`)
- **Related Decisions & Rules:** `BR-05`, `BR-09`, `C03`, `CASE-11`, `CASE-18`, `CASE-22`, `OWNER-20261105-05`

## 1. Context

Stage 11 (`11.01`–`11.05`) completes the daily cash drawer lifecycle (`CashShift`), categorized cash and non-cash expense recording with append-only Director-only reversals (`CashExpense`), Promise-to-Pay supersession and reminder candidate projection (`PromiseToPay`), and method-wise shift reconciliation (`ReconciliationService`).

## 2. Decisions

- **Single Active Cash Shift & Closed Shift Immutability (`11.01`, `T11.01`, `BR-09`):** Enforced via `idx_cash_shifts_open_center` and center-scoped `pg_advisory_xact_lock`, returning `409 VERSION_CONFLICT` to concurrent callers. Dynamic date checks (`shift_date === centerTodayDate`) run inside the fresh execution handler (`N02`) so committed shifts remain idempotently replayable on subsequent days (`N01`).
- **Categorized Cash & Non-Cash Expenses and Append-Only Director Reversals (`11.02`, `T11.02`, `C03`):** Supports `CASH`, `CARD`, `CLICK`, `PAYME`, `TRANSFER` (`OWNER-20261105-05`). Only `CASH` expenses reduce `expected_closing_cash_uzs`; `CASH` overdrafts are rejected (`422`). Expense reversals are strictly `DIRECTOR`-only and append-only (`reverses_expense_id`, `idx_cash_expenses_unique_reversal`, `EXPENSE_REVERSED` `CREDIT` `LedgerEntry`).
- **Promise-to-Pay Supersession & Reminder Candidate Eligibility (`11.03`, `T11.03`, `CASE-11`, `CASE-22`):** Repeated partial payments supersede prior `ACTIVE` promises (`status = 'CANCELLED'`, `cancel_reason = 'SUPERSEDED_BY_NEW_PARTIAL_PAYMENT_PROMISE'`, `superseded_by_promise_id`) so a student is never reminded twice. Full invoice settlement transitions promises to `FULFILLED` (`CASE-22`).
- **Method-Wise Reconciliation & Fail-Closed Drift Detection (`11.04`, `T11.04`, `CASE-18`):** `expected_closing_cash_uzs = opening_cash_uzs + cash_receipts_uzs - cash_refunds_uzs - cash_expenses_uzs` (`0 + 3,200,000 - 150,000 = 3,050,000` cash expected; `1,800,000` card excluded). Stored projection drift fails closed with `409 VERSION_CONFLICT`.
