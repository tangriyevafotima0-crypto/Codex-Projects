# ADR-012: Stage 12 Attendance Lifecycle, Authoritative Lesson-Attendance Aggregate Revision (`R01`), Offline Sync Protocol, and Stale Excel Conflict Prevention

- **Status:** Proposed (`IN_REVIEW` under `S12FIX-S13FULL-R`)
- **Date:** 2026-11-05
- **Stage:** `S12` (`12.01`–`12.05`, `R01`–`R03`)

## 1. Context
Stage 12 implements lesson attendance marking across Teacher Web, Teacher Mobile (offline SQLite queue), Admin Excel Import, and Admin/Director reason-coded overrides (`BR-03`, `BR-11`, `C04`, `D07`, `CASE-05`, `CASE-06`, `CASE-16`, `CASE-21`, `T12.01`–`T12.05`).

In `S11S12FIX-Q` review (`Q-VERSION-01` / `R01`), independent 3-student sequential subset overrides (`Student A` -> `v2`, `Student B` -> `v3`, `Student C` -> `v4`) exposed a defect when inferring the lesson-attendance aggregate version from `MAX(attendance_records.version)`: because untouched students' per-record `version` stays `1` while each touched student's per-record `version` increments by `+1`, overriding `Student B` after `Student A` set `B.version = 2` so `MAX(attendance_records.version)` remained `2` even though the response returned `new_version = 3`.

## 2. Architectural Decisions

1. **Authoritative Persisted Lesson-Attendance Aggregate Revision (`R01`):**
   - Additive migration `20261105000800_s12_s13_attendance_version_and_worker_schedules` adds `"attendance_version" INTEGER NOT NULL DEFAULT 0 CHECK ("attendance_version" >= 0)` to `"lesson_occurrences"`, distinct from `"lesson_occurrences"."version"` (which tracks schedule/cancellation/ping mutations) and distinct from `"attendance_records"."version"` (which tracks contiguous per-student record revisions).
   - Unsubmitted lessons have `attendance_version = 0` (and `GET /api/v1/lessons/{lesson_id}/attendance` reports `is_submitted: false, current_version: 1` for initial submission).
   - Initial attendance submission (`expected_version: 1`) atomically sets `lesson_occurrences.attendance_version = 1` (`WHERE attendance_version = 0`) and creates `attendance_records` with per-record `version = 1`.
   - Each reason-coded `ADMIN_OVERRIDE` (`expected_version = V`) verifies `V === currentLessonAttendanceVersion`, atomically increments `lesson_occurrences.attendance_version = V + 1` (`WHERE attendance_version = V`), and updates **only** the included student records in `attendance_records` (incrementing each touched student's per-record `version` contiguously by `+1` and appending `attendance_revisions`). Untouched students' `status`, `source_channel`, `recorded_by_staff_id`, `override_reason`, per-record `version`, and revision history remain completely untouched (`ATT-IT-11`, `ATT-IT-12`).
   - `GET current_version`, `POST submit/override new_version`, `409` `conflict_details.server_version`, offline sync `server_version`, and `client_operation_logs` responses all agree on the persisted `lesson_occurrences.attendance_version`.

2. **Offline SQLite Sync & Portable Acknowledgement Reducer (`12.02`):**
   - `POST /api/v1/attendance/offline-sync` deduplicates per `(center_id, actor_id, 'ATTENDANCE_CLIENT_OP_UUID', client_operation_uuid)` in `client_operation_logs` and maps domain `IdempotencyConflictError` / `OptimisticVersionConflictError` / `ApiHttpException(409)` into per-operation `CONFLICT_409` ACKs without aborting earlier committed items in the batch.
