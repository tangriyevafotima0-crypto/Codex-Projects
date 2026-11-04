-- EduERP v2.0 — Stage 04 Initial Database Foundation Migration
-- Migration ID: 20261104000100_initial_foundation (mapped from planning target `initial/migration.sql` per ADR-004)
-- Target Engine: PostgreSQL 16
-- Scope:
--   1. Creates all 46 canonical tables (25 Mutable + 21 Strictly Append-Only).
--   2. Enforces composite tenant foreign keys (id, center_id) with ON DELETE RESTRICT / ON UPDATE RESTRICT.
--   3. Enforces domain CHECK constraints (positive/non-negative/non-zero BIGINT money, actor_type STAFF|SYSTEM_WORKER,
--      cash shift drawer formula, invoice balance formula, churn_reason_code 1..5, attendance ADMIN_OVERRIDE reason).
--   4. Enforces UNIQUE and partial unique indexes (active enrollment, active guardian link, active substitute,
--      active trial activation, single open cash shift, multi-lesson daily occurrence_seq, billing cycle identity).
--   5. Installs defense-in-depth triggers:
--      - eduerp_forbid_append_only_mutation() on all 21 append-only tables
--      - eduerp_guard_closed_state_mutation() on cash_shifts and payroll_snapshots once CLOSED
--      - eduerp_guard_last_active_director() on staff_users
--   6. Defines idempotent eduerp_apply_role_grants() to enforce least-privilege grants for separated DB roles.

-- ============================================================================
-- SECTION 1: CANONICAL TABLES (46 ENTITIES)
-- ============================================================================

CREATE TABLE IF NOT EXISTS "center_licenses" (
  "center_id" UUID PRIMARY KEY,
  "center_slug" VARCHAR(64) NOT NULL UNIQUE,
  "license_status" VARCHAR(16) NOT NULL CHECK ("license_status" IN ('ACTIVE', 'GRACE_PERIOD', 'READ_ONLY')),
  "signed_jwt_token" TEXT NOT NULL,
  "signature_key_id" VARCHAR(32) NOT NULL,
  "valid_until_utc" TIMESTAMPTZ NOT NULL,
  "grace_until_utc" TIMESTAMPTZ NOT NULL,
  "last_verified_at_utc" TIMESTAMPTZ NOT NULL,
  "updated_by_vendor_audit_id" UUID NULL,
  "version" INTEGER NOT NULL DEFAULT 1 CHECK ("version" >= 1),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS "staff_users" (
  "id" UUID PRIMARY KEY,
  "center_id" UUID NOT NULL,
  "role" VARCHAR(16) NOT NULL CHECK ("role" IN ('DIRECTOR', 'ADMIN', 'TEACHER')),
  "full_name" VARCHAR(120) NOT NULL,
  "login_username" VARCHAR(64) NOT NULL,
  "phone_e164" VARCHAR(20) NULL CHECK ("phone_e164" IS NULL OR "phone_e164" ~ '^\+[1-9][0-9]{7,14}$'),
  "telegram_user_id" BIGINT NULL,
  "password_hash" TEXT NOT NULL,
  "must_change_password" BOOLEAN NOT NULL DEFAULT TRUE,
  "status" VARCHAR(16) NOT NULL CHECK ("status" IN ('ACTIVE', 'DEACTIVATED')),
  "failed_login_count" INTEGER NOT NULL DEFAULT 0 CHECK ("failed_login_count" >= 0),
  "locked_until" TIMESTAMPTZ NULL,
  "version" INTEGER NOT NULL DEFAULT 1 CHECK ("version" >= 1),
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "uq_staff_users_id_center" UNIQUE ("id", "center_id"),
  CONSTRAINT "uq_staff_users_center_username" UNIQUE ("center_id", "login_username")
);
CREATE INDEX IF NOT EXISTS "idx_staff_users_center_role_status" ON "staff_users" ("center_id", "role", "status");

CREATE TABLE IF NOT EXISTS "staff_sessions" (
  "id" UUID PRIMARY KEY,
  "center_id" UUID NOT NULL,
  "staff_id" UUID NOT NULL,
  "refresh_token_hash" CHAR(64) NOT NULL UNIQUE,
  "role_snapshot" VARCHAR(16) NOT NULL CHECK ("role_snapshot" IN ('DIRECTOR', 'ADMIN', 'TEACHER')),
  "device_info" VARCHAR(255) NULL,
  "expires_at" TIMESTAMPTZ NOT NULL,
  "revoked_at" TIMESTAMPTZ NULL,
  "revoke_reason" VARCHAR(64) NULL,
  "version" INTEGER NOT NULL DEFAULT 1 CHECK ("version" >= 1),
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "fk_staff_sessions_staff" FOREIGN KEY ("staff_id", "center_id")
    REFERENCES "staff_users" ("id", "center_id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX IF NOT EXISTS "idx_staff_sessions_staff_revoked" ON "staff_sessions" ("staff_id", "revoked_at");

CREATE TABLE IF NOT EXISTS "students" (
  "id" UUID PRIMARY KEY,
  "center_id" UUID NOT NULL,
  "student_code" VARCHAR(24) NOT NULL,
  "full_name" VARCHAR(120) NOT NULL,
  "normalized_name" VARCHAR(120) NOT NULL,
  "birth_date" DATE NULL,
  "status" VARCHAR(16) NOT NULL CHECK ("status" IN ('ACTIVE', 'ARCHIVED')),
  "notes" TEXT NULL,
  "version" INTEGER NOT NULL DEFAULT 1 CHECK ("version" >= 1),
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "uq_students_id_center" UNIQUE ("id", "center_id"),
  CONSTRAINT "uq_students_center_code" UNIQUE ("center_id", "student_code")
);
CREATE INDEX IF NOT EXISTS "idx_students_center_norm_status" ON "students" ("center_id", "normalized_name", "status");

CREATE TABLE IF NOT EXISTS "guardians" (
  "id" UUID PRIMARY KEY,
  "center_id" UUID NOT NULL,
  "full_name" VARCHAR(120) NOT NULL,
  "phone_e164" VARCHAR(20) NOT NULL CHECK ("phone_e164" ~ '^\+[1-9][0-9]{7,14}$'),
  "status" VARCHAR(16) NOT NULL CHECK ("status" IN ('ACTIVE', 'ARCHIVED')),
  "version" INTEGER NOT NULL DEFAULT 1 CHECK ("version" >= 1),
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "uq_guardians_id_center" UNIQUE ("id", "center_id"),
  CONSTRAINT "uq_guardians_center_phone" UNIQUE ("center_id", "phone_e164")
);

CREATE TABLE IF NOT EXISTS "guardian_students" (
  "id" UUID PRIMARY KEY,
  "center_id" UUID NOT NULL,
  "guardian_id" UUID NOT NULL,
  "student_id" UUID NOT NULL,
  "relationship" VARCHAR(32) NOT NULL CHECK ("relationship" IN ('MOTHER', 'FATHER', 'GUARDIAN', 'SELF')),
  "is_primary_payer" BOOLEAN NOT NULL DEFAULT TRUE,
  "active" BOOLEAN NOT NULL DEFAULT TRUE,
  "version" INTEGER NOT NULL DEFAULT 1 CHECK ("version" >= 1),
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "unlinked_at" TIMESTAMPTZ NULL,
  CONSTRAINT "uq_guardian_students_pair" UNIQUE ("guardian_id", "student_id"),
  CONSTRAINT "fk_guardian_students_guardian" FOREIGN KEY ("guardian_id", "center_id")
    REFERENCES "guardians" ("id", "center_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "fk_guardian_students_student" FOREIGN KEY ("student_id", "center_id")
    REFERENCES "students" ("id", "center_id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX IF NOT EXISTS "idx_guardian_students_student_active" ON "guardian_students" ("student_id", "active");

CREATE TABLE IF NOT EXISTS "guardian_telegram_links" (
  "id" UUID PRIMARY KEY,
  "center_id" UUID NOT NULL,
  "guardian_id" UUID NOT NULL,
  "invite_token_hash" CHAR(64) NOT NULL UNIQUE,
  "invite_expires_at" TIMESTAMPTZ NOT NULL,
  "invite_used_at" TIMESTAMPTZ NULL,
  "telegram_user_id" BIGINT NULL,
  "telegram_chat_id" BIGINT NULL,
  "linked_phone_e164" VARCHAR(20) NOT NULL CHECK ("linked_phone_e164" ~ '^\+[1-9][0-9]{7,14}$'),
  "status" VARCHAR(24) NOT NULL CHECK ("status" IN ('INVITED', 'ACTIVE', 'BOT_BLOCKED_403', 'UNLINKED_REVOKED')),
  "last_delivery_status" VARCHAR(24) NULL,
  "last_error_at" TIMESTAMPTZ NULL,
  "revoked_at" TIMESTAMPTZ NULL,
  "revoke_reason" VARCHAR(64) NULL,
  "version" INTEGER NOT NULL DEFAULT 1 CHECK ("version" >= 1),
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "fk_guardian_tg_links_guardian" FOREIGN KEY ("guardian_id", "center_id")
    REFERENCES "guardians" ("id", "center_id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS "idx_guardian_telegram_links_active"
  ON "guardian_telegram_links" ("center_id", "guardian_id") WHERE "status" = 'ACTIVE';
CREATE INDEX IF NOT EXISTS "idx_guardian_tg_links_chat_status"
  ON "guardian_telegram_links" ("center_id", "telegram_chat_id", "status");

CREATE TABLE IF NOT EXISTS "courses" (
  "id" UUID PRIMARY KEY,
  "center_id" UUID NOT NULL,
  "name" VARCHAR(100) NOT NULL,
  "default_monthly_fee_uzs" BIGINT NOT NULL CHECK ("default_monthly_fee_uzs" >= 0),
  "default_lessons_per_cycle" INTEGER NOT NULL DEFAULT 12 CHECK ("default_lessons_per_cycle" > 0),
  "status" VARCHAR(16) NOT NULL CHECK ("status" IN ('ACTIVE', 'ARCHIVED')),
  "version" INTEGER NOT NULL DEFAULT 1 CHECK ("version" >= 1),
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "uq_courses_id_center" UNIQUE ("id", "center_id"),
  CONSTRAINT "uq_courses_center_name" UNIQUE ("center_id", "name")
);

CREATE TABLE IF NOT EXISTS "course_groups" (
  "id" UUID PRIMARY KEY,
  "center_id" UUID NOT NULL,
  "course_id" UUID NOT NULL,
  "name" VARCHAR(100) NOT NULL,
  "primary_teacher_id" UUID NOT NULL,
  "billing_mode" VARCHAR(24) NOT NULL CHECK ("billing_mode" IN ('CALENDAR_PRO_RATA', 'ROLLING_MONTH', 'LESSON_PACKAGE_12')),
  "current_fee_uzs" BIGINT NOT NULL CHECK ("current_fee_uzs" >= 0),
  "lessons_per_cycle" INTEGER NOT NULL DEFAULT 12 CHECK ("lessons_per_cycle" > 0),
  "schedule_days_json" JSONB NOT NULL,
  "starts_time" VARCHAR(8) NOT NULL,
  "duration_minutes" INTEGER NOT NULL CHECK ("duration_minutes" > 0),
  "timezone" VARCHAR(64) NOT NULL DEFAULT 'Asia/Tashkent',
  "status" VARCHAR(16) NOT NULL CHECK ("status" IN ('ACTIVE', 'ARCHIVED')),
  "version" INTEGER NOT NULL DEFAULT 1 CHECK ("version" >= 1),
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "uq_course_groups_id_center" UNIQUE ("id", "center_id"),
  CONSTRAINT "fk_course_groups_course" FOREIGN KEY ("course_id", "center_id")
    REFERENCES "courses" ("id", "center_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "fk_course_groups_teacher" FOREIGN KEY ("primary_teacher_id", "center_id")
    REFERENCES "staff_users" ("id", "center_id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX IF NOT EXISTS "idx_course_groups_teacher_status"
  ON "course_groups" ("center_id", "primary_teacher_id", "status");

CREATE TABLE IF NOT EXISTS "course_price_history" (
  "id" UUID PRIMARY KEY,
  "center_id" UUID NOT NULL,
  "course_id" UUID NOT NULL,
  "group_id" UUID NULL,
  "previous_fee_uzs" BIGINT NOT NULL CHECK ("previous_fee_uzs" >= 0),
  "new_fee_uzs" BIGINT NOT NULL CHECK ("new_fee_uzs" >= 0),
  "effective_from" DATE NOT NULL,
  "changed_by_staff_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "fk_course_price_history_course" FOREIGN KEY ("course_id", "center_id")
    REFERENCES "courses" ("id", "center_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "fk_course_price_history_group" FOREIGN KEY ("group_id", "center_id")
    REFERENCES "course_groups" ("id", "center_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "fk_course_price_history_staff" FOREIGN KEY ("changed_by_staff_id", "center_id")
    REFERENCES "staff_users" ("id", "center_id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX IF NOT EXISTS "idx_course_price_history_course_date" ON "course_price_history" ("course_id", "effective_from");

CREATE TABLE IF NOT EXISTS "enrollments" (
  "id" UUID PRIMARY KEY,
  "center_id" UUID NOT NULL,
  "student_id" UUID NOT NULL,
  "group_id" UUID NOT NULL,
  "status" VARCHAR(16) NOT NULL CHECK ("status" IN ('TRIAL', 'ACTIVE', 'FROZEN', 'LEFT')),
  "enrolled_at_date" DATE NOT NULL,
  "first_trial_lesson_id" UUID NULL,
  "first_trial_date" DATE NULL,
  "activated_at" TIMESTAMPTZ NULL,
  "billing_anchor_day" SMALLINT NULL CHECK ("billing_anchor_day" IS NULL OR ("billing_anchor_day" BETWEEN 1 AND 31)),
  "package_lessons_remaining" INTEGER NULL CHECK ("package_lessons_remaining" IS NULL OR "package_lessons_remaining" >= 0),
  "left_at_date" DATE NULL,
  "churn_reason_code" SMALLINT NULL CHECK ("churn_reason_code" IS NULL OR "churn_reason_code" IN (1, 2, 3, 4, 5)),
  "churn_attributed_teacher_id" UUID NULL,
  "churn_notes" TEXT NULL,
  "version" INTEGER NOT NULL DEFAULT 1 CHECK ("version" >= 1),
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "uq_enrollments_id_center" UNIQUE ("id", "center_id"),
  CONSTRAINT "chk_enrollments_left_churn" CHECK (("status" <> 'LEFT') OR ("left_at_date" IS NOT NULL AND "churn_reason_code" IS NOT NULL)),
  CONSTRAINT "fk_enrollments_student" FOREIGN KEY ("student_id", "center_id")
    REFERENCES "students" ("id", "center_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "fk_enrollments_group" FOREIGN KEY ("group_id", "center_id")
    REFERENCES "course_groups" ("id", "center_id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS "idx_enrollments_active_student_group"
  ON "enrollments" ("student_id", "group_id") WHERE "status" IN ('TRIAL', 'ACTIVE', 'FROZEN');
CREATE INDEX IF NOT EXISTS "idx_enrollments_student_status" ON "enrollments" ("student_id", "status");

CREATE TABLE IF NOT EXISTS "lesson_occurrences" (
  "id" UUID PRIMARY KEY,
  "center_id" UUID NOT NULL,
  "group_id" UUID NOT NULL,
  "lesson_date" DATE NOT NULL,
  "occurrence_seq" SMALLINT NOT NULL DEFAULT 1 CHECK ("occurrence_seq" >= 1),
  "starts_at_utc" TIMESTAMPTZ NOT NULL,
  "ends_at_utc" TIMESTAMPTZ NOT NULL CHECK ("ends_at_utc" > "starts_at_utc"),
  "status" VARCHAR(20) NOT NULL CHECK ("status" IN ('SCHEDULED', 'COMPLETED', 'CANCELLED_BY_CENTER', 'RESCHEDULED')),
  "rescheduled_from_lesson_id" UUID NULL,
  "primary_teacher_snapshot_id" UUID NOT NULL,
  "pay_recipient_teacher_id" UUID NOT NULL,
  "attendance_submitted_at" TIMESTAMPTZ NULL,
  "attendance_submitted_by" UUID NULL,
  "teacher_ping_sent_at" TIMESTAMPTZ NULL,
  "admin_escalation_sent_at" TIMESTAMPTZ NULL,
  "version" INTEGER NOT NULL DEFAULT 1 CHECK ("version" >= 1),
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "uq_lesson_occurrences_id_center" UNIQUE ("id", "center_id"),
  CONSTRAINT "uq_lesson_occurrences_group_date_seq" UNIQUE ("group_id", "lesson_date", "occurrence_seq"),
  CONSTRAINT "uq_lesson_occurrences_group_starts" UNIQUE ("group_id", "starts_at_utc"),
  CONSTRAINT "fk_lesson_occurrences_group" FOREIGN KEY ("group_id", "center_id")
    REFERENCES "course_groups" ("id", "center_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "fk_lesson_occurrences_primary_teacher" FOREIGN KEY ("primary_teacher_snapshot_id", "center_id")
    REFERENCES "staff_users" ("id", "center_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "fk_lesson_occurrences_pay_teacher" FOREIGN KEY ("pay_recipient_teacher_id", "center_id")
    REFERENCES "staff_users" ("id", "center_id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX IF NOT EXISTS "idx_lesson_occurrences_center_status_starts"
  ON "lesson_occurrences" ("center_id", "status", "starts_at_utc");

CREATE TABLE IF NOT EXISTS "substitute_assignments" (
  "id" UUID PRIMARY KEY,
  "center_id" UUID NOT NULL,
  "lesson_id" UUID NOT NULL,
  "original_teacher_id" UUID NOT NULL,
  "substitute_teacher_id" UUID NOT NULL CHECK ("substitute_teacher_id" <> "original_teacher_id"),
  "assigned_by_admin_id" UUID NOT NULL,
  "reason" VARCHAR(255) NOT NULL,
  "status" VARCHAR(16) NOT NULL CHECK ("status" IN ('ACTIVE', 'REVOKED')),
  "pay_share_policy_snapshot" VARCHAR(32) NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1 CHECK ("version" >= 1),
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "revoked_at" TIMESTAMPTZ NULL,
  CONSTRAINT "uq_substitute_assignments_id_center" UNIQUE ("id", "center_id"),
  CONSTRAINT "fk_substitute_assignments_lesson" FOREIGN KEY ("lesson_id", "center_id")
    REFERENCES "lesson_occurrences" ("id", "center_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "fk_substitute_assignments_orig_teacher" FOREIGN KEY ("original_teacher_id", "center_id")
    REFERENCES "staff_users" ("id", "center_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "fk_substitute_assignments_sub_teacher" FOREIGN KEY ("substitute_teacher_id", "center_id")
    REFERENCES "staff_users" ("id", "center_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "fk_substitute_assignments_admin" FOREIGN KEY ("assigned_by_admin_id", "center_id")
    REFERENCES "staff_users" ("id", "center_id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS "idx_substitute_assignments_active_lesson"
  ON "substitute_assignments" ("lesson_id") WHERE "status" = 'ACTIVE';

CREATE TABLE IF NOT EXISTS "attendance_records" (
  "id" UUID PRIMARY KEY,
  "center_id" UUID NOT NULL,
  "lesson_id" UUID NOT NULL,
  "student_id" UUID NOT NULL,
  "enrollment_id" UUID NOT NULL,
  "status" VARCHAR(16) NOT NULL CHECK ("status" IN ('PRESENT', 'LATE', 'ABSENT')),
  "is_excused_frozen" BOOLEAN NOT NULL DEFAULT FALSE,
  "source_channel" VARCHAR(20) NOT NULL CHECK ("source_channel" IN ('TEACHER_MOBILE', 'TEACHER_WEB', 'ADMIN_EXCEL', 'ADMIN_OVERRIDE')),
  "recorded_by_staff_id" UUID NOT NULL,
  "override_reason" TEXT NULL,
  "client_operation_uuid" UUID NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1 CHECK ("version" >= 1),
  "submitted_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "uq_attendance_records_id_center" UNIQUE ("id", "center_id"),
  CONSTRAINT "uq_attendance_records_lesson_student" UNIQUE ("lesson_id", "student_id"),
  CONSTRAINT "chk_attendance_records_override_reason" CHECK (
    "source_channel" <> 'ADMIN_OVERRIDE' OR ("override_reason" IS NOT NULL AND length(btrim("override_reason")) >= 3)
  ),
  CONSTRAINT "fk_attendance_records_lesson" FOREIGN KEY ("lesson_id", "center_id")
    REFERENCES "lesson_occurrences" ("id", "center_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "fk_attendance_records_student" FOREIGN KEY ("student_id", "center_id")
    REFERENCES "students" ("id", "center_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "fk_attendance_records_enrollment" FOREIGN KEY ("enrollment_id", "center_id")
    REFERENCES "enrollments" ("id", "center_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "fk_attendance_records_staff" FOREIGN KEY ("recorded_by_staff_id", "center_id")
    REFERENCES "staff_users" ("id", "center_id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE TABLE IF NOT EXISTS "attendance_revisions" (
  "id" UUID PRIMARY KEY,
  "center_id" UUID NOT NULL,
  "attendance_record_id" UUID NOT NULL,
  "revision_version" INTEGER NOT NULL CHECK ("revision_version" >= 1),
  "previous_status" VARCHAR(16) NULL CHECK ("previous_status" IS NULL OR "previous_status" IN ('PRESENT', 'LATE', 'ABSENT')),
  "new_status" VARCHAR(16) NOT NULL CHECK ("new_status" IN ('PRESENT', 'LATE', 'ABSENT')),
  "source_channel" VARCHAR(20) NOT NULL CHECK ("source_channel" IN ('TEACHER_MOBILE', 'TEACHER_WEB', 'ADMIN_EXCEL', 'ADMIN_OVERRIDE')),
  "actor_staff_id" UUID NOT NULL,
  "reason" TEXT NULL,
  "client_operation_uuid" UUID NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "uq_attendance_revisions_rec_ver" UNIQUE ("attendance_record_id", "revision_version"),
  CONSTRAINT "fk_attendance_revisions_record" FOREIGN KEY ("attendance_record_id", "center_id")
    REFERENCES "attendance_records" ("id", "center_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "fk_attendance_revisions_staff" FOREIGN KEY ("actor_staff_id", "center_id")
    REFERENCES "staff_users" ("id", "center_id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE TABLE IF NOT EXISTS "client_operation_logs" (
  "client_operation_uuid" UUID PRIMARY KEY,
  "center_id" UUID NOT NULL,
  "actor_id" UUID NOT NULL,
  "operation_type" VARCHAR(48) NOT NULL,
  "request_body_sha256" CHAR(64) NOT NULL,
  "response_status_code" INTEGER NOT NULL,
  "response_payload_json" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "uq_client_operation_logs_scope" UNIQUE ("center_id", "actor_id", "operation_type", "client_operation_uuid")
);

CREATE TABLE IF NOT EXISTS "grade_entries" (
  "id" UUID PRIMARY KEY,
  "center_id" UUID NOT NULL,
  "lesson_id" UUID NOT NULL,
  "enrollment_id" UUID NOT NULL,
  "student_id" UUID NOT NULL,
  "score" NUMERIC(5,2) NOT NULL CHECK ("score" >= 0 AND "score" <= 100),
  "comment_sanitized" VARCHAR(500) NULL,
  "recorded_by_teacher_id" UUID NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1 CHECK ("version" >= 1),
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "uq_grade_entries_lesson_student" UNIQUE ("lesson_id", "student_id"),
  CONSTRAINT "fk_grade_entries_lesson" FOREIGN KEY ("lesson_id", "center_id")
    REFERENCES "lesson_occurrences" ("id", "center_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "fk_grade_entries_enrollment" FOREIGN KEY ("enrollment_id", "center_id")
    REFERENCES "enrollments" ("id", "center_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "fk_grade_entries_student" FOREIGN KEY ("student_id", "center_id")
    REFERENCES "students" ("id", "center_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "fk_grade_entries_teacher" FOREIGN KEY ("recorded_by_teacher_id", "center_id")
    REFERENCES "staff_users" ("id", "center_id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE TABLE IF NOT EXISTS "billing_policy_versions" (
  "id" UUID PRIMARY KEY,
  "center_id" UUID NOT NULL,
  "version_number" INTEGER NOT NULL CHECK ("version_number" >= 1),
  "billing_mode" VARCHAR(24) NOT NULL,
  "rounding_mode" VARCHAR(24) NOT NULL,
  "discount_stacking_mode" VARCHAR(24) NOT NULL,
  "freeze_credit_basis" VARCHAR(32) NOT NULL,
  "rolling_month_end_mode" VARCHAR(24) NOT NULL,
  "package_cancel_mode" VARCHAR(24) NOT NULL,
  "refund_debt_mode" VARCHAR(24) NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "uq_billing_policy_versions_id_center" UNIQUE ("id", "center_id"),
  CONSTRAINT "uq_billing_policy_versions_center_num" UNIQUE ("center_id", "version_number")
);

CREATE TABLE IF NOT EXISTS "trial_activations" (
  "id" UUID PRIMARY KEY,
  "center_id" UUID NOT NULL,
  "enrollment_id" UUID NOT NULL,
  "trial_activation_seq" INTEGER NOT NULL CHECK ("trial_activation_seq" >= 1),
  "first_trial_lesson_id" UUID NOT NULL,
  "second_trigger_lesson_id" UUID NOT NULL CHECK ("second_trigger_lesson_id" <> "first_trial_lesson_id"),
  "generated_invoice_id" UUID NOT NULL,
  "status" VARCHAR(24) NOT NULL CHECK ("status" IN ('ACTIVE_ACTIVATION', 'COMPENSATED_VOID')),
  "compensated_by_credit_note_id" UUID NULL,
  "compensated_reason" TEXT NULL,
  "version" INTEGER NOT NULL DEFAULT 1 CHECK ("version" >= 1),
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "compensated_at" TIMESTAMPTZ NULL,
  CONSTRAINT "uq_trial_activations_id_center" UNIQUE ("id", "center_id"),
  CONSTRAINT "uq_trial_activations_enr_seq" UNIQUE ("enrollment_id", "trial_activation_seq"),
  CONSTRAINT "fk_trial_activations_enrollment" FOREIGN KEY ("enrollment_id", "center_id")
    REFERENCES "enrollments" ("id", "center_id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS "idx_trial_activations_active_enrollment"
  ON "trial_activations" ("enrollment_id") WHERE "status" = 'ACTIVE_ACTIVATION';

CREATE TABLE IF NOT EXISTS "billing_cycles" (
  "id" UUID PRIMARY KEY,
  "center_id" UUID NOT NULL,
  "enrollment_id" UUID NOT NULL,
  "cycle_type" VARCHAR(24) NOT NULL CHECK ("cycle_type" IN ('CALENDAR_MONTH', 'ROLLING_MONTH', 'LESSON_PACKAGE_12')),
  "cycle_key" VARCHAR(64) NOT NULL,
  "cycle_seq" INTEGER NOT NULL CHECK ("cycle_seq" >= 1),
  "period_start_date" DATE NOT NULL,
  "period_end_date" DATE NULL,
  "planned_lessons" INTEGER NOT NULL CHECK ("planned_lessons" > 0),
  "billable_lessons" INTEGER NOT NULL CHECK ("billable_lessons" >= 0 AND "billable_lessons" <= "planned_lessons"),
  "policy_version_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "uq_billing_cycles_id_center" UNIQUE ("id", "center_id"),
  CONSTRAINT "uq_billing_cycles_identity" UNIQUE ("enrollment_id", "cycle_type", "cycle_key"),
  CONSTRAINT "fk_billing_cycles_enrollment" FOREIGN KEY ("enrollment_id", "center_id")
    REFERENCES "enrollments" ("id", "center_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "fk_billing_cycles_policy" FOREIGN KEY ("policy_version_id", "center_id")
    REFERENCES "billing_policy_versions" ("id", "center_id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE TABLE IF NOT EXISTS "invoices" (
  "id" UUID PRIMARY KEY,
  "center_id" UUID NOT NULL,
  "invoice_number" VARCHAR(32) NOT NULL,
  "student_id" UUID NOT NULL,
  "enrollment_id" UUID NOT NULL,
  "billing_cycle_id" UUID NOT NULL UNIQUE,
  "policy_version_id" UUID NOT NULL,
  "currency" CHAR(3) NOT NULL DEFAULT 'UZS' CHECK ("currency" = 'UZS'),
  "tariff_snapshot_uzs" BIGINT NOT NULL CHECK ("tariff_snapshot_uzs" >= 0),
  "base_pro_rata_charge_uzs" BIGINT NOT NULL CHECK ("base_pro_rata_charge_uzs" >= 0),
  "approved_discount_uzs" BIGINT NOT NULL DEFAULT 0 CHECK ("approved_discount_uzs" >= 0),
  "credit_note_adjustments_uzs" BIGINT NOT NULL DEFAULT 0 CHECK ("credit_note_adjustments_uzs" >= 0),
  "effective_net_charge_uzs" BIGINT NOT NULL CHECK ("effective_net_charge_uzs" >= 0),
  "allocated_paid_uzs" BIGINT NOT NULL DEFAULT 0 CHECK ("allocated_paid_uzs" >= 0),
  "remaining_debt_uzs" BIGINT NOT NULL CHECK ("remaining_debt_uzs" >= 0),
  "billed_lessons" INTEGER NOT NULL CHECK ("billed_lessons" >= 0),
  "frozen_credited_lessons" INTEGER NOT NULL DEFAULT 0 CHECK ("frozen_credited_lessons" >= 0 AND "frozen_credited_lessons" <= "billed_lessons"),
  "status" VARCHAR(24) NOT NULL CHECK ("status" IN ('ISSUED_OPEN', 'PARTIALLY_PAID', 'PAID', 'GRANT_ZERO', 'VOID_COMPENSATED')),
  "due_date" DATE NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1 CHECK ("version" >= 1),
  "issued_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "uq_invoices_id_center" UNIQUE ("id", "center_id"),
  CONSTRAINT "uq_invoices_center_number" UNIQUE ("center_id", "invoice_number"),
  CONSTRAINT "chk_invoices_net_charge_formula" CHECK (
    "effective_net_charge_uzs" = GREATEST(0::bigint, "base_pro_rata_charge_uzs" - "approved_discount_uzs" - "credit_note_adjustments_uzs")
  ),
  CONSTRAINT "chk_invoices_remaining_debt_formula" CHECK (
    "remaining_debt_uzs" = GREATEST(0::bigint, "effective_net_charge_uzs" - "allocated_paid_uzs")
  ),
  CONSTRAINT "fk_invoices_student" FOREIGN KEY ("student_id", "center_id")
    REFERENCES "students" ("id", "center_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "fk_invoices_enrollment" FOREIGN KEY ("enrollment_id", "center_id")
    REFERENCES "enrollments" ("id", "center_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "fk_invoices_cycle" FOREIGN KEY ("billing_cycle_id", "center_id")
    REFERENCES "billing_cycles" ("id", "center_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "fk_invoices_policy" FOREIGN KEY ("policy_version_id", "center_id")
    REFERENCES "billing_policy_versions" ("id", "center_id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE TABLE IF NOT EXISTS "invoice_lines" (
  "id" UUID PRIMARY KEY,
  "center_id" UUID NOT NULL,
  "invoice_id" UUID NOT NULL,
  "line_type" VARCHAR(32) NOT NULL CHECK ("line_type" IN ('BASE_TARIFF', 'PRO_RATA_CALC', 'APPROVED_DISCOUNT', 'PRIOR_FREEZE_CREDIT', 'TRIAL_COMPENSATION_CREDIT')),
  "description" VARCHAR(255) NOT NULL,
  "amount_uzs" BIGINT NOT NULL,
  "formula_snapshot" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "fk_invoice_lines_invoice" FOREIGN KEY ("invoice_id", "center_id")
    REFERENCES "invoices" ("id", "center_id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX IF NOT EXISTS "idx_invoice_lines_invoice" ON "invoice_lines" ("invoice_id");

CREATE TABLE IF NOT EXISTS "discount_requests" (
  "id" UUID PRIMARY KEY,
  "center_id" UUID NOT NULL,
  "student_id" UUID NOT NULL,
  "enrollment_id" UUID NOT NULL,
  "target_invoice_id" UUID NULL,
  "discount_kind" VARCHAR(24) NOT NULL CHECK ("discount_kind" IN ('FAMILY_DISCOUNT', 'SPECIAL_50_PERCENT', 'CUSTOM_PERCENT', 'CUSTOM_FIXED', 'FULL_GRANT_100')),
  "percent_value" NUMERIC(5,2) NULL CHECK ("percent_value" IS NULL OR ("percent_value" > 0 AND "percent_value" <= 100)),
  "fixed_amount_uzs" BIGINT NULL CHECK ("fixed_amount_uzs" IS NULL OR "fixed_amount_uzs" > 0),
  "reason" TEXT NOT NULL,
  "valid_from" DATE NOT NULL,
  "valid_until" DATE NOT NULL CHECK ("valid_until" >= "valid_from"),
  "requested_by_admin_id" UUID NOT NULL,
  "status" VARCHAR(24) NOT NULL CHECK ("status" IN ('PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'EXPIRED', 'REVOKED')),
  "version" INTEGER NOT NULL DEFAULT 1 CHECK ("version" >= 1),
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "uq_discount_requests_id_center" UNIQUE ("id", "center_id"),
  CONSTRAINT "fk_discount_requests_student" FOREIGN KEY ("student_id", "center_id")
    REFERENCES "students" ("id", "center_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "fk_discount_requests_enrollment" FOREIGN KEY ("enrollment_id", "center_id")
    REFERENCES "enrollments" ("id", "center_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "fk_discount_requests_invoice" FOREIGN KEY ("target_invoice_id", "center_id")
    REFERENCES "invoices" ("id", "center_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "fk_discount_requests_admin" FOREIGN KEY ("requested_by_admin_id", "center_id")
    REFERENCES "staff_users" ("id", "center_id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE TABLE IF NOT EXISTS "discount_approvals" (
  "id" UUID PRIMARY KEY,
  "center_id" UUID NOT NULL,
  "discount_request_id" UUID NOT NULL UNIQUE,
  "decision" VARCHAR(16) NOT NULL CHECK ("decision" IN ('APPROVED', 'REJECTED')),
  "director_staff_id" UUID NOT NULL,
  "approval_channel" VARCHAR(16) NOT NULL CHECK ("approval_channel" IN ('STAFF_WEB', 'STAFF_MOBILE', 'DIRECTOR_BOT')),
  "applied_amount_uzs" BIGINT NOT NULL CHECK ("applied_amount_uzs" >= 0),
  "decision_note" TEXT NULL,
  "decided_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "uq_discount_approvals_id_center" UNIQUE ("id", "center_id"),
  CONSTRAINT "fk_discount_approvals_request" FOREIGN KEY ("discount_request_id", "center_id")
    REFERENCES "discount_requests" ("id", "center_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "fk_discount_approvals_director" FOREIGN KEY ("director_staff_id", "center_id")
    REFERENCES "staff_users" ("id", "center_id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE TABLE IF NOT EXISTS "freeze_records" (
  "id" UUID PRIMARY KEY,
  "center_id" UUID NOT NULL,
  "enrollment_id" UUID NOT NULL,
  "source_invoice_id" UUID NOT NULL,
  "freeze_start_date" DATE NOT NULL,
  "freeze_end_date" DATE NOT NULL CHECK ("freeze_end_date" >= "freeze_start_date"),
  "reason_type" VARCHAR(24) NOT NULL CHECK ("reason_type" IN ('MEDICAL_CERTIFICATE', 'PRIOR_NOTICE')),
  "reason_details" TEXT NOT NULL,
  "distinct_frozen_lessons" INTEGER NOT NULL CHECK ("distinct_frozen_lessons" >= 0),
  "basis_net_charge_uzs" BIGINT NOT NULL CHECK ("basis_net_charge_uzs" >= 0),
  "calculated_credit_uzs" BIGINT NOT NULL CHECK ("calculated_credit_uzs" >= 0 AND "calculated_credit_uzs" <= "basis_net_charge_uzs"),
  "created_by_admin_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "uq_freeze_records_id_center" UNIQUE ("id", "center_id"),
  CONSTRAINT "fk_freeze_records_enrollment" FOREIGN KEY ("enrollment_id", "center_id")
    REFERENCES "enrollments" ("id", "center_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "fk_freeze_records_invoice" FOREIGN KEY ("source_invoice_id", "center_id")
    REFERENCES "invoices" ("id", "center_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "fk_freeze_records_admin" FOREIGN KEY ("created_by_admin_id", "center_id")
    REFERENCES "staff_users" ("id", "center_id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE TABLE IF NOT EXISTS "freeze_lesson_links" (
  "id" UUID PRIMARY KEY,
  "center_id" UUID NOT NULL,
  "enrollment_id" UUID NOT NULL,
  "lesson_id" UUID NOT NULL,
  "freeze_record_id" UUID NOT NULL,
  "credited_amount_uzs" BIGINT NOT NULL CHECK ("credited_amount_uzs" >= 0),
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "uq_freeze_lesson_links_enr_lesson" UNIQUE ("enrollment_id", "lesson_id"),
  CONSTRAINT "fk_freeze_lesson_links_enrollment" FOREIGN KEY ("enrollment_id", "center_id")
    REFERENCES "enrollments" ("id", "center_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "fk_freeze_lesson_links_lesson" FOREIGN KEY ("lesson_id", "center_id")
    REFERENCES "lesson_occurrences" ("id", "center_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "fk_freeze_lesson_links_freeze" FOREIGN KEY ("freeze_record_id", "center_id")
    REFERENCES "freeze_records" ("id", "center_id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE TABLE IF NOT EXISTS "credit_notes" (
  "id" UUID PRIMARY KEY,
  "center_id" UUID NOT NULL,
  "student_id" UUID NOT NULL,
  "enrollment_id" UUID NOT NULL,
  "source_invoice_id" UUID NULL,
  "credit_reason" VARCHAR(32) NOT NULL CHECK ("credit_reason" IN ('FREEZE_NEXT_PERIOD_CREDIT', 'DISCOUNT_RETRO_ADJUSTMENT', 'TRIAL_CORRECTION_VOID', 'WITHDRAWAL_UNUSED_LESSONS')),
  "amount_uzs" BIGINT NOT NULL CHECK ("amount_uzs" > 0),
  "source_event_key" VARCHAR(128) NOT NULL UNIQUE,
  "actor_type" VARCHAR(16) NOT NULL CHECK ("actor_type" IN ('STAFF', 'SYSTEM_WORKER')),
  "actor_staff_id" UUID NULL,
  "system_job_name" VARCHAR(64) NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "uq_credit_notes_id_center" UNIQUE ("id", "center_id"),
  CONSTRAINT "chk_credit_notes_actor" CHECK (
    ("actor_type" = 'STAFF' AND "actor_staff_id" IS NOT NULL AND "system_job_name" IS NULL)
    OR ("actor_type" = 'SYSTEM_WORKER' AND "actor_staff_id" IS NULL AND "system_job_name" IS NOT NULL)
  ),
  CONSTRAINT "fk_credit_notes_student" FOREIGN KEY ("student_id", "center_id")
    REFERENCES "students" ("id", "center_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "fk_credit_notes_enrollment" FOREIGN KEY ("enrollment_id", "center_id")
    REFERENCES "enrollments" ("id", "center_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "fk_credit_notes_source_invoice" FOREIGN KEY ("source_invoice_id", "center_id")
    REFERENCES "invoices" ("id", "center_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "fk_credit_notes_actor_staff" FOREIGN KEY ("actor_staff_id", "center_id")
    REFERENCES "staff_users" ("id", "center_id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE TABLE IF NOT EXISTS "cash_shifts" (
  "id" UUID PRIMARY KEY,
  "center_id" UUID NOT NULL,
  "shift_date" DATE NOT NULL,
  "opened_by_admin_id" UUID NOT NULL,
  "opened_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "opening_cash_uzs" BIGINT NOT NULL DEFAULT 0 CHECK ("opening_cash_uzs" >= 0),
  "cash_receipts_uzs" BIGINT NOT NULL DEFAULT 0 CHECK ("cash_receipts_uzs" >= 0),
  "non_cash_receipts_uzs" BIGINT NOT NULL DEFAULT 0 CHECK ("non_cash_receipts_uzs" >= 0),
  "cash_refunds_uzs" BIGINT NOT NULL DEFAULT 0 CHECK ("cash_refunds_uzs" >= 0),
  "non_cash_refunds_uzs" BIGINT NOT NULL DEFAULT 0 CHECK ("non_cash_refunds_uzs" >= 0),
  "cash_expenses_uzs" BIGINT NOT NULL DEFAULT 0 CHECK ("cash_expenses_uzs" >= 0),
  "expected_closing_cash_uzs" BIGINT NOT NULL DEFAULT 0,
  "counted_closing_cash_uzs" BIGINT NULL CHECK ("counted_closing_cash_uzs" IS NULL OR "counted_closing_cash_uzs" >= 0),
  "discrepancy_uzs" BIGINT NULL,
  "discrepancy_reason" TEXT NULL,
  "status" VARCHAR(16) NOT NULL CHECK ("status" IN ('OPEN', 'CLOSED')),
  "closed_by_admin_id" UUID NULL,
  "closed_at" TIMESTAMPTZ NULL,
  "version" INTEGER NOT NULL DEFAULT 1 CHECK ("version" >= 1),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "uq_cash_shifts_id_center" UNIQUE ("id", "center_id"),
  CONSTRAINT "chk_cash_shifts_drawer_formula" CHECK (
    "expected_closing_cash_uzs" = "opening_cash_uzs" + "cash_receipts_uzs" - "cash_refunds_uzs" - "cash_expenses_uzs"
  ),
  CONSTRAINT "fk_cash_shifts_opened_by" FOREIGN KEY ("opened_by_admin_id", "center_id")
    REFERENCES "staff_users" ("id", "center_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "fk_cash_shifts_closed_by" FOREIGN KEY ("closed_by_admin_id", "center_id")
    REFERENCES "staff_users" ("id", "center_id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS "idx_cash_shifts_open_center"
  ON "cash_shifts" ("center_id") WHERE "status" = 'OPEN';

CREATE TABLE IF NOT EXISTS "payments" (
  "id" UUID PRIMARY KEY,
  "center_id" UUID NOT NULL,
  "student_id" UUID NOT NULL,
  "cash_shift_id" UUID NOT NULL,
  "amount_uzs" BIGINT NOT NULL CHECK ("amount_uzs" > 0),
  "currency" CHAR(3) NOT NULL DEFAULT 'UZS' CHECK ("currency" = 'UZS'),
  "payment_method" VARCHAR(16) NOT NULL CHECK ("payment_method" IN ('CASH', 'CARD', 'CLICK', 'PAYME', 'TRANSFER')),
  "recorded_by_admin_id" UUID NOT NULL,
  "idempotency_key" VARCHAR(128) NOT NULL,
  "request_hash" CHAR(64) NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "uq_payments_id_center" UNIQUE ("id", "center_id"),
  CONSTRAINT "uq_payments_idempotency" UNIQUE ("center_id", "recorded_by_admin_id", "idempotency_key"),
  CONSTRAINT "fk_payments_student" FOREIGN KEY ("student_id", "center_id")
    REFERENCES "students" ("id", "center_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "fk_payments_shift" FOREIGN KEY ("cash_shift_id", "center_id")
    REFERENCES "cash_shifts" ("id", "center_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "fk_payments_admin" FOREIGN KEY ("recorded_by_admin_id", "center_id")
    REFERENCES "staff_users" ("id", "center_id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE TABLE IF NOT EXISTS "payment_allocations" (
  "id" UUID PRIMARY KEY,
  "center_id" UUID NOT NULL,
  "payment_id" UUID NOT NULL,
  "invoice_id" UUID NOT NULL,
  "allocated_amount_uzs" BIGINT NOT NULL CHECK ("allocated_amount_uzs" > 0),
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "uq_payment_allocations_id_center" UNIQUE ("id", "center_id"),
  CONSTRAINT "fk_payment_allocations_payment" FOREIGN KEY ("payment_id", "center_id")
    REFERENCES "payments" ("id", "center_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "fk_payment_allocations_invoice" FOREIGN KEY ("invoice_id", "center_id")
    REFERENCES "invoices" ("id", "center_id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX IF NOT EXISTS "idx_payment_allocations_invoice" ON "payment_allocations" ("invoice_id");

CREATE TABLE IF NOT EXISTS "unapplied_credits" (
  "id" UUID PRIMARY KEY,
  "center_id" UUID NOT NULL,
  "student_id" UUID NOT NULL,
  "source_payment_id" UUID NOT NULL UNIQUE,
  "initial_credit_uzs" BIGINT NOT NULL CHECK ("initial_credit_uzs" > 0),
  "remaining_credit_uzs" BIGINT NOT NULL CHECK ("remaining_credit_uzs" >= 0 AND "remaining_credit_uzs" <= "initial_credit_uzs"),
  "version" INTEGER NOT NULL DEFAULT 1 CHECK ("version" >= 1),
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "uq_unapplied_credits_id_center" UNIQUE ("id", "center_id"),
  CONSTRAINT "fk_unapplied_credits_student" FOREIGN KEY ("student_id", "center_id")
    REFERENCES "students" ("id", "center_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "fk_unapplied_credits_payment" FOREIGN KEY ("source_payment_id", "center_id")
    REFERENCES "payments" ("id", "center_id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE TABLE IF NOT EXISTS "credit_note_applications" (
  "id" UUID PRIMARY KEY,
  "center_id" UUID NOT NULL,
  "credit_note_id" UUID NULL,
  "unapplied_credit_id" UUID NULL,
  "target_invoice_id" UUID NOT NULL,
  "applied_amount_uzs" BIGINT NOT NULL CHECK ("applied_amount_uzs" > 0),
  "actor_type" VARCHAR(16) NOT NULL CHECK ("actor_type" IN ('STAFF', 'SYSTEM_WORKER')),
  "actor_staff_id" UUID NULL,
  "system_job_name" VARCHAR(64) NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "chk_credit_note_apps_source_xor" CHECK (("credit_note_id" IS NOT NULL) <> ("unapplied_credit_id" IS NOT NULL)),
  CONSTRAINT "chk_credit_note_apps_actor" CHECK (
    ("actor_type" = 'STAFF' AND "actor_staff_id" IS NOT NULL AND "system_job_name" IS NULL)
    OR ("actor_type" = 'SYSTEM_WORKER' AND "actor_staff_id" IS NULL AND "system_job_name" IS NOT NULL)
  ),
  CONSTRAINT "fk_credit_note_apps_credit_note" FOREIGN KEY ("credit_note_id", "center_id")
    REFERENCES "credit_notes" ("id", "center_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "fk_credit_note_apps_unapplied" FOREIGN KEY ("unapplied_credit_id", "center_id")
    REFERENCES "unapplied_credits" ("id", "center_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "fk_credit_note_apps_invoice" FOREIGN KEY ("target_invoice_id", "center_id")
    REFERENCES "invoices" ("id", "center_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "fk_credit_note_apps_actor_staff" FOREIGN KEY ("actor_staff_id", "center_id")
    REFERENCES "staff_users" ("id", "center_id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX IF NOT EXISTS "idx_credit_note_apps_invoice" ON "credit_note_applications" ("target_invoice_id");

CREATE TABLE IF NOT EXISTS "reversal_or_refund_requests" (
  "id" UUID PRIMARY KEY,
  "center_id" UUID NOT NULL,
  "original_payment_id" UUID NOT NULL,
  "kind" VARCHAR(24) NOT NULL CHECK ("kind" IN ('ERROR_STORNO_REVERSAL', 'PARTIAL_REFUND', 'FULL_REFUND')),
  "amount_uzs" BIGINT NOT NULL CHECK ("amount_uzs" > 0),
  "refund_method" VARCHAR(16) NOT NULL CHECK ("refund_method" IN ('CASH', 'CARD', 'CLICK', 'PAYME', 'TRANSFER')),
  "debt_effect_policy" VARCHAR(24) NOT NULL CHECK ("debt_effect_policy" IN ('REOPEN_INVOICE_DEBT', 'CLOSE_WITH_CREDIT_NOTE')),
  "reason" TEXT NOT NULL,
  "requested_by_admin_id" UUID NOT NULL,
  "status" VARCHAR(28) NOT NULL CHECK ("status" IN ('PENDING_DIRECTOR_APPROVAL', 'APPROVED_EXECUTED', 'REJECTED')),
  "decided_by_director_id" UUID NULL,
  "decision_note" TEXT NULL,
  "red_alert_sent_at" TIMESTAMPTZ NULL,
  "version" INTEGER NOT NULL DEFAULT 1 CHECK ("version" >= 1),
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "uq_reversal_requests_id_center" UNIQUE ("id", "center_id"),
  CONSTRAINT "fk_reversal_requests_payment" FOREIGN KEY ("original_payment_id", "center_id")
    REFERENCES "payments" ("id", "center_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "fk_reversal_requests_admin" FOREIGN KEY ("requested_by_admin_id", "center_id")
    REFERENCES "staff_users" ("id", "center_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "fk_reversal_requests_director" FOREIGN KEY ("decided_by_director_id", "center_id")
    REFERENCES "staff_users" ("id", "center_id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE TABLE IF NOT EXISTS "reversal_or_refund_executions" (
  "id" UUID PRIMARY KEY,
  "center_id" UUID NOT NULL,
  "request_id" UUID NOT NULL UNIQUE,
  "original_payment_id" UUID NOT NULL,
  "cash_shift_id" UUID NULL,
  "kind" VARCHAR(24) NOT NULL CHECK ("kind" IN ('ERROR_STORNO_REVERSAL', 'PARTIAL_REFUND', 'FULL_REFUND')),
  "amount_uzs" BIGINT NOT NULL CHECK ("amount_uzs" > 0),
  "refund_method" VARCHAR(16) NOT NULL CHECK ("refund_method" IN ('CASH', 'CARD', 'CLICK', 'PAYME', 'TRANSFER')),
  "debt_effect_policy" VARCHAR(24) NOT NULL CHECK ("debt_effect_policy" IN ('REOPEN_INVOICE_DEBT', 'CLOSE_WITH_CREDIT_NOTE')),
  "approved_by_director_id" UUID NOT NULL,
  "compensation_credit_note_id" UUID NULL,
  "executed_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "uq_reversal_executions_id_center" UNIQUE ("id", "center_id"),
  CONSTRAINT "fk_reversal_executions_request" FOREIGN KEY ("request_id", "center_id")
    REFERENCES "reversal_or_refund_requests" ("id", "center_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "fk_reversal_executions_payment" FOREIGN KEY ("original_payment_id", "center_id")
    REFERENCES "payments" ("id", "center_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "fk_reversal_executions_shift" FOREIGN KEY ("cash_shift_id", "center_id")
    REFERENCES "cash_shifts" ("id", "center_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "fk_reversal_executions_director" FOREIGN KEY ("approved_by_director_id", "center_id")
    REFERENCES "staff_users" ("id", "center_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "fk_reversal_executions_credit_note" FOREIGN KEY ("compensation_credit_note_id", "center_id")
    REFERENCES "credit_notes" ("id", "center_id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE TABLE IF NOT EXISTS "payment_allocation_reversals" (
  "id" UUID PRIMARY KEY,
  "center_id" UUID NOT NULL,
  "original_allocation_id" UUID NOT NULL,
  "reversal_execution_id" UUID NOT NULL,
  "invoice_id" UUID NOT NULL,
  "reversed_amount_uzs" BIGINT NOT NULL CHECK ("reversed_amount_uzs" > 0),
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "fk_alloc_reversals_allocation" FOREIGN KEY ("original_allocation_id", "center_id")
    REFERENCES "payment_allocations" ("id", "center_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "fk_alloc_reversals_execution" FOREIGN KEY ("reversal_execution_id", "center_id")
    REFERENCES "reversal_or_refund_executions" ("id", "center_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "fk_alloc_reversals_invoice" FOREIGN KEY ("invoice_id", "center_id")
    REFERENCES "invoices" ("id", "center_id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX IF NOT EXISTS "idx_alloc_reversals_orig" ON "payment_allocation_reversals" ("original_allocation_id");

CREATE TABLE IF NOT EXISTS "receipts" (
  "id" UUID PRIMARY KEY,
  "center_id" UUID NOT NULL,
  "receipt_number" VARCHAR(32) NOT NULL,
  "payment_id" UUID NOT NULL UNIQUE,
  "student_id" UUID NOT NULL,
  "amount_uzs" BIGINT NOT NULL CHECK ("amount_uzs" > 0),
  "payment_method" VARCHAR(16) NOT NULL CHECK ("payment_method" IN ('CASH', 'CARD', 'CLICK', 'PAYME', 'TRANSFER')),
  "remaining_debt_snapshot_uzs" BIGINT NOT NULL CHECK ("remaining_debt_snapshot_uzs" >= 0),
  "next_due_date_snapshot" DATE NULL,
  "is_fiscal_tax_receipt" BOOLEAN NOT NULL DEFAULT FALSE CHECK ("is_fiscal_tax_receipt" = FALSE),
  "issued_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "uq_receipts_center_number" UNIQUE ("center_id", "receipt_number"),
  CONSTRAINT "fk_receipts_payment" FOREIGN KEY ("payment_id", "center_id")
    REFERENCES "payments" ("id", "center_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "fk_receipts_student" FOREIGN KEY ("student_id", "center_id")
    REFERENCES "students" ("id", "center_id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE TABLE IF NOT EXISTS "promises_to_pay" (
  "id" UUID PRIMARY KEY,
  "center_id" UUID NOT NULL,
  "student_id" UUID NOT NULL,
  "invoice_id" UUID NOT NULL,
  "trigger_payment_id" UUID NOT NULL,
  "promised_amount_uzs" BIGINT NOT NULL CHECK ("promised_amount_uzs" > 0),
  "promise_date" DATE NOT NULL,
  "status" VARCHAR(16) NOT NULL CHECK ("status" IN ('ACTIVE', 'FULFILLED', 'CANCELLED', 'OVERDUE_NOTIFIED')),
  "reminder_sent_at" TIMESTAMPTZ NULL,
  "version" INTEGER NOT NULL DEFAULT 1 CHECK ("version" >= 1),
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "fk_promises_student" FOREIGN KEY ("student_id", "center_id")
    REFERENCES "students" ("id", "center_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "fk_promises_invoice" FOREIGN KEY ("invoice_id", "center_id")
    REFERENCES "invoices" ("id", "center_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "fk_promises_payment" FOREIGN KEY ("trigger_payment_id", "center_id")
    REFERENCES "payments" ("id", "center_id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX IF NOT EXISTS "idx_promises_center_status_date"
  ON "promises_to_pay" ("center_id", "status", "promise_date");

CREATE TABLE IF NOT EXISTS "cash_expenses" (
  "id" UUID PRIMARY KEY,
  "center_id" UUID NOT NULL,
  "cash_shift_id" UUID NOT NULL,
  "category" VARCHAR(48) NOT NULL,
  "amount_uzs" BIGINT NOT NULL CHECK ("amount_uzs" <> 0),
  "payment_method" VARCHAR(16) NOT NULL CHECK ("payment_method" IN ('CASH', 'CARD', 'TRANSFER')),
  "reason_and_doc" VARCHAR(255) NOT NULL,
  "reverses_expense_id" UUID NULL,
  "recorded_by_staff_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "uq_cash_expenses_id_center" UNIQUE ("id", "center_id"),
  CONSTRAINT "fk_cash_expenses_shift" FOREIGN KEY ("cash_shift_id", "center_id")
    REFERENCES "cash_shifts" ("id", "center_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "fk_cash_expenses_reverses" FOREIGN KEY ("reverses_expense_id", "center_id")
    REFERENCES "cash_expenses" ("id", "center_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "fk_cash_expenses_staff" FOREIGN KEY ("recorded_by_staff_id", "center_id")
    REFERENCES "staff_users" ("id", "center_id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE TABLE IF NOT EXISTS "ledger_entries" (
  "id" UUID PRIMARY KEY,
  "center_id" UUID NOT NULL,
  "entry_seq" BIGSERIAL NOT NULL,
  "entry_type" VARCHAR(32) NOT NULL CHECK ("entry_type" IN (
    'INVOICE_ISSUED', 'DISCOUNT_APPLIED', 'CREDIT_NOTE_ISSUED', 'CREDIT_NOTE_APPLIED',
    'PAYMENT_RECEIVED', 'PAYMENT_REVERSED', 'REFUND_PAID', 'EXPENSE_RECORDED', 'EXPENSE_REVERSED', 'OPENING_BALANCE'
  )),
  "student_id" UUID NULL,
  "invoice_id" UUID NULL,
  "payment_id" UUID NULL,
  "reversal_execution_id" UUID NULL,
  "credit_note_id" UUID NULL,
  "cash_expense_id" UUID NULL,
  "direction" VARCHAR(6) NOT NULL CHECK ("direction" IN ('DEBIT', 'CREDIT')),
  "amount_uzs" BIGINT NOT NULL CHECK ("amount_uzs" >= 0),
  "payment_method" VARCHAR(16) NULL,
  "actor_type" VARCHAR(16) NOT NULL CHECK ("actor_type" IN ('STAFF', 'SYSTEM_WORKER')),
  "actor_staff_id" UUID NULL,
  "system_job_name" VARCHAR(64) NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "chk_ledger_entries_actor" CHECK (
    ("actor_type" = 'STAFF' AND "actor_staff_id" IS NOT NULL AND "system_job_name" IS NULL)
    OR ("actor_type" = 'SYSTEM_WORKER' AND "actor_staff_id" IS NULL AND "system_job_name" IS NOT NULL)
  ),
  CONSTRAINT "fk_ledger_entries_student" FOREIGN KEY ("student_id", "center_id")
    REFERENCES "students" ("id", "center_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "fk_ledger_entries_invoice" FOREIGN KEY ("invoice_id", "center_id")
    REFERENCES "invoices" ("id", "center_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "fk_ledger_entries_payment" FOREIGN KEY ("payment_id", "center_id")
    REFERENCES "payments" ("id", "center_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "fk_ledger_entries_reversal" FOREIGN KEY ("reversal_execution_id", "center_id")
    REFERENCES "reversal_or_refund_executions" ("id", "center_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "fk_ledger_entries_credit_note" FOREIGN KEY ("credit_note_id", "center_id")
    REFERENCES "credit_notes" ("id", "center_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "fk_ledger_entries_expense" FOREIGN KEY ("cash_expense_id", "center_id")
    REFERENCES "cash_expenses" ("id", "center_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "fk_ledger_entries_actor_staff" FOREIGN KEY ("actor_staff_id", "center_id")
    REFERENCES "staff_users" ("id", "center_id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX IF NOT EXISTS "idx_ledger_entries_center_seq" ON "ledger_entries" ("center_id", "entry_seq");

CREATE TABLE IF NOT EXISTS "payroll_snapshots" (
  "id" UUID PRIMARY KEY,
  "center_id" UUID NOT NULL,
  "period_key" CHAR(7) NOT NULL,
  "teacher_id" UUID NOT NULL,
  "payroll_model_snapshot" VARCHAR(24) NOT NULL,
  "primary_lessons_taught" INTEGER NOT NULL DEFAULT 0 CHECK ("primary_lessons_taught" >= 0),
  "substitute_lessons_taught" INTEGER NOT NULL DEFAULT 0 CHECK ("substitute_lessons_taught" >= 0),
  "base_earned_uzs" BIGINT NOT NULL CHECK ("base_earned_uzs" >= 0),
  "substitute_earned_uzs" BIGINT NOT NULL CHECK ("substitute_earned_uzs" >= 0),
  "adjustments_total_uzs" BIGINT NOT NULL DEFAULT 0,
  "net_payable_uzs" BIGINT NOT NULL,
  "status" VARCHAR(16) NOT NULL CHECK ("status" IN ('DRAFT', 'CLOSED')),
  "closed_by_director_id" UUID NULL,
  "closed_at" TIMESTAMPTZ NULL,
  "version" INTEGER NOT NULL DEFAULT 1 CHECK ("version" >= 1),
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "uq_payroll_snapshots_id_center" UNIQUE ("id", "center_id"),
  CONSTRAINT "uq_payroll_snapshots_period_teacher" UNIQUE ("center_id", "period_key", "teacher_id"),
  CONSTRAINT "fk_payroll_snapshots_teacher" FOREIGN KEY ("teacher_id", "center_id")
    REFERENCES "staff_users" ("id", "center_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "fk_payroll_snapshots_director" FOREIGN KEY ("closed_by_director_id", "center_id")
    REFERENCES "staff_users" ("id", "center_id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE TABLE IF NOT EXISTS "payroll_adjustments" (
  "id" UUID PRIMARY KEY,
  "center_id" UUID NOT NULL,
  "target_current_snapshot_id" UUID NOT NULL,
  "reference_closed_period_key" CHAR(7) NOT NULL,
  "teacher_id" UUID NOT NULL,
  "delta_amount_uzs" BIGINT NOT NULL CHECK ("delta_amount_uzs" <> 0),
  "reason" TEXT NOT NULL,
  "created_by_director_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "fk_payroll_adjustments_snapshot" FOREIGN KEY ("target_current_snapshot_id", "center_id")
    REFERENCES "payroll_snapshots" ("id", "center_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "fk_payroll_adjustments_teacher" FOREIGN KEY ("teacher_id", "center_id")
    REFERENCES "staff_users" ("id", "center_id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "fk_payroll_adjustments_director" FOREIGN KEY ("created_by_director_id", "center_id")
    REFERENCES "staff_users" ("id", "center_id") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX IF NOT EXISTS "idx_payroll_adjustments_snapshot" ON "payroll_adjustments" ("target_current_snapshot_id");

CREATE TABLE IF NOT EXISTS "audit_logs" (
  "id" UUID PRIMARY KEY,
  "center_id" UUID NOT NULL,
  "actor_type" VARCHAR(16) NOT NULL CHECK ("actor_type" IN ('STAFF', 'GUARDIAN_BOT', 'VENDOR', 'SYSTEM_WORKER')),
  "actor_id" UUID NULL,
  "actor_role" VARCHAR(16) NULL,
  "action" VARCHAR(64) NOT NULL,
  "entity_type" VARCHAR(48) NOT NULL,
  "entity_id" UUID NOT NULL,
  "severity" VARCHAR(16) NOT NULL DEFAULT 'INFO' CHECK ("severity" IN ('INFO', 'WARN', 'CRITICAL_RED')),
  "before_redacted_json" JSONB NULL,
  "after_redacted_json" JSONB NULL,
  "request_id" VARCHAR(64) NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS "idx_audit_logs_center_entity" ON "audit_logs" ("center_id", "entity_type", "entity_id");

CREATE TABLE IF NOT EXISTS "outbox_events" (
  "id" UUID PRIMARY KEY,
  "center_id" UUID NOT NULL,
  "event_name" VARCHAR(64) NOT NULL,
  "schema_version" INTEGER NOT NULL DEFAULT 1 CHECK ("schema_version" >= 1),
  "aggregate_type" VARCHAR(48) NOT NULL,
  "aggregate_id" UUID NOT NULL,
  "aggregate_version" INTEGER NOT NULL CHECK ("aggregate_version" >= 1),
  "dedup_key" VARCHAR(160) NOT NULL UNIQUE,
  "payload_json" JSONB NOT NULL,
  "status" VARCHAR(24) NOT NULL CHECK ("status" IN ('PENDING', 'LEASED', 'COMPLETED', 'DEAD_LETTER', 'SUPERSEDED_BY_RESTORE')),
  "attempt_count" INTEGER NOT NULL DEFAULT 0 CHECK ("attempt_count" >= 0),
  "lease_token" BIGINT NOT NULL DEFAULT 0 CHECK ("lease_token" >= 0),
  "leased_by_worker" VARCHAR(64) NULL,
  "lease_until" TIMESTAMPTZ NULL,
  "next_attempt_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "last_error" TEXT NULL,
  "occurred_at_utc" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "processed_at_utc" TIMESTAMPTZ NULL,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "uq_outbox_events_id_center" UNIQUE ("id", "center_id"),
  CONSTRAINT "uq_outbox_events_aggregate_version" UNIQUE ("center_id", "aggregate_type", "aggregate_id", "aggregate_version")
);
CREATE INDEX IF NOT EXISTS "idx_outbox_events_poll"
  ON "outbox_events" ("center_id", "status", "next_attempt_at", "occurred_at_utc");

CREATE TABLE IF NOT EXISTS "outbox_consumer_receipts" (
  "id" UUID PRIMARY KEY,
  "center_id" UUID NOT NULL,
  "outbox_event_id" UUID NOT NULL,
  "consumer_name" VARCHAR(64) NOT NULL,
  "consumer_receipt_key" VARCHAR(192) NOT NULL,
  "fencing_lease_token" BIGINT NOT NULL CHECK ("fencing_lease_token" >= 0),
  "effect_summary_json" JSONB NOT NULL,
  "processed_at_utc" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "uq_outbox_receipts_consumer_event" UNIQUE ("center_id", "consumer_name", "outbox_event_id"),
  CONSTRAINT "uq_outbox_receipts_key" UNIQUE ("center_id", "consumer_receipt_key"),
  CONSTRAINT "fk_outbox_receipts_event" FOREIGN KEY ("outbox_event_id", "center_id")
    REFERENCES "outbox_events" ("id", "center_id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE TABLE IF NOT EXISTS "notification_deliveries" (
  "id" UUID PRIMARY KEY,
  "center_id" UUID NOT NULL,
  "outbox_event_id" UUID NOT NULL,
  "recipient_type" VARCHAR(16) NOT NULL CHECK ("recipient_type" IN ('GUARDIAN', 'DIRECTOR', 'TEACHER', 'ADMIN')),
  "recipient_id" UUID NOT NULL,
  "telegram_chat_id" BIGINT NULL,
  "delivery_status" VARCHAR(24) NOT NULL CHECK ("delivery_status" IN ('QUEUED', 'API_ACCEPTED', 'RETRY_429', 'FAILED_403_BLOCKED', 'SKIPPED_UNLINKED', 'DEAD_LETTER')),
  "attempt_count" INTEGER NOT NULL DEFAULT 0 CHECK ("attempt_count" >= 0),
  "next_attempt_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "last_lease_token" BIGINT NOT NULL DEFAULT 0 CHECK ("last_lease_token" >= 0),
  "telegram_message_id" BIGINT NULL,
  "retry_after_seconds" INTEGER NULL,
  "version" INTEGER NOT NULL DEFAULT 1 CHECK ("version" >= 1),
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "uq_notification_deliveries_recipient" UNIQUE ("outbox_event_id", "recipient_type", "recipient_id"),
  CONSTRAINT "fk_notification_deliveries_event" FOREIGN KEY ("outbox_event_id", "center_id")
    REFERENCES "outbox_events" ("id", "center_id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE TABLE IF NOT EXISTS "import_batches" (
  "id" UUID PRIMARY KEY,
  "center_id" UUID NOT NULL,
  "template_type" VARCHAR(24) NOT NULL CHECK ("template_type" IN ('STUDENT_ROSTER', 'MONTHLY_ATTENDANCE')),
  "template_version" VARCHAR(16) NOT NULL,
  "upload_sha256" CHAR(64) NOT NULL,
  "preview_token_hash" CHAR(64) NOT NULL UNIQUE,
  "preview_expires_at" TIMESTAMPTZ NOT NULL,
  "total_rows" INTEGER NOT NULL CHECK ("total_rows" >= 0 AND "total_rows" <= 1000),
  "valid_rows" INTEGER NOT NULL CHECK ("valid_rows" >= 0),
  "error_rows" INTEGER NOT NULL CHECK ("error_rows" >= 0),
  "preview_report_json" JSONB NOT NULL,
  "status" VARCHAR(20) NOT NULL CHECK ("status" IN ('PREVIEW_READY', 'PREVIEW_HAS_ERRORS', 'COMMITTED', 'EXPIRED', 'CONFLICT_REJECTED')),
  "uploaded_by_admin_id" UUID NOT NULL,
  "committed_at" TIMESTAMPTZ NULL,
  "version" INTEGER NOT NULL DEFAULT 1 CHECK ("version" >= 1),
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "uq_import_batches_id_center" UNIQUE ("id", "center_id"),
  CONSTRAINT "fk_import_batches_admin" FOREIGN KEY ("uploaded_by_admin_id", "center_id")
    REFERENCES "staff_users" ("id", "center_id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

-- ============================================================================
-- SECTION 2: IMMUTABILITY & DOMAIN INVARIANT TRIGGERS (T04.01, T04.02, S2F03)
-- ============================================================================

CREATE OR REPLACE FUNCTION eduerp_forbid_append_only_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'IMMUTABLE_TABLE_VIOLATION: Table % is strictly append-only; % is prohibited.', TG_TABLE_NAME, TG_OP
    USING ERRCODE = '42501';
END;
$$;

DO $$
DECLARE
  tbl TEXT;
  append_only_tables TEXT[] := ARRAY[
    'course_price_history',
    'attendance_revisions',
    'client_operation_logs',
    'billing_policy_versions',
    'billing_cycles',
    'invoice_lines',
    'discount_approvals',
    'freeze_records',
    'freeze_lesson_links',
    'credit_notes',
    'credit_note_applications',
    'payments',
    'payment_allocations',
    'payment_allocation_reversals',
    'reversal_or_refund_executions',
    'receipts',
    'cash_expenses',
    'ledger_entries',
    'payroll_adjustments',
    'audit_logs',
    'outbox_consumer_receipts'
  ];
BEGIN
  FOREACH tbl IN ARRAY append_only_tables LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_immutable_%I ON %I;', tbl, tbl);
    EXECUTE format(
      'CREATE TRIGGER trg_immutable_%I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION eduerp_forbid_append_only_mutation();',
      tbl, tbl
    );
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION eduerp_guard_closed_state_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'DELETE_PROHIBITED: Table % does not allow row deletion.', TG_TABLE_NAME
      USING ERRCODE = '42501';
  END IF;
  IF OLD.status = 'CLOSED' THEN
    RAISE EXCEPTION 'CLOSED_RECORD_IMMUTABLE: % row % is CLOSED and cannot be modified.', TG_TABLE_NAME, OLD.id
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_cash_shifts_closed_immutable ON "cash_shifts";
CREATE TRIGGER trg_cash_shifts_closed_immutable
  BEFORE UPDATE OR DELETE ON "cash_shifts"
  FOR EACH ROW EXECUTE FUNCTION eduerp_guard_closed_state_mutation();

DROP TRIGGER IF EXISTS trg_payroll_snapshots_closed_immutable ON "payroll_snapshots";
CREATE TRIGGER trg_payroll_snapshots_closed_immutable
  BEFORE UPDATE OR DELETE ON "payroll_snapshots"
  FOR EACH ROW EXECUTE FUNCTION eduerp_guard_closed_state_mutation();

CREATE OR REPLACE FUNCTION eduerp_guard_last_active_director()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  remaining_directors INTEGER;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'DELETE_PROHIBITED: staff_users rows cannot be deleted; use status = DEACTIVATED.'
      USING ERRCODE = '42501';
  END IF;
  IF OLD.role = 'DIRECTOR' AND OLD.status = 'ACTIVE' AND (NEW.role <> 'DIRECTOR' OR NEW.status <> 'ACTIVE') THEN
    SELECT COUNT(*) INTO remaining_directors
      FROM "staff_users"
     WHERE "center_id" = OLD.center_id
       AND "role" = 'DIRECTOR'
       AND "status" = 'ACTIVE'
       AND "id" <> OLD.id;
    IF remaining_directors = 0 THEN
      RAISE EXCEPTION 'LAST_DIRECTOR_CANNOT_BE_DEACTIVATED: Center % must retain at least one ACTIVE DIRECTOR.', OLD.center_id
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_staff_users_last_active_director ON "staff_users";
CREATE TRIGGER trg_staff_users_last_active_director
  BEFORE UPDATE OR DELETE ON "staff_users"
  FOR EACH ROW EXECUTE FUNCTION eduerp_guard_last_active_director();

-- ============================================================================
-- SECTION 3: LEAST-PRIVILEGE ROLE ACL FUNCTION (T04.02, S2F03)
-- ============================================================================

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
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE ledger_entries_entry_seq_seq TO %I;', p_worker_role);
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = p_readonly_role) THEN
    EXECUTE format('GRANT USAGE ON SCHEMA public TO %I;', p_readonly_role);
    FOREACH tbl IN ARRAY mutable_tables || append_only_tables LOOP
      EXECUTE format('REVOKE ALL ON TABLE %I FROM %I;', tbl, p_readonly_role);
      EXECUTE format('GRANT SELECT ON TABLE %I TO %I;', tbl, p_readonly_role);
    END LOOP;
  END IF;
END;
$$;

SELECT eduerp_apply_role_grants();
