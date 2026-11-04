import * as assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { createApiApplication } from '../../src/application';
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

describe('Stage 06 Students, Guardians, Phone Revocation, Enrollments, Transfers & Duplicate Warnings (STU-IT-01..STU-IT-10 / T06.01..T06.04)', () => {
  let env: EphemeralDatabaseEnvironment;
  let app: Awaited<ReturnType<typeof createApiApplication>>;
  let port: number;
  const C = SYNTHETIC_DEMO_CENTER_A;
  const CB = SYNTHETIC_DEMO_CENTER_B;

  let adminToken: string;
  let teacherToken: string;

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
    });

    app = await createApiApplication(config);
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

    await loginAs('director.demo');
    adminToken = await loginAs('admin.demo');
    teacherToken = await loginAs('teacher.demo');
  });

  after(async () => {
    if (app) {
      await app.close();
    }
    if (env) {
      await env.cleanup();
    }
  });

  it('STU-IT-01: enforces RBAC on Student/Guardian/Enrollment endpoints (Director/Admin allowed; Teacher 403 FORBIDDEN_ROLE on list/profile/write; cross-center payload tampering rejected)', async () => {
    // Teacher denied on GET /api/v1/students, GET /api/v1/students/:id, POST /api/v1/students, GET /api/v1/students/duplicates
    for (const call of [
      { method: 'GET' as const, path: '/api/v1/students' },
      { method: 'GET' as const, path: `/api/v1/students/${C.studentId}` },
      { method: 'GET' as const, path: '/api/v1/students/duplicates?full_name=Ali+Valiyev' },
      {
        method: 'POST' as const,
        path: '/api/v1/students',
        headers: { 'Idempotency-Key': `idem-tchr-stu-${crypto.randomUUID()}` },
        body: {
          student_full_name: 'Teacher Attempt',
          guardian_full_name: 'Guardian Attempt',
          guardian_phone_e164: '+998901239988',
          group_id: C.groupId,
          initial_status: 'TRIAL',
          enrolled_at_date: '2026-11-04',
        },
      },
    ]) {
      const res = await httpJsonRequest({
        port,
        method: call.method,
        path: call.path,
        headers: {
          Authorization: `Bearer ${teacherToken}`,
          ...(call.headers ?? {}),
        },
        body: call.body,
      });
      assert.equal(res.statusCode, 403);
      assert.equal(res.json.error_code, 'FORBIDDEN_ROLE');
    }

    // Client payload tampering with center_id is rejected with 400 VALIDATION_ERROR
    const tamperRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/students',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `idem-tamper-stu-${crypto.randomUUID()}`,
      },
      body: {
        student_full_name: 'Tampered Student',
        guardian_full_name: 'Tampered Guardian',
        guardian_phone_e164: '+998901239977',
        group_id: C.groupId,
        initial_status: 'TRIAL',
        enrolled_at_date: '2026-11-04',
        center_id: CB.centerId,
      },
    });
    assert.equal(tamperRes.statusCode, 400);
    assert.equal(tamperRes.json.error_code, 'VALIDATION_ERROR');
  });

  it('STU-IT-02 (T06.01): quick registration creates student+guardian+enrollment atomically, concurrent same-key requests create 1 student, different payload returns 409, and mid-tx fault rolls back all tables', async () => {
    const idemKey = `idem-quick-conc-${crypto.randomUUID()}`;
    const payload = {
      student_full_name: "O‘ktam   O'g'li Karimov",
      birth_date: '2011-05-14',
      guardian_full_name: 'Karim Ota',
      guardian_phone_e164: '998 (90) 555-44-33',
      relationship: 'FATHER',
      group_id: C.groupId,
      initial_status: 'TRIAL',
      enrolled_at_date: '2026-11-04',
    };

    // Concurrent calls with the same Idempotency-Key produce exactly ONE student, ONE guardian, and ONE enrollment
    const [resA, resB] = await Promise.all([
      httpJsonRequest({
        port,
        method: 'POST',
        path: '/api/v1/students',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Idempotency-Key': idemKey,
        },
        body: payload,
      }),
      httpJsonRequest({
        port,
        method: 'POST',
        path: '/api/v1/students',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Idempotency-Key': idemKey,
        },
        body: payload,
      }),
    ]);

    assert.equal(resA.statusCode, 201);
    assert.equal(resB.statusCode, 201);
    assert.equal(resA.json.student_id, resB.json.student_id);

    const dbCount = await env.apiPoolA.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM "students" WHERE "id" = $1::uuid`,
      [resA.json.student_id],
    );
    assert.equal(Number(dbCount.rows[0]?.cnt), 1);

    // Reusing the same Idempotency-Key with a different phone or name returns 409 IDEMPOTENCY_PAYLOAD_MISMATCH
    const mismatchRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/students',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': idemKey,
      },
      body: {
        ...payload,
        guardian_phone_e164: '+998905554499',
      },
    });
    assert.equal(mismatchRes.statusCode, 409);
    assert.equal(mismatchRes.json.error_code, 'IDEMPOTENCY_PAYLOAD_MISMATCH');

    // Injected mid-transaction fault rolls back student, guardian, guardian_students, enrollment, and audit_logs completely
    const faultPhone = '+998908887766';
    const faultRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/students',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `idem-fault-reg-${crypto.randomUUID()}`,
      },
      body: {
        student_full_name: 'Fault Rollback Student',
        guardian_full_name: 'Fault Rollback Guardian',
        guardian_phone_e164: faultPhone,
        relationship: 'MOTHER',
        group_id: C.groupId,
        initial_status: 'TRIAL',
        enrolled_at_date: '2026-11-04',
        debug_fail_after_student_insert: true,
      },
    });
    assert.equal(faultRes.statusCode, 500);

    const checkFaultRows = await env.apiPoolA.query<{ stu_cnt: string; grd_cnt: string }>(
      `SELECT (SELECT COUNT(*)::text FROM "students" WHERE "full_name" = 'Fault Rollback Student') AS stu_cnt,
              (SELECT COUNT(*)::text FROM "guardians" WHERE "phone_e164" = $1) AS grd_cnt`,
      [faultPhone],
    );
    assert.equal(Number(checkFaultRows.rows[0]?.stu_cnt), 0);
    assert.equal(Number(checkFaultRows.rows[0]?.grd_cnt), 0);
  });

  it('STU-IT-03 (T06.01, T06.02, T06.04): allows distinct students with the same name, allows siblings sharing a guardian phone, supports multi-guardian per child, and blocks exact name+phone double-entry unless confirmed', async () => {
    // 1. Two distinct students with the exact same name ("Jasur Toshmatov") but different guardian phones are both allowed (201)
    //    and the second one surfaces a non-blocking SAME_NORMALIZED_NAME_DIFFERENT_PHONE warning!
    const jasur1 = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/students',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `idem-jasur-1-${crypto.randomUUID()}`,
      },
      body: {
        student_full_name: 'Jasur Toshmatov',
        guardian_full_name: 'Toshmat Ota 1',
        guardian_phone_e164: '+998902001101',
        relationship: 'FATHER',
        group_id: C.groupId,
        initial_status: 'TRIAL',
        enrolled_at_date: '2026-11-04',
      },
    });
    assert.equal(jasur1.statusCode, 201);

    const jasur2 = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/students',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `idem-jasur-2-${crypto.randomUUID()}`,
      },
      body: {
        student_full_name: 'Jasur Toshmatov',
        guardian_full_name: 'Toshmat Ota 2',
        guardian_phone_e164: '+998902001102',
        relationship: 'FATHER',
        group_id: C.groupId,
        initial_status: 'TRIAL',
        enrolled_at_date: '2026-11-04',
      },
    });
    assert.equal(jasur2.statusCode, 201);
    assert.notEqual(jasur1.json.student_id, jasur2.json.student_id);
    const warnings2 = jasur2.json.duplicate_warnings as Array<Record<string, unknown>>;
    assert.ok(
      warnings2.some(
        (w) =>
          w.student_id === jasur1.json.student_id &&
          w.match_reason === 'SAME_NORMALIZED_NAME_DIFFERENT_PHONE' &&
          w.is_blocking_without_confirmation === false,
      ),
    );

    // 2. Attempting to register the EXACT same student name ("Jasur Toshmatov") with the SAME guardian phone (+998902001101)
    //    without confirm_sibling_or_similar_name=true is blocked with 409 DUPLICATE_STUDENT_DETECTED!
    const accidentalDoubleEntry = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/students',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `idem-jasur-dup-${crypto.randomUUID()}`,
      },
      body: {
        student_full_name: 'jasur   toshmatov',
        guardian_full_name: 'Toshmat Ota 1',
        guardian_phone_e164: '+998902001101',
        relationship: 'FATHER',
        group_id: C.groupId,
        initial_status: 'TRIAL',
        enrolled_at_date: '2026-11-04',
      },
    });
    assert.equal(accidentalDoubleEntry.statusCode, 409);
    assert.equal(accidentalDoubleEntry.json.error_code, 'DUPLICATE_STUDENT_DETECTED');

    // 3a. R2 Regression: Passing a string boolean ('false') is rejected with 400 VALIDATION_ERROR (never coerced to true!),
    //     and registering a sibling with an existing guardian phone WITHOUT explicit reuse_existing_guardian=true / guardian_id
    //     is rejected with 409 DUPLICATE_STUDENT_DETECTED even if guardian_full_name matches!
    const stringBooleanAttempt = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/students',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `idem-madina-badbool-${crypto.randomUUID()}`,
      },
      body: {
        student_full_name: 'Madina Toshmatova',
        guardian_full_name: 'Toshmat Ota 1',
        guardian_phone_e164: '+998902001101',
        relationship: 'FATHER',
        reuse_existing_guardian: 'false',
      },
    });
    assert.equal(stringBooleanAttempt.statusCode, 400);
    assert.equal(stringBooleanAttempt.json.error_code, 'VALIDATION_ERROR');

    const unconfirmedGuardianReuseAttempt = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/students',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `idem-madina-no-reuse-${crypto.randomUUID()}`,
      },
      body: {
        student_full_name: 'Madina Toshmatova',
        guardian_full_name: 'Toshmat Ota 1',
        guardian_phone_e164: '+998902001101',
        relationship: 'FATHER',
        group_id: C.groupId,
        initial_status: 'TRIAL',
        enrolled_at_date: '2026-11-04',
      },
    });
    assert.equal(unconfirmedGuardianReuseAttempt.statusCode, 409);
    assert.equal(unconfirmedGuardianReuseAttempt.json.error_code, 'DUPLICATE_STUDENT_DETECTED');

    // 3b. Registering a SIBLING ("Madina Toshmatova") with explicit reuse_existing_guardian: true
    //     succeeds (201), links both children to the same guardian, and sets family_discount_eligible=true!
    const siblingMadina = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/students',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `idem-madina-sib-${crypto.randomUUID()}`,
      },
      body: {
        student_full_name: 'Madina Toshmatova',
        guardian_full_name: 'Toshmat Ota 1',
        guardian_phone_e164: '+998902001101',
        relationship: 'FATHER',
        reuse_existing_guardian: true,
        group_id: C.groupId,
        initial_status: 'TRIAL',
        enrolled_at_date: '2026-11-04',
      },
    });
    assert.equal(siblingMadina.statusCode, 201);
    assert.equal(siblingMadina.json.family_discount_eligible, true);
    const madinaWarnings = siblingMadina.json.duplicate_warnings as Array<Record<string, unknown>>;
    assert.ok(
      madinaWarnings.some(
        (w) =>
          w.student_id === jasur1.json.student_id &&
          w.match_reason === 'SHARED_GUARDIAN_PHONE_SIBLING',
      ),
    );

    // 4. Link a SECOND guardian (Mother) to Madina -> 1 child has 2 active guardians, and Father has 2 active children!
    const linkMother = await httpJsonRequest({
      port,
      method: 'POST',
      path: `/api/v1/students/${siblingMadina.json.student_id as string}/guardians`,
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `idem-link-mother-${crypto.randomUUID()}`,
      },
      body: {
        guardian_full_name: 'Nodira Ona',
        guardian_phone_e164: '+998902001199',
        relationship: 'MOTHER',
        is_primary_payer: false,
      },
    });
    assert.equal(linkMother.statusCode, 201);
    assert.equal(linkMother.json.relationship, 'MOTHER');

    const madinaProfile = await httpJsonRequest({
      port,
      method: 'GET',
      path: `/api/v1/students/${siblingMadina.json.student_id as string}`,
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(madinaProfile.statusCode, 200);
    assert.equal((madinaProfile.json.guardians as unknown[]).length, 2);
  });

  it('STU-IT-04 & STU-IT-05 (T06.02, D18): enforces phone normalization & same-center collision, allows same phone in Center B, and atomically revokes old Telegram links + emits GuardianLinkRevoked outbox event on phone change', async () => {
    // 1. Ambiguous local phone without country code is rejected with 400 VALIDATION_ERROR
    const badPhoneRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/students',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `idem-bad-phone-${crypto.randomUUID()}`,
      },
      body: {
        student_full_name: 'Bad Phone Student',
        guardian_full_name: 'Bad Phone Guardian',
        guardian_phone_e164: '901234567',
        group_id: C.groupId,
        initial_status: 'TRIAL',
        enrolled_at_date: '2026-11-04',
      },
    });
    assert.equal(badPhoneRes.statusCode, 400);
    assert.equal(badPhoneRes.json.error_code, 'VALIDATION_ERROR');

    // 2. Center B can have a guardian with the same phone (+998901112233) as Center A without conflict
    const centerBSamePhone = await env.apiPoolB.query(
      `SELECT "phone_e164" FROM "guardians" WHERE "center_id" = $1::uuid AND "id" = $2::uuid`,
      [CB.centerId, CB.guardianId],
    );
    assert.equal(centerBSamePhone.rows[0]?.phone_e164, '+998901112233');

    // 3. Seed an ACTIVE guardian_telegram_links row for C.guardianId (+998901112233) with telegram_chat_id = 777888999
    const activeLinkId = crypto.randomUUID();
    await env.apiPoolA.query(
      `INSERT INTO "guardian_telegram_links" (
         "id", "center_id", "guardian_id", "invite_token_hash", "invite_expires_at",
         "invite_used_at", "telegram_user_id", "telegram_chat_id", "linked_phone_e164", "status", "version"
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4, NOW() + INTERVAL '7 days',
         NOW(), 777888999, 777888999, '+998901112233', 'ACTIVE', 1
       )`,
      [activeLinkId, C.centerId, C.guardianId, crypto.randomBytes(32).toString('hex')],
    );

    // 4. Fault injection on updateGuardianPhoneAndRevokeBot rolls back phone change, link revocation, and outbox event
    const faultPhoneUpdate = await httpJsonRequest({
      port,
      method: 'PATCH',
      path: `/api/v1/guardians/${C.guardianId}/phone`,
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `idem-grd-phone-fault-${crypto.randomUUID()}`,
      },
      body: {
        new_phone_e164: '+998903334455',
        reason: 'Guardian SIM card changed',
        revoke_existing_telegram_links: true,
        expected_version: 1,
        debug_fail_after_phone_update: true,
      },
    });
    assert.equal(faultPhoneUpdate.statusCode, 500);

    const afterFaultCheck = await env.apiPoolA.query<{ phone_e164: string; link_status: string }>(
      `SELECT g."phone_e164",
              (SELECT "status" FROM "guardian_telegram_links" WHERE "id" = $2::uuid) AS link_status
         FROM "guardians" g WHERE g."id" = $1::uuid`,
      [C.guardianId, activeLinkId],
    );
    assert.equal(afterFaultCheck.rows[0]?.phone_e164, '+998901112233');
    assert.equal(afterFaultCheck.rows[0]?.link_status, 'ACTIVE');

    // 5. Valid PATCH /api/v1/guardians/:id/phone atomically updates phone, revokes old ACTIVE link,
    //    creates new INVITED link, and queues GuardianLinkRevoked outbox event with zero raw phone in outbox payload!
    const validPhoneUpdate = await httpJsonRequest({
      port,
      method: 'PATCH',
      path: `/api/v1/guardians/${C.guardianId}/phone`,
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `idem-grd-phone-ok-${crypto.randomUUID()}`,
        'If-Match-Version': '1',
      },
      body: {
        new_phone_e164: '998 90 333-44-55',
        reason: 'Guardian SIM card changed',
        revoke_existing_telegram_links: true,
        expected_version: 1,
      },
    });
    assert.equal(validPhoneUpdate.statusCode, 200);
    assert.equal(validPhoneUpdate.json.single_use_invite_deeplink, null);
    assert.equal(validPhoneUpdate.json.relink_required, true);
    const cachedPhoneResponse = await env.apiPoolA.query<{ response_payload_json: unknown }>(`SELECT response_payload_json FROM client_operation_logs WHERE operation_type = 'UPDATE_GUARDIAN_PHONE_AND_REVOKE_BOT'`);
    assert.equal(cachedPhoneResponse.rows.length, 1);
    for (const row of cachedPhoneResponse.rows) {
      assert.equal(JSON.stringify(row.response_payload_json).includes('t.me/'), false, 'No bearer invitation URL belongs in generic idempotency storage');
    }
    assert.equal(validPhoneUpdate.json.guardian_id, C.guardianId);
    assert.equal(Number(validPhoneUpdate.json.revoked_old_links_count) >= 1, true);

    const revokedLinkRow = await env.apiPoolA.query<{
      status: string;
      revoke_reason: string;
      revoked_at: Date | null;
    }>(
      `SELECT "status", "revoke_reason", "revoked_at"
         FROM "guardian_telegram_links"
        WHERE "id" = $1::uuid`,
      [activeLinkId],
    );
    assert.equal(revokedLinkRow.rows[0]?.status, 'UNLINKED_REVOKED');
    assert.equal(revokedLinkRow.rows[0]?.revoke_reason, 'GUARDIAN_PHONE_CHANGED');
    assert.notEqual(revokedLinkRow.rows[0]?.revoked_at, null);

    const outboxRes = await env.apiPoolA.query<{
      event_name: string;
      dedup_key: string;
      payload_json: Record<string, unknown>;
    }>(
      `SELECT "event_name", "dedup_key", "payload_json"
         FROM "outbox_events"
        WHERE "center_id" = $1::uuid
          AND "event_name" = 'GuardianLinkRevoked'
          AND "aggregate_id" = $2::uuid`,
      [C.centerId, activeLinkId],
    );
    assert.equal(outboxRes.rows.length, 1);
    assert.equal(outboxRes.rows[0].dedup_key, `GuardianLinkRevoked:${activeLinkId}:v2`);
    assert.equal(outboxRes.rows[0].payload_json.guardian_id, C.guardianId);
    assert.equal(outboxRes.rows[0].payload_json.revoked_telegram_chat_id, 777888999);
    const outboxPayloadText = JSON.stringify(outboxRes.rows[0].payload_json);
    assert.equal(outboxPayloadText.includes('903334455'), false, 'Outbox payload must not contain raw phone');
    assert.equal(outboxPayloadText.includes('901112233'), false, 'Outbox payload must not contain raw phone');
  });

  it('STU-IT-06 & STU-IT-09 (T06.01, T06.02): unlinking one child preserves sibling relation and debt, soft-archiving hides student from default search while preserving profile/debt history, and search supports Uzbek apostrophes & cursor pagination', async () => {
    // 1. Seed a high-BigInt open invoice on C.studentId (12,500,000,000 UZS > 2^31-1) to prove lossless BigInt debt preservation
    const cycleId = crypto.randomUUID();
    const invoiceId = crypto.randomUUID();
    const enrForInvoiceId = crypto.randomUUID();
    await env.apiPoolA.query(
      `INSERT INTO "enrollments" ("id", "center_id", "student_id", "group_id", "status", "enrolled_at_date")
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'ACTIVE', '2026-10-01')
       ON CONFLICT DO NOTHING`,
      [enrForInvoiceId, C.centerId, C.studentId, C.groupId],
    );
    await env.apiPoolA.query(
      `INSERT INTO "billing_cycles" ("id", "center_id", "enrollment_id", "cycle_type", "cycle_key", "cycle_seq", "period_start_date", "period_end_date", "planned_lessons", "billable_lessons", "policy_version_id")
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'CALENDAR_MONTH', '2026-10', 1, '2026-10-01', '2026-10-31', 12, 12, $4::uuid)`,
      [cycleId, C.centerId, enrForInvoiceId, C.billingPolicyId],
    );
    await env.apiPoolA.query(
      `INSERT INTO "invoices" (
         "id", "center_id", "invoice_number", "student_id", "enrollment_id", "billing_cycle_id", "policy_version_id",
         "tariff_snapshot_uzs", "base_pro_rata_charge_uzs", "approved_discount_uzs", "credit_note_adjustments_uzs",
         "effective_net_charge_uzs", "allocated_paid_uzs", "remaining_debt_uzs", "billed_lessons", "status", "due_date"
       ) VALUES (
         $1::uuid, $2::uuid, 'INV-2026-HIGH-01', $3::uuid, $4::uuid, $5::uuid, $6::uuid,
         15000000000, 15000000000, 0, 0, 15000000000, 2500000000, 12500000000, 12, 'PARTIALLY_PAID', '2026-10-15'
       )`,
      [invoiceId, C.centerId, C.studentId, enrForInvoiceId, cycleId, C.billingPolicyId],
    );

    // Link a second sibling to C.guardianId so C.guardianId has 2 active children
    const sib2Res = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/students',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `idem-sib2-${crypto.randomUUID()}`,
      },
      body: {
        student_full_name: 'Sardor Valiyev',
        guardian_id: C.guardianId,
        guardian_full_name: 'Vali Ota (Synthetic)',
        guardian_phone_e164: '+998903334455',
        relationship: 'FATHER',
        reuse_existing_guardian: true,
      },
    });
    assert.equal(sib2Res.statusCode, 201);

    // 2. Unlink C.guardianId from C.studentId -> soft inactive, preserves sibling link on Sardor Valiyev AND preserves 12,500,000,000 UZS debt on C.studentId!
    const unlinkRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: `/api/v1/students/${C.studentId}/guardians/${C.guardianId}/unlink`,
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `idem-unlink-${crypto.randomUUID()}`,
      },
      body: {
        reason: 'Guardian responsibility transferred to uncle',
        expected_version: 1,
      },
    });
    assert.equal(unlinkRes.statusCode, 200);
    assert.equal(unlinkRes.json.active, false);
    assert.equal(unlinkRes.json.preserved_sibling_active_links_count, 1);
    assert.equal(unlinkRes.json.preserved_student_remaining_debt_uzs, '12500000000');

    // 3. Soft-archive C.studentId -> hidden in default GET /api/v1/students, visible with include_archived=true and GET /api/v1/students/:id, debt still 12,500,000,000 UZS!
    const archiveRes = await httpJsonRequest({
      port,
      method: 'PATCH',
      path: `/api/v1/students/${C.studentId}`,
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `idem-archive-stu-${crypto.randomUUID()}`,
        'If-Match-Version': '1',
      },
      body: {
        status: 'ARCHIVED',
        reason: 'Graduated and archived for record retention',
        expected_version: 1,
      },
    });
    assert.equal(archiveRes.statusCode, 200);
    assert.equal(archiveRes.json.status, 'ARCHIVED');
    assert.equal(archiveRes.json.total_remaining_debt_uzs, '12500000000');
    assert.equal(archiveRes.json.version, 2);

    const defaultSearch = await httpJsonRequest({
      port,
      method: 'GET',
      path: `/api/v1/students?search=${encodeURIComponent('STU-SYN-0001')}`,
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(defaultSearch.statusCode, 200);
    assert.equal((defaultSearch.json.items as unknown[]).length, 0);

    const archivedSearch = await httpJsonRequest({
      port,
      method: 'GET',
      path: `/api/v1/students?search=${encodeURIComponent('STU-SYN-0001')}&include_archived=true`,
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(archivedSearch.statusCode, 200);
    assert.equal((archivedSearch.json.items as unknown[]).length, 1);

    // 4. Search by Uzbek apostrophe variants ("O'ktam" finds "O‘ktam O'g'li Karimov") and deterministic cursor pagination
    const apostropheSearch = await httpJsonRequest({
      port,
      method: 'GET',
      path: `/api/v1/students?search=${encodeURIComponent("oʻktam oʼgʼli")}`,
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(apostropheSearch.statusCode, 200);
    const foundItems = apostropheSearch.json.items as Array<Record<string, unknown>>;
    assert.equal(foundItems.length, 1);
    assert.equal(foundItems[0].full_name, "O‘ktam O'g'li Karimov");

    // Cursor pagination with limit=2 walks through Center A students with zero duplicates and zero Center B rows
    const page1 = await httpJsonRequest({
      port,
      method: 'GET',
      path: '/api/v1/students?limit=2',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(page1.statusCode, 200);
    const p1Items = page1.json.items as Array<Record<string, unknown>>;
    assert.equal(p1Items.length, 2);
    assert.equal(typeof page1.json.next_cursor, 'string');

    const page2 = await httpJsonRequest({
      port,
      method: 'GET',
      path: `/api/v1/students?limit=2&cursor=${encodeURIComponent(page1.json.next_cursor as string)}`,
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(page2.statusCode, 200);
    const p2Items = page2.json.items as Array<Record<string, unknown>>;
    assert.ok(p2Items.length >= 1);
    assert.notEqual(p1Items[0].student_id, p2Items[0].student_id);
  });

  it('STU-IT-07 & STU-IT-08 (T06.03, BR-08): enforces enrollment lifecycle transitions, duplicate active rejection, atomic group transfer with fault rollback, withdrawal churn_reason_code 1..5 + debt preservation, LEFT->new re-enrollment, and policy gate 403', async () => {
    // Restore C.studentId to ACTIVE so we can test group transfer and re-enrollment
    const restoreRes = await httpJsonRequest({
      port,
      method: 'PATCH',
      path: `/api/v1/students/${C.studentId}`,
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `idem-restore-stu-${crypto.randomUUID()}`,
      },
      body: {
        status: 'ACTIVE',
        reason: 'Re-activated for new semester',
        expected_version: 2,
      },
    });
    assert.equal(restoreRes.statusCode, 200);

    // 1. Attempting duplicate active enrollment in C.groupId is rejected with 409
    const dupActiveEnr = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/enrollments',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `idem-dup-enr-${crypto.randomUUID()}`,
      },
      body: {
        student_id: C.studentId,
        group_id: C.groupId,
        initial_status: 'ACTIVE',
        enrolled_at_date: '2026-11-04',
      },
    });
    assert.equal(dupActiveEnr.statusCode, 409);

    // 2. Policy gate: requesting auto_issue_pro_rata_invoice=true fails closed with 403 POLICY_DECISION_NOT_CONFIRMED
    const policyBlockedEnr = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/enrollments',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `idem-pol-enr-${crypto.randomUUID()}`,
      },
      body: {
        student_id: C.studentId,
        group_id: C.groupId,
        initial_status: 'ACTIVE',
        enrolled_at_date: '2026-11-04',
        auto_issue_pro_rata_invoice: true,
      },
    });
    assert.equal(policyBlockedEnr.statusCode, 403);
    assert.equal(policyBlockedEnr.json.error_code, 'POLICY_DECISION_NOT_CONFIRMED');

    // 3. Create a second group (groupTransferTargetId) and test atomic transfer with fault rollback first, then success
    const groupTransferTargetId = crypto.randomUUID();
    await env.apiPoolA.query(
      `INSERT INTO "course_groups" ("id", "center_id", "course_id", "name", "primary_teacher_id", "billing_mode", "current_fee_uzs", "lessons_per_cycle", "schedule_days_json", "starts_time", "duration_minutes", "timezone", "status")
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'MATH-G2-ADVANCED', $4::uuid, 'LESSON_PACKAGE_12', 600000, 12, '["TUE","THU","SAT"]'::jsonb, '11:00', 90, 'Asia/Tashkent', 'ACTIVE')`,
      [groupTransferTargetId, C.centerId, C.courseId, C.teacherId],
    );

    const activeEnrRes = await env.apiPoolA.query<{ id: string; version: number }>(
      `SELECT "id"::text AS id, "version" FROM "enrollments" WHERE "center_id" = $1::uuid AND "student_id" = $2::uuid AND "group_id" = $3::uuid AND "status" = 'ACTIVE'`,
      [C.centerId, C.studentId, C.groupId],
    );
    const sourceEnrId = activeEnrRes.rows[0].id;

    // Fault injection during transfer rolls back closing of source enrollment
    const faultTransfer = await httpJsonRequest({
      port,
      method: 'POST',
      path: `/api/v1/enrollments/${sourceEnrId}/transfer`,
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `idem-xf-fault-${crypto.randomUUID()}`,
      },
      body: {
        target_group_id: groupTransferTargetId,
        effective_date: '2026-11-04',
        target_status: 'ACTIVE',
        reason: 'Fault injection transfer test',
        expected_version: 1,
        debug_fail_after_close_old: true,
      },
    });
    assert.equal(faultTransfer.statusCode, 500);

    const checkSourceStillActive = await env.apiPoolA.query<{ status: string }>(
      `SELECT "status" FROM "enrollments" WHERE "id" = $1::uuid`,
      [sourceEnrId],
    );
    assert.equal(checkSourceStillActive.rows[0]?.status, 'ACTIVE');

    // Valid transfer closes sourceEnrId (status=LEFT, churn_reason_code=3), creates linked new enrollment, and preserves old invoice reference + 12,500,000,000 UZS debt!
    const okTransfer = await httpJsonRequest({
      port,
      method: 'POST',
      path: `/api/v1/enrollments/${sourceEnrId}/transfer`,
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `idem-xf-ok-${crypto.randomUUID()}`,
      },
      body: {
        target_group_id: groupTransferTargetId,
        effective_date: '2026-11-04',
        target_status: 'ACTIVE',
        reason: 'Promoted to advanced group',
        expected_version: 1,
      },
    });
    assert.equal(okTransfer.statusCode, 200);
    const closedEnr = okTransfer.json.closed_enrollment as Record<string, unknown>;
    const newEnr = okTransfer.json.new_enrollment as Record<string, unknown>;
    assert.equal(closedEnr.enrollment_id, sourceEnrId);
    assert.equal(closedEnr.status, 'LEFT');
    assert.equal(closedEnr.churn_reason_code, 3);
    assert.equal(newEnr.group_id, groupTransferTargetId);
    assert.equal(newEnr.status, 'ACTIVE');
    assert.equal(newEnr.transferred_from_enrollment_id, sourceEnrId);
    assert.equal(newEnr.package_lessons_remaining, 12);
    assert.equal(okTransfer.json.preserved_debt_snapshot_uzs, '12500000000');

    // 4. Policy gate on withdrawal: requesting forgive_remaining_debt=true fails closed with 403 POLICY_DECISION_NOT_CONFIRMED
    const policyBlockedWithdraw = await httpJsonRequest({
      port,
      method: 'POST',
      path: `/api/v1/enrollments/${newEnr.enrollment_id as string}/withdraw`,
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `idem-wd-pol-${crypto.randomUUID()}`,
      },
      body: {
        left_at_date: '2026-11-10',
        churn_reason_code: 1,
        expected_version: 1,
        forgive_remaining_debt: true,
      },
    });
    assert.equal(policyBlockedWithdraw.statusCode, 403);
    assert.equal(policyBlockedWithdraw.json.error_code, 'POLICY_DECISION_NOT_CONFIRMED');

    // 5. Valid withdrawal with churn_reason_code=1 transitions to LEFT and preserves 12,500,000,000 UZS debt
    const okWithdraw = await httpJsonRequest({
      port,
      method: 'POST',
      path: `/api/v1/enrollments/${newEnr.enrollment_id as string}/withdraw`,
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `idem-wd-ok-${crypto.randomUUID()}`,
      },
      body: {
        left_at_date: '2026-11-10',
        churn_reason_code: 1,
        churn_notes: 'Temporary financial pause',
        expected_version: 1,
      },
    });
    assert.equal(okWithdraw.statusCode, 200);
    assert.equal(okWithdraw.json.status, 'LEFT');
    assert.equal(okWithdraw.json.churn_reason_code, 1);
    assert.equal(okWithdraw.json.preserved_debt_snapshot_uzs, '12500000000');

    // 6. Re-enrolling a LEFT student into C.groupId creates a NEW enrollment row while keeping old LEFT rows intact
    const reEnrollRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/enrollments',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `idem-reenroll-${crypto.randomUUID()}`,
      },
      body: {
        student_id: C.studentId,
        group_id: C.groupId,
        initial_status: 'ACTIVE',
        enrolled_at_date: '2026-11-15',
      },
    });
    assert.equal(reEnrollRes.statusCode, 201);
    assert.notEqual(reEnrollRes.json.enrollment_id, sourceEnrId);
  });
});
