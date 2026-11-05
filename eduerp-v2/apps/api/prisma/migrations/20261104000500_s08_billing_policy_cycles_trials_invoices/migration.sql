-- EduERP v2.0 — Stage 08 Additive Migration (Configurable Billing Policies, Cycles, Trial Conversion & Invoices)
-- Migration ID: 20261104000500_s08_billing_policy_cycles_trials_invoices
-- Target Engine: PostgreSQL 16
-- Scope (08.01–08.05 & OWNER-20261104-02 / OWNER-20261104-03):
--   1. Adds explicit per-center first_partial_charge_mode ('UNCONFIGURED' | 'PRORATE_REMAINING_LESSONS' | 'FULL_CYCLE'),
--      cancelled_lesson_proration_mode, policy_confirmation_status ('UNCONFIGURED' | 'CONFIRMED'),
--      effective_from_date, and created_by_staff_id to append-only billing_policy_versions (zero mutable version column).
--   2. Adds optional billing_policy_version_id binding on course_groups with composite tenant-safe FK.
--   3. Adds immutable snapshot metadata columns (due_date_rule_snapshot, fixed_due_day_snapshot,
--      collection_timing_snapshot, first_partial_charge_mode_snapshot, calculation_version) to append-only billing_cycles.
--   4. Adds tariff_effective_from_snapshot, collection_timing_snapshot, and calculation_version to invoices.
--   5. Extends eduerp_enforce_relational_lineage() so trial_activations enforces same-center/same-group lesson and
--      invoice lineage at the PostgreSQL trigger level, and re-applies runtime role grants via eduerp_apply_role_grants().

ALTER TABLE "billing_policy_versions"
  ADD COLUMN IF NOT EXISTS "first_partial_charge_mode" VARCHAR(32) NOT NULL DEFAULT 'UNCONFIGURED'
    CHECK ("first_partial_charge_mode" IN ('UNCONFIGURED', 'PRORATE_REMAINING_LESSONS', 'FULL_CYCLE')),
  ADD COLUMN IF NOT EXISTS "cancelled_lesson_proration_mode" VARCHAR(32) NOT NULL DEFAULT 'EXCLUDE_CANCELLED_FROM_PLANNED'
    CHECK ("cancelled_lesson_proration_mode" IN ('UNCONFIGURED', 'EXCLUDE_CANCELLED_FROM_PLANNED', 'COUNT_SCHEDULED_BASELINE')),
  ADD COLUMN IF NOT EXISTS "policy_confirmation_status" VARCHAR(24) NOT NULL DEFAULT 'CONFIRMED'
    CHECK ("policy_confirmation_status" IN ('UNCONFIGURED', 'CONFIRMED')),
  ADD COLUMN IF NOT EXISTS "effective_from_date" DATE NOT NULL DEFAULT DATE '2026-01-01',
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
