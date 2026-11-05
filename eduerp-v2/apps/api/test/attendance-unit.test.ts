/**
 * EduERP v2.0 — Stage 12 Unit & Offline SQLite Protocol Test Suite (`ATT-UNIT-01..06`).
 */

import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import {
  applyOfflineAttendanceSyncAck,
  OfflineAttendanceAckResultContract,
  OfflineAttendanceQueueItemContract,
} from '@eduerp/contracts';
import {
  emitAttendanceCorrectedOutboxEventInTx,
  emitAttendanceSubmittedOutboxEventInTx,
} from '../src/attendance/attendance.events';
import { evaluateAttendanceWriteConflict } from '../src/attendance/conflicts.service';
import {
  validateOfflineSyncBatchInput,
  validateSubmitAttendanceInput,
} from '../src/attendance/dto';
import { RequestWithCorrelationId } from '../src/common/request-id.middleware';
import { TransactionContext } from '../src/database/transaction';

const LESSON_1_ID = '11111111-2222-4333-8444-000000000040';
const LESSON_2_ID = '11111111-2222-4333-8444-000000000041';
const STU_1_ID = '11111111-2222-4333-8444-000000000010';
const STU_2_ID = '11111111-2222-4333-8444-000000000011';
const ENR_1_ID = '11111111-2222-4333-8444-000000000020';
const ATT_1_ID = '11111111-2222-4333-8444-000000000901';
const OP_UUID_1 = 'aaaaaaaa-bbbb-4ccc-8ddd-000000000001';
const OP_UUID_2 = 'aaaaaaaa-bbbb-4ccc-8ddd-000000000002';
const OP_UUID_3 = 'aaaaaaaa-bbbb-4ccc-8ddd-000000000003';
const OP_UUID_4 = 'aaaaaaaa-bbbb-4ccc-8ddd-000000000004';

function makeMockReq(headers: Record<string, string> = {}): RequestWithCorrelationId {
  return {
    headers,
    requestId: 'req-s12-unit-01',
  } as unknown as RequestWithCorrelationId;
}

describe('Stage 12 Unit & SQLite Protocol Suite — Attendance, Conflicts, Offline Sync & Events (ATT-UNIT-01..06)', () => {
  it('ATT-UNIT-01: validates 12.01 lesson attendance submission DTOs, optimistic version, and unconfirmed trial compensation policy gate', () => {
    const teacherSubmit = validateSubmitAttendanceInput(makeMockReq(), LESSON_1_ID, {
      client_operation_uuid: OP_UUID_1,
      expected_version: 1,
      source_channel: 'TEACHER_WEB',
      records: [
        { student_id: STU_2_ID, status: 'LATE' },
        { student_id: STU_1_ID, status: 'PRESENT' },
      ],
    });
    assert.equal(teacherSubmit.lessonId, LESSON_1_ID);
    assert.equal(teacherSubmit.sourceChannel, 'TEACHER_WEB');
    assert.equal(teacherSubmit.clientOperationUuid, OP_UUID_1);
    assert.equal(teacherSubmit.expectedVersion, 1);
    assert.equal(teacherSubmit.records.length, 2);
    assert.equal(teacherSubmit.records[0].studentId, STU_1_ID);
    assert.equal(teacherSubmit.records[0].status, 'PRESENT');
    assert.equal(teacherSubmit.records[1].studentId, STU_2_ID);
    assert.equal(teacherSubmit.records[1].status, 'LATE');

    assert.throws(
      () =>
        validateSubmitAttendanceInput(makeMockReq(), LESSON_1_ID, {
          client_operation_uuid: OP_UUID_1,
          expected_version: 1,
          source_channel: 'TEACHER_WEB',
          records: [
            { student_id: STU_1_ID, status: 'PRESENT' },
            { student_id: STU_1_ID, status: 'ABSENT' },
          ],
        }),
      (err: unknown) => {
        const ex = err as { statusCode?: number; errorCode?: string };
        return ex.statusCode === 422 && ex.errorCode === 'VALIDATION_ERROR';
      },
    );

    const validOverride = validateSubmitAttendanceInput(
      makeMockReq({ 'if-match-version': '1' }),
      LESSON_1_ID,
      {
        client_operation_uuid: OP_UUID_2,
        expected_version: 1,
        source_channel: 'ADMIN_OVERRIDE',
        override_reason: 'Medical certificate verified by Admin',
        records: [{ student_id: STU_1_ID, status: 'ABSENT' }],
      },
    );
    assert.equal(validOverride.sourceChannel, 'ADMIN_OVERRIDE');
    assert.equal(validOverride.overrideReason, 'Medical certificate verified by Admin');
    assert.equal(validOverride.expectedVersion, 1);

    for (const flag of ['auto_compensate_trial_invoice', 'void_activated_trial_invoice'] as const) {
      assert.throws(
        () =>
          validateSubmitAttendanceInput(makeMockReq(), LESSON_1_ID, {
            client_operation_uuid: OP_UUID_1,
            expected_version: 1,
            source_channel: 'ADMIN_OVERRIDE',
            override_reason: 'Correcting 2nd trial attendance',
            [flag]: true,
            records: [{ student_id: STU_1_ID, status: 'ABSENT' }],
          }),
        (err: unknown) => {
          const ex = err as { statusCode?: number; errorCode?: string };
          return ex.statusCode === 403 && ex.errorCode === 'POLICY_DECISION_NOT_CONFIRMED';
        },
      );
    }
  });

  it('ATT-UNIT-02: validates 12.02 offline attendance sync batches and deterministic student ordering', () => {
    const batch = validateOfflineSyncBatchInput({
      operations: [
        {
          client_operation_uuid: OP_UUID_1,
          lesson_id: LESSON_1_ID,
          expected_version: 1,
          source_channel: 'TEACHER_MOBILE',
          records: [
            { student_id: STU_2_ID, status: 'ABSENT' },
            { student_id: STU_1_ID, status: 'PRESENT' },
          ],
        },
        {
          client_operation_uuid: OP_UUID_2,
          lesson_id: LESSON_2_ID,
          expected_version: 1,
          source_channel: 'TEACHER_MOBILE',
          records: [{ student_id: STU_1_ID, status: 'LATE' }],
        },
      ],
    });
    assert.equal(batch.operations.length, 2);
    assert.equal(batch.operations[0].records[0].studentId, STU_1_ID);
    assert.equal(batch.operations[0].records[1].studentId, STU_2_ID);

    assert.throws(
      () => validateOfflineSyncBatchInput({ operations: [] }),
      (err: unknown) => {
        const ex = err as { statusCode?: number; errorCode?: string };
        return ex.statusCode === 400 && ex.errorCode === 'VALIDATION_ERROR';
      },
    );
  });

  it('ATT-UNIT-03: evaluates 12.03 CASE-21 conflict resolution matrix (Teacher vs Stale Excel 409, Teacher vs Teacher 409, reason-required ADMIN_OVERRIDE)', () => {
    const initial = evaluateAttendanceWriteConflict({
      lessonId: LESSON_1_ID,
      actorRole: 'TEACHER',
      requestedSourceChannel: 'TEACHER_WEB',
      overrideReason: null,
      expectedVersion: 1,
      existingRecords: [],
      incomingRecords: [{ studentId: STU_1_ID, status: 'PRESENT' }],
    });
    assert.equal(initial.mode, 'INITIAL_SUBMIT');
    assert.equal(initial.resolvedSourceChannel, 'TEACHER_WEB');
    assert.equal(initial.nextRecordVersion, 1);

    const existingConfirmed = [
      {
        id: ATT_1_ID,
        studentId: STU_1_ID,
        enrollmentId: ENR_1_ID,
        status: 'PRESENT' as const,
        isExcusedFrozen: false,
        sourceChannel: 'TEACHER_WEB' as const,
        recordedByStaffId: '11111111-2222-4333-8444-000000000004',
        overrideReason: null,
        version: 1,
      },
    ];

    assert.throws(
      () =>
        evaluateAttendanceWriteConflict({
          lessonId: LESSON_1_ID,
          actorRole: 'ADMIN',
          requestedSourceChannel: 'ADMIN_EXCEL',
          overrideReason: null,
          expectedVersion: 1,
          existingRecords: existingConfirmed,
          incomingRecords: [{ studentId: STU_1_ID, status: 'ABSENT' }],
        }),
      (err: unknown) => {
        const ex = err as {
          statusCode?: number;
          errorCode?: string;
          conflictDetails?: Record<string, unknown>;
        };
        return (
          ex.statusCode === 409 &&
          ex.errorCode === 'STALE_EXCEL_CONFLICT' &&
          ex.conflictDetails?.excel_version === 1 &&
          ex.conflictDetails?.server_version === 1
        );
      },
    );

    assert.throws(
      () =>
        evaluateAttendanceWriteConflict({
          lessonId: LESSON_1_ID,
          actorRole: 'TEACHER',
          requestedSourceChannel: 'TEACHER_WEB',
          overrideReason: null,
          expectedVersion: 1,
          existingRecords: existingConfirmed,
          incomingRecords: [{ studentId: STU_1_ID, status: 'ABSENT' }],
        }),
      (err: unknown) => {
        const ex = err as { statusCode?: number; errorCode?: string };
        return ex.statusCode === 409 && ex.errorCode === 'VERSION_CONFLICT';
      },
    );

    assert.throws(
      () =>
        evaluateAttendanceWriteConflict({
          lessonId: LESSON_1_ID,
          actorRole: 'ADMIN',
          requestedSourceChannel: 'ADMIN_OVERRIDE',
          overrideReason: null,
          expectedVersion: 1,
          existingRecords: existingConfirmed,
          incomingRecords: [{ studentId: STU_1_ID, status: 'ABSENT' }],
        }),
      (err: unknown) => {
        const ex = err as { statusCode?: number; errorCode?: string };
        return ex.statusCode === 422 && ex.errorCode === 'VALIDATION_ERROR';
      },
    );

    assert.throws(
      () =>
        evaluateAttendanceWriteConflict({
          lessonId: LESSON_1_ID,
          actorRole: 'ADMIN',
          requestedSourceChannel: 'ADMIN_OVERRIDE',
          overrideReason: 'Verified parent phone call',
          expectedVersion: 99,
          existingRecords: existingConfirmed,
          incomingRecords: [{ studentId: STU_1_ID, status: 'ABSENT' }],
        }),
      (err: unknown) => {
        const ex = err as { statusCode?: number; errorCode?: string };
        return ex.statusCode === 409 && ex.errorCode === 'VERSION_CONFLICT';
      },
    );

    const validOverride = evaluateAttendanceWriteConflict({
      lessonId: LESSON_1_ID,
      actorRole: 'ADMIN',
      requestedSourceChannel: 'ADMIN_OVERRIDE',
      overrideReason: 'Verified parent phone call',
      expectedVersion: 1,
      existingRecords: existingConfirmed,
      incomingRecords: [{ studentId: STU_1_ID, status: 'ABSENT' }],
    });
    assert.equal(validOverride.mode, 'ADMIN_OVERRIDE');
    assert.equal(validOverride.resolvedSourceChannel, 'ADMIN_OVERRIDE');
    assert.equal(validOverride.normalizedOverrideReason, 'Verified parent phone call');
    assert.equal(validOverride.nextRecordVersion, 2);

    // R01: When currentLessonAttendanceVersion is 3 (e.g. after overriding Student A -> v2 and Student B -> v3),
    // expectedVersion: 2 must be rejected with 409 VERSION_CONFLICT (server_version: 3) even if max(record.version) == 2!
    assert.throws(
      () =>
        evaluateAttendanceWriteConflict({
          lessonId: LESSON_1_ID,
          actorRole: 'ADMIN',
          requestedSourceChannel: 'ADMIN_OVERRIDE',
          overrideReason: 'Stale override using max record version 2 instead of aggregate version 3',
          expectedVersion: 2,
          currentLessonAttendanceVersion: 3,
          existingRecords: [
            { ...existingConfirmed[0], version: 2 },
            { ...existingConfirmed[0], id: '11111111-2222-4333-8444-000000000902', studentId: STU_2_ID, version: 2 },
          ],
          incomingRecords: [{ studentId: STU_1_ID, status: 'LATE' }],
        }),
      (err: unknown) => {
        const ex = err as { statusCode?: number; errorCode?: string; conflictDetails?: Record<string, unknown> };
        return (
          ex.statusCode === 409 &&
          ex.errorCode === 'VERSION_CONFLICT' &&
          ex.conflictDetails?.server_version === 3
        );
      },
    );

    const validThirdOverride = evaluateAttendanceWriteConflict({
      lessonId: LESSON_1_ID,
      actorRole: 'ADMIN',
      requestedSourceChannel: 'ADMIN_OVERRIDE',
      overrideReason: 'Valid 3rd subset override using aggregate version 3',
      expectedVersion: 3,
      currentLessonAttendanceVersion: 3,
      existingRecords: [
        { ...existingConfirmed[0], version: 2 },
        { ...existingConfirmed[0], id: '11111111-2222-4333-8444-000000000902', studentId: STU_2_ID, version: 2 },
      ],
      incomingRecords: [{ studentId: STU_1_ID, status: 'LATE' }],
    });
    assert.equal(validThirdOverride.nextRecordVersion, 4);
  });

  it('ATT-UNIT-04: emits 12.04 AttendanceSubmitted (v1) and AttendanceCorrected (v1) outbox events with PII-minimal payloads', async () => {
    const capturedQueries: Array<{ sql: string; params: readonly unknown[] }> = [];
    const mockTx: TransactionContext = {
      query: async (sql: string, params: readonly unknown[] = []) => {
        capturedQueries.push({ sql, params });
        return { rows: [], rowCount: 1 };
      },
    } as unknown as TransactionContext;

    const nowUtc = new Date('2026-11-05T08:00:00.000Z');
    await emitAttendanceSubmittedOutboxEventInTx(mockTx, {
      centerId: '11111111-2222-4333-8444-000000000001',
      lessonId: LESSON_1_ID,
      groupId: '11111111-2222-4333-8444-000000000030',
      lessonDate: '2026-11-04',
      occurrenceSeq: 1,
      aggregateVersion: 1,
      clientOperationUuid: OP_UUID_1,
      submittedByStaffId: '11111111-2222-4333-8444-000000000004',
      absentStudentIds: [STU_2_ID],
      lateStudentIds: [],
      presentTrialEnrollmentIds: [ENR_1_ID],
      occurredAtUtc: nowUtc,
    });

    await emitAttendanceCorrectedOutboxEventInTx(mockTx, {
      centerId: '11111111-2222-4333-8444-000000000001',
      attendanceRecordId: ATT_1_ID,
      revisionVersion: 2,
      lessonId: LESSON_1_ID,
      studentId: STU_1_ID,
      enrollmentId: ENR_1_ID,
      previousStatus: 'PRESENT',
      newStatus: 'ABSENT',
      overrideReason: 'Verified medical certificate',
      actorStaffId: '11111111-2222-4333-8444-000000000003',
      requiresTrialCompensationReview: false,
      occurredAtUtc: nowUtc,
    });

    assert.equal(capturedQueries.length, 2);
    const submittedPayload = JSON.parse(String(capturedQueries[0].params[5])) as Record<
      string,
      unknown
    >;
    assert.equal(submittedPayload.lesson_id, LESSON_1_ID);
    assert.deepEqual(submittedPayload.absent_student_ids, [STU_2_ID]);
    assert.deepEqual(submittedPayload.present_trial_enrollment_ids, [ENR_1_ID]);

    const correctedPayload = JSON.parse(String(capturedQueries[1].params[5])) as Record<
      string,
      unknown
    >;
    assert.equal(correctedPayload.attendance_record_id, ATT_1_ID);
    assert.equal(correctedPayload.previous_status, 'PRESENT');
    assert.equal(correctedPayload.new_status, 'ABSENT');
    assert.equal(correctedPayload.override_reason, 'Verified medical certificate');
  });

  it('ATT-UNIT-05: applies 12.02 portable applyOfflineAttendanceSyncAck reducer across ACK_COMMITTED, ACK_IDEMPOTENT_REPLAY, CONFLICT_409, FORBIDDEN_PERMISSION_REVOKED, and missing ACKs', () => {
    const queue: OfflineAttendanceQueueItemContract[] = [
      {
        client_operation_uuid: OP_UUID_1,
        lesson_id: LESSON_1_ID,
        expected_version: 1,
        payload_sha256: 'a'.repeat(64),
        state: 'PENDING',
        synced_server_version: null,
        last_ack_status: null,
        last_error_code: null,
        conflict_details_json: null,
      },
      {
        client_operation_uuid: OP_UUID_2,
        lesson_id: LESSON_2_ID,
        expected_version: 1,
        payload_sha256: 'b'.repeat(64),
        state: 'PENDING',
        synced_server_version: null,
        last_ack_status: null,
        last_error_code: null,
        conflict_details_json: null,
      },
      {
        client_operation_uuid: OP_UUID_3,
        lesson_id: LESSON_1_ID,
        expected_version: 1,
        payload_sha256: 'c'.repeat(64),
        state: 'PENDING',
        synced_server_version: null,
        last_ack_status: null,
        last_error_code: null,
        conflict_details_json: null,
      },
      {
        client_operation_uuid: OP_UUID_4,
        lesson_id: LESSON_2_ID,
        expected_version: 1,
        payload_sha256: 'd'.repeat(64),
        state: 'PENDING',
        synced_server_version: null,
        last_ack_status: null,
        last_error_code: null,
        conflict_details_json: null,
      },
    ];

    const acks: OfflineAttendanceAckResultContract[] = [
      {
        client_operation_uuid: OP_UUID_1,
        lesson_id: LESSON_1_ID,
        ack_status: 'ACK_COMMITTED',
        server_version: 1,
        error_code: null,
        conflict_details: null,
      },
      {
        client_operation_uuid: OP_UUID_2,
        lesson_id: LESSON_2_ID,
        ack_status: 'ACK_IDEMPOTENT_REPLAY',
        server_version: 1,
        error_code: null,
        conflict_details: null,
      },
      {
        client_operation_uuid: OP_UUID_3,
        lesson_id: LESSON_1_ID,
        ack_status: 'CONFLICT_409',
        server_version: 2,
        error_code: 'VERSION_CONFLICT',
        conflict_details: { server_version: 2 },
      },
      {
        client_operation_uuid: OP_UUID_4,
        lesson_id: LESSON_2_ID,
        ack_status: 'FORBIDDEN_PERMISSION_REVOKED',
        server_version: null,
        error_code: 'FORBIDDEN_OBJECT_SCOPE',
        conflict_details: null,
      },
    ];

    const reduced = applyOfflineAttendanceSyncAck(queue, acks);
    assert.equal(reduced[0].state, 'SYNCED');
    assert.equal(reduced[0].synced_server_version, 1);
    assert.equal(reduced[1].state, 'SYNCED');
    assert.equal(reduced[1].last_ack_status, 'ACK_IDEMPOTENT_REPLAY');
    assert.equal(reduced[2].state, 'CONFLICT');
    assert.equal(reduced[2].last_error_code, 'VERSION_CONFLICT');
    assert.equal(reduced[3].state, 'REJECTED');
    assert.equal(reduced[3].last_error_code, 'FORBIDDEN_OBJECT_SCOPE');

    const pendingAfter = reduced.filter((r) => r.state === 'PENDING');
    assert.equal(pendingAfter.length, 0);
  });

  it('ATT-UNIT-06: executes real SQLite database file offline queue persistence and acknowledgement protocol without infinite retry loops', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eduerp-s12-sqlite-'));
    const sqliteDbPath = path.join(tmpDir, 'offline_attendance.sqlite');

    try {
      execFileSync(
        'python3',
        [
          '-B',
          '-c',
          `
import sqlite3, sys
conn = sqlite3.connect(sys.argv[1])
conn.execute("""
  CREATE TABLE offline_attendance_queue (
    client_operation_uuid TEXT PRIMARY KEY,
    lesson_id TEXT NOT NULL,
    expected_version INTEGER NOT NULL,
    payload_sha256 TEXT NOT NULL,
    state TEXT NOT NULL,
    synced_server_version INTEGER NULL,
    last_ack_status TEXT NULL,
    last_error_code TEXT NULL,
    conflict_details_json TEXT NULL
  )
""")
rows = [
  ("${OP_UUID_1}", "${LESSON_1_ID}", 1, "${'a'.repeat(64)}", 'PENDING'),
  ("${OP_UUID_2}", "${LESSON_2_ID}", 1, "${'b'.repeat(64)}", 'PENDING'),
  ("${OP_UUID_3}", "${LESSON_1_ID}", 1, "${'c'.repeat(64)}", 'PENDING'),
]
conn.executemany(
  "INSERT INTO offline_attendance_queue (client_operation_uuid, lesson_id, expected_version, payload_sha256, state) VALUES (?, ?, ?, ?, ?)",
  rows,
)
conn.commit()
conn.close()
`,
          sqliteDbPath,
        ],
        { stdio: 'pipe' },
      );

      const pendingJson = execFileSync(
        'python3',
        [
          '-B',
          '-c',
          `
import json, sqlite3, sys
conn = sqlite3.connect(sys.argv[1])
conn.row_factory = sqlite3.Row
rows = [dict(r) for r in conn.execute("SELECT * FROM offline_attendance_queue WHERE state = 'PENDING' ORDER BY client_operation_uuid ASC").fetchall()]
conn.close()
print(json.dumps(rows))
`,
          sqliteDbPath,
        ],
        { encoding: 'utf8' },
      );

      const pendingQueue = JSON.parse(pendingJson.trim()) as OfflineAttendanceQueueItemContract[];
      assert.equal(pendingQueue.length, 3);

      const serverAcks: OfflineAttendanceAckResultContract[] = [
        {
          client_operation_uuid: OP_UUID_1,
          lesson_id: LESSON_1_ID,
          ack_status: 'ACK_COMMITTED',
          server_version: 1,
          error_code: null,
        },
        {
          client_operation_uuid: OP_UUID_2,
          lesson_id: LESSON_2_ID,
          ack_status: 'ACK_IDEMPOTENT_REPLAY',
          server_version: 1,
          error_code: null,
        },
        {
          client_operation_uuid: OP_UUID_3,
          lesson_id: LESSON_1_ID,
          ack_status: 'CONFLICT_409',
          server_version: 2,
          error_code: 'STALE_EXCEL_CONFLICT',
          conflict_details: { server_version: 2 },
        },
      ];

      const reduced = applyOfflineAttendanceSyncAck(pendingQueue, serverAcks);

      execFileSync(
        'python3',
        [
          '-B',
          '-c',
          `
import json, sqlite3, sys
conn = sqlite3.connect(sys.argv[1])
records = json.loads(sys.argv[2])
for r in records:
    conn.execute("""
      UPDATE offline_attendance_queue
         SET state = ?,
             synced_server_version = ?,
             last_ack_status = ?,
             last_error_code = ?,
             conflict_details_json = ?
       WHERE client_operation_uuid = ?
    """, (
      r["state"],
      r["synced_server_version"],
      r["last_ack_status"],
      r["last_error_code"],
      json.dumps(r["conflict_details_json"]) if r["conflict_details_json"] is not None else None,
      r["client_operation_uuid"],
    ))
conn.commit()
conn.close()
`,
          sqliteDbPath,
          JSON.stringify(reduced),
        ],
        { stdio: 'pipe' },
      );

      const finalJson = execFileSync(
        'python3',
        [
          '-B',
          '-c',
          `
import json, sqlite3, sys
conn = sqlite3.connect(sys.argv[1])
conn.row_factory = sqlite3.Row
all_rows = [dict(r) for r in conn.execute("SELECT * FROM offline_attendance_queue ORDER BY client_operation_uuid ASC").fetchall()]
pending_cnt = conn.execute("SELECT COUNT(*) FROM offline_attendance_queue WHERE state = 'PENDING'").fetchone()[0]
conn.close()
print(json.dumps({"rows": all_rows, "pending_cnt": pending_cnt}))
`,
          sqliteDbPath,
        ],
        { encoding: 'utf8' },
      );

      const finalState = JSON.parse(finalJson.trim()) as {
        rows: Array<Record<string, unknown>>;
        pending_cnt: number;
      };
      assert.equal(finalState.pending_cnt, 0);
      assert.equal(finalState.rows[0].state, 'SYNCED');
      assert.equal(finalState.rows[0].last_ack_status, 'ACK_COMMITTED');
      assert.equal(finalState.rows[1].state, 'SYNCED');
      assert.equal(finalState.rows[1].last_ack_status, 'ACK_IDEMPOTENT_REPLAY');
      assert.equal(finalState.rows[2].state, 'CONFLICT');
      assert.equal(finalState.rows[2].last_error_code, 'STALE_EXCEL_CONFLICT');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
