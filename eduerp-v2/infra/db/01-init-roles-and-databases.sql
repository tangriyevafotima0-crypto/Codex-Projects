-- EduERP v2.0 — Development & CI PostgreSQL Role & Multi-Center Isolation Bootstrap (infra/db/01-init-roles-and-databases.sql)
-- Step 04.02 (T04.02):
-- - Separates bootstrap superuser (POSTGRES_USER) from schema owner/migrator (eduerp_migrator),
--   API runtime (eduerp_api_runtime), Worker runtime (eduerp_worker_runtime), and Readonly (eduerp_readonly).
-- - Creates isolated Center B database (eduerp_jizzax_ziyo_dev) and role (eduerp_center_b_api) with PUBLIC CONNECT
--   revoked so Center A credentials cannot connect to Center B's database.
-- - Uses ONLY safe non-secret development/test placeholders (EXAMPLE_DEV_ONLY_*).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'eduerp_migrator') THEN
    CREATE ROLE eduerp_migrator LOGIN PASSWORD 'EXAMPLE_DEV_ONLY_MIGRATOR_PASS' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'eduerp_api_runtime') THEN
    CREATE ROLE eduerp_api_runtime LOGIN PASSWORD 'EXAMPLE_DEV_ONLY_API_RUNTIME_PASS' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'eduerp_worker_runtime') THEN
    CREATE ROLE eduerp_worker_runtime LOGIN PASSWORD 'EXAMPLE_DEV_ONLY_WORKER_RUNTIME_PASS' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'eduerp_readonly') THEN
    CREATE ROLE eduerp_readonly LOGIN PASSWORD 'EXAMPLE_DEV_ONLY_READONLY_PASS' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'eduerp_center_b_api') THEN
    CREATE ROLE eduerp_center_b_api LOGIN PASSWORD 'EXAMPLE_DEV_ONLY_CENTER_B_API_PASS' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END;
$$;

-- Create Center B database for cross-center isolation verification if not present
SELECT 'CREATE DATABASE eduerp_jizzax_ziyo_dev OWNER eduerp_migrator'
 WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'eduerp_jizzax_ziyo_dev')\gexec

-- Enforce strict database CONNECT isolation between Center A (eduerp_guliston_ilm_dev) and Center B (eduerp_jizzax_ziyo_dev)
REVOKE CONNECT ON DATABASE eduerp_guliston_ilm_dev FROM PUBLIC;
GRANT CONNECT, TEMP ON DATABASE eduerp_guliston_ilm_dev TO eduerp_migrator;
GRANT CONNECT ON DATABASE eduerp_guliston_ilm_dev TO eduerp_api_runtime, eduerp_worker_runtime, eduerp_readonly;
REVOKE CONNECT ON DATABASE eduerp_guliston_ilm_dev FROM eduerp_center_b_api;

REVOKE CONNECT ON DATABASE eduerp_jizzax_ziyo_dev FROM PUBLIC;
GRANT CONNECT, TEMP ON DATABASE eduerp_jizzax_ziyo_dev TO eduerp_migrator;
GRANT CONNECT ON DATABASE eduerp_jizzax_ziyo_dev TO eduerp_center_b_api;
REVOKE CONNECT ON DATABASE eduerp_jizzax_ziyo_dev FROM eduerp_api_runtime, eduerp_worker_runtime, eduerp_readonly;

-- Grant schema ownership on Center A public schema to eduerp_migrator
\connect eduerp_guliston_ilm_dev
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO eduerp_migrator;
GRANT USAGE ON SCHEMA public TO eduerp_api_runtime, eduerp_worker_runtime, eduerp_readonly;
