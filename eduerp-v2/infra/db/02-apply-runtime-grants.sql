-- EduERP v2.0 — Post-Migration Runtime Role ACL Application (infra/db/02-apply-runtime-grants.sql)
-- Step 04.02 (T04.02, F05, F06):
-- - Invokes eduerp_apply_role_grants() after Prisma CLI migration deploy so that:
--   * API runtime role has SELECT, INSERT, UPDATE on 25 Mutable tables and SELECT, INSERT ONLY on 21 Append-Only tables.
--   * Worker runtime role has least-privilege queue/scheduler grants and zero UPDATE/DELETE on Append-Only tables.
--   * Readonly role has SELECT ONLY on all 46 tables.
--   * Grants SELECT on _prisma_migrations to runtime roles for schema readiness verification.

DO $$
BEGIN
  IF current_database() = 'eduerp_jizzax_ziyo_dev' THEN
    PERFORM eduerp_apply_role_grants('eduerp_center_b_api', 'eduerp_center_b_worker', 'eduerp_center_b_readonly');
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = '_prisma_migrations') THEN
      GRANT SELECT ON TABLE "_prisma_migrations" TO eduerp_center_b_api, eduerp_center_b_worker, eduerp_center_b_readonly;
    END IF;
  ELSE
    PERFORM eduerp_apply_role_grants('eduerp_api_runtime', 'eduerp_worker_runtime', 'eduerp_readonly');
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = '_prisma_migrations') THEN
      GRANT SELECT ON TABLE "_prisma_migrations" TO eduerp_api_runtime, eduerp_worker_runtime, eduerp_readonly;
    END IF;
  END IF;
END;
$$;
