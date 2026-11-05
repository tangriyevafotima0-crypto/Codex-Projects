-- EduERP v2.0 — Stage 08 & Stage 09 Additive Migration
-- Migration ID: 20261104000500_s08_billing_policy_cycles_trials_invoices
-- Target Engine: PostgreSQL 16
-- Scope (08.01–08.05, 09.01–09.05, K02, K05, L02 & OWNER-20261104-02 / 03 / OWNER-20261105-04):
--   1. K05: Widens mode columns on billing_policy_versions from VARCHAR(24) to VARCHAR(32) so 25-character
--      'CONTINUE_FROM_CLAMPED_DAY' and S09 policy literals store cleanly without VARCHAR(24) truncation/500 errors.
--   2. K02 & OWNER-20261105-04: Sets fail-closed 'UNCONFIGURED' defaults on billing_policy_versions for S08 billing
--      (first_partial_charge_mode, policy_confirmation_status, effective_from_date NULL) AND separate fail-closed
--      'UNCONFIGURED' defaults for S09 discount stacking and freeze credit (discount_stacking_mode, freeze_credit_basis,
--      discount_policy_status, freeze_policy_status) so general S08 billing confirmation never auto-confirms S09 features.
--   3. L02: Adds immutable allocated_lesson_ids_json and consumed_lesson_ids_json snapshots to append-only billing_cycles
--      and creates append-only technical helper table billing_cycle_lesson_allocations with UNIQUE(enrollment_id, lesson_id),
--      composite tenant-safe RESTRICT FKs, lineage trigger, and immutability trigger so LESSON_PACKAGE_12 lesson ownership
--      is durably persisted and never recomputed from mutable live schedules.
--   4. 09.02 & 09.03: Adds immutable policy snapshot metadata columns to append-only discount_approvals and freeze_records.
--   5. Re-applies runtime role grants via eduerp_apply_role_grants().

ALTER TABLE "billing_policy_versions"
  ALTER COLUMN "billing_mode" TYPE VARCHAR(32),
  ALTER COLUMN "rounding_mode" TYPE VARCHAR(32),
  ALTER COLUMN "discount_stacking_mode" TYPE VARCHAR(32),
  ALTER COLUMN "freeze_credit_basis" TYPE VARCHAR(32),
  ALTER COLUMN "rolling_month_end_mode" TYPE VARCHAR(32),
  ALTER COLUMN "package_cancel_mode" TYPE VARCHAR(32),
  ALTER COLUMN "refund_debt_mode" TYPE VARCHAR(32),
  ALTER COLUMN "discount_stacking_mode" SET DEFAULT 'UNCONFIGURED',
  ALTER COLUMN "freeze_credit_basis" SET DEFAULT 'UNCONFIGURED';

ALTER TABLE "billing_policy_versions"
  ADD COLUMN IF NOT EXISTS "first_partial_charge_mode" VARCHAR(32) NOT NULL DEFAULT 'UNCONFIGURED'
    CHECK ("first_partial_charge_mode" IN ('UNCONFIGURED', 'PRORATE_REMAINING_LESSONS', 'FULL_CYCLE')),
  ADD COLUMN IF NOT EXISTS "cancelled_lesson_proration_mode" VARCHAR(32) NOT NULL DEFAULT 'EXCLUDE_CANCELLED_FROM_PLANNED'
    CHECK ("cancelled_lesson_proration_mode" IN ('UNCONFIGURED', 'EXCLUDE_CANCELLED_FROM_PLANNED', 'COUNT_SCHEDULED_BASELINE')),
  ADD COLUMN IF NOT EXISTS "policy_confirmation_status" VARCHAR(24) NOT NULL DEFAULT 'UNCONFIGURED'
    CHECK ("policy_confirmation_status" IN ('UNCONFIGURED', 'CONFIRMED')),
  ADD COLUMN IF NOT EXISTS "discount_policy_status" VARCHAR(24) NOT NULL DEFAULT 'UNCONFIGURED'
    CHECK ("discount_policy_status" IN ('UNCONFIGURED', 'CONFIRMED')),
  ADD COLUMN IF NOT EXISTS "freeze_policy_status" VARCHAR(24) NOT NULL DEFAULT 'UNCONFIGURED'
    CHECK ("freeze_policy_status" IN ('UNCONFIGURED', 'CONFIRMED')),
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
  ADD COLUMN IF NOT EXISTS "allocated_lesson_ids_json" JSONB NULL DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS "consumed_lesson_ids_json" JSONB NULL DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS "calculation_version" VARCHAR(32) NOT NULL DEFAULT 's08-v1';

CREATE INDEX IF NOT EXISTS "idx_billing_cycles_center_enrollment_seq"
  ON "billing_cycles" ("center_id", "enrollment_id", "cycle_type", "cycle_seq" DESC);

-- L02: Durable, append-only package cycle -> lesson ownership allocation table
CREATE TABLE IF NOT EXISTS "billing_cycle_lesson_allocations" (
  "id" UUID PRIMARY KEY,
  "center_id" UUID NOT NULL,
  "billing_cycle_id" UUID NOT NULL,
  "enrollment_id" UUID NOT NULL,
  "lesson_id" UUID NOT NULL,
  "cycle_seq" INTEGER NOT NULL CHECK ("cycle_seq" >= 1),
  "slot_index" INTEGER NOT NULL CHECK ("slot_index" >= 1),
  "consumed_by_attendance" BOOLEAN NOT NULL DEFAULT FALSE,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "uq_bcla_id_center" UNIQUE ("id", "center_id"),
  CONSTRAINT "uq_bcla_enrollment_lesson" UNIQUE ("enrollment_id", "lesson_id"),
  CONSTRAINT "uq_bcla_cycle_lesson" UNIQUE ("billing_cycle_id", "lesson_id"),
  CONSTRAINT "uq_bcla_cycle_slot" UNIQUE ("billing_cycle_id", "slot_index"),
  CONSTRAINT "fk_bcla_cycle" FOREIGN KEY ("billing_cycle_id", "center_id")
    REFERENCES "billing_cycles" ("id", "center_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "fk_bcla_enrollment" FOREIGN KEY ("enrollment_id", "center_id")
    REFERENCES "enrollments" ("id", "center_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "fk_bcla_lesson" FOREIGN KEY ("lesson_id", "center_id")
    REFERENCES "lesson_occurrences" ("id", "center_id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE INDEX IF NOT EXISTS "idx_bcla_center_enrollment_seq"
  ON "billing_cycle_lesson_allocations" ("center_id", "enrollment_id", "cycle_seq" ASC, "slot_index" ASC);

CREATE OR REPLACE FUNCTION eduerp_enforce_bcla_lineage()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_cycle_enrollment_id UUID;
  v_enr_group_id UUID;
  v_lesson_group_id UUID;
BEGIN
  SELECT "enrollment_id" INTO v_cycle_enrollment_id
    FROM "billing_cycles"
   WHERE "id" = NEW.billing_cycle_id AND "center_id" = NEW.center_id;

  IF v_cycle_enrollment_id IS DISTINCT FROM NEW.enrollment_id THEN
    RAISE EXCEPTION 'LINEAGE_MISMATCH: billing_cycle_lesson_allocations.enrollment_id does not match billing_cycles.enrollment_id.'
      USING ERRCODE = '23503';
  END IF;

  SELECT "group_id" INTO v_enr_group_id
    FROM "enrollments"
   WHERE "id" = NEW.enrollment_id AND "center_id" = NEW.center_id;

  SELECT "group_id" INTO v_lesson_group_id
    FROM "lesson_occurrences"
   WHERE "id" = NEW.lesson_id AND "center_id" = NEW.center_id;

  IF v_enr_group_id IS DISTINCT FROM v_lesson_group_id THEN
    RAISE EXCEPTION 'LINEAGE_MISMATCH: billing_cycle_lesson_allocations lesson group_id does not match enrollment group_id.'
      USING ERRCODE = '23503';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_immutable_billing_cycle_lesson_allocations ON "billing_cycle_lesson_allocations";
CREATE TRIGGER trg_immutable_billing_cycle_lesson_allocations
  BEFORE UPDATE OR DELETE ON "billing_cycle_lesson_allocations"
  FOR EACH ROW EXECUTE FUNCTION eduerp_forbid_append_only_mutation();

DROP TRIGGER IF EXISTS trg_lineage_billing_cycle_lesson_allocations ON "billing_cycle_lesson_allocations";
CREATE TRIGGER trg_lineage_billing_cycle_lesson_allocations
  BEFORE INSERT OR UPDATE ON "billing_cycle_lesson_allocations"
  FOR EACH ROW EXECUTE FUNCTION eduerp_enforce_bcla_lineage();

ALTER TABLE "invoices"
  ADD COLUMN IF NOT EXISTS "tariff_effective_from_snapshot" DATE NULL,
  ADD COLUMN IF NOT EXISTS "collection_timing_snapshot" VARCHAR(16) NOT NULL DEFAULT 'ARREARS'
    CHECK ("collection_timing_snapshot" IN ('ADVANCE', 'ARREARS')),
  ADD COLUMN IF NOT EXISTS "calculation_version" VARCHAR(32) NOT NULL DEFAULT 's08-v1';

CREATE INDEX IF NOT EXISTS "idx_invoices_center_student_issued"
  ON "invoices" ("center_id", "student_id", "issued_at" DESC, "id" DESC);

CREATE INDEX IF NOT EXISTS "idx_attendance_records_trial_lookup"
  ON "attendance_records" ("center_id", "enrollment_id", "status", "lesson_id");

-- 09.02 & 09.03: Immutable policy snapshot columns on discount_approvals and freeze_records
ALTER TABLE "discount_approvals"
  ADD COLUMN IF NOT EXISTS "policy_version_id" UUID NULL,
  ADD COLUMN IF NOT EXISTS "discount_stacking_mode_snapshot" VARCHAR(32) NOT NULL DEFAULT 'UNCONFIGURED',
  ADD COLUMN IF NOT EXISTS "calculation_version" VARCHAR(32) NOT NULL DEFAULT 's09-v1';

ALTER TABLE "freeze_records"
  ADD COLUMN IF NOT EXISTS "policy_version_id" UUID NULL,
  ADD COLUMN IF NOT EXISTS "freeze_credit_basis_snapshot" VARCHAR(32) NOT NULL DEFAULT 'UNCONFIGURED',
  ADD COLUMN IF NOT EXISTS "calculation_version" VARCHAR(32) NOT NULL DEFAULT 's09-v1';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_discount_approvals_policy_version'
  ) THEN
    ALTER TABLE "discount_approvals"
      ADD CONSTRAINT "fk_discount_approvals_policy_version"
      FOREIGN KEY ("policy_version_id", "center_id")
      REFERENCES "billing_policy_versions" ("id", "center_id")
      ON DELETE RESTRICT ON UPDATE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_freeze_records_policy_version'
  ) THEN
    ALTER TABLE "freeze_records"
      ADD CONSTRAINT "fk_freeze_records_policy_version"
      FOREIGN KEY ("policy_version_id", "center_id")
      REFERENCES "billing_policy_versions" ("id", "center_id")
      ON DELETE RESTRICT ON UPDATE RESTRICT;
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS "idx_discount_requests_center_enr_status"
  ON "discount_requests" ("center_id", "enrollment_id", "status");

CREATE INDEX IF NOT EXISTS "idx_freeze_records_center_invoice"
  ON "freeze_records" ("center_id", "source_invoice_id");

CREATE OR REPLACE FUNCTION eduerp_apply_role_grants(
  p_api_role TEXT DEFAULT 'eduerp_api_runtime',
  p_worker_role TEXT DEFAULT 'eduerp_worker_runtime',
  p_readonly_role TEXT DEFAULT 'eduerp_readonly'
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  tbl TEXT;
  mutable_tables TEXT[] := ARRAY[
    'staff_users', 'staff_sessions', 'students', 'guardians', 'guardian_students',
    'guardian_telegram_links', 'courses', 'course_groups', 'enrollments',
    'lesson_occurrences', 'substitute_assignments', 'attendance_records',
    'grade_entries', 'trial_activations', 'invoices', 'discount_requests',
    'unapplied_credits', 'reversal_or_refund_requests', 'promises_to_pay',
    'cash_shifts', 'payroll_snapshots', 'outbox_events', 'notification_deliveries',
    'import_batches', 'center_licenses'
  ];
  append_only_tables TEXT[] := ARRAY[
    'course_price_history', 'attendance_revisions', 'client_operation_logs',
    'billing_policy_versions', 'billing_cycles', 'invoice_lines',
    'discount_approvals', 'freeze_records', 'freeze_lesson_links',
    'credit_notes', 'credit_note_applications', 'payments',
    'payment_allocations', 'payment_allocation_reversals',
    'reversal_or_refund_executions', 'receipts', 'cash_expenses',
    'ledger_entries', 'payroll_adjustments', 'audit_logs',
    'outbox_consumer_receipts'
  ];
  worker_mutable_tables TEXT[] := ARRAY[
    'outbox_events', 'notification_deliveries', 'promises_to_pay',
    'lesson_occurrences', 'invoices', 'enrollments', 'trial_activations',
    'guardian_telegram_links', 'center_licenses'
  ];
  worker_append_insert_tables TEXT[] := ARRAY[
    'outbox_consumer_receipts', 'audit_logs', 'billing_cycles',
    'invoice_lines', 'credit_notes', 'credit_note_applications', 'ledger_entries'
  ];
BEGIN
  IF p_api_role = p_worker_role OR p_api_role = p_readonly_role OR p_worker_role = p_readonly_role THEN
    RAISE EXCEPTION 'INVALID_ROLE_GRANT_TARGET: API (%s), Worker (%s), and Readonly (%s) roles must be distinct so grants do not overwrite one another (F05).',
      p_api_role, p_worker_role, p_readonly_role
      USING ERRCODE = '22023';
  END IF;

  REVOKE CREATE ON SCHEMA public FROM PUBLIC;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = p_api_role) THEN
    EXECUTE format('GRANT USAGE ON SCHEMA public TO %I;', p_api_role);
    FOREACH tbl IN ARRAY mutable_tables LOOP
      EXECUTE format('REVOKE ALL ON TABLE %I FROM %I;', tbl, p_api_role);
      EXECUTE format('GRANT SELECT, INSERT, UPDATE ON TABLE %I TO %I;', tbl, p_api_role);
    END LOOP;
    FOREACH tbl IN ARRAY append_only_tables LOOP
      EXECUTE format('REVOKE ALL ON TABLE %I FROM %I;', tbl, p_api_role);
      EXECUTE format('GRANT SELECT, INSERT ON TABLE %I TO %I;', tbl, p_api_role);
    END LOOP;
    IF EXISTS (
      SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'auth_rate_limit_buckets'
    ) THEN
      EXECUTE format('REVOKE ALL ON TABLE auth_rate_limit_buckets FROM %I;', p_api_role);
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE auth_rate_limit_buckets TO %I;', p_api_role);
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'billing_cycle_lesson_allocations'
    ) THEN
      EXECUTE format('REVOKE ALL ON TABLE billing_cycle_lesson_allocations FROM %I;', p_api_role);
      EXECUTE format('GRANT SELECT, INSERT ON TABLE billing_cycle_lesson_allocations TO %I;', p_api_role);
    END IF;
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE ledger_entries_entry_seq_seq TO %I;', p_api_role);
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = p_worker_role) THEN
    EXECUTE format('GRANT USAGE ON SCHEMA public TO %I;', p_worker_role);
    FOREACH tbl IN ARRAY mutable_tables LOOP
      EXECUTE format('REVOKE ALL ON TABLE %I FROM %I;', tbl, p_worker_role);
      IF tbl = ANY(worker_mutable_tables) THEN
        EXECUTE format('GRANT SELECT, INSERT, UPDATE ON TABLE %I TO %I;', tbl, p_worker_role);
      ELSE
        EXECUTE format('GRANT SELECT ON TABLE %I TO %I;', tbl, p_worker_role);
      END IF;
    END LOOP;
    FOREACH tbl IN ARRAY append_only_tables LOOP
      EXECUTE format('REVOKE ALL ON TABLE %I FROM %I;', tbl, p_worker_role);
      IF tbl = ANY(worker_append_insert_tables) THEN
        EXECUTE format('GRANT SELECT, INSERT ON TABLE %I TO %I;', tbl, p_worker_role);
      ELSE
        EXECUTE format('GRANT SELECT ON TABLE %I TO %I;', tbl, p_worker_role);
      END IF;
    END LOOP;
    IF EXISTS (
      SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'auth_rate_limit_buckets'
    ) THEN
      EXECUTE format('REVOKE ALL ON TABLE auth_rate_limit_buckets FROM %I;', p_worker_role);
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'billing_cycle_lesson_allocations'
    ) THEN
      EXECUTE format('REVOKE ALL ON TABLE billing_cycle_lesson_allocations FROM %I;', p_worker_role);
      EXECUTE format('GRANT SELECT, INSERT ON TABLE billing_cycle_lesson_allocations TO %I;', p_worker_role);
    END IF;
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE ledger_entries_entry_seq_seq TO %I;', p_worker_role);
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = p_readonly_role) THEN
    EXECUTE format('GRANT USAGE ON SCHEMA public TO %I;', p_readonly_role);
    FOREACH tbl IN ARRAY mutable_tables || append_only_tables LOOP
      EXECUTE format('REVOKE ALL ON TABLE %I FROM %I;', tbl, p_readonly_role);
      EXECUTE format('GRANT SELECT ON TABLE %I TO %I;', tbl, p_readonly_role);
    END LOOP;
    IF EXISTS (
      SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'auth_rate_limit_buckets'
    ) THEN
      EXECUTE format('REVOKE ALL ON TABLE auth_rate_limit_buckets FROM %I;', p_readonly_role);
      EXECUTE format('GRANT SELECT ON TABLE auth_rate_limit_buckets TO %I;', p_readonly_role);
    END IF;
    IF EXISTS (
      SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'billing_cycle_lesson_allocations'
    ) THEN
      EXECUTE format('REVOKE ALL ON TABLE billing_cycle_lesson_allocations FROM %I;', p_readonly_role);
      EXECUTE format('GRANT SELECT ON TABLE billing_cycle_lesson_allocations TO %I;', p_readonly_role);
    END IF;
  END IF;
END;
$$;

SELECT eduerp_apply_role_grants();
