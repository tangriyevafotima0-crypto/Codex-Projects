# ADR-007 — Stage 07 Academics, Timezone/DST Lesson Scheduling, Single-Lesson Substitute Entitlements, Grade Revision History & R1/R2 Hardening

- **Status:** `IN_REVIEW`
- **Task ID:** `S07FULL-I` (`R1`, `R2`, `R3`, `07.01`–`07.05`)
- **Base Commit:** `f365207ca2b41ae6aceeb1577ff1aea0a2883569`
- **Date:** `2026-11-04`

---

## 1. Context & Problem Statement

Stage 07 (`07.01`–`07.05`) introduces the core academic domain of EduERP v2.0 (courses, append-only tariff history, course groups, lesson occurrences with center IANA timezone & holiday/reschedule semantics, 1-lesson substitute teacher entitlements, and student exam grades with revision history) while closing two residual P2 hardening items (`R1` and `R2`) and packaging hygiene (`R3`) from the Stage 06 manager review (`planning/state/reviews/S04-S06-H.md`).

Additionally, the product owner confirmed `OWNER-20261104-02`, requiring per-center/per-group configurable billing timing parameters (anniversary due date vs center-fixed due day, and separate advance vs arrears collection timing) while keeping open monetary calculation formulas (`D03`, `D21`, `D14`, `D22`) gated until Stage 08.

---

## 2. Architectural Decisions

### 2.1. `R1` — Fail-Closed Shared PostgreSQL Rate Limiter & Technical Helper Table Boundary
- `AuthService.checkAndIncrementSharedIpRateLimit()` no longer falls back to a process-local `Map` when querying `auth_rate_limit_buckets` fails.
- Any database connectivity, schema, or table privilege failure (`REVOKE ALL ON TABLE auth_rate_limit_buckets`) fails closed with HTTP `503 DATABASE_UNAVAILABLE` and a static, secret-free diagnostic message.
- Expired buckets in `auth_rate_limit_buckets` are cleaned up in bounded batches (`LIMIT 256` per center on `expires_at <= now`). `auth_rate_limit_buckets` is documented as a short-TTL technical rate-limit helper table outside the 46 canonical domain entities, not a customer audit or financial retention table.

### 2.2. `R2` — Strict Typed Booleans & Explicit Guardian Reuse Intent
- `parseOptionalStrictBoolean()` in `apps/api/src/students/normalization.ts` rejects non-boolean values (such as string `'false'`, `'true'`, `0`, `1`) with HTTP `400 VALIDATION_ERROR`, eliminating `Boolean('false') === true` coercion hazards.
- `StudentsService.registerStudentQuick15s()` no longer auto-reuses an existing guardian merely because `sameGuardianName` matches. Reusing an existing guardian by `phone_e164` requires explicit intent: matching `guardian_id`, `reuse_existing_guardian: true`, or `confirm_sibling_or_similar_name: true` (when guardian name also matches). Siblings and distinct students with the same name remain fully supported.

### 2.3. `07.01` & `OWNER-20261104-02` — Courses, Append-Only Tariff History & Group Billing Configuration
- `course_price_history` remains strictly append-only (protected by `trg_immutable_course_price_history` and runtime DB role ACLs, with zero mutable `version` column). Additive columns `change_reason` and `target_version_snapshot` record audit metadata alongside `changed_by_staff_id` and `effective_from`.
- **Current vs `as_of_date` Tariff Resolution:** When `PATCH /api/v1/courses/:course_id/price` is called with a future `effective_from > today_in_center_timezone`, the future tariff is appended to `course_price_history` without overwriting today's active `default_monthly_fee_uzs`. `CoursesService.buildCourseResponse()` resolves `effective_fee_as_of_uzs` as the latest `course_price_history` entry with `effective_from <= as_of_date`, and never updates existing `invoices` or `ledger_entries`.
- **Per-Center / Per-Group Billing Parameters (`OWNER-20261104-02`):** `course_groups` stores three orthogonal configuration axes:
  1. `billing_mode` (`CALENDAR_PRO_RATA | ROLLING_MONTH | LESSON_PACKAGE_12`)
  2. `due_date_rule` (`ENROLLMENT_ANNIVERSARY | CENTER_FIXED_DAY`) + `fixed_due_day` (`1..31`, e.g. `15`)
  3. `collection_timing` (`ARREARS | ADVANCE`)
  Enforced in PostgreSQL by `chk_course_groups_due_date_rule`. Actual invoice/pro-rata/package monetary formulas remain gated until Stage 08 (`403 POLICY_DECISION_NOT_CONFIRMED`).
- **Teacher Deactivation Open-Lesson Warnings:** When a `TEACHER` is deactivated or changed to another role in `StaffService.updateStaffStatus()`, active substitute assignments on future `SCHEDULED` lessons are revoked (restoring `pay_recipient_teacher_id = primary_teacher_snapshot_id` on those future scheduled lessons while never touching `COMPLETED` lessons), and `open_scheduled_lessons_warning_count`, `affected_active_group_ids`, and `open_scheduled_lesson_ids` are returned and logged in `audit_logs` (`TEACHER_DEACTIVATED_OPEN_LESSONS_WARNING`) without silently reassigning primary groups/lessons.

### 2.4. `07.02` — Timezone/DST-Safe Lesson Occurrences, Conflict Serialization, Holidays & Rescheduling
- Each lesson occurrence has its own UUID `id` and `(group_id, lesson_date, occurrence_seq)` identity, supporting multiple lessons on the same calendar day.
- `resolveWallTimeToUtcInstant()` converts `(lesson_date, local_starts_time, timezone)` into UTC using `Intl.DateTimeFormat` with explicit IANA timezone validation, 100% independent of `process.env.TZ`. Nonexistent spring-forward DST gaps fail closed with `422 NONEXISTENT_LOCAL_TIME_DST_GAP`, and ambiguous fall-back DST overlaps fail closed with `422 AMBIGUOUS_LOCAL_TIME_DST_OVERLAP` unless `dst_disambiguation` (`EARLIER | LATER`) is specified.
- Concurrent `scheduleGroupLessonOccurrence` calls lock both `course_groups` and the teacher's `staff_users` row (`FOR UPDATE`), preventing parallel overlapping lessons in the same group or across multiple groups taught by the same teacher.
- Rescheduling sets the original lesson to `status = 'RESCHEDULED'` and links the new lesson via `rescheduled_from_lesson_id` (enforced by composite FK `fk_lesson_occurrences_rescheduled_from`, `chk_lesson_occurrences_no_self_reschedule`, and partial unique index `idx_lesson_occurrences_rescheduled_from_once`), preserving any existing grades/attendance/audit records on the original lesson ID.
- Cancelled (`CANCELLED_BY_CENTER`) and replaced (`RESCHEDULED`) lessons evaluate `eligible_for_teacher_ping: false`, `eligible_for_trial_conversion: false`, and `eligible_for_package_consumption: false`.

### 2.5. `07.03` — Shared Authorization Resolver & Single-Lesson Substitute Entitlements
- `AcademicAccessService` centralizes group and single-lesson authorization across `GroupsService`, `LessonsService`, `SubstitutionsService`, and `GradesService`.
- Assigning a substitute teacher (`POST /api/v1/lessons/:lesson_id/substitute`) locks `lesson_occurrences` (`FOR UPDATE`), checks `expected_version`, updates `pay_recipient_teacher_id = substitute_teacher_id` while preserving `primary_teacher_snapshot_id`, and inserts an `ACTIVE` `substitute_assignments` row.
- Substitute entitlement is strictly scoped to the assigned `lesson_id`: a teacher assigned as substitute for Lesson 1 of Group G on a given day is denied (`403 FORBIDDEN_OBJECT_SCOPE`) on Lesson 2 of Group G on the same day, and revoking the substitute assignment immediately blocks subsequent offline-queued requests.

### 2.6. `07.04` — Exam Grades, Server Plain-Text Sanitization & Canonical `AuditLog` Revision History
- `GradeEntry` (`grade_entries`) remains one of the 46 canonical tables (`mutable` with optimistic `version`).
- Every grade creation (`GRADE_ENTRY_CREATED`) and update (`GRADE_ENTRY_UPDATED`) atomically inserts an immutable revision record into the canonical append-only `audit_logs` table (indexed by `idx_audit_logs_center_entity_history`), capturing `revision_version`, `previous_score`, `new_score`, `previous_comment_sanitized`, `new_comment_sanitized`, `recorded_by_teacher_id`, `reason`, and `request_id`. This avoids introducing a 47th domain table while guaranteeing DB-enforced append-only immutability (`trg_immutable_audit_logs` + `eduerp_api_runtime` ACL).
- `sanitizePlainTextGradeComment()` enforces a server-side plain-text / JSON contract (neutralizing `<script>`, event-handler attributes, `javascript:`, and `<`/`>` characters). No frontend UI exists in Stage 07; this is strictly a server-side plain-text boundary.
