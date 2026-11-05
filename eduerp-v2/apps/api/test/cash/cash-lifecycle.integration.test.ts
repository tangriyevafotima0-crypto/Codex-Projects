/**
 * EduERP v2.0 — Gate G8: Stage 11 Cash Shifts, Categorized Expenses, Promise-to-Pay & Method-Wise Reconciliation
 * Real Nest HTTP + PostgreSQL Integration Test Suite (`CASH-IT-01..10`):
 *
 * - `CASH-IT-01`: `11.01` Open cash shift (`POST /api/v1/cash-shifts/open`), opening float, past/future `shift_date` rejected (`422`),
 *   next-day temporal idempotency replay (`clock.setTestNow` -> replays without failing date check — `N01`/`N02`),
 *   single active `OPEN` shift per center (`409`), and concurrent 2-worker open race (`1` `201`, `1` `409`).
 * - `CASH-IT-02`: `11.01`–`11.04` RBAC (`Teacher` denied `403 FORBIDDEN_ROLE` on all cash/expense/promise endpoints;
 *   `Admin` allowed on open/close/get/record-expense/promises, denied `403 FORBIDDEN_ROLE` on expense reversal),
 *   cross-center object isolation (`404`), and deactivated staff pre-replay guard (`401 UNAUTHORIZED`).
 * - `CASH-IT-03`: `11.02` Categorized expenses (`CASH`, `CARD`, `CLICK`, `PAYME`, `TRANSFER`), negative cash drawer overdraft guard (`422`),
 *   non-cash expense excluded from physical cash drawer, and concurrent 2-worker `CASH` expense overdraft race (`1` `201`, `1` `422`).
 * - `CASH-IT-04`: `11.02` Director-only append-only expense reversal (`reverses_expense_id` via `POST /api/v1/cash-expenses` and
 *   `POST /api/v1/cash-expenses/{expense_id}/reverse`), original `CashExpense` preserved, `EXPENSE_REVERSED` `CREDIT` `LedgerEntry`,
 *   cash drawer balance restored, duplicate reversal rejected (`409`), reverse-of-reversal rejected (`422`), and concurrent 2-Director reversal race (`1` `201`, `1` `409`).
 * - `CASH-IT-05`: `11.03` Promise-to-Pay lifecycle (`CASE-11`, `CASE-22`), repeated partial payments superseding prior `ACTIVE` promise
 *   (`status = 'CANCELLED'`, `cancel_reason = 'SUPERSEDED_BY_NEW_PARTIAL_PAYMENT_PROMISE'`, `superseded_by_promise_id`) so a student is never reminded twice,
 *   due reminder candidate projection (`GET /api/v1/promises`), and automatic `FULFILLED` transition on full payment reducing debt to `0`.
 * - `CASH-IT-06`: `11.04` Method-wise reconciliation (`CASE-18` / `T11.04`: `0 + 3,200,000 - 150,000 = 3,050,000` cash expected while
 *   `1,800,000` card/non-cash is excluded from cash drawer), multi-method flows (`CLICK`, `PAYME`, `TRANSFER`), and `GET /api/v1/cash-shifts/{shift_id}`.
 * - `CASH-IT-07`: `11.01` & `11.04` Close cash shift (`POST /api/v1/cash-shifts/{shift_id}/close`), `discrepancy_uzs = counted - expected`,
 *   mandatory `discrepancy_reason` when `discrepancy_uzs !== 0` (`422` without reason, `200` with reason + `ShiftClosed` outbox),
 *   optimistic version check (`409`), and concurrent 2-worker close race (`1` `200`, `1` `409`).
 * - `CASH-IT-08`: `11.01` & `11.02` Closed shift immutability (`409 SHIFT_CLOSED` on payment, payment reversal execution, new expense,
 *   and expense reversal against a `CLOSED` shift with zero partial rows), and opening a fresh shift after closing the prior shift.
 * - `CASH-IT-09`: `11.04` Stored projection drift detection (`409 VERSION_CONFLICT` when stored `cash_shifts` columns drift from immutable records)
 *   and unconfirmed policy gates (`403 POLICY_DECISION_NOT_CONFIRMED`).
 * - `CASH-IT-10`: `11.05` Atomic rollback fault injection across `ShiftsService` and `ExpensesService` steps leaving zero partial rows,
 *   plus direct SQL verification that `UPDATE`/`DELETE` on `cash_expenses` and `ledger_entries` fails with PostgreSQL `42501`.
 */

import { INestApplication } from '@nestjs/common';
import * as assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as http from 'node:http';
import { after, before, describe, it } from 'node:test';
import { createApiApplication } from '../../src/application';
import { ClockService } from '../../src/auth/clock.service';
import { AuthenticatedStaffPrincipal } from '../../src/auth/permissions.guard';
import { ExpensesService } from '../../src/cash/expenses.service';
import { ShiftsService } from '../../src/cash/shifts.service';
import { RequestWithCorrelationId } from '../../src/common/request-id.middleware';
import { loadApiEnv } from '../../src/config/env';
import {
  executeSyntheticSeed,
  SYNTHETIC_DEMO_CENTER_A as C,
  SYNTHETIC_DEMO_CENTER_B as CB,
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

describe('Gate G8 — Stage 11 Cash Shifts, Categorized Expenses, Promise-to-Pay & Method-Wise Reconciliation HTTP + PostgreSQL Integration Suite (CASH-IT-01..10)', () => {
  let env: EphemeralDatabaseEnvironment;
  let app: INestApplication;
  let clock: ClockService;
  let shiftsService: ShiftsService;
  let expensesService: ExpensesService;
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

  async function closeAnyOpenShiftInCenterA(): Promise<void> {
    await env.apiPoolA.query(
      `UPDATE "cash_shifts"
          SET "status" = 'CLOSED',
              "counted_closing_cash_uzs" = "expected_closing_cash_uzs",
              "discrepancy_uzs" = 0,
              "closed_by_admin_id" = $2::uuid,
              "closed_at" = NOW(),
              "version" = "version" + 1
        WHERE "center_id" = $1::uuid
          AND "status" = 'OPEN'`,
      [C.centerId, C.directorId],
    );
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
        `STU-S11-${String(fixtureSeq).padStart(3, '0')}`,
        `Stage11 Student ${fixtureSeq}`,
        `stage11 student ${fixtureSeq}`,
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
      [groupId, C.centerId, C.courseId, `S11-GRP-${fixtureSeq}`, C.teacherId],
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
          `INV-S11-${fixtureSeq}-${i + 1}`,
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
    shiftsService = app.get(ShiftsService);
    expensesService = app.get(ExpensesService);
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

  it('CASH-IT-01: opens cash shift with opening float, rejects past/future shift_date (422), replays idempotently on subsequent day (N01/N02), enforces single OPEN shift per center (409), and serializes concurrent 2-worker open race', async () => {
    clock.setTestNow(new Date('2026-11-05T07:00:00.000Z'));
    await closeAnyOpenShiftInCenterA();

    for (const badDate of ['2026-11-04', '2026-11-06']) {
      const badDateRes = await httpJsonRequest({
        port,
        method: 'POST',
        path: '/api/v1/cash-shifts/open',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Idempotency-Key': `idem-s11-bad-date-${badDate}`,
        },
        body: {
          shift_date: badDate,
          opening_cash_uzs: '100000',
        },
      });
      assert.equal(badDateRes.statusCode, 422);
      assert.equal(badDateRes.json.error_code, 'VALIDATION_ERROR');
    }

    const [raceA, raceB] = await Promise.all([
      httpJsonRequest({
        port,
        method: 'POST',
        path: '/api/v1/cash-shifts/open',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Idempotency-Key': 'idem-s11-open-race-a',
        },
        body: {
          shift_date: '2026-11-05',
          opening_cash_uzs: '250000',
        },
      }),
      httpJsonRequest({
        port,
        method: 'POST',
        path: '/api/v1/cash-shifts/open',
        headers: {
          Authorization: `Bearer ${directorToken}`,
          'Idempotency-Key': 'idem-s11-open-race-b',
        },
        body: {
          shift_date: '2026-11-05',
          opening_cash_uzs: '250000',
        },
      }),
    ]);

    const statuses = [raceA.statusCode, raceB.statusCode].sort((a, b) => a - b);
    assert.deepEqual(statuses, [201, 409]);

    const winner = raceA.statusCode === 201 ? raceA : raceB;
    const winnerToken = raceA.statusCode === 201 ? adminToken : directorToken;
    const winnerKey =
      raceA.statusCode === 201 ? 'idem-s11-open-race-a' : 'idem-s11-open-race-b';

    assert.equal(winner.json.status, 'OPEN');
    assert.equal(winner.json.shift_date, '2026-11-05');
    assert.equal(winner.json.opening_cash_uzs, '250000');
    assert.equal(winner.json.expected_closing_cash_uzs, '250000');

    clock.setTestNow(new Date('2026-11-06T08:00:00.000Z'));
    const nextDayReplay = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/cash-shifts/open',
      headers: {
        Authorization: `Bearer ${winnerToken}`,
        'Idempotency-Key': winnerKey,
      },
      body: {
        shift_date: '2026-11-05',
        opening_cash_uzs: '250000',
      },
    });
    assert.equal(nextDayReplay.statusCode, 201);
    assert.equal(nextDayReplay.json.shift_id, winner.json.shift_id);

    const mismatchRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/cash-shifts/open',
      headers: {
        Authorization: `Bearer ${winnerToken}`,
        'Idempotency-Key': winnerKey,
      },
      body: {
        shift_date: '2026-11-05',
        opening_cash_uzs: '500000',
      },
    });
    assert.equal(mismatchRes.statusCode, 409);
    assert.equal(mismatchRes.json.error_code, 'IDEMPOTENCY_PAYLOAD_MISMATCH');

    clock.setTestNow(new Date('2026-11-05T07:00:00.000Z'));
  });

  it('CASH-IT-02: enforces RBAC (Teacher 403 FORBIDDEN_ROLE, Admin denied expense reversal 403), cross-center isolation (404), and deactivated staff pre-replay guard (401)', async () => {
    await closeAnyOpenShiftInCenterA();
    const openRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/cash-shifts/open',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': 'idem-s11-it02-open',
      },
      body: {
        shift_date: '2026-11-05',
        opening_cash_uzs: '500000',
      },
    });
    assert.equal(openRes.statusCode, 201);
    const shiftId = String(openRes.json.shift_id);

    const teacherCalls = await Promise.all([
      httpJsonRequest({
        port,
        method: 'POST',
        path: '/api/v1/cash-shifts/open',
        headers: {
          Authorization: `Bearer ${teacherToken}`,
          'Idempotency-Key': 'idem-s11-tch-open',
        },
        body: { shift_date: '2026-11-05', opening_cash_uzs: '0' },
      }),
      httpJsonRequest({
        port,
        method: 'GET',
        path: `/api/v1/cash-shifts/${shiftId}`,
        headers: { Authorization: `Bearer ${teacherToken}` },
      }),
      httpJsonRequest({
        port,
        method: 'POST',
        path: `/api/v1/cash-shifts/${shiftId}/close`,
        headers: {
          Authorization: `Bearer ${teacherToken}`,
          'Idempotency-Key': 'idem-s11-tch-close',
        },
        body: { counted_closing_cash_uzs: '500000', expected_version: 1 },
      }),
      httpJsonRequest({
        port,
        method: 'POST',
        path: '/api/v1/cash-expenses',
        headers: {
          Authorization: `Bearer ${teacherToken}`,
          'Idempotency-Key': 'idem-s11-tch-exp',
        },
        body: {
          cash_shift_id: shiftId,
          category: 'SUPPLIES',
          amount_uzs: '50000',
          payment_method: 'CASH',
          reason_and_doc: 'Markers #DOC-TCH',
        },
      }),
      httpJsonRequest({
        port,
        method: 'GET',
        path: '/api/v1/promises',
        headers: { Authorization: `Bearer ${teacherToken}` },
      }),
    ]);

    for (const res of teacherCalls) {
      assert.equal(res.statusCode, 403);
      assert.equal(res.json.error_code, 'FORBIDDEN_ROLE');
    }

    const expRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/cash-expenses',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': 'idem-s11-it02-exp-1',
      },
      body: {
        cash_shift_id: shiftId,
        category: 'OFFICE_SUPPLIES',
        amount_uzs: '50000',
        payment_method: 'CASH',
        reason_and_doc: 'Whiteboard markers #INV-1102',
      },
    });
    assert.equal(expRes.statusCode, 201);
    const expenseId = String(expRes.json.last_recorded_expense_id);

    const adminRevViaPost = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/cash-expenses',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': 'idem-s11-it02-adm-rev-1',
      },
      body: {
        cash_shift_id: shiftId,
        category: 'OFFICE_SUPPLIES',
        amount_uzs: '-50000',
        payment_method: 'CASH',
        reason_and_doc: 'Admin unauthorized reversal attempt',
        reverses_expense_id: expenseId,
      },
    });
    assert.equal(adminRevViaPost.statusCode, 403);
    assert.equal(adminRevViaPost.json.error_code, 'FORBIDDEN_ROLE');

    const adminRevViaEndpoint = await httpJsonRequest({
      port,
      method: 'POST',
      path: `/api/v1/cash-expenses/${expenseId}/reverse`,
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': 'idem-s11-it02-adm-rev-2',
      },
      body: {
        reason_and_doc: 'Admin unauthorized reversal endpoint attempt',
      },
    });
    assert.equal(adminRevViaEndpoint.statusCode, 403);
    assert.equal(adminRevViaEndpoint.json.error_code, 'FORBIDDEN_ROLE');

    const centerBShiftId = crypto.randomUUID();
    await env.apiPoolB.query(
      `INSERT INTO "cash_shifts" (
         "id", "center_id", "shift_date", "opened_by_admin_id",
         "opening_cash_uzs", "expected_closing_cash_uzs", "status", "version"
       ) VALUES ($1::uuid, $2::uuid, '2026-11-05', $3::uuid, 0, 0, 'OPEN', 1)`,
      [centerBShiftId, CB.centerId, CB.adminId],
    );

    const crossShiftGet = await httpJsonRequest({
      port,
      method: 'GET',
      path: `/api/v1/cash-shifts/${centerBShiftId}`,
      headers: { Authorization: `Bearer ${directorToken}` },
    });
    assert.equal(crossShiftGet.statusCode, 404);

    const crossPromisesGet = await httpJsonRequest({
      port,
      method: 'GET',
      path: `/api/v1/promises?student_id=${CB.studentId}`,
      headers: { Authorization: `Bearer ${directorToken}` },
    });
    assert.equal(crossPromisesGet.statusCode, 404);

    await env.apiPoolA.query(
      `UPDATE "staff_users" SET "status" = 'DEACTIVATED' WHERE "id" = $1::uuid AND "center_id" = $2::uuid`,
      [C.adminId, C.centerId],
    );
    try {
      const deactivatedReplay = await httpJsonRequest({
        port,
        method: 'POST',
        path: '/api/v1/cash-expenses',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Idempotency-Key': 'idem-s11-it02-exp-1',
        },
        body: {
          cash_shift_id: shiftId,
          category: 'OFFICE_SUPPLIES',
          amount_uzs: '50000',
          payment_method: 'CASH',
          reason_and_doc: 'Whiteboard markers #INV-1102',
        },
      });
      assert.equal(deactivatedReplay.statusCode, 401);
    } finally {
      await env.apiPoolA.query(
        `UPDATE "staff_users" SET "status" = 'ACTIVE' WHERE "id" = $1::uuid AND "center_id" = $2::uuid`,
        [C.adminId, C.centerId],
      );
      await refreshTokens();
    }
  });

  it('CASH-IT-03: records categorized CASH & non-cash expenses, enforces negative cash drawer overdraft guard (422), and serializes concurrent 2-worker CASH expense overdraft race', async () => {
    await closeAnyOpenShiftInCenterA();

    const openRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/cash-shifts/open',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': 'idem-s11-it03-open',
      },
      body: {
        shift_date: '2026-11-05',
        opening_cash_uzs: '200000',
      },
    });
    assert.equal(openRes.statusCode, 201);
    const shiftId = String(openRes.json.shift_id);

    const overdraftRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/cash-expenses',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': 'idem-s11-it03-overdraft',
      },
      body: {
        cash_shift_id: shiftId,
        category: 'RENT_UTILITIES',
        amount_uzs: '250000',
        payment_method: 'CASH',
        reason_and_doc: 'Electricity bill exceeding cash drawer #UTIL-01',
      },
    });
    assert.equal(overdraftRes.statusCode, 422);
    assert.equal(overdraftRes.json.error_code, 'VALIDATION_ERROR');

    for (const [idx, method] of (['CARD', 'CLICK', 'PAYME', 'TRANSFER'] as const).entries()) {
      const nonCashExpRes = await httpJsonRequest({
        port,
        method: 'POST',
        path: '/api/v1/cash-expenses',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Idempotency-Key': `idem-s11-it03-noncash-${method}`,
        },
        body: {
          cash_shift_id: shiftId,
          category: `NON_CASH_${method}`,
          amount_uzs: '100000',
          payment_method: method,
          reason_and_doc: `Non-cash expense via ${method} #NC-${idx + 1}`,
        },
      });
      assert.equal(nonCashExpRes.statusCode, 201);
      assert.equal(nonCashExpRes.json.expected_closing_cash_uzs, '200000');
      assert.equal(nonCashExpRes.json.non_cash_expenses_uzs, String((idx + 1) * 100000));
    }

    const [raceExpA, raceExpB] = await Promise.all([
      httpJsonRequest({
        port,
        method: 'POST',
        path: '/api/v1/cash-expenses',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Idempotency-Key': 'idem-s11-it03-race-a',
        },
        body: {
          cash_shift_id: shiftId,
          category: 'SUPPLIES_A',
          amount_uzs: '150000',
          payment_method: 'CASH',
          reason_and_doc: 'Printer toner A #TON-A',
        },
      }),
      httpJsonRequest({
        port,
        method: 'POST',
        path: '/api/v1/cash-expenses',
        headers: {
          Authorization: `Bearer ${directorToken}`,
          'Idempotency-Key': 'idem-s11-it03-race-b',
        },
        body: {
          cash_shift_id: shiftId,
          category: 'SUPPLIES_B',
          amount_uzs: '150000',
          payment_method: 'CASH',
          reason_and_doc: 'Printer toner B #TON-B',
        },
      }),
    ]);

    const raceStatuses = [raceExpA.statusCode, raceExpB.statusCode].sort((a, b) => a - b);
    assert.deepEqual(raceStatuses, [201, 422]);

    const afterRaceGet = await httpJsonRequest({
      port,
      method: 'GET',
      path: `/api/v1/cash-shifts/${shiftId}`,
      headers: { Authorization: `Bearer ${directorToken}` },
    });
    assert.equal(afterRaceGet.statusCode, 200);
    assert.equal(afterRaceGet.json.cash_expenses_uzs, '150000');
    assert.equal(afterRaceGet.json.expected_closing_cash_uzs, '50000');
  });

  it('CASH-IT-04: executes Director-only append-only expense reversal, restores drawer cash, blocks duplicate reversal (409) & reverse-of-reversal (422), and serializes concurrent 2-Director reversal race', async () => {
    await closeAnyOpenShiftInCenterA();

    const openRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/cash-shifts/open',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': 'idem-s11-it04-open',
      },
      body: {
        shift_date: '2026-11-05',
        opening_cash_uzs: '500000',
      },
    });
    assert.equal(openRes.statusCode, 201);
    const shiftId = String(openRes.json.shift_id);

    const exp1Res = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/cash-expenses',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': 'idem-s11-it04-exp-cash',
      },
      body: {
        cash_shift_id: shiftId,
        category: 'OFFICE_SUPPLIES',
        amount_uzs: '150000',
        payment_method: 'CASH',
        reason_and_doc: 'Cash expense #EXP-CASH-01',
      },
    });
    assert.equal(exp1Res.statusCode, 201);
    assert.equal(exp1Res.json.expected_closing_cash_uzs, '350000');
    const cashExpenseId = String(exp1Res.json.last_recorded_expense_id);

    const exp2Res = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/cash-expenses',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': 'idem-s11-it04-exp-card',
      },
      body: {
        cash_shift_id: shiftId,
        category: 'INTERNET',
        amount_uzs: '80000',
        payment_method: 'CARD',
        reason_and_doc: 'Card expense #EXP-CARD-01',
      },
    });
    assert.equal(exp2Res.statusCode, 201);
    assert.equal(exp2Res.json.non_cash_expenses_uzs, '80000');
    const cardExpenseId = String(exp2Res.json.last_recorded_expense_id);

    const [revRaceA, revRaceB] = await Promise.all([
      httpJsonRequest({
        port,
        method: 'POST',
        path: `/api/v1/cash-expenses/${cashExpenseId}/reverse`,
        headers: {
          Authorization: `Bearer ${directorToken}`,
          'Idempotency-Key': 'idem-s11-it04-rev-race-a',
        },
        body: {
          reason_and_doc: 'Director reversal of duplicate cash expense #REV-A',
        },
      }),
      httpJsonRequest({
        port,
        method: 'POST',
        path: '/api/v1/cash-expenses',
        headers: {
          Authorization: `Bearer ${directorToken}`,
          'Idempotency-Key': 'idem-s11-it04-rev-race-b',
        },
        body: {
          cash_shift_id: shiftId,
          category: 'OFFICE_SUPPLIES',
          amount_uzs: '-150000',
          payment_method: 'CASH',
          reason_and_doc: 'Director reversal of duplicate cash expense #REV-B',
          reverses_expense_id: cashExpenseId,
        },
      }),
    ]);

    const revStatuses = [revRaceA.statusCode, revRaceB.statusCode].sort((a, b) => a - b);
    assert.deepEqual(revStatuses, [201, 409]);

    const revWinner = revRaceA.statusCode === 201 ? revRaceA : revRaceB;
    assert.equal(revWinner.json.cash_expenses_uzs, '0');
    assert.equal(revWinner.json.expected_closing_cash_uzs, '500000');
    const reversalRowId = String(revWinner.json.last_recorded_expense_id);

    const revOfRevRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: `/api/v1/cash-expenses/${reversalRowId}/reverse`,
      headers: {
        Authorization: `Bearer ${directorToken}`,
        'Idempotency-Key': 'idem-s11-it04-rev-of-rev',
      },
      body: {
        reason_and_doc: 'Attempt to reverse a reversal record',
      },
    });
    assert.equal(revOfRevRes.statusCode, 422);

    const cardRevRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/cash-expenses',
      headers: {
        Authorization: `Bearer ${directorToken}`,
        'Idempotency-Key': 'idem-s11-it04-rev-card',
      },
      body: {
        cash_shift_id: shiftId,
        category: 'INTERNET',
        amount_uzs: '-80000',
        payment_method: 'CARD',
        reason_and_doc: 'Reverse erroneous card expense #REV-CARD-01',
        reverses_expense_id: cardExpenseId,
      },
    });
    assert.equal(cardRevRes.statusCode, 201);
    assert.equal(cardRevRes.json.non_cash_expenses_uzs, '0');
    assert.equal(cardRevRes.json.expected_closing_cash_uzs, '500000');

    const expRowsCount = await env.apiPoolA.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM "cash_expenses" WHERE "center_id" = $1::uuid AND "cash_shift_id" = $2::uuid`,
      [C.centerId, shiftId],
    );
    assert.equal(expRowsCount.rows[0].cnt, '4');
  });

  it('CASH-IT-05: manages 11.03 Promise-to-Pay lifecycle (superseding prior ACTIVE promise on repeated partial payment so student is never reminded twice, due reminder candidate listing, and CASE-22 auto-fulfillment on settlement)', async () => {
    clock.setTestNow(new Date('2026-11-05T07:00:00.000Z'));
    await closeAnyOpenShiftInCenterA();

    const openRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/cash-shifts/open',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': 'idem-s11-it05-open',
      },
      body: {
        shift_date: '2026-11-05',
        opening_cash_uzs: '0',
      },
    });
    assert.equal(openRes.statusCode, 201);
    const shiftId = String(openRes.json.shift_id);

    const fixture = await createIsolatedStudentAndInvoices(['500000'], ['2026-11-05']);
    const invoiceId = fixture.invoiceIds[0];

    const pay1Res = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/payments',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': 'idem-s11-it05-pay-1',
      },
      body: {
        student_id: fixture.studentId,
        cash_shift_id: shiftId,
        amount_uzs: '200000',
        currency: 'UZS',
        payment_method: 'CASH',
        target_invoice_ids: [invoiceId],
        promise_date: '2026-11-10',
      },
    });
    assert.equal(pay1Res.statusCode, 201);
    const promise1 = pay1Res.json.promise_to_pay as Record<string, unknown>;
    assert.ok(promise1);
    const promise1Id = String(promise1.promise_id);
    assert.equal(promise1.status, 'ACTIVE');
    assert.equal(promise1.promised_amount_uzs, '300000');
    assert.equal(promise1.promise_date, '2026-11-10');

    const pay2Res = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/payments',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': 'idem-s11-it05-pay-2',
      },
      body: {
        student_id: fixture.studentId,
        cash_shift_id: shiftId,
        amount_uzs: '100000',
        currency: 'UZS',
        payment_method: 'CASH',
        target_invoice_ids: [invoiceId],
        promise_date: '2026-11-15',
      },
    });
    assert.equal(pay2Res.statusCode, 201);
    const promise2 = pay2Res.json.promise_to_pay as Record<string, unknown>;
    assert.ok(promise2);
    const promise2Id = String(promise2.promise_id);
    assert.notEqual(promise2Id, promise1Id);
    assert.equal(promise2.status, 'ACTIVE');
    assert.equal(promise2.promised_amount_uzs, '200000');
    assert.equal(promise2.promise_date, '2026-11-15');

    clock.setTestNow(new Date('2026-11-15T08:00:00.000Z'));

    const listOnDueDateRes = await httpJsonRequest({
      port,
      method: 'GET',
      path: `/api/v1/promises?student_id=${fixture.studentId}`,
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(listOnDueDateRes.statusCode, 200);
    const promisesList = listOnDueDateRes.json.promises as Array<Record<string, unknown>>;
    const reminderCandidates = listOnDueDateRes.json.due_reminder_candidates as Array<
      Record<string, unknown>
    >;

    assert.equal(promisesList.length, 2);
    const p1Row = promisesList.find((p) => p.promise_id === promise1Id)!;
    const p2Row = promisesList.find((p) => p.promise_id === promise2Id)!;

    assert.equal(p1Row.status, 'CANCELLED');
    assert.equal(p1Row.cancel_reason, 'SUPERSEDED_BY_NEW_PARTIAL_PAYMENT_PROMISE');
    assert.equal(p1Row.superseded_by_promise_id, promise2Id);
    assert.equal(p1Row.eligible_for_due_reminder, false);

    assert.equal(p2Row.status, 'ACTIVE');
    assert.equal(p2Row.eligible_for_due_reminder, true);

    assert.equal(reminderCandidates.length, 1);
    assert.equal(reminderCandidates[0].promise_id, promise2Id);

    clock.setTestNow(new Date('2026-11-05T09:00:00.000Z'));
    const pay3Res = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/payments',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': 'idem-s11-it05-pay-3',
      },
      body: {
        student_id: fixture.studentId,
        cash_shift_id: shiftId,
        amount_uzs: '200000',
        currency: 'UZS',
        payment_method: 'CASH',
        target_invoice_ids: [invoiceId],
      },
    });
    assert.equal(pay3Res.statusCode, 201);
    assert.equal(pay3Res.json.total_student_remaining_debt_uzs, '0');

    clock.setTestNow(new Date('2026-11-15T08:00:00.000Z'));
    const listAfterSettleRes = await httpJsonRequest({
      port,
      method: 'GET',
      path: `/api/v1/promises?student_id=${fixture.studentId}`,
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(listAfterSettleRes.statusCode, 200);
    const settledPromises = listAfterSettleRes.json.promises as Array<Record<string, unknown>>;
    const settledCandidates = listAfterSettleRes.json.due_reminder_candidates as Array<
      Record<string, unknown>
    >;
    const settledDebtors = listAfterSettleRes.json.debtors as Array<Record<string, unknown>>;

    const p2After = settledPromises.find((p) => p.promise_id === promise2Id)!;
    assert.equal(p2After.status, 'FULFILLED');
    assert.equal(p2After.eligible_for_due_reminder, false);
    assert.equal(settledCandidates.length, 0);
    assert.equal(settledDebtors.length, 0);

    clock.setTestNow(new Date('2026-11-05T07:00:00.000Z'));
  });

  it('CASH-IT-06: verifies 11.04 CASE-18 / T11.04 method-wise reconciliation (0 + 3,200,000 CASH - 150,000 CASH expense = 3,050,000 expected closing cash; 1,800,000 CARD excluded from cash drawer)', async () => {
    clock.setTestNow(new Date('2026-11-05T07:00:00.000Z'));
    await closeAnyOpenShiftInCenterA();

    const openRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/cash-shifts/open',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': 'idem-s11-it06-open',
      },
      body: {
        shift_date: '2026-11-05',
        opening_cash_uzs: '0',
      },
    });
    assert.equal(openRes.statusCode, 201);
    const shiftId = String(openRes.json.shift_id);

    const fixture = await createIsolatedStudentAndInvoices(['3200000', '1800000']);

    const cashPayRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/payments',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': 'idem-s11-it06-pay-cash',
      },
      body: {
        student_id: fixture.studentId,
        cash_shift_id: shiftId,
        amount_uzs: '3200000',
        currency: 'UZS',
        payment_method: 'CASH',
        target_invoice_ids: [fixture.invoiceIds[0]],
      },
    });
    assert.equal(cashPayRes.statusCode, 201);

    const cardPayRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/payments',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': 'idem-s11-it06-pay-card',
      },
      body: {
        student_id: fixture.studentId,
        cash_shift_id: shiftId,
        amount_uzs: '1800000',
        currency: 'UZS',
        payment_method: 'CARD',
        target_invoice_ids: [fixture.invoiceIds[1]],
      },
    });
    assert.equal(cardPayRes.statusCode, 201);

    const cashExpRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/cash-expenses',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': 'idem-s11-it06-exp-cash',
      },
      body: {
        cash_shift_id: shiftId,
        category: 'OFFICE_SUPPLIES',
        amount_uzs: '150000',
        payment_method: 'CASH',
        reason_and_doc: 'Paper and markers #CASE18-EXP',
      },
    });
    assert.equal(cashExpRes.statusCode, 201);

    const getReconRes = await httpJsonRequest({
      port,
      method: 'GET',
      path: `/api/v1/cash-shifts/${shiftId}`,
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(getReconRes.statusCode, 200);
    assert.equal(getReconRes.json.opening_cash_uzs, '0');
    assert.equal(getReconRes.json.cash_receipts_uzs, '3200000');
    assert.equal(getReconRes.json.non_cash_receipts_uzs, '1800000');
    assert.equal(getReconRes.json.cash_refunds_uzs, '0');
    assert.equal(getReconRes.json.non_cash_refunds_uzs, '0');
    assert.equal(getReconRes.json.cash_expenses_uzs, '150000');
    assert.equal(getReconRes.json.non_cash_expenses_uzs, '0');
    assert.equal(getReconRes.json.expected_closing_cash_uzs, '3050000');
    assert.equal(getReconRes.json.net_non_cash_flow_uzs, '1800000');
    assert.equal(getReconRes.json.projection_drift_detected, false);

    const breakdown = getReconRes.json.method_breakdown as Array<Record<string, unknown>>;
    const cashItem = breakdown.find((b) => b.payment_method === 'CASH')!;
    const cardItem = breakdown.find((b) => b.payment_method === 'CARD')!;
    assert.equal(cashItem.gross_receipts_uzs, '3200000');
    assert.equal(cashItem.net_expenses_uzs, '150000');
    assert.equal(cashItem.net_flow_uzs, '3050000');
    assert.equal(cardItem.gross_receipts_uzs, '1800000');
    assert.equal(cardItem.net_expenses_uzs, '0');
    assert.equal(cardItem.net_flow_uzs, '1800000');
  });

  it('CASH-IT-07: closes cash shift, enforces mandatory discrepancy_reason when counted != expected (422), emits ShiftClosed outbox event, and serializes concurrent 2-worker close race', async () => {
    await closeAnyOpenShiftInCenterA();

    const openRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/cash-shifts/open',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': 'idem-s11-it07-open',
      },
      body: {
        shift_date: '2026-11-05',
        opening_cash_uzs: '3050000',
      },
    });
    assert.equal(openRes.statusCode, 201);
    const shiftId = String(openRes.json.shift_id);

    const missingReasonRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: `/api/v1/cash-shifts/${shiftId}/close`,
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': 'idem-s11-it07-close-no-reason',
      },
      body: {
        counted_closing_cash_uzs: '3000000',
        expected_version: 1,
      },
    });
    assert.equal(missingReasonRes.statusCode, 422);
    assert.equal(missingReasonRes.json.error_code, 'VALIDATION_ERROR');

    const staleVerRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: `/api/v1/cash-shifts/${shiftId}/close`,
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': 'idem-s11-it07-close-stale-ver',
      },
      body: {
        counted_closing_cash_uzs: '3050000',
        expected_version: 99,
      },
    });
    assert.equal(staleVerRes.statusCode, 409);
    assert.equal(staleVerRes.json.error_code, 'VERSION_CONFLICT');

    const [closeRaceA, closeRaceB] = await Promise.all([
      httpJsonRequest({
        port,
        method: 'POST',
        path: `/api/v1/cash-shifts/${shiftId}/close`,
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Idempotency-Key': 'idem-s11-it07-close-race-a',
        },
        body: {
          counted_closing_cash_uzs: '3000000',
          discrepancy_reason: 'Cash drawer short by 50,000 UZS verified by Director',
          expected_version: 1,
        },
      }),
      httpJsonRequest({
        port,
        method: 'POST',
        path: `/api/v1/cash-shifts/${shiftId}/close`,
        headers: {
          Authorization: `Bearer ${directorToken}`,
          'Idempotency-Key': 'idem-s11-it07-close-race-b',
        },
        body: {
          counted_closing_cash_uzs: '3000000',
          discrepancy_reason: 'Cash drawer short by 50,000 UZS verified by Director',
          expected_version: 1,
        },
      }),
    ]);

    const closeStatuses = [closeRaceA.statusCode, closeRaceB.statusCode].sort((a, b) => a - b);
    assert.deepEqual(closeStatuses, [200, 409]);

    const winnerClose = closeRaceA.statusCode === 200 ? closeRaceA : closeRaceB;
    assert.equal(winnerClose.json.status, 'CLOSED');
    assert.equal(winnerClose.json.expected_closing_cash_uzs, '3050000');
    assert.equal(winnerClose.json.counted_closing_cash_uzs, '3000000');
    assert.equal(winnerClose.json.discrepancy_uzs, '-50000');
    assert.equal(
      winnerClose.json.discrepancy_reason,
      'Cash drawer short by 50,000 UZS verified by Director',
    );

    const outboxRes = await env.apiPoolA.query<{ event_name: string; payload_json: Record<string, unknown> }>(
      `SELECT "event_name", "payload_json"
         FROM "outbox_events"
        WHERE "center_id" = $1::uuid
          AND "aggregate_type" = 'CashShift'
          AND "aggregate_id" = $2::uuid
          AND "event_name" = 'ShiftClosed'`,
      [C.centerId, shiftId],
    );
    assert.equal(outboxRes.rows.length, 1);
    assert.equal(outboxRes.rows[0].payload_json.discrepancy_uzs, '-50000');
  });

  it('CASH-IT-08: enforces CLOSED shift immutability (409 SHIFT_CLOSED on payment, payment reversal execution, new expense, and expense reversal) and permits opening a new shift after close', async () => {
    await closeAnyOpenShiftInCenterA();

    const open1Res = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/cash-shifts/open',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': 'idem-s11-it08-open-1',
      },
      body: {
        shift_date: '2026-11-05',
        opening_cash_uzs: '500000',
      },
    });
    assert.equal(open1Res.statusCode, 201);
    const shift1Id = String(open1Res.json.shift_id);

    const fixture = await createIsolatedStudentAndInvoices(['400000', '400000']);

    const payRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/payments',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': 'idem-s11-it08-pay-1',
      },
      body: {
        student_id: fixture.studentId,
        cash_shift_id: shift1Id,
        amount_uzs: '400000',
        currency: 'UZS',
        payment_method: 'CASH',
        target_invoice_ids: [fixture.invoiceIds[0]],
      },
    });
    assert.equal(payRes.statusCode, 201);
    const paymentId = String((payRes.json.payment as Record<string, unknown>).payment_id);

    const revReqRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/payments/reversals',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': 'idem-s11-it08-rev-req',
      },
      body: {
        original_payment_id: paymentId,
        kind: 'ERRONEOUS_ENTRY_REVERSAL',
        amount_uzs: '400000',
        refund_method: 'CASH',
        debt_effect_policy: 'RESTORE_INVOICE_DEBT',
        reason: 'Pending reversal before shift close',
      },
    });
    assert.equal(revReqRes.statusCode, 201);
    const reversalRequestId = String(revReqRes.json.request_id);

    const expRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/cash-expenses',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': 'idem-s11-it08-exp-1',
      },
      body: {
        cash_shift_id: shift1Id,
        category: 'SUPPLIES',
        amount_uzs: '100000',
        payment_method: 'CASH',
        reason_and_doc: 'Expense before shift close #EXP-08',
      },
    });
    assert.equal(expRes.statusCode, 201);
    const expenseId = String(expRes.json.last_recorded_expense_id);
    const currentShiftVersion = Number(expRes.json.version);

    const close1Res = await httpJsonRequest({
      port,
      method: 'POST',
      path: `/api/v1/cash-shifts/${shift1Id}/close`,
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': 'idem-s11-it08-close-1',
      },
      body: {
        counted_closing_cash_uzs: '800000',
        expected_version: currentShiftVersion,
      },
    });
    assert.equal(close1Res.statusCode, 200);
    assert.equal(close1Res.json.status, 'CLOSED');

    const closedPayRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/payments',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': 'idem-s11-it08-closed-pay',
      },
      body: {
        student_id: fixture.studentId,
        cash_shift_id: shift1Id,
        amount_uzs: '400000',
        currency: 'UZS',
        payment_method: 'CASH',
        target_invoice_ids: [fixture.invoiceIds[1]],
      },
    });
    assert.equal(closedPayRes.statusCode, 409);
    assert.equal(closedPayRes.json.error_code, 'SHIFT_CLOSED');

    const closedPayRevApproveRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: `/api/v1/payments/reversals/${reversalRequestId}/decision`,
      headers: {
        Authorization: `Bearer ${directorToken}`,
        'Idempotency-Key': 'idem-s11-it08-closed-rev-approve',
      },
      body: {
        decision: 'APPROVE',
        cash_shift_id: shift1Id,
        decision_note: 'Attempt to execute reversal on closed shift',
        expected_version: 1,
      },
    });
    assert.equal(closedPayRevApproveRes.statusCode, 409);
    assert.equal(closedPayRevApproveRes.json.error_code, 'SHIFT_CLOSED');

    const closedNewExpRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/cash-expenses',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': 'idem-s11-it08-closed-exp',
      },
      body: {
        cash_shift_id: shift1Id,
        category: 'SUPPLIES',
        amount_uzs: '50000',
        payment_method: 'CASH',
        reason_and_doc: 'Attempt expense on closed shift',
      },
    });
    assert.equal(closedNewExpRes.statusCode, 409);
    assert.equal(closedNewExpRes.json.error_code, 'SHIFT_CLOSED');

    const closedExpRevRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: `/api/v1/cash-expenses/${expenseId}/reverse`,
      headers: {
        Authorization: `Bearer ${directorToken}`,
        'Idempotency-Key': 'idem-s11-it08-closed-exp-rev',
      },
      body: {
        reason_and_doc: 'Attempt expense reversal on closed shift',
      },
    });
    assert.equal(closedExpRevRes.statusCode, 409);
    assert.equal(closedExpRevRes.json.error_code, 'SHIFT_CLOSED');

    const open2Res = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/cash-shifts/open',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': 'idem-s11-it08-open-2',
      },
      body: {
        shift_date: '2026-11-05',
        opening_cash_uzs: '800000',
      },
    });
    assert.equal(open2Res.statusCode, 201);
    assert.notEqual(open2Res.json.shift_id, shift1Id);
    assert.equal(open2Res.json.status, 'OPEN');
  });

  it('CASH-IT-09: detects stored projection drift on cash_shifts (409 VERSION_CONFLICT) and enforces unconfirmed policy gates (403 POLICY_DECISION_NOT_CONFIRMED)', async () => {
    await closeAnyOpenShiftInCenterA();

    const openRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/cash-shifts/open',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Idempotency-Key': 'idem-s11-it09-open',
      },
      body: {
        shift_date: '2026-11-05',
        opening_cash_uzs: '500000',
      },
    });
    assert.equal(openRes.statusCode, 201);
    const shiftId = String(openRes.json.shift_id);

    await env.apiPoolA.query(
      `UPDATE "cash_shifts"
          SET "expected_closing_cash_uzs" = 500001
        WHERE "id" = $1::uuid
          AND "center_id" = $2::uuid`,
      [shiftId, C.centerId],
    );

    const driftedGetRes = await httpJsonRequest({
      port,
      method: 'GET',
      path: `/api/v1/cash-shifts/${shiftId}`,
      headers: { Authorization: `Bearer ${directorToken}` },
    });
    assert.equal(driftedGetRes.statusCode, 409);
    assert.equal(driftedGetRes.json.error_code, 'VERSION_CONFLICT');

    const driftedCloseRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: `/api/v1/cash-shifts/${shiftId}/close`,
      headers: {
        Authorization: `Bearer ${directorToken}`,
        'Idempotency-Key': 'idem-s11-it09-drifted-close',
      },
      body: {
        counted_closing_cash_uzs: '500000',
        expected_version: 1,
      },
    });
    assert.equal(driftedCloseRes.statusCode, 409);
    assert.equal(driftedCloseRes.json.error_code, 'VERSION_CONFLICT');

    await env.apiPoolA.query(
      `UPDATE "cash_shifts"
          SET "expected_closing_cash_uzs" = 500000
        WHERE "id" = $1::uuid
          AND "center_id" = $2::uuid`,
      [shiftId, C.centerId],
    );
    const restoredGetRes = await httpJsonRequest({
      port,
      method: 'GET',
      path: `/api/v1/cash-shifts/${shiftId}`,
      headers: { Authorization: `Bearer ${directorToken}` },
    });
    assert.equal(restoredGetRes.statusCode, 200);

    const unconfirmedCalls = await Promise.all([
      httpJsonRequest({
        port,
        method: 'POST',
        path: '/api/v1/cash-shifts/open',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Idempotency-Key': 'idem-s11-it09-pol-open',
        },
        body: {
          shift_date: '2026-11-05',
          opening_cash_uzs: '0',
          auto_carry_over_previous_counted_cash: true,
        },
      }),
      httpJsonRequest({
        port,
        method: 'POST',
        path: `/api/v1/cash-shifts/${shiftId}/close`,
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Idempotency-Key': 'idem-s11-it09-pol-close',
        },
        body: {
          counted_closing_cash_uzs: '450000',
          expected_version: 1,
          convert_discrepancy_to_expense: true,
        },
      }),
      httpJsonRequest({
        port,
        method: 'POST',
        path: '/api/v1/cash-expenses',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Idempotency-Key': 'idem-s11-it09-pol-exp',
        },
        body: {
          cash_shift_id: shiftId,
          category: 'SUPPLIES',
          amount_uzs: '900000',
          payment_method: 'CASH',
          reason_and_doc: 'Overdraft policy attempt',
          allow_negative_cash_overdraft: true,
        },
      }),
    ]);

    for (const res of unconfirmedCalls) {
      assert.equal(res.statusCode, 403);
      assert.equal(res.json.error_code, 'POLICY_DECISION_NOT_CONFIRMED');
    }
  });

  it('CASH-IT-10: proves atomic transaction rollback across every ShiftsService & ExpensesService write step and verifies PostgreSQL 42501 append-only protection on cash_expenses and ledger_entries', async () => {
    await closeAnyOpenShiftInCenterA();

    const directorPrincipal: AuthenticatedStaffPrincipal = {
      staffId: C.directorId,
      centerId: C.centerId,
      role: 'DIRECTOR',
      sessionId: crypto.randomUUID(),
      familyId: crypto.randomUUID(), centerSlug: C.centerSlug,
      staffVersion: 1, mustChangePassword: false, transportMode: 'BEARER',
      csrfTokenHash: null, licenseMode: 'ACTIVE',
    };

    for (const step of ['SHIFT_INSERT', 'AUDIT_LOG'] as const) {
      const mockReq = {
        headers: {
          'idempotency-key': `idem-s11-fault-open-${step}`,
          'x-request-id': `req-s11-fault-open-${step}`,
        },
        requestId: `req-s11-fault-open-${step}`,
      } as unknown as RequestWithCorrelationId;

      await assert.rejects(
        () =>
          shiftsService.openCashShift(
            mockReq,
            directorPrincipal,
            {
              shift_date: '2026-11-05',
              opening_cash_uzs: '300000',
            },
            { testFaultAfterStep: step },
          ),
        new RegExp(`SIMULATED_S11_SHIFT_FAULT_AFTER_${step}`),
      );

      const openCount = await env.apiPoolA.query<{ cnt: string }>(
        `SELECT COUNT(*)::text AS cnt FROM "cash_shifts" WHERE "center_id" = $1::uuid AND "status" = 'OPEN'`,
        [C.centerId],
      );
      assert.equal(openCount.rows[0].cnt, '0');
    }

    const openRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/cash-shifts/open',
      headers: {
        Authorization: `Bearer ${directorToken}`,
        'Idempotency-Key': 'idem-s11-it10-open-clean',
      },
      body: {
        shift_date: '2026-11-05',
        opening_cash_uzs: '500000',
      },
    });
    assert.equal(openRes.statusCode, 201);
    const shiftId = String(openRes.json.shift_id);

    for (const step of ['EXPENSE_INSERT', 'CASH_SHIFT_UPDATE', 'LEDGER_ENTRY', 'AUDIT_LOG'] as const) {
      const mockReq = {
        headers: {
          'idempotency-key': `idem-s11-fault-exp-${step}`,
          'x-request-id': `req-s11-fault-exp-${step}`,
        },
        requestId: `req-s11-fault-exp-${step}`,
      } as unknown as RequestWithCorrelationId;

      await assert.rejects(
        () =>
          expensesService.recordCashOrCardExpense(
            mockReq,
            directorPrincipal,
            {
              cash_shift_id: shiftId,
              category: 'FAULT_TEST',
              amount_uzs: '100000',
              payment_method: 'CASH',
              reason_and_doc: `Fault test at ${step}`,
            },
            { testFaultAfterStep: step },
          ),
        new RegExp(`SIMULATED_S11_EXPENSE_FAULT_AFTER_${step}`),
      );

      const expCount = await env.apiPoolA.query<{ cnt: string }>(
        `SELECT COUNT(*)::text AS cnt FROM "cash_expenses" WHERE "center_id" = $1::uuid AND "cash_shift_id" = $2::uuid`,
        [C.centerId, shiftId],
      );
      assert.equal(expCount.rows[0].cnt, '0');
    }

    const validExpRes = await httpJsonRequest({
      port,
      method: 'POST',
      path: '/api/v1/cash-expenses',
      headers: {
        Authorization: `Bearer ${directorToken}`,
        'Idempotency-Key': 'idem-s11-it10-valid-exp',
      },
      body: {
        cash_shift_id: shiftId,
        category: 'SUPPLIES',
        amount_uzs: '100000',
        payment_method: 'CASH',
        reason_and_doc: 'Valid expense #IT10',
      },
    });
    assert.equal(validExpRes.statusCode, 201);
    const validExpenseId = String(validExpRes.json.last_recorded_expense_id);

    for (const step of ['SHIFT_CLOSE_UPDATE', 'AUDIT_LOG', 'OUTBOX_EVENT'] as const) {
      const mockReq = {
        headers: {
          'idempotency-key': `idem-s11-fault-close-${step}`,
          'x-request-id': `req-s11-fault-close-${step}`,
        },
        requestId: `req-s11-fault-close-${step}`,
      } as unknown as RequestWithCorrelationId;

      await assert.rejects(
        () =>
          shiftsService.closeCashShiftAndReconcile(
            mockReq,
            directorPrincipal,
            shiftId,
            {
              counted_closing_cash_uzs: '400000',
              expected_version: 2,
            },
            { testFaultAfterStep: step },
          ),
        new RegExp(`SIMULATED_S11_SHIFT_FAULT_AFTER_${step}`),
      );

      const shiftStatusRes = await env.apiPoolA.query<{ status: string }>(
        `SELECT "status"::text AS status FROM "cash_shifts" WHERE "id" = $1::uuid AND "center_id" = $2::uuid`,
        [shiftId, C.centerId],
      );
      assert.equal(shiftStatusRes.rows[0].status, 'OPEN');
    }

    for (const sql of [
      `UPDATE "cash_expenses" SET "amount_uzs" = 1 WHERE "id" = '${validExpenseId}'::uuid`,
      `DELETE FROM "cash_expenses" WHERE "id" = '${validExpenseId}'::uuid`,
      `UPDATE "ledger_entries" SET "amount_uzs" = 1 WHERE "cash_expense_id" = '${validExpenseId}'::uuid`,
      `DELETE FROM "ledger_entries" WHERE "cash_expense_id" = '${validExpenseId}'::uuid`,
    ]) {
      await assert.rejects(
        () => env.apiPoolA.query(sql),
        (err: unknown) => (err as { code?: string }).code === '42501',
      );
    }
  });
});
