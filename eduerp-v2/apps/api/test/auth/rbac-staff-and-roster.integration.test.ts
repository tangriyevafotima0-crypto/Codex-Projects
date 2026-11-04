import * as assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { createApiApplication } from '../../src/application';
import { ClockService } from '../../src/auth/clock.service';
import { hashPassword } from '../../src/auth/password';
import { RequestLogEntry } from '../../src/common/request-id.middleware';
import { loadApiEnv } from '../../src/config/env';
import {
  executeSyntheticSeed,
  SYNTHETIC_DEMO_CENTER_A,
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
  readonly method: 'GET' | 'POST' | 'PATCH';
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

describe('Stage 05 RBAC Matrix (OWNER-20261104-01), Keyed Staff Idempotency (G05), Atomic Revocation & Time-Scoped Substitute Roster (G04) (AUTH-IT-07..13, 17)', () => {
  let env: EphemeralDatabaseEnvironment;
  let app: Awaited<ReturnType<typeof createApiApplication>>;
  let port: number;
  let clock: ClockService;
  const capturedLogs: RequestLogEntry[] = [];
  const C = SYNTHETIC_DEMO_CENTER_A;

  let directorToken: string;
  let adminToken: string;
  let teacherAToken: string;

  before(async () => {
    env = await createEphemeralTestDbEnv();
    await executeSyntheticSeed(env.apiPoolA, C, {
      ...process.env,
      NODE_ENV: 'test',
      BOT_OUTBOUND_ENABLED: 'false',
    });

    const config = loadApiEnv({
      NODE_ENV: 'test',
      LOG_LEVEL: 'info',
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

    app = await createApiApplication(config, (entry) => capturedLogs.push(entry));
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
    teacherAToken = await loginAs('teacher.demo');
  });

  after(async () => {
    if (app) {
      await app.close();
    }
    if (env) {
      await env.cleanup();
    }
  });

  it('AUTH-IT-07: Director creates DIRECTOR, ADMIN, and TEACHER accounts with must_change_password=true and zero password/phone leakage in response', async () => {
    for (const role of ['DIRECTOR', 'ADMIN', 'TEACHER'] as const) {
      const res = await httpJsonRequest({
        port,
        method: 'POST',
        path: '/api/v1/staff',
        headers: {
          Authorization: `Bearer ${directorToken}`,
          'Idempotency-Key': `idem-dir-create-${role}-${crypto.randomUUID()}`,
        },
        body: {
          full_name: `Director Created ${role}`,
          login_username: `dir.created.${role.toLowerCase()}`,
          role,
          phone_e164: '+998901234567',
          initial_password: 'InitialStaffPass_2026!',
        },
      });
      assert.equal(res.statusCode, 201);
      assert.equal(res.json.role, role);
      assert.equal(res.json.status, 'ACTIVE');
      assert.equal('password_hash' in res.json, false);
      assert.equal('phone_e164' in res.json, false);
      assert.equal(res.rawBody.includes('InitialStaffPass_2026!'), false);
    }
  });

  it('AUTH-IT-08 (OWNER-20261104-01 & G05): Admin creates TEACHER only, keyed idempotency rejects changed phone_e164 or initial_password with 409, and Teacher/Admin role boundaries hold', async () => {
    const createKey = `idem-adm-create-teacher-${crypto.randomUUID()}`;
    const adminCreateTeacher = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/staff',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': createKey,
      },
      body: {
        full_name: 'Admin Created Teacher',
        login_username: 'adm.created.teacher',
        role: 'TEACHER',
        phone_e164: '+998901112233',
        initial_password: 'InitialTeacherPass_2026!',
      },
    });
    assert.equal(adminCreateTeacher.statusCode, 201);
    assert.equal(adminCreateTeacher.json.role, 'TEACHER');

    // Exact replay with identical phone and initial_password returns cached 201
    const exactReplay = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/staff',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': createKey,
      },
      body: {
        full_name: 'Admin Created Teacher',
        login_username: 'adm.created.teacher',
        role: 'TEACHER',
        phone_e164: '+998901112233',
        initial_password: 'InitialTeacherPass_2026!',
      },
    });
    assert.equal(exactReplay.statusCode, 201);
    assert.equal(exactReplay.json.id, adminCreateTeacher.json.id);

    // G05: Same Idempotency-Key with a DIFFERENT phone_e164 returns 409 IDEMPOTENCY_PAYLOAD_MISMATCH
    const differentPhoneReplay = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/staff',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': createKey,
      },
      body: {
        full_name: 'Admin Created Teacher',
        login_username: 'adm.created.teacher',
        role: 'TEACHER',
        phone_e164: '+998909998877',
        initial_password: 'InitialTeacherPass_2026!',
      },
    });
    assert.equal(differentPhoneReplay.statusCode, 409);
    assert.equal(differentPhoneReplay.json.error_code, 'IDEMPOTENCY_PAYLOAD_MISMATCH');

    // G05: Same Idempotency-Key with a DIFFERENT initial_password returns 409 IDEMPOTENCY_PAYLOAD_MISMATCH
    const differentPasswordReplay = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/staff',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': createKey,
      },
      body: {
        full_name: 'Admin Created Teacher',
        login_username: 'adm.created.teacher',
        role: 'TEACHER',
        phone_e164: '+998901112233',
        initial_password: 'DifferentInitialPassword_2026!',
      },
    });
    assert.equal(differentPasswordReplay.statusCode, 409);
    assert.equal(differentPasswordReplay.json.error_code, 'IDEMPOTENCY_PAYLOAD_MISMATCH');

    // Admin attempting to create ADMIN or DIRECTOR is rejected with 403 FORBIDDEN_ROLE
    for (const forbiddenRole of ['ADMIN', 'DIRECTOR'] as const) {
      const res = await httpJsonRequest({
        port,
        method: 'POST',
        path: '/api/v1/staff',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Idempotency-Key': `idem-adm-forbid-${forbiddenRole}-${crypto.randomUUID()}`,
        },
        body: {
          full_name: `Forbidden ${forbiddenRole}`,
          login_username: `adm.forbidden.${forbiddenRole.toLowerCase()}`,
          role: forbiddenRole,
          initial_password: 'InitialStaffPass_2026!',
        },
      });
      assert.equal(res.statusCode, 403);
      assert.equal(res.json.error_code, 'FORBIDDEN_ROLE');
    }

    // Teacher attempting to create any staff account is rejected with 403 FORBIDDEN_ROLE
    const teacherCreate = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/staff',
      headers: {
        Authorization: `Bearer ${teacherAToken}`,
        'Idempotency-Key': `idem-tchr-create-${crypto.randomUUID()}`,
      },
      body: {
        full_name: 'Teacher Created Staff',
        login_username: 'tchr.created',
        role: 'TEACHER',
        initial_password: 'InitialStaffPass_2026!',
      },
    });
    assert.equal(teacherCreate.statusCode, 403);
    assert.equal(teacherCreate.json.error_code, 'FORBIDDEN_ROLE');

    // Unconfirmed Admin actions (GET /api/v1/staff, PATCH /api/v1/staff/:id/status, POST /api/v1/staff/:id/sessions/revoke) remain denied (403)
    const adminList = await httpJsonRequest({
      port,
      method: 'GET',
      path: '/api/v1/staff',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(adminList.statusCode, 403);
    assert.equal(adminList.json.error_code, 'POLICY_DECISION_NOT_CONFIRMED');

    const adminStatusPatch = await httpJsonRequest({
      port,
      method: 'PATCH',
      path: `/api/v1/staff/${C.teacherId}/status`,
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `idem-adm-patch-${crypto.randomUUID()}`,
      },
      body: { status: 'DEACTIVATED', role: 'TEACHER', reason: 'Admin attempt', expected_version: 1 },
    });
    assert.equal(adminStatusPatch.statusCode, 403);
    assert.equal(adminStatusPatch.json.error_code, 'FORBIDDEN_ROLE');

    const adminRevoke = await httpJsonRequest({
      port,
      method: 'POST',
      path: `/api/v1/staff/${C.teacherId}/sessions/revoke`,
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `idem-adm-revoke-${crypto.randomUUID()}`,
      },
      body: { reason: 'Admin unauthorized revoke' },
    });
    assert.equal(adminRevoke.statusCode, 403);
    assert.equal(adminRevoke.json.error_code, 'POLICY_DECISION_NOT_CONFIRMED');
  });

  it('AUTH-IT-09: enforces HTTP last-Director protection and blocks self-deactivation of sole active Director', async () => {
    const extraDirRes = await env.apiPoolA.query<{ id: string; version: number }>(
      `SELECT "id"::text AS id, "version" FROM "staff_users" WHERE "center_id" = $1::uuid AND "login_username" = 'dir.created.director'`,
      [C.centerId],
    );
    if (extraDirRes.rows[0]) {
      const deactivateExtra = await httpJsonRequest({
        port,
        method: 'PATCH',
        path: `/api/v1/staff/${extraDirRes.rows[0].id}/status`,
        headers: {
          Authorization: `Bearer ${directorToken}`,
          'Idempotency-Key': `idem-deact-extra-dir-${crypto.randomUUID()}`,
        },
        body: {
          status: 'DEACTIVATED',
          role: 'DIRECTOR',
          reason: 'Cleanup extra director for sole director test',
          expected_version: extraDirRes.rows[0].version,
        },
      });
      assert.equal(deactivateExtra.statusCode, 200);
    }

    const selfDeactivate = await httpJsonRequest({
      port,
      method: 'PATCH',
      path: `/api/v1/staff/${C.directorId}/status`,
      headers: {
        Authorization: `Bearer ${directorToken}`,
        'Idempotency-Key': `idem-self-deact-${crypto.randomUUID()}`,
      },
      body: {
        status: 'DEACTIVATED',
        role: 'DIRECTOR',
        reason: 'Attempt self deactivate last director',
        expected_version: 1,
      },
    });
    assert.equal(selfDeactivate.statusCode, 422);
    assert.equal(selfDeactivate.json.error_code, 'LAST_DIRECTOR_CANNOT_BE_DEACTIVATED');
  });

  it('AUTH-IT-10: atomic role/status change and forced session revoke immediately invalidate existing JWTs', async () => {
    const targetStaffId = crypto.randomUUID();
    const targetHash = await hashPassword(SYNTHETIC_TEST_ONLY_PASSWORD, { N: 16384 });
    await env.apiPoolA.query(
      `INSERT INTO "staff_users" ("id", "center_id", "role", "full_name", "login_username", "password_hash", "must_change_password", "status", "version")
       VALUES ($1::uuid, $2::uuid, 'ADMIN', 'Role Change Target', 'role.change.target', $3, FALSE, 'ACTIVE', 1)`,
      [targetStaffId, C.centerId, targetHash],
    );

    const targetLogin = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/auth/login',
      body: { username: 'role.change.target', password: SYNTHETIC_TEST_ONLY_PASSWORD },
    });
    assert.equal(targetLogin.statusCode, 200);
    const targetAccessToken = targetLogin.json.access_token as string;

    const roleUpdate = await httpJsonRequest({
      port,
      method: 'PATCH',
      path: `/api/v1/staff/${targetStaffId}/status`,
      headers: {
        Authorization: `Bearer ${directorToken}`,
        'Idempotency-Key': `idem-role-upd-${crypto.randomUUID()}`,
      },
      body: {
        status: 'ACTIVE',
        role: 'TEACHER',
        reason: 'Reassigned from Admin to Teacher',
        expected_version: 1,
      },
    });
    assert.equal(roleUpdate.statusCode, 200);
    assert.equal(roleUpdate.json.role, 'TEACHER');
    assert.equal(roleUpdate.json.version, 2);

    const staleAdminCreate = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/staff',
      headers: {
        Authorization: `Bearer ${targetAccessToken}`,
        'Idempotency-Key': `idem-stale-admin-${crypto.randomUUID()}`,
      },
      body: {
        full_name: 'Stale Token Attempt',
        login_username: 'stale.attempt',
        role: 'TEACHER',
        initial_password: 'InitialStaffPass_2026!',
      },
    });
    assert.equal(staleAdminCreate.statusCode, 401);

    const relogin = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/auth/login',
      body: { username: 'role.change.target', password: SYNTHETIC_TEST_ONLY_PASSWORD },
    });
    assert.equal(relogin.statusCode, 200);

    const forceRevoke = await httpJsonRequest({
      port,
      method: 'POST',
      path: `/api/v1/staff/${targetStaffId}/sessions/revoke`,
      headers: {
        Authorization: `Bearer ${directorToken}`,
        'Idempotency-Key': `idem-force-revoke-${crypto.randomUUID()}`,
      },
      body: { reason: 'Security audit session reset' },
    });
    assert.equal(forceRevoke.statusCode, 200);
    assert.equal(forceRevoke.json.staff_id, targetStaffId);
    assert.equal(forceRevoke.json.revoked_sessions_count, 1);
  });

  it('AUTH-IT-11, AUTH-IT-12, AUTH-IT-13 & AUTH-IT-17 (G04): enforces Teacher own group vs current-day center-timezone substitute scope (denying past/future/revoked substitute and other teacher groups with 403) and zero phone/financial leakage', async () => {
    const enrAId = crypto.randomUUID();
    await env.apiPoolA.query(
      `INSERT INTO "enrollments" ("id", "center_id", "student_id", "group_id", "status", "enrolled_at_date")
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'ACTIVE', '2026-11-01')`,
      [enrAId, C.centerId, C.studentId, C.groupId],
    );

    const teacherBId = crypto.randomUUID();
    const groupBId = crypto.randomUUID();
    const studentBId = crypto.randomUUID();
    const enrBId = crypto.randomUUID();
    const tHash = await hashPassword(SYNTHETIC_TEST_ONLY_PASSWORD, { N: 16384 });

    await env.apiPoolA.query(
      `INSERT INTO "staff_users" ("id", "center_id", "role", "full_name", "login_username", "phone_e164", "password_hash", "must_change_password", "status")
       VALUES ($1::uuid, $2::uuid, 'TEACHER', 'Teacher B Other', 'teacher.b.other', '+998907778899', $3, FALSE, 'ACTIVE')`,
      [teacherBId, C.centerId, tHash],
    );
    await env.apiPoolA.query(
      `INSERT INTO "course_groups" ("id", "center_id", "course_id", "name", "primary_teacher_id", "billing_mode", "current_fee_uzs", "lessons_per_cycle", "schedule_days_json", "starts_time", "duration_minutes", "timezone", "status")
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'ENGLISH-G2-TEACHER-B', $4::uuid, 'CALENDAR_PRO_RATA', 550000, 12, '["TUE","THU","SAT"]'::jsonb, '15:00', 90, 'Asia/Tashkent', 'ACTIVE')`,
      [groupBId, C.centerId, C.courseId, teacherBId],
    );
    await env.apiPoolA.query(
      `INSERT INTO "students" ("id", "center_id", "student_code", "full_name", "normalized_name", "status")
       VALUES ($1::uuid, $2::uuid, 'STU-B-0099', 'Secret Student B', 'secret student b', 'ACTIVE')`,
      [studentBId, C.centerId],
    );
    await env.apiPoolA.query(
      `INSERT INTO "enrollments" ("id", "center_id", "student_id", "group_id", "status", "enrolled_at_date")
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'ACTIVE', '2026-11-01')`,
      [enrBId, C.centerId, studentBId, groupBId],
    );

    // 1. Teacher A can view own group's safe roster (200), containing ONLY safe TeacherStudentView fields
    const ownRoster = await httpJsonRequest({
      port,
      method: 'GET',
      path: `/api/v1/groups/${C.groupId}/roster?search=ali&limit=10`,
      headers: { Authorization: `Bearer ${teacherAToken}` },
    });
    assert.equal(ownRoster.statusCode, 200);
    assert.equal(ownRoster.json.group_id, C.groupId);
    const rosterItems = ownRoster.json.roster as Array<Record<string, unknown>>;
    assert.equal(rosterItems.length, 1);
    assert.deepEqual(Object.keys(rosterItems[0]).sort(), [
      'enrollment_id',
      'enrollment_status',
      'full_name',
      'student_code',
      'student_id',
    ]);
    assert.equal(ownRoster.rawBody.includes('+998'), false);
    assert.equal(ownRoster.rawBody.includes('debt'), false);

    // 2. Teacher A attempting to access Teacher B's group without substitute assignment -> 403 FORBIDDEN_OBJECT_SCOPE
    const otherGroupAttempt = await httpJsonRequest({
      port,
      method: 'GET',
      path: `/api/v1/groups/${groupBId}/roster`,
      headers: { Authorization: `Bearer ${teacherAToken}` },
    });
    assert.equal(otherGroupAttempt.statusCode, 403);
    assert.equal(otherGroupAttempt.json.error_code, 'FORBIDDEN_OBJECT_SCOPE');

    // 3. G04 Temporal Substitute Entitlement Test:
    // Fix ClockService to 2026-11-03T20:30:00Z (which is 2026-11-04 01:30:00+05:00 in Asia/Tashkent!)
    clock.setTestNow(new Date('2026-11-03T20:30:00.000Z'));
    try {
      const pastLessonId = crypto.randomUUID();
      const futureLessonId = crypto.randomUUID();
      const todayLessonId = crypto.randomUUID();
      const pastSubId = crypto.randomUUID();
      const futureSubId = crypto.randomUUID();
      const todaySubId = crypto.randomUUID();

      // Insert PAST (2026-11-03) and FUTURE (2026-11-05) lessons with ACTIVE substitute assignments for Teacher A
      await env.apiPoolA.query(
        `INSERT INTO "lesson_occurrences" ("id", "center_id", "group_id", "lesson_date", "occurrence_seq", "starts_at_utc", "ends_at_utc", "status", "primary_teacher_snapshot_id", "pay_recipient_teacher_id")
         VALUES
           ($1::uuid, $3::uuid, $4::uuid, '2026-11-03', 1, '2026-11-03T10:00:00Z', '2026-11-03T11:30:00Z', 'COMPLETED', $5::uuid, $6::uuid),
           ($2::uuid, $3::uuid, $4::uuid, '2026-11-05', 1, '2026-11-05T10:00:00Z', '2026-11-05T11:30:00Z', 'SCHEDULED', $5::uuid, $6::uuid)`,
        [pastLessonId, futureLessonId, C.centerId, groupBId, teacherBId, C.teacherId],
      );
      await env.apiPoolA.query(
        `INSERT INTO "substitute_assignments" ("id", "center_id", "lesson_id", "original_teacher_id", "substitute_teacher_id", "assigned_by_admin_id", "reason", "status", "pay_share_policy_snapshot")
         VALUES
           ($1::uuid, $3::uuid, $4::uuid, $6::uuid, $7::uuid, $8::uuid, 'Past substitute', 'ACTIVE', 'PER_LESSON_SUBSTITUTE'),
           ($2::uuid, $3::uuid, $5::uuid, $6::uuid, $7::uuid, $8::uuid, 'Future substitute', 'ACTIVE', 'PER_LESSON_SUBSTITUTE')`,
        [pastSubId, futureSubId, C.centerId, pastLessonId, futureLessonId, teacherBId, C.teacherId, C.adminId],
      );

      // Even with ACTIVE past and future substitute rows, Teacher A MUST be denied (403) on 2026-11-04 (Asia/Tashkent)!
      const pastFutureDenied = await httpJsonRequest({
        port,
        method: 'GET',
        path: `/api/v1/groups/${groupBId}/roster`,
        headers: { Authorization: `Bearer ${teacherAToken}` },
      });
      assert.equal(pastFutureDenied.statusCode, 403);
      assert.equal(pastFutureDenied.json.error_code, 'FORBIDDEN_OBJECT_SCOPE');

      // Now insert TODAY's lesson (2026-11-04 in Asia/Tashkent) with ACTIVE substitute assignment -> ALLOWED (200)!
      await env.apiPoolA.query(
        `INSERT INTO "lesson_occurrences" ("id", "center_id", "group_id", "lesson_date", "occurrence_seq", "starts_at_utc", "ends_at_utc", "status", "primary_teacher_snapshot_id", "pay_recipient_teacher_id")
         VALUES ($1::uuid, $2::uuid, $3::uuid, '2026-11-04', 1, '2026-11-04T10:00:00Z', '2026-11-04T11:30:00Z', 'SCHEDULED', $4::uuid, $5::uuid)`,
        [todayLessonId, C.centerId, groupBId, teacherBId, C.teacherId],
      );
      await env.apiPoolA.query(
        `INSERT INTO "substitute_assignments" ("id", "center_id", "lesson_id", "original_teacher_id", "substitute_teacher_id", "assigned_by_admin_id", "reason", "status", "pay_share_policy_snapshot")
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, 'Today substitute', 'ACTIVE', 'PER_LESSON_SUBSTITUTE')`,
        [todaySubId, C.centerId, todayLessonId, teacherBId, C.teacherId, C.adminId],
      );

      const todaySubAllowed = await httpJsonRequest({
        port,
        method: 'GET',
        path: `/api/v1/groups/${groupBId}/roster`,
        headers: { Authorization: `Bearer ${teacherAToken}` },
      });
      assert.equal(todaySubAllowed.statusCode, 200);

      // Revoking today's substitute assignment immediately denies access (403)
      await env.apiPoolA.query(
        `UPDATE "substitute_assignments" SET "status" = 'REVOKED', "revoked_at" = NOW(), "version" = "version" + 1 WHERE "id" = $1::uuid`,
        [todaySubId],
      );

      const todaySubRevoked = await httpJsonRequest({
        port,
        method: 'GET',
        path: `/api/v1/groups/${groupBId}/roster`,
        headers: { Authorization: `Bearer ${teacherAToken}` },
      });
      assert.equal(todaySubRevoked.statusCode, 403);
      assert.equal(todaySubRevoked.json.error_code, 'FORBIDDEN_OBJECT_SCOPE');
    } finally {
      clock.setTestNow(null);
    }

    // 4. Non-existent or foreign center group UUID returns 404 NOT_FOUND
    const foreignGroupAttempt = await httpJsonRequest({
      port,
      method: 'GET',
      path: '/api/v1/groups/22222222-3333-4444-8555-000000000030/roster',
      headers: { Authorization: `Bearer ${teacherAToken}` },
    });
    assert.equal(foreignGroupAttempt.statusCode, 404);
    assert.equal(foreignGroupAttempt.json.error_code, 'NOT_FOUND');

    // 5. Verify audit_logs and request logs never contain passwords, password hashes, tokens, or raw phone numbers
    const auditDump = await env.apiPoolA.query<{ dump: string }>(
      `SELECT json_agg(row_to_json(a))::text AS dump FROM "audit_logs" a`,
    );
    const rawAuditText = auditDump.rows[0]?.dump ?? '';
    assert.equal(rawAuditText.includes(SYNTHETIC_TEST_ONLY_PASSWORD), false);
    assert.equal(rawAuditText.includes('$scrypt$'), false);
    assert.equal(rawAuditText.includes('+99890'), false);

    const serializedLogs = JSON.stringify(capturedLogs);
    assert.equal(serializedLogs.includes(SYNTHETIC_TEST_ONLY_PASSWORD), false);
    assert.equal(serializedLogs.includes(directorToken), false);
    assert.equal(serializedLogs.includes(teacherAToken), false);
  });
});
