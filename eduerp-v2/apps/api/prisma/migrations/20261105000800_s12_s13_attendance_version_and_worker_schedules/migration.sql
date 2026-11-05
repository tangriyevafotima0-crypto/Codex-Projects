-- EduERP v2.0 — Stage 12 (R01) & Stage 13 Additive Migration
-- Migration ID: 20261105000800_s12_s13_attendance_version_and_worker_schedules
-- Target Engine: PostgreSQL 16
-- Scope (R01 & 13.01–13.05):
--   1. R01: Adds durable lesson-attendance aggregate counter `attendance_version` (INTEGER NOT NULL DEFAULT 0 >= 0)
--      to `lesson_occurrences` so sequential subset overrides (Student A -> Student B -> Student C) persist the
--      authoritative lesson attendance version in PostgreSQL without mutating untouched students' records or revisions.
--   2. Backfills `lesson_occurrences.attendance_version` deterministically for any existing submitted lessons from
--      `attendance_records` and `attendance_revisions`.
--   3. 13.03: Adds `teacher_ping_recipient_id` (UUID NULL) on `lesson_occurrences` to record which teacher
--      (`pay_recipient_teacher_id` at 20-minute mark) received the unsubmitted-attendance ping.
--   4. Re-applies least-privilege runtime role grants via `eduerp_apply_role_grants()`.

ALTER TABLE "lesson_occurrences"
  ADD COLUMN IF NOT EXISTS "attendance_version" INTEGER NOT NULL DEFAULT 0
    CHECK ("attendance_version" >= 0),
  ADD COLUMN IF NOT EXISTS "teacher_ping_recipient_id" UUID NULL DEFAULT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_lesson_occurrences_ping_recipient'
  ) THEN
    ALTER TABLE "lesson_occurrences"
      ADD CONSTRAINT "fk_lesson_occurrences_ping_recipient"
      FOREIGN KEY ("teacher_ping_recipient_id", "center_id")
      REFERENCES "staff_users" ("id", "center_id")
      ON DELETE RESTRICT ON UPDATE RESTRICT;
  END IF;
END;
$$;

-- Backfill attendance_version for any existing lesson_occurrences that already have attendance_records
UPDATE "lesson_occurrences" AS lo
   SET "attendance_version" = GREATEST(
         lo."attendance_version",
         COALESCE(
           (
             SELECT 1 + COUNT(DISTINCT ar_rev."client_operation_uuid") FILTER (WHERE ar_rev."revision_version" > 1)
               FROM "attendance_records" ar
               JOIN "attendance_revisions" ar_rev
                 ON ar_rev."attendance_record_id" = ar."id"
                AND ar_rev."center_id" = ar."center_id"
              WHERE ar."center_id" = lo."center_id"
                AND ar."lesson_id" = lo."id"
           ),
           0
         ),
         COALESCE(
           (
             SELECT MAX(ar."version")
               FROM "attendance_records" ar
              WHERE ar."center_id" = lo."center_id"
                AND ar."lesson_id" = lo."id"
           ),
           0
         )
       )
 WHERE EXISTS (
   SELECT 1
     FROM "attendance_records" ar
    WHERE ar."center_id" = lo."center_id"
      AND ar."lesson_id" = lo."id"
 );

CREATE INDEX IF NOT EXISTS "idx_lesson_occurrences_ping_scan"
  ON "lesson_occurrences" ("center_id", "status", "starts_at_utc", "ends_at_utc");

SELECT eduerp_apply_role_grants();
