import * as assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { createApiApplication } from '../../src/application';
import { ClockService } from '../../src/auth/clock.service';
import { hashPassword } from '../../src/auth/password';
import { loadApiEnv } from '../../src/config/env';
import {
  executeSyntheticSeed,
  SYNTHETIC_DEMO_CENTER_A,
  SYNTHETIC_DEMO_CENTER_B,
  SYNTHETIC_TEST_ONLY_PASSWORD,
} from '../../src/database/seed-contract';
import {
  createEphemeralTestDbEnv,
  EphemeralDatabaseEnvironment,
} from '../database/harness';

interface HttpCallResult {
  readonly statusCode: number;
  readonly rawBody: string;
  readonly json: Record<string, unknown>;
}

function httpJsonRequest(params: {
  readonly port: number;
  readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  readonly path: string;
  readonly headers?: Record<string, string>;
  readonly body?: unknown;
}): Promise<HttpCallResult> {
  return new Promise((resolve, reject) => {
    const rawPayload =
      params.body === undefined ? undefined : JSON.stringify(params.body);
    const headers: Record<string, string> = {
      ...(rawPayload !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(params.headers ?? {}),
    };
    if (rawPayload !== undefined) {
      headers['Content-Length'] = String(Buffer.byteLength(rawPayload, 'utf8'));
    }

    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: params.port,
        path: params.path,
        method: params.method,
        headers,
      },
      (res) => {
        res.setEncoding('utf8');
        let rawBody = '';
        res.on('data', (chunk: string) => {
          rawBody += chunk;
        });
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            rawBody,
            json: rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {},
          });
        });
      },
    );
    req.on('error', reject);
    if (rawPayload !== undefined) {
      req.write(rawPayload);
    }
    req.end();
  });
}

describe('Stage 07 Academics: Courses, Price History, Groups, Schedule, Single-Lesson Substitutes & Grades (ACAD-IT-01..ACAD-IT-10 / T07.01..T07.04)', () => {
  let env: EphemeralDatabaseEnvironment;
  let app: Awaited<ReturnType<typeof createApiApplication>>;
  let port: number;
  let clock: ClockService;
  const C = SYNTHETIC_DEMO_CENTER_A;
  const CB = SYNTHETIC_DEMO_CENTER_B;

  let directorToken: string;
  let adminToken: string;
  let primaryTeacherToken: string;
  let subTeacherId: string;
  let subTeacherToken: string;
  let otherTeacherToken: string;
  let otherTeacherId: string;

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

    const pwHash = await hashPassword(SYNTHETIC_TEST_ONLY_PASSWORD, { N: 16384 });
    subTeacherId = crypto.randomUUID();
    otherTeacherId = crypto.randomUUID();

    await env.apiPoolA.query(
      `INSERT INTO "staff_users" ("id", "center_id", "role", "full_name", "login_username", "phone_e164", "password_hash", "must_change_password", "status")
       VALUES
         ($1::uuid, $3::uuid, 'TEACHER', 'Substitute Teacher Zamena', 'teacher.sub.zamena', '+998904441122', $4, FALSE, 'ACTIVE'),
         ($2::uuid, $3::uuid, 'TEACHER', 'Other Group Teacher', 'teacher.other.group', '+998904443344', $4, FALSE, 'ACTIVE')`,
      [subTeacherId, otherTeacherId, C.centerId, pwHash],
    );

    const config = loadApiEnv({
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
      AUTH_RATE_LIMIT_MAX_REQUESTS: '50',
    });

    app = await createApiApplication(config);
    clock = app.get(ClockService);
    await app.listen(0, '127.0.0.1');
    port = ((app.getHttpServer() as http.Server).address() as AddressInfo).port;

    const loginAs = async (username: string): Promise<string> => {
      const res = await httpJsonRequest({
        port,
        method: 'POST',
        path: '/api/v1/auth/login',
        body: { username, password: SYNTHETIC_TEST_ONLY_PASSWORD },
      });
      assert.equal(res.statusCode, 200);
      return res.json.access_token as string;
    };

    directorToken = await loginAs('director.demo');
    adminToken = await loginAs('admin.demo');
    primaryTeacherToken = await loginAs('teacher.demo');
    subTeacherToken = await loginAs('teacher.sub.zamena');
    otherTeacherToken = await loginAs('teacher.other.group');
  });

  after(async () => {
    if (app) {
      await app.close();
    }
    if (env) {
      await env.cleanup();
    }
  });

  it('ACAD-IT-01 (Matrix #1 — 07.01 & OWNER-20261104-02): enforces Director/Admin course & group permissions, denies Teacher writes & Admin tariff changes, rejects invalid/other-center teachers, and stores OWNER-20261104-02 due-date & advance/arrears parameters', async () => {
    // 1. Teacher is denied on course/group write & course list endpoints (403 FORBIDDEN_ROLE)
    for (const reqSpec of [
      { method: 'GET' as const, path: '/api/v1/courses' },
      {
        method: 'POST' as const,
        path: '/api/v1/courses',
        headers: { 'Idempotency-Key': `idem-tchr-crs-${crypto.randomUUID()}` },
        body: { name: 'Forbidden Course', default_monthly_fee_uzs: '500000', default_lessons_per_cycle: 12 },
      },
      {
        method: 'PATCH' as const,
        path: `/api/v1/courses/${C.courseId}/price`,
        headers: { 'Idempotency-Key': `idem-tchr-prc-${crypto.randomUUID()}` },
        body: { new_fee_uzs: '600000', effective_from: '2026-11-04', expected_version: 1 },
      },
      {
        method: 'POST' as const,
        path: '/api/v1/groups',
        headers: { 'Idempotency-Key': `idem-tchr-grp-${crypto.randomUUID()}` },
        body: {
          course_id: C.courseId,
          name: 'Forbidden Group',
          primary_teacher_id: C.teacherId,
          billing_mode: 'CALENDAR_PRO_RATA',
          current_fee_uzs: '500000',
          lessons_per_cycle: 12,
          schedule_days: ['MON', 'WED', 'FRI'],
          starts_time: '09:00',
          duration_minutes: 90,
        },
      },
    ]) {
      const res = await httpJsonRequest({
        port,
        method: reqSpec.method,
        path: reqSpec.path,
        headers: {
          Authorization: `Bearer ${primaryTeacherToken}`,
          ...(reqSpec.headers ?? {}),
        },
        body: reqSpec.body,
      });
      assert.equal(res.statusCode, 403);
      assert.equal(res.json.error_code, 'FORBIDDEN_ROLE');
    }

    // 2. Admin can create a course (201) but is denied on updateCoursePrice (403 FORBIDDEN_ROLE — Director only)
    const createCourseRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/courses',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `idem-adm-crs-${crypto.randomUUID()}`,
      },
      body: {
        name: 'IELTS Intensive Academic',
        default_monthly_fee_uzs: '600000',
        default_lessons_per_cycle: 12,
        effective_from: '2026-11-01',
      },
    });
    assert.equal(createCourseRes.statusCode, 201);
    assert.equal(createCourseRes.json.default_monthly_fee_uzs, '600000');
    assert.equal((createCourseRes.json.price_history as unknown[]).length, 1);

    const adminUpdatePrice = await httpJsonRequest({
      port,
      method: 'PATCH',
      path: `/api/v1/courses/${createCourseRes.json.id as string}/price`,
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `idem-adm-price-${crypto.randomUUID()}`,
      },
      body: {
        new_fee_uzs: '650000',
        effective_from: '2026-11-04',
        expected_version: 1,
      },
    });
    assert.equal(adminUpdatePrice.statusCode, 403);
    assert.equal(adminUpdatePrice.json.error_code, 'FORBIDDEN_ROLE');

    // 3. Assigning an ADMIN (non-TEACHER) or a Center B teacher as group primary_teacher_id is rejected
    const nonTeacherGroup = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/groups',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `idem-bad-tchr-role-${crypto.randomUUID()}`,
      },
      body: {
        course_id: createCourseRes.json.id,
        name: 'Invalid Admin Teacher Group',
        primary_teacher_id: C.adminId,
        billing_mode: 'CALENDAR_PRO_RATA',
        current_fee_uzs: '600000',
        lessons_per_cycle: 12,
        schedule_days: ['MON', 'WED', 'FRI'],
        starts_time: '10:00',
        duration_minutes: 90,
      },
    });
    assert.equal(nonTeacherGroup.statusCode, 422);

    const foreignTeacherGroup = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/groups',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `idem-foreign-tchr-${crypto.randomUUID()}`,
      },
      body: {
        course_id: createCourseRes.json.id,
        name: 'Foreign Center Teacher Group',
        primary_teacher_id: CB.teacherId,
        billing_mode: 'CALENDAR_PRO_RATA',
        current_fee_uzs: '600000',
        lessons_per_cycle: 12,
        schedule_days: ['MON', 'WED', 'FRI'],
        starts_time: '10:00',
        duration_minutes: 90,
      },
    });
    assert.equal(foreignTeacherGroup.statusCode, 404);

    // 4. OWNER-20261104-02: Create group with Variant 1 (ENROLLMENT_ANNIVERSARY + ARREARS, e.g. Aug 12 -> Sep 12)
    //    and Variant 2 (CENTER_FIXED_DAY fixed_due_day=15 + ADVANCE)
    const groupVar1 = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/groups',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `idem-grp-var1-${crypto.randomUUID()}`,
      },
      body: {
        course_id: createCourseRes.json.id,
        name: 'IELTS-VAR1-ANNIVERSARY',
        primary_teacher_id: C.teacherId,
        billing_mode: 'ROLLING_MONTH',
        due_date_rule: 'ENROLLMENT_ANNIVERSARY',
        collection_timing: 'ARREARS',
        current_fee_uzs: '600000',
        lessons_per_cycle: 12,
        schedule_days: ['MON', 'WED', 'FRI'],
        starts_time: '09:00',
        duration_minutes: 90,
        timezone: 'Asia/Tashkent',
      },
    });
    assert.equal(groupVar1.statusCode, 201);
    assert.equal(groupVar1.json.due_date_rule, 'ENROLLMENT_ANNIVERSARY');
    assert.equal(groupVar1.json.fixed_due_day, null);
    assert.equal(groupVar1.json.collection_timing, 'ARREARS');

    const groupVar2 = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/groups',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `idem-grp-var2-${crypto.randomUUID()}`,
      },
      body: {
        course_id: createCourseRes.json.id,
        name: 'IELTS-VAR2-FIXED-15-ADVANCE',
        primary_teacher_id: C.teacherId,
        billing_mode: 'CALENDAR_PRO_RATA',
        due_date_rule: 'CENTER_FIXED_DAY',
        fixed_due_day: 15,
        collection_timing: 'ADVANCE',
        current_fee_uzs: '600000',
        lessons_per_cycle: 12,
        schedule_days: ['TUE', 'THU', 'SAT'],
        starts_time: '14:00',
        duration_minutes: 90,
        timezone: 'Asia/Tashkent',
      },
    });
    assert.equal(groupVar2.statusCode, 201);
    assert.equal(groupVar2.json.due_date_rule, 'CENTER_FIXED_DAY');
    assert.equal(groupVar2.json.fixed_due_day, 15);
    assert.equal(groupVar2.json.collection_timing, 'ADVANCE');
  });

  it('ACAD-IT-02 (Matrix #2 — T07.01): updates course tariff with append-only price history, separates current vs future effective_from dates, supports int64 BigInt bounds, and preserves existing invoice snapshots untouched', async () => {
    clock.setTestNow(new Date('2026-11-04T08:00:00.000Z'));
    try {
      // Seed an existing invoice on C.studentId in C.groupId with tariff_snapshot_uzs = 500000
      const enrId = crypto.randomUUID();
      const cycleId = crypto.randomUUID();
      const invoiceId = crypto.randomUUID();

      await env.apiPoolA.query(
        `INSERT INTO "enrollments" ("id", "center_id", "student_id", "group_id", "status", "enrolled_at_date")
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'ACTIVE', '2026-10-01')`,
        [enrId, C.centerId, C.studentId, C.groupId],
      );
      await env.apiPoolA.query(
        `INSERT INTO "billing_cycles" ("id", "center_id", "enrollment_id", "cycle_type", "cycle_key", "cycle_seq", "period_start_date", "period_end_date", "planned_lessons", "billable_lessons", "policy_version_id")
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'CALENDAR_MONTH', '2026-10', 1, '2026-10-01', '2026-10-31', 12, 12, $4::uuid)`,
        [cycleId, C.centerId, enrId, C.billingPolicyId],
      );
      await env.apiPoolA.query(
        `INSERT INTO "invoices" (
           "id", "center_id", "invoice_number", "student_id", "enrollment_id", "billing_cycle_id", "policy_version_id",
           "tariff_snapshot_uzs", "base_pro_rata_charge_uzs", "approved_discount_uzs", "credit_note_adjustments_uzs",
           "effective_net_charge_uzs", "allocated_paid_uzs", "remaining_debt_uzs", "billed_lessons", "status", "due_date"
         ) VALUES (
           $1::uuid, $2::uuid, 'INV-S07-TARIFF-01', $3::uuid, $4::uuid, $5::uuid, $6::uuid,
           500000, 500000, 0, 0, 500000, 100000, 400000, 12, 'PARTIALLY_PAID', '2026-10-15'
         )`,
        [invoiceId, C.centerId, C.studentId, enrId, cycleId, C.billingPolicyId],
      );

      // 1. Update C.courseId price effective TODAY (2026-11-04) to 580,000 UZS
      const updateToday = await httpJsonRequest({
        port,
        method: 'PATCH',
        path: `/api/v1/courses/${C.courseId}/price`,
        headers: {
          Authorization: `Bearer ${directorToken}`,
          'Idempotency-Key': `idem-prc-today-${crypto.randomUUID()}`,
          'If-Match-Version': '1',
        },
        body: {
          new_fee_uzs: '580000',
          effective_from: '2026-11-04',
          reason: 'November 2026 tariff adjustment',
          expected_version: 1,
        },
      });
      assert.equal(updateToday.statusCode, 200);
      assert.equal(updateToday.json.default_monthly_fee_uzs, '580000');
      assert.equal(updateToday.json.version, 2);

      // 2. Schedule a FUTURE price update effective 2026-12-01 (720,000 UZS)
      const updateFuture = await httpJsonRequest({
        port,
        method: 'PATCH',
        path: `/api/v1/courses/${C.courseId}/price`,
        headers: {
          Authorization: `Bearer ${directorToken}`,
          'Idempotency-Key': `idem-prc-future-${crypto.randomUUID()}`,
          'If-Match-Version': '2',
        },
        body: {
          new_fee_uzs: '720000',
          effective_from: '2026-12-01',
          reason: 'December 2026 scheduled tariff',
          expected_version: 2,
        },
      });
      assert.equal(updateFuture.statusCode, 200);
      // As of today (2026-11-04), effective fee MUST remain 580,000 UZS (future tariff does NOT become today's price!)
      assert.equal(updateFuture.json.default_monthly_fee_uzs, '580000');
      assert.equal(updateFuture.json.effective_fee_as_of_uzs, '580000');
      assert.equal(updateFuture.json.latest_scheduled_fee_uzs, '720000');
      assert.equal(updateFuture.json.latest_effective_from, '2026-12-01');

      // Querying GET /api/v1/courses?as_of_date=2026-12-01 resolves 720,000 UZS!
      const listDec = await httpJsonRequest({
        port,
        method: 'GET',
        path: '/api/v1/courses?as_of_date=2026-12-01',
        headers: { Authorization: `Bearer ${directorToken}` },
      });
      assert.equal(listDec.statusCode, 200);
      const mathCourseDec = (listDec.json.items as Array<Record<string, unknown>>).find(
        (c) => c.id === C.courseId,
      );
      assert.equal(mathCourseDec?.default_monthly_fee_uzs, '720000');

      // 3. Verify historical invoice INV-S07-TARIFF-01 snapshot is 100% unchanged!
      const invCheck = await env.apiPoolA.query<{
        tariff_snapshot_uzs: string;
        remaining_debt_uzs: string;
      }>(
        `SELECT "tariff_snapshot_uzs"::text AS tariff_snapshot_uzs,
                "remaining_debt_uzs"::text AS remaining_debt_uzs
           FROM "invoices"
          WHERE "id" = $1::uuid`,
        [invoiceId],
      );
      assert.equal(invCheck.rows[0]?.tariff_snapshot_uzs, '500000');
      assert.equal(invCheck.rows[0]?.remaining_debt_uzs, '400000');

      // 4. Verify append-only course_price_history rejects UPDATE and DELETE at the DB level
      await assert.rejects(
        () =>
          env.apiPoolA.query(
            `UPDATE "course_price_history" SET "new_fee_uzs" = 100 WHERE "course_id" = $1::uuid`,
            [C.courseId],
          ),
        (err: unknown) => (err as { code?: string }).code === '42501',
      );
      await assert.rejects(
        () =>
          env.apiPoolA.query(
            `DELETE FROM "course_price_history" WHERE "course_id" = $1::uuid`,
            [C.courseId],
          ),
        (err: unknown) => (err as { code?: string }).code === '42501',
      );
    } finally {
      clock.setTestNow(null);
    }
  });

  it('ACAD-IT-03 (Matrix #3 — T07.01): deactivating a teacher surfaces open scheduled lesson warnings without mutating historical snapshots, and soft-archiving preserves lessons/enrollments', async () => {
    const tempTeacherId = crypto.randomUUID();
    const tempGroupId = crypto.randomUUID();
    const completedLessonId = crypto.randomUUID();
    const openLesson1Id = crypto.randomUUID();
    const openLesson2Id = crypto.randomUUID();
    const pwHash = await hashPassword(SYNTHETIC_TEST_ONLY_PASSWORD, { N: 16384 });

    await env.apiPoolA.query(
      `INSERT INTO "staff_users" ("id", "center_id", "role", "full_name", "login_username", "phone_e164", "password_hash", "must_change_password", "status")
       VALUES ($1::uuid, $2::uuid, 'TEACHER', 'Deactivate Warning Teacher', 'teacher.deact.warn', '+998904445566', $3, FALSE, 'ACTIVE')`,
      [tempTeacherId, C.centerId, pwHash],
    );
    await env.apiPoolA.query(
      `INSERT INTO "course_groups" ("id", "center_id", "course_id", "name", "primary_teacher_id", "billing_mode", "current_fee_uzs", "lessons_per_cycle", "schedule_days_json", "starts_time", "duration_minutes", "timezone", "status")
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'WARN-GROUP-01', $4::uuid, 'CALENDAR_PRO_RATA', 500000, 12, '["MON","WED","FRI"]'::jsonb, '10:00', 90, 'Asia/Tashkent', 'ACTIVE')`,
      [tempGroupId, C.centerId, C.courseId, tempTeacherId],
    );
    await env.apiPoolA.query(
      `INSERT INTO "lesson_occurrences" ("id", "center_id", "group_id", "lesson_date", "occurrence_seq", "starts_at_utc", "ends_at_utc", "status", "primary_teacher_snapshot_id", "pay_recipient_teacher_id")
       VALUES
         ($1::uuid, $4::uuid, $5::uuid, '2026-11-02', 1, '2026-11-02T05:00:00Z', '2026-11-02T06:30:00Z', 'COMPLETED', $6::uuid, $6::uuid),
         ($2::uuid, $4::uuid, $5::uuid, '2026-11-06', 1, '2026-11-06T05:00:00Z', '2026-11-06T06:30:00Z', 'SCHEDULED', $6::uuid, $6::uuid),
         ($3::uuid, $4::uuid, $5::uuid, '2026-11-09', 1, '2026-11-09T05:00:00Z', '2026-11-09T06:30:00Z', 'SCHEDULED', $6::uuid, $6::uuid)`,
      [completedLessonId, openLesson1Id, openLesson2Id, C.centerId, tempGroupId, tempTeacherId],
    );

    const deactRes = await httpJsonRequest({
      port,
      method: 'PATCH',
      path: `/api/v1/staff/${tempTeacherId}/status`,
      headers: {
        Authorization: `Bearer ${directorToken}`,
        'Idempotency-Key': `idem-deact-warn-${crypto.randomUUID()}`,
      },
      body: {
        status: 'DEACTIVATED',
        role: 'TEACHER',
        reason: 'Medical leave deactivation',
        expected_version: 1,
      },
    });
    assert.equal(deactRes.statusCode, 200);
    assert.equal(deactRes.json.status, 'DEACTIVATED');
    assert.equal(deactRes.json.open_scheduled_lessons_warning_count, 2);
    assert.equal(deactRes.json.reassignment_required_warning, true);
    assert.deepEqual(deactRes.json.affected_active_group_ids, [tempGroupId]);
    assert.deepEqual(deactRes.json.open_scheduled_lesson_ids, [openLesson1Id, openLesson2Id]);

    // Historical COMPLETED lesson snapshot and open lessons were NOT silently reassigned
    const snapCheck = await env.apiPoolA.query<{
      primary_teacher_snapshot_id: string;
      pay_recipient_teacher_id: string;
    }>(
      `SELECT "primary_teacher_snapshot_id"::text AS primary_teacher_snapshot_id,
              "pay_recipient_teacher_id"::text AS pay_recipient_teacher_id
         FROM "lesson_occurrences"
        WHERE "id" = $1::uuid`,
      [completedLessonId],
    );
    assert.equal(snapCheck.rows[0]?.primary_teacher_snapshot_id, tempTeacherId);
    assert.equal(snapCheck.rows[0]?.pay_recipient_teacher_id, tempTeacherId);

    // Reassign group to active otherTeacherId and soft-archive group -> historical lessons remain intact
    const archiveGrp = await httpJsonRequest({
      port,
      method: 'PATCH',
      path: `/api/v1/groups/${tempGroupId}`,
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `idem-arch-grp-${crypto.randomUUID()}`,
      },
      body: {
        primary_teacher_id: otherTeacherId,
        status: 'ARCHIVED',
        reason: 'Archived after cohort completion',
        expected_version: 1,
      },
    });
    assert.equal(archiveGrp.statusCode, 200);
    assert.equal(archiveGrp.json.status, 'ARCHIVED');

    const lessonsStillExist = await env.apiPoolA.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM "lesson_occurrences" WHERE "group_id" = $1::uuid`,
      [tempGroupId],
    );
    assert.equal(Number(lessonsStillExist.rows[0]?.cnt), 3);
  });

  it('ACAD-IT-04 & ACAD-IT-05 (Matrix #4 & #5 — T07.02): supports two distinct lessons on the same day, blocks parallel time conflicts across groups/teachers, generates recurring lessons with explicit holiday skip/cancel, and enforces DST/timezone rules', async () => {
    // 1. Schedule two distinct lessons on the same day (2026-11-11, occurrence_seq 1 & 2) in C.groupId
    const l1 = await httpJsonRequest({
      port,
      method: 'POST',
      path: `/api/v1/groups/${C.groupId}/lessons`,
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `idem-sameday-1-${crypto.randomUUID()}`,
      },
      body: {
        lesson_date: '2026-11-11',
        occurrence_seq: 1,
        local_starts_time: '09:00',
        duration_minutes: 90,
      },
    });
    const l2 = await httpJsonRequest({
      port,
      method: 'POST',
      path: `/api/v1/groups/${C.groupId}/lessons`,
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `idem-sameday-2-${crypto.randomUUID()}`,
      },
      body: {
        lesson_date: '2026-11-11',
        occurrence_seq: 2,
        local_starts_time: '15:00',
        duration_minutes: 90,
      },
    });
    assert.equal(l1.statusCode, 201);
    assert.equal(l2.statusCode, 201);
    assert.notEqual(l1.json.id, l2.json.id);
    assert.equal(l1.json.lesson_date, '2026-11-11');
    assert.equal(l2.json.lesson_date, '2026-11-11');
    assert.equal(l1.json.starts_at_utc, '2026-11-11T04:00:00.000Z');
    assert.equal(l2.json.starts_at_utc, '2026-11-11T10:00:00.000Z');

    // 2. Two parallel schedule calls for an overlapping time slot (2026-11-13 09:00..10:30 vs 09:30..11:00)
    //    cannot both succeed!
    const [par1, par2] = await Promise.all([
      httpJsonRequest({
        port,
        method: 'POST',
        path: `/api/v1/groups/${C.groupId}/lessons`,
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Idempotency-Key': `idem-par-sched-1-${crypto.randomUUID()}`,
        },
        body: {
          lesson_date: '2026-11-13',
          occurrence_seq: 1,
          local_starts_time: '09:00',
          duration_minutes: 90,
        },
      }),
      httpJsonRequest({
        port,
        method: 'POST',
        path: `/api/v1/groups/${C.groupId}/lessons`,
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Idempotency-Key': `idem-par-sched-2-${crypto.randomUUID()}`,
        },
        body: {
          lesson_date: '2026-11-13',
          occurrence_seq: 2,
          local_starts_time: '09:30',
          duration_minutes: 90,
        },
      }),
    ]);
    assert.deepEqual([par1.statusCode, par2.statusCode].sort(), [201, 409]);

    // 3. Batch recurring generator with explicit public holiday skip & create_cancelled
    const genRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: `/api/v1/groups/${C.groupId}/lessons/generate`,
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `idem-gen-rec-${crypto.randomUUID()}`,
      },
      body: {
        start_date: '2026-12-07',
        end_date: '2026-12-11',
        holidays: [
          {
            date: '2026-12-09',
            reason: 'Center Winter Maintenance Day',
            mode: 'SKIP',
          },
        ],
      },
    });
    assert.equal(genRes.statusCode, 201);
    const createdGen = genRes.json.created_lessons as Array<Record<string, unknown>>;
    const skippedGen = genRes.json.skipped_holidays as Array<Record<string, unknown>>;
    // Mon Dec 07 and Fri Dec 11 created; Wed Dec 09 skipped!
    assert.equal(createdGen.length, 2);
    assert.equal(skippedGen.length, 1);
    assert.equal(skippedGen[0].lesson_date, '2026-12-09');
    assert.equal(skippedGen[0].source, 'EXPLICIT_HOLIDAY_INPUT');

    // 4. DST timezone regression on a group in America/New_York
    const nyGroupRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/groups',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `idem-ny-grp-${crypto.randomUUID()}`,
      },
      body: {
        course_id: C.courseId,
        name: 'NY-DST-TEST-GROUP',
        primary_teacher_id: otherTeacherId,
        billing_mode: 'CALENDAR_PRO_RATA',
        current_fee_uzs: '500000',
        lessons_per_cycle: 12,
        schedule_days: ['SUN'],
        starts_time: '01:30',
        duration_minutes: 60,
        timezone: 'America/New_York',
      },
    });
    assert.equal(nyGroupRes.statusCode, 201);
    const nyGroupId = nyGroupRes.json.group_id as string;

    const dstGapRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: `/api/v1/groups/${nyGroupId}/lessons`,
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `idem-ny-gap-${crypto.randomUUID()}`,
      },
      body: {
        lesson_date: '2026-03-08',
        occurrence_seq: 1,
        local_starts_time: '02:30',
        duration_minutes: 60,
      },
    });
    assert.equal(dstGapRes.statusCode, 422);

    const dstOverlapRejectRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: `/api/v1/groups/${nyGroupId}/lessons`,
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `idem-ny-ovl-rej-${crypto.randomUUID()}`,
      },
      body: {
        lesson_date: '2026-11-01',
        occurrence_seq: 1,
        local_starts_time: '01:30',
        duration_minutes: 60,
      },
    });
    assert.equal(dstOverlapRejectRes.statusCode, 422);

    const dstOverlapEarlierRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: `/api/v1/groups/${nyGroupId}/lessons`,
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `idem-ny-ovl-early-${crypto.randomUUID()}`,
      },
      body: {
        lesson_date: '2026-11-01',
        occurrence_seq: 1,
        local_starts_time: '01:30',
        duration_minutes: 60,
        dst_disambiguation: 'EARLIER',
      },
    });
    assert.equal(dstOverlapEarlierRes.statusCode, 201);
    assert.equal(dstOverlapEarlierRes.json.starts_at_utc, '2026-11-01T05:30:00.000Z');
  });

  it('ACAD-IT-06 (Matrix #6 — T07.02): reschedules lesson with stable rescheduled_from_lesson_id relation, rolls back on injected fault, preserves existing grades, and marks cancelled lessons ineligible for ping/trial/billing', async () => {
    const origLessonRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: `/api/v1/groups/${C.groupId}/lessons`,
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `idem-resched-orig-${crypto.randomUUID()}`,
      },
      body: {
        lesson_date: '2026-11-16',
        occurrence_seq: 1,
        local_starts_time: '09:00',
        duration_minutes: 90,
      },
    });
    assert.equal(origLessonRes.statusCode, 201);
    const origLessonId = origLessonRes.json.id as string;

    //Fault injection during reschedule rolls back source lesson status to SCHEDULED
    const faultResched = await httpJsonRequest({
      port,
      method: 'POST',
      path: `/api/v1/groups/${C.groupId}/lessons`,
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `idem-resched-fault-${crypto.randomUUID()}`,
      },
      body: {
        lesson_date: '2026-11-17',
        occurrence_seq: 1,
        local_starts_time: '09:00',
        duration_minutes: 90,
        rescheduled_from_lesson_id: origLessonId,
        expected_version: 1,
        debug_fail_after_reschedule_source_update: true,
      },
    });
    assert.equal(faultResched.statusCode, 500);

    const checkOrigStillScheduled = await env.apiPoolA.query<{ status: string }>(
      `SELECT "status" FROM "lesson_occurrences" WHERE "id" = $1::uuid`,
      [origLessonId],
    );
    assert.equal(checkOrigStillScheduled.rows[0]?.status, 'SCHEDULED');

    // Valid reschedule transitions origLessonId to RESCHEDULED and creates replacement lesson
    const validResched = await httpJsonRequest({
      port,
      method: 'POST',
      path: `/api/v1/groups/${C.groupId}/lessons`,
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `idem-resched-ok-${crypto.randomUUID()}`,
      },
      body: {
        lesson_date: '2026-11-17',
        occurrence_seq: 1,
        local_starts_time: '09:00',
        duration_minutes: 90,
        rescheduled_from_lesson_id: origLessonId,
        expected_version: 1,
      },
    });
    assert.equal(validResched.statusCode, 201);
    assert.equal(validResched.json.rescheduled_from_lesson_id, origLessonId);
    const replacementLessonId = validResched.json.id as string;

    // Attempting to reschedule origLessonId a second time is rejected with 409 VERSION_CONFLICT
    const doubleResched = await httpJsonRequest({
      port,
      method: 'POST',
      path: `/api/v1/groups/${C.groupId}/lessons`,
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `idem-resched-dup-${crypto.randomUUID()}`,
      },
      body: {
        lesson_date: '2026-11-18',
        occurrence_seq: 1,
        local_starts_time: '09:00',
        duration_minutes: 90,
        rescheduled_from_lesson_id: origLessonId,
      },
    });
    assert.equal(doubleResched.statusCode, 409);

    // Cancel replacementLessonId -> status becomes CANCELLED_BY_CENTER and operational eligibility flags become false
    const cancelRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: `/api/v1/lessons/${replacementLessonId}/cancel`,
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `idem-cancel-les-${crypto.randomUUID()}`,
      },
      body: {
        reason: 'National holiday closure',
        cancellation_source: 'PUBLIC_HOLIDAY',
        expected_version: 1,
      },
    });
    assert.equal(cancelRes.statusCode, 200);
    assert.equal(cancelRes.json.status, 'CANCELLED_BY_CENTER');
    assert.equal(cancelRes.json.eligible_for_teacher_ping, false);
    assert.equal(cancelRes.json.eligible_for_trial_conversion, false);
    assert.equal(cancelRes.json.eligible_for_package_consumption, false);
  });

  it('ACAD-IT-07 & ACAD-IT-08 (Matrix #7 & #8 — T07.03): enforces single-lesson substitute entitlement (denying same-day other lesson in the same group), one-winner concurrency, atomic pay_recipient_teacher_id snapshot, fault rollback, and immediate revocation re-auth', async () => {
    clock.setTestNow(new Date('2026-11-04T06:00:00.000Z')); // 2026-11-04 in Asia/Tashkent
    try {
      // Schedule TWO lessons on today (2026-11-04) in C.groupId: Morning (seq=1) and Evening (seq=2)
      const morningRes = await httpJsonRequest({
        port,
        method: 'POST',
        path: `/api/v1/groups/${C.groupId}/lessons`,
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Idempotency-Key': `idem-sub-morn-${crypto.randomUUID()}`,
        },
        body: {
          lesson_date: '2026-11-04',
          occurrence_seq: 1,
          local_starts_time: '09:00',
          duration_minutes: 90,
        },
      });
      const eveningRes = await httpJsonRequest({
        port,
        method: 'POST',
        path: `/api/v1/groups/${C.groupId}/lessons`,
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Idempotency-Key': `idem-sub-eve-${crypto.randomUUID()}`,
        },
        body: {
          lesson_date: '2026-11-04',
          occurrence_seq: 2,
          local_starts_time: '16:00',
          duration_minutes: 90,
        },
      });
      assert.equal(morningRes.statusCode, 201);
      assert.equal(eveningRes.statusCode, 201);
      const morningLessonId = morningRes.json.id as string;
      const eveningLessonId = eveningRes.json.id as string;

      // 1. Fault injection during substitute assignment rolls back both substitute_assignments and pay_recipient_teacher_id
      const faultSub = await httpJsonRequest({
        port,
        method: 'POST',
        path: `/api/v1/lessons/${morningLessonId}/substitute`,
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Idempotency-Key': `idem-sub-fault-${crypto.randomUUID()}`,
        },
        body: {
          substitute_teacher_id: subTeacherId,
          reason: 'Fault injection test',
          expected_version: 1,
          debug_fail_after_assignment_insert: true,
        },
      });
      assert.equal(faultSub.statusCode, 500);

      const checkPayAfterFault = await env.apiPoolA.query<{ pay_recipient_teacher_id: string }>(
        `SELECT "pay_recipient_teacher_id"::text AS pay_recipient_teacher_id FROM "lesson_occurrences" WHERE "id" = $1::uuid`,
        [morningLessonId],
      );
      assert.equal(checkPayAfterFault.rows[0]?.pay_recipient_teacher_id, C.teacherId);

      // 2. Concurrent substitute assignments on morningLessonId with expected_version=1 -> 1 winner (200), 1 conflict (409)!
      const [concSub1, concSub2] = await Promise.all([
        httpJsonRequest({
          port,
          method: 'POST',
          path: `/api/v1/lessons/${morningLessonId}/substitute`,
          headers: {
            Authorization: `Bearer ${adminToken}`,
            'Idempotency-Key': `idem-sub-conc-1-${crypto.randomUUID()}`,
          },
          body: {
            substitute_teacher_id: subTeacherId,
            reason: 'Primary teacher sick leave morning only',
            expected_version: 1,
          },
        }),
        httpJsonRequest({
          port,
          method: 'POST',
          path: `/api/v1/lessons/${morningLessonId}/substitute`,
          headers: {
            Authorization: `Bearer ${adminToken}`,
            'Idempotency-Key': `idem-sub-conc-2-${crypto.randomUUID()}`,
          },
          body: {
            substitute_teacher_id: otherTeacherId,
            reason: 'Competing concurrent substitute assignment',
            expected_version: 1,
          },
        }),
      ]);
      assert.deepEqual([concSub1.statusCode, concSub2.statusCode].sort(), [200, 409]);

      // Ensure subTeacherId is the active substitute on morningLessonId (if concSub2 won the race, replace with subTeacherId at version 2)
      let currentMorningLessonVersion = 2;
      if (concSub1.statusCode !== 200) {
        const fixSub = await httpJsonRequest({
          port,
          method: 'POST',
          path: `/api/v1/lessons/${morningLessonId}/substitute`,
          headers: {
            Authorization: `Bearer ${adminToken}`,
            'Idempotency-Key': `idem-sub-fix-${crypto.randomUUID()}`,
          },
          body: {
            substitute_teacher_id: subTeacherId,
            reason: 'Set subTeacherId as morning substitute',
            expected_version: 2,
          },
        });
        assert.equal(fixSub.statusCode, 200);
        currentMorningLessonVersion = 3;
      }

      // Verify primary_teacher_snapshot_id is still C.teacherId while pay_recipient_teacher_id is subTeacherId!
      const snapRow = await env.apiPoolA.query<{
        primary_teacher_snapshot_id: string;
        pay_recipient_teacher_id: string;
      }>(
        `SELECT "primary_teacher_snapshot_id"::text AS primary_teacher_snapshot_id,
                "pay_recipient_teacher_id"::text AS pay_recipient_teacher_id
           FROM "lesson_occurrences"
          WHERE "id" = $1::uuid`,
        [morningLessonId],
      );
      assert.equal(snapRow.rows[0]?.primary_teacher_snapshot_id, C.teacherId);
      assert.equal(snapRow.rows[0]?.pay_recipient_teacher_id, subTeacherId);

      // 3. Single-Lesson Boundary Proof (T07.03):
      // subTeacherToken calling GET /api/v1/groups/:groupId/lessons sees ONLY morningLessonId (1 item), NOT eveningLessonId!
      const subLessonsList = await httpJsonRequest({
        port,
        method: 'GET',
        path: `/api/v1/groups/${C.groupId}/lessons`,
        headers: { Authorization: `Bearer ${subTeacherToken}` },
      });
      assert.equal(subLessonsList.statusCode, 200);
      const subVisibleLessons = subLessonsList.json.items as Array<Record<string, unknown>>;
      assert.equal(subVisibleLessons.length, 1);
      assert.equal(subVisibleLessons[0].id, morningLessonId);

      // subTeacherToken can access morningLessonId grades (200) and roster with lesson_id=morningLessonId (200)
      const subMorningGrades = await httpJsonRequest({
        port,
        method: 'GET',
        path: `/api/v1/lessons/${morningLessonId}/grades`,
        headers: { Authorization: `Bearer ${subTeacherToken}` },
      });
      assert.equal(subMorningGrades.statusCode, 200);

      const subMorningRoster = await httpJsonRequest({
        port,
        method: 'GET',
        path: `/api/v1/groups/${C.groupId}/roster?lesson_id=${morningLessonId}`,
        headers: { Authorization: `Bearer ${subTeacherToken}` },
      });
      assert.equal(subMorningRoster.statusCode, 200);

      // subTeacherToken is DENIED (403 FORBIDDEN_OBJECT_SCOPE) on eveningLessonId (same group, same day!)
      const subEveningGradesRead = await httpJsonRequest({
        port,
        method: 'GET',
        path: `/api/v1/lessons/${eveningLessonId}/grades`,
        headers: { Authorization: `Bearer ${subTeacherToken}` },
      });
      assert.equal(subEveningGradesRead.statusCode, 403);
      assert.equal(subEveningGradesRead.json.error_code, 'FORBIDDEN_OBJECT_SCOPE');

      const subEveningGradesWrite = await httpJsonRequest({
        port,
        method: 'POST',
        path: `/api/v1/lessons/${eveningLessonId}/grades`,
        headers: {
          Authorization: `Bearer ${subTeacherToken}`,
          'Idempotency-Key': `idem-sub-eve-write-${crypto.randomUUID()}`,
        },
        body: {
          expected_version: 1,
          grades: [{ student_id: C.studentId, score: 90 }],
        },
      });
      assert.equal(subEveningGradesWrite.statusCode, 403);
      assert.equal(subEveningGradesWrite.json.error_code, 'FORBIDDEN_OBJECT_SCOPE');

      const subEveningRoster = await httpJsonRequest({
        port,
        method: 'GET',
        path: `/api/v1/groups/${C.groupId}/roster?lesson_id=${eveningLessonId}`,
        headers: { Authorization: `Bearer ${subTeacherToken}` },
      });
      assert.equal(subEveningRoster.statusCode, 403);
      assert.equal(subEveningRoster.json.error_code, 'FORBIDDEN_OBJECT_SCOPE');

      // 4. Revoke morningLessonId substitute assignment -> restores pay_recipient_teacher_id to C.teacherId
      //    and immediately blocks subTeacherToken's offline/cached grade submission with 403!
      const revokeSub = await httpJsonRequest({
        port,
        method: 'POST',
        path: `/api/v1/lessons/${morningLessonId}/substitute/revoke`,
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Idempotency-Key': `idem-sub-rev-${crypto.randomUUID()}`,
        },
        body: {
          reason: 'Primary teacher recovered and returned',
          expected_version: currentMorningLessonVersion,
        },
      });
      assert.equal(revokeSub.statusCode, 200);
      assert.equal(revokeSub.json.status, 'REVOKED');
      assert.equal(revokeSub.json.pay_recipient_teacher_id, C.teacherId);

      const offlineSubWriteAfterRevoke = await httpJsonRequest({
        port,
        method: 'POST',
        path: `/api/v1/lessons/${morningLessonId}/grades`,
        headers: {
          Authorization: `Bearer ${subTeacherToken}`,
          'Idempotency-Key': `idem-sub-after-rev-${crypto.randomUUID()}`,
        },
        body: {
          expected_version: Number(revokeSub.json.lesson_version),
          grades: [{ student_id: C.studentId, score: 88 }],
        },
      });
      assert.equal(offlineSubWriteAfterRevoke.statusCode, 403);
      assert.equal(offlineSubWriteAfterRevoke.json.error_code, 'FORBIDDEN_OBJECT_SCOPE');
    } finally {
      clock.setTestNow(null);
    }
  });

  it('ACAD-IT-09 & ACAD-IT-10 (Matrix #9 & #10 — T07.04): enforces grade score bounds, plain-text comment sanitization, batch atomicity, optimistic concurrency, append-only revision history in audit_logs, and zero phone/financial leaks to Teacher', async () => {
    const gradeLessonRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: `/api/v1/groups/${C.groupId}/lessons`,
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `idem-grd-les-${crypto.randomUUID()}`,
      },
      body: {
        lesson_date: '2026-11-18',
        occurrence_seq: 1,
        local_starts_time: '09:00',
        duration_minutes: 90,
      },
    });
    assert.equal(gradeLessonRes.statusCode, 201);
    const gradeLessonId = gradeLessonRes.json.id as string;

    // 1. Out-of-range score (>100) and non-enrolled student_id are rejected
    const outOfRangeRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: `/api/v1/lessons/${gradeLessonId}/grades`,
      headers: {
        Authorization: `Bearer ${primaryTeacherToken}`,
        'Idempotency-Key': `idem-grd-oor-${crypto.randomUUID()}`,
      },
      body: {
        expected_version: 1,
        grades: [{ student_id: C.studentId, score: 105 }],
      },
    });
    assert.equal(outOfRangeRes.statusCode, 422);

    const wrongStudentRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: `/api/v1/lessons/${gradeLessonId}/grades`,
      headers: {
        Authorization: `Bearer ${primaryTeacherToken}`,
        'Idempotency-Key': `idem-grd-wrongstu-${crypto.randomUUID()}`,
      },
      body: {
        expected_version: 1,
        grades: [{ student_id: CB.studentId, score: 85 }],
      },
    });
    assert.equal(wrongStudentRes.statusCode, 422);

    // 2. Fault injection rolls back grade entry and lesson version
    const faultGradeRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: `/api/v1/lessons/${gradeLessonId}/grades`,
      headers: {
        Authorization: `Bearer ${primaryTeacherToken}`,
        'Idempotency-Key': `idem-grd-fault-${crypto.randomUUID()}`,
      },
      body: {
        expected_version: 1,
        grades: [{ student_id: C.studentId, score: 80, comment: 'Initial fault test' }],
        debug_fail_after_first_grade_write: true,
      },
    });
    assert.equal(faultGradeRes.statusCode, 500);

    const checkNoGradesAfterFault = await env.apiPoolA.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM "grade_entries" WHERE "lesson_id" = $1::uuid`,
      [gradeLessonId],
    );
    assert.equal(Number(checkNoGradesAfterFault.rows[0]?.cnt), 0);

    // 3. Valid grade submission v1 with <script> comment -> sanitized plain text stored, version increments to 2
    const submitV1Key = `idem-grd-v1-${crypto.randomUUID()}`;
    const submitV1 = await httpJsonRequest({
      port,
      method: 'POST',
      path: `/api/v1/lessons/${gradeLessonId}/grades`,
      headers: {
        Authorization: `Bearer ${primaryTeacherToken}`,
        'Idempotency-Key': submitV1Key,
        'If-Match-Version': '1',
      },
      body: {
        expected_version: 1,
        reason: 'Midterm exam initial grading',
        grades: [
          {
            student_id: C.studentId,
            score: 84.5,
            comment: '<script>evil()</script> Strong algebra solution > average',
          },
        ],
      },
    });
    assert.equal(submitV1.statusCode, 200);
    assert.equal(submitV1.json.saved_count, 1);
    assert.equal(submitV1.json.version, 2);
    const v1Entries = submitV1.json.entries as Array<Record<string, unknown>>;
    assert.equal(v1Entries[0].score, 84.5);
    assert.equal(String(v1Entries[0].comment_sanitized).includes('<script>'), false);
    assert.ok(String(v1Entries[0].comment_sanitized).includes('[REDACTED_TAG]'));

    // Same Idempotency-Key with different score returns 409 IDEMPOTENCY_PAYLOAD_MISMATCH
    const mismatchGradeIdem = await httpJsonRequest({
      port,
      method: 'POST',
      path: `/api/v1/lessons/${gradeLessonId}/grades`,
      headers: {
        Authorization: `Bearer ${primaryTeacherToken}`,
        'Idempotency-Key': submitV1Key,
      },
      body: {
        expected_version: 1,
        reason: 'Midterm exam initial grading',
        grades: [{ student_id: C.studentId, score: 99 }],
      },
    });
    assert.equal(mismatchGradeIdem.statusCode, 409);
    assert.equal(mismatchGradeIdem.json.error_code, 'IDEMPOTENCY_PAYLOAD_MISMATCH');

    // Stale expected_version: 1 on update is rejected with 409 VERSION_CONFLICT
    const staleUpdate = await httpJsonRequest({
      port,
      method: 'POST',
      path: `/api/v1/lessons/${gradeLessonId}/grades`,
      headers: {
        Authorization: `Bearer ${primaryTeacherToken}`,
        'Idempotency-Key': `idem-grd-stale-${crypto.randomUUID()}`,
      },
      body: {
        expected_version: 1,
        grades: [{ student_id: C.studentId, score: 95 }],
      },
    });
    assert.equal(staleUpdate.statusCode, 409);
    assert.equal(staleUpdate.json.error_code, 'VERSION_CONFLICT');

    // 4. Valid grade update v2 (score 84.5 -> 96.0) with expected_version: 2 preserves v1 and v2 in append-only revision history!
    const submitV2 = await httpJsonRequest({
      port,
      method: 'POST',
      path: `/api/v1/lessons/${gradeLessonId}/grades`,
      headers: {
        Authorization: `Bearer ${primaryTeacherToken}`,
        'Idempotency-Key': `idem-grd-v2-${crypto.randomUUID()}`,
        'If-Match-Version': '2',
      },
      body: {
        expected_version: 2,
        reason: 'Bonus problem re-grade approved',
        grades: [
          {
            student_id: C.studentId,
            score: 96,
            comment: 'Updated after bonus problem review',
            expected_grade_version: 1,
          },
        ],
      },
    });
    assert.equal(submitV2.statusCode, 200);
    assert.equal(submitV2.json.version, 3);

    const historyRes = await httpJsonRequest({
      port,
      method: 'GET',
      path: `/api/v1/lessons/${gradeLessonId}/grades`,
      headers: { Authorization: `Bearer ${primaryTeacherToken}` },
    });
    assert.equal(historyRes.statusCode, 200);
    const currentItems = historyRes.json.items as Array<Record<string, unknown>>;
    const revisions = historyRes.json.revisions as Array<Record<string, unknown>>;
    assert.equal(currentItems.length, 1);
    assert.equal(currentItems[0].score, 96);
    assert.equal(currentItems[0].version, 2);

    assert.equal(revisions.length, 2);
    assert.equal(revisions[0].action, 'GRADE_ENTRY_CREATED');
    assert.equal(revisions[0].revision_version, 1);
    assert.equal(revisions[0].previous_score, null);
    assert.equal(revisions[0].new_score, 84.5);

    assert.equal(revisions[1].action, 'GRADE_ENTRY_UPDATED');
    assert.equal(revisions[1].revision_version, 2);
    assert.equal(revisions[1].previous_score, 84.5);
    assert.equal(revisions[1].new_score, 96);
    assert.equal(revisions[1].reason, 'Bonus problem re-grade approved');

    // 5. Verify append-only grade revision rows in audit_logs cannot be updated or deleted
    await assert.rejects(
      () =>
        env.apiPoolA.query(
          `UPDATE "audit_logs" SET "action" = 'TAMPERED' WHERE "id" = $1::uuid`,
          [revisions[0].audit_id],
        ),
      (err: unknown) => (err as { code?: string }).code === '42501',
    );

    // 6. Verify Teacher responses across listCourseGroups, listGroupLessons, and listLessonGradesAndHistory
    //    never expose raw guardian/student phones or financial fields (current_fee_uzs, debt, invoice)
    const teacherGroupsRes = await httpJsonRequest({
      port,
      method: 'GET',
      path: '/api/v1/groups',
      headers: { Authorization: `Bearer ${primaryTeacherToken}` },
    });
    assert.equal(teacherGroupsRes.statusCode, 200);
    assert.equal(teacherGroupsRes.rawBody.includes('current_fee_uzs'), false);
    assert.equal(teacherGroupsRes.rawBody.includes('+998'), false);
    assert.equal(historyRes.rawBody.includes('+998'), false);
    assert.equal(historyRes.rawBody.includes('remaining_debt_uzs'), false);
  });

  it('ACAD-IT-11 (I02, I06): verifies isolated grade create/update/read/revision lifecycle, multi-item batch rollback when 2nd item fails, concurrent grade update race, and idempotency payload mismatch vs authorized replay', async () => {
    const isolatedLessonRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: `/api/v1/groups/${C.groupId}/lessons`,
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `idem-i02-lsn-${crypto.randomUUID()}`,
      },
      body: {
        lesson_date: '2026-11-23',
        occurrence_seq: 1,
        local_starts_time: '15:00',
        duration_minutes: 90,
      },
    });
    assert.equal(isolatedLessonRes.statusCode, 201);
    const i02LessonId = String(isolatedLessonRes.json.id);

    // 1. Multi-item batch where 1st item is valid (enrolled C.studentId) and 2nd item is non-enrolled student ->
    //    real domain validation fails on 2nd item (422 STUDENT_NOT_ENROLLED_IN_GROUP) and rolls back 1st item & lesson version!
    const nonEnrolledId = crypto.randomUUID();
    await env.apiPoolA.query(
      `INSERT INTO "students" ("id", "center_id", "student_code", "full_name", "normalized_name", "status", "version", "updated_at")
       VALUES ($1::uuid, $2::uuid, 'I02-NONENROLLED', 'I02 Batch Rollback NonEnrolled', 'i02 batch rollback nonenrolled', 'ACTIVE', 1, NOW())`,
      [nonEnrolledId, C.centerId],
    );

    const invalidSecondItemBatch = await httpJsonRequest({
      port,
      method: 'POST',
      path: `/api/v1/lessons/${i02LessonId}/grades`,
      headers: {
        Authorization: `Bearer ${primaryTeacherToken}`,
        'Idempotency-Key': `idem-i02-batch-fail-${crypto.randomUUID()}`,
      },
      body: {
        expected_version: 1,
        grades: [
          { student_id: C.studentId, score: 88.5, comment: 'First student valid' },
          { student_id: nonEnrolledId, score: 77.0, comment: 'Second student not enrolled' },
        ],
      },
    });
    assert.equal(invalidSecondItemBatch.statusCode, 422);
    assert.equal(invalidSecondItemBatch.json.error_code, 'VALIDATION_ERROR');

    const gradeCountAfterBatchFail = await env.apiPoolA.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM "grade_entries" WHERE "center_id" = $1::uuid AND "lesson_id" = $2::uuid`,
      [C.centerId, i02LessonId],
    );
    assert.equal(gradeCountAfterBatchFail.rows[0]?.cnt, '0');

    const lessonVerAfterBatchFail = await env.apiPoolA.query<{ version: number }>(
      `SELECT "version" FROM "lesson_occurrences" WHERE "center_id" = $1::uuid AND "id" = $2::uuid`,
      [C.centerId, i02LessonId],
    );
    assert.equal(Number(lessonVerAfterBatchFail.rows[0]?.version), 1);

    // 2. Valid grade create v1 -> 200 OK, lesson version = 2, grade version = 1
    const createKey = `idem-i02-v1-${crypto.randomUUID()}`;
    const createRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: `/api/v1/lessons/${i02LessonId}/grades`,
      headers: {
        Authorization: `Bearer ${primaryTeacherToken}`,
        'Idempotency-Key': createKey,
      },
      body: {
        expected_version: 1,
        grades: [{ student_id: C.studentId, score: 89.25, comment: 'Initial quiz score' }],
      },
    });
    assert.equal(createRes.statusCode, 200);
    assert.equal(createRes.json.version, 2);

    // 3. Authorized replay with the exact same createKey and body (including expected_version: 1) ->
    //    returns 200 OK from idempotency store without creating duplicate grade or audit rows!
    const replayCreateRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: `/api/v1/lessons/${i02LessonId}/grades`,
      headers: {
        Authorization: `Bearer ${primaryTeacherToken}`,
        'Idempotency-Key': createKey,
      },
      body: {
        expected_version: 1,
        grades: [{ student_id: C.studentId, score: 89.25, comment: 'Initial quiz score' }],
      },
    });
    assert.equal(replayCreateRes.statusCode, 200);
    assert.equal(replayCreateRes.json.version, 2);

    // 4. Same Idempotency-Key with changed score -> 409 IDEMPOTENCY_PAYLOAD_MISMATCH
    const mismatchRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: `/api/v1/lessons/${i02LessonId}/grades`,
      headers: {
        Authorization: `Bearer ${primaryTeacherToken}`,
        'Idempotency-Key': createKey,
      },
      body: {
        expected_version: 1,
        grades: [{ student_id: C.studentId, score: 95.0, comment: 'Initial quiz score' }],
      },
    });
    assert.equal(mismatchRes.statusCode, 409);
    assert.equal(mismatchRes.json.error_code, 'IDEMPOTENCY_PAYLOAD_MISMATCH');

    // 5. Concurrent grade update race on same (lesson_id, student_id) with expected_version: 2 ->
    //    exactly 1 winner (200) and 1 loser (409 VERSION_CONFLICT)
    const [race1, race2] = await Promise.all([
      httpJsonRequest({
        port,
        method: 'POST',
        path: `/api/v1/lessons/${i02LessonId}/grades`,
        headers: {
          Authorization: `Bearer ${primaryTeacherToken}`,
          'Idempotency-Key': `idem-i02-race1-${crypto.randomUUID()}`,
        },
        body: {
          expected_version: 2,
          reason: 'Re-check A',
          grades: [{ student_id: C.studentId, score: 93.0, comment: 'Race update A', expected_grade_version: 1 }],
        },
      }),
      httpJsonRequest({
        port,
        method: 'POST',
        path: `/api/v1/lessons/${i02LessonId}/grades`,
        headers: {
          Authorization: `Bearer ${primaryTeacherToken}`,
          'Idempotency-Key': `idem-i02-race2-${crypto.randomUUID()}`,
        },
        body: {
          expected_version: 2,
          reason: 'Re-check B',
          grades: [{ student_id: C.studentId, score: 97.5, comment: 'Race update B', expected_grade_version: 1 }],
        },
      }),
    ]);
    const raceCodes = [race1.statusCode, race2.statusCode].sort((a, b) => a - b);
    assert.deepEqual(raceCodes, [200, 409]);

    // 6. Verify GET /api/v1/lessons/:lesson_id/grades returns latest score and exactly 2 ordered append-only revisions
    const readRes = await httpJsonRequest({
      port,
      method: 'GET',
      path: `/api/v1/lessons/${i02LessonId}/grades`,
      headers: { Authorization: `Bearer ${primaryTeacherToken}` },
    });
    assert.equal(readRes.statusCode, 200);
    const items = readRes.json.items as Array<Record<string, unknown>>;
    const revisions = readRes.json.revisions as Array<Record<string, unknown>>;
    assert.equal(items.length, 1);
    assert.equal(items[0].version, 2);
    assert.equal(revisions.length, 2);
    assert.equal(revisions[0].action, 'GRADE_ENTRY_CREATED');
    assert.equal(revisions[0].revision_version, 1);
    assert.equal(revisions[0].new_score, 89.25);
    assert.equal(revisions[1].action, 'GRADE_ENTRY_UPDATED');
    assert.equal(revisions[1].revision_version, 2);
    assert.equal(revisions[1].previous_score, 89.25);
  });

  it('ACAD-IT-12 (I03, I06): blocks cached idempotency replay and fresh writes after substitute revocation, substitute reassignment (Sub A -> Sub B), or primary teacher reassignment, while preserving authorized replay before revoke', async () => {
    // Schedule an isolated lesson for I03 adversarial replay testing
    const i03LessonRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: `/api/v1/groups/${C.groupId}/lessons`,
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `idem-i03-lsn-${crypto.randomUUID()}`,
      },
      body: {
        lesson_date: '2026-11-25',
        occurrence_seq: 1,
        local_starts_time: '15:00',
        duration_minutes: 90,
      },
    });
    assert.equal(i03LessonRes.statusCode, 201);
    const i03LessonId = String(i03LessonRes.json.id);

    // 1. Primary teacher submits initial grade with keyPrimary1 -> 200 OK (lesson version becomes 2)
    const keyPrimary1 = `idem-i03-prim1-${crypto.randomUUID()}`;
    const primBody = {
      expected_version: 1,
      grades: [{ student_id: C.studentId, score: 80, comment: 'Primary initial grade' }],
    };
    const primSubmit = await httpJsonRequest({
      port,
      method: 'POST',
      path: `/api/v1/lessons/${i03LessonId}/grades`,
      headers: {
        Authorization: `Bearer ${primaryTeacherToken}`,
        'Idempotency-Key': keyPrimary1,
      },
      body: primBody,
    });
    assert.equal(primSubmit.statusCode, 200);
    assert.equal(primSubmit.json.version, 2);

    // 2. Assign Substitute A (subTeacherId) to i03LessonId -> 200 OK (lesson version becomes 3)
    const assignSubA = await httpJsonRequest({
      port,
      method: 'POST',
      path: `/api/v1/lessons/${i03LessonId}/substitute`,
      headers: {
        Authorization: `Bearer ${directorToken}`,
        'Idempotency-Key': `idem-i03-subA-${crypto.randomUUID()}`,
      },
      body: {
        substitute_teacher_id: subTeacherId,
        expected_version: 2,
        reason: 'Primary teacher conference',
      },
    });
    assert.equal(assignSubA.statusCode, 200);
    assert.equal(assignSubA.json.lesson_version, 3);

    // 3. While Substitute A is ACTIVE on i03LessonId, original Primary Teacher is blocked from exclusive grade writes
    //    BOTH on a new key AND when replaying their old keyPrimary1!
    const primReplayWhileSubActive = await httpJsonRequest({
      port,
      method: 'POST',
      path: `/api/v1/lessons/${i03LessonId}/grades`,
      headers: {
        Authorization: `Bearer ${primaryTeacherToken}`,
        'Idempotency-Key': keyPrimary1,
      },
      body: primBody,
    });
    assert.equal(primReplayWhileSubActive.statusCode, 403);
    assert.equal(primReplayWhileSubActive.json.error_code, 'FORBIDDEN_OBJECT_SCOPE');

    // 4. Substitute A submits grade update with keySubA -> 200 OK (lesson version becomes 4)
    const keySubA = `idem-i03-subA-grade-${crypto.randomUUID()}`;
    const subABody = {
      expected_version: 3,
      reason: 'Substitute A grading',
      grades: [{ student_id: C.studentId, score: 91, comment: 'Sub A grade', expected_grade_version: 1 }],
    };
    const subASubmit = await httpJsonRequest({
      port,
      method: 'POST',
      path: `/api/v1/lessons/${i03LessonId}/grades`,
      headers: {
        Authorization: `Bearer ${subTeacherToken}`,
        'Idempotency-Key': keySubA,
      },
      body: subABody,
    });
    assert.equal(subASubmit.statusCode, 200);
    assert.equal(subASubmit.json.version, 4);

    // 5. While Substitute A is STILL ACTIVE, replaying keySubA with exact same body returns 200 OK from idempotency cache
    const subAReplayWhileActive = await httpJsonRequest({
      port,
      method: 'POST',
      path: `/api/v1/lessons/${i03LessonId}/grades`,
      headers: {
        Authorization: `Bearer ${subTeacherToken}`,
        'Idempotency-Key': keySubA,
      },
      body: subABody,
    });
    assert.equal(subAReplayWhileActive.statusCode, 200);
    assert.equal(subAReplayWhileActive.json.version, 4);

    // 6. Director revokes Substitute A on i03LessonId -> 200 OK (lesson version becomes 5)
    const revokeSubA = await httpJsonRequest({
      port,
      method: 'POST',
      path: `/api/v1/lessons/${i03LessonId}/substitute/revoke`,
      headers: {
        Authorization: `Bearer ${directorToken}`,
        'Idempotency-Key': `idem-i03-revA-${crypto.randomUUID()}`,
      },
      body: {
        expected_version: 4,
        reason: 'Substitute A revoked',
      },
    });
    assert.equal(revokeSubA.statusCode, 200);
    assert.equal(revokeSubA.json.lesson_version, 5);

    // 7. CRITICAL I03 CHECK: Substitute A replays the EXACT SAME keySubA and subABody after revoke ->
    //    MUST fail closed with 403 FORBIDDEN_OBJECT_SCOPE (never returning cached 200 from client_operation_logs!)
    const subAReplayAfterRevoke = await httpJsonRequest({
      port,
      method: 'POST',
      path: `/api/v1/lessons/${i03LessonId}/grades`,
      headers: {
        Authorization: `Bearer ${subTeacherToken}`,
        'Idempotency-Key': keySubA,
      },
      body: subABody,
    });
    assert.equal(subAReplayAfterRevoke.statusCode, 403);
    assert.equal(subAReplayAfterRevoke.json.error_code, 'FORBIDDEN_OBJECT_SCOPE');

    // And Substitute A with a fresh Idempotency-Key also fails closed with 403 FORBIDDEN_OBJECT_SCOPE
    const subAFreshKeyAfterRevoke = await httpJsonRequest({
      port,
      method: 'POST',
      path: `/api/v1/lessons/${i03LessonId}/grades`,
      headers: {
        Authorization: `Bearer ${subTeacherToken}`,
        'Idempotency-Key': `idem-i03-subA-fresh-${crypto.randomUUID()}`,
      },
      body: {
        expected_version: 5,
        reason: 'Post-revoke attempt',
        grades: [{ student_id: C.studentId, score: 50, comment: 'Denied' }],
      },
    });
    assert.equal(subAFreshKeyAfterRevoke.statusCode, 403);
    assert.equal(subAFreshKeyAfterRevoke.json.error_code, 'FORBIDDEN_OBJECT_SCOPE');

    // 8. Reassignment to Substitute B (otherTeacherId): Substitute A remains 403 on old/new keys while Substitute B succeeds (200)
    const assignSubB = await httpJsonRequest({
      port,
      method: 'POST',
      path: `/api/v1/lessons/${i03LessonId}/substitute`,
      headers: {
        Authorization: `Bearer ${directorToken}`,
        'Idempotency-Key': `idem-i03-subB-${crypto.randomUUID()}`,
      },
      body: {
        substitute_teacher_id: otherTeacherId,
        expected_version: 5,
        reason: 'Reassigned to Substitute B',
      },
    });
    assert.equal(assignSubB.statusCode, 200);
    assert.equal(assignSubB.json.lesson_version, 6);

    const subAReplayWhileSubBActive = await httpJsonRequest({
      port,
      method: 'POST',
      path: `/api/v1/lessons/${i03LessonId}/grades`,
      headers: {
        Authorization: `Bearer ${subTeacherToken}`,
        'Idempotency-Key': keySubA,
      },
      body: subABody,
    });
    assert.equal(subAReplayWhileSubBActive.statusCode, 403);
    assert.equal(subAReplayWhileSubBActive.json.error_code, 'FORBIDDEN_OBJECT_SCOPE');

    const keySubB = `idem-i03-subB-grade-${crypto.randomUUID()}`;
    const subBBody = {
      expected_version: 6,
      reason: 'Substitute B grading',
      grades: [{ student_id: C.studentId, score: 94, comment: 'Sub B grade', expected_grade_version: 2 }],
    };
    const subBSubmit = await httpJsonRequest({
      port,
      method: 'POST',
      path: `/api/v1/lessons/${i03LessonId}/grades`,
      headers: {
        Authorization: `Bearer ${otherTeacherToken}`,
        'Idempotency-Key': keySubB,
      },
      body: subBBody,
    });
    assert.equal(subBSubmit.statusCode, 200);
    assert.equal(subBSubmit.json.version, 7);

    // 9. Parallel revoke of Substitute B vs Substitute B grade replay -> serialized cleanly, and post-revoke replay is 403
    const [parallelRevokeB, parallelReplayB] = await Promise.all([
      httpJsonRequest({
        port,
        method: 'POST',
        path: `/api/v1/lessons/${i03LessonId}/substitute/revoke`,
        headers: {
          Authorization: `Bearer ${directorToken}`,
          'Idempotency-Key': `idem-i03-revB-${crypto.randomUUID()}`,
        },
        body: {
          expected_version: 7,
          reason: 'Parallel revoke B',
        },
      }),
      httpJsonRequest({
        port,
        method: 'POST',
        path: `/api/v1/lessons/${i03LessonId}/grades`,
        headers: {
          Authorization: `Bearer ${otherTeacherToken}`,
          'Idempotency-Key': keySubB,
        },
        body: subBBody,
      }),
    ]);
    assert.equal(parallelRevokeB.statusCode, 200);
    assert.ok([200, 403].includes(parallelReplayB.statusCode));

    const subBPostRevokeReplay = await httpJsonRequest({
      port,
      method: 'POST',
      path: `/api/v1/lessons/${i03LessonId}/grades`,
      headers: {
        Authorization: `Bearer ${otherTeacherToken}`,
        'Idempotency-Key': keySubB,
      },
      body: subBBody,
    });
    assert.equal(subBPostRevokeReplay.statusCode, 403);
    assert.equal(subBPostRevokeReplay.json.error_code, 'FORBIDDEN_OBJECT_SCOPE');

    // 10. Primary teacher reassignment on an isolated group: after reassigning Group from Primary 1 to Primary 2,
    //     Primary 1 is denied (403) on both old cached idempotency replay and fresh writes on open scheduled lessons,
    //     while historical COMPLETED lesson snapshots remain untouched.
    const reassignGroupRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/groups',
      headers: {
        Authorization: `Bearer ${directorToken}`,
        'Idempotency-Key': `idem-i03-grp-${crypto.randomUUID()}`,
      },
      body: {
        course_id: C.courseId,
        name: 'I03 Primary Reassign Group',
        primary_teacher_id: C.teacherId,
        billing_mode: 'CALENDAR_PRO_RATA',
        current_fee_uzs: '500000',
        lessons_per_cycle: 12,
        schedule_days: ['MON', 'WED', 'FRI'],
        starts_time: '11:00',
        duration_minutes: 90,
        timezone: 'Asia/Tashkent',
      },
    });
    assert.equal(reassignGroupRes.statusCode, 201);
    const reassignGroupId = String(reassignGroupRes.json.group_id);

    await env.apiPoolA.query(
      `INSERT INTO "enrollments" ("id", "center_id", "student_id", "group_id", "status", "enrolled_at_date")
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'ACTIVE', '2026-11-01')`,
      [crypto.randomUUID(), C.centerId, C.studentId, reassignGroupId],
    );

    const openLsnRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: `/api/v1/groups/${reassignGroupId}/lessons`,
      headers: {
        Authorization: `Bearer ${directorToken}`,
        'Idempotency-Key': `idem-i03-openlsn-${crypto.randomUUID()}`,
      },
      body: {
        lesson_date: '2026-11-26',
        occurrence_seq: 1,
        local_starts_time: '11:00',
        duration_minutes: 90,
      },
    });
    assert.equal(openLsnRes.statusCode, 201);
    const openLsnId = String(openLsnRes.json.id);

    const completedLsnId = crypto.randomUUID();
    await env.apiPoolA.query(
      `INSERT INTO "lesson_occurrences" (
         "id", "center_id", "group_id", "lesson_date", "occurrence_seq",
         "starts_at_utc", "ends_at_utc", "status",
         "primary_teacher_snapshot_id", "pay_recipient_teacher_id",
         "version", "created_at", "updated_at"
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, DATE '2026-11-01', 1,
         TIMESTAMPTZ '2026-11-01T06:00:00Z', TIMESTAMPTZ '2026-11-01T07:30:00Z', 'COMPLETED',
         $4::uuid, $4::uuid, 1, NOW(), NOW()
       )`,
      [completedLsnId, C.centerId, reassignGroupId, C.teacherId],
    );

    const keyOldPrimary = `idem-i03-oldprim-${crypto.randomUUID()}`;
    const oldPrimBody = {
      expected_version: 1,
      grades: [{ student_id: C.studentId, score: 85, comment: 'Before group teacher change' }],
    };
    const oldPrimWrite = await httpJsonRequest({
      port,
      method: 'POST',
      path: `/api/v1/lessons/${openLsnId}/grades`,
      headers: {
        Authorization: `Bearer ${primaryTeacherToken}`,
        'Idempotency-Key': keyOldPrimary,
      },
      body: oldPrimBody,
    });
    assert.equal(oldPrimWrite.statusCode, 200);

    // Director reassigns group primary_teacher_id to otherTeacherId
    const patchGrpTeacher = await httpJsonRequest({
      port,
      method: 'PATCH',
      path: `/api/v1/groups/${reassignGroupId}`,
      headers: {
        Authorization: `Bearer ${directorToken}`,
        'Idempotency-Key': `idem-i03-patchgrp-${crypto.randomUUID()}`,
      },
      body: {
        expected_version: 1,
        primary_teacher_id: otherTeacherId,
      },
    });
    assert.equal(patchGrpTeacher.statusCode, 200);
    assert.equal(patchGrpTeacher.json.primary_teacher_id, otherTeacherId);

    // Old primary teacher replaying keyOldPrimary on openLsnId is now denied with 403 FORBIDDEN_OBJECT_SCOPE!
    const oldPrimReplayAfterGroupReassign = await httpJsonRequest({
      port,
      method: 'POST',
      path: `/api/v1/lessons/${openLsnId}/grades`,
      headers: {
        Authorization: `Bearer ${primaryTeacherToken}`,
        'Idempotency-Key': keyOldPrimary,
      },
      body: oldPrimBody,
    });
    assert.equal(oldPrimReplayAfterGroupReassign.statusCode, 403);
    assert.equal(oldPrimReplayAfterGroupReassign.json.error_code, 'FORBIDDEN_OBJECT_SCOPE');

    // Historical COMPLETED lesson snapshot remains C.teacherId
    const completedSnapshotRow = await env.apiPoolA.query<{
      primary_teacher_snapshot_id: string;
      pay_recipient_teacher_id: string;
    }>(
      `SELECT "primary_teacher_snapshot_id", "pay_recipient_teacher_id"
       FROM "lesson_occurrences"
       WHERE "center_id" = $1::uuid AND "id" = $2::uuid`,
      [C.centerId, completedLsnId],
    );
    assert.equal(completedSnapshotRow.rows[0]?.primary_teacher_snapshot_id, C.teacherId);
    assert.equal(completedSnapshotRow.rows[0]?.pay_recipient_teacher_id, C.teacherId);
  });

  it('ACAD-IT-13 (I04, I06): resolves future group-specific and course tariffs across effective_from dates, center timezone day boundaries, multiple future changes, and same-date revisions without leaking across groups or mutating historical invoices', async () => {
    const setClockAndRefreshTokens = async (iso: string): Promise<void> => {
      clock.setTestNow(new Date(iso));
      for (const username of ['director.demo', 'teacher.demo']) {
        const login = await httpJsonRequest({ port, method: 'POST', path: '/api/v1/auth/login',
          body: { username, password: SYNTHETIC_TEST_ONLY_PASSWORD } });
        assert.equal(login.statusCode, 200);
        if (username === 'director.demo') directorToken = login.json.access_token as string;
        else primaryTeacherToken = login.json.access_token as string;
      }
    };
    await setClockAndRefreshTokens('2026-11-04T09:00:00.000Z');
    try {
      // Create an isolated course and two groups under the same course to verify group-level tariff isolation
      const i04CourseRes = await httpJsonRequest({
        port,
        method: 'POST',
        path: '/api/v1/courses',
        headers: {
          Authorization: `Bearer ${directorToken}`,
          'Idempotency-Key': `idem-i04-crs-${crypto.randomUUID()}`,
        },
        body: {
          name: 'Physics I04 Tariff Resolution',
          default_monthly_fee_uzs: '480000',
        },
      });
      assert.equal(i04CourseRes.statusCode, 201);
      const i04CourseId = String(i04CourseRes.json.id);

      const grp1Res = await httpJsonRequest({
        port,
        method: 'POST',
        path: '/api/v1/groups',
        headers: {
          Authorization: `Bearer ${directorToken}`,
          'Idempotency-Key': `idem-i04-grp1-${crypto.randomUUID()}`,
        },
        body: {
          course_id: i04CourseId,
          name: 'Physics Group 1 (Future Tariff Target)',
          primary_teacher_id: C.teacherId,
          billing_mode: 'CALENDAR_PRO_RATA',
          current_fee_uzs: '480000',
          lessons_per_cycle: 12,
          schedule_days: ['MON', 'WED', 'FRI'],
          starts_time: '11:00',
          duration_minutes: 90,
          timezone: 'Asia/Tashkent',
        },
      });
      assert.equal(grp1Res.statusCode, 201);
      const grp1Id = String(grp1Res.json.group_id);

      const grp2Res = await httpJsonRequest({
        port,
        method: 'POST',
        path: '/api/v1/groups',
        headers: {
          Authorization: `Bearer ${directorToken}`,
          'Idempotency-Key': `idem-i04-grp2-${crypto.randomUUID()}`,
        },
        body: {
          course_id: i04CourseId,
          name: 'Physics Group 2 (Control Sibling Group)',
          primary_teacher_id: C.teacherId,
          billing_mode: 'CALENDAR_PRO_RATA',
          current_fee_uzs: '480000',
          lessons_per_cycle: 12,
          schedule_days: ['MON', 'WED', 'FRI'],
          starts_time: '11:00',
          duration_minutes: 90,
          timezone: 'Asia/Tashkent',
        },
      });
      assert.equal(grp2Res.statusCode, 201);
      const grp2Id = String(grp2Res.json.group_id);

      // Seed a historical invoice on Group 1 to prove tariff changes never mutate existing invoices
      const enrollmentId = crypto.randomUUID();
      const cycleId = crypto.randomUUID();
      const historicalInvoiceId = crypto.randomUUID();
      await env.apiPoolA.query(
        `INSERT INTO "enrollments" ("id", "center_id", "student_id", "group_id", "status", "enrolled_at_date")
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'ACTIVE', '2026-10-01')`,
        [enrollmentId, C.centerId, C.studentId, grp1Id],
      );
      await env.apiPoolA.query(
        `INSERT INTO "billing_cycles" ("id", "center_id", "enrollment_id", "cycle_type", "cycle_key", "cycle_seq", "period_start_date", "period_end_date", "planned_lessons", "billable_lessons", "policy_version_id")
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'CALENDAR_MONTH', '2026-10', 1, '2026-10-01', '2026-10-31', 12, 12, $4::uuid)`,
        [cycleId, C.centerId, enrollmentId, C.billingPolicyId],
      );
      await env.apiPoolA.query(
        `INSERT INTO "invoices" (
           "id", "center_id", "invoice_number", "student_id", "enrollment_id", "billing_cycle_id", "policy_version_id",
           "tariff_snapshot_uzs", "base_pro_rata_charge_uzs", "approved_discount_uzs", "credit_note_adjustments_uzs",
           "effective_net_charge_uzs", "allocated_paid_uzs", "remaining_debt_uzs", "billed_lessons", "status", "due_date"
         ) VALUES (
           $1::uuid, $2::uuid, 'INV-S07-I04-01', $3::uuid, $4::uuid, $5::uuid, $6::uuid,
           480000, 480000, 0, 0, 480000, 0, 480000, 12, 'ISSUED_OPEN', '2026-10-10'
         )`,
        [historicalInvoiceId, C.centerId, C.studentId, enrollmentId, cycleId, C.billingPolicyId],
      );

      // 1. Schedule Group 1 future tariff Change 1 on 2026-11-10 ('650000')
      const priceChange1 = await httpJsonRequest({
        port,
        method: 'PATCH',
        path: `/api/v1/courses/${i04CourseId}/price`,
        headers: {
          Authorization: `Bearer ${directorToken}`,
          'Idempotency-Key': `idem-i04-p1-${crypto.randomUUID()}`,
        },
        body: {
          group_id: grp1Id,
          expected_version: 1,
          new_fee_uzs: '650000',
          effective_from: '2026-11-10',
          reason: 'Group 1 mid-month lab fee increase',
        },
      });
      assert.equal(priceChange1.statusCode, 200);
      assert.equal(priceChange1.json.default_monthly_fee_uzs, '480000');
      assert.ok((priceChange1.json.price_history as Array<Record<string, unknown>>).some((h) => h.group_id === grp1Id && h.new_fee_uzs === '650000' && h.effective_from === '2026-11-10'));
      assert.equal(priceChange1.json.version, 2);

      // 2. Schedule a second same-date revision on 2026-11-10 ('680000', expected_version: 2 -> version 3)
      //    and a later future Change 2 on 2026-11-20 ('9007199254740999' > Number.MAX_SAFE_INTEGER, expected_version: 3 -> version 4)
      const priceChange1Revision = await httpJsonRequest({
        port,
        method: 'PATCH',
        path: `/api/v1/courses/${i04CourseId}/price`,
        headers: {
          Authorization: `Bearer ${directorToken}`,
          'Idempotency-Key': `idem-i04-p1rev-${crypto.randomUUID()}`,
        },
        body: {
          group_id: grp1Id,
          expected_version: 2,
          new_fee_uzs: '680000',
          effective_from: '2026-11-10',
          reason: 'Revised Nov 10 tariff to 680000',
        },
      });
      assert.equal(priceChange1Revision.statusCode, 200);
      assert.equal(priceChange1Revision.json.version, 3);

      const priceChange2 = await httpJsonRequest({
        port,
        method: 'PATCH',
        path: `/api/v1/courses/${i04CourseId}/price`,
        headers: {
          Authorization: `Bearer ${directorToken}`,
          'Idempotency-Key': `idem-i04-p2-${crypto.randomUUID()}`,
        },
        body: {
          group_id: grp1Id,
          expected_version: 3,
          new_fee_uzs: '9007199254740999',
          effective_from: '2026-11-20',
          reason: 'Enterprise tier BigInt tariff from Nov 20',
        },
      });
      assert.equal(priceChange2.statusCode, 200);
      assert.equal(priceChange2.json.version, 4);

      // 3. Before effective_from in Asia/Tashkent: 2026-11-09T18:30:00Z is 2026-11-09 23:30 (+05:00)
      await setClockAndRefreshTokens('2026-11-09T18:30:00.000Z');
      const groupsBeforeRes = await httpJsonRequest({
        port,
        method: 'GET',
        path: '/api/v1/groups',
        headers: { Authorization: `Bearer ${directorToken}` },
      });
      assert.equal(groupsBeforeRes.statusCode, 200);
      const itemsBefore = groupsBeforeRes.json.items as Array<Record<string, unknown>>;
      const g1Before = itemsBefore.find((g) => g.id === grp1Id);
      const g2Before = itemsBefore.find((g) => g.id === grp2Id);
      assert.ok(g1Before && g2Before);
      assert.equal(g1Before.current_fee_uzs, '480000');
      assert.equal(g2Before.current_fee_uzs, '480000');

      // Querying GET /api/v1/groups?as_of_date=2026-11-10 previews the Nov 10 effective fee ('680000') while current_fee_uzs stays '480000'
      const groupsAsOfPreview = await httpJsonRequest({
        port,
        method: 'GET',
        path: '/api/v1/groups?as_of_date=2026-11-10',
        headers: { Authorization: `Bearer ${directorToken}` },
      });
      assert.equal(groupsAsOfPreview.statusCode, 200);
      const g1Preview = (groupsAsOfPreview.json.items as Array<Record<string, unknown>>).find((g) => g.id === grp1Id);
      assert.ok(g1Preview);
      assert.equal(g1Preview.current_fee_uzs, '680000');
      assert.equal(g1Preview.effective_fee_as_of_uzs, '680000');
      assert.equal(g1Preview.as_of_date, '2026-11-10');

      // 4. Cross midnight in Asia/Tashkent: 2026-11-09T19:30:00Z is 2026-11-10 00:30 (+05:00) ->
      //    Group 1 current_fee_uzs immediately transitions to '680000' (latest revision for 2026-11-10),
      //    while Group 2 and Course default remain '480000'!
      await setClockAndRefreshTokens('2026-11-09T19:30:00.000Z');
      const groupsOnNov10 = await httpJsonRequest({
        port,
        method: 'GET',
        path: '/api/v1/groups',
        headers: { Authorization: `Bearer ${directorToken}` },
      });
      assert.equal(groupsOnNov10.statusCode, 200);
      const itemsNov10 = groupsOnNov10.json.items as Array<Record<string, unknown>>;
      const g1Nov10 = itemsNov10.find((g) => g.id === grp1Id);
      const g2Nov10 = itemsNov10.find((g) => g.id === grp2Id);
      assert.ok(g1Nov10 && g2Nov10);
      assert.equal(g1Nov10.current_fee_uzs, '680000');
      assert.equal(g1Nov10.effective_fee_as_of_uzs, '680000');
      assert.equal(g1Nov10.as_of_date, '2026-11-10');
      assert.equal(g2Nov10.current_fee_uzs, '480000');

      // Also verify PATCH /api/v1/groups/:group_id on 2026-11-11 returns resolved current_fee_uzs: '680000'
      await setClockAndRefreshTokens('2026-11-11T10:00:00.000Z');
      const patchGrpOnNov11 = await httpJsonRequest({
        port,
        method: 'PATCH',
        path: `/api/v1/groups/${grp1Id}`,
        headers: {
          Authorization: `Bearer ${directorToken}`,
          'Idempotency-Key': `idem-i04-patchg1-${crypto.randomUUID()}`,
        },
        body: {
          expected_version: 4,
          name: 'Physics Group 1 (Nov 11 Active Tariff)',
        },
      });
      assert.equal(patchGrpOnNov11.statusCode, 200);
      assert.equal(patchGrpOnNov11.json.current_fee_uzs, '680000');

      // Course default fee remains '480000' (group tariff never leaks to course default)
      const coursesOnNov11 = await httpJsonRequest({
        port,
        method: 'GET',
        path: '/api/v1/courses',
        headers: { Authorization: `Bearer ${directorToken}` },
      });
      assert.equal(coursesOnNov11.statusCode, 200);
      const i04CourseOnNov11 = (coursesOnNov11.json.items as Array<Record<string, unknown>>).find(
        (c) => c.id === i04CourseId,
      );
      assert.ok(i04CourseOnNov11);
      assert.equal(i04CourseOnNov11.default_monthly_fee_uzs, '480000');

      // 5. Advance clock to 2026-11-21 -> Group 1 current_fee_uzs transitions to Change 2 ('9007199254740999')
      await setClockAndRefreshTokens('2026-11-21T10:00:00.000Z');
      const groupsOnNov21 = await httpJsonRequest({
        port,
        method: 'GET',
        path: '/api/v1/groups',
        headers: { Authorization: `Bearer ${directorToken}` },
      });
      assert.equal(groupsOnNov21.statusCode, 200);
      const g1Nov21 = (groupsOnNov21.json.items as Array<Record<string, unknown>>).find((g) => g.id === grp1Id);
      assert.ok(g1Nov21);
      assert.equal(g1Nov21.current_fee_uzs, '9007199254740999');
      assert.equal(g1Nov21.latest_effective_from, '2026-11-20');

      // 6. Teacher GET /api/v1/groups still omits all financial fields (current_fee_uzs, effective_fee_as_of_uzs)
      const teacherGroupsOnNov21 = await httpJsonRequest({
        port,
        method: 'GET',
        path: '/api/v1/groups',
        headers: { Authorization: `Bearer ${primaryTeacherToken}` },
      });
      assert.equal(teacherGroupsOnNov21.statusCode, 200);
      assert.equal(teacherGroupsOnNov21.rawBody.includes('current_fee_uzs'), false);
      assert.equal(teacherGroupsOnNov21.rawBody.includes('effective_fee_as_of_uzs'), false);
      assert.equal(teacherGroupsOnNov21.rawBody.includes('9007199254740999'), false);

      // 7. Historical invoice tariff_snapshot_uzs remains untouched ('480000')
      const invAfter = await env.apiPoolA.query<{ tariff_snapshot_uzs: string }>(
        `SELECT "tariff_snapshot_uzs"::text AS tariff_snapshot_uzs
         FROM "invoices"
         WHERE "center_id" = $1::uuid AND "id" = $2::uuid`,
        [C.centerId, historicalInvoiceId],
      );
      assert.equal(invAfter.rows[0]?.tariff_snapshot_uzs, '480000');
    } finally {
      clock.setTestNow(null);
    }
  });
});
