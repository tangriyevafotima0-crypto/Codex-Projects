import { INestApplication } from '@nestjs/common';
import * as assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as http from 'node:http';
import { after, before, describe, it } from 'node:test';
import { createApiApplication } from '../../src/application';
import { ClockService } from '../../src/auth/clock.service';
import { loadApiEnv } from '../../src/config/env';
import {
  executeSyntheticSeed,
  SYNTHETIC_DEMO_CENTER_A as C,
  SYNTHETIC_DEMO_CENTER_B as CB,
  SYNTHETIC_TEST_ONLY_PASSWORD,
} from '../../src/database/seed-contract';
import { DiscountApprovalService } from '../../src/adjustments/discount-approval';
import { FreezeCreditService } from '../../src/adjustments/freeze-credit';
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

describe('Gate G6 — Stage 09 Discounts, Stacking, Grants, Freezes & Withdrawals HTTP + PostgreSQL Integration Suite (ADJ-IT-01..08)', () => {
  let env: EphemeralDatabaseEnvironment;
  let app: INestApplication;
  let port = 0;

  let directorToken = '';
  let adminToken = '';
  let teacherToken = '';

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
    app.get(ClockService).setTestNow(new Date('2026-11-04T09:00:00Z'));
    await app.listen(0, '127.0.0.1');
    const addr = app.getHttpServer().address();
    port = typeof addr === 'object' && addr ? addr.port : 0;

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

  it('ADJ-IT-01 (09.01, T09.01): creates discount/grant requests without mutating invoice or debt, enforces reason/expiry/percent/fixed bounds, rejects mass-assignment, and validates authenticated guardian family offer eligibility', async () => {
    // 1. Confirm S08 billing policy ONLY (without discount_stacking_mode or freeze_credit_basis)
    const s08PolicyRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/billing/policies',
      headers: {
        Authorization: `Bearer ${directorToken}`,
        'Idempotency-Key': `idem-adj01-s08pol-${crypto.randomUUID()}`,
      },
      body: {
        billing_mode: 'CALENDAR_PRO_RATA',
        first_partial_charge_mode: 'PRORATE_REMAINING_LESSONS',
        policy_confirmation_status: 'CONFIRMED',
        effective_from_date: '2026-01-01',
      },
    });
    assert.equal(s08PolicyRes.statusCode, 201);
    assert.equal(s08PolicyRes.json.policy_confirmation_status, 'CONFIRMED');
    assert.equal(s08PolicyRes.json.discount_policy_status, 'UNCONFIGURED');
    assert.equal(s08PolicyRes.json.freeze_policy_status, 'UNCONFIGURED');

    // Create an enrollment and issue a November 2026 invoice (480,000 UZS)
    const stuRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/students',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `idem-adj01-stu1-${crypto.randomUUID()}`,
      },
      body: {
        student_full_name: 'Azizbek Karimov',
        guardian_full_name: 'Karim Ota',
        guardian_phone_e164: '+998901239901',
        relationship: 'FATHER',
        group_id: C.groupId,
        initial_status: 'ACTIVE',
        enrolled_at_date: '2026-11-01',
      },
    });
    assert.equal(stuRes.statusCode, 201);
    const enrollmentId = String(
      ((stuRes.json.enrollments as Array<Record<string, unknown>>)[0]).enrollment_id,
    );

    const invRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/billing/cycles/invoice',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `idem-adj01-inv-${crypto.randomUUID()}`,
      },
      body: {
        enrollment_id: enrollmentId,
        cycle_type: 'CALENDAR_MONTH',
        cycle_key: 'CAL:2026-11',
        period_start_date: '2026-11-01',
      },
    });
    assert.equal(invRes.statusCode, 200);
    const invoiceId = String(invRes.json.invoice_id);
    assert.equal(invRes.json.effective_net_charge_uzs, '480000');

    // 2. TEACHER is strictly denied (403 FORBIDDEN_ROLE)
    const teacherAttempt = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/discounts/requests',
      headers: {
        Authorization: `Bearer ${teacherToken}`,
        'Idempotency-Key': `idem-adj01-tch-${crypto.randomUUID()}`,
      },
      body: {
        enrollment_id: enrollmentId,
        target_invoice_id: invoiceId,
        discount_kind: 'SPECIAL_50_PERCENT',
        reason: 'Teacher unauthorized attempt',
        valid_from: '2026-11-01',
        valid_until: '2026-11-30',
      },
    });
    assert.equal(teacherAttempt.statusCode, 403);
    assert.equal(teacherAttempt.json.error_code, 'FORBIDDEN_ROLE');

    // 3. Fixed discount > invoice base charge (500,000 > 480,000) is rejected with 422 (T09.01)
    const excessiveFixed = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/discounts/requests',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `idem-adj01-exfix-${crypto.randomUUID()}`,
      },
      body: {
        enrollment_id: enrollmentId,
        target_invoice_id: invoiceId,
        discount_kind: 'CUSTOM_FIXED',
        fixed_amount_uzs: '500000',
        reason: 'Excessive fixed discount',
        valid_from: '2026-11-01',
        valid_until: '2026-11-30',
      },
    });
    assert.equal(excessiveFixed.statusCode, 422);
    assert.equal(excessiveFixed.json.error_code, 'VALIDATION_ERROR');

    // 4. FAMILY_DISCOUNT before a second child is linked to the guardian is rejected with 422
    const prematureFamily = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/discounts/requests',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `idem-adj01-prefam-${crypto.randomUUID()}`,
      },
      body: {
        enrollment_id: enrollmentId,
        target_invoice_id: invoiceId,
        discount_kind: 'FAMILY_DISCOUNT',
        fixed_amount_uzs: '50000',
        reason: 'Single child family attempt',
        valid_from: '2026-11-01',
        valid_until: '2026-11-30',
      },
    });
    assert.equal(prematureFamily.statusCode, 422);
    assert.equal(prematureFamily.json.error_code, 'VALIDATION_ERROR');

    // Register a second sibling linked to the same guardian (reuse_existing_guardian: true)
    const siblingRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/students',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `idem-adj01-stu2-${crypto.randomUUID()}`,
      },
      body: {
        student_full_name: 'Madina Karimova',
        guardian_full_name: 'Karim Ota',
        guardian_phone_e164: '+998901239901',
        relationship: 'FATHER',
        reuse_existing_guardian: true,
        confirm_sibling_or_similar_name: true,
        group_id: C.groupId,
        initial_status: 'ACTIVE',
        enrolled_at_date: '2026-11-01',
      },
    });
    assert.equal(siblingRes.statusCode, 201);
    assert.equal(siblingRes.json.family_discount_eligible, true);

    // 5. Admin creates a valid SPECIAL_50_PERCENT request -> 201 PENDING_APPROVAL, invoice & debt UNCHANGED!
    const idemKey50 = `idem-adj01-req50-${crypto.randomUUID()}`;
    const req50Res = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/discounts/requests',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': idemKey50,
      },
      body: {
        enrollment_id: enrollmentId,
        target_invoice_id: invoiceId,
        discount_kind: 'SPECIAL_50_PERCENT',
        reason: 'Regional math olympiad winner',
        valid_from: '2026-11-01',
        valid_until: '2026-11-30',
      },
    });
    assert.equal(req50Res.statusCode, 201);
    assert.equal(req50Res.json.status, 'PENDING_APPROVAL');
    assert.equal(req50Res.json.applied_amount_uzs, '0');
    assert.equal(req50Res.json.family_offer_eligible, true);

    // Verify invoice and ledger are untouched while request is PENDING_APPROVAL
    const invCheck = await httpJsonRequest({
      port,
      method: 'GET',
      path: `/api/v1/invoices/${invoiceId}`,
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(invCheck.statusCode, 200);
    assert.equal(invCheck.json.approved_discount_uzs, '0');
    assert.equal(invCheck.json.effective_net_charge_uzs, '480000');
    assert.equal(invCheck.json.remaining_debt_uzs, '480000');

    // Same Idempotency-Key with mutated reason returns 409 IDEMPOTENCY_PAYLOAD_MISMATCH
    const mismatchRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/discounts/requests',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': idemKey50,
      },
      body: {
        enrollment_id: enrollmentId,
        target_invoice_id: invoiceId,
        discount_kind: 'SPECIAL_50_PERCENT',
        reason: 'Mutated reason under same key',
        valid_from: '2026-11-01',
        valid_until: '2026-11-30',
      },
    });
    assert.equal(mismatchRes.statusCode, 409);
    assert.equal(mismatchRes.json.error_code, 'IDEMPOTENCY_PAYLOAD_MISMATCH');
  });

  it('ADJ-IT-02 (09.02, OWNER-20261105-04): blocks Director discount approval with 403 POLICY_DECISION_NOT_CONFIRMED when only S08 billing policy is confirmed, and blocks Admin/Teacher from approving', async () => {
    const reqList = await env.apiPoolA.query<{ id: string; enrollment_id: string }>(
      `SELECT "id"::text AS id, "enrollment_id"::text AS enrollment_id
         FROM "discount_requests"
        WHERE "center_id" = $1::uuid AND "status" = 'PENDING_APPROVAL'
        LIMIT 1`,
      [C.centerId],
    );
    const discountRequestId = reqList.rows[0]!.id;

    // 1. ADMIN is strictly denied on /decision (403 FORBIDDEN_ROLE)
    const adminApprove = await httpJsonRequest({
      port,
      method: 'POST',
      path: `/api/v1/discounts/requests/${discountRequestId}/decision`,
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `idem-adj02-adm-${crypto.randomUUID()}`,
      },
      body: {
        decision: 'APPROVED',
        expected_version: 1,
      },
    });
    assert.equal(adminApprove.statusCode, 403);
    assert.equal(adminApprove.json.error_code, 'FORBIDDEN_ROLE');

    // 2. DIRECTOR approval BEFORE S09 discount_stacking_mode is confirmed fails closed with 403 POLICY_DECISION_NOT_CONFIRMED!
    const unconfApprove = await httpJsonRequest({
      port,
      method: 'POST',
      path: `/api/v1/discounts/requests/${discountRequestId}/decision`,
      headers: {
        Authorization: `Bearer ${directorToken}`,
        'Idempotency-Key': `idem-adj02-unconf-${crypto.randomUUID()}`,
      },
      body: {
        decision: 'APPROVED',
        decision_note: 'Attempt before S09 discount policy is configured',
        expected_version: 1,
      },
    });
    assert.equal(unconfApprove.statusCode, 403);
    assert.equal(unconfApprove.json.error_code, 'POLICY_DECISION_NOT_CONFIRMED');

    const dbCheck = await env.apiPoolA.query<{
      req_status: string;
      approvals_cnt: number;
      ledger_cnt: number;
    }>(
      `SELECT (SELECT "status"::text FROM "discount_requests" WHERE "id" = $1::uuid) AS req_status,
              (SELECT COUNT(*)::int FROM "discount_approvals" WHERE "discount_request_id" = $1::uuid) AS approvals_cnt,
              (SELECT COUNT(*)::int FROM "ledger_entries" WHERE "center_id" = $2::uuid AND "entry_type" = 'DISCOUNT_APPLIED') AS ledger_cnt`,
      [discountRequestId, C.centerId],
    );
    assert.equal(dbCheck.rows[0]?.req_status, 'PENDING_APPROVAL');
    assert.equal(dbCheck.rows[0]?.approvals_cnt, 0);
    assert.equal(dbCheck.rows[0]?.ledger_cnt, 0);
  });

  it('ADJ-IT-03 (09.02, T09.02, CASE-07): executes Director approval after explicit discount policy confirmation, serializes parallel Director approvals to 1 effect, and rolls back on injected fault', async () => {
    // 1. Director explicitly configures discount_stacking_mode = 'MAX_SINGLE' (effective 2026-01-01)
    const discPolRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/billing/policies',
      headers: {
        Authorization: `Bearer ${directorToken}`,
        'Idempotency-Key': `idem-adj03-pol-${crypto.randomUUID()}`,
      },
      body: {
        billing_mode: 'CALENDAR_PRO_RATA',
        first_partial_charge_mode: 'PRORATE_REMAINING_LESSONS',
        discount_stacking_mode: 'MAX_SINGLE',
        policy_confirmation_status: 'CONFIRMED',
        effective_from_date: '2026-01-01',
      },
    });
    assert.equal(discPolRes.statusCode, 201);
    assert.equal(discPolRes.json.discount_policy_status, 'CONFIRMED');
    assert.equal(discPolRes.json.discount_stacking_mode, 'MAX_SINGLE');
    assert.equal(discPolRes.json.freeze_policy_status, 'UNCONFIGURED');

    const reqRow = await env.apiPoolA.query<{
      id: string;
      target_invoice_id: string;
    }>(
      `SELECT "id"::text AS id, "target_invoice_id"::text AS target_invoice_id
         FROM "discount_requests"
        WHERE "center_id" = $1::uuid AND "status" = 'PENDING_APPROVAL'
        LIMIT 1`,
      [C.centerId],
    );
    const discountRequestId = reqRow.rows[0]!.id;
    const targetInvoiceId = reqRow.rows[0]!.target_invoice_id;

    // 2. Fault injection after LEDGER_ENTRY rolls back the entire transaction atomically
    const approvalService = app.get(DiscountApprovalService);
    await assert.rejects(
      () =>
        approvalService.decideDiscountOrGrantRequest(
          {
            headers: {
              'idempotency-key': `idem-adj03-fault-${crypto.randomUUID()}`,
              'x-request-id': 'req-adj03-fault',
            },
          } as never,
          {
            staffId: C.directorId,
            centerId: C.centerId,
            centerSlug: C.centerSlug,
            role: 'DIRECTOR',
            sessionId: crypto.randomUUID(),
            mustChangePassword: false,
            familyId: crypto.randomUUID(),
            staffVersion: 1,
            transportMode: 'BEARER',
            csrfTokenHash: null,
            licenseMode: 'ACTIVE',
          },
          discountRequestId,
          { decision: 'APPROVED', expected_version: 1 },
          { testFaultAfterStep: 'LEDGER_ENTRY' },
        ),
      /SIMULATED_S09_DISCOUNT_FAULT_AFTER_LEDGER_ENTRY/,
    );

    const afterFault = await env.apiPoolA.query<{ status: string; inv_disc: string }>(
      `SELECT (SELECT "status"::text FROM "discount_requests" WHERE "id" = $1::uuid) AS status,
              (SELECT "approved_discount_uzs"::text FROM "invoices" WHERE "id" = $2::uuid) AS inv_disc`,
      [discountRequestId, targetInvoiceId],
    );
    assert.equal(afterFault.rows[0]?.status, 'PENDING_APPROVAL');
    assert.equal(afterFault.rows[0]?.inv_disc, '0');

    // 3. Two parallel Director approvals with different Idempotency-Keys race ->
    //    exactly ONE succeeds (200) and the other returns 409 VERSION_CONFLICT!
    const [raceA, raceB] = await Promise.all([
      httpJsonRequest({
        port,
        method: 'POST',
        path: `/api/v1/discounts/requests/${discountRequestId}/decision`,
        headers: {
          Authorization: `Bearer ${directorToken}`,
          'Idempotency-Key': `idem-adj03-raceA-${crypto.randomUUID()}`,
        },
        body: {
          decision: 'APPROVED',
          decision_note: 'Approved 50% scholarship',
          expected_version: 1,
        },
      }),
      httpJsonRequest({
        port,
        method: 'POST',
        path: `/api/v1/discounts/requests/${discountRequestId}/decision`,
        headers: {
          Authorization: `Bearer ${directorToken}`,
          'Idempotency-Key': `idem-adj03-raceB-${crypto.randomUUID()}`,
        },
        body: {
          decision: 'APPROVED',
          decision_note: 'Concurrent duplicate approval attempt',
          expected_version: 1,
        },
      }),
    ]);

    const statuses = [raceA.statusCode, raceB.statusCode].sort((a, b) => a - b);
    assert.deepEqual(statuses, [200, 409]);

    const winner = raceA.statusCode === 200 ? raceA : raceB;
    assert.equal(winner.json.status, 'APPROVED');
    assert.equal(winner.json.applied_amount_uzs, '240000');

    const invAfter = await httpJsonRequest({
      port,
      method: 'GET',
      path: `/api/v1/invoices/${targetInvoiceId}`,
      headers: { Authorization: `Bearer ${directorToken}` },
    });
    assert.equal(invAfter.statusCode, 200);
    assert.equal(invAfter.json.approved_discount_uzs, '240000');
    assert.equal(invAfter.json.effective_net_charge_uzs, '240000');
    assert.equal(invAfter.json.remaining_debt_uzs, '240000');
    assert.equal(invAfter.json.status, 'ISSUED_OPEN');

    const dbVerify = await env.apiPoolA.query<{
      app_cnt: number;
      led_cnt: number;
      evt_cnt: number;
    }>(
      `SELECT (SELECT COUNT(*)::int FROM "discount_approvals" WHERE "discount_request_id" = $1::uuid) AS app_cnt,
              (SELECT COUNT(*)::int FROM "ledger_entries" WHERE "invoice_id" = $2::uuid AND "entry_type" = 'DISCOUNT_APPLIED') AS led_cnt,
              (SELECT COUNT(*)::int FROM "outbox_events" WHERE "aggregate_id" = $1::uuid AND "event_name" = 'DiscountApproved') AS evt_cnt`,
      [discountRequestId, targetInvoiceId],
    );
    assert.equal(dbVerify.rows[0]?.app_cnt, 1);
    assert.equal(dbVerify.rows[0]?.led_cnt, 1);
    assert.equal(dbVerify.rows[0]?.evt_cnt, 1);
  });

  it('ADJ-IT-04 (09.02, OWNER-20261105-04, CASE-08, CASE-09): verifies MAX_SINGLE (384,000) vs SEQUENTIAL (345,600) stacking, FULL_GRANT_100 (0 debt, no cash refund), and retroactive overpaid invoice 403 gate', async () => {
    // Create explicit MAX_SINGLE and SEQUENTIAL policy versions
    const maxPolRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/billing/policies',
      headers: {
        Authorization: `Bearer ${directorToken}`,
        'Idempotency-Key': `idem-adj04-maxpol-${crypto.randomUUID()}`,
      },
      body: {
        billing_mode: 'CALENDAR_PRO_RATA',
        first_partial_charge_mode: 'PRORATE_REMAINING_LESSONS',
        discount_stacking_mode: 'MAX_SINGLE',
        policy_confirmation_status: 'CONFIRMED',
        effective_from_date: '2026-01-01',
      },
    });
    assert.equal(maxPolRes.statusCode, 201);
    const maxPolId = String(maxPolRes.json.id);

    const seqPolRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/billing/policies',
      headers: {
        Authorization: `Bearer ${directorToken}`,
        'Idempotency-Key': `idem-adj04-seqpol-${crypto.randomUUID()}`,
      },
      body: {
        billing_mode: 'CALENDAR_PRO_RATA',
        first_partial_charge_mode: 'PRORATE_REMAINING_LESSONS',
        discount_stacking_mode: 'SEQUENTIAL',
        policy_confirmation_status: 'CONFIRMED',
        effective_from_date: '2026-01-01',
      },
    });
    assert.equal(seqPolRes.statusCode, 201);
    const seqPolId = String(seqPolRes.json.id);

    for (const [label, polId, expectedNetAfterSecond, expectedTotalDiscount] of [
      ['MAX_SINGLE', maxPolId, '384000', '96000'],
      ['SEQUENTIAL', seqPolId, '345600', '134400'],
    ] as const) {
      const grpRes = await httpJsonRequest({
        port,
        method: 'POST',
        path: '/api/v1/groups',
        headers: {
          Authorization: `Bearer ${directorToken}`,
          'Idempotency-Key': `idem-adj04-grp-${label}-${crypto.randomUUID()}`,
        },
        body: {
          course_id: C.courseId,
          name: `ADJ-IT-04 ${label} Group`,
          primary_teacher_id: C.teacherId,
          billing_mode: 'CALENDAR_PRO_RATA',
          billing_policy_version_id: polId,
          current_fee_uzs: '480000',
          lessons_per_cycle: 12,
          schedule_days: ['MON', 'WED', 'FRI'],
          starts_time: label === 'MAX_SINGLE' ? '13:00' : '14:15',
          duration_minutes: 60,
          timezone: 'Asia/Tashkent',
        },
      });
      assert.equal(grpRes.statusCode, 201);
      const grpId = String(grpRes.json.group_id);

      const enrRes = await httpJsonRequest({
        port,
        method: 'POST',
        path: '/api/v1/enrollments',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Idempotency-Key': `idem-adj04-enr-${label}-${crypto.randomUUID()}`,
        },
        body: {
          student_id: C.studentId,
          group_id: grpId,
          initial_status: 'ACTIVE',
          enrolled_at_date: '2026-11-01',
        },
      });
      assert.equal(enrRes.statusCode, 201);
      const enrId = String(enrRes.json.enrollment_id);

      const invRes = await httpJsonRequest({
        port,
        method: 'POST',
        path: '/api/v1/billing/cycles/invoice',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Idempotency-Key': `idem-adj04-inv-${label}-${crypto.randomUUID()}`,
        },
        body: {
          enrollment_id: enrId,
          cycle_type: 'CALENDAR_MONTH',
          cycle_key: 'CAL:2026-11',
          period_start_date: '2026-11-01',
        },
      });
      assert.equal(invRes.statusCode, 200);
      const invId = String(invRes.json.invoice_id);

      // Apply 20% discount (96,000 -> 384,000) then 10% discount
      for (const pct of [20, 10]) {
        const reqRes = await httpJsonRequest({
          port,
          method: 'POST',
          path: '/api/v1/discounts/requests',
          headers: {
            Authorization: `Bearer ${adminToken}`,
            'Idempotency-Key': `idem-adj04-req-${label}-${pct}-${crypto.randomUUID()}`,
          },
          body: {
            enrollment_id: enrId,
            target_invoice_id: invId,
            discount_kind: 'CUSTOM_PERCENT',
            percent_value: pct,
            reason: `${label} ${pct}% test discount`,
            valid_from: '2026-11-01',
            valid_until: '2026-11-30',
          },
        });
        assert.equal(reqRes.statusCode, 201);

        const appRes = await httpJsonRequest({
          port,
          method: 'POST',
          path: `/api/v1/discounts/requests/${reqRes.json.discount_request_id as string}/decision`,
          headers: {
            Authorization: `Bearer ${directorToken}`,
            'Idempotency-Key': `idem-adj04-app-${label}-${pct}-${crypto.randomUUID()}`,
          },
          body: {
            decision: 'APPROVED',
            expected_version: 1,
          },
        });
        assert.equal(appRes.statusCode, 200);
      }

      const finalInv = await httpJsonRequest({
        port,
        method: 'GET',
        path: `/api/v1/invoices/${invId}`,
        headers: { Authorization: `Bearer ${directorToken}` },
      });
      assert.equal(finalInv.statusCode, 200);
      assert.equal(finalInv.json.approved_discount_uzs, expectedTotalDiscount);
      assert.equal(finalInv.json.effective_net_charge_uzs, expectedNetAfterSecond);
      assert.equal(finalInv.json.remaining_debt_uzs, expectedNetAfterSecond);
    }

    // 2. FULL_GRANT_100 on a December 2026 invoice sets net_charge = 0, remaining_debt = 0, status = GRANT_ZERO, 0 payments/refunds
    const grantInvRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/billing/cycles/invoice',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `idem-adj04-grantinv-${crypto.randomUUID()}`,
      },
      body: {
        enrollment_id: String(
          (
            await env.apiPoolA.query<{ id: string }>(
              `SELECT "id"::text AS id FROM "enrollments" WHERE "center_id" = $1::uuid AND "status" = 'ACTIVE' LIMIT 1`,
              [C.centerId],
            )
          ).rows[0]!.id,
        ),
        cycle_type: 'CALENDAR_MONTH',
        cycle_key: 'CAL:2026-12',
        period_start_date: '2026-12-01',
      },
    });
    assert.equal(grantInvRes.statusCode, 200);
    const grantInvId = String(grantInvRes.json.invoice_id);
    const grantEnrId = String(grantInvRes.json.enrollment_id);

    const grantReqRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/discounts/requests',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `idem-adj04-grantreq-${crypto.randomUUID()}`,
      },
      body: {
        enrollment_id: grantEnrId,
        target_invoice_id: grantInvId,
        discount_kind: 'FULL_GRANT_100',
        reason: 'Full presidential scholarship grant',
        valid_from: '2026-12-01',
        valid_until: '2026-12-31',
      },
    });
    assert.equal(grantReqRes.statusCode, 201);

    const grantAppRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: `/api/v1/discounts/requests/${grantReqRes.json.discount_request_id as string}/decision`,
      headers: {
        Authorization: `Bearer ${directorToken}`,
        'Idempotency-Key': `idem-adj04-grantapp-${crypto.randomUUID()}`,
      },
      body: {
        decision: 'APPROVED',
        expected_version: 1,
      },
    });
    assert.equal(grantAppRes.statusCode, 200);
    assert.equal(grantAppRes.json.applied_amount_uzs, '480000');

    const grantInvCheck = await httpJsonRequest({
      port,
      method: 'GET',
      path: `/api/v1/invoices/${grantInvId}`,
      headers: { Authorization: `Bearer ${directorToken}` },
    });
    assert.equal(grantInvCheck.json.effective_net_charge_uzs, '0');
    assert.equal(grantInvCheck.json.remaining_debt_uzs, '0');
    assert.equal(grantInvCheck.json.status, 'GRANT_ZERO');
  });

  it('ADJ-IT-05 & ADJ-IT-06 (09.03, OWNER-20261105-04, T09.03, CASE-15): enforces freeze policy confirmation gate, computes 3/12 net-proportional freeze credit (384,000 -> 96,000), deduplicates overlapping freezes, gives 0 credit on GRANT_ZERO, and applies CreditNote to next cycle invoice without double-consumption', async () => {
    // Create a group with 12 concrete lessons in November 2026
    const grpRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/groups',
      headers: {
        Authorization: `Bearer ${directorToken}`,
        'Idempotency-Key': `idem-adj05-grp-${crypto.randomUUID()}`,
      },
      body: {
        course_id: C.courseId,
        name: 'ADJ-IT-05 Freeze Credit Group',
        primary_teacher_id: C.teacherId,
        billing_mode: 'CALENDAR_PRO_RATA',
        current_fee_uzs: '480000',
        lessons_per_cycle: 12,
        schedule_days: ['MON', 'WED', 'FRI'],
        starts_time: '15:30',
        duration_minutes: 60,
        timezone: 'Asia/Tashkent',
      },
    });
    assert.equal(grpRes.statusCode, 201);
    const grpId = String(grpRes.json.group_id);

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
    for (const d of novDates) {
      const lRes = await httpJsonRequest({
        port,
        method: 'POST',
        path: `/api/v1/groups/${grpId}/lessons`,
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Idempotency-Key': `idem-adj05-lsn-${d}-${crypto.randomUUID()}`,
        },
        body: {
          lesson_date: d,
          occurrence_seq: 1,
          local_starts_time: '15:30',
          duration_minutes: 60,
        },
      });
      assert.equal(lRes.statusCode, 201);
    }

    const stuRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/students',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `idem-adj05-stu-${crypto.randomUUID()}`,
      },
      body: {
        student_full_name: 'Sardor Freeze Student',
        guardian_full_name: 'Sardor Guardian',
        guardian_phone_e164: '+998901239905',
        relationship: 'MOTHER',
        group_id: grpId,
        initial_status: 'ACTIVE',
        enrolled_at_date: '2026-11-01',
      },
    });
    assert.equal(stuRes.statusCode, 201);
    const enrId = String(
      ((stuRes.json.enrollments as Array<Record<string, unknown>>)[0]).enrollment_id,
    );

    // Issue Nov 2026 invoice (480,000 UZS, 12 billed lessons) and apply 20% discount -> 384,000 UZS net charge
    const invRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/billing/cycles/invoice',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `idem-adj05-inv-${crypto.randomUUID()}`,
      },
      body: {
        enrollment_id: enrId,
        cycle_type: 'CALENDAR_MONTH',
        cycle_key: 'CAL:2026-11',
        period_start_date: '2026-11-01',
      },
    });
    assert.equal(invRes.statusCode, 200);
    const invId = String(invRes.json.invoice_id);

    const disc20Req = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/discounts/requests',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `idem-adj05-d20req-${crypto.randomUUID()}`,
      },
      body: {
        enrollment_id: enrId,
        target_invoice_id: invId,
        discount_kind: 'CUSTOM_PERCENT',
        percent_value: 20,
        reason: '20% discount before freeze',
        valid_from: '2026-11-01',
        valid_until: '2026-11-30',
      },
    });
    assert.equal(disc20Req.statusCode, 201);

    const disc20App = await httpJsonRequest({
      port,
      method: 'POST',
      path: `/api/v1/discounts/requests/${disc20Req.json.discount_request_id as string}/decision`,
      headers: {
        Authorization: `Bearer ${directorToken}`,
        'Idempotency-Key': `idem-adj05-d20app-${crypto.randomUUID()}`,
      },
      body: {
        decision: 'APPROVED',
        expected_version: 1,
      },
    });
    assert.equal(disc20App.statusCode, 200);

    // 1. Attempting POST /api/v1/freezes BEFORE freeze_credit_basis is confirmed fails closed with 403 POLICY_DECISION_NOT_CONFIRMED!
    const unconfFreeze = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/freezes',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `idem-adj05-unconffrz-${crypto.randomUUID()}`,
      },
      body: {
        enrollment_id: enrId,
        source_invoice_id: invId,
        freeze_start_date: '2026-11-09',
        freeze_end_date: '2026-11-13',
        reason_type: 'MEDICAL_CERTIFICATE',
        reason_details: 'Hospital certificate #101',
        expected_version: 1,
      },
    });
    assert.equal(unconfFreeze.statusCode, 403);
    assert.equal(unconfFreeze.json.error_code, 'POLICY_DECISION_NOT_CONFIRMED');

    // 2. Director explicitly confirms freeze_credit_basis = 'NET_PROPORTIONAL_LESSON' (effective 2026-01-01)
    const frzPolRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/billing/policies',
      headers: {
        Authorization: `Bearer ${directorToken}`,
        'Idempotency-Key': `idem-adj05-frzpol-${crypto.randomUUID()}`,
      },
      body: {
        billing_mode: 'CALENDAR_PRO_RATA',
        first_partial_charge_mode: 'PRORATE_REMAINING_LESSONS',
        discount_stacking_mode: 'SEQUENTIAL',
        freeze_credit_basis: 'NET_PROPORTIONAL_LESSON',
        policy_confirmation_status: 'CONFIRMED',
        effective_from_date: '2026-01-01',
      },
    });
    assert.equal(frzPolRes.statusCode, 201);
    assert.equal(frzPolRes.json.freeze_policy_status, 'CONFIRMED');

    // Fault injection after CREDIT_NOTE rolls back atomically
    const freezeService = app.get(FreezeCreditService);
    await assert.rejects(
      () =>
        freezeService.createFreezeAndIssueCreditNote(
          {
            headers: {
              'idempotency-key': `idem-adj05-fault-${crypto.randomUUID()}`,
              'x-request-id': 'req-adj05-fault',
            },
          } as never,
          {
            staffId: C.adminId,
            centerId: C.centerId,
            centerSlug: C.centerSlug,
            role: 'ADMIN',
            sessionId: crypto.randomUUID(),
            mustChangePassword: false,
            familyId: crypto.randomUUID(),
            staffVersion: 1,
            transportMode: 'BEARER',
            csrfTokenHash: null,
            licenseMode: 'ACTIVE',
          },
          {
            enrollment_id: enrId,
            source_invoice_id: invId,
            freeze_start_date: '2026-11-09',
            freeze_end_date: '2026-11-13',
            reason_type: 'MEDICAL_CERTIFICATE',
            reason_details: 'Fault injection test',
            expected_version: 1,
          },
          { testFaultAfterStep: 'CREDIT_NOTE' },
        ),
      /SIMULATED_S09_FREEZE_FAULT_AFTER_CREDIT_NOTE/,
    );

    // 3. Freeze 3 lessons (2026-11-09, 2026-11-11, 2026-11-13) on 384,000 UZS net invoice ->
    //    384,000 * 3 / 12 = 96,000 UZS CreditNote!
    const frz1Res = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/freezes',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `idem-adj05-frz1-${crypto.randomUUID()}`,
      },
      body: {
        enrollment_id: enrId,
        source_invoice_id: invId,
        freeze_start_date: '2026-11-09',
        freeze_end_date: '2026-11-13',
        reason_type: 'MEDICAL_CERTIFICATE',
        reason_details: 'Inpatient medical certificate #204',
        expected_version: 1,
      },
    });
    assert.equal(frz1Res.statusCode, 201);
    assert.equal(frz1Res.json.distinct_frozen_lessons, 3);
    assert.equal(frz1Res.json.basis_net_charge_uzs, '384000');
    assert.equal(frz1Res.json.calculated_credit_uzs, '96000');
    assert.equal(typeof frz1Res.json.credit_note_id, 'string');

    // 4. Overlapping freeze on 2026-11-11..2026-11-16 (where 11-11 & 11-13 are already frozen and 11-16 is 1 new lesson) ->
    //    credits ONLY the 1 new lesson (384,000 * 1 / 12 = 32,000 UZS)!
    const frz2Res = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/freezes',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `idem-adj05-frz2-${crypto.randomUUID()}`,
      },
      body: {
        enrollment_id: enrId,
        source_invoice_id: invId,
        freeze_start_date: '2026-11-11',
        freeze_end_date: '2026-11-16',
        reason_type: 'PRIOR_NOTICE',
        reason_details: 'Extended recovery notice',
        expected_version: 2,
      },
    });
    assert.equal(frz2Res.statusCode, 201);
    assert.equal(frz2Res.json.distinct_frozen_lessons, 1);
    assert.equal(frz2Res.json.calculated_credit_uzs, '32000');

    // 5. Issue December 2026 invoice (480,000 UZS) with two concurrent requests ->
    //    applies 96,000 + 32,000 = 128,000 UZS in CreditNotes exactly once (effective_net_charge_uzs = 352,000 UZS)!
    const [decInvA, decInvB] = await Promise.all([
      httpJsonRequest({
        port,
        method: 'POST',
        path: '/api/v1/billing/cycles/invoice',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Idempotency-Key': `idem-adj06-decA-${crypto.randomUUID()}`,
        },
        body: {
          enrollment_id: enrId,
          cycle_type: 'CALENDAR_MONTH',
          cycle_key: 'CAL:2026-12',
          period_start_date: '2026-12-01',
        },
      }),
      httpJsonRequest({
        port,
        method: 'POST',
        path: '/api/v1/billing/cycles/invoice',
        headers: {
          Authorization: `Bearer ${directorToken}`,
          'Idempotency-Key': `idem-adj06-decB-${crypto.randomUUID()}`,
        },
        body: {
          enrollment_id: enrId,
          cycle_type: 'CALENDAR_MONTH',
          cycle_key: 'CAL:2026-12',
          period_start_date: '2026-12-01',
        },
      }),
    ]);
    assert.equal(decInvA.statusCode, 200);
    assert.equal(decInvB.statusCode, 200);
    assert.equal(decInvA.json.invoice_id, decInvB.json.invoice_id);
    assert.equal(decInvA.json.base_pro_rata_charge_uzs, '480000');
    assert.equal(decInvA.json.credit_note_adjustments_uzs, '128000');
    assert.equal(decInvA.json.effective_net_charge_uzs, '352000');
    assert.equal(decInvA.json.remaining_debt_uzs, '352000');
  });

  it('ADJ-IT-07 & ADJ-IT-08 (09.04, 09.05, T09.04, CASE-17): enforces withdrawal churn reasons 1..5, preserves existing debt, revokes pending discount requests, blocks post-exit billing, allows new-ID re-enrollment, and verifies cross-center/ACL guards', async () => {
    // Create a student & enrollment, issue Nov 2026 invoice (480,000 UZS), and create a pending discount request
    const stuRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/students',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `idem-adj07-stu-${crypto.randomUUID()}`,
      },
      body: {
        student_full_name: 'Jasur Withdraw Student',
        guardian_full_name: 'Jasur Guardian',
        guardian_phone_e164: '+998901239907',
        relationship: 'FATHER',
        group_id: C.groupId,
        initial_status: 'ACTIVE',
        enrolled_at_date: '2026-11-01',
      },
    });
    assert.equal(stuRes.statusCode, 201);
    const studentId = String(stuRes.json.student_id);
    const enrId = String(
      ((stuRes.json.enrollments as Array<Record<string, unknown>>)[0]).enrollment_id,
    );

    const invRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/billing/cycles/invoice',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `idem-adj07-inv-${crypto.randomUUID()}`,
      },
      body: {
        enrollment_id: enrId,
        cycle_type: 'CALENDAR_MONTH',
        cycle_key: 'CAL:2026-11',
        period_start_date: '2026-11-01',
      },
    });
    assert.equal(invRes.statusCode, 200);
    const invId = String(invRes.json.invoice_id);

    const pendingReqRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/discounts/requests',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `idem-adj07-pendreq-${crypto.randomUUID()}`,
      },
      body: {
        enrollment_id: enrId,
        target_invoice_id: invId,
        discount_kind: 'SPECIAL_50_PERCENT',
        reason: 'Pending request before withdrawal',
        valid_from: '2026-11-01',
        valid_until: '2026-11-30',
      },
    });
    assert.equal(pendingReqRes.statusCode, 201);
    const pendingReqId = String(pendingReqRes.json.discount_request_id);

    // 1. Invalid churn_reason_code (9) rejected with 400
    const badChurn = await httpJsonRequest({
      port,
      method: 'POST',
      path: `/api/v1/enrollments/${enrId}/withdraw`,
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `idem-adj07-badchurn-${crypto.randomUUID()}`,
      },
      body: {
        left_at_date: '2026-11-20',
        churn_reason_code: 9,
        expected_version: 1,
      },
    });
    assert.equal(badChurn.statusCode, 400);

    // 2. Valid withdrawal with churn_reason_code = 1 transitions to LEFT, preserves 480,000 UZS debt, and revokes pending discount request
    const wdRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: `/api/v1/enrollments/${enrId}/withdraw`,
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `idem-adj07-wd-${crypto.randomUUID()}`,
      },
      body: {
        left_at_date: '2026-11-20',
        churn_reason_code: 1,
        churn_notes: 'Moved to another district',
        expected_version: 1,
      },
    });
    assert.equal(wdRes.statusCode, 200);
    assert.equal(wdRes.json.status, 'LEFT');
    assert.equal(wdRes.json.churn_reason_code, 1);
    assert.equal(wdRes.json.preserved_debt_snapshot_uzs, '480000');

    // Verify pending discount request was automatically REVOKED and cannot be approved
    const approveAfterLeft = await httpJsonRequest({
      port,
      method: 'POST',
      path: `/api/v1/discounts/requests/${pendingReqId}/decision`,
      headers: {
        Authorization: `Bearer ${directorToken}`,
        'Idempotency-Key': `idem-adj07-appafter-${crypto.randomUUID()}`,
      },
      body: {
        decision: 'APPROVED',
        expected_version: 1,
      },
    });
    assert.equal(approveAfterLeft.statusCode, 409);

    // Verify post-exit December 2026 invoice on the LEFT enrollment is blocked with 422
    const postExitInv = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/billing/cycles/invoice',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `idem-adj07-postinv-${crypto.randomUUID()}`,
      },
      body: {
        enrollment_id: enrId,
        cycle_type: 'CALENDAR_MONTH',
        cycle_key: 'CAL:2026-12',
        period_start_date: '2026-12-01',
      },
    });
    assert.equal(postExitInv.statusCode, 422);

    // 3. Re-enrolling the student creates a NEW enrollment ID while preserving the old LEFT enrollment and its 480,000 UZS debt
    const reEnrollRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/enrollments',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `idem-adj07-reenr-${crypto.randomUUID()}`,
      },
      body: {
        student_id: studentId,
        group_id: C.groupId,
        initial_status: 'ACTIVE',
        enrolled_at_date: '2026-12-01',
      },
    });
    assert.equal(reEnrollRes.statusCode, 201);
    assert.notEqual(reEnrollRes.json.enrollment_id, enrId);

    const stuProfile = await httpJsonRequest({
      port,
      method: 'GET',
      path: `/api/v1/students/${studentId}`,
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(stuProfile.statusCode, 200);
    assert.equal(stuProfile.json.total_remaining_debt_uzs, '480000');
    assert.equal((stuProfile.json.enrollments as unknown[]).length, 2);

    // 4. Cross-center UUID isolation & append-only DB ACLs on discount_approvals, freeze_records, freeze_lesson_links, credit_notes
    const crossCenterAttempt = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/discounts/requests',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `idem-adj08-xcenter-${crypto.randomUUID()}`,
      },
      body: {
        enrollment_id: CB.studentId,
        discount_kind: 'SPECIAL_50_PERCENT',
        reason: 'Cross-center probe',
        valid_from: '2026-11-01',
        valid_until: '2026-11-30',
      },
    });
    assert.equal(crossCenterAttempt.statusCode, 404);

    for (const tbl of [
      'discount_approvals',
      'freeze_records',
      'freeze_lesson_links',
      'credit_notes',
      'billing_cycle_lesson_allocations',
    ]) {
      await assert.rejects(
        () => env.apiPoolA.query(`DELETE FROM "${tbl}"`),
        (err: unknown) => (err as { code?: string }).code === '42501',
      );
    }
  });
});
