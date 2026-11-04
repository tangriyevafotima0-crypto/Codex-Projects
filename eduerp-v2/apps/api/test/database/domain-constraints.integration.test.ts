import * as assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { CANONICAL_IMMUTABLE_TABLES } from '../../src/database/database.service';
import {
  formatMoneyUzs,
  MAX_OAS_18_DIGIT_UZS,
  parsePositiveMoneyUzs,
} from '../../src/database/money';
import {
  executeSyntheticSeed,
  SYNTHETIC_DEMO_CENTER_A,
} from '../../src/database/seed-contract';
import {
  createEphemeralTestDbEnv,
  EphemeralDatabaseEnvironment,
} from './harness';

async function assertPgCode(
  fn: () => Promise<unknown>,
  expectedCodes: string | readonly string[],
  messageHint?: string,
): Promise<void> {
  const allowed = Array.isArray(expectedCodes) ? expectedCodes : [expectedCodes];
  await assert.rejects(
    fn,
    (err: unknown) => {
      const pgErr = err as { code?: string; message?: string };
      assert.ok(
        pgErr.code && allowed.includes(pgErr.code),
        `Expected PostgreSQL SQLSTATE in [${allowed.join(', ')}], got ${pgErr.code}: ${pgErr.message}`,
      );
      if (messageHint) {
        assert.ok(
          (pgErr.message ?? '').includes(messageHint),
          `Expected message containing '${messageHint}', got '${pgErr.message}'`,
        );
      }
      return true;
    },
  );
}

describe('PostgreSQL Domain Constraints, Relational Lineage, Race-Safe Last Director & Immutability Triggers (DB-IT-05..08, 14..16, 19, F07, F08, F09)', () => {
  let env: EphemeralDatabaseEnvironment;
  const C = SYNTHETIC_DEMO_CENTER_A;

  before(async () => {
    env = await createEphemeralTestDbEnv();
    await executeSyntheticSeed(env.apiPoolA, C, {
      ...process.env,
      NODE_ENV: 'test',
      BOT_OUTBOUND_ENABLED: 'false',
    });
  });

  after(async () => {
    if (env) {
      await env.cleanup();
    }
  });

  it('DB-IT-05: enforces composite unique (center_id, login_username) on staff_users while allowing same login_username in another center', async () => {
    await assertPgCode(
      () =>
        env.apiPoolA.query(
          `INSERT INTO "staff_users" ("id", "center_id", "role", "full_name", "login_username", "password_hash", "status")
           VALUES ($1::uuid, $2::uuid, 'ADMIN', 'Duplicate Username', 'director.demo', 'hash', 'ACTIVE')`,
          [crypto.randomUUID(), C.centerId],
        ),
      '23505',
    );

    const otherCenterStaffId = crypto.randomUUID();
    const res = await env.apiPoolA.query(
      `INSERT INTO "staff_users" ("id", "center_id", "role", "full_name", "login_username", "password_hash", "status")
       VALUES ($1::uuid, '99999999-8888-4777-8666-555555555555'::uuid, 'DIRECTOR', 'Other Center Director', 'director.demo', 'hash', 'ACTIVE')`,
      [otherCenterStaffId],
    );
    assert.equal(res.rowCount, 1);
  });

  it('DB-IT-06 (F07): enforces partial unique indexes, LEFT->reenroll lifecycle, and same-day multi-lesson occurrence_seq', async () => {
    const shift1Id = crypto.randomUUID();
    await env.apiPoolA.query(
      `INSERT INTO "cash_shifts" ("id", "center_id", "shift_date", "opened_by_admin_id", "opening_cash_uzs", "expected_closing_cash_uzs", "status")
       VALUES ($1::uuid, $2::uuid, '2026-11-04', $3::uuid, 0, 0, 'OPEN')`,
      [shift1Id, C.centerId, C.adminId],
    );

    await assertPgCode(
      () =>
        env.apiPoolA.query(
          `INSERT INTO "cash_shifts" ("id", "center_id", "shift_date", "opened_by_admin_id", "opening_cash_uzs", "expected_closing_cash_uzs", "status")
           VALUES ($1::uuid, $2::uuid, '2026-11-04', $3::uuid, 0, 0, 'OPEN')`,
          [crypto.randomUUID(), C.centerId, C.adminId],
        ),
      '23505',
    );

    // Active enrollment partial unique index + LEFT -> re-enroll lifecycle (F07)
    const firstEnrollmentId = crypto.randomUUID();
    await env.apiPoolA.query(
      `INSERT INTO "enrollments" ("id", "center_id", "student_id", "group_id", "status", "enrolled_at_date")
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'TRIAL', '2026-11-01')`,
      [firstEnrollmentId, C.centerId, C.studentId, C.groupId],
    );

    await assertPgCode(
      () =>
        env.apiPoolA.query(
          `INSERT INTO "enrollments" ("id", "center_id", "student_id", "group_id", "status", "enrolled_at_date")
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'ACTIVE', '2026-11-02')`,
          [crypto.randomUUID(), C.centerId, C.studentId, C.groupId],
        ),
      '23505',
    );

    // Transition firstEnrollmentId to LEFT with valid churn_reason_code=3, then re-enroll in same group!
    await env.apiPoolA.query(
      `UPDATE "enrollments"
          SET "status" = 'LEFT',
              "left_at_date" = '2026-11-02',
              "churn_reason_code" = 3,
              "version" = "version" + 1
        WHERE "id" = $1::uuid`,
      [firstEnrollmentId],
    );

    const enrollmentId = crypto.randomUUID();
    const reenrollRes = await env.apiPoolA.query(
      `INSERT INTO "enrollments" ("id", "center_id", "student_id", "group_id", "status", "enrolled_at_date")
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'TRIAL', '2026-11-03')`,
      [enrollmentId, C.centerId, C.studentId, C.groupId],
    );
    assert.equal(reenrollRes.rowCount, 1);

    // Same-day multi-lesson occurrences (occurrence_seq = 1 and occurrence_seq = 2 on 2026-11-02)
    const l1Id = crypto.randomUUID();
    const l2Id = crypto.randomUUID();
    await env.apiPoolA.query(
      `INSERT INTO "lesson_occurrences" ("id", "center_id", "group_id", "lesson_date", "occurrence_seq", "starts_at_utc", "ends_at_utc", "status", "primary_teacher_snapshot_id", "pay_recipient_teacher_id")
       VALUES
         ($1::uuid, $3::uuid, $4::uuid, '2026-11-02', 1, '2026-11-02T04:00:00Z', '2026-11-02T05:30:00Z', 'COMPLETED', $5::uuid, $5::uuid),
         ($2::uuid, $3::uuid, $4::uuid, '2026-11-02', 2, '2026-11-02T09:00:00Z', '2026-11-02T10:30:00Z', 'COMPLETED', $5::uuid, $5::uuid)`,
      [l1Id, l2Id, C.centerId, C.groupId, C.teacherId],
    );

    // Duplicate occurrence_seq=1 on same group+date fails 23505
    await assertPgCode(
      () =>
        env.apiPoolA.query(
          `INSERT INTO "lesson_occurrences" ("id", "center_id", "group_id", "lesson_date", "occurrence_seq", "starts_at_utc", "ends_at_utc", "status", "primary_teacher_snapshot_id", "pay_recipient_teacher_id")
           VALUES ($1::uuid, $2::uuid, $3::uuid, '2026-11-02', 1, '2026-11-02T11:00:00Z', '2026-11-02T12:30:00Z', 'SCHEDULED', $4::uuid, $4::uuid)`,
          [crypto.randomUUID(), C.centerId, C.groupId, C.teacherId],
        ),
      '23505',
    );

    const invId = crypto.randomUUID();
    await assertPgCode(
      () =>
        env.apiPoolA.query(
          `INSERT INTO "trial_activations" ("id", "center_id", "enrollment_id", "trial_activation_seq", "first_trial_lesson_id", "second_trigger_lesson_id", "generated_invoice_id", "status")
           VALUES ($1::uuid, $2::uuid, $3::uuid, 1, $4::uuid, $4::uuid, $5::uuid, 'ACTIVE_ACTIVATION')`,
          [crypto.randomUUID(), C.centerId, enrollmentId, l1Id, invId],
        ),
      '23514',
    );

    const trial1Id = crypto.randomUUID();
    await env.apiPoolA.query(
      `INSERT INTO "trial_activations" ("id", "center_id", "enrollment_id", "trial_activation_seq", "first_trial_lesson_id", "second_trigger_lesson_id", "generated_invoice_id", "status")
       VALUES ($1::uuid, $2::uuid, $3::uuid, 1, $4::uuid, $5::uuid, $6::uuid, 'ACTIVE_ACTIVATION')`,
      [trial1Id, C.centerId, enrollmentId, l1Id, l2Id, invId],
    );

    await assertPgCode(
      () =>
        env.apiPoolA.query(
          `INSERT INTO "trial_activations" ("id", "center_id", "enrollment_id", "trial_activation_seq", "first_trial_lesson_id", "second_trigger_lesson_id", "generated_invoice_id", "status")
           VALUES ($1::uuid, $2::uuid, $3::uuid, 2, $4::uuid, $5::uuid, $6::uuid, 'ACTIVE_ACTIVATION')`,
          [crypto.randomUUID(), C.centerId, enrollmentId, l1Id, l2Id, crypto.randomUUID()],
        ),
      '23505',
    );

    await env.apiPoolA.query(
      `UPDATE "trial_activations" SET "status" = 'COMPENSATED_VOID', "compensated_at" = NOW(), "version" = "version" + 1 WHERE "id" = $1::uuid`,
      [trial1Id],
    );
    const trial2Res = await env.apiPoolA.query(
      `INSERT INTO "trial_activations" ("id", "center_id", "enrollment_id", "trial_activation_seq", "first_trial_lesson_id", "second_trigger_lesson_id", "generated_invoice_id", "status")
       VALUES ($1::uuid, $2::uuid, $3::uuid, 2, $4::uuid, $5::uuid, $6::uuid, 'ACTIVE_ACTIVATION')`,
      [crypto.randomUUID(), C.centerId, enrollmentId, l1Id, l2Id, crypto.randomUUID()],
    );
    assert.equal(trial2Res.rowCount, 1);
  });

  it('DB-IT-07: ON DELETE RESTRICT blocks deleting parent records referenced by child records (and runtime role lacks DELETE)', async () => {
    await assertPgCode(
      () => env.apiPoolA.query(`DELETE FROM "students" WHERE "id" = $1::uuid`, [C.studentId]),
      '42501',
    );
    await assertPgCode(
      () => env.migratorPoolA.query(`DELETE FROM "students" WHERE "id" = $1::uuid`, [C.studentId]),
      '23503',
    );
    await assertPgCode(
      () => env.migratorPoolA.query(`DELETE FROM "courses" WHERE "id" = $1::uuid`, [C.courseId]),
      '23503',
    );
  });

  it('DB-IT-08, DB-IT-15, DB-IT-16, DB-IT-17 & F07/F09: enforces money/BigInt precision, relational lineage across attendance/invoice/payment/allocation/ledger, actor matrix, and append-only triggers', async () => {
    const enrollmentRes = await env.apiPoolA.query<{ id: string }>(
      `SELECT "id" FROM "enrollments" WHERE "student_id" = $1::uuid AND "center_id" = $2::uuid AND "status" = 'TRIAL' LIMIT 1`,
      [C.studentId, C.centerId],
    );
    const enrollmentId = enrollmentRes.rows[0].id;
    const lessonRes = await env.apiPoolA.query<{ id: string }>(
      `SELECT "id" FROM "lesson_occurrences" WHERE "group_id" = $1::uuid ORDER BY "occurrence_seq" ASC LIMIT 1`,
      [C.groupId],
    );
    const lessonId = lessonRes.rows[0].id;

    // DB-IT-16: Leaving enrollment without churn_reason_code 1..5 fails chk_enrollments_left_churn (23514)
    await assertPgCode(
      () =>
        env.apiPoolA.query(
          `UPDATE "enrollments" SET "status" = 'LEFT', "left_at_date" = '2026-11-15', "churn_reason_code" = NULL WHERE "id" = $1::uuid`,
          [enrollmentId],
        ),
      '23514',
    );

    // Attendance ADMIN_OVERRIDE without override_reason fails chk_attendance_records_override_reason (23514)
    await assertPgCode(
      () =>
        env.apiPoolA.query(
          `INSERT INTO "attendance_records" ("id", "center_id", "lesson_id", "student_id", "enrollment_id", "status", "source_channel", "recorded_by_staff_id", "override_reason", "client_operation_uuid")
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'PRESENT', 'ADMIN_OVERRIDE', $6::uuid, NULL, $7::uuid)`,
          [crypto.randomUUID(), C.centerId, lessonId, C.studentId, enrollmentId, C.adminId, crypto.randomUUID()],
        ),
      '23514',
    );

    // Valid attendance record succeeds, and duplicate (lesson_id, student_id) fails 23505 (F07)
    const validAttId = crypto.randomUUID();
    await env.apiPoolA.query(
      `INSERT INTO "attendance_records" ("id", "center_id", "lesson_id", "student_id", "enrollment_id", "status", "source_channel", "recorded_by_staff_id", "client_operation_uuid")
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'PRESENT', 'TEACHER_WEB', $6::uuid, $7::uuid)`,
      [validAttId, C.centerId, lessonId, C.studentId, enrollmentId, C.teacherId, crypto.randomUUID()],
    );
    await assertPgCode(
      () =>
        env.apiPoolA.query(
          `INSERT INTO "attendance_records" ("id", "center_id", "lesson_id", "student_id", "enrollment_id", "status", "source_channel", "recorded_by_staff_id", "client_operation_uuid")
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'LATE', 'TEACHER_WEB', $6::uuid, $7::uuid)`,
          [crypto.randomUUID(), C.centerId, lessonId, C.studentId, enrollmentId, C.teacherId, crypto.randomUUID()],
        ),
      '23505',
    );

    // F09 Regression: Create second student + second group + enrollment + lesson, and verify cross-student & cross-group lineage rejection!
    const otherStudentId = crypto.randomUUID();
    const otherGroupId = crypto.randomUUID();
    const otherEnrollmentId = crypto.randomUUID();
    const otherLessonId = crypto.randomUUID();

    await env.apiPoolA.query(
      `INSERT INTO "students" ("id", "center_id", "student_code", "full_name", "normalized_name", "status")
       VALUES ($1::uuid, $2::uuid, 'STU-PROBE-02', 'Probe Two Student', 'probe two student', 'ACTIVE')`,
      [otherStudentId, C.centerId],
    );
    await env.apiPoolA.query(
      `INSERT INTO "course_groups" ("id", "center_id", "course_id", "name", "primary_teacher_id", "billing_mode", "current_fee_uzs", "lessons_per_cycle", "schedule_days_json", "starts_time", "duration_minutes", "timezone", "status")
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'MATH-G2-OTHER', $4::uuid, 'CALENDAR_PRO_RATA', 480000, 12, '["TUE","THU","SAT"]'::jsonb, '14:00', 90, 'Asia/Tashkent', 'ACTIVE')`,
      [otherGroupId, C.centerId, C.courseId, C.teacherId],
    );
    await env.apiPoolA.query(
      `INSERT INTO "enrollments" ("id", "center_id", "student_id", "group_id", "status", "enrolled_at_date")
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'ACTIVE', '2026-11-04')`,
      [otherEnrollmentId, C.centerId, otherStudentId, otherGroupId],
    );
    await env.apiPoolA.query(
      `INSERT INTO "lesson_occurrences" ("id", "center_id", "group_id", "lesson_date", "occurrence_seq", "starts_at_utc", "ends_at_utc", "status", "primary_teacher_snapshot_id", "pay_recipient_teacher_id")
       VALUES ($1::uuid, $2::uuid, $3::uuid, '2026-11-04', 1, '2026-11-04T09:00:00Z', '2026-11-04T10:30:00Z', 'SCHEDULED', $4::uuid, $4::uuid)`,
      [otherLessonId, C.centerId, otherGroupId, C.teacherId],
    );

    // F09-1 (Exact MANAGER_S04_PROBES reproducer): student_id = C.studentId paired with otherEnrollmentId (belonging to otherStudentId) -> REJECTED 23503!
    await assertPgCode(
      () =>
        env.apiPoolA.query(
          `INSERT INTO "attendance_records" ("id", "center_id", "lesson_id", "student_id", "enrollment_id", "status", "source_channel", "recorded_by_staff_id", "client_operation_uuid")
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'PRESENT', 'TEACHER_WEB', $6::uuid, $7::uuid)`,
          [crypto.randomUUID(), C.centerId, otherLessonId, C.studentId, otherEnrollmentId, C.teacherId, crypto.randomUUID()],
        ),
      '23503',
    );

    // F09-2: student_id = C.studentId and enrollmentId (Group 1) paired with otherLessonId (Group 2) -> REJECTED 23503!
    await assertPgCode(
      () =>
        env.apiPoolA.query(
          `INSERT INTO "attendance_records" ("id", "center_id", "lesson_id", "student_id", "enrollment_id", "status", "source_channel", "recorded_by_staff_id", "client_operation_uuid")
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'PRESENT', 'TEACHER_WEB', $6::uuid, $7::uuid)`,
          [crypto.randomUUID(), C.centerId, otherLessonId, C.studentId, enrollmentId, C.teacherId, crypto.randomUUID()],
        ),
      '23503',
    );

    const cycleId = crypto.randomUUID();
    await env.apiPoolA.query(
      `INSERT INTO "billing_cycles" ("id", "center_id", "enrollment_id", "cycle_type", "cycle_key", "cycle_seq", "period_start_date", "period_end_date", "planned_lessons", "billable_lessons", "policy_version_id")
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'CALENDAR_MONTH', '2026-11', 1, '2026-11-01', '2026-11-30', 12, 12, $4::uuid)`,
      [cycleId, C.centerId, enrollmentId, C.billingPolicyId],
    );

    // F09-3: Invoice linking otherStudentId/otherEnrollmentId to cycleId (belonging to enrollmentId) -> REJECTED 23503!
    await assertPgCode(
      () =>
        env.apiPoolA.query(
          `INSERT INTO "invoices" ("id", "center_id", "invoice_number", "student_id", "enrollment_id", "billing_cycle_id", "policy_version_id", "tariff_snapshot_uzs", "base_pro_rata_charge_uzs", "approved_discount_uzs", "credit_note_adjustments_uzs", "effective_net_charge_uzs", "allocated_paid_uzs", "remaining_debt_uzs", "billed_lessons", "status", "due_date")
           VALUES ($1::uuid, $2::uuid, 'INV-WRONG-LINEAGE', $3::uuid, $4::uuid, $5::uuid, $6::uuid, 500000, 500000, 0, 0, 500000, 0, 500000, 12, 'ISSUED_OPEN', '2026-11-05')`,
          [crypto.randomUUID(), C.centerId, otherStudentId, otherEnrollmentId, cycleId, C.billingPolicyId],
        ),
      '23503',
    );

    // DB-IT-15: Invoice with mismatched remaining_debt_uzs fails chk_invoices_remaining_debt_formula (23514)
    await assertPgCode(
      () =>
        env.apiPoolA.query(
          `INSERT INTO "invoices" ("id", "center_id", "invoice_number", "student_id", "enrollment_id", "billing_cycle_id", "policy_version_id", "tariff_snapshot_uzs", "base_pro_rata_charge_uzs", "approved_discount_uzs", "credit_note_adjustments_uzs", "effective_net_charge_uzs", "allocated_paid_uzs", "remaining_debt_uzs", "billed_lessons", "status", "due_date")
           VALUES ($1::uuid, $2::uuid, 'INV-202611-BAD', $3::uuid, $4::uuid, $5::uuid, $6::uuid, 500000, 500000, 0, 0, 500000, 0, 100000, 12, 'ISSUED_OPEN', '2026-11-05')`,
          [crypto.randomUUID(), C.centerId, C.studentId, enrollmentId, cycleId, C.billingPolicyId],
        ),
      '23514',
    );

    const invoiceId = crypto.randomUUID();
    await env.apiPoolA.query(
      `INSERT INTO "invoices" ("id", "center_id", "invoice_number", "student_id", "enrollment_id", "billing_cycle_id", "policy_version_id", "tariff_snapshot_uzs", "base_pro_rata_charge_uzs", "approved_discount_uzs", "credit_note_adjustments_uzs", "effective_net_charge_uzs", "allocated_paid_uzs", "remaining_debt_uzs", "billed_lessons", "status", "due_date")
       VALUES ($1::uuid, $2::uuid, 'INV-202611-001', $3::uuid, $4::uuid, $5::uuid, $6::uuid, 500000, 500000, 0, 0, 500000, 300000, 200000, 12, 'PARTIALLY_PAID', '2026-11-05')`,
      [invoiceId, C.centerId, C.studentId, enrollmentId, cycleId, C.billingPolicyId],
    );

    const shiftRes = await env.apiPoolA.query<{ id: string }>(
      `SELECT "id" FROM "cash_shifts" WHERE "center_id" = $1::uuid AND "status" = 'OPEN' LIMIT 1`,
      [C.centerId],
    );
    const shiftId = shiftRes.rows[0].id;

    // DB-IT-15: Payment with amount_uzs <= 0 fails CHECK (23514)
    await assertPgCode(
      () =>
        env.apiPoolA.query(
          `INSERT INTO "payments" ("id", "center_id", "student_id", "cash_shift_id", "amount_uzs", "payment_method", "recorded_by_admin_id", "idempotency_key", "request_hash")
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 0, 'CASH', $5::uuid, 'idem-zero-1', $6)`,
          [crypto.randomUUID(), C.centerId, C.studentId, shiftId, C.adminId, 'a'.repeat(64)],
        ),
      '23514',
    );

    // DB-IT-15: Verify lossless BIGINT roundtrip above Number.MAX_SAFE_INTEGER (9007199254740993)
    const hugeAmount = parsePositiveMoneyUzs('9007199254740993');
    const paymentId = crypto.randomUUID();
    await env.apiPoolA.query(
      `INSERT INTO "payments" ("id", "center_id", "student_id", "cash_shift_id", "amount_uzs", "payment_method", "recorded_by_admin_id", "idempotency_key", "request_hash")
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::bigint, 'TRANSFER', $6::uuid, 'idem-bigint-safe-01', $7)`,
      [paymentId, C.centerId, C.studentId, shiftId, formatMoneyUzs(hugeAmount), C.adminId, 'b'.repeat(64)],
    );
    const readBack = await env.apiPoolA.query<{ amount_uzs: string }>(
      `SELECT "amount_uzs"::text AS amount_uzs FROM "payments" WHERE "id" = $1::uuid`,
      [paymentId],
    );
    assert.equal(readBack.rows[0]?.amount_uzs, '9007199254740993');
    assert.equal(parsePositiveMoneyUzs(readBack.rows[0]?.amount_uzs), MAX_OAS_18_DIGIT_UZS > hugeAmount ? hugeAmount : 0n);

    // F09-4: Payment belonging to otherStudentId cannot be allocated to invoiceId belonging to C.studentId (23503)
    const otherPaymentId = crypto.randomUUID();
    await env.apiPoolA.query(
      `INSERT INTO "payments" ("id", "center_id", "student_id", "cash_shift_id", "amount_uzs", "payment_method", "recorded_by_admin_id", "idempotency_key", "request_hash")
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 100000, 'CASH', $5::uuid, 'idem-other-pay-1', $6)`,
      [otherPaymentId, C.centerId, otherStudentId, shiftId, C.adminId, 'd'.repeat(64)],
    );
    await assertPgCode(
      () =>
        env.apiPoolA.query(
          `INSERT INTO "payment_allocations" ("id", "center_id", "payment_id", "invoice_id", "allocated_amount_uzs")
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 100000)`,
          [crypto.randomUUID(), C.centerId, otherPaymentId, invoiceId],
        ),
      '23503',
    );

    // F07 Actor Matrix (STAFF vs SYSTEM_WORKER valid & invalid on ledger_entries)
    await assertPgCode(
      () =>
        env.apiPoolA.query(
          `INSERT INTO "ledger_entries" ("id", "center_id", "entry_type", "student_id", "invoice_id", "direction", "amount_uzs", "actor_type", "actor_staff_id", "system_job_name")
           VALUES ($1::uuid, $2::uuid, 'INVOICE_ISSUED', $3::uuid, $4::uuid, 'DEBIT', 500000, 'STAFF', NULL, 'illegal_worker_name')`,
          [crypto.randomUUID(), C.centerId, C.studentId, invoiceId],
        ),
      '23514',
    );
    await assertPgCode(
      () =>
        env.apiPoolA.query(
          `INSERT INTO "ledger_entries" ("id", "center_id", "entry_type", "student_id", "invoice_id", "direction", "amount_uzs", "actor_type", "actor_staff_id", "system_job_name")
           VALUES ($1::uuid, $2::uuid, 'INVOICE_ISSUED', $3::uuid, $4::uuid, 'DEBIT', 500000, 'SYSTEM_WORKER', $5::uuid, NULL)`,
          [crypto.randomUUID(), C.centerId, C.studentId, invoiceId, C.adminId],
        ),
      '23514',
    );

    const validLedgerStaff = await env.apiPoolA.query(
      `INSERT INTO "ledger_entries" ("id", "center_id", "entry_type", "student_id", "invoice_id", "direction", "amount_uzs", "actor_type", "actor_staff_id", "system_job_name")
       VALUES ($1::uuid, $2::uuid, 'INVOICE_ISSUED', $3::uuid, $4::uuid, 'DEBIT', 500000, 'STAFF', $5::uuid, NULL)`,
      [crypto.randomUUID(), C.centerId, C.studentId, invoiceId, C.adminId],
    );
    assert.equal(validLedgerStaff.rowCount, 1);

    const validLedgerWorker = await env.workerPoolA.query(
      `INSERT INTO "ledger_entries" ("id", "center_id", "entry_type", "student_id", "invoice_id", "direction", "amount_uzs", "actor_type", "actor_staff_id", "system_job_name")
       VALUES ($1::uuid, $2::uuid, 'INVOICE_ISSUED', $3::uuid, $4::uuid, 'DEBIT', 500000, 'SYSTEM_WORKER', NULL, 'trial_activation_worker')`,
      [crypto.randomUUID(), C.centerId, C.studentId, invoiceId],
    );
    assert.equal(validLedgerWorker.rowCount, 1);

    // DB-IT-08: Append-only trigger blocks UPDATE and DELETE on payments and course_price_history even for migrator/owner (42501 IMMUTABLE_TABLE_VIOLATION)
    await assertPgCode(
      () => env.migratorPoolA.query(`UPDATE "payments" SET "amount_uzs" = 100 WHERE "id" = $1::uuid`, [paymentId]),
      '42501',
      'IMMUTABLE_TABLE_VIOLATION',
    );
    await assertPgCode(
      () => env.migratorPoolA.query(`DELETE FROM "payments" WHERE "id" = $1::uuid`, [paymentId]),
      '42501',
      'IMMUTABLE_TABLE_VIOLATION',
    );
    await assertPgCode(
      () => env.migratorPoolA.query(`DELETE FROM "course_price_history" WHERE "id" = $1::uuid`, [C.priceHistoryId]),
      '42501',
      'IMMUTABLE_TABLE_VIOLATION',
    );

    const trigCheck = await env.apiPoolA.query<{ relname: string }>(
      `SELECT DISTINCT c.relname::text AS relname
         FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_proc p ON p.oid = t.tgfoid
        WHERE p.proname = 'eduerp_forbid_append_only_mutation'
          AND NOT t.tgisinternal`,
    );
    assert.equal(trigCheck.rows.length, CANONICAL_IMMUTABLE_TABLES.length);

    // Closed payroll snapshot immutability trigger (42501 CLOSED_RECORD_IMMUTABLE)
    const snapId = crypto.randomUUID();
    await env.apiPoolA.query(
      `INSERT INTO "payroll_snapshots" ("id", "center_id", "period_key", "teacher_id", "payroll_model_snapshot", "primary_lessons_taught", "substitute_lessons_taught", "base_earned_uzs", "substitute_earned_uzs", "adjustments_total_uzs", "net_payable_uzs", "status", "closed_by_director_id", "closed_at")
       VALUES ($1::uuid, $2::uuid, '2026-10', $3::uuid, 'PER_LESSON_FIXED', 11, 1, 1800000, 200000, 0, 2000000, 'CLOSED', $4::uuid, NOW())`,
      [snapId, C.centerId, C.teacherId, C.directorId],
    );
    await assertPgCode(
      () => env.apiPoolA.query(`UPDATE "payroll_snapshots" SET "net_payable_uzs" = 1900000 WHERE "id" = $1::uuid`, [snapId]),
      '42501',
      'CLOSED_RECORD_IMMUTABLE',
    );

    // Closed cash shift immutability trigger (42501 CLOSED_RECORD_IMMUTABLE)
    const closedShiftId = crypto.randomUUID();
    await env.apiPoolA.query(
      `INSERT INTO "cash_shifts" ("id", "center_id", "shift_date", "opened_by_admin_id", "opening_cash_uzs", "cash_receipts_uzs", "cash_refunds_uzs", "cash_expenses_uzs", "expected_closing_cash_uzs", "counted_closing_cash_uzs", "discrepancy_uzs", "status", "closed_by_admin_id", "closed_at")
       VALUES ($1::uuid, $2::uuid, '2026-11-03', $3::uuid, 0, 3200000, 0, 150000, 3050000, 3050000, 0, 'CLOSED', $3::uuid, NOW())`,
      [closedShiftId, C.centerId, C.adminId],
    );
    await assertPgCode(
      () => env.apiPoolA.query(`UPDATE "cash_shifts" SET "counted_closing_cash_uzs" = 0 WHERE "id" = $1::uuid`, [closedShiftId]),
      '42501',
      'CLOSED_RECORD_IMMUTABLE',
    );
  });

  it('DB-IT-14: enforces outbox lease_token fencing, predecessor aggregate_version ordering, and atomic consumer receipt deduplication', async () => {
    const aggId = crypto.randomUUID();
    const ev1Id = crypto.randomUUID();
    const ev2Id = crypto.randomUUID();

    await env.apiPoolA.query(
      `INSERT INTO "outbox_events" ("id", "center_id", "event_name", "schema_version", "aggregate_type", "aggregate_id", "aggregate_version", "dedup_key", "payload_json", "status", "lease_token")
       VALUES
         ($1::uuid, $3::uuid, 'PaymentRecorded', 1, 'Payment', $4::uuid, 1, 'outbox-ev-1', '{"seq":1}'::jsonb, 'PENDING', 0),
         ($2::uuid, $3::uuid, 'AllocationAdjusted', 1, 'Payment', $4::uuid, 2, 'outbox-ev-2', '{"seq":2}'::jsonb, 'PENDING', 0)`,
      [ev1Id, ev2Id, C.centerId, aggId],
    );

    const claimRes = await env.workerPoolA.query<{ id: string; lease_token: string }>(
      `WITH claimable AS (
         SELECT candidate."id"
           FROM "outbox_events" candidate
          WHERE candidate."center_id" = $1::uuid
            AND candidate."status" = 'PENDING'
            AND NOT EXISTS (
              SELECT 1
                FROM "outbox_events" prev
               WHERE prev."center_id" = candidate."center_id"
                 AND prev."aggregate_type" = candidate."aggregate_type"
                 AND prev."aggregate_id" = candidate."aggregate_id"
                 AND prev."aggregate_version" < candidate."aggregate_version"
                 AND prev."status" IN ('PENDING', 'LEASED', 'DEAD_LETTER')
            )
          ORDER BY candidate."occurred_at_utc" ASC
          LIMIT 5
          FOR UPDATE SKIP LOCKED
       )
       UPDATE "outbox_events" target
          SET "status" = 'LEASED',
              "leased_by_worker" = 'worker-a',
              "lease_until" = NOW() + INTERVAL '60 seconds',
              "lease_token" = target."lease_token" + 1
         FROM claimable
        WHERE target."id" = claimable."id"
       RETURNING target."id"::text AS id, target."lease_token"::text AS lease_token`,
      [C.centerId],
    );

    assert.equal(claimRes.rows.length, 1);
    assert.equal(claimRes.rows[0].id, ev1Id);
    assert.equal(claimRes.rows[0].lease_token, '1');

    const staleUpdate = await env.workerPoolA.query(
      `UPDATE "outbox_events" SET "status" = 'COMPLETED' WHERE "id" = $1::uuid AND "lease_token" = 0`,
      [ev1Id],
    );
    assert.equal(staleUpdate.rowCount, 0);

    const r1 = await env.workerPoolA.query(
      `INSERT INTO "outbox_consumer_receipts" ("id", "center_id", "outbox_event_id", "consumer_name", "consumer_receipt_key", "fencing_lease_token", "effect_summary_json")
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'telegram_parent_notifier', 'rcpt-ev1', 1, '{"delivered":true}'::jsonb)
       ON CONFLICT ("center_id", "consumer_name", "outbox_event_id") DO NOTHING`,
      [crypto.randomUUID(), C.centerId, ev1Id],
    );
    assert.equal(r1.rowCount, 1);

    const r2 = await env.workerPoolA.query(
      `INSERT INTO "outbox_consumer_receipts" ("id", "center_id", "outbox_event_id", "consumer_name", "consumer_receipt_key", "fencing_lease_token", "effect_summary_json")
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'telegram_parent_notifier', 'rcpt-ev1-dup', 2, '{"delivered":true}'::jsonb)
       ON CONFLICT ("center_id", "consumer_name", "outbox_event_id") DO NOTHING`,
      [crypto.randomUUID(), C.centerId, ev1Id],
    );
    assert.equal(r2.rowCount, 0);
  });

  it('DB-IT-19 (F08): race-safe last active Director trigger blocks sequential and concurrent 2-connection deactivation of all Directors', async () => {
    await assertPgCode(
      () =>
        env.apiPoolA.query(
          `UPDATE "staff_users" SET "status" = 'DEACTIVATED' WHERE "id" = $1::uuid AND "center_id" = $2::uuid`,
          [C.directorId, C.centerId],
        ),
      '23514',
      'LAST_DIRECTOR_CANNOT_BE_DEACTIVATED',
    );

    await assertPgCode(
      () =>
        env.apiPoolA.query(
          `UPDATE "staff_users" SET "role" = 'ADMIN' WHERE "id" = $1::uuid AND "center_id" = $2::uuid`,
          [C.directorId, C.centerId],
        ),
      '23514',
      'LAST_DIRECTOR_CANNOT_BE_DEACTIVATED',
    );

    // F08 Regression (exact MANAGER_S04_PROBES concurrent two-connection deactivation reproducer):
    const d2 = crypto.randomUUID();
    await env.apiPoolA.query(
      `INSERT INTO "staff_users" ("id", "center_id", "role", "full_name", "login_username", "password_hash", "status")
       VALUES ($1::uuid, $2::uuid, 'DIRECTOR', 'Second Director', 'probe.director.2', 'hash', 'ACTIVE')`,
      [d2, C.centerId],
    );

    const connA = await env.apiPoolA.connect();
    const connB = await env.apiPoolA.connect();
    try {
      await Promise.all([connA.query('BEGIN'), connB.query('BEGIN')]);
      // Each transaction must finish independently; waiting for both UPDATEs before
      // COMMIT can keep the winning transaction's row lock indefinitely.
      const results = await Promise.allSettled([
        (async () => {
          try {
            await connA.query("SET LOCAL statement_timeout = '5000ms'");
            await connA.query(`UPDATE "staff_users" SET "status" = 'DEACTIVATED' WHERE "id" = $1::uuid`, [C.directorId]);
            await connA.query('COMMIT');
          } catch (error) {
            await connA.query('ROLLBACK');
            throw error;
          }
        })(),
        (async () => {
          try {
            await connB.query("SET LOCAL statement_timeout = '5000ms'");
            await connB.query(`UPDATE "staff_users" SET "status" = 'DEACTIVATED' WHERE "id" = $1::uuid`, [d2]);
            await connB.query('COMMIT');
          } catch (error) {
            await connB.query('ROLLBACK');
            throw error;
          }
        })(),
      ]);
      assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1,
        'Exactly one Director deactivation must commit');
      assert.equal(results.filter((result) => result.status === 'rejected').length, 1,
        'The competing deactivation must be rejected');
    } finally {
      await Promise.allSettled([connA.query('ROLLBACK'), connB.query('ROLLBACK')]);
      connA.release();
      connB.release();
    }

    const activeRes = await env.apiPoolA.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM "staff_users" WHERE "center_id" = $1::uuid AND "role" = 'DIRECTOR' AND "status" = 'ACTIVE'`,
      [C.centerId],
    );
    assert.ok(
      activeRes.rows[0].n >= 1,
      `Expected at least 1 ACTIVE DIRECTOR after concurrent deactivation, got ${activeRes.rows[0].n}`,
    );

    // Restore both directors to ACTIVE so subsequent tests see C.directorId as ACTIVE
    await env.apiPoolA.query(
      `UPDATE "staff_users" SET "status" = 'ACTIVE', "version" = "version" + 1 WHERE "id" = $1::uuid`,
      [C.directorId],
    );
    await env.apiPoolA.query(
      `UPDATE "staff_users" SET "status" = 'DEACTIVATED', "version" = "version" + 1 WHERE "id" = $1::uuid`,
      [d2],
    );
  });
});
