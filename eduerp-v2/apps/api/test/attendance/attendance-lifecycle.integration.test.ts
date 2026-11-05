/**
 * EduERP v2.0 — Gate G9: Stage 12 Attendance, Stale Excel Conflicts, Offline Sync & Trial Lesson Integration
 * Real Nest HTTP + PostgreSQL Integration Test Suite (`ATT-IT-01..10`).
 */

import { INestApplication } from '@nestjs/common';
import * as assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as http from 'node:http';
import { after, before, describe, it } from 'node:test';
import { createApiApplication } from '../../src/application';
import { AttendanceService } from '../../src/attendance/attendance.service';
import { ClockService } from '../../src/auth/clock.service';
import { AuthenticatedStaffPrincipal } from '../../src/auth/permissions.guard';
import { RequestWithCorrelationId } from '../../src/common/request-id.middleware';
import { loadApiEnv } from '../../src/config/env';
import {
  executeSyntheticSeed,
  SYNTHETIC_DEMO_CENTER_A as C,
  SYNTHETIC_DEMO_CENTER_B as CB,
  SYNTHETIC_PASSWORD_HASH,
  SYNTHETIC_TEST_ONLY_PASSWORD,
} from '../../src/database/seed-contract';
import {
  createEphemeralTestDbEnv,
  EphemeralDatabaseEnvironment,
} from '../database/harness';

interface HttpJsonResponse {
  readonly statusCode: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly rawBody: string;
  readonly json: Record<string, unknown>;
}

async function httpJsonRequest(options: {
  port: number;
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
}): Promise<HttpJsonResponse> {
  const payload = options.body !== undefined ? JSON.stringify(options.body) : undefined;
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: options.port,
        method: options.method,
        path: options.path,
        headers: {
          Host: `${C.centerSlug}.eduerp.local`,
          ...(payload !== undefined
            ? {
                'Content-Type': 'application/json',
                'Content-Length': String(Buffer.byteLength(payload)),
              }
            : {}),
          ...(options.headers ?? {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const rawBody = Buffer.concat(chunks).toString('utf8');
          let parsed: Record<string, unknown> = {};
          try {
            parsed = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
          } catch {
            parsed = { _raw: rawBody };
          }
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers,
            rawBody,
            json: parsed,
          });
        });
      },
    );
    req.on('error', reject);
    if (payload !== undefined) {
      req.write(payload);
    }
    req.end();
  });
}

describe('Gate G9 — Stage 12 Attendance, Stale Excel Conflicts, Offline Sync & Trial Integration HTTP + PostgreSQL Suite (ATT-IT-01..10)', () => {
  let env: EphemeralDatabaseEnvironment;
  let app: INestApplication;
  let clock: ClockService;
  let attendanceService: AttendanceService;
  let port = 0;

  let directorToken = '';
  let adminToken = '';
  let teacherToken = '';
  let teacher2Id = '';
  let teacher2Token = '';
  let fixtureSeq = 0;

  async function refreshTokens(): Promise<void> {
    const dirRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/auth/login',
      body: { username: 'director.demo', password: SYNTHETIC_TEST_ONLY_PASSWORD },
    });
    assert.equal(dirRes.statusCode, 200);
    directorToken = String(dirRes.json.access_token);

    const admRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/auth/login',
      body: { username: 'admin.demo', password: SYNTHETIC_TEST_ONLY_PASSWORD },
    });
    assert.equal(admRes.statusCode, 200);
    adminToken = String(admRes.json.access_token);

    const tchRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/auth/login',
      body: { username: 'teacher.demo', password: SYNTHETIC_TEST_ONLY_PASSWORD },
    });
    assert.equal(tchRes.statusCode, 200);
    teacherToken = String(tchRes.json.access_token);

    if (teacher2Id) {
      const tch2Res = await httpJsonRequest({
        port,
        method: 'POST',
        path: '/api/v1/auth/login',
        body: { username: 'teacher2.s12', password: SYNTHETIC_TEST_ONLY_PASSWORD },
      });
      assert.equal(tch2Res.statusCode, 200);
      teacher2Token = String(tch2Res.json.access_token);
    }
  }

  async function createIsolatedGroupAndLessons(options: {
    lessonDates: readonly string[];
    startsTimes?: readonly string[];
    occurrenceSeqs?: readonly number[];
    students: ReadonlyArray<{
      status: 'TRIAL' | 'ACTIVE' | 'FROZEN' | 'LEFT';
      enrolledAtDate?: string;
      leftAtDate?: string | null;
    }>;
    primaryTeacherId?: string;
  }): Promise<{
    groupId: string;
    lessonIds: string[];
    students: Array<{ studentId: string; enrollmentId: string }>;
  }> {
    fixtureSeq += 1;
    const groupId = crypto.randomUUID();
    const primaryTeacherId = options.primaryTeacherId ?? C.teacherId;

    await env.apiPoolA.query(
      `INSERT INTO "course_groups" (
         "id", "center_id", "course_id", "name", "primary_teacher_id",
         "billing_mode", "current_fee_uzs", "lessons_per_cycle",
         "schedule_days_json", "starts_time", "duration_minutes", "timezone", "status"
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4, $5::uuid,
         'CALENDAR_PRO_RATA', 600000, 12,
         '["MON","WED","FRI"]'::jsonb, '09:00', 90, 'Asia/Tashkent', 'ACTIVE'
       )`,
      [groupId, C.centerId, C.courseId, `S12-GRP-${fixtureSeq}`, primaryTeacherId],
    );

    const lessonIds: string[] = [];
    for (let i = 0; i < options.lessonDates.length; i += 1) {
      const lessonId = crypto.randomUUID();
      const lessonDate = options.lessonDates[i];
      const startsTime = options.startsTimes?.[i] ?? '09:00';
      const occurrenceSeq = options.occurrenceSeqs?.[i] ?? 1;
      const [hh, mm] = startsTime.split(':').map((n) => Number(n));
      const startsAtUtc = new Date(
        `${lessonDate}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00+05:00`,
      );
      const endsAtUtc = new Date(startsAtUtc.getTime() + 90 * 60 * 1000);

      await env.apiPoolA.query(
        `INSERT INTO "lesson_occurrences" (
           "id", "center_id", "group_id", "lesson_date", "occurrence_seq",
           "starts_at_utc", "ends_at_utc", "status",
           "primary_teacher_snapshot_id", "pay_recipient_teacher_id", "version"
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4::date, $5::smallint,
           $6::timestamptz, $7::timestamptz, 'SCHEDULED',
           $8::uuid, $8::uuid, 1
         )`,
        [
          lessonId,
          C.centerId,
          groupId,
          lessonDate,
          occurrenceSeq,
          startsAtUtc,
          endsAtUtc,
          primaryTeacherId,
        ],
      );
      lessonIds.push(lessonId);
    }

    const students: Array<{ studentId: string; enrollmentId: string }> = [];
    for (let j = 0; j < options.students.length; j += 1) {
      const spec = options.students[j];
      const studentId = crypto.randomUUID();
      const enrollmentId = crypto.randomUUID();
      const enrolledAtDate = spec.enrolledAtDate ?? '2026-11-01';

      await env.apiPoolA.query(
        `INSERT INTO "students" ("id", "center_id", "student_code", "full_name", "normalized_name", "status")
         VALUES ($1::uuid, $2::uuid, $3, $4, $5, 'ACTIVE')`,
        [
          studentId,
          C.centerId,
          `STU-S12-${String(fixtureSeq).padStart(2, '0')}-${j + 1}`,
          `Stage12 Student ${fixtureSeq}-${j + 1}`,
          `stage12 student ${fixtureSeq}-${j + 1}`,
        ],
      );

      await env.apiPoolA.query(
        `INSERT INTO "enrollments" (
           "id", "center_id", "student_id", "group_id", "status",
           "enrolled_at_date", "left_at_date", "churn_reason_code", "churn_attributed_teacher_id", "version"
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5,
           $6::date, $7::date, $8::smallint, $9::uuid, 1
         )`,
        [
          enrollmentId,
          C.centerId,
          studentId,
          groupId,
          spec.status,
          enrolledAtDate,
          spec.status === 'LEFT' ? (spec.leftAtDate ?? '2026-11-03') : null,
          spec.status === 'LEFT' ? 1 : null,
          spec.status === 'LEFT' ? primaryTeacherId : null,
        ],
      );

      students.push({ studentId, enrollmentId });
    }

    return { groupId, lessonIds, students };
  }

  before(async () => {
    env = await createEphemeralTestDbEnv();
    await executeSyntheticSeed(env.apiPoolA, C, {
      ...process.env,
      NODE_ENV: 'test',
      BOT_OUTBOUND_ENABLED: 'false',
    });
    await executeSyntheticSeed(env.apiPoolB, CB, {
      ...process.env,
      NODE_ENV: 'test',
      BOT_OUTBOUND_ENABLED: 'false',
    });

    await env.apiPoolA.query(
      `UPDATE "billing_policy_versions"
          SET "policy_confirmation_status" = 'CONFIRMED',
              "confirmed_by_director_id" = $2::uuid,
              "confirmed_at" = NOW()
        WHERE "center_id" = $1::uuid`,
      [C.centerId, C.directorId],
    );

    teacher2Id = crypto.randomUUID();
    await env.apiPoolA.query(
      `INSERT INTO "staff_users" ("id", "center_id", "role", "full_name", "login_username", "password_hash", "status")
       VALUES ($1::uuid, $2::uuid, 'TEACHER', 'Second Teacher S12', 'teacher2.s12', $3, 'ACTIVE')`,
      [teacher2Id, C.centerId, SYNTHETIC_PASSWORD_HASH],
    );

    const apiConfig = loadApiEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'error',
      API_HOST: '127.0.0.1',
      API_PORT: '3000',
      CENTER_ID: C.centerId,
      CENTER_SLUG: C.centerSlug,
      CENTER_TIMEZONE: 'Asia/Tashkent',
      LICENSE_MODE: 'ACTIVE',
      DATABASE_URL: env.apiRuntimeCenterAUrl,
      JWT_ACCESS_SECRET: 'TestOnly_JwtAccessSecret_AtLeast32CharsLong_01',
      JWT_REFRESH_SECRET: 'TestOnly_JwtRefreshSecret_AtLeast32CharsLong_02',
      INTERNAL_BOT_HMAC_SECRET: 'TestOnly_InternalBotHmacSecret_32CharsLong_03',
      TELEGRAM_WEBHOOK_SECRET: 'TestOnly_TelegramWebhookSecret_24',
    });

    app = await createApiApplication(apiConfig);
    clock = app.get(ClockService);
    attendanceService = app.get(AttendanceService);
    clock.setTestNow(new Date('2026-11-05T07:00:00.000Z'));

    await app.listen(0, '127.0.0.1');
    const addr = app.getHttpServer().address() as { port: number };
    port = Number(addr.port);

    await refreshTokens();
  });

  after(async () => {
    if (app) {
      await app.close();
    }
    if (env) {
      await env.cleanup();
    }
  });

  it('ATT-IT-01: enforces 12.01 Draft (GET with zero DB/outbox/invoice writes) vs Submitted (POST creating AttendanceRecord v1, AttendanceRevision #1, Lesson COMPLETED, and AttendanceSubmitted outbox) and suppresses phone/financial fields in Teacher DTOs', async () => {
    const fixture = await createIsolatedGroupAndLessons({
      lessonDates: ['2026-11-04'],
      students: [{ status: 'ACTIVE' }, { status: 'ACTIVE' }],
    });
    const lessonId = fixture.lessonIds[0];
    const stu1 = fixture.students[0].studentId;
    const stu2 = fixture.students[1].studentId;

    const draftRes = await httpJsonRequest({
      port,
      method: 'GET',
      path: `/api/v1/lessons/${lessonId}/attendance`,
      headers: { Authorization: `Bearer ${teacherToken}` },
    });
    assert.equal(draftRes.statusCode, 200);
    assert.equal(draftRes.json.is_submitted, false);
    assert.equal(draftRes.json.lesson_status, 'SCHEDULED');

    const draftRoster = draftRes.json.roster as Array<Record<string, unknown>>;
    assert.equal(draftRoster.length, 2);
    for (const item of draftRoster) {
      assert.equal(item.draft_default_status, 'PRESENT');
      assert.equal(item.submitted_status, null);
      assert.equal(item.attendance_record_id, null);
      assert.equal('phone_e164' in item, false);
      assert.equal('guardian_phone' in item, false);
      assert.equal('remaining_debt_uzs' in item, false);
      assert.equal('tariff_snapshot_uzs' in item, false);
    }

    const attCountBefore = await env.apiPoolA.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM "attendance_records" WHERE "center_id" = $1::uuid AND "lesson_id" = $2::uuid`,
      [C.centerId, lessonId],
    );
    assert.equal(attCountBefore.rows[0].cnt, '0');

    const outboxBefore = await env.apiPoolA.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM "outbox_events" WHERE "center_id" = $1::uuid AND "aggregate_id" = $2::uuid`,
      [C.centerId, lessonId],
    );
    assert.equal(outboxBefore.rows[0].cnt, '0');

    const opUuid = crypto.randomUUID();
    const submitRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: `/api/v1/lessons/${lessonId}/attendance/submit`,
      headers: {
        Authorization: `Bearer ${teacherToken}`,
        'Idempotency-Key': 'idem-s12-it01-submit',
      },
      body: {
        client_operation_uuid: opUuid,
        expected_version: 1,
        source_channel: 'TEACHER_WEB',
        records: [
          { student_id: stu1, status: 'PRESENT' },
          { student_id: stu2, status: 'LATE' },
        ],
      },
    });
    assert.equal(submitRes.statusCode, 200);
    assert.equal(submitRes.json.new_version, 1);
    const submittedRecords = submitRes.json.records as Array<Record<string, unknown>>;
    assert.equal(submittedRecords.length, 2);

    const r1 = submittedRecords.find((r) => r.student_id === stu1)!;
    const r2 = submittedRecords.find((r) => r.student_id === stu2)!;
    assert.equal(r1.status, 'PRESENT');
    assert.equal(r1.version, 1);
    assert.equal(r2.status, 'LATE');
    assert.equal(r2.version, 1);

    const afterGetRes = await httpJsonRequest({
      port,
      method: 'GET',
      path: `/api/v1/lessons/${lessonId}/attendance`,
      headers: { Authorization: `Bearer ${teacherToken}` },
    });
    assert.equal(afterGetRes.statusCode, 200);
    assert.equal(afterGetRes.json.is_submitted, true);
    assert.equal(afterGetRes.json.lesson_status, 'COMPLETED');

    const revRows = await env.apiPoolA.query<{ revision_version: number; new_status: string }>(
      `SELECT "revision_version", "new_status"::text AS new_status
         FROM "attendance_revisions"
        WHERE "center_id" = $1::uuid
          AND "attendance_record_id" IN ($2::uuid, $3::uuid)`,
      [C.centerId, String(r1.attendance_record_id), String(r2.attendance_record_id)],
    );
    assert.equal(revRows.rows.length, 2);
    assert.ok(revRows.rows.every((r) => r.revision_version === 1));

    const outboxAfter = await env.apiPoolA.query<{
      event_name: string;
      schema_version: number;
      payload_json: Record<string, unknown>;
    }>(
      `SELECT "event_name", "schema_version", "payload_json"
         FROM "outbox_events"
        WHERE "center_id" = $1::uuid
          AND "aggregate_type" = 'LessonOccurrence'
          AND "aggregate_id" = $2::uuid`,
      [C.centerId, lessonId],
    );
    assert.equal(outboxAfter.rows.length, 1);
    assert.equal(outboxAfter.rows[0].event_name, 'AttendanceSubmitted');
    assert.equal(outboxAfter.rows[0].schema_version, 1);
    assert.deepEqual(outboxAfter.rows[0].payload_json.late_student_ids, [stu2]);
  });

  it('ATT-IT-02: supports 2 lessons on the same day with independent (lesson_id, student_id) attendance_records', async () => {
    const fixture = await createIsolatedGroupAndLessons({
      lessonDates: ['2026-11-04', '2026-11-04'],
      startsTimes: ['09:00', '14:00'],
      occurrenceSeqs: [1, 2],
      students: [{ status: 'ACTIVE' }],
    });
    const [morningLessonId, afternoonLessonId] = fixture.lessonIds;
    const studentId = fixture.students[0].studentId;

    const morningRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: `/api/v1/lessons/${morningLessonId}/attendance/submit`,
      headers: {
        Authorization: `Bearer ${teacherToken}`,
        'Idempotency-Key': 'idem-s12-it02-morning',
      },
      body: {
        client_operation_uuid: crypto.randomUUID(),
        expected_version: 1,
        source_channel: 'TEACHER_WEB',
        records: [{ student_id: studentId, status: 'PRESENT' }],
      },
    });
    assert.equal(morningRes.statusCode, 200);

    const afternoonRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: `/api/v1/lessons/${afternoonLessonId}/attendance/submit`,
      headers: {
        Authorization: `Bearer ${teacherToken}`,
        'Idempotency-Key': 'idem-s12-it02-afternoon',
      },
      body: {
        client_operation_uuid: crypto.randomUUID(),
        expected_version: 1,
        source_channel: 'TEACHER_WEB',
        records: [{ student_id: studentId, status: 'ABSENT' }],
      },
    });
    assert.equal(afternoonRes.statusCode, 200);

    const morningRecords = morningRes.json.records as Array<Record<string, unknown>>;
    const afternoonRecords = afternoonRes.json.records as Array<Record<string, unknown>>;
    assert.equal(morningRecords[0].status, 'PRESENT');
    assert.equal(afternoonRecords[0].status, 'ABSENT');
    assert.notEqual(
      morningRecords[0].attendance_record_id,
      afternoonRecords[0].attendance_record_id,
    );
  });

  it('ATT-IT-03: enforces Teacher & single-lesson Substitute scope, blocks revoked substitute replay (403 FORBIDDEN_OBJECT_SCOPE), and isolates Center B (404)', async () => {
    const fixture = await createIsolatedGroupAndLessons({
      lessonDates: ['2026-11-04', '2026-11-05'],
      students: [{ status: 'ACTIVE' }],
      primaryTeacherId: C.teacherId,
    });
    const [lesson1Id, lesson2Id] = fixture.lessonIds;
    const studentId = fixture.students[0].studentId;

    const deniedGet = await httpJsonRequest({
      port,
      method: 'GET',
      path: `/api/v1/lessons/${lesson1Id}/attendance`,
      headers: { Authorization: `Bearer ${teacher2Token}` },
    });
    assert.equal(deniedGet.statusCode, 403);
    assert.equal(deniedGet.json.error_code, 'FORBIDDEN_OBJECT_SCOPE');

    const deniedPost = await httpJsonRequest({
      port,
      method: 'POST',
      path: `/api/v1/lessons/${lesson1Id}/attendance/submit`,
      headers: {
        Authorization: `Bearer ${teacher2Token}`,
        'Idempotency-Key': 'idem-s12-it03-unassigned',
      },
      body: {
        client_operation_uuid: crypto.randomUUID(),
        expected_version: 1,
        source_channel: 'TEACHER_WEB',
        records: [{ student_id: studentId, status: 'PRESENT' }],
      },
    });
    assert.equal(deniedPost.statusCode, 403);
    assert.equal(deniedPost.json.error_code, 'FORBIDDEN_OBJECT_SCOPE');

    const subAssignmentId = crypto.randomUUID();
    await env.apiPoolA.query(
      `INSERT INTO "substitute_assignments" (
         "id", "center_id", "lesson_id", "original_teacher_id", "substitute_teacher_id",
         "assigned_by_admin_id", "status", "version"
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
         $6::uuid, 'ACTIVE', 1
       )`,
      [subAssignmentId, C.centerId, lesson1Id, C.teacherId, teacher2Id, C.adminId],
    );

    const subOpUuid = crypto.randomUUID();
    const subSubmit1 = await httpJsonRequest({
      port,
      method: 'POST',
      path: `/api/v1/lessons/${lesson1Id}/attendance/submit`,
      headers: {
        Authorization: `Bearer ${teacher2Token}`,
        'Idempotency-Key': 'idem-s12-it03-sub-lesson1',
      },
      body: {
        client_operation_uuid: subOpUuid,
        expected_version: 1,
        source_channel: 'TEACHER_WEB',
        records: [{ student_id: studentId, status: 'PRESENT' }],
      },
    });
    assert.equal(subSubmit1.statusCode, 200);

    const subSubmit2 = await httpJsonRequest({
      port,
      method: 'POST',
      path: `/api/v1/lessons/${lesson2Id}/attendance/submit`,
      headers: {
        Authorization: `Bearer ${teacher2Token}`,
        'Idempotency-Key': 'idem-s12-it03-sub-lesson2',
      },
      body: {
        client_operation_uuid: crypto.randomUUID(),
        expected_version: 1,
        source_channel: 'TEACHER_WEB',
        records: [{ student_id: studentId, status: 'PRESENT' }],
      },
    });
    assert.equal(subSubmit2.statusCode, 403);
    assert.equal(subSubmit2.json.error_code, 'FORBIDDEN_OBJECT_SCOPE');

    await env.apiPoolA.query(
      `UPDATE "substitute_assignments"
          SET "status" = 'CANCELLED',
              "version" = "version" + 1
        WHERE "id" = $1::uuid AND "center_id" = $2::uuid`,
      [subAssignmentId, C.centerId],
    );

    const revokedReplay = await httpJsonRequest({
      port,
      method: 'POST',
      path: `/api/v1/lessons/${lesson1Id}/attendance/submit`,
      headers: {
        Authorization: `Bearer ${teacher2Token}`,
        'Idempotency-Key': 'idem-s12-it03-sub-lesson1',
      },
      body: {
        client_operation_uuid: subOpUuid,
        expected_version: 1,
        source_channel: 'TEACHER_WEB',
        records: [{ student_id: studentId, status: 'PRESENT' }],
      },
    });
    assert.equal(revokedReplay.statusCode, 403);
    assert.equal(revokedReplay.json.error_code, 'FORBIDDEN_OBJECT_SCOPE');

    const crossGet = await httpJsonRequest({
      port,
      method: 'GET',
      path: `/api/v1/lessons/${CB.lessonId}/attendance`,
      headers: { Authorization: `Bearer ${directorToken}` },
    });
    assert.equal(crossGet.statusCode, 404);
  });

  it('ATT-IT-04: enforces 12.03 CASE-21 conflict rules (Stale Excel 409 STALE_EXCEL_CONFLICT, Teacher overwrite 409, reason-required ADMIN_OVERRIDE with AttendanceRevision #2 and AttendanceCorrected outbox)', async () => {
    const fixture = await createIsolatedGroupAndLessons({
      lessonDates: ['2026-11-04'],
      students: [{ status: 'ACTIVE' }],
    });
    const lessonId = fixture.lessonIds[0];
    const studentId = fixture.students[0].studentId;

    const teacherRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: `/api/v1/lessons/${lessonId}/attendance/submit`,
      headers: {
        Authorization: `Bearer ${teacherToken}`,
        'Idempotency-Key': 'idem-s12-it04-tch-1',
      },
      body: {
        client_operation_uuid: crypto.randomUUID(),
        expected_version: 1,
        source_channel: 'TEACHER_WEB',
        records: [{ student_id: studentId, status: 'PRESENT' }],
      },
    });
    assert.equal(teacherRes.statusCode, 200);

    const staleExcelRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: `/api/v1/lessons/${lessonId}/attendance/submit`,
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': 'idem-s12-it04-stale-excel',
      },
      body: {
        client_operation_uuid: crypto.randomUUID(),
        expected_version: 1,
        source_channel: 'ADMIN_EXCEL',
        records: [{ student_id: studentId, status: 'ABSENT' }],
      },
    });
    assert.equal(staleExcelRes.statusCode, 409);
    assert.equal(staleExcelRes.json.error_code, 'STALE_EXCEL_CONFLICT');

    const checkAfterExcel = await httpJsonRequest({
      port,
      method: 'GET',
      path: `/api/v1/lessons/${lessonId}/attendance`,
      headers: { Authorization: `Bearer ${teacherToken}` },
    });
    const rosterAfterExcel = checkAfterExcel.json.roster as Array<Record<string, unknown>>;
    assert.equal(rosterAfterExcel[0].submitted_status, 'PRESENT');
    assert.equal(rosterAfterExcel[0].record_version, 1);

    const teacherOverwriteRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: `/api/v1/lessons/${lessonId}/attendance/submit`,
      headers: {
        Authorization: `Bearer ${teacherToken}`,
        'Idempotency-Key': 'idem-s12-it04-tch-overwrite',
      },
      body: {
        client_operation_uuid: crypto.randomUUID(),
        expected_version: 1,
        source_channel: 'TEACHER_WEB',
        records: [{ student_id: studentId, status: 'ABSENT' }],
      },
    });
    assert.equal(teacherOverwriteRes.statusCode, 409);
    assert.equal(teacherOverwriteRes.json.error_code, 'VERSION_CONFLICT');

    const teacherFakeAdminRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: `/api/v1/lessons/${lessonId}/attendance/submit`,
      headers: {
        Authorization: `Bearer ${teacherToken}`,
        'Idempotency-Key': 'idem-s12-it04-tch-fake-admin',
      },
      body: {
        client_operation_uuid: crypto.randomUUID(),
        expected_version: 1,
        source_channel: 'ADMIN_OVERRIDE',
        override_reason: 'Teacher trying admin override',
        records: [{ student_id: studentId, status: 'ABSENT' }],
      },
    });
    assert.equal(teacherFakeAdminRes.statusCode, 403);
    assert.equal(teacherFakeAdminRes.json.error_code, 'FORBIDDEN_ROLE');

    const staleVerAdminRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: `/api/v1/lessons/${lessonId}/attendance/submit`,
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': 'idem-s12-it04-adm-stale-ver',
      },
      body: {
        client_operation_uuid: crypto.randomUUID(),
        expected_version: 99,
        source_channel: 'ADMIN_OVERRIDE',
        override_reason: 'Parent confirmed absence by phone',
        records: [{ student_id: studentId, status: 'ABSENT' }],
      },
    });
    assert.equal(staleVerAdminRes.statusCode, 409);
    assert.equal(staleVerAdminRes.json.error_code, 'VERSION_CONFLICT');

    const validAdminRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: `/api/v1/lessons/${lessonId}/attendance/submit`,
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': 'idem-s12-it04-adm-valid',
      },
      body: {
        client_operation_uuid: crypto.randomUUID(),
        expected_version: 1,
        source_channel: 'ADMIN_OVERRIDE',
        override_reason: 'Parent provided medical certificate #MED-21',
        records: [{ student_id: studentId, status: 'ABSENT' }],
      },
    });
    assert.equal(validAdminRes.statusCode, 200);
    assert.equal(validAdminRes.json.new_version, 2);
    const updatedRecords = validAdminRes.json.records as Array<Record<string, unknown>>;
    assert.equal(updatedRecords[0].status, 'ABSENT');
    assert.equal(updatedRecords[0].source_channel, 'ADMIN_OVERRIDE');
    assert.equal(updatedRecords[0].version, 2);

    const attendanceRecordId = String(updatedRecords[0].attendance_record_id);
    const revisions = await env.apiPoolA.query<{
      revision_version: number;
      previous_status: string | null;
      new_status: string;
      source_channel: string;
      reason: string | null;
    }>(
      `SELECT "revision_version",
              "previous_status"::text AS previous_status,
              "new_status"::text AS new_status,
              "source_channel"::text AS source_channel,
              "reason"
         FROM "attendance_revisions"
        WHERE "center_id" = $1::uuid
          AND "attendance_record_id" = $2::uuid
        ORDER BY "revision_version" ASC`,
      [C.centerId, attendanceRecordId],
    );
    assert.equal(revisions.rows.length, 2);
    assert.equal(revisions.rows[0].revision_version, 1);
    assert.equal(revisions.rows[0].previous_status, null);
    assert.equal(revisions.rows[0].new_status, 'PRESENT');
    assert.equal(revisions.rows[1].revision_version, 2);
    assert.equal(revisions.rows[1].previous_status, 'PRESENT');
    assert.equal(revisions.rows[1].new_status, 'ABSENT');
    assert.equal(revisions.rows[1].source_channel, 'ADMIN_OVERRIDE');
    assert.equal(revisions.rows[1].reason, 'Parent provided medical certificate #MED-21');

    const correctedOutbox = await env.apiPoolA.query<{ event_name: string }>(
      `SELECT "event_name"
         FROM "outbox_events"
        WHERE "center_id" = $1::uuid
          AND "aggregate_type" = 'AttendanceRecord'
          AND "aggregate_id" = $2::uuid
          AND "event_name" = 'AttendanceCorrected'`,
      [C.centerId, attendanceRecordId],
    );
    assert.equal(correctedOutbox.rows.length, 1);
  });

  it('ATT-IT-05: integrates 12.04 Trial Lesson 1 (0 debt) -> Lesson 2 conversion (1 TrialActivation + 1 Invoice from first_trial_date — CASE-05, CASE-06)', async () => {
    const fixture = await createIsolatedGroupAndLessons({
      lessonDates: ['2026-11-02', '2026-11-04'],
      students: [
        { status: 'TRIAL', enrolledAtDate: '2026-11-01' },
        { status: 'TRIAL', enrolledAtDate: '2026-11-01' },
      ],
    });
    const [lesson1Id, lesson2Id] = fixture.lessonIds;
    const trialStudentConvert = fixture.students[0];
    const trialStudentAbsentOn2nd = fixture.students[1];

    const lesson1Res = await httpJsonRequest({
      port,
      method: 'POST',
      path: `/api/v1/lessons/${lesson1Id}/attendance/submit`,
      headers: {
        Authorization: `Bearer ${teacherToken}`,
        'Idempotency-Key': 'idem-s12-it05-lesson1',
      },
      body: {
        client_operation_uuid: crypto.randomUUID(),
        expected_version: 1,
        source_channel: 'TEACHER_WEB',
        records: [
          { student_id: trialStudentConvert.studentId, status: 'PRESENT' },
          { student_id: trialStudentAbsentOn2nd.studentId, status: 'PRESENT' },
        ],
      },
    });
    assert.equal(lesson1Res.statusCode, 200);
    assert.equal(lesson1Res.json.trial_activations_triggered, 0);

    const invAfterLesson1 = await env.apiPoolA.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM "invoices" WHERE "center_id" = $1::uuid AND "student_id" IN ($2::uuid, $3::uuid)`,
      [C.centerId, trialStudentConvert.studentId, trialStudentAbsentOn2nd.studentId],
    );
    assert.equal(invAfterLesson1.rows[0].cnt, '0');

    const lesson2Res = await httpJsonRequest({
      port,
      method: 'POST',
      path: `/api/v1/lessons/${lesson2Id}/attendance/submit`,
      headers: {
        Authorization: `Bearer ${teacherToken}`,
        'Idempotency-Key': 'idem-s12-it05-lesson2',
      },
      body: {
        client_operation_uuid: crypto.randomUUID(),
        expected_version: 1,
        source_channel: 'TEACHER_WEB',
        records: [
          { student_id: trialStudentConvert.studentId, status: 'PRESENT' },
          { student_id: trialStudentAbsentOn2nd.studentId, status: 'ABSENT' },
        ],
      },
    });
    assert.equal(lesson2Res.statusCode, 200);
    assert.equal(lesson2Res.json.trial_activations_triggered, 1);
    assert.equal((lesson2Res.json.activated_invoice_ids as unknown[]).length, 1);

    const enrCheck = await env.apiPoolA.query<{
      id: string;
      status: string;
      first_trial_date: string | null;
    }>(
      `SELECT "id"::text AS id, "status"::text AS status, "first_trial_date"::text AS first_trial_date
         FROM "enrollments"
        WHERE "center_id" = $1::uuid
          AND "id" IN ($2::uuid, $3::uuid)`,
      [C.centerId, trialStudentConvert.enrollmentId, trialStudentAbsentOn2nd.enrollmentId],
    );
    const enr1 = enrCheck.rows.find((r) => r.id === trialStudentConvert.enrollmentId)!;
    const enr2 = enrCheck.rows.find((r) => r.id === trialStudentAbsentOn2nd.enrollmentId)!;
    assert.equal(enr1.status, 'ACTIVE');
    assert.equal(enr1.first_trial_date, '2026-11-02');
    assert.equal(enr2.status, 'TRIAL');
    assert.equal(enr2.first_trial_date, '2026-11-02');

    const invoiceRows = await env.apiPoolA.query<{
      student_id: string;
      effective_net_charge_uzs: string;
    }>(
      `SELECT "student_id"::text AS student_id,
              "effective_net_charge_uzs"::text AS effective_net_charge_uzs
         FROM "invoices"
        WHERE "center_id" = $1::uuid
          AND "student_id" IN ($2::uuid, $3::uuid)`,
      [C.centerId, trialStudentConvert.studentId, trialStudentAbsentOn2nd.studentId],
    );
    assert.equal(invoiceRows.rows.length, 1);
    assert.equal(invoiceRows.rows[0].student_id, trialStudentConvert.studentId);
    assert.ok(BigInt(invoiceRows.rows[0].effective_net_charge_uzs) > 0n);
  });

  it('ATT-IT-06: processes 12.02 offline batch sync (ACK_COMMITTED, ACK_IDEMPOTENT_REPLAY, CONFLICT_409, FORBIDDEN_PERMISSION_REVOKED, and payload mismatch)', async () => {
    const fixture = await createIsolatedGroupAndLessons({
      lessonDates: ['2026-11-02', '2026-11-04', '2026-11-05'],
      students: [{ status: 'ACTIVE' }],
      primaryTeacherId: C.teacherId,
    });
    const [lesson1Id, lesson2Id, lesson3Id] = fixture.lessonIds;
    const studentId = fixture.students[0].studentId;

    const preConfirmRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: `/api/v1/lessons/${lesson2Id}/attendance/submit`,
      headers: {
        Authorization: `Bearer ${teacherToken}`,
        'Idempotency-Key': 'idem-s12-it06-preconfirm',
      },
      body: {
        client_operation_uuid: crypto.randomUUID(),
        expected_version: 1,
        source_channel: 'TEACHER_WEB',
        records: [{ student_id: studentId, status: 'PRESENT' }],
      },
    });
    assert.equal(preConfirmRes.statusCode, 200);

    await env.apiPoolA.query(
      `INSERT INTO "substitute_assignments" (
         "id", "center_id", "lesson_id", "original_teacher_id", "substitute_teacher_id",
         "assigned_by_admin_id", "status", "version"
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
         $6::uuid, 'ACTIVE', 1
       )`,
      [crypto.randomUUID(), C.centerId, lesson3Id, C.teacherId, teacher2Id, C.adminId],
    );

    const op1Uuid = crypto.randomUUID();
    const op2Uuid = crypto.randomUUID();
    const op3Uuid = crypto.randomUUID();

    const syncRes1 = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/attendance/offline-sync',
      headers: {
        Authorization: `Bearer ${teacherToken}`,
        'Idempotency-Key': 'idem-s12-it06-batch-1',
      },
      body: {
        operations: [
          {
            client_operation_uuid: op1Uuid,
            lesson_id: lesson1Id,
            expected_version: 1,
            source_channel: 'TEACHER_MOBILE',
            records: [{ student_id: studentId, status: 'LATE' }],
          },
          {
            client_operation_uuid: op2Uuid,
            lesson_id: lesson2Id,
            expected_version: 1,
            source_channel: 'TEACHER_MOBILE',
            records: [{ student_id: studentId, status: 'ABSENT' }],
          },
          {
            client_operation_uuid: op3Uuid,
            lesson_id: lesson3Id,
            expected_version: 1,
            source_channel: 'TEACHER_MOBILE',
            records: [{ student_id: studentId, status: 'PRESENT' }],
          },
        ],
      },
    });
    assert.equal(syncRes1.statusCode, 200);
    const results1 = syncRes1.json.results as Array<Record<string, unknown>>;
    assert.equal(results1.length, 3);
    assert.equal(results1[0].ack_status, 'ACK_COMMITTED');
    assert.equal(results1[1].ack_status, 'CONFLICT_409');
    assert.equal(results1[1].error_code, 'VERSION_CONFLICT');
    assert.equal(results1[2].ack_status, 'FORBIDDEN_PERMISSION_REVOKED');
    assert.equal(results1[2].error_code, 'FORBIDDEN_OBJECT_SCOPE');

    const syncReplayRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/attendance/offline-sync',
      headers: {
        Authorization: `Bearer ${teacherToken}`,
        'Idempotency-Key': 'idem-s12-it06-batch-replay',
      },
      body: {
        operations: [
          {
            client_operation_uuid: op1Uuid,
            lesson_id: lesson1Id,
            expected_version: 1,
            source_channel: 'TEACHER_MOBILE',
            records: [{ student_id: studentId, status: 'LATE' }],
          },
        ],
      },
    });
    assert.equal(syncReplayRes.statusCode, 200);
    const replayResults = syncReplayRes.json.results as Array<Record<string, unknown>>;
    assert.equal(replayResults[0].ack_status, 'ACK_IDEMPOTENT_REPLAY');

    const syncMismatchRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/attendance/offline-sync',
      headers: {
        Authorization: `Bearer ${teacherToken}`,
        'Idempotency-Key': 'idem-s12-it06-batch-mismatch',
      },
      body: {
        operations: [
          {
            client_operation_uuid: op1Uuid,
            lesson_id: lesson1Id,
            expected_version: 1,
            source_channel: 'TEACHER_MOBILE',
            records: [{ student_id: studentId, status: 'ABSENT' }],
          },
        ],
      },
    });
    assert.equal(syncMismatchRes.statusCode, 200);
    const mismatchResults = syncMismatchRes.json.results as Array<Record<string, unknown>>;
    assert.equal(mismatchResults[0].ack_status, 'CONFLICT_409');
    assert.equal(mismatchResults[0].error_code, 'IDEMPOTENCY_PAYLOAD_MISMATCH');
  });

  it('ATT-IT-07: enforces roster completeness, FROZEN student is_excused_frozen tracking, and 403 POLICY_DECISION_NOT_CONFIRMED on unconfirmed trial compensation', async () => {
    const fixture = await createIsolatedGroupAndLessons({
      lessonDates: ['2026-11-04'],
      students: [
        { status: 'ACTIVE', enrolledAtDate: '2026-11-01' },
        { status: 'FROZEN', enrolledAtDate: '2026-11-01' },
      ],
    });
    const lessonId = fixture.lessonIds[0];
    const [stu1, stu2] = fixture.students;

    const partialRosterRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: `/api/v1/lessons/${lessonId}/attendance/submit`,
      headers: {
        Authorization: `Bearer ${teacherToken}`,
        'Idempotency-Key': 'idem-s12-it07-partial',
      },
      body: {
        client_operation_uuid: crypto.randomUUID(),
        expected_version: 1,
        source_channel: 'TEACHER_WEB',
        records: [{ student_id: stu1.studentId, status: 'PRESENT' }],
      },
    });
    assert.equal(partialRosterRes.statusCode, 422);
    assert.equal(partialRosterRes.json.error_code, 'VALIDATION_ERROR');

    const unconfirmedPolicyRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: `/api/v1/lessons/${lessonId}/attendance/submit`,
      headers: {
        Authorization: `Bearer ${teacherToken}`,
        'Idempotency-Key': 'idem-s12-it07-policy',
      },
      body: {
        client_operation_uuid: crypto.randomUUID(),
        expected_version: 1,
        source_channel: 'TEACHER_WEB',
        auto_compensate_trial_invoice: true,
        records: [
          { student_id: stu1.studentId, status: 'PRESENT' },
          { student_id: stu2.studentId, status: 'ABSENT' },
        ],
      },
    });
    assert.equal(unconfirmedPolicyRes.statusCode, 403);
    assert.equal(unconfirmedPolicyRes.json.error_code, 'POLICY_DECISION_NOT_CONFIRMED');

    const fullSubmitRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: `/api/v1/lessons/${lessonId}/attendance/submit`,
      headers: {
        Authorization: `Bearer ${teacherToken}`,
        'Idempotency-Key': 'idem-s12-it07-full',
      },
      body: {
        client_operation_uuid: crypto.randomUUID(),
        expected_version: 1,
        source_channel: 'TEACHER_WEB',
        records: [
          { student_id: stu1.studentId, status: 'PRESENT' },
          { student_id: stu2.studentId, status: 'ABSENT' },
        ],
      },
    });
    assert.equal(fullSubmitRes.statusCode, 200);
    const records = fullSubmitRes.json.records as Array<Record<string, unknown>>;
    const frozenRec = records.find((r) => r.student_id === stu2.studentId)!;
    assert.equal(frozenRec.is_excused_frozen, true);
  });

  it('ATT-IT-08: serializes concurrent 2-worker attendance submit and concurrent 2-Admin override races without lost updates or duplicate revisions', async () => {
    const fixture = await createIsolatedGroupAndLessons({
      lessonDates: ['2026-11-04'],
      students: [{ status: 'ACTIVE' }],
    });
    const lessonId = fixture.lessonIds[0];
    const studentId = fixture.students[0].studentId;

    const [raceA, raceB] = await Promise.all([
      httpJsonRequest({
        port,
        method: 'POST',
        path: `/api/v1/lessons/${lessonId}/attendance/submit`,
        headers: {
          Authorization: `Bearer ${teacherToken}`,
          'Idempotency-Key': 'idem-s12-it08-race-a',
        },
        body: {
          client_operation_uuid: crypto.randomUUID(),
          expected_version: 1,
          source_channel: 'TEACHER_WEB',
          records: [{ student_id: studentId, status: 'PRESENT' }],
        },
      }),
      httpJsonRequest({
        port,
        method: 'POST',
        path: `/api/v1/lessons/${lessonId}/attendance/submit`,
        headers: {
          Authorization: `Bearer ${teacherToken}`,
          'Idempotency-Key': 'idem-s12-it08-race-b',
        },
        body: {
          client_operation_uuid: crypto.randomUUID(),
          expected_version: 1,
          source_channel: 'TEACHER_MOBILE',
          records: [{ student_id: studentId, status: 'LATE' }],
        },
      }),
    ]);

    const raceStatuses = [raceA.statusCode, raceB.statusCode].sort((a, b) => a - b);
    assert.deepEqual(raceStatuses, [200, 409]);

    const [overrideA, overrideB] = await Promise.all([
      httpJsonRequest({
        port,
        method: 'POST',
        path: `/api/v1/lessons/${lessonId}/attendance/submit`,
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Idempotency-Key': 'idem-s12-it08-ovr-a',
        },
        body: {
          client_operation_uuid: crypto.randomUUID(),
          expected_version: 1,
          source_channel: 'ADMIN_OVERRIDE',
          override_reason: 'Admin override A',
          records: [{ student_id: studentId, status: 'LATE' }],
        },
      }),
      httpJsonRequest({
        port,
        method: 'POST',
        path: `/api/v1/lessons/${lessonId}/attendance/submit`,
        headers: {
          Authorization: `Bearer ${directorToken}`,
          'Idempotency-Key': 'idem-s12-it08-ovr-b',
        },
        body: {
          client_operation_uuid: crypto.randomUUID(),
          expected_version: 1,
          source_channel: 'ADMIN_OVERRIDE',
          override_reason: 'Director override B',
          records: [{ student_id: studentId, status: 'ABSENT' }],
        },
      }),
    ]);

    const overrideStatuses = [overrideA.statusCode, overrideB.statusCode].sort((a, b) => a - b);
    assert.deepEqual(overrideStatuses, [200, 409]);
  });

  it('ATT-IT-09: proves atomic rollback across every AttendanceService write step (ATTENDANCE_RECORD_WRITE, ATTENDANCE_REVISION_INSERT, TRIAL_EVALUATION, AUDIT_LOG, OUTBOX_EVENT)', async () => {
    const fixture = await createIsolatedGroupAndLessons({
      lessonDates: ['2026-11-02', '2026-11-04'],
      students: [{ status: 'TRIAL', enrolledAtDate: '2026-11-01' }],
    });
    const [lesson1Id, lesson2Id] = fixture.lessonIds;
    const trialStu = fixture.students[0];

    const lesson1Res = await httpJsonRequest({
      port,
      method: 'POST',
      path: `/api/v1/lessons/${lesson1Id}/attendance/submit`,
      headers: {
        Authorization: `Bearer ${teacherToken}`,
        'Idempotency-Key': 'idem-s12-it09-lesson1',
      },
      body: {
        client_operation_uuid: crypto.randomUUID(),
        expected_version: 1,
        source_channel: 'TEACHER_WEB',
        records: [{ student_id: trialStu.studentId, status: 'PRESENT' }],
      },
    });
    assert.equal(lesson1Res.statusCode, 200);

    const teacherPrincipal: AuthenticatedStaffPrincipal = {
      staffId: C.teacherId,
      centerId: C.centerId,
      role: 'TEACHER',
      sessionId: crypto.randomUUID(),
      familyId: crypto.randomUUID(),
      centerSlug: C.centerSlug,
      staffVersion: 1,
      mustChangePassword: false,
      transportMode: 'BEARER',
      csrfTokenHash: null,
      licenseMode: 'ACTIVE',
    };

    for (const step of [
      'ATTENDANCE_RECORD_WRITE',
      'ATTENDANCE_REVISION_INSERT',
      'TRIAL_EVALUATION',
      'AUDIT_LOG',
      'OUTBOX_EVENT',
    ] as const) {
      const mockReq = {
        headers: {
          'idempotency-key': `idem-s12-fault-${step}`,
          'x-request-id': `req-s12-fault-${step}`,
        },
        requestId: `req-s12-fault-${step}`,
      } as unknown as RequestWithCorrelationId;

      await assert.rejects(
        () =>
          attendanceService.submitLessonAttendance(
            mockReq,
            teacherPrincipal,
            lesson2Id,
            {
              client_operation_uuid: crypto.randomUUID(),
              expected_version: 1,
              source_channel: 'TEACHER_WEB',
              records: [{ student_id: trialStu.studentId, status: 'PRESENT' }],
            },
            { testFaultAfterStep: step },
          ),
        new RegExp(`SIMULATED_S12_ATTENDANCE_FAULT_AFTER_${step}`),
      );

      const attCount = await env.apiPoolA.query<{ cnt: string }>(
        `SELECT COUNT(*)::text AS cnt FROM "attendance_records" WHERE "center_id" = $1::uuid AND "lesson_id" = $2::uuid`,
        [C.centerId, lesson2Id],
      );
      assert.equal(attCount.rows[0].cnt, '0');

      const invCount = await env.apiPoolA.query<{ cnt: string }>(
        `SELECT COUNT(*)::text AS cnt FROM "invoices" WHERE "center_id" = $1::uuid AND "student_id" = $2::uuid`,
        [C.centerId, trialStu.studentId],
      );
      assert.equal(invCount.rows[0].cnt, '0');

      const enrRow = await env.apiPoolA.query<{ status: string }>(
        `SELECT "status"::text AS status FROM "enrollments" WHERE "id" = $1::uuid AND "center_id" = $2::uuid`,
        [trialStu.enrollmentId, C.centerId],
      );
      assert.equal(enrRow.rows[0].status, 'TRIAL');
    }
  });

  it('ATT-IT-10: verifies PostgreSQL 42501 append-only immutability on attendance_revisions (trg_immutable_attendance_revisions)', async () => {
    const revRow = await env.apiPoolA.query<{ id: string }>(
      `SELECT "id"::text AS id FROM "attendance_revisions" WHERE "center_id" = $1::uuid LIMIT 1`,
      [C.centerId],
    );
    assert.equal(revRow.rows.length, 1);
    const revId = revRow.rows[0].id;

    for (const sql of [
      `UPDATE "attendance_revisions" SET "new_status" = 'ABSENT' WHERE "id" = '${revId}'::uuid`,
      `DELETE FROM "attendance_revisions" WHERE "id" = '${revId}'::uuid`,
    ]) {
      await assert.rejects(
        () => env.apiPoolA.query(sql),
        (err: unknown) => (err as { code?: string }).code === '42501',
      );
    }
  });
});
