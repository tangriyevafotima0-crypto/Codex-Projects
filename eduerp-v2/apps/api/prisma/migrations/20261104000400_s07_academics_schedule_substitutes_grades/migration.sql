-- EduERP v2.0 — Stage 07 Additive Migration (Courses, Price History, Groups, Lessons, Substitutes & Grades)
-- Migration ID: 20261104000400_s07_academics_schedule_substitutes_grades
-- Target Engine: PostgreSQL 16
-- Scope (07.01–07.04 & OWNER-20261104-02):
--   1. 07.01: Adds change_reason and target_version_snapshot to append-only course_price_history
--      (keeping zero mutable 'version' column on immutable table per S2F03).
--   2. 07.01 & OWNER-20261104-02: Adds center-configurable due_date_rule ('ENROLLMENT_ANNIVERSARY' | 'CENTER_FIXED_DAY'),
--      fixed_due_day (1..31), and collection_timing ('ADVANCE' | 'ARREARS') to course_groups, separating service period,
--      due-date rule, and advance/arrears timing without inventing S08 monetary charge formulas.
--   3. 07.02: Adds cancellation_reason, cancellation_source, composite self-safe reschedule FK
--      (fk_lesson_occurrences_rescheduled_from), no-self-reschedule CHECK, and single-replacement partial unique index
--      on lesson_occurrences.
--   4. 07.03 & 07.04: Adds revoke_reason on substitute_assignments and composite lookup indexes for teacher schedule
--      conflict detection, single-lesson substitute entitlement resolution, and append-only grade revision audit history.

ALTER TABLE "course_price_history"
  ADD COLUMN IF NOT EXISTS "change_reason" VARCHAR(255) NULL,
  ADD COLUMN IF NOT EXISTS "target_version_snapshot" INTEGER NOT NULL DEFAULT 1
    CHECK ("target_version_snapshot" >= 1);

CREATE INDEX IF NOT EXISTS "idx_course_price_history_lookup"
  ON "course_price_history" ("center_id", "course_id", "group_id", "effective_from" DESC, "created_at" DESC);

ALTER TABLE "course_groups"
  ADD COLUMN IF NOT EXISTS "due_date_rule" VARCHAR(32) NOT NULL DEFAULT 'ENROLLMENT_ANNIVERSARY'
    CHECK ("due_date_rule" IN ('ENROLLMENT_ANNIVERSARY', 'CENTER_FIXED_DAY')),
  ADD COLUMN IF NOT EXISTS "fixed_due_day" SMALLINT NULL
    CHECK ("fixed_due_day" IS NULL OR ("fixed_due_day" BETWEEN 1 AND 31)),
  ADD COLUMN IF NOT EXISTS "collection_timing" VARCHAR(16) NOT NULL DEFAULT 'ARREARS'
    CHECK ("collection_timing" IN ('ADVANCE', 'ARREARS'));

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_course_groups_due_date_rule'
  ) THEN
    ALTER TABLE "course_groups"
      ADD CONSTRAINT "chk_course_groups_due_date_rule"
      CHECK (
        ("due_date_rule" = 'ENROLLMENT_ANNIVERSARY' AND "fixed_due_day" IS NULL)
        OR ("due_date_rule" = 'CENTER_FIXED_DAY' AND "fixed_due_day" IS NOT NULL)
      );
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS "idx_course_groups_center_teacher_status"
  ON "course_groups" ("center_id", "primary_teacher_id", "status");

ALTER TABLE "lesson_occurrences"
  ADD COLUMN IF NOT EXISTS "cancellation_reason" VARCHAR(255) NULL,
  ADD COLUMN IF NOT EXISTS "cancellation_source" VARCHAR(32) NULL
    CHECK (
      "cancellation_source" IS NULL
      OR "cancellation_source" IN ('ADMIN_MANUAL', 'PUBLIC_HOLIDAY', 'WEATHER_EMERGENCY', 'HOLIDAY_CALENDAR_INPUT')
    );

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_lesson_occurrences_rescheduled_from'
  ) THEN
    ALTER TABLE "lesson_occurrences"
      ADD CONSTRAINT "fk_lesson_occurrences_rescheduled_from"
      FOREIGN KEY ("rescheduled_from_lesson_id", "center_id")
      REFERENCES "lesson_occurrences" ("id", "center_id")
      ON DELETE RESTRICT ON UPDATE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_lesson_occurrences_no_self_reschedule'
  ) THEN
    ALTER TABLE "lesson_occurrences"
      ADD CONSTRAINT "chk_lesson_occurrences_no_self_reschedule"
      CHECK ("rescheduled_from_lesson_id" IS NULL OR "rescheduled_from_lesson_id" <> "id");
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS "idx_lesson_occurrences_rescheduled_from_once"
  ON "lesson_occurrences" ("center_id", "rescheduled_from_lesson_id")
  WHERE "rescheduled_from_lesson_id" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "idx_lesson_occurrences_center_teacher_window"
  ON "lesson_occurrences" ("center_id", "pay_recipient_teacher_id", "starts_at_utc", "ends_at_utc");

ALTER TABLE "substitute_assignments"
  ADD COLUMN IF NOT EXISTS "revoke_reason" VARCHAR(255) NULL;

CREATE INDEX IF NOT EXISTS "idx_substitute_assignments_center_sub_active"
  ON "substitute_assignments" ("center_id", "substitute_teacher_id", "status", "lesson_id");

CREATE INDEX IF NOT EXISTS "idx_audit_logs_center_entity_history"
  ON "audit_logs" ("center_id", "entity_type", "entity_id", "created_at" ASC, "id" ASC);

SELECT eduerp_apply_role_grants();
