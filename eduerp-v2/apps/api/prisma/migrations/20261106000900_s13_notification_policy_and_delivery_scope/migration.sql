-- EduERP v2.0 — Migration 09 (S13FIX-T / T03 & T04):
-- 1. Feature-specific per-center notification policy columns on billing_policy_versions
--    (defaulting to UNCONFIGURED / UNCONFIGURED_CHANNEL_POLICY so general S08 billing confirmation
--    NEVER implicitly confirms PromiseDue reminder channels under OPEN_CHANNEL_02 / OWNER-20261105-04).
-- 2. Durable recipient-scoped child & payload projection columns + policy provenance on notification_deliveries
--    (target_student_id, payload_projection_json, policy_version_id) for exact guardian-student isolation.

ALTER TABLE "billing_policy_versions"
  ADD COLUMN IF NOT EXISTS "notification_policy_status" VARCHAR(24) NOT NULL DEFAULT 'UNCONFIGURED',
  ADD COLUMN IF NOT EXISTS "promise_reminder_channel_policy" VARCHAR(40) NOT NULL DEFAULT 'UNCONFIGURED_CHANNEL_POLICY',
  ADD COLUMN IF NOT EXISTS "notification_policy_effective_until" DATE NULL DEFAULT NULL;

ALTER TABLE "billing_policy_versions"
  DROP CONSTRAINT IF EXISTS "chk_billing_policy_versions_notification_status",
  ADD CONSTRAINT "chk_billing_policy_versions_notification_status"
    CHECK ("notification_policy_status" IN ('UNCONFIGURED', 'CONFIRMED'));

ALTER TABLE "billing_policy_versions"
  DROP CONSTRAINT IF EXISTS "chk_billing_policy_versions_promise_channel_policy",
  ADD CONSTRAINT "chk_billing_policy_versions_promise_channel_policy"
    CHECK ("promise_reminder_channel_policy" IN (
      'UNCONFIGURED_CHANNEL_POLICY',
      'CONFIRMED_GUARDIAN_ONLY',
      'CONFIRMED_ADMIN_AND_GUARDIAN'
    ));

ALTER TABLE "notification_deliveries"
  ADD COLUMN IF NOT EXISTS "target_student_id" UUID NULL DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS "payload_projection_json" JSONB NULL DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS "policy_version_id" UUID NULL DEFAULT NULL;

CREATE INDEX IF NOT EXISTS "idx_notification_deliveries_center_target_student"
  ON "notification_deliveries"("center_id", "target_student_id");

SELECT eduerp_apply_role_grants();
