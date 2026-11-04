#!/bin/sh
# EduERP v2.0 — PostgreSQL 16 Container Init Hook (Stage 04)
# Runs automatically on fresh PostgreSQL volume initialization:
# 1. Creates separated non-superuser roles (eduerp_migrator, eduerp_api_runtime, eduerp_worker_runtime, eduerp_readonly, eduerp_center_b_api)
#    and isolated Center B database (eduerp_jizzax_ziyo_dev).
# 2. Applies the canonical 46-table / 24-trigger foundation migration as eduerp_migrator.
# 3. Applies least-privilege runtime table/sequence grants via 02-apply-runtime-grants.sql.
set -eu

echo "[eduerp-db-init] Applying 01-init-roles-and-databases.sql..."
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -f /opt/eduerp/sql/01-init-roles-and-databases.sql

for target_db in eduerp_guliston_ilm_dev eduerp_jizzax_ziyo_dev; do
  echo "[eduerp-db-init] Granting schema ownership on ${target_db} to eduerp_migrator..."
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "${target_db}" -c "REVOKE CREATE ON SCHEMA public FROM PUBLIC; GRANT USAGE, CREATE ON SCHEMA public TO eduerp_migrator;"

  echo "[eduerp-db-init] Applying initial migration to ${target_db} as eduerp_migrator..."
  PGPASSWORD=EXAMPLE_DEV_ONLY_MIGRATOR_PASS psql -v ON_ERROR_STOP=1 \
    --username eduerp_migrator \
    --dbname "${target_db}" \
    -f /opt/eduerp/migrations/20261104000100_initial_foundation/migration.sql

  echo "[eduerp-db-init] Applying runtime grants to ${target_db}..."
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "${target_db}" -f /opt/eduerp/sql/02-apply-runtime-grants.sql
done

echo "[eduerp-db-init] Completed role separation, 46-table migration, and least-privilege grants."
