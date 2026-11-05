# ADR-012: Stage 12 Attendance Lifecycle, Offline Sync Protocol, Stale Excel Conflict Prevention, and Trial Conversion Integration

- **Status:** Proposed (`IN_REVIEW` under `S11S12FIX-Q`)
- **Date:** 2026-11-05
- **Stage:** `S12` (`12.01`–`12.05`, `P01`–`P06`)

## 1. Context
Stage 12 implements lesson attendance marking across Teacher Web, Teacher Mobile (offline SQLite queue), Admin Excel Import, and Admin/Director reason-coded overrides (`BR-03`, `BR-11`, `C04`, `D07`, `CASE-05`, `CASE-06`, `CASE-16`, `CASE-21`, `T12.01`–`T12.05`), using the canonical 46-table PostgreSQL schema (`lesson_occurrences`, `substitute_assignments`, `attendance_records`, `attendance_revisions`, `client_operation_logs`, `trial_activations`, `invoices`, `outbox_events`, `audit_logs`).

## 2. Architectural Decisions

1. **Draft vs Submitted Attendance Separation (`12.01`):**
   - `GET /api/v1/lessons/{lesson_id}/attendance` (`getLessonAttendanceDraftOrSubmitted`) computes the live roster from eligible `enrollments` (`TRIAL`, `ACTIVE`, `FROZEN`) and displays `draft_default_status = 'PRESENT'` without writing any database rows, outbox events, or trial conversions.
   - Confirmed attendance is persisted only on `POST /api/v1/lessons/{lesson_id}/attendance/submit` (`submitLessonAttendance`, or alias `POST /api/v1/lessons/{lesson_id}/attendance`), which creates `attendance_records` (`version = 1`), `attendance_revisions` (`revision_version = 1`), marks `lesson_occurrences.status = 'COMPLETED'`, and emits `AttendanceSubmitted` (`v1`).
   - Teacher responses never expose guardian phone numbers or financial/invoice identifiers (`activated_invoice_ids` omitted from `AttendanceSubmitResponseDto`).

2. **Offline SQLite Sync & Portable Acknowledgement Reducer (`12.02`):**
   - `POST /api/v1/attendance/offline-sync` (`syncOfflineAttendanceBatch`, or alias `POST /api/v1/attendance/sync`) processes each queued item with `(center_id, actor_id, operation_type='ATTENDANCE_CLIENT_OP_UUID', client_operation_uuid)` deduplication in `client_operation_logs`.
   - `applyOfflineAttendanceSyncAck` in `packages/contracts/src/index.ts` transitions a queue item to `SYNCED` only when `ack_status` is `ACK_COMMITTED` or `ACK_IDEMPOTENT_REPLAY` **and** `server_version` is a positive integer (`>= 1`); malformed/null `server_version` keeps the item `PENDING` (`INVALID_ACK_SERVER_VERSION`), `CONFLICT_409` transitions to `CONFLICT`, and `FORBIDDEN_PERMISSION_REVOKED` / `BLOCKED_LICENSE_READ_ONLY` transition to `REJECTED` without infinite retry loops.

3. **Stale Excel Conflict Prevention & Subset Admin Override Provenance (`12.03`):**
   - `POST /api/v1/lessons/{lesson_id}/attendance/excel-import` (`importExcelLessonAttendance`, or `source_channel = 'ADMIN_EXCEL'`) succeeds only for initial unconfirmed lessons (`existingRecords.length === 0`). If Teacher/Admin attendance is already confirmed (`currentVersion >= 1`), it fails closed with `409 STALE_EXCEL_CONFLICT` and reports the actual persisted `server_version = currentVersion` (`1` after initial Teacher submit).
   - `POST /api/v1/lessons/{lesson_id}/attendance/override` (`overrideLessonAttendance`, or `source_channel = 'ADMIN_OVERRIDE'`) is restricted to `DIRECTOR` and `ADMIN` (`TEACHER` denied `403 FORBIDDEN_ROLE`), requires a non-empty `override_reason`, and updates **only** the student records included in `records` — untouched students on the lesson retain their original `TEACHER_WEB`/`TEACHER_MOBILE` `source_channel`, `recorded_by_staff_id`, `override_reason = null`, `version`, and revision history.

4. **Transactional Outbox Events & 2nd-Trial Conversion (`12.04`):**
   - When a `TRIAL` student is marked `PRESENT` or `LATE` on their 2nd distinct lesson occurrence, `TrialConversionService.evaluateTrialEnrollmentWithinTransaction` executes inside the same PostgreSQL transaction, creating `TrialActivation` and the initial `Invoice` anchored to `first_trial_date`.
   - If an `ADMIN_OVERRIDE` changes a 2nd-trial lesson from `PRESENT`/`LATE` to `ABSENT`, `AttendanceCorrected` (`v1`) sets `requires_trial_compensation_review = true` without auto-voiding historical invoices (`auto_compensate_trial_invoice` / `void_activated_trial_invoice` rejected with `403 POLICY_DECISION_NOT_CONFIRMED`).
