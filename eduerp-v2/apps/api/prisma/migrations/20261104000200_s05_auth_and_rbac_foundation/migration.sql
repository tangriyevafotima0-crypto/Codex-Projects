-- EduERP v2.0 — Stage 05 Additive Authentication, Session Family & RBAC Foundation Migration
-- Migration ID: 20261104000200_s05_auth_and_rbac_foundation
-- Target Engine: PostgreSQL 16
-- Scope (05.01-05.05):
--   1. Adds last_failed_login_at and password_changed_at to staff_users for brute-force lockout and credential lifecycle tracking.
--   2. Adds family_id, parent_session_id, replaced_by_session_id, rotated_at, csrf_token_hash, transport_mode, and
--      staff_version_snapshot to staff_sessions for single-use refresh rotation, replay family revocation, and
--      browser cookie CSRF vs mobile bearer transport binding.
--   3. Preserves all 46 canonical tables and existing data rows (additive upgrade compatible with F07 / T04.02).

ALTER TABLE "staff_users"
  ADD COLUMN IF NOT EXISTS "last_failed_login_at" TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS "password_changed_at" TIMESTAMPTZ NULL;

ALTER TABLE "staff_sessions"
  ADD COLUMN IF NOT EXISTS "family_id" UUID NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS "parent_session_id" UUID NULL,
  ADD COLUMN IF NOT EXISTS "replaced_by_session_id" UUID NULL,
  ADD COLUMN IF NOT EXISTS "rotated_at" TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS "csrf_token_hash" CHAR(64) NULL,
  ADD COLUMN IF NOT EXISTS "transport_mode" VARCHAR(16) NOT NULL DEFAULT 'BEARER'
    CHECK ("transport_mode" IN ('BEARER', 'COOKIE')),
  ADD COLUMN IF NOT EXISTS "staff_version_snapshot" INTEGER NOT NULL DEFAULT 1
    CHECK ("staff_version_snapshot" >= 1);

CREATE INDEX IF NOT EXISTS "idx_staff_sessions_family"
  ON "staff_sessions" ("center_id", "family_id");

SELECT eduerp_apply_role_grants();
