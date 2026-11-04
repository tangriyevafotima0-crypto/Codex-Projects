-- EduERP v2.0 — Stage 06 Additive Migration & G02/G05 Auth Security Remediation
-- Migration ID: 20261104000300_s06_auth_fixes_and_student_foundation
-- Target Engine: PostgreSQL 16
-- Scope (G02, G05, 06.01–06.04):
--   1. G05: Adds family_expires_at to staff_sessions and backfills existing rows so refresh rotation
--      never extends a session family beyond its original absolute deadline.
--   2. G02: Creates non-domain technical helper table auth_rate_limit_buckets (separate from the 46 canonical
--      domain tables, documented in ADR-006) for shared, bounded, restart-safe IP/center rate limiting across
--      multiple API instances without storing raw IP addresses or passwords.
--   3. 06.03: Adds transferred_from_enrollment_id with composite lineage FK (id, center_id, student_id) on
--      enrollments to preserve group transfer lineage and historical financial references.
--   4. 06.01–06.04: Adds center-scoped search and guardian-link indexes and refreshes least-privilege role grants.

ALTER TABLE "staff_sessions"
  ADD COLUMN IF NOT EXISTS "family_expires_at" TIMESTAMPTZ NULL;

UPDATE "staff_sessions"
   SET "family_expires_at" = "expires_at"
 WHERE "family_expires_at" IS NULL;

CREATE TABLE IF NOT EXISTS "auth_rate_limit_buckets" (
  "center_id" UUID NOT NULL,
  "bucket_key" VARCHAR(96) NOT NULL,
  "attempt_count" INTEGER NOT NULL DEFAULT 1 CHECK ("attempt_count" >= 1),
  "window_started_at" TIMESTAMPTZ NOT NULL,
  "expires_at" TIMESTAMPTZ NOT NULL,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "pk_auth_rate_limit_buckets" PRIMARY KEY ("center_id", "bucket_key")
);

CREATE INDEX IF NOT EXISTS "idx_auth_rate_limit_buckets_expires"
  ON "auth_rate_limit_buckets" ("center_id", "expires_at");

ALTER TABLE "enrollments"
  ADD COLUMN IF NOT EXISTS "transferred_from_enrollment_id" UUID NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_enrollments_transferred_from'
  ) THEN
    ALTER TABLE "enrollments"
      ADD CONSTRAINT "fk_enrollments_transferred_from"
      FOREIGN KEY ("transferred_from_enrollment_id", "center_id", "student_id")
      REFERENCES "enrollments" ("id", "center_id", "student_id")
      ON DELETE RESTRICT ON UPDATE RESTRICT;
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS "idx_students_center_normalized_name"
  ON "students" ("center_id", "normalized_name");

CREATE INDEX IF NOT EXISTS "idx_students_center_status_id"
  ON "students" ("center_id", "status", "id");

CREATE INDEX IF NOT EXISTS "idx_guardian_students_student_active"
  ON "guardian_students" ("center_id", "student_id", "active");

CREATE INDEX IF NOT EXISTS "idx_guardian_students_guardian_active"
  ON "guardian_students" ("center_id", "guardian_id", "active");

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
  END IF;
END;
$$;

SELECT eduerp_apply_role_grants();
