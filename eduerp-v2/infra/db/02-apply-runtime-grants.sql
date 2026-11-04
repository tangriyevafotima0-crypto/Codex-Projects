-- EduERP v2.0 — Post-Migration Runtime Role ACL Application (infra/db/02-apply-runtime-grants.sql)
-- Step 04.02 (T04.02):
-- - Invokes eduerp_apply_role_grants() after schema migration so that:
--   * eduerp_api_runtime has SELECT, INSERT, UPDATE on 25 Mutable tables and SELECT, INSERT ONLY on 21 Append-Only tables.
--   * eduerp_worker_runtime has least-privilege queue/scheduler grants and zero UPDATE/DELETE on Append-Only tables.
--   * eduerp_readonly has SELECT ONLY on all 46 tables.

SELECT eduerp_apply_role_grants('eduerp_api_runtime', 'eduerp_worker_runtime', 'eduerp_readonly');
