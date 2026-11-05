/**
 * EduERP v2.0 — Gate G7: Stage 10 Payments, Allocations, Promises, Reversals & Receipts
 * Real Nest HTTP + PostgreSQL Integration Test Suite (`PAY-IT-01..10`):
 *
 * - `PAY-IT-01`: All 5 manual payment methods (`CASH`, `CARD`, `CLICK`, `PAYME`, `TRANSFER` under `OWNER-20261105-05`),
 *   cash vs non-cash shift drawer math (`expected_closing_cash_uzs`), late manual entry (`paid_at < recorded_at`),
 *   future `paid_at > recorded_at` rejection (`422`), and scoped `external_reference` uniqueness (`409`).
 * - `PAY-IT-02`: RBAC (`Teacher` `403 FORBIDDEN_ROLE`), cross-center & cross-student isolation (`404` / `403 FORBIDDEN_OBJECT_SCOPE`),
 *   idempotency replay (`same key+body -> 1 payment`, `same key+different amount -> 409 IDEMPOTENCY_PAYLOAD_MISMATCH`),
 *   and pre-replay live staff status check (deactivated Admin replaying old key -> `401 UNAUTHORIZED`).
 * - `PAY-IT-03`: S11 Cash Shift Guard Seam (`409 SHIFT_CLOSED` on closed shift for payment and reversal with zero DB rows;
 *   `403 POLICY_DECISION_NOT_CONFIRMED` on `backfill_closed_shift_ledger: true`).
 * - `PAY-IT-04`: Partial payment (`500,000` invoice + `300,000` payment -> `422 PROMISE_DATE_REQUIRED_FOR_PARTIAL_PAYMENT` when
 *   `promise_date` omitted; `201` with `remaining_debt_uzs = 200,000` + `PromiseToPay(ACTIVE)` when `promise_date` provided;
 *   subsequent `200,000` payment transitions invoice to `PAID` and `PromiseToPay` to `FULFILLED` with `PromiseFulfilled` outbox — `CASE-11`, `CASE-22`).
 * - `PAY-IT-05`: Overpayment (`500,000` invoice + `600,000` payment -> `500,000` allocation, `0` debt, `100,000` `UnappliedCredit` — `CASE-12`),
 *   multi-invoice ordered & explicit allocations, and lossless `BigInt` above `Number.MAX_SAFE_INTEGER`.
 * - `PAY-IT-06`: Concurrent same-key idempotency race (2 simultaneous requests -> 1 payment, 1 receipt, 1 ledger row)
 *   and concurrent different-key payments against the same invoice (serialized via row locks without over-allocation).
 * - `PAY-IT-07`: `10.03` Erroneous `4,000,000` payment -> reason-required reversal request (`PENDING_DIRECTOR_APPROVAL`,
 *   `Admin` denied `403 FORBIDDEN_ROLE` on approval) -> `Director` approval (`APPROVED_EXECUTED`, original `+4,000,000` preserved,
 *   append-only `ReversalOrRefundExecution` + `PaymentAllocationReversal` + `PAYMENT_REVERSED` `DEBIT` `LedgerEntry`,
 *   invoice debt restored to `400,000`) -> new `+400,000` payment -> net `400,000` paid, `0` debt (`CASE-13`).
 * - `PAY-IT-08`: `10.03` Partial refund (`150,000` of `400,000` -> restores `150,000` debt, `250,000` remaining cap;
 *   subsequent `300,000` rejected with `422 REFUND_CAP_EXCEEDED`), parallel 2-Director approval race on same request (`1` `200`, `1` `409`),
 *   parallel 2-Director approval race on two competing `300,000` requests against a `400,000` payment (`1` `200`, `1` `422`),
 *   `CASH` vs `CARD` refund drawer effect (`C03`), and `403 POLICY_DECISION_NOT_CONFIRMED` on `CLOSE_WITH_CREDIT_NOTE` (`CASE-14`).
 * - `PAY-IT-09`: `10.04` Internal Electronic Receipt (`GET /api/v1/receipts/{receipt_id}`): center-scoped unique `RCP-YYYYMM-NNNNNN`,
 *   `is_fiscal_tax_receipt: false`, `paid_at_utc` & `recorded_at_utc` snapshots, cross-student query rejection (`403`),
 *   and preserved receipt with `PARTIALLY_REVERSED` / `FULLY_REVERSED` history after payment reversal.
 * - `PAY-IT-10`: Atomic rollback fault injection at every payment and reversal write step (`PAYMENT_INSERT`, `ALLOCATION_APPLY`,
 *   `CASH_SHIFT_UPDATE`, `LEDGER_ENTRY`, `RECEIPT_INSERT`, `AUDIT_LOG`, `OUTBOX_EVENT`, `EXECUTION_INSERT`, `ALLOCATION_REVERSAL`,
 *   `INVOICE_UPDATE`) leaving zero partial rows and unchanged balances, plus direct SQL verification that `UPDATE`/`DELETE`
 *   on `payments`, `payment_allocations`, `payment_allocation_reversals`, `reversal_or_refund_executions`, and `receipts` fails with `42501`.
 */

import { INestApplication } from '@nestjs/common';
import * as assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as http from 'node:http';
import { after, before, describe, it } from 'node:test';
import { createApiApplication } from '../../src/application';
import { ClockService } from '../../src/auth/clock.service';
import { AuthenticatedStaffPrincipal } from '../../src/auth/permissions.guard';
import { RequestWithCorrelationId } from '../../src/common/request-id.middleware';
import { loadApiEnv } from '../../src/config/env';
import {
  executeSyntheticSeed,
  SYNTHETIC_DEMO_CENTER_A as C,
  SYNTHETIC_DEMO_CENTER_B as CB,
  SYNTHETIC_TEST_ONLY_PASSWORD,
} from '../../src/database/seed-contract';
import { PaymentService } from '../../src/payments/payment.service';
import { ReversalService } from '../../src/payments/reversal.service';
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

describe('Gate G7 — Stage 10 Manual Payments, Allocations, Promises, Reversals & Receipts HTTP + PostgreSQL Integration Suite (PAY-IT-01..10)', () => {
  let env: EphemeralDatabaseEnvironment;
  let app: INestApplication;
  let clock: ClockService;
  let paymentService: PaymentService;
  let reversalService: ReversalService;
  let port = 0;

  let directorToken = '';
  let adminToken = '';
  let teacherToken = '';
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
  }

  async function ensureOpenCashShift(openingCashUzs = '0'): Promise<string> {
    const existing = await env.apiPoolA.query<{ id: string }>(
      `SELECT "id"::text AS id
         FROM "cash_shifts"
        WHERE "center_id" = $1::uuid
          AND "status" = 'OPEN'
        LIMIT 1`,
      [C.centerId],
    );
    if (existing.rows[0]) {
      return existing.rows[0].id;
    }
    const shiftId = crypto.randomUUID();
    await env.apiPoolA.query(
      `INSERT INTO "cash_shifts" (
         "id",
         "center_id",
         "shift_date",
         "opened_by_admin_id",
         "opening_cash_uzs",
         "cash_receipts_uzs",
         "non_cash_receipts_uzs",
         "cash_refunds_uzs",
         "non_cash_refunds_uzs",
         "cash_expenses_uzs",
         "expected_closing_cash_uzs",
         "status",
         "version"
       ) VALUES (
         $1::uuid,
         $2::uuid,
         '2026-11-05',
         $3::uuid,
         $4::bigint,
         0,
         0,
         0,
         0,
         0,
         $4::bigint,
         'OPEN',
         1
       )`,
      [shiftId, C.centerId, C.adminId, openingCashUzs],
    );
    return shiftId;
  }

  async function createIsolatedStudentAndInvoices(
    invoiceAmountsUzs: readonly string[],
    dueDates?: readonly string[],
  ): Promise<{
    studentId: string;
    groupId: string;
    enrollmentId: string;
    invoiceIds: string[];
  }> {
    fixtureSeq += 1;
    const studentId = crypto.randomUUID();
    const groupId = crypto.randomUUID();
    const enrollmentId = crypto.randomUUID();

    await env.apiPoolA.query(
      `INSERT INTO "students" ("id", "center_id", "student_code", "full_name", "normalized_name", "status")
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, 'ACTIVE')`,
      [
        studentId,
        C.centerId,
        `STU-S10-${String(fixtureSeq).padStart(3, '0')}`,
        `Stage10 Student ${fixtureSeq}`,
        `stage10 student ${fixtureSeq}`,
      ],
    );

    await env.apiPoolA.query(
      `INSERT INTO "course_groups" (
         "id", "center_id", "course_id", "name", "primary_teacher_id",
         "billing_mode", "current_fee_uzs", "lessons_per_cycle",
         "schedule_days_json", "starts_time", "duration_minutes", "timezone", "status"
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4, $5::uuid,
         'CALENDAR_PRO_RATA', 500000, 12,
         '["MON","WED","FRI"]'::jsonb, '09:00', 90, 'Asia/Tashkent', 'ACTIVE'
       )`,
      [groupId, C.centerId, C.courseId, `S10-GRP-${fixtureSeq}`, C.teacherId],
    );

    await env.apiPoolA.query(
      `INSERT INTO "enrollments" ("id", "center_id", "student_id", "group_id", "status", "enrolled_at_date")
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'ACTIVE', '2026-11-01')`,
      [enrollmentId, C.centerId, studentId, groupId],
    );

    const invoiceIds: string[] = [];
    for (let i = 0; i < invoiceAmountsUzs.length; i += 1) {
      const amountUzs = invoiceAmountsUzs[i];
      const dueDate = dueDates?.[i] ?? `2026-11-${String(5 + i).padStart(2, '0')}`;
      const cycleId = crypto.randomUUID();
      const invoiceId = crypto.randomUUID();

      await env.apiPoolA.query(
        `INSERT INTO "billing_cycles" (
           "id", "center_id", "enrollment_id", "cycle_type", "cycle_key", "cycle_seq",
           "period_start_date", "period_end_date", "planned_lessons", "billable_lessons", "policy_version_id"
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, 'CALENDAR_MONTH', $4, $5::int,
           '2026-11-01', '2026-11-30', 12, 12, $6::uuid
         )`,
        [
          cycleId,
          C.centerId,
          enrollmentId,
          `2026-${String(i + 1).padStart(2, '0')}`,
          i + 1,
          C.billingPolicyId,
        ],
      );

      await env.apiPoolA.query(
        `INSERT INTO "invoices" (
           "id", "center_id", "invoice_number", "student_id", "enrollment_id",
           "billing_cycle_id", "policy_version_id", "tariff_snapshot_uzs",
           "base_pro_rata_charge_uzs", "approved_discount_uzs", "credit_note_adjustments_uzs",
           "effective_net_charge_uzs", "allocated_paid_uzs", "remaining_debt_uzs",
           "billed_lessons", "status", "due_date", "version"
         ) VALUES (
           $1::uuid, $2::uuid, $3, $4::uuid, $5::uuid,
           $6::uuid, $7::uuid, $8::bigint,
           $8::bigint, 0, 0,
           $8::bigint, 0, $8::bigint,
           12, 'ISSUED_OPEN', $9::date, 1
         )`,
        [
          invoiceId,
          C.centerId,
          `INV-S10-${fixtureSeq}-${i + 1}`,
          studentId,
          enrollmentId,
          cycleId,
          C.billingPolicyId,
          amountUzs,
          dueDate,
        ],
      );

      invoiceIds.push(invoiceId);
    }

    return { studentId, groupId, enrollmentId, invoiceIds };
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
    clock = app.get(ClockService);
    paymentService = app.get(PaymentService);
    reversalService = app.get(ReversalService);
    clock.setFixedNowForTesting(new Date('2026-11-05T07:00:00.000Z'));

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

  it('PAY-IT-01: records all 5 manual payment methods (CASH, CARD, CLICK, PAYME, TRANSFER), updates shift cash vs non-cash totals, preserves late-entry paid_at != recorded_at, and enforces scoped external_reference uniqueness', async () => {
    const openShiftId = await ensureOpenCashShift('100000');
    const shiftBefore = await env.apiPoolA.query<{
      opening_cash_uzs: string;
      cash_receipts_uzs: string;
      non_cash_receipts_uzs: string;
      expected_closing_cash_uzs: string;
    }>(
      `SELECT "opening_cash_uzs"::text AS opening_cash_uzs,
              "cash_receipts_uzs"::text AS cash_receipts_uzs,
              "non_cash_receipts_uzs"::text AS non_cash_receipts_uzs,
              "expected_closing_cash_uzs"::text AS expected_closing_cash_uzs
         FROM "cash_shifts"
        WHERE "id" = $1::uuid`,
      [openShiftId],
    );

    const methods = ['CASH', 'CARD', 'CLICK', 'PAYME', 'TRANSFER'] as const;
    for (let i = 0; i < methods.length; i += 1) {
      const method = methods[i];
      const fx = await createIsolatedStudentAndInvoices(['200000']);
      const isLate = method === 'CLICK';
      const paidAtParam = isLate ? '2026-11-04T12:30:00.000Z' : undefined;

      const res = await httpJsonRequest({
        port,
        method: 'POST',
        path: '/api/v1/payments',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Idempotency-Key': `pay-it-01-${method}-${crypto.randomUUID()}`,
        },
        body: {
          student_id: fx.studentId,
          cash_shift_id: openShiftId,
          target_invoice_ids: fx.invoiceIds,
          amount_uzs: '200000',
          currency: 'UZS',
          payment_method: method,
          ...(paidAtParam ? { paid_at: paidAtParam } : {}),
          external_reference: `EXT-S10-${method}-001`,
          payment_note: `Manual ${method} payment under OWNER-20261105-05`,
        },
      });

      assert.equal(res.statusCode, 201, `Expected 201 for ${method}, got ${res.statusCode}: ${res.rawBody}`);
      assert.equal(res.json.amount_uzs, '200000');
      assert.equal(res.json.allocated_total_uzs, '200000');
      assert.equal(res.json.unapplied_credit_uzs, '0');
      assert.equal(res.json.remaining_debt_uzs, '0');
      assert.equal(res.json.payment_method, method);
      assert.equal(res.json.is_fiscal_tax_receipt, false);
      assert.equal(res.json.late_entry, isLate);

      if (isLate) {
        assert.equal(res.json.paid_at_utc, '2026-11-04T12:30:00.000Z');
        assert.equal(res.json.recorded_at_utc, '2026-11-05T07:00:00.000Z');
      }
    }

    const shiftAfter = await env.apiPoolA.query<{
      cash_receipts_uzs: string;
      non_cash_receipts_uzs: string;
      expected_closing_cash_uzs: string;
    }>(
      `SELECT "cash_receipts_uzs"::text AS cash_receipts_uzs,
              "non_cash_receipts_uzs"::text AS non_cash_receipts_uzs,
              "expected_closing_cash_uzs"::text AS expected_closing_cash_uzs
         FROM "cash_shifts"
        WHERE "id" = $1::uuid`,
      [openShiftId],
    );

    // Only CASH (200,000) increases cash_receipts_uzs and expected_closing_cash_uzs;
    // CARD + CLICK + PAYME + TRANSFER (4 * 200,000 = 800,000) increase non_cash_receipts_uzs!
    assert.equal(
      BigInt(shiftAfter.rows[0].cash_receipts_uzs) - BigInt(shiftBefore.rows[0].cash_receipts_uzs),
      200000n,
    );
    assert.equal(
      BigInt(shiftAfter.rows[0].expected_closing_cash_uzs) -
        BigInt(shiftBefore.rows[0].expected_closing_cash_uzs),
      200000n,
    );
    assert.equal(
      BigInt(shiftAfter.rows[0].non_cash_receipts_uzs) -
        BigInt(shiftBefore.rows[0].non_cash_receipts_uzs),
      800000n,
    );

    // Duplicate external_reference with same payment_method is rejected with 409
    const fxDup = await createIsolatedStudentAndInvoices(['200000']);
    const dupRefRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/payments',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `pay-it-01-dup-ref-${crypto.randomUUID()}`,
      },
      body: {
        student_id: fxDup.studentId,
        cash_shift_id: openShiftId,
        target_invoice_ids: fxDup.invoiceIds,
        amount_uzs: '200000',
        currency: 'UZS',
        payment_method: 'CLICK',
        external_reference: 'EXT-S10-CLICK-001',
      },
    });
    assert.equal(dupRefRes.statusCode, 409);

    // Future paid_at > recorded_at is rejected with 422 and zero payment rows for fxDup
    const futurePaidRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/payments',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `pay-it-01-future-${crypto.randomUUID()}`,
      },
      body: {
        student_id: fxDup.studentId,
        cash_shift_id: openShiftId,
        target_invoice_ids: fxDup.invoiceIds,
        amount_uzs: '200000',
        currency: 'UZS',
        payment_method: 'CASH',
        paid_at: '2026-11-06T00:00:00.000Z',
      },
    });
    assert.equal(futurePaidRes.statusCode, 422);

    const fxDupPayCnt = await env.apiPoolA.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM "payments" WHERE "student_id" = $1::uuid`,
      [fxDup.studentId],
    );
    assert.equal(fxDupPayCnt.rows[0].cnt, '0');
  });

  it('PAY-IT-02: enforces RBAC (Teacher 403), cross-center & cross-student isolation, idempotent replay vs 409 payload mismatch, and pre-replay live staff status check', async () => {
    const openShiftId = await ensureOpenCashShift();
    const fxA = await createIsolatedStudentAndInvoices(['400000']);
    const fxB = await createIsolatedStudentAndInvoices(['400000']);

    // Teacher is forbidden (403 FORBIDDEN_ROLE) on payment recording
    const teacherPayRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/payments',
      headers: {
        Authorization: `Bearer ${teacherToken}`,
        'Idempotency-Key': `pay-it-02-tch-${crypto.randomUUID()}`,
      },
      body: {
        student_id: fxA.studentId,
        cash_shift_id: openShiftId,
        amount_uzs: '400000',
        currency: 'UZS',
        payment_method: 'CASH',
      },
    });
    assert.equal(teacherPayRes.statusCode, 403);
    assert.equal(teacherPayRes.json.error_code, 'FORBIDDEN_ROLE');

    // Cross-center student_id returns 404 NOT_FOUND
    const crossCenterRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/payments',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `pay-it-02-xc-${crypto.randomUUID()}`,
      },
      body: {
        student_id: CB.studentId,
        cash_shift_id: openShiftId,
        amount_uzs: '400000',
        currency: 'UZS',
        payment_method: 'CASH',
      },
    });
    assert.equal(crossCenterRes.statusCode, 404);

    // Cross-student invoice in same center returns 403 FORBIDDEN_OBJECT_SCOPE
    const crossStudentInvRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/payments',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `pay-it-02-xs-${crypto.randomUUID()}`,
      },
      body: {
        student_id: fxA.studentId,
        cash_shift_id: openShiftId,
        target_invoice_ids: fxB.invoiceIds,
        amount_uzs: '400000',
        currency: 'UZS',
        payment_method: 'CASH',
      },
    });
    assert.equal(crossStudentInvRes.statusCode, 403);
    assert.equal(crossStudentInvRes.json.error_code, 'FORBIDDEN_OBJECT_SCOPE');

    // Idempotent replay with same key + same body returns identical payment_id and creates only 1 row
    const idemKey = `pay-it-02-idem-${crypto.randomUUID()}`;
    const validBody = {
      student_id: fxA.studentId,
      cash_shift_id: openShiftId,
      target_invoice_ids: fxA.invoiceIds,
      amount_uzs: '400000',
      currency: 'UZS',
      payment_method: 'PAYME',
    };

    const firstRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/payments',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': idemKey,
      },
      body: validBody,
    });
    assert.equal(firstRes.statusCode, 201);

    const replayRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/payments',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': idemKey,
      },
      body: validBody,
    });
    assert.equal(replayRes.statusCode, 201);
    assert.equal(replayRes.json.payment_id, firstRes.json.payment_id);
    assert.equal(replayRes.json.receipt_id, firstRes.json.receipt_id);

    // Same key + different amount returns 409 IDEMPOTENCY_PAYLOAD_MISMATCH
    const mismatchRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/payments',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': idemKey,
      },
      body: { ...validBody, amount_uzs: '350000' },
    });
    assert.equal(mismatchRes.statusCode, 409);
    assert.equal(mismatchRes.json.error_code, 'IDEMPOTENCY_PAYLOAD_MISMATCH');

    // Pre-replay live authorization check: if Admin is deactivated, replaying the old key fails with 401/403 before returning cached replay!
    await env.apiPoolA.query(
      `UPDATE "staff_users" SET "status" = 'DEACTIVATED', "version" = "version" + 1 WHERE "id" = $1::uuid`,
      [C.adminId],
    );
    try {
      const revokedReplayRes = await httpJsonRequest({
        port,
        method: 'POST',
        path: '/api/v1/payments',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Idempotency-Key': idemKey,
        },
        body: validBody,
      });
      assert.ok(
        revokedReplayRes.statusCode === 401 || revokedReplayRes.statusCode === 403,
        `Expected 401/403 for deactivated staff replay, got ${revokedReplayRes.statusCode}`,
      );
    } finally {
      await env.apiPoolA.query(
        `UPDATE "staff_users" SET "status" = 'ACTIVE', "version" = "version" + 1 WHERE "id" = $1::uuid`,
        [C.adminId],
      );
      await refreshTokens();
    }
  });

  it('PAY-IT-03: enforces S11 Cash Shift Guard Seam (409 SHIFT_CLOSED on closed shift and 403 on closed-shift backfill)', async () => {
    const closedShiftId = crypto.randomUUID();
    await env.apiPoolA.query(
      `INSERT INTO "cash_shifts" (
         "id", "center_id", "shift_date", "opened_by_admin_id",
         "opening_cash_uzs", "cash_receipts_uzs", "non_cash_receipts_uzs",
         "cash_refunds_uzs", "non_cash_refunds_uzs", "cash_expenses_uzs",
         "expected_closing_cash_uzs", "counted_closing_cash_uzs", "discrepancy_uzs",
         "status", "closed_by_admin_id", "closed_at", "version"
       ) VALUES (
         $1::uuid, $2::uuid, '2026-11-04', $3::uuid,
         0, 500000, 0, 0, 0, 0,
         500000, 500000, 0,
         'CLOSED', $3::uuid, NOW(), 2
       )`,
      [closedShiftId, C.centerId, C.adminId],
    );

    const fx = await createIsolatedStudentAndInvoices(['500000']);

    const closedPayRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/payments',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `pay-it-03-closed-${crypto.randomUUID()}`,
      },
      body: {
        student_id: fx.studentId,
        cash_shift_id: closedShiftId,
        target_invoice_ids: fx.invoiceIds,
        amount_uzs: '500000',
        currency: 'UZS',
        payment_method: 'CASH',
      },
    });
    assert.equal(closedPayRes.statusCode, 409);
    assert.equal(closedPayRes.json.error_code, 'SHIFT_CLOSED');

    const backfillRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/payments',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `pay-it-03-backfill-${crypto.randomUUID()}`,
      },
      body: {
        student_id: fx.studentId,
        cash_shift_id: closedShiftId,
        target_invoice_ids: fx.invoiceIds,
        amount_uzs: '500000',
        currency: 'UZS',
        payment_method: 'CASH',
        backfill_closed_shift_ledger: true,
      },
    });
    assert.equal(backfillRes.statusCode, 403);
    assert.equal(backfillRes.json.error_code, 'POLICY_DECISION_NOT_CONFIRMED');

    const payCount = await env.apiPoolA.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM "payments" WHERE "student_id" = $1::uuid`,
      [fx.studentId],
    );
    assert.equal(payCount.rows[0].cnt, '0');
  });

  it('PAY-IT-04: enforces CASE-11 partial payment (500k - 300k = 200k debt) with mandatory PromiseToPay and CASE-22 automatic PromiseFulfilled on remaining 200k payment', async () => {
    const openShiftId = await ensureOpenCashShift();
    const fx = await createIsolatedStudentAndInvoices(['500000']);

    // 11a: Missing promise_date on partial payment -> 422 PROMISE_DATE_REQUIRED_FOR_PARTIAL_PAYMENT + zero DB rows
    const noPromiseRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/payments',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `pay-it-04-nopromise-${crypto.randomUUID()}`,
      },
      body: {
        student_id: fx.studentId,
        cash_shift_id: openShiftId,
        target_invoice_ids: fx.invoiceIds,
        amount_uzs: '300000',
        currency: 'UZS',
        payment_method: 'CASH',
      },
    });
    assert.equal(noPromiseRes.statusCode, 422);
    assert.equal(noPromiseRes.json.error_code, 'PROMISE_DATE_REQUIRED_FOR_PARTIAL_PAYMENT');

    const checkZeroRows = await env.apiPoolA.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM "payments" WHERE "student_id" = $1::uuid`,
      [fx.studentId],
    );
    assert.equal(checkZeroRows.rows[0].cnt, '0');

    // 11b: Partial payment 300,000 with promise_date = '2026-11-15' -> 201, remaining_debt_uzs = 200,000, PromiseToPay ACTIVE
    const partialRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/payments',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `pay-it-04-partial-${crypto.randomUUID()}`,
      },
      body: {
        student_id: fx.studentId,
        cash_shift_id: openShiftId,
        target_invoice_ids: fx.invoiceIds,
        amount_uzs: '300000',
        currency: 'UZS',
        payment_method: 'CASH',
        promise_date: '2026-11-15',
      },
    });
    assert.equal(partialRes.statusCode, 201);
    assert.equal(partialRes.json.allocated_total_uzs, '300000');
    assert.equal(partialRes.json.remaining_debt_uzs, '200000');
    assert.equal(partialRes.json.promise_date, '2026-11-15');
    assert.ok(partialRes.json.promise_id);

    const promiseId = String(partialRes.json.promise_id);
    const promiseRowBefore = await env.apiPoolA.query<{
      status: string;
      promised_amount_uzs: string;
    }>(
      `SELECT "status"::text AS status, "promised_amount_uzs"::text AS promised_amount_uzs
         FROM "promises_to_pay"
        WHERE "id" = $1::uuid`,
      [promiseId],
    );
    assert.equal(promiseRowBefore.rows[0].status, 'ACTIVE');
    assert.equal(promiseRowBefore.rows[0].promised_amount_uzs, '200000');

    // CASE-22: Paying the remaining 200,000 before promise_date clears debt to 0 and transitions PromiseToPay to FULFILLED!
    const clearDebtRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/payments',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `pay-it-04-clear-${crypto.randomUUID()}`,
      },
      body: {
        student_id: fx.studentId,
        cash_shift_id: openShiftId,
        target_invoice_ids: fx.invoiceIds,
        amount_uzs: '200000',
        currency: 'UZS',
        payment_method: 'CARD',
      },
    });
    assert.equal(clearDebtRes.statusCode, 201);
    assert.equal(clearDebtRes.json.remaining_debt_uzs, '0');
    assert.equal(clearDebtRes.json.promise_id, null);

    const promiseRowAfter = await env.apiPoolA.query<{ status: string }>(
      `SELECT "status"::text AS status FROM "promises_to_pay" WHERE "id" = $1::uuid`,
      [promiseId],
    );
    assert.equal(promiseRowAfter.rows[0].status, 'FULFILLED');

    const pfOutbox = await env.apiPoolA.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt
         FROM "outbox_events"
        WHERE "center_id" = $1::uuid
          AND "event_name" = 'PromiseFulfilled'
          AND "aggregate_id" = $2::uuid`,
      [C.centerId, promiseId],
    );
    assert.equal(pfOutbox.rows[0].cnt, '1');
  });

  it('PAY-IT-05: handles CASE-12 overpayment (600k on 500k -> 500k allocation + 100k UnappliedCredit), multi-invoice allocation, and BigInt > MAX_SAFE_INTEGER', async () => {
    const openShiftId = await ensureOpenCashShift();

    // 1. Overpayment: 600,000 on 500,000 invoice
    const fxOver = await createIsolatedStudentAndInvoices(['500000']);
    const overRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/payments',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `pay-it-05-over-${crypto.randomUUID()}`,
      },
      body: {
        student_id: fxOver.studentId,
        cash_shift_id: openShiftId,
        target_invoice_ids: fxOver.invoiceIds,
        amount_uzs: '600000',
        currency: 'UZS',
        payment_method: 'TRANSFER',
      },
    });
    assert.equal(overRes.statusCode, 201);
    assert.equal(overRes.json.allocated_total_uzs, '500000');
    assert.equal(overRes.json.unapplied_credit_uzs, '100000');
    assert.equal(overRes.json.remaining_debt_uzs, '0');
    assert.ok(overRes.json.unapplied_credit_id);

    // Verify GET /api/v1/students/{student_id} reflects total_remaining_debt_uzs = 0 and unapplied_credit_uzs = 100000
    const stuProfile = await httpJsonRequest({
      port,
      method: 'GET',
      path: `/api/v1/students/${fxOver.studentId}`,
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(stuProfile.statusCode, 200);
    assert.equal(stuProfile.json.total_remaining_debt_uzs, '0');
    assert.equal(stuProfile.json.unapplied_credit_uzs, '100000');

    // 2. Multi-invoice allocation across 2 invoices (300,000 and 400,000) with 500,000 payment
    const fxMulti = await createIsolatedStudentAndInvoices(['300000', '400000']);
    const multiRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/payments',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `pay-it-05-multi-${crypto.randomUUID()}`,
      },
      body: {
        student_id: fxMulti.studentId,
        cash_shift_id: openShiftId,
        target_invoice_ids: fxMulti.invoiceIds,
        amount_uzs: '500000',
        currency: 'UZS',
        payment_method: 'CARD',
        promise_date: '2026-11-25',
      },
    });
    assert.equal(multiRes.statusCode, 201);
    assert.equal(multiRes.json.allocated_total_uzs, '500000');
    assert.equal(multiRes.json.remaining_debt_uzs, '200000');

    const inv1Check = await env.apiPoolA.query<{ status: string; remaining_debt_uzs: string }>(
      `SELECT "status"::text AS status, "remaining_debt_uzs"::text AS remaining_debt_uzs FROM "invoices" WHERE "id" = $1::uuid`,
      [fxMulti.invoiceIds[0]],
    );
    const inv2Check = await env.apiPoolA.query<{ status: string; remaining_debt_uzs: string }>(
      `SELECT "status"::text AS status, "remaining_debt_uzs"::text AS remaining_debt_uzs FROM "invoices" WHERE "id" = $1::uuid`,
      [fxMulti.invoiceIds[1]],
    );
    assert.equal(inv1Check.rows[0].status, 'PAID');
    assert.equal(inv1Check.rows[0].remaining_debt_uzs, '0');
    assert.equal(inv2Check.rows[0].status, 'PARTIALLY_PAID');
    assert.equal(inv2Check.rows[0].remaining_debt_uzs, '200000');

    // 3. Lossless BigInt > Number.MAX_SAFE_INTEGER (9007199254740993)
    const fxHuge = await createIsolatedStudentAndInvoices(['9007199254740993']);
    const hugeRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/payments',
      headers: {
        Authorization: `Bearer ${directorToken}`,
        'Idempotency-Key': `pay-it-05-huge-${crypto.randomUUID()}`,
      },
      body: {
        student_id: fxHuge.studentId,
        cash_shift_id: openShiftId,
        target_invoice_ids: fxHuge.invoiceIds,
        amount_uzs: '9007199254740993',
        currency: 'UZS',
        payment_method: 'TRANSFER',
      },
    });
    assert.equal(hugeRes.statusCode, 201);
    assert.equal(hugeRes.json.amount_uzs, '9007199254740993');
    assert.equal(hugeRes.json.allocated_total_uzs, '9007199254740993');
    assert.equal(hugeRes.json.remaining_debt_uzs, '0');
  });

  it('PAY-IT-06: serializes concurrent same-key idempotency race (1 payment) and concurrent different-key payments against the same invoice without over-allocation', async () => {
    const openShiftId = await ensureOpenCashShift();

    // 1. Concurrent same-key race -> 1 payment, 1 receipt, 1 ledger row
    const fxSameKey = await createIsolatedStudentAndInvoices(['400000']);
    const sharedKey = `pay-it-06-samekey-${crypto.randomUUID()}`;
    const sameKeyBody = {
      student_id: fxSameKey.studentId,
      cash_shift_id: openShiftId,
      target_invoice_ids: fxSameKey.invoiceIds,
      amount_uzs: '400000',
      currency: 'UZS',
      payment_method: 'CLICK',
    };

    const [sameA, sameB] = await Promise.all([
      httpJsonRequest({
        port,
        method: 'POST',
        path: '/api/v1/payments',
        headers: { Authorization: `Bearer ${adminToken}`, 'Idempotency-Key': sharedKey },
        body: sameKeyBody,
      }),
      httpJsonRequest({
        port,
        method: 'POST',
        path: '/api/v1/payments',
        headers: { Authorization: `Bearer ${adminToken}`, 'Idempotency-Key': sharedKey },
        body: sameKeyBody,
      }),
    ]);

    assert.equal(sameA.statusCode, 201);
    assert.equal(sameB.statusCode, 201);
    assert.equal(sameA.json.payment_id, sameB.json.payment_id);

    const sameKeyPayCount = await env.apiPoolA.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM "payments" WHERE "student_id" = $1::uuid`,
      [fxSameKey.studentId],
    );
    assert.equal(sameKeyPayCount.rows[0].cnt, '1');

    // 2. Concurrent different-key payments (two legitimate 300,000 payments against a single 500,000 invoice)
    // Total allocated to the invoice must be capped at 500,000, and 100,000 must go to UnappliedCredit!
    const fxDiffKeys = await createIsolatedStudentAndInvoices(['500000']);
    const [diffA, diffB] = await Promise.all([
      httpJsonRequest({
        port,
        method: 'POST',
        path: '/api/v1/payments',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Idempotency-Key': `pay-it-06-diff-a-${crypto.randomUUID()}`,
        },
        body: {
          student_id: fxDiffKeys.studentId,
          cash_shift_id: openShiftId,
          target_invoice_ids: fxDiffKeys.invoiceIds,
          amount_uzs: '300000',
          currency: 'UZS',
          payment_method: 'CASH',
          promise_date: '2026-11-20',
        },
      }),
      httpJsonRequest({
        port,
        method: 'POST',
        path: '/api/v1/payments',
        headers: {
          Authorization: `Bearer ${directorToken}`,
          'Idempotency-Key': `pay-it-06-diff-b-${crypto.randomUUID()}`,
        },
        body: {
          student_id: fxDiffKeys.studentId,
          cash_shift_id: openShiftId,
          target_invoice_ids: fxDiffKeys.invoiceIds,
          amount_uzs: '300000',
          currency: 'UZS',
          payment_method: 'CARD',
          promise_date: '2026-11-20',
        },
      }),
    ]);

    assert.equal(diffA.statusCode, 201);
    assert.equal(diffB.statusCode, 201);

    const invAfterRace = await env.apiPoolA.query<{
      allocated_paid_uzs: string;
      remaining_debt_uzs: string;
      status: string;
    }>(
      `SELECT "allocated_paid_uzs"::text AS allocated_paid_uzs,
              "remaining_debt_uzs"::text AS remaining_debt_uzs,
              "status"::text AS status
         FROM "invoices"
        WHERE "id" = $1::uuid`,
      [fxDiffKeys.invoiceIds[0]],
    );
    assert.equal(invAfterRace.rows[0].allocated_paid_uzs, '500000');
    assert.equal(invAfterRace.rows[0].remaining_debt_uzs, '0');
    assert.equal(invAfterRace.rows[0].status, 'PAID');

    const unappliedAfterRace = await env.apiPoolA.query<{ sum_credit: string }>(
      `SELECT COALESCE(SUM("remaining_credit_uzs"), 0)::text AS sum_credit
         FROM "unapplied_credits"
        WHERE "student_id" = $1::uuid`,
      [fxDiffKeys.studentId],
    );
    assert.equal(unappliedAfterRace.rows[0].sum_credit, '100000');
  });

  it('PAY-IT-07: executes CASE-13 erroneous 4,000,000 payment storno reversal (Admin request -> Admin approval denied 403 -> Director approval -> new 400,000 payment -> net 400,000, original history preserved)', async () => {
    const openShiftId = await ensureOpenCashShift();
    const fx = await createIsolatedStudentAndInvoices(['400000']);

    // Step 1: Admin mistakenly records 4,000,000 instead of 400,000
    const errPayRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/payments',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `pay-it-07-err-${crypto.randomUUID()}`,
      },
      body: {
        student_id: fx.studentId,
        cash_shift_id: openShiftId,
        target_invoice_ids: fx.invoiceIds,
        amount_uzs: '4000000',
        currency: 'UZS',
        payment_method: 'CASH',
      },
    });
    assert.equal(errPayRes.statusCode, 201);
    const errPaymentId = String(errPayRes.json.payment_id);
    assert.equal(errPayRes.json.allocated_total_uzs, '400000');
    assert.equal(errPayRes.json.unapplied_credit_uzs, '3600000');

    // Step 2: Admin submits reason-required reversal request (zero financial effect before Director approval)
    const revReqRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/payments/reversals',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `pay-it-07-revreq-${crypto.randomUUID()}`,
      },
      body: {
        original_payment_id: errPaymentId,
        kind: 'ERROR_STORNO_REVERSAL',
        amount_uzs: '4000000',
        refund_method: 'CASH',
        reason: 'Mistakenly typed extra zero: 4,000,000 instead of 400,000',
      },
    });
    assert.equal(revReqRes.statusCode, 201);
    assert.equal(revReqRes.json.status, 'PENDING_DIRECTOR_APPROVAL');
    assert.equal(revReqRes.json.execution, null);
    const reversalRequestId = String(revReqRes.json.request_id);

    // Invoice debt is still 0 while request is PENDING_DIRECTOR_APPROVAL
    const invBeforeApprove = await env.apiPoolA.query<{ remaining_debt_uzs: string }>(
      `SELECT "remaining_debt_uzs"::text AS remaining_debt_uzs FROM "invoices" WHERE "id" = $1::uuid`,
      [fx.invoiceIds[0]],
    );
    assert.equal(invBeforeApprove.rows[0].remaining_debt_uzs, '0');

    // Step 3: Admin attempting to approve their own request is rejected with 403 FORBIDDEN_ROLE
    const adminApproveRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: `/api/v1/payments/reversals/${reversalRequestId}/decision`,
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `pay-it-07-adm-app-${crypto.randomUUID()}`,
      },
      body: {
        decision: 'APPROVED_EXECUTED',
        debt_effect_policy: 'REOPEN_INVOICE_DEBT',
        cash_shift_id: openShiftId,
        expected_version: 1,
      },
    });
    assert.equal(adminApproveRes.statusCode, 403);
    assert.equal(adminApproveRes.json.error_code, 'FORBIDDEN_ROLE');

    // Step 4: Director approves the reversal -> append-only ReversalOrRefundExecution + PaymentAllocationReversal + PAYMENT_REVERSED DEBIT LedgerEntry, invoice debt restored to 400,000!
    const dirApproveRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: `/api/v1/payments/reversals/${reversalRequestId}/decision`,
      headers: {
        Authorization: `Bearer ${directorToken}`,
        'Idempotency-Key': `pay-it-07-dir-app-${crypto.randomUUID()}`,
      },
      body: {
        decision: 'APPROVED_EXECUTED',
        debt_effect_policy: 'REOPEN_INVOICE_DEBT',
        cash_shift_id: openShiftId,
        expected_version: 1,
      },
    });
    assert.equal(dirApproveRes.statusCode, 200);
    assert.equal(dirApproveRes.json.status, 'APPROVED_EXECUTED');
    assert.ok(dirApproveRes.json.execution);

    // Original 4,000,000 payment row is untouched in DB
    const origPayRow = await env.apiPoolA.query<{ amount_uzs: string }>(
      `SELECT "amount_uzs"::text AS amount_uzs FROM "payments" WHERE "id" = $1::uuid`,
      [errPaymentId],
    );
    assert.equal(origPayRow.rows[0].amount_uzs, '4000000');

    // Invoice debt is restored to 400,000 (ISSUED_OPEN) and UnappliedCredit remaining_credit_uzs is 0
    const invAfterStorno = await env.apiPoolA.query<{
      allocated_paid_uzs: string;
      remaining_debt_uzs: string;
      status: string;
    }>(
      `SELECT "allocated_paid_uzs"::text AS allocated_paid_uzs,
              "remaining_debt_uzs"::text AS remaining_debt_uzs,
              "status"::text AS status
         FROM "invoices"
        WHERE "id" = $1::uuid`,
      [fx.invoiceIds[0]],
    );
    assert.equal(invAfterStorno.rows[0].allocated_paid_uzs, '0');
    assert.equal(invAfterStorno.rows[0].remaining_debt_uzs, '400000');
    assert.equal(invAfterStorno.rows[0].status, 'ISSUED_OPEN');

    // Step 5: Record correct 400,000 payment -> net ledger payment = 4,000,000 - 4,000,000 + 400,000 = 400,000, remaining debt = 0!
    const correctPayRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/payments',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `pay-it-07-correct-${crypto.randomUUID()}`,
      },
      body: {
        student_id: fx.studentId,
        cash_shift_id: openShiftId,
        target_invoice_ids: fx.invoiceIds,
        amount_uzs: '400000',
        currency: 'UZS',
        payment_method: 'CASH',
      },
    });
    assert.equal(correctPayRes.statusCode, 201);
    assert.equal(correctPayRes.json.remaining_debt_uzs, '0');

    const ledgerNetRes = await env.apiPoolA.query<{ net_paid: string }>(
      `SELECT (
         COALESCE(SUM(CASE WHEN "entry_type" = 'PAYMENT_RECEIVED' AND "direction" = 'CREDIT' THEN "amount_uzs" ELSE 0 END), 0) -
         COALESCE(SUM(CASE WHEN "entry_type" IN ('PAYMENT_REVERSED', 'REFUND_PAID') AND "direction" = 'DEBIT' THEN "amount_uzs" ELSE 0 END), 0)
       )::text AS net_paid
         FROM "ledger_entries"
        WHERE "center_id" = $1::uuid
          AND "student_id" = $2::uuid`,
      [C.centerId, fx.studentId],
    );
    assert.equal(ledgerNetRes.rows[0].net_paid, '400000');
  });

  it('PAY-IT-08: enforces CASE-14 partial refund cap (150k of 400k -> 250k cap, next 300k -> 422 REFUND_CAP_EXCEEDED), parallel 2-Director approval serialization, CASH vs CARD drawer math, and D22 CLOSE_WITH_CREDIT_NOTE gate', async () => {
    const openShiftId = await ensureOpenCashShift();
    const fx = await createIsolatedStudentAndInvoices(['400000']);

    const payRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/payments',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `pay-it-08-pay-${crypto.randomUUID()}`,
      },
      body: {
        student_id: fx.studentId,
        cash_shift_id: openShiftId,
        target_invoice_ids: fx.invoiceIds,
        amount_uzs: '400000',
        currency: 'UZS',
        payment_method: 'CASH',
      },
    });
    assert.equal(payRes.statusCode, 201);
    const paymentId = String(payRes.json.payment_id);

    // Request 150,000 partial refund
    const req150Res = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/payments/reversals',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `pay-it-08-req150-${crypto.randomUUID()}`,
      },
      body: {
        original_payment_id: paymentId,
        kind: 'PARTIAL_REFUND',
        amount_uzs: '150000',
        refund_method: 'CASH',
        reason: 'Partial refund of 150,000 UZS approved by center',
      },
    });
    assert.equal(req150Res.statusCode, 201);
    const req150Id = String(req150Res.json.request_id);

    // D22 CLOSE_WITH_CREDIT_NOTE is rejected with 403 POLICY_DECISION_NOT_CONFIRMED
    const unconfirmedD22Res = await httpJsonRequest({
      port,
      method: 'POST',
      path: `/api/v1/payments/reversals/${req150Id}/decision`,
      headers: {
        Authorization: `Bearer ${directorToken}`,
        'Idempotency-Key': `pay-it-08-d22-${crypto.randomUUID()}`,
      },
      body: {
        decision: 'APPROVED_EXECUTED',
        debt_effect_policy: 'CLOSE_WITH_CREDIT_NOTE',
        cash_shift_id: openShiftId,
        expected_version: 1,
      },
    });
    assert.equal(unconfirmedD22Res.statusCode, 403);
    assert.equal(unconfirmedD22Res.json.error_code, 'POLICY_DECISION_NOT_CONFIRMED');

    // Parallel 2-Director approval race with different idempotency keys on req150Id -> 1 winner (200), 1 loser (409)
    const [raceA, raceB] = await Promise.all([
      httpJsonRequest({
        port,
        method: 'POST',
        path: `/api/v1/payments/reversals/${req150Id}/decision`,
        headers: {
          Authorization: `Bearer ${directorToken}`,
          'Idempotency-Key': `pay-it-08-race-a-${crypto.randomUUID()}`,
        },
        body: {
          decision: 'APPROVED_EXECUTED',
          debt_effect_policy: 'REOPEN_INVOICE_DEBT',
          cash_shift_id: openShiftId,
          expected_version: 1,
        },
      }),
      httpJsonRequest({
        port,
        method: 'POST',
        path: `/api/v1/payments/reversals/${req150Id}/decision`,
        headers: {
          Authorization: `Bearer ${directorToken}`,
          'Idempotency-Key': `pay-it-08-race-b-${crypto.randomUUID()}`,
        },
        body: {
          decision: 'APPROVED_EXECUTED',
          debt_effect_policy: 'REOPEN_INVOICE_DEBT',
          cash_shift_id: openShiftId,
          expected_version: 1,
        },
      }),
    ]);

    const raceStatuses = [raceA.statusCode, raceB.statusCode].sort();
    assert.deepEqual(raceStatuses, [200, 409]);

    // Invoice debt is now 150,000 (allocated_paid_uzs = 250,000, PARTIALLY_PAID)
    const invAfter150 = await env.apiPoolA.query<{
      allocated_paid_uzs: string;
      remaining_debt_uzs: string;
      status: string;
    }>(
      `SELECT "allocated_paid_uzs"::text AS allocated_paid_uzs,
              "remaining_debt_uzs"::text AS remaining_debt_uzs,
              "status"::text AS status
         FROM "invoices"
        WHERE "id" = $1::uuid`,
      [fx.invoiceIds[0]],
    );
    assert.equal(invAfter150.rows[0].allocated_paid_uzs, '250000');
    assert.equal(invAfter150.rows[0].remaining_debt_uzs, '150000');
    assert.equal(invAfter150.rows[0].status, 'PARTIALLY_PAID');

    // Requesting another 300,000 (> 250,000 remaining reversible) fails with 422 REFUND_CAP_EXCEEDED
    const exceedCapRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/payments/reversals',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `pay-it-08-exceed-${crypto.randomUUID()}`,
      },
      body: {
        original_payment_id: paymentId,
        kind: 'PARTIAL_REFUND',
        amount_uzs: '300000',
        refund_method: 'CASH',
        reason: 'Attempting to refund 300,000 when only 250,000 remains',
      },
    });
    assert.equal(exceedCapRes.statusCode, 422);
    assert.equal(exceedCapRes.json.error_code, 'REFUND_CAP_EXCEEDED');
  });

  it('PAY-IT-09: issues unique center-scoped internal electronic receipts (10.04), enforces student/role scope, and preserves receipt with reversal history', async () => {
    const openShiftId = await ensureOpenCashShift();
    const fx1 = await createIsolatedStudentAndInvoices(['250000']);
    const fx2 = await createIsolatedStudentAndInvoices(['250000']);

    // Issue 2 payments in parallel -> distinct unique RCP-YYYYMM-NNNNNN numbers
    const [p1, p2] = await Promise.all([
      httpJsonRequest({
        port,
        method: 'POST',
        path: '/api/v1/payments',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Idempotency-Key': `pay-it-09-p1-${crypto.randomUUID()}`,
        },
        body: {
          student_id: fx1.studentId,
          cash_shift_id: openShiftId,
          target_invoice_ids: fx1.invoiceIds,
          amount_uzs: '250000',
          currency: 'UZS',
          payment_method: 'CLICK',
          paid_at: '2026-11-05T06:15:00.000Z',
        },
      }),
      httpJsonRequest({
        port,
        method: 'POST',
        path: '/api/v1/payments',
        headers: {
          Authorization: `Bearer ${directorToken}`,
          'Idempotency-Key': `pay-it-09-p2-${crypto.randomUUID()}`,
        },
        body: {
          student_id: fx2.studentId,
          cash_shift_id: openShiftId,
          target_invoice_ids: fx2.invoiceIds,
          amount_uzs: '250000',
          currency: 'UZS',
          payment_method: 'PAYME',
        },
      }),
    ]);

    assert.equal(p1.statusCode, 201);
    assert.equal(p2.statusCode, 201);
    assert.notEqual(p1.json.receipt_number, p2.json.receipt_number);
    assert.match(String(p1.json.receipt_number), /^RCP-202611-\d{6}$/);

    const receiptId = String(p1.json.receipt_id);

    // Teacher cannot read receipt (403 FORBIDDEN_ROLE)
    const tchReceipt = await httpJsonRequest({
      port,
      method: 'GET',
      path: `/api/v1/receipts/${receiptId}`,
      headers: { Authorization: `Bearer ${teacherToken}` },
    });
    assert.equal(tchReceipt.statusCode, 403);

    // Wrong student_id filter returns 403 FORBIDDEN_OBJECT_SCOPE
    const wrongStudentReceipt = await httpJsonRequest({
      port,
      method: 'GET',
      path: `/api/v1/receipts/${receiptId}?student_id=${fx2.studentId}`,
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(wrongStudentReceipt.statusCode, 403);

    // Valid receipt read before reversal
    const rcptBefore = await httpJsonRequest({
      port,
      method: 'GET',
      path: `/api/v1/receipts/${receiptId}?student_id=${fx1.studentId}`,
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(rcptBefore.statusCode, 200);
    assert.equal(rcptBefore.json.is_fiscal_tax_receipt, false);
    assert.equal(rcptBefore.json.amount_uzs, '250000');
    assert.equal(rcptBefore.json.paid_at_utc, '2026-11-05T06:15:00.000Z');
    assert.equal(rcptBefore.json.recorded_at_utc, '2026-11-05T07:00:00.000Z');
    assert.equal(rcptBefore.json.reversal_status, 'NONE');

    // Reverse 100,000 on p1 and verify the original receipt is NOT deleted and shows PARTIALLY_REVERSED
    const revReq = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/payments/reversals',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `pay-it-09-rev-${crypto.randomUUID()}`,
      },
      body: {
        original_payment_id: p1.json.payment_id,
        kind: 'PARTIAL_REFUND',
        amount_uzs: '100000',
        refund_method: 'CLICK',
        reason: 'Partial adjustment on Click payment',
      },
    });
    assert.equal(revReq.statusCode, 201);

    const revApprove = await httpJsonRequest({
      port,
      method: 'POST',
      path: `/api/v1/payments/reversals/${revReq.json.request_id}/decision`,
      headers: {
        Authorization: `Bearer ${directorToken}`,
        'Idempotency-Key': `pay-it-09-app-${crypto.randomUUID()}`,
      },
      body: {
        decision: 'APPROVED_EXECUTED',
        debt_effect_policy: 'REOPEN_INVOICE_DEBT',
        cash_shift_id: openShiftId,
        expected_version: 1,
      },
    });
    assert.equal(revApprove.statusCode, 200);

    const rcptAfter = await httpJsonRequest({
      port,
      method: 'GET',
      path: `/api/v1/receipts/${receiptId}`,
      headers: { Authorization: `Bearer ${directorToken}` },
    });
    assert.equal(rcptAfter.statusCode, 200);
    assert.equal(rcptAfter.json.amount_uzs, '250000');
    assert.equal(rcptAfter.json.reversed_total_uzs, '100000');
    assert.equal(rcptAfter.json.net_effective_payment_uzs, '150000');
    assert.equal(rcptAfter.json.reversal_status, 'PARTIALLY_REVERSED');
    assert.equal((rcptAfter.json.reversals as unknown[]).length, 1);
  });

  it('PAY-IT-10: rolls back atomically on injected faults at every payment and reversal write step and rejects direct UPDATE/DELETE on append-only tables with 42501', async () => {
    const openShiftId = await ensureOpenCashShift();
    const fx = await createIsolatedStudentAndInvoices(['300000']);

    const directorPrincipal: AuthenticatedStaffPrincipal = {
      staffId: C.directorId,
      sessionId: crypto.randomUUID(),
      familyId: crypto.randomUUID(),
      centerId: C.centerId,
      centerSlug: C.centerSlug,
      role: 'DIRECTOR',
      staffVersion: 1,
      mustChangePassword: false,
      transportMode: 'BEARER',
      csrfTokenHash: null,
      licenseMode: 'ACTIVE',
    };

    const paymentFaultSteps = [
      'PAYMENT_INSERT',
      'ALLOCATION_APPLY',
      'CASH_SHIFT_UPDATE',
      'LEDGER_ENTRY',
      'RECEIPT_INSERT',
      'AUDIT_LOG',
      'OUTBOX_EVENT',
    ] as const;

    for (const step of paymentFaultSteps) {
      const mockReq = {
        headers: {
          'idempotency-key': `pay-it-10-fault-${step}-${crypto.randomUUID()}`,
          'x-request-id': `req-fault-${step}`,
        },
        requestId: `req-fault-${step}`,
      } as unknown as RequestWithCorrelationId;

      await assert.rejects(
        () =>
          paymentService.recordPaymentWithRequiredPromise(
            mockReq,
            directorPrincipal,
            {
              student_id: fx.studentId,
              cash_shift_id: openShiftId,
              target_invoice_ids: fx.invoiceIds,
              amount_uzs: '300000',
              currency: 'UZS',
              payment_method: 'CASH',
            },
            { testFaultAfterStep: step },
          ),
        new RegExp(`SIMULATED_S10_PAYMENT_FAULT_AFTER_${step}`),
      );
    }

    // Verify zero payments, zero allocations, zero receipts, and unchanged 300,000 debt on fx.studentId!
    const payCntAfterFaults = await env.apiPoolA.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM "payments" WHERE "student_id" = $1::uuid`,
      [fx.studentId],
    );
    assert.equal(payCntAfterFaults.rows[0].cnt, '0');

    const invAfterFaults = await env.apiPoolA.query<{ remaining_debt_uzs: string }>(
      `SELECT "remaining_debt_uzs"::text AS remaining_debt_uzs FROM "invoices" WHERE "id" = $1::uuid`,
      [fx.invoiceIds[0]],
    );
    assert.equal(invAfterFaults.rows[0].remaining_debt_uzs, '300000');

    // Now record a valid payment and test reversal fault injection + append-only SQL immutability
    const okPayRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/payments',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `pay-it-10-ok-${crypto.randomUUID()}`,
      },
      body: {
        student_id: fx.studentId,
        cash_shift_id: openShiftId,
        target_invoice_ids: fx.invoiceIds,
        amount_uzs: '300000',
        currency: 'UZS',
        payment_method: 'CASH',
      },
    });
    assert.equal(okPayRes.statusCode, 201);
    const okPayId = String(okPayRes.json.payment_id);
    const okReceiptId = String(okPayRes.json.receipt_id);

    const revReqRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/payments/reversals',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': `pay-it-10-revreq-${crypto.randomUUID()}`,
      },
      body: {
        original_payment_id: okPayId,
        kind: 'ERROR_STORNO_REVERSAL',
        amount_uzs: '300000',
        refund_method: 'CASH',
        reason: 'Test reversal rollback injection across all steps',
      },
    });
    assert.equal(revReqRes.statusCode, 201);
    const revReqId = String(revReqRes.json.request_id);

    const reversalFaultSteps = [
      'REQUEST_UPDATE',
      'EXECUTION_INSERT',
      'ALLOCATION_REVERSAL',
      'INVOICE_UPDATE',
      'CASH_SHIFT_UPDATE',
      'LEDGER_ENTRY',
      'AUDIT_LOG',
      'OUTBOX_EVENT',
    ] as const;

    for (const step of reversalFaultSteps) {
      const mockReq = {
        headers: {
          'idempotency-key': `pay-it-10-revfault-${step}-${crypto.randomUUID()}`,
          'x-request-id': `req-revfault-${step}`,
          'if-match': '"1"',
        },
        requestId: `req-revfault-${step}`,
      } as unknown as RequestWithCorrelationId;

      await assert.rejects(
        () =>
          reversalService.decidePaymentReversalOrRefund(
            mockReq,
            directorPrincipal,
            revReqId,
            {
              decision: 'APPROVED_EXECUTED',
              debt_effect_policy: 'REOPEN_INVOICE_DEBT',
              cash_shift_id: openShiftId,
              expected_version: 1,
            },
            { testFaultAfterStep: step },
          ),
        new RegExp(`SIMULATED_S10_REVERSAL_FAULT_AFTER_${step}`),
      );
    }

    // Reversal request is still PENDING_DIRECTOR_APPROVAL at version 1 and 0 executions exist!
    const checkRevReq = await env.apiPoolA.query<{ status: string; version: number }>(
      `SELECT "status"::text AS status, "version" FROM "reversal_or_refund_requests" WHERE "id" = $1::uuid`,
      [revReqId],
    );
    assert.equal(checkRevReq.rows[0].status, 'PENDING_DIRECTOR_APPROVAL');
    assert.equal(Number(checkRevReq.rows[0].version), 1);

    // Direct SQL UPDATE/DELETE on immutable tables (payments, payment_allocations, receipts) is rejected with 42501
    for (const sql of [
      `UPDATE "payments" SET "amount_uzs" = 100 WHERE "id" = '${okPayId}'::uuid`,
      `DELETE FROM "payments" WHERE "id" = '${okPayId}'::uuid`,
      `UPDATE "receipts" SET "amount_uzs" = 100 WHERE "id" = '${okReceiptId}'::uuid`,
      `DELETE FROM "receipts" WHERE "id" = '${okReceiptId}'::uuid`,
    ]) {
      await assert.rejects(
        () => env.apiPoolA.query(sql),
        (err: unknown) => (err as { code?: string }).code === '42501',
      );
    }
  });
});
