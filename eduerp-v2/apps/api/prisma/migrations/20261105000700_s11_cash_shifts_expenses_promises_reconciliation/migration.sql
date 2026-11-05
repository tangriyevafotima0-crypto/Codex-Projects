-- EduERP v2.0 — Stage 11 Additive Migration
-- Migration ID: 20261105000700_s11_cash_shifts_expenses_promises_reconciliation
-- Target Engine: PostgreSQL 16
-- Scope (11.01–11.05 & OWNER-20261105-05):
--   1. Adds non_cash_expenses_uzs BIGINT >= 0 to cash_shifts for method-wise non-cash expense tracking (11.02, 11.04).
--   2. Widens cash_expenses.payment_method CHECK constraint to ('CASH', 'CARD', 'CLICK', 'PAYME', 'TRANSFER')
--      under OWNER-20261105-05, adds partial unique index idx_cash_expenses_unique_reversal so an expense can be
--      reversed at most once, and adds chk_cash_expenses_no_self_reversal.
--   3. Adds cancel_reason and superseded_by_promise_id + idx_promises_active_invoice on promises_to_pay so repeated
--      partial payments supersede prior ACTIVE promises and a student is never reminded twice (11.03, CASE-22).
--   4. Re-applies least-privilege runtime role grants via eduerp_apply_role_grants().

ALTER TABLE "cash_shifts"
  ADD COLUMN IF NOT EXISTS "non_cash_expenses_uzs" BIGINT NOT NULL DEFAULT 0
    CHECK ("non_cash_expenses_uzs" >= 0);

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT c.conname
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
     WHERE t.relname = 'cash_expenses'
       AND c.contype = 'c'
       AND pg_get_constraintdef(c.oid) ILIKE '%payment_method%'
  LOOP
    EXECUTE format('ALTER TABLE "cash_expenses" DROP CONSTRAINT %I', r.conname);
  END LOOP;
END;
$$;

ALTER TABLE "cash_expenses"
  ADD CONSTRAINT "chk_cash_expenses_payment_method"
  CHECK ("payment_method" IN ('CASH', 'CARD', 'CLICK', 'PAYME', 'TRANSFER'));

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_cash_expenses_no_self_reversal'
  ) THEN
    ALTER TABLE "cash_expenses"
      ADD CONSTRAINT "chk_cash_expenses_no_self_reversal"
      CHECK ("reverses_expense_id" IS NULL OR "reverses_expense_id" <> "id");
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS "idx_cash_expenses_unique_reversal"
  ON "cash_expenses" ("center_id", "reverses_expense_id")
  WHERE "reverses_expense_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "idx_cash_expenses_center_shift_created"
  ON "cash_expenses" ("center_id", "cash_shift_id", "created_at" ASC, "id" ASC);

ALTER TABLE "promises_to_pay"
  ADD COLUMN IF NOT EXISTS "cancel_reason" VARCHAR(255) NULL DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS "superseded_by_promise_id" UUID NULL DEFAULT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "idx_promises_active_invoice"
  ON "promises_to_pay" ("center_id", "invoice_id")
  WHERE "status" = 'ACTIVE';

SELECT eduerp_apply_role_grants();
