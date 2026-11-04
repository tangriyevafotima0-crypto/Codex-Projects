import * as crypto from 'node:crypto';
import type { Pool } from 'pg';
import { DatabaseService } from './database.service';
import { runInTransaction } from './transaction';

export const SEED_CONTRACT_VERSION = '2.0.0-s05.1';

/**
 * Synthetic test-only password used exclusively in automated test fixtures (`NODE_ENV=test`).
 * Production seed execution is strictly forbidden by `validateRestoreSafeSeedEnv()`.
 */
export const SYNTHETIC_TEST_ONLY_PASSWORD = 'SyntheticTestOnly_ValidPass_2026!';

function createSyntheticScryptHash(password: string, saltTag: string): string {
  const salt = crypto.createHash('sha256').update(saltTag, 'utf8').digest().subarray(0, 16);
  const derived = crypto.scryptSync(password, salt, 64, {
    N: 16384,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  return `$scrypt$v=1$n=16384,r=8,p=1$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

export const SYNTHETIC_DIRECTOR_SCRYPT_HASH = createSyntheticScryptHash(
  SYNTHETIC_TEST_ONLY_PASSWORD,
  'eduerp-synthetic-director-salt-v1',
);
export const SYNTHETIC_ADMIN_SCRYPT_HASH = createSyntheticScryptHash(
  SYNTHETIC_TEST_ONLY_PASSWORD,
  'eduerp-synthetic-admin-salt-v1',
);
export const SYNTHETIC_TEACHER_SCRYPT_HASH = createSyntheticScryptHash(
  SYNTHETIC_TEST_ONLY_PASSWORD,
  'eduerp-synthetic-teacher-salt-v1',
);

export interface SyntheticCenterFixture {
  readonly centerId: string;
  readonly centerSlug: string;
  readonly directorId: string;
  readonly adminId: string;
  readonly teacherId: string;
  readonly billingPolicyId: string;
  readonly courseId: string;
  readonly priceHistoryId: string;
  readonly groupId: string;
  readonly studentId: string;
  readonly guardianId: string;
  readonly guardianStudentId: string;
}

export const SYNTHETIC_DEMO_CENTER_A: SyntheticCenterFixture = Object.freeze({
  centerId: '11111111-2222-4333-8444-555555555555',
  centerSlug: 'guliston-ilm',
  directorId: '11111111-2222-4333-8444-000000000001',
  adminId: '11111111-2222-4333-8444-000000000002',
  teacherId: '11111111-2222-4333-8444-000000000003',
  billingPolicyId: '11111111-2222-4333-8444-000000000010',
  courseId: '11111111-2222-4333-8444-000000000020',
  priceHistoryId: '11111111-2222-4333-8444-000000000021',
  groupId: '11111111-2222-4333-8444-000000000030',
  studentId: '11111111-2222-4333-8444-000000000040',
  guardianId: '11111111-2222-4333-8444-000000000050',
  guardianStudentId: '11111111-2222-4333-8444-000000000051',
});

export const SYNTHETIC_DEMO_CENTER_B: SyntheticCenterFixture = Object.freeze({
  centerId: '22222222-3333-4444-8555-666666666666',
  centerSlug: 'jizzax-ziyo',
  directorId: '22222222-3333-4444-8555-000000000001',
  adminId: '22222222-3333-4444-8555-000000000002',
  teacherId: '22222222-3333-4444-8555-000000000003',
  billingPolicyId: '22222222-3333-4444-8555-000000000010',
  courseId: '22222222-3333-4444-8555-000000000020',
  priceHistoryId: '22222222-3333-4444-8555-000000000021',
  groupId: '22222222-3333-4444-8555-000000000030',
  studentId: '22222222-3333-4444-8555-000000000040',
  guardianId: '22222222-3333-4444-8555-000000000050',
  guardianStudentId: '22222222-3333-4444-8555-000000000051',
});

export interface SeedExecutionSummary {
  readonly contractVersion: string;
  readonly centerId: string;
  readonly centerSlug: string;
  readonly insertedRowCount: number;
  readonly idempotentNoOp: boolean;
}

export function validateRestoreSafeSeedEnv(rawEnv: NodeJS.ProcessEnv = process.env): void {
  const outbound = (rawEnv.BOT_OUTBOUND_ENABLED ?? 'false').trim().toLowerCase();
  if (outbound !== 'false') {
    throw new Error(
      'Restore/seed safety violation (B14): BOT_OUTBOUND_ENABLED must be "false" during seed or backup restore',
    );
  }
  if (rawEnv.NODE_ENV === 'production' && rawEnv.EDUERP_ALLOW_SYNTHETIC_SEED_IN_PROD !== 'true') {
    throw new Error('Synthetic seed fixture is forbidden when NODE_ENV=production');
  }
}

export async function executeSyntheticSeed(
  poolOrService: Pool | DatabaseService,
  fixture: SyntheticCenterFixture = SYNTHETIC_DEMO_CENTER_A,
  rawEnv: NodeJS.ProcessEnv = process.env,
): Promise<SeedExecutionSummary> {
  validateRestoreSafeSeedEnv(rawEnv);

  const { result } = await runInTransaction(poolOrService, async (tx) => {
    let inserted = 0;

    const r1 = await tx.query(
      `INSERT INTO "center_licenses" (
         "center_id", "center_slug", "license_status", "signed_jwt_token",
         "signature_key_id", "valid_until_utc", "grace_until_utc",
         "last_verified_at_utc", "version"
       ) VALUES (
         $1::uuid, $2, 'ACTIVE', 'SYNTHETIC_DEMO_SIGNED_LICENSE_TOKEN_S04',
         'vendor-ed25519-key-01', '2027-12-31T23:59:59Z', '2028-01-07T23:59:59Z',
         NOW(), 1
       ) ON CONFLICT ("center_id") DO NOTHING`,
      [fixture.centerId, fixture.centerSlug],
    );
    inserted += r1.rowCount ?? 0;

    const r2 = await tx.query(
      `INSERT INTO "staff_users" (
         "id", "center_id", "role", "full_name", "login_username",
         "phone_e164", "password_hash", "must_change_password", "status"
       ) VALUES
         ($1::uuid, $4::uuid, 'DIRECTOR', 'Synthetic Director Demo', 'director.demo', '+998900000001', $5, FALSE, 'ACTIVE'),
         ($2::uuid, $4::uuid, 'ADMIN', 'Synthetic Admin Demo', 'admin.demo', '+998900000002', $6, FALSE, 'ACTIVE'),
         ($3::uuid, $4::uuid, 'TEACHER', 'Synthetic Teacher Demo', 'teacher.demo', '+998900000003', $7, FALSE, 'ACTIVE')
       ON CONFLICT ("id") DO NOTHING`,
      [
        fixture.directorId,
        fixture.adminId,
        fixture.teacherId,
        fixture.centerId,
        SYNTHETIC_DIRECTOR_SCRYPT_HASH,
        SYNTHETIC_ADMIN_SCRYPT_HASH,
        SYNTHETIC_TEACHER_SCRYPT_HASH,
      ],
    );
    inserted += r2.rowCount ?? 0;

    const r3 = await tx.query(
      `INSERT INTO "billing_policy_versions" (
         "id", "center_id", "version_number", "billing_mode", "rounding_mode",
         "discount_stacking_mode", "freeze_credit_basis", "rolling_month_end_mode",
         "package_cancel_mode", "refund_debt_mode"
       ) VALUES (
         $1::uuid, $2::uuid, 1, 'CALENDAR_PRO_RATA', 'HALF_UP_UZS_INT',
         'MAX_SINGLE_DISCOUNT', 'NET_PROPORTIONAL_LESSON', 'CLAMP_LAST_DAY',
         'PRESERVE_BALANCE', 'REOPEN_INVOICE_DEBT'
       ) ON CONFLICT ("id") DO NOTHING`,
      [fixture.billingPolicyId, fixture.centerId],
    );
    inserted += r3.rowCount ?? 0;

    const r4 = await tx.query(
      `INSERT INTO "courses" (
         "id", "center_id", "name", "default_monthly_fee_uzs", "default_lessons_per_cycle", "status"
       ) VALUES (
         $1::uuid, $2::uuid, 'Mathematics Foundation (Synthetic)', 480000, 12, 'ACTIVE'
       ) ON CONFLICT ("id") DO NOTHING`,
      [fixture.courseId, fixture.centerId],
    );
    inserted += r4.rowCount ?? 0;

    const r5 = await tx.query(
      `INSERT INTO "course_groups" (
         "id", "center_id", "course_id", "name", "primary_teacher_id",
         "billing_mode", "current_fee_uzs", "lessons_per_cycle",
         "schedule_days_json", "starts_time", "duration_minutes", "timezone", "status"
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, 'MATH-G1-SYNTHETIC', $4::uuid,
         'CALENDAR_PRO_RATA', 480000, 12,
         '["MON","WED","FRI"]'::jsonb, '09:00', 90, 'Asia/Tashkent', 'ACTIVE'
       ) ON CONFLICT ("id") DO NOTHING`,
      [fixture.groupId, fixture.centerId, fixture.courseId, fixture.teacherId],
    );
    inserted += r5.rowCount ?? 0;

    const r6 = await tx.query(
      `INSERT INTO "course_price_history" (
         "id", "center_id", "course_id", "group_id",
         "previous_fee_uzs", "new_fee_uzs", "effective_from", "changed_by_staff_id"
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, NULL,
         480000, 480000, '2026-01-01', $4::uuid
       ) ON CONFLICT ("id") DO NOTHING`,
      [fixture.priceHistoryId, fixture.centerId, fixture.courseId, fixture.directorId],
    );
    inserted += r6.rowCount ?? 0;

    const r7 = await tx.query(
      `INSERT INTO "students" (
         "id", "center_id", "student_code", "full_name", "normalized_name", "status"
       ) VALUES (
         $1::uuid, $2::uuid, 'STU-SYN-0001', 'Ali Valiyev (Synthetic)', 'ali valiyev (synthetic)', 'ACTIVE'
       ) ON CONFLICT ("id") DO NOTHING`,
      [fixture.studentId, fixture.centerId],
    );
    inserted += r7.rowCount ?? 0;

    const r8 = await tx.query(
      `INSERT INTO "guardians" (
         "id", "center_id", "full_name", "phone_e164", "status"
       ) VALUES (
         $1::uuid, $2::uuid, 'Vali Ota (Synthetic)', '+998901112233', 'ACTIVE'
       ) ON CONFLICT ("id") DO NOTHING`,
      [fixture.guardianId, fixture.centerId],
    );
    inserted += r8.rowCount ?? 0;

    const r9 = await tx.query(
      `INSERT INTO "guardian_students" (
         "id", "center_id", "guardian_id", "student_id", "relationship", "is_primary_payer", "active"
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'FATHER', TRUE, TRUE
       ) ON CONFLICT ("id") DO NOTHING`,
      [fixture.guardianStudentId, fixture.centerId, fixture.guardianId, fixture.studentId],
    );
    inserted += r9.rowCount ?? 0;

    return inserted;
  });

  return {
    contractVersion: SEED_CONTRACT_VERSION,
    centerId: fixture.centerId,
    centerSlug: fixture.centerSlug,
    insertedRowCount: result,
    idempotentNoOp: result === 0,
  };
}
