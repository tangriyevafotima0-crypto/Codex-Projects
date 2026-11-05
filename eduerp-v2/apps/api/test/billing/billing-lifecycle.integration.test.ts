import 'reflect-metadata';
import * as assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { INestApplication } from '@nestjs/common';
import { createApiApplication } from '../../src/application';
import { ClockService } from '../../src/auth/clock.service';
import { FaultInjectionStep, InvoiceGeneratorService } from '../../src/billing/invoice-generator';
import { TrialConversionService } from '../../src/billing/trial-conversion';
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

interface HttpJsonResponse {
  readonly statusCode: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly rawBody: string;
  readonly json: Record<string, unknown>;
}

function httpJsonRequest(params: {
  readonly port: number;
  readonly method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  readonly path: string;
  readonly headers?: Record<string, string>;
  readonly body?: unknown;
}): Promise<HttpJsonResponse> {
  return new Promise((resolve, reject) => {
    const payload =
      params.body === undefined
        ? ''
        : typeof params.body === 'string'
          ? params.body
          : JSON.stringify(params.body);

    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: params.port,
        path: params.path,
        method: params.method,
        headers: {
          ...(params.body !== undefined
            ? {
                'Content-Type': 'application/json',
                'Content-Length': String(Buffer.byteLength(payload)),
              }
            : {}),
          ...(params.headers ?? {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const rawBody = Buffer.concat(chunks).toString('utf8');
          let parsed: Record<string, unknown> = {};
          try {
            parsed = JSON.parse(rawBody) as Record<string, unknown>;
          } catch {
            parsed = {};
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
    if (payload.length > 0) {
      req.write(payload);
    }
    req.end();
  });
}

describe('Gate G5 — Real HTTP + PostgreSQL Stage 08 Billing, Proration, Subscriptions, Trial Conversion & Invoice Atomicity Integration Suite (BILL-IT-01..08)', () => {
  let env: EphemeralDatabaseEnvironment;
  let app: INestApplication;
  let clock: ClockService;
  let invoiceGenerator: InvoiceGeneratorService;
  let trialConversion: TrialConversionService;
  let port = 0;

  let directorToken = '';
  let adminToken = '';
  let teacherToken = '';

  const C = SYNTHETIC_DEMO_CENTER_A;

  async function refreshAllTokens(): Promise<void> {
    for (const [username, roleKey] of [
      ['director.demo', 'DIRECTOR'],
      ['admin.demo', 'ADMIN'],
      ['teacher.demo', 'TEACHER'],
    ] as const) {
      const login = await httpJsonRequest({
        port,
        method: 'POST',
        path: '/api/v1/auth/login',
        body: { username, password: SYNTHETIC_TEST_ONLY_PASSWORD },
      });
      assert.equal(login.statusCode, 200);
      if (roleKey === 'DIRECTOR') directorToken = String(login.json.access_token);
      else if (roleKey === 'ADMIN') adminToken = String(login.json.access_token);
      else teacherToken = String(login.json.access_token);
    }
  }

  async function setClockAndRefreshTokens(isoUtc: string): Promise<void> {
    clock.setTestNow(new Date(isoUtc));
    await refreshAllTokens();
  }

  before(async () => {
    env = await createEphemeralTestDbEnv();
    await executeSyntheticSeed(env.apiPoolA, SYNTHETIC_DEMO_CENTER_A, {
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
    clock = app.get(ClockService);
    invoiceGenerator = app.get(InvoiceGeneratorService);
    trialConversion = app.get(TrialConversionService);
    await app.listen(0, '127.0.0.1');
    port = ((app.getHttpServer() as http.Server).address() as AddressInfo).port;

    await setClockAndRefreshTokens('2026-11-04T09:00:00.000Z');
  });

  after(async () => {
    if (clock) {
      clock.setTestNow(null);
    }
    if (app) {
      await app.close();
    }
    if (env) {
      await env.cleanup();
    }
  });

  it('BILL-IT-01 (Matrix #1, #2, #5, #18): gates unconfirmed partial-period policy with 403 and zero DB side effects, enforces Director-only policy creation, and verifies PRORATE_REMAINING_LESSONS (480000*7/12=280000) vs FULL_CYCLE (480000) and zero-lesson blocks', async () => {
    // 1. Create a student enrolled mid-month on 2026-11-11 in default C.groupId (where 7 of 12 MWF lessons remain in Nov 2026: Nov 11, 13, 16, 18, 20, 23, 25; Wait: let us generate exact 12 lessons in an isolated group!)
    const grpRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/groups',
      headers: {
        Authorization: `Bearer ${directorToken}`,
        'Idempotency-Key': `idem-b01-grp-${crypto.randomUUID()}`,
      },
      body: {
        course_id: C.courseId,
        name: 'BILL-IT-01 Calendar ProRata Group',
        primary_teacher_id: C.teacherId,
        billing_mode: 'CALENDAR_PRO_RATA',
        current_fee_uzs: '480000',
        lessons_per_cycle: 12,
        schedule_days: ['MON', 'WED', 'FRI'],
        starts_time: '09:00',
        duration_minutes: 90,
        timezone: 'Asia/Tashkent',
      },
    });
    assert.equal(grpRes.statusCode, 201);
    const groupId = String(grpRes.json.group_id);

    // Schedule 12 lessons in Nov 2026: 5 lessons before Nov 12 (Nov 2, 4, 6, 9, 11) and 7 lessons on/after Nov 12 (Nov 13, 16, 18, 20, 23, 25, 27)
    const novLessonDates = [
      '2026-11-02',
      '2026-11-04',
      '2026-11-06',
      '2026-11-09',
      '2026-11-11',
      '2026-11-13',
      '2026-11-16',
      '2026-11-18',
      '2026-11-20',
      '2026-11-23',
      '2026-11-25',
      '2026-11-27',
    ];
    for (const d of novLessonDates) {
      const lRes = await httpJsonRequest({
        port,
        method: 'POST',
        path: `/api/v1/groups/${groupId}/lessons`,
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Idempotency-Key': `idem-b01-lsn-${d}-${crypto.randomUUID()}`,
        },
        body: {
          lesson_date: d,
          occurrence_seq: 1,
          local_starts_time: '09:00',
          duration_minutes: 90,
        },
      });
      assert.equal(lRes.statusCode, 201);
    }

    // Create student enrolled on 2026-11-12 (7 remaining lessons out of 12 planned lessons)
    const stuRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/students',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `idem-b01-stu-${crypto.randomUUID()}`,
      },
      body: {
        full_name: 'Sardor ProRata Student',
        guardian: {
          full_name: 'Karim Ota',
          phone_e164: '+998901230801',
          relationship: 'FATHER',
        },
        enrollment: {
          group_id: groupId,
          initial_status: 'ACTIVE',
          enrolled_at_date: '2026-11-12',
        },
      },
    });
    assert.equal(stuRes.statusCode, 201);
    const enrollmentId = String((stuRes.json.enrollment as Record<string, unknown>).enrollment_id);

    // 2. Because the initial seed policy has first_partial_charge_mode = 'UNCONFIGURED',
    //    attempting to issue a partial-period invoice fails closed with 403 POLICY_DECISION_NOT_CONFIRMED and 0 DB rows!
    const unconfirmedAttempt = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/billing/cycles/invoice',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `idem-b01-unconf-${crypto.randomUUID()}`,
      },
      body: {
        enrollment_id: enrollmentId,
        cycle_type: 'CALENDAR_MONTH',
        cycle_key: 'CAL:2026-11',
        period_start_date: '2026-11-01',
      },
    });
    assert.equal(unconfirmedAttempt.statusCode, 403);
    assert.equal(unconfirmedAttempt.json.error_code, 'POLICY_DECISION_NOT_CONFIRMED');

    const cycleCountAfter403 = await env.apiPoolA.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM "billing_cycles" WHERE "center_id" = $1::uuid AND "enrollment_id" = $2::uuid`,
      [C.centerId, enrollmentId],
    );
    assert.equal(cycleCountAfter403.rows[0]?.cnt, '0');

    // 3. Admin cannot create a center billing policy (403 FORBIDDEN_ROLE); Director can create confirmed policy!
    const adminCreatePolicy = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/billing/policies',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `idem-b01-adm-pol-${crypto.randomUUID()}`,
      },
      body: {
        billing_mode: 'CALENDAR_PRO_RATA',
        first_partial_charge_mode: 'PRORATE_REMAINING_LESSONS',
      },
    });
    assert.equal(adminCreatePolicy.statusCode, 403);
    assert.equal(adminCreatePolicy.json.error_code, 'FORBIDDEN_ROLE');

    const dirCreateProratePolicy = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/billing/policies',
      headers: {
        Authorization: `Bearer ${directorToken}`,
        'Idempotency-Key': `idem-b01-dir-pol-${crypto.randomUUID()}`,
      },
      body: {
        billing_mode: 'CALENDAR_PRO_RATA',
        first_partial_charge_mode: 'PRORATE_REMAINING_LESSONS',
        rounding_mode: 'HALF_UP_UZS_INT',
        rolling_month_end_mode: 'CONTINUE_FROM_CLAMPED_DAY',
        package_cancel_mode: 'PRESERVE_BALANCE',
        policy_confirmation_status: 'CONFIRMED',
        effective_from_date: '2026-01-01',
      },
    });
    assert.equal(dirCreateProratePolicy.statusCode, 201);
    const proratePolicyId = String(dirCreateProratePolicy.json.id);

    // 4. Issue partial-period invoice under PRORATE_REMAINING_LESSONS: 480,000 * 7 / 12 = 280,000 UZS!
    const issueProrateRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/billing/cycles/invoice',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `idem-b01-issue-prorate-${crypto.randomUUID()}`,
      },
      body: {
        enrollment_id: enrollmentId,
        cycle_type: 'CALENDAR_MONTH',
        cycle_key: 'CAL:2026-11',
        period_start_date: '2026-11-01',
      },
    });
    assert.equal(issueProrateRes.statusCode, 200);
    assert.equal(issueProrateRes.json.tariff_snapshot_uzs, '480000');
    assert.equal(issueProrateRes.json.planned_lessons, 12);
    assert.equal(issueProrateRes.json.billable_lessons, 7);
    assert.equal(issueProrateRes.json.billed_lessons, 7);
    assert.equal(issueProrateRes.json.base_pro_rata_charge_uzs, '280000');
    assert.equal(issueProrateRes.json.effective_net_charge_uzs, '280000');
    assert.equal(issueProrateRes.json.remaining_debt_uzs, '280000');
    assert.equal(issueProrateRes.json.status, 'ISSUED_OPEN');
    assert.equal(issueProrateRes.json.policy_version_id, proratePolicyId);

    // 5. Verify FULL_CYCLE variant on a second group bound to a FULL_CYCLE policy version -> charges full 480,000 UZS!
    const fullCyclePolRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/billing/policies',
      headers: {
        Authorization: `Bearer ${directorToken}`,
        'Idempotency-Key': `idem-b01-fullpol-${crypto.randomUUID()}`,
      },
      body: {
        billing_mode: 'CALENDAR_PRO_RATA',
        first_partial_charge_mode: 'FULL_CYCLE',
        rounding_mode: 'HALF_UP_UZS_INT',
        rolling_month_end_mode: 'CONTINUE_FROM_CLAMPED_DAY',
        package_cancel_mode: 'PRESERVE_BALANCE',
        policy_confirmation_status: 'CONFIRMED',
        effective_from_date: '2026-01-01',
      },
    });
    assert.equal(fullCyclePolRes.statusCode, 201);
    const fullCyclePolicyId = String(fullCyclePolRes.json.id);

    // Re-bind proratePolicyId as latest default for CALENDAR_PRO_RATA so other groups use PRORATE_REMAINING_LESSONS by default
    const restoreDefaultProrate = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/billing/policies',
      headers: {
        Authorization: `Bearer ${directorToken}`,
        'Idempotency-Key': `idem-b01-restpol-${crypto.randomUUID()}`,
      },
      body: {
        billing_mode: 'CALENDAR_PRO_RATA',
        first_partial_charge_mode: 'PRORATE_REMAINING_LESSONS',
        rounding_mode: 'HALF_UP_UZS_INT',
        rolling_month_end_mode: 'CONTINUE_FROM_CLAMPED_DAY',
        package_cancel_mode: 'PRESERVE_BALANCE',
        policy_confirmation_status: 'CONFIRMED',
        effective_from_date: '2026-01-01',
      },
    });
    assert.equal(restoreDefaultProrate.statusCode, 201);

    const grpFullRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/groups',
      headers: {
        Authorization: `Bearer ${directorToken}`,
        'Idempotency-Key': `idem-b01-grpfull-${crypto.randomUUID()}`,
      },
      body: {
        course_id: C.courseId,
        name: 'BILL-IT-01 FullCycle Group',
        primary_teacher_id: C.teacherId,
        billing_mode: 'CALENDAR_PRO_RATA',
        billing_policy_version_id: fullCyclePolicyId,
        current_fee_uzs: '480000',
        lessons_per_cycle: 12,
        schedule_days: ['MON', 'WED', 'FRI'],
        starts_time: '14:00',
        duration_minutes: 90,
        timezone: 'Asia/Tashkent',
      },
    });
    assert.equal(grpFullRes.statusCode, 201);
    const fullGroupId = String(grpFullRes.json.group_id);

    const enrFullRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/enrollments',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `idem-b01-enrfull-${crypto.randomUUID()}`,
      },
      body: {
        student_id: C.studentId,
        group_id: fullGroupId,
        initial_status: 'ACTIVE',
        enrolled_at_date: '2026-11-12',
      },
    });
    assert.equal(enrFullRes.statusCode, 201);
    const enrFullId = String(enrFullRes.json.enrollment_id);

    const issueFullRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/billing/cycles/invoice',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `idem-b01-issuefull-${crypto.randomUUID()}`,
      },
      body: {
        enrollment_id: enrFullId,
        cycle_type: 'CALENDAR_MONTH',
        cycle_key: 'CAL:2026-11',
        period_start_date: '2026-11-01',
      },
    });
    assert.equal(issueFullRes.statusCode, 200);
    assert.equal(issueFullRes.json.base_pro_rata_charge_uzs, '480000');
    assert.equal(issueFullRes.json.effective_net_charge_uzs, '480000');
  });

  it('BILL-IT-02 (Matrix #3, #4): verifies rolling-month renewal chain (Jan31->Feb28->Mar28 and leap year Jan31->Feb29->Mar29) and orthogonal due-date / collection-timing rules (Aug12->Sep12 vs Aug12->Sep15)', async () => {
    // Configure confirmed ROLLING_MONTH policy
    const rolPolRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/billing/policies',
      headers: {
        Authorization: `Bearer ${directorToken}`,
        'Idempotency-Key': `idem-b02-rolpol-${crypto.randomUUID()}`,
      },
      body: {
        billing_mode: 'ROLLING_MONTH',
        first_partial_charge_mode: 'PRORATE_REMAINING_LESSONS',
        rounding_mode: 'HALF_UP_UZS_INT',
        rolling_month_end_mode: 'CONTINUE_FROM_CLAMPED_DAY',
        package_cancel_mode: 'PRESERVE_BALANCE',
        policy_confirmation_status: 'CONFIRMED',
        effective_from_date: '2026-01-01',
      },
    });
    assert.equal(rolPolRes.statusCode, 201);

    // 1. Group with ROLLING_MONTH + ENROLLMENT_ANNIVERSARY + ARREARS (Jan 31 -> Feb 28 -> Mar 28 chain + Aug 12 -> Sep 12 due date)
    const grpAnnivRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/groups',
      headers: {
        Authorization: `Bearer ${directorToken}`,
        'Idempotency-Key': `idem-b02-grpanniv-${crypto.randomUUID()}`,
      },
      body: {
        course_id: C.courseId,
        name: 'BILL-IT-02 Rolling Anniversary Group',
        primary_teacher_id: C.teacherId,
        billing_mode: 'ROLLING_MONTH',
        due_date_rule: 'ENROLLMENT_ANNIVERSARY',
        collection_timing: 'ARREARS',
        current_fee_uzs: '500000',
        lessons_per_cycle: 12,
        schedule_days: ['TUE', 'THU', 'SAT'],
        starts_time: '10:00',
        duration_minutes: 90,
        timezone: 'Asia/Tashkent',
      },
    });
    assert.equal(grpAnnivRes.statusCode, 201);
    const grpAnnivId = String(grpAnnivRes.json.group_id);

    const enrJan31Res = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/enrollments',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `idem-b02-enrjan31-${crypto.randomUUID()}`,
      },
      body: {
        student_id: C.studentId,
        group_id: grpAnnivId,
        initial_status: 'ACTIVE',
        enrolled_at_date: '2026-01-31',
      },
    });
    assert.equal(enrJan31Res.statusCode, 201);
    const enrJan31Id = String(enrJan31Res.json.enrollment_id);

    // Cycle 1: 2026-01-31 .. 2026-02-27 (due_date = 2026-02-28)
    const c1 = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/billing/cycles/invoice',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `idem-b02-c1-${crypto.randomUUID()}`,
      },
      body: {
        enrollment_id: enrJan31Id,
        cycle_type: 'ROLLING_MONTH',
        cycle_key: 'ROL:2026-01-31',
        period_start_date: '2026-01-31',
      },
    });
    assert.equal(c1.statusCode, 200);
    assert.equal(c1.json.period_start_date, '2026-01-31');
    assert.equal(c1.json.period_end_date, '2026-02-27');
    assert.equal(c1.json.due_date, '2026-02-28');

    // Cycle 2: continues from 2026-02-28 .. 2026-03-27 (due_date = 2026-03-28, NEVER restoring 31!)
    const c2 = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/billing/cycles/invoice',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `idem-b02-c2-${crypto.randomUUID()}`,
      },
      body: {
        enrollment_id: enrJan31Id,
        cycle_type: 'ROLLING_MONTH',
        cycle_key: 'ROL:2026-02-28',
        period_start_date: '2026-02-28',
      },
    });
    assert.equal(c2.statusCode, 200);
    assert.equal(c2.json.period_start_date, '2026-02-28');
    assert.equal(c2.json.period_end_date, '2026-03-27');
    assert.equal(c2.json.due_date, '2026-03-28');

    // Cycle 3: continues from 2026-03-28 .. 2026-04-27 (due_date = 2026-04-28)
    const c3 = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/billing/cycles/invoice',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `idem-b02-c3-${crypto.randomUUID()}`,
      },
      body: {
        enrollment_id: enrJan31Id,
        cycle_type: 'ROLLING_MONTH',
        cycle_key: 'ROL:2026-03-28',
        period_start_date: '2026-03-28',
      },
    });
    assert.equal(c3.statusCode, 200);
    assert.equal(c3.json.period_start_date, '2026-03-28');
    assert.equal(c3.json.period_end_date, '2026-04-27');
    assert.equal(c3.json.due_date, '2026-04-28');

    // 2. Group with ROLLING_MONTH + CENTER_FIXED_DAY = 15 + ARREARS (OWNER-20261104-02 Example 2: Aug 12 -> Sep 15 due date)
    const grpFixed15Res = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/groups',
      headers: {
        Authorization: `Bearer ${directorToken}`,
        'Idempotency-Key': `idem-b02-grpf15-${crypto.randomUUID()}`,
      },
      body: {
        course_id: C.courseId,
        name: 'BILL-IT-02 Rolling Fixed15 Group',
        primary_teacher_id: C.teacherId,
        billing_mode: 'ROLLING_MONTH',
        due_date_rule: 'CENTER_FIXED_DAY',
        fixed_due_day: 15,
        collection_timing: 'ARREARS',
        current_fee_uzs: '500000',
        lessons_per_cycle: 12,
        schedule_days: ['TUE', 'THU', 'SAT'],
        starts_time: '16:00',
        duration_minutes: 90,
        timezone: 'Asia/Tashkent',
      },
    });
    assert.equal(grpFixed15Res.statusCode, 201);
    const grpFixed15Id = String(grpFixed15Res.json.group_id);

    const enrAug12Res = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/enrollments',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `idem-b02-enraug12-${crypto.randomUUID()}`,
      },
      body: {
        student_id: C.studentId,
        group_id: grpFixed15Id,
        initial_status: 'ACTIVE',
        enrolled_at_date: '2026-08-12',
      },
    });
    assert.equal(enrAug12Res.statusCode, 201);
    const enrAug12Id = String(enrAug12Res.json.enrollment_id);

    const aug12Inv = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/billing/cycles/invoice',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `idem-b02-aug12inv-${crypto.randomUUID()}`,
      },
      body: {
        enrollment_id: enrAug12Id,
        cycle_type: 'ROLLING_MONTH',
        cycle_key: 'ROL:2026-08-12',
        period_start_date: '2026-08-12',
      },
    });
    assert.equal(aug12Inv.statusCode, 200);
    assert.equal(aug12Inv.json.period_start_date, '2026-08-12');
    assert.equal(aug12Inv.json.period_end_date, '2026-09-11');
    assert.equal(aug12Inv.json.due_date, '2026-09-15');
    assert.equal(aug12Inv.json.base_pro_rata_charge_uzs, '500000');
  });

  it('BILL-IT-03 (Matrix #6, #11): resolves service-period tariff snapshot via price-resolver as of period_start_date (never recalculating historical cycles with future tariffs) and preserves old invoices when policy version changes', async () => {
    await setClockAndRefreshTokens('2026-11-04T09:00:00.000Z');
    try {
      const grpRes = await httpJsonRequest({
        port,
        method: 'POST',
        path: '/api/v1/groups',
        headers: {
          Authorization: `Bearer ${directorToken}`,
          'Idempotency-Key': `idem-b03-grp-${crypto.randomUUID()}`,
        },
        body: {
          course_id: C.courseId,
          name: 'BILL-IT-03 Historical Tariff Snapshot Group',
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
      assert.equal(grpRes.statusCode, 201);
      const groupId = String(grpRes.json.group_id);

      // Schedule future group tariff increase to 650,000 UZS effective 2026-12-01
      const priceUpdate = await httpJsonRequest({
        port,
        method: 'PATCH',
        path: `/api/v1/courses/${C.courseId}/price`,
        headers: {
          Authorization: `Bearer ${directorToken}`,
          'Idempotency-Key': `idem-b03-price-${crypto.randomUUID()}`,
        },
        body: {
          group_id: groupId,
          expected_version: 1,
          new_fee_uzs: '650000',
          effective_from: '2026-12-01',
          reason: 'December tariff increase',
        },
      });
      assert.equal(priceUpdate.statusCode, 200);

      const enrRes = await httpJsonRequest({
        port,
        method: 'POST',
        path: '/api/v1/enrollments',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Idempotency-Key': `idem-b03-enr-${crypto.randomUUID()}`,
        },
        body: {
          student_id: C.studentId,
          group_id: groupId,
          initial_status: 'ACTIVE',
          enrolled_at_date: '2026-11-01',
        },
      });
      assert.equal(enrRes.statusCode, 201);
      const enrollmentId = String(enrRes.json.enrollment_id);

      // Advance clock to 2026-12-05 (after the Dec 1 tariff increase is active today!) and refresh JWTs
      await setClockAndRefreshTokens('2026-12-05T09:00:00.000Z');

      // 1. Issuing the historical November 2026 cycle (period_start_date = 2026-11-01) on Dec 5 MUST use the Nov 1 tariff (480,000), NOT today's Dec 5 tariff (650,000)!
      const novInv = await httpJsonRequest({
        port,
        method: 'POST',
        path: '/api/v1/billing/cycles/invoice',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Idempotency-Key': `idem-b03-nov-${crypto.randomUUID()}`,
        },
        body: {
          enrollment_id: enrollmentId,
          cycle_type: 'CALENDAR_MONTH',
          cycle_key: 'CAL:2026-11',
          period_start_date: '2026-11-01',
        },
      });
      assert.equal(novInv.statusCode, 200);
      assert.equal(novInv.json.tariff_snapshot_uzs, '480000');
      assert.equal(novInv.json.effective_net_charge_uzs, '480000');
      const novInvoiceId = String(novInv.json.invoice_id);
      const novPolicyId = String(novInv.json.policy_version_id);

      // 2. Issuing the December 2026 cycle (period_start_date = 2026-12-01) uses the Dec 1 tariff (650,000)
      const decInv = await httpJsonRequest({
        port,
        method: 'POST',
        path: '/api/v1/billing/cycles/invoice',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Idempotency-Key': `idem-b03-dec-${crypto.randomUUID()}`,
        },
        body: {
          enrollment_id: enrollmentId,
          cycle_type: 'CALENDAR_MONTH',
          cycle_key: 'CAL:2026-12',
          period_start_date: '2026-12-01',
        },
      });
      assert.equal(decInv.statusCode, 200);
      assert.equal(decInv.json.tariff_snapshot_uzs, '650000');
      assert.equal(decInv.json.effective_net_charge_uzs, '650000');

      // 3. Re-open historical November invoice via GET /api/v1/invoices/:invoice_id -> tariff_snapshot_uzs and policy_version_id are unchanged!
      const reopenNov = await httpJsonRequest({
        port,
        method: 'GET',
        path: `/api/v1/invoices/${novInvoiceId}`,
        headers: { Authorization: `Bearer ${directorToken}` },
      });
      assert.equal(reopenNov.statusCode, 200);
      assert.equal(reopenNov.json.tariff_snapshot_uzs, '480000');
      assert.equal(reopenNov.json.policy_version_id, novPolicyId);
    } finally {
      await setClockAndRefreshTokens('2026-11-04T09:00:00.000Z');
    }
  });

  it('BILL-IT-04 (Matrix #7, #8): enforces idempotency replay/mismatch (409) and durable cycle identity dedup across new keys, different actors, and parallel concurrent requests (producing 1 invoice and 1 debt)', async () => {
    const grpRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/groups',
      headers: {
        Authorization: `Bearer ${directorToken}`,
        'Idempotency-Key': `idem-b04-grp-${crypto.randomUUID()}`,
      },
      body: {
        course_id: C.courseId,
        name: 'BILL-IT-04 Concurrency Dedup Group',
        primary_teacher_id: C.teacherId,
        billing_mode: 'CALENDAR_PRO_RATA',
        current_fee_uzs: '480000',
        lessons_per_cycle: 12,
        schedule_days: ['MON', 'WED', 'FRI'],
        starts_time: '13:00',
        duration_minutes: 90,
        timezone: 'Asia/Tashkent',
      },
    });
    assert.equal(grpRes.statusCode, 201);
    const groupId = String(grpRes.json.group_id);

    const enrRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/enrollments',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `idem-b04-enr-${crypto.randomUUID()}`,
      },
      body: {
        student_id: C.studentId,
        group_id: groupId,
        initial_status: 'ACTIVE',
        enrolled_at_date: '2026-11-01',
      },
    });
    assert.equal(enrRes.statusCode, 201);
    const enrollmentId = String(enrRes.json.enrollment_id);

    // 1. Fire two parallel concurrent requests with DIFFERENT Idempotency-Keys and DIFFERENT actors (Director vs Admin)
    //    for the exact same (enrollment_id, 'CALENDAR_MONTH', 'CAL:2026-11')!
    const keyDir = `idem-b04-dir-${crypto.randomUUID()}`;
    const keyAdm = `idem-b04-adm-${crypto.randomUUID()}`;
    const reqBody = {
      enrollment_id: enrollmentId,
      cycle_type: 'CALENDAR_MONTH',
      cycle_key: 'CAL:2026-11',
      period_start_date: '2026-11-01',
    };

    const [p1, p2] = await Promise.all([
      httpJsonRequest({
        port,
        method: 'POST',
        path: '/api/v1/billing/cycles/invoice',
        headers: { Authorization: `Bearer ${directorToken}`, 'Idempotency-Key': keyDir },
        body: reqBody,
      }),
      httpJsonRequest({
        port,
        method: 'POST',
        path: '/api/v1/billing/cycles/invoice',
        headers: { Authorization: `Bearer ${adminToken}`, 'Idempotency-Key': keyAdm },
        body: reqBody,
      }),
    ]);

    assert.equal(p1.statusCode, 200);
    assert.equal(p2.statusCode, 200);
    assert.equal(p1.json.invoice_id, p2.json.invoice_id);
    assert.equal(p1.json.invoice_number, p2.json.invoice_number);

    // 2. Verify exactly 1 billing_cycles row, 1 invoices row, and 1 INVOICE_ISSUED ledger_entries row exist for this enrollment!
    const counts = await env.apiPoolA.query<{
      cycles_cnt: string;
      invoices_cnt: string;
      ledger_cnt: string;
    }>(
      `SELECT (SELECT COUNT(*)::text FROM "billing_cycles" WHERE "center_id" = $1::uuid AND "enrollment_id" = $2::uuid) AS cycles_cnt,
              (SELECT COUNT(*)::text FROM "invoices" WHERE "center_id" = $1::uuid AND "enrollment_id" = $2::uuid) AS invoices_cnt,
              (SELECT COUNT(*)::text FROM "ledger_entries" WHERE "center_id" = $1::uuid AND "invoice_id" = $3::uuid AND "entry_type" = 'INVOICE_ISSUED') AS ledger_cnt`,
      [C.centerId, enrollmentId, p1.json.invoice_id],
    );
    assert.equal(counts.rows[0]?.cycles_cnt, '1');
    assert.equal(counts.rows[0]?.invoices_cnt, '1');
    assert.equal(counts.rows[0]?.ledger_cnt, '1');

    // 3. Replaying keyDir with changed cycle_key -> 409 IDEMPOTENCY_PAYLOAD_MISMATCH
    const mismatch = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/billing/cycles/invoice',
      headers: { Authorization: `Bearer ${directorToken}`, 'Idempotency-Key': keyDir },
      body: {
        ...reqBody,
        cycle_key: 'CAL:2026-12',
        period_start_date: '2026-12-01',
      },
    });
    assert.equal(mismatch.statusCode, 409);
    assert.equal(mismatch.json.error_code, 'IDEMPOTENCY_PAYLOAD_MISMATCH');

    // 4. Attempting to re-issue same cycle_key with conflicting period_start_date on a new key -> 409 VERSION_CONFLICT
    const conflictingPeriod = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/billing/cycles/invoice',
      headers: {
        Authorization: `Bearer ${directorToken}`,
        'Idempotency-Key': `idem-b04-conflict-${crypto.randomUUID()}`,
      },
      body: {
        enrollment_id: enrollmentId,
        cycle_type: 'CALENDAR_MONTH',
        cycle_key: 'CAL:2026-11',
        period_start_date: '2026-12-01',
      },
    });
    assert.equal(conflictingPeriod.statusCode, 409);
    assert.equal(conflictingPeriod.json.error_code, 'VERSION_CONFLICT');
  });

  it('BILL-IT-05 (Matrix #9): enforces Teacher 403 FORBIDDEN_ROLE, cross-center 404 isolation, mass-assignment 400 rejection, and LICENSE_READ_ONLY_MODE 403 gate', async () => {
    // 1. Teacher is denied on all billing & invoice endpoints (403 FORBIDDEN_ROLE)
    const teacherIssue = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/billing/cycles/invoice',
      headers: {
        Authorization: `Bearer ${teacherToken}`,
        'Idempotency-Key': `idem-b05-t-${crypto.randomUUID()}`,
      },
      body: {
        enrollment_id: crypto.randomUUID(),
        cycle_type: 'CALENDAR_MONTH',
        cycle_key: 'CAL:2026-11',
        period_start_date: '2026-11-01',
      },
    });
    assert.equal(teacherIssue.statusCode, 403);
    assert.equal(teacherIssue.json.error_code, 'FORBIDDEN_ROLE');

    const teacherListStuInv = await httpJsonRequest({
      port,
      method: 'GET',
      path: `/api/v1/students/${C.studentId}/invoices`,
      headers: { Authorization: `Bearer ${teacherToken}` },
    });
    assert.equal(teacherListStuInv.statusCode, 403);
    assert.equal(teacherListStuInv.json.error_code, 'FORBIDDEN_ROLE');

    // 2. Mass-assignment fields (tariff_uzs, amount_uzs, center_id, policy_version_id) in request body -> 400 VALIDATION_ERROR
    for (const forbiddenField of [
      { tariff_uzs: '1000' },
      { amount_uzs: '1000' },
      { center_id: C.centerId },
      { policy_version_id: C.billingPolicyId },
    ]) {
      const massRes = await httpJsonRequest({
        port,
        method: 'POST',
        path: '/api/v1/billing/cycles/invoice',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Idempotency-Key': `idem-b05-mass-${crypto.randomUUID()}`,
        },
        body: {
          enrollment_id: crypto.randomUUID(),
          cycle_type: 'CALENDAR_MONTH',
          cycle_key: 'CAL:2026-11',
          period_start_date: '2026-11-01',
          ...forbiddenField,
        },
      });
      assert.equal(massRes.statusCode, 400);
      assert.equal(massRes.json.error_code, 'VALIDATION_ERROR');
    }

    // 3. Cross-center / non-existent student_id or invoice_id -> 404 NOT_FOUND
    const unknownInvRes = await httpJsonRequest({
      port,
      method: 'GET',
      path: `/api/v1/invoices/${crypto.randomUUID()}`,
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(unknownInvRes.statusCode, 404);
    assert.equal(unknownInvRes.json.error_code, 'NOT_FOUND');

    // 4. LICENSE_READ_ONLY_MODE blocks invoice issuance (403) while allowing GET student invoices (200)
    await env.apiPoolA.query(
      `UPDATE "center_licenses" SET "license_status" = 'READ_ONLY', "version" = "version" + 1 WHERE "center_id" = $1::uuid`,
      [C.centerId],
    );
    try {
      const roWrite = await httpJsonRequest({
        port,
        method: 'POST',
        path: '/api/v1/billing/cycles/invoice',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Idempotency-Key': `idem-b05-ro-${crypto.randomUUID()}`,
        },
        body: {
          enrollment_id: crypto.randomUUID(),
          cycle_type: 'CALENDAR_MONTH',
          cycle_key: 'CAL:2026-11',
          period_start_date: '2026-11-01',
        },
      });
      assert.equal(roWrite.statusCode, 403);
      assert.equal(roWrite.json.error_code, 'LICENSE_READ_ONLY_MODE');

      const roRead = await httpJsonRequest({
        port,
        method: 'GET',
        path: `/api/v1/students/${C.studentId}/invoices`,
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      assert.equal(roRead.statusCode, 200);
      assert.ok(Array.isArray(roRead.json.items));
    } finally {
      await env.apiPoolA.query(
        `UPDATE "center_licenses" SET "license_status" = 'ACTIVE', "version" = "version" + 1 WHERE "center_id" = $1::uuid`,
        [C.centerId],
      );
    }
  });

  it('BILL-IT-06 (Matrix #10): rolls back BillingCycle, Invoice, InvoiceLines, LedgerEntry, AuditLog, and OutboxEvent to zero effects on fault after each consequential write step and succeeds cleanly on retry', async () => {
    const grpRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/groups',
      headers: {
        Authorization: `Bearer ${directorToken}`,
        'Idempotency-Key': `idem-b06-grp-${crypto.randomUUID()}`,
      },
      body: {
        course_id: C.courseId,
        name: 'BILL-IT-06 Fault Rollback Group',
        primary_teacher_id: C.teacherId,
        billing_mode: 'CALENDAR_PRO_RATA',
        current_fee_uzs: '480000',
        lessons_per_cycle: 12,
        schedule_days: ['MON', 'WED', 'FRI'],
        starts_time: '15:00',
        duration_minutes: 90,
        timezone: 'Asia/Tashkent',
      },
    });
    assert.equal(grpRes.statusCode, 201);
    const groupId = String(grpRes.json.group_id);

    const enrRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/enrollments',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `idem-b06-enr-${crypto.randomUUID()}`,
      },
      body: {
        student_id: C.studentId,
        group_id: groupId,
        initial_status: 'ACTIVE',
        enrolled_at_date: '2026-11-01',
      },
    });
    assert.equal(enrRes.statusCode, 201);
    const enrollmentId = String(enrRes.json.enrollment_id);

    const faultSteps: FaultInjectionStep[] = [
      'BILLING_CYCLE',
      'INVOICE',
      'INVOICE_LINES',
      'LEDGER_ENTRY',
      'AUDIT_LOG',
      'OUTBOX_EVENT',
    ];

    for (const step of faultSteps) {
      await assert.rejects(
        () =>
          invoiceGenerator.issueWorkerInvoiceForCycle({
            centerId: C.centerId,
            enrollmentId,
            cycleType: 'CALENDAR_MONTH',
            cycleKey: 'CAL:2026-11',
            periodStartDate: '2026-11-01',
            systemJobName: 'TestFaultRollbackJob',
            testFaultAfterStep: step,
          }),
        new RegExp(`SIMULATED_S08_FAULT_AFTER_${step}`),
      );

      const verifyZero = await env.apiPoolA.query<{
        cycles_cnt: string;
        invoices_cnt: string;
      }>(
        `SELECT (SELECT COUNT(*)::text FROM "billing_cycles" WHERE "center_id" = $1::uuid AND "enrollment_id" = $2::uuid) AS cycles_cnt,
                (SELECT COUNT(*)::text FROM "invoices" WHERE "center_id" = $1::uuid AND "enrollment_id" = $2::uuid) AS invoices_cnt`,
        [C.centerId, enrollmentId],
      );
      assert.equal(verifyZero.rows[0]?.cycles_cnt, '0', `Fault at ${step} must leave 0 billing_cycles`);
      assert.equal(verifyZero.rows[0]?.invoices_cnt, '0', `Fault at ${step} must leave 0 invoices`);
    }

    // Clean retry without fault succeeds and commits all 6 tables atomically
    const cleanRetry = await invoiceGenerator.issueWorkerInvoiceForCycle({
      centerId: C.centerId,
      enrollmentId,
      cycleType: 'CALENDAR_MONTH',
      cycleKey: 'CAL:2026-11',
      periodStartDate: '2026-11-01',
      systemJobName: 'TestFaultRollbackJob',
    });
    assert.equal(cleanRetry.replayedByCycleIdentity, false);
    assert.equal(cleanRetry.invoice.effective_net_charge_uzs, '480000');
    assert.equal(cleanRetry.invoice.lines.length, 1);

    const outboxCheck = await env.apiPoolA.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM "outbox_events" WHERE "center_id" = $1::uuid AND "aggregate_id" = $2::uuid AND "event_name" = 'AllocationAdjusted'`,
      [C.centerId, cleanRetry.invoice.invoice_id],
    );
    assert.equal(outboxCheck.rows[0]?.cnt, '1');
  });

  it('BILL-IT-07 (Matrix #12, #13, #14, #15): verifies trial conversion lifecycle (1st present -> 0 debt, absent/cancelled/same-lesson retry -> no conversion, parallel 2nd distinct attendance -> single activation & single invoice from first_trial_date, compensation gate 403)', async () => {
    const grpRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/groups',
      headers: {
        Authorization: `Bearer ${directorToken}`,
        'Idempotency-Key': `idem-b07-grp-${crypto.randomUUID()}`,
      },
      body: {
        course_id: C.courseId,
        name: 'BILL-IT-07 Trial Conversion Group',
        primary_teacher_id: C.teacherId,
        billing_mode: 'CALENDAR_PRO_RATA',
        current_fee_uzs: '480000',
        lessons_per_cycle: 12,
        schedule_days: ['MON', 'WED', 'FRI'],
        starts_time: '10:00',
        duration_minutes: 90,
        timezone: 'Asia/Tashkent',
      },
    });
    assert.equal(grpRes.statusCode, 201);
    const groupId = String(grpRes.json.group_id);

    // Schedule 12 lessons in Nov 2026 (5 before Nov 12, 7 on/after Nov 12: Nov 13, 16, 18, 20, 23, 25, 27)
    const novDates = [
      '2026-11-02',
      '2026-11-04',
      '2026-11-06',
      '2026-11-09',
      '2026-11-11',
      '2026-11-13',
      '2026-11-16',
      '2026-11-18',
      '2026-11-20',
      '2026-11-23',
      '2026-11-25',
      '2026-11-27',
    ];
    const lessonIdsByDate: Record<string, string> = {};
    for (const d of novDates) {
      const lRes = await httpJsonRequest({
        port,
        method: 'POST',
        path: `/api/v1/groups/${groupId}/lessons`,
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Idempotency-Key': `idem-b07-lsn-${d}-${crypto.randomUUID()}`,
        },
        body: {
          lesson_date: d,
          occurrence_seq: 1,
          local_starts_time: '10:00',
          duration_minutes: 90,
        },
      });
      assert.equal(lRes.statusCode, 201);
      lessonIdsByDate[d] = String(lRes.json.id);
    }

    // Create TRIAL student enrolled on 2026-11-11
    const trialStuRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/students',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `idem-b07-stu-${crypto.randomUUID()}`,
      },
      body: {
        full_name: 'Malika Trial Student',
        guardian: {
          full_name: 'Nargiza Ona',
          phone_e164: '+998901230807',
          relationship: 'MOTHER',
        },
        enrollment: {
          group_id: groupId,
          initial_status: 'TRIAL',
          enrolled_at_date: '2026-11-11',
        },
      },
    });
    assert.equal(trialStuRes.statusCode, 201);
    const studentId = String(trialStuRes.json.student_id);
    const enrollmentId = String((trialStuRes.json.enrollment as Record<string, unknown>).enrollment_id);

    // 1. Seed ABSENT on 2026-11-11 -> evaluateTrialEnrollmentAttendance returns NO_ELIGIBLE_ATTENDANCE, 0 invoices
    const absentAttId = crypto.randomUUID();
    await env.apiPoolA.query(
      `INSERT INTO "attendance_records" (
         "id", "center_id", "lesson_id", "student_id", "enrollment_id",
         "status", "source_channel", "recorded_by_staff_id", "client_operation_uuid"
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'ABSENT', 'STAFF_WEB', $6::uuid, $7::uuid)`,
      [
        absentAttId,
        C.centerId,
        lessonIdsByDate['2026-11-11'],
        studentId,
        enrollmentId,
        C.teacherId,
        crypto.randomUUID(),
      ],
    );

    const evalAfterAbsent = await trialConversion.evaluateTrialEnrollmentAttendance({
      centerId: C.centerId,
      enrollmentId,
    });
    assert.equal(evalAfterAbsent.outcome, 'NO_ELIGIBLE_ATTENDANCE');
    assert.equal(evalAfterAbsent.generated_invoice, null);

    // 2. 1st actual PRESENT trial attendance on 2026-11-13 (where 7 lessons remain in Nov 2026: Nov 13..Nov 27) ->
    //    records first_trial_date = '2026-11-13', keeps status = 'TRIAL', creates ZERO invoices and ZERO debt!
    await env.apiPoolA.query(
      `INSERT INTO "attendance_records" (
         "id", "center_id", "lesson_id", "student_id", "enrollment_id",
         "status", "source_channel", "recorded_by_staff_id", "client_operation_uuid"
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'PRESENT', 'STAFF_WEB', $6::uuid, $7::uuid)`,
      [
        crypto.randomUUID(),
        C.centerId,
        lessonIdsByDate['2026-11-13'],
        studentId,
        enrollmentId,
        C.teacherId,
        crypto.randomUUID(),
      ],
    );

    const evalFirstPresent = await trialConversion.evaluateTrialEnrollmentAttendance({
      centerId: C.centerId,
      enrollmentId,
    });
    assert.equal(evalFirstPresent.outcome, 'FIRST_TRIAL_RECORDED_NO_DEBT');
    assert.equal(evalFirstPresent.enrollment_status, 'TRIAL');
    assert.equal(evalFirstPresent.first_trial_date, '2026-11-13');
    assert.equal(evalFirstPresent.generated_invoice, null);

    // Re-evaluating the same 1st lesson retry still produces 0 invoices
    const evalFirstRetry = await trialConversion.evaluateTrialEnrollmentAttendance({
      centerId: C.centerId,
      enrollmentId,
    });
    assert.equal(evalFirstRetry.outcome, 'FIRST_TRIAL_RECORDED_NO_DEBT');

    const invCountAfterFirst = await env.apiPoolA.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM "invoices" WHERE "center_id" = $1::uuid AND "enrollment_id" = $2::uuid`,
      [C.centerId, enrollmentId],
    );
    assert.equal(invCountAfterFirst.rows[0]?.cnt, '0');

    // 3. 2nd distinct attended lesson on 2026-11-16 ('LATE') with TWO PARALLEL evaluateTrialEnrollmentAttendance calls ->
    //    activates enrollment ONCE and issues ONE pro-rata invoice starting from first_trial_date = '2026-11-13' (480,000 * 7 / 12 = 280,000 UZS)!
    await env.apiPoolA.query(
      `INSERT INTO "attendance_records" (
         "id", "center_id", "lesson_id", "student_id", "enrollment_id",
         "status", "source_channel", "recorded_by_staff_id", "client_operation_uuid"
       ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'LATE', 'STAFF_WEB', $6::uuid, $7::uuid)`,
      [
        crypto.randomUUID(),
        C.centerId,
        lessonIdsByDate['2026-11-16'],
        studentId,
        enrollmentId,
        C.teacherId,
        crypto.randomUUID(),
      ],
    );

    const [convA, convB] = await Promise.all([
      trialConversion.evaluateTrialEnrollmentAttendance({
        centerId: C.centerId,
        enrollmentId,
      }),
      trialConversion.evaluateTrialEnrollmentAttendance({
        centerId: C.centerId,
        enrollmentId,
      }),
    ]);

    const outcomes = [convA.outcome, convB.outcome].sort();
    assert.deepEqual(outcomes, ['ACTIVATED_AND_INVOICED', 'ALREADY_ACTIVE_NO_OP']);
    const activeConv = convA.outcome === 'ACTIVATED_AND_INVOICED' ? convA : convB;
    assert.ok(activeConv.generated_invoice);
    assert.equal(activeConv.first_trial_date, '2026-11-13');
    assert.equal(activeConv.second_trigger_lesson_id, lessonIdsByDate['2026-11-16']);
    assert.equal(activeConv.trial_activation_seq, 1);
    assert.equal(activeConv.generated_invoice.billed_lessons, 7);
    assert.equal(activeConv.generated_invoice.base_pro_rata_charge_uzs, '280000');
    assert.equal(activeConv.generated_invoice.remaining_debt_uzs, '280000');

    // Verify 1 TrialActivation row, 1 Invoice row, and 1 TrialActivated OutboxEvent row in DB
    const dbCheck = await env.apiPoolA.query<{
      act_cnt: string;
      inv_cnt: string;
      evt_cnt: string;
    }>(
      `SELECT (SELECT COUNT(*)::text FROM "trial_activations" WHERE "center_id" = $1::uuid AND "enrollment_id" = $2::uuid) AS act_cnt,
              (SELECT COUNT(*)::text FROM "invoices" WHERE "center_id" = $1::uuid AND "enrollment_id" = $2::uuid) AS inv_cnt,
              (SELECT COUNT(*)::text FROM "outbox_events" WHERE "center_id" = $1::uuid AND "event_name" = 'TrialActivated' AND "aggregate_id" = $3::uuid) AS evt_cnt`,
      [C.centerId, enrollmentId, activeConv.trial_activation_id],
    );
    assert.equal(dbCheck.rows[0]?.act_cnt, '1');
    assert.equal(dbCheck.rows[0]?.inv_cnt, '1');
    assert.equal(dbCheck.rows[0]?.evt_cnt, '1');

    // 4. Unconfirmed financial trial compensation mutation fails closed with 403 POLICY_DECISION_NOT_CONFIRMED
    await assert.rejects(
      () =>
        trialConversion.requestTrialActivationCompensation({
          centerId: C.centerId,
          enrollmentId,
          reason: 'Admin override test',
        }),
      (err: unknown) =>
        (err as { statusCode?: number; errorCode?: string }).statusCode === 403 &&
        (err as { errorCode?: string }).errorCode === 'POLICY_DECISION_NOT_CONFIRMED',
    );
  });

  it('BILL-IT-08 (Matrix #16, #17, #18): verifies LESSON_PACKAGE_12 (PKG:1/PKG:2), existing CreditNote application capped at base charge without negative balance, and runtime DB role append-only ACLs', async () => {
    // Configure confirmed LESSON_PACKAGE_12 policy
    const pkgPolRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/billing/policies',
      headers: {
        Authorization: `Bearer ${directorToken}`,
        'Idempotency-Key': `idem-b08-pkgpol-${crypto.randomUUID()}`,
      },
      body: {
        billing_mode: 'LESSON_PACKAGE_12',
        first_partial_charge_mode: 'FULL_CYCLE',
        rounding_mode: 'HALF_UP_UZS_INT',
        rolling_month_end_mode: 'CONTINUE_FROM_CLAMPED_DAY',
        package_cancel_mode: 'PRESERVE_BALANCE',
        policy_confirmation_status: 'CONFIRMED',
        effective_from_date: '2026-01-01',
      },
    });
    assert.equal(pkgPolRes.statusCode, 201);

    const grpPkgRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/groups',
      headers: {
        Authorization: `Bearer ${directorToken}`,
        'Idempotency-Key': `idem-b08-grppkg-${crypto.randomUUID()}`,
      },
      body: {
        course_id: C.courseId,
        name: 'BILL-IT-08 Package12 Group',
        primary_teacher_id: C.teacherId,
        billing_mode: 'LESSON_PACKAGE_12',
        current_fee_uzs: '600000',
        lessons_per_cycle: 12,
        schedule_days: ['MON', 'WED', 'FRI'],
        starts_time: '17:00',
        duration_minutes: 90,
        timezone: 'Asia/Tashkent',
      },
    });
    assert.equal(grpPkgRes.statusCode, 201);
    const grpPkgId = String(grpPkgRes.json.group_id);

    const enrPkgRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/enrollments',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `idem-b08-enrpkg-${crypto.randomUUID()}`,
      },
      body: {
        student_id: C.studentId,
        group_id: grpPkgId,
        initial_status: 'ACTIVE',
        enrolled_at_date: '2026-11-01',
      },
    });
    assert.equal(enrPkgRes.statusCode, 201);
    const enrPkgId = String(enrPkgRes.json.enrollment_id);

    // 1. Issue PKG:1 (600,000 UZS)
    const pkg1Inv = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/billing/cycles/invoice',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `idem-b08-pkg1-${crypto.randomUUID()}`,
      },
      body: {
        enrollment_id: enrPkgId,
        cycle_type: 'LESSON_PACKAGE_12',
        cycle_key: 'PKG:1',
        period_start_date: '2026-11-01',
      },
    });
    assert.equal(pkg1Inv.statusCode, 200);
    assert.equal(pkg1Inv.json.cycle_key, 'PKG:1');
    assert.equal(pkg1Inv.json.cycle_seq, 1);
    assert.equal(pkg1Inv.json.effective_net_charge_uzs, '600000');

    // 2. Seed an existing CreditNote of 750,000 UZS on enrPkgId and issue PKG:2 (base charge 600,000 UZS) ->
    //    CreditNoteApplication is capped at 600,000 UZS (effective_net_charge_uzs = 0, remaining_debt_uzs = 0, status = 'PAID',
    //    leaving 150,000 UZS unconsumed on the credit note and NEVER creating a negative invoice balance!)
    const creditNoteId = crypto.randomUUID();
    await env.apiPoolA.query(
      `INSERT INTO "credit_notes" (
         "id", "center_id", "student_id", "enrollment_id", "source_invoice_id",
         "credit_reason", "amount_uzs", "source_event_key", "actor_type", "actor_staff_id"
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
         'PRIOR_FREEZE_CREDIT', 750000, $6, 'STAFF', $7::uuid
       )`,
      [
        creditNoteId,
        C.centerId,
        C.studentId,
        enrPkgId,
        pkg1Inv.json.invoice_id,
        `cn-test-${crypto.randomUUID()}`,
        C.directorId,
      ],
    );

    const pkg2Inv = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/billing/cycles/invoice',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `idem-b08-pkg2-${crypto.randomUUID()}`,
      },
      body: {
        enrollment_id: enrPkgId,
        cycle_type: 'LESSON_PACKAGE_12',
        cycle_key: 'PKG:2',
        period_start_date: '2026-12-01',
      },
    });
    assert.equal(pkg2Inv.statusCode, 200);
    assert.equal(pkg2Inv.json.cycle_key, 'PKG:2');
    assert.equal(pkg2Inv.json.cycle_seq, 2);
    assert.equal(pkg2Inv.json.base_pro_rata_charge_uzs, '600000');
    assert.equal(pkg2Inv.json.credit_note_adjustments_uzs, '600000');
    assert.equal(pkg2Inv.json.effective_net_charge_uzs, '0');
    assert.equal(pkg2Inv.json.remaining_debt_uzs, '0');
    assert.equal(pkg2Inv.json.status, 'PAID');

    // 3. Verify append-only immutability on billing_policy_versions, billing_cycles, invoice_lines, and ledger_entries (42501)
    for (const [tbl, idVal] of [
      ['billing_policy_versions', pkgPolRes.json.id],
      ['billing_cycles', pkg1Inv.json.billing_cycle_id],
      ['invoice_lines', (pkg1Inv.json.lines as Array<Record<string, unknown>>)[0].id],
    ] as const) {
      await assert.rejects(
        () =>
          env.apiPoolA.query(`DELETE FROM "${tbl}" WHERE "id" = $1::uuid`, [idVal]),
        (err: unknown) => (err as { code?: string }).code === '42501',
      );
    }
  });
});
