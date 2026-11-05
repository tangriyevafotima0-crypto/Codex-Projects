-- EduERP v2.0 — Stage 08 Additive Migration (Configurable Billing Policies, Cycles, Trial Conversion & Invoices)
-- Migration ID: 20261104000500_s08_billing_policy_cycles_trials_invoices
-- Target Engine: PostgreSQL 16
-- Scope (08.01–08.05, K02, K05 & OWNER-20261104-02 / OWNER-20261104-03):
--   1. K05: Widens mode columns on billing_policy_versions from VARCHAR(24) to VARCHAR(32) so 25-character
--      'CONTINUE_FROM_CLAMPED_DAY' and future policy literals store cleanly without VARCHAR(24) truncation/500 errors.
--   2. K02: Adds first_partial_charge_mode DEFAULT 'UNCONFIGURED', cancelled_lesson_proration_mode DEFAULT 'EXCLUDE_CANCELLED_FROM_PLANNED',
--      policy_confirmation_status DEFAULT 'UNCONFIGURED', effective_from_date DATE NULL DEFAULT NULL, and created_by_staff_id UUID NULL
--      to append-only billing_policy_versions. Existing/seed rows remain 'UNCONFIGURED' until a Center Director explicitly
--      creates a confirmed policy version.
--   3. Adds optional billing_policy_version_id binding on course_groups with composite tenant-safe FK.
--   4. Adds immutable snapshot metadata columns to append-only billing_cycles and mutable invoices.
--   5. Re-applies runtime role grants via eduerp_apply_role_grants().

ALTER TABLE "billing_policy_versions"
  ALTER COLUMN "billing_mode" TYPE VARCHAR(32),
  ALTER COLUMN "rounding_mode" TYPE VARCHAR(32),
  ALTER COLUMN "discount_stacking_mode" TYPE VARCHAR(32),
  ALTER COLUMN "freeze_credit_basis" TYPE VARCHAR(32),
  ALTER COLUMN "rolling_month_end_mode" TYPE VARCHAR(32),
  ALTER COLUMN "package_cancel_mode" TYPE VARCHAR(32),
  ALTER COLUMN "refund_debt_mode" TYPE VARCHAR(32);

ALTER TABLE "billing_policy_versions"
  ADD COLUMN IF NOT EXISTS "first_partial_charge_mode" VARCHAR(32) NOT NULL DEFAULT 'UNCONFIGURED'
    CHECK ("first_partial_charge_mode" IN ('UNCONFIGURED', 'PRORATE_REMAINING_LESSONS', 'FULL_CYCLE')),
  ADD COLUMN IF NOT EXISTS "cancelled_lesson_proration_mode" VARCHAR(32) NOT NULL DEFAULT 'EXCLUDE_CANCELLED_FROM_PLANNED'
    CHECK ("cancelled_lesson_proration_mode" IN ('UNCONFIGURED', 'EXCLUDE_CANCELLED_FROM_PLANNED', 'COUNT_SCHEDULED_BASELINE')),
  ADD COLUMN IF NOT EXISTS "policy_confirmation_status" VARCHAR(24) NOT NULL DEFAULT 'UNCONFIGURED'
    CHECK ("policy_confirmation_status" IN ('UNCONFIGURED', 'CONFIRMED')),
  ADD COLUMN IF NOT EXISTS "effective_from_date" DATE NULL DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS "created_by_staff_id" UUID NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_billing_policy_versions_created_by'
  ) THEN
    ALTER TABLE "billing_policy_versions"
      ADD CONSTRAINT "fk_billing_policy_versions_created_by"
      FOREIGN KEY ("created_by_staff_id", "center_id")
      REFERENCES "staff_users" ("id", "center_id")
      ON DELETE RESTRICT ON UPDATE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_billing_policy_versions_rolling_end_mode'
  ) THEN
    ALTER TABLE "billing_policy_versions"
      ADD CONSTRAINT "chk_billing_policy_versions_rolling_end_mode"
      CHECK ("rolling_month_end_mode" IN ('CLAMP_LAST_DAY', 'CONTINUE_FROM_CLAMPED_DAY', 'RESTORE_ANCHOR_31', 'UNCONFIGURED'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_billing_policy_versions_package_cancel_mode'
  ) THEN
    ALTER TABLE "billing_policy_versions"
      ADD CONSTRAINT "chk_billing_policy_versions_package_cancel_mode"
      CHECK ("package_cancel_mode" IN ('PRESERVE_BALANCE', 'CREDIT_NEXT_CYCLE', 'UNCONFIGURED'));
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS "idx_billing_policy_versions_center_mode_ver"
  ON "billing_policy_versions" ("center_id", "billing_mode", "effective_from_date" DESC, "version_number" DESC);

ALTER TABLE "course_groups"
  ADD COLUMN IF NOT EXISTS "billing_policy_version_id" UUID NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_course_groups_billing_policy_version'
  ) THEN
    ALTER TABLE "course_groups"
      ADD CONSTRAINT "fk_course_groups_billing_policy_version"
      FOREIGN KEY ("billing_policy_version_id", "center_id")
      REFERENCES "billing_policy_versions" ("id", "center_id")
      ON DELETE RESTRICT ON UPDATE RESTRICT;
  END IF;
END;
$$;

ALTER TABLE "billing_cycles"
  ADD COLUMN IF NOT EXISTS "due_date_rule_snapshot" VARCHAR(32) NOT NULL DEFAULT 'ENROLLMENT_ANNIVERSARY'
    CHECK ("due_date_rule_snapshot" IN ('ENROLLMENT_ANNIVERSARY', 'CENTER_FIXED_DAY')),
  ADD COLUMN IF NOT EXISTS "fixed_due_day_snapshot" SMALLINT NULL
    CHECK ("fixed_due_day_snapshot" IS NULL OR ("fixed_due_day_snapshot" BETWEEN 1 AND 31)),
  ADD COLUMN IF NOT EXISTS "collection_timing_snapshot" VARCHAR(16) NOT NULL DEFAULT 'ARREARS'
    CHECK ("collection_timing_snapshot" IN ('ADVANCE', 'ARREARS')),
  ADD COLUMN IF NOT EXISTS "first_partial_charge_mode_snapshot" VARCHAR(32) NOT NULL DEFAULT 'PRORATE_REMAINING_LESSONS'
    CHECK ("first_partial_charge_mode_snapshot" IN ('UNCONFIGURED', 'PRORATE_REMAINING_LESSONS', 'FULL_CYCLE')),
  ADD COLUMN IF NOT EXISTS "calculation_version" VARCHAR(32) NOT NULL DEFAULT 's08-v1';

CREATE INDEX IF NOT EXISTS "idx_billing_cycles_center_enrollment_seq"
  ON "billing_cycles" ("center_id", "enrollment_id", "cycle_type", "cycle_seq" DESC);

ALTER TABLE "invoices"
  ADD COLUMN IF NOT EXISTS "tariff_effective_from_snapshot" DATE NULL,
  ADD COLUMN IF NOT EXISTS "collection_timing_snapshot" VARCHAR(16) NOT NULL DEFAULT 'ARREARS'
    CHECK ("collection_timing_snapshot" IN ('ADVANCE', 'ARREARS')),
  ADD COLUMN IF NOT EXISTS "calculation_version" VARCHAR(32) NOT NULL DEFAULT 's08-v1';

CREATE INDEX IF NOT EXISTS "idx_invoices_center_student_issued"
  ON "invoices" ("center_id", "student_id", "issued_at" DESC, "id" DESC);

CREATE INDEX IF NOT EXISTS "idx_attendance_records_trial_lookup"
  ON "attendance_records" ("center_id", "enrollment_id", "status", "lesson_id");

SELECT eduerp_apply_role_grants();
