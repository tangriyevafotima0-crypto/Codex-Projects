-- EduERP v2.0 — Stage 10 Additive Migration
-- Migration ID: 20261105000600_s10_payments_allocations_reversals_receipts
-- Target Engine: PostgreSQL 16
-- Scope (10.01–10.05 & OWNER-20261105-05):
--   1. Adds paid_at (external payment timestamp), recorded_at (server entry timestamp),
--      external_reference, payment_note, and source_channel to append-only payments table
--      so late manual entries preserve both timestamps and external references are uniquely
--      scoped per (center_id, payment_method, external_reference) when provided.
--   2. Adds currency, paid_at_snapshot, and recorded_at_snapshot to append-only receipts table.
--   3. Adds lookup indexes for student payments and payment reversal requests/executions.
--   4. Re-applies least-privilege runtime role grants via eduerp_apply_role_grants().

ALTER TABLE "payments"
  ADD COLUMN IF NOT EXISTS "paid_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS "recorded_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS "external_reference" VARCHAR(128) NULL DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS "payment_note" VARCHAR(500) NULL DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS "source_channel" VARCHAR(32) NOT NULL DEFAULT 'ADMIN_MANUAL_ENTRY'
    CHECK ("source_channel" IN ('ADMIN_MANUAL_ENTRY', 'DIRECTOR_MANUAL_ENTRY'));

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_payments_paid_at_not_after_recorded_at'
  ) THEN
    ALTER TABLE "payments"
      ADD CONSTRAINT "chk_payments_paid_at_not_after_recorded_at"
      CHECK ("paid_at" <= "recorded_at");
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS "idx_payments_center_method_ext_ref"
  ON "payments" ("center_id", "payment_method", "external_reference")
  WHERE "external_reference" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "idx_payments_center_student_created"
  ON "payments" ("center_id", "student_id", "created_at" DESC, "id" DESC);

ALTER TABLE "receipts"
  ADD COLUMN IF NOT EXISTS "currency" CHAR(3) NOT NULL DEFAULT 'UZS'
    CHECK ("currency" = 'UZS'),
  ADD COLUMN IF NOT EXISTS "paid_at_snapshot" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS "recorded_at_snapshot" TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS "idx_reversal_requests_center_payment"
  ON "reversal_or_refund_requests" ("center_id", "original_payment_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "idx_reversal_executions_center_payment"
  ON "reversal_or_refund_executions" ("center_id", "original_payment_id", "executed_at" DESC);

SELECT eduerp_apply_role_grants();
