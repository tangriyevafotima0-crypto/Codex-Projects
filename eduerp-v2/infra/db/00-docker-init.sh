#!/bin/sh
# EduERP v2.0 — PostgreSQL 16 Container Init Hook (Stage 04/05 — F06)
# Runs on fresh PostgreSQL volume initialization to bootstrap separated non-superuser roles
# (eduerp_migrator, eduerp_api_runtime, eduerp_worker_runtime, eduerp_readonly, eduerp_center_b_*)
# and isolated per-center databases (eduerp_guliston_ilm_dev, eduerp_jizzax_ziyo_dev).
# Schema migrations are executed via the dedicated `migrator` service using `prisma migrate deploy`.
set -eu

echo "[eduerp-db-init] Bootstrapping roles and per-center databases via 01-init-roles-and-databases.sql..."
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -f /opt/eduerp/sql/01-init-roles-and-databases.sql
echo "[eduerp-db-init] Role and database bootstrap complete."
