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

-- O03: Deterministically supersede older duplicate ACTIVE promises_to_pay rows per (center_id, invoice_id)
-- created by repeated S10 partial payments prior to S11 before creating idx_promises_active_invoice.
WITH ranked_active_promises AS (
  SELECT "id",
         "center_id",
         "invoice_id",
         FIRST_VALUE("id") OVER (
           PARTITION BY "center_id", "invoice_id"
           ORDER BY "created_at" DESC, "id" DESC
         ) AS newest_promise_id,
         ROW_NUMBER() OVER (
           PARTITION BY "center_id", "invoice_id"
           ORDER BY "created_at" DESC, "id" DESC
         ) AS rn
    FROM "promises_to_pay"
   WHERE "status" = 'ACTIVE'
)
UPDATE "promises_to_pay" AS p
   SET "status" = 'CANCELLED',
       "cancel_reason" = COALESCE(p."cancel_reason", 'SUPERSEDED_BY_NEW_PARTIAL_PAYMENT_PROMISE'),
       "superseded_by_promise_id" = r.newest_promise_id,
       "version" = p."version" + 1,
       "updated_at" = NOW()
  FROM ranked_active_promises AS r
 WHERE p."id" = r."id"
   AND p."center_id" = r."center_id"
   AND r.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS "idx_promises_active_invoice"
  ON "promises_to_pay" ("center_id", "invoice_id")
  WHERE "status" = 'ACTIVE';

SELECT eduerp_apply_role_grants();
