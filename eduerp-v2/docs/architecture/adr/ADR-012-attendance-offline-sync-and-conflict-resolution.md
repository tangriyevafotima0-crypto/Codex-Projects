# ADR-012: Attendance Lifecycle, Offline Sync Protocol, Stale Conflict Queue, and Trial Conversion

- **Status:** Accepted
- **Date:** 2026-11-05
- **Stage:** S12 (`S11FIX-S12FULL-P`)

## Context
Stage 12 introduces teacher and admin lesson attendance marking across Web, Desktop (Offline SQLite), Excel import, and Mobile channels, along with conflict queuing for stale edits, reason-coded Admin overrides, immutable revision history, outbox events, and trial lesson feedback/conversion.

## Decisions
1. **Per-Record Optimistic Concurrency & Immutable Revision History:**
   - Every `attendance_records` row carries an integer `version` (starting at `1`) and appends an immutable `attendance_revisions` row on every create, update, or conflict resolution.
2. **Stale Offline / Excel Conflict Queue (No Silent Overwrite):**
   - When an incoming mutation carries an `expected_version` that does not match the current `attendance_records.version` (or `base_version_missing` for an Excel import when a record already exists with a different status/remarks), the server never overwrites the authoritative row.
   - Instead, it creates an `OPEN` row in `attendance_conflicts` with `conflict_type` (`STALE_OFFLINE_SYNC`, `EXCEL_IMPORT_CONFLICT`, or `CONCURRENT_EDIT`), emits `AttendanceConflictOpened`, and returns `CONFLICT_QUEUED` (in `/api/v1/attendance/sync`) or HTTP `409 CONFLICT` (in `/api/v1/attendance/sessions/:id/mark`).
3. **Reason-Coded Admin Override:**
   - Only `OWNER`, `DIRECTOR`, and `ADMIN` can resolve an open conflict via `POST /api/v1/attendance/conflicts/:id/resolve` with `resolution_status` (`RESOLVED_ACCEPT_INCOMING` or `RESOLVED_KEEP_EXISTING`) and a mandatory `resolution_reason` (minimum 5 characters).
   - Accepting the incoming value increments `attendance_records.version`, appends an `ADMIN_OVERRIDE` revision in `attendance_revisions`, writes an `audit_logs` entry, and emits `AttendanceOverridden` and `AttendanceUpdated`.
4. **Trial Lesson Feedback & Conversion:**
   - Trial bookings (`trial_lesson_bookings`) can be marked `ATTENDED` or `NO_SHOW` with teacher feedback during session attendance marking and converted by Admin/Director/Owner into an active student and `TRIAL` or `ACTIVE` group enrollment via `POST /api/v1/attendance/trials/:id/convert`.
