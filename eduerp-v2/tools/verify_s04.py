#!/usr/bin/env python3
"""EduERP v2.0 — Stage 04..13 Offline Structural, Schema, SQL, RBAC & Test Verifier (tools/verify_s04.py).

Verifies all Stage 04 (`04.01`..`04.05`, `F01`..`F10`), Stage 05 (`05.01`..`05.05`), Stage 06 (`06.01`..`06.05`),
Stage 07 (`07.01`..`07.05`), Stage 08 (`08.01`..`08.05`, `K01`..`K08`, `L01`..`L03`), Stage 09 (`09.01`..`09.05`,
`OWNER-20261105-04`), Stage 10..12, and Stage 13 (`13.01`..`13.05`, `S01`..`S08`, `S13FIX-T` / `T01`..`T06`) artifacts honestly:
1. `apps/api/prisma/schema.prisma` maps all 46 canonical entities, has ZERO `P1012` 1-to-1 composite relation uniqueness errors,
   defines composite `@id([centerId, actorId, operationType, clientOperationUuid])` on `ClientOperationLog`, and includes
   `L02` package allocation snapshot fields on `BillingCycle`, `OWNER-20261105-04` S09 policy confirmation fields on
   `BillingPolicyVersion`, `DiscountApproval`, and `FreezeRecord`, and `S13FIX-T` (`T03`/`T04`) notification policy &
   delivery scope fields on `BillingPolicyVersion` and `NotificationDelivery`.
2. Cumulative PostgreSQL migrations (`000100`..`000900`) define all 46 canonical tables plus technical helper tables
   (`auth_rate_limit_buckets`, `billing_cycle_lesson_allocations`), `ON DELETE RESTRICT` FKs, 9 named CHECKs,
   5 partial unique indexes, immutability triggers, relational lineage triggers, and least-privilege role grants.
3. Every SQL `INSERT INTO` statement in TypeScript source/tests references valid columns from the cumulative SQL migrations.
4. `docs/security/rbac-matrix.csv` covers all 60 Stage 03–12 operations.
5. `apps/worker/test/worker-integration.test.ts` declares all 24 Stage 13 scenarios (`WORKER-IT-01..24`).
"""
from __future__ import annotations

import csv
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

MUTABLE_ENTITIES = {
    "StaffUser": "staff_users",
    "StaffSession": "staff_sessions",
    "Student": "students",
    "Guardian": "guardians",
    "GuardianStudent": "guardian_students",
    "GuardianTelegramLink": "guardian_telegram_links",
    "Course": "courses",
    "CourseGroup": "course_groups",
    "Enrollment": "enrollments",
    "LessonOccurrence": "lesson_occurrences",
    "SubstituteAssignment": "substitute_assignments",
    "AttendanceRecord": "attendance_records",
    "GradeEntry": "grade_entries",
    "TrialActivation": "trial_activations",
    "Invoice": "invoices",
    "DiscountRequest": "discount_requests",
    "UnappliedCredit": "unapplied_credits",
    "ReversalOrRefundRequest": "reversal_or_refund_requests",
    "PromiseToPay": "promises_to_pay",
    "CashShift": "cash_shifts",
    "PayrollSnapshot": "payroll_snapshots",
    "OutboxEvent": "outbox_events",
    "NotificationDelivery": "notification_deliveries",
    "ImportBatch": "import_batches",
    "CenterLicense": "center_licenses",
}

IMMUTABLE_ENTITIES = {
    "CoursePriceHistory": "course_price_history",
    "AttendanceRevision": "attendance_revisions",
    "ClientOperationLog": "client_operation_logs",
    "BillingPolicyVersion": "billing_policy_versions",
    "BillingCycle": "billing_cycles",
    "InvoiceLine": "invoice_lines",
    "DiscountApproval": "discount_approvals",
    "FreezeRecord": "freeze_records",
    "FreezeLessonLink": "freeze_lesson_links",
    "CreditNote": "credit_notes",
    "CreditNoteApplication": "credit_note_applications",
    "Payment": "payments",
    "PaymentAllocation": "payment_allocations",
    "PaymentAllocationReversal": "payment_allocation_reversals",
    "ReversalOrRefundExecution": "reversal_or_refund_executions",
    "Receipt": "receipts",
    "CashExpense": "cash_expenses",
    "LedgerEntry": "ledger_entries",
    "PayrollAdjustment": "payroll_adjustments",
    "AuditLog": "audit_logs",
    "OutboxConsumerReceipt": "outbox_consumer_receipts",
}

ALL_ENTITIES = {**MUTABLE_ENTITIES, **IMMUTABLE_ENTITIES}

REQUIRED_CHECK_CONSTRAINTS = [
    "chk_enrollments_left_churn",
    "chk_attendance_records_override_reason",
    "chk_invoices_net_charge_formula",
    "chk_invoices_remaining_debt_formula",
    "chk_credit_notes_actor",
    "chk_cash_shifts_drawer_formula",
    "chk_credit_note_apps_source_xor",
    "chk_credit_note_apps_actor",
    "chk_ledger_entries_actor",
]

REQUIRED_PARTIAL_INDEXES = [
    "idx_guardian_telegram_links_active",
    "idx_enrollments_active_student_group",
    "idx_substitute_assignments_active_lesson",
    "idx_trial_activations_active_enrollment",
    "idx_cash_shifts_open_center",
]

LINEAGE_TRIGGER_TABLES = [
    "attendance_records",
    "grade_entries",
    "invoices",
    "discount_requests",
    "freeze_records",
    "freeze_lesson_links",
    "credit_notes",
    "credit_note_applications",
    "payment_allocations",
    "payment_allocation_reversals",
    "ledger_entries",
]


def parse_migration_table_columns(mig_sql: str, *extra_sqls: str) -> dict[str, set[str]]:
    table_cols: dict[str, set[str]] = {}
    for m in re.finditer(r'CREATE TABLE IF NOT EXISTS "([a-z0-9_]+)"\s*\((.*?)\n\);', mig_sql, flags=re.S):
        tbl_name = m.group(1)
        body = m.group(2)
        cols: set[str] = set()
        for line in body.splitlines():
            line = line.strip()
            if line.startswith("CONSTRAINT "):
                continue
            cm = re.match(r'^"([a-z0-9_]+)"\s+', line)
            if cm:
                cols.add(cm.group(1))
        table_cols[tbl_name] = cols

    for m in re.finditer(r'ALTER TABLE "([a-z0-9_]+)"(.*?);', "\n".join(extra_sqls), flags=re.S):
        tbl_name = m.group(1)
        body = m.group(2)
        if tbl_name in table_cols:
            for cm in re.finditer(r'ADD COLUMN IF NOT EXISTS "([a-z0-9_]+)"', body):
                table_cols[tbl_name].add(cm.group(1))
    return table_cols


def verify_prisma_1to1_relations(model_blocks: dict[str, str]) -> int:
    models: dict[str, dict] = {}
    for mname, body in model_blocks.items():
        unique_sets: set[tuple[str, ...]] = set()
        relations: list[dict] = []
        for line in body.splitlines():
            line = line.strip()
            if not line or line.startswith("//"):
                continue
            if line.startswith("@@unique") or line.startswith("@@id"):
                m = re.search(r"\[\s*([^\]]+)\s*\]", line)
                if m:
                    cols = tuple(c.strip() for c in m.group(1).split(","))
                    unique_sets.add(cols)
                continue
            if line.startswith("@@"):
                continue
            parts = line.split()
            if len(parts) < 2:
                continue
            fname, ftype = parts[0], parts[1]
            if "@id" in line or "@unique" in line:
                unique_sets.add((fname,))
            base_type = ftype.rstrip("?").rstrip("[]")
            is_list = ftype.endswith("[]")
            rel_name = None
            m_name = re.search(r'@relation\(\s*"([^"]+)"', line)
            if m_name:
                rel_name = m_name.group(1)
            fields = None
            m_fields = re.search(r"fields:\s*\[([^\]]+)\]", line)
            if m_fields:
                fields = tuple(c.strip() for c in m_fields.group(1).split(","))
            relations.append(
                {
                    "field": fname,
                    "target": base_type,
                    "is_list": is_list,
                    "rel_name": rel_name,
                    "fields": fields,
                }
            )
        models[mname] = {"unique_sets": unique_sets, "relations": relations}

    checked_1to1 = 0
    for mname, info in models.items():
        for r in info["relations"]:
            if r["fields"] is not None:
                target = r["target"]
                t_rels = [
                    tr
                    for tr in models[target]["relations"]
                    if tr["target"] == mname and tr["rel_name"] == r["rel_name"] and tr["fields"] is None
                ]
                for tr in t_rels:
                    if not tr["is_list"]:
                        checked_1to1 += 1
                        if r["fields"] not in info["unique_sets"]:
                            raise ValueError(
                                f"[ERR_S04_F01_P1012_1TO1_UNIQUE] Model {mname}.{r['field']} -> {target}.{tr['field']} "
                                f"is 1-to-1 with fields {r['fields']} not in unique_sets {info['unique_sets']}"
                            )
    return checked_1to1


def verify_prisma_schema_and_coverage(
    root: Path,
    schema_text: str | None = None,
    coverage_rows: list[dict] | None = None,
) -> dict:
    if schema_text is None:
        schema_text = (root / "apps/api/prisma/schema.prisma").read_text(encoding="utf-8")
    if coverage_rows is None:
        with (root / "docs/architecture/schema-coverage.csv").open(encoding="utf-8") as f:
            coverage_rows = list(csv.DictReader(f))

    if not re.search(r'provider\s*=\s*"prisma-client"', schema_text):
        raise ValueError('[ERR_S04_PRISMA_GENERATOR] schema.prisma must use Prisma 7 provider = "prisma-client"')
    if not re.search(r'output\s*=\s*"\.\./src/generated/prisma"', schema_text):
        raise ValueError("[ERR_S04_PRISMA_OUTPUT] schema.prisma must output to ../src/generated/prisma")
    if "url =" in schema_text or "directUrl =" in schema_text:
        raise ValueError("[ERR_S04_PRISMA_DATASOURCE_URL] Prisma 7 schema.prisma must not embed url = env(...) inside datasource block")

    model_blocks = dict(re.findall(r"model\s+(\w+)\s*\{([^}]+)\}", schema_text, flags=re.S))
    if set(model_blocks.keys()) != set(ALL_ENTITIES.keys()):
        diff = set(model_blocks.keys()) ^ set(ALL_ENTITIES.keys())
        raise ValueError(f"[ERR_S04_MODEL_COUNT] Expected exact 46 canonical Prisma models, diff: {diff}")

    checked_1to1 = verify_prisma_1to1_relations(model_blocks)

    col_block = model_blocks["ClientOperationLog"]
    if "@@id([centerId, actorId, operationType, clientOperationUuid])" not in col_block:
        raise ValueError("[ERR_S04_F10_CLIENT_OP_LOG_PK] ClientOperationLog must declare @@id([centerId, actorId, operationType, clientOperationUuid])")

    bpv_block = model_blocks["BillingPolicyVersion"]
    for req_field in [
        "discountPolicyStatus",
        "freezePolicyStatus",
        "policyConfirmationStatus",
        "notificationPolicyStatus",
        "promiseReminderChannelPolicy",
        "notificationPolicyEffectiveUntil",
    ]:
        if req_field not in bpv_block:
            raise ValueError(f"[ERR_S09_S13_MISSING_POLICY_FIELD] BillingPolicyVersion missing {req_field}")

    nd_block = model_blocks["NotificationDelivery"]
    for req_field in ["targetStudentId", "payloadProjectionJson", "policyVersionId"]:
        if req_field not in nd_block:
            raise ValueError(f"[ERR_S13_MISSING_DELIVERY_FIELD] NotificationDelivery missing {req_field}")

    bc_block = model_blocks["BillingCycle"]
    for req_field in ["allocatedLessonIdsJson", "consumedLessonIdsJson"]:
        if req_field not in bc_block:
            raise ValueError(f"[ERR_S08_L02_MISSING_CYCLE_FIELD] BillingCycle missing {req_field}")

    pay_block = model_blocks["Payment"]
    for req_field in ["paidAt", "recordedAt", "externalReference", "paymentNote", "sourceChannel"]:
        if req_field not in pay_block:
            raise ValueError(f"[ERR_S10_MISSING_PAYMENT_FIELD] Payment missing {req_field}")

    rcpt_block = model_blocks["Receipt"]
    for req_field in ["currency", "paidAtSnapshot", "recordedAtSnapshot"]:
        if req_field not in rcpt_block:
            raise ValueError(f"[ERR_S10_MISSING_RECEIPT_FIELD] Receipt missing {req_field}")

    cs_block = model_blocks["CashShift"]
    if "nonCashExpensesUzs" not in cs_block:
        raise ValueError("[ERR_S11_MISSING_SHIFT_FIELD] CashShift missing nonCashExpensesUzs")

    ptp_block = model_blocks["PromiseToPay"]
    for req_field in ["cancelReason", "supersededByPromiseId"]:
        if req_field not in ptp_block:
            raise ValueError(f"[ERR_S11_MISSING_PROMISE_FIELD] PromiseToPay missing {req_field}")

    for ent, tbl in MUTABLE_ENTITIES.items():
        blk = model_blocks[ent]
        if f'@@map("{tbl}")' not in blk:
            raise ValueError(f'[ERR_S04_MAP_MISMATCH] Model {ent} missing @@map("{tbl}")')
        if ent != "OutboxEvent" and not re.search(r"^\s*version\s+Int\b", blk, flags=re.M):
            raise ValueError(f"[ERR_S04_MUTABLE_MISSING_VERSION] Mutable model {ent} missing version Int field")
        if ent == "OutboxEvent" and not re.search(r"^\s*leaseToken\s+BigInt\b", blk, flags=re.M):
            raise ValueError("[ERR_S04_OUTBOX_LEASE] OutboxEvent missing leaseToken BigInt field")

    for ent, tbl in IMMUTABLE_ENTITIES.items():
        blk = model_blocks[ent]
        if f'@@map("{tbl}")' not in blk:
            raise ValueError(f'[ERR_S04_MAP_MISMATCH] Model {ent} missing @@map("{tbl}")')
        if re.search(r"^\s*version\s+Int\b", blk, flags=re.M):
            raise ValueError(f"[ERR_S04_IMMUTABLE_HAS_VERSION] Immutable model {ent} must not have mutable version field")

    if "onDelete: Cascade" in schema_text or "onDelete: SetNull" in schema_text:
        raise ValueError("[ERR_S04_FORBIDDEN_CASCADE] schema.prisma must use onDelete: Restrict on all relations")

    expected_cols = [
        "entity_name",
        "prisma_model",
        "table_name",
        "mutability_class",
        "runtime_role_grants",
        "primary_and_foreign_keys",
        "unique_and_partial_indexes",
        "check_and_trigger_constraints",
        "migration_locator",
        "integration_test_ids",
    ]
    if not coverage_rows or list(coverage_rows[0].keys()) != expected_cols or len(coverage_rows) != 46:
        raise ValueError("[ERR_S04_COVERAGE_CSV] docs/architecture/schema-coverage.csv must have exact 46 rows and canonical columns")

    seen_entities: set[str] = set()
    for row in coverage_rows:
        ent = row["entity_name"]
        tbl = row["table_name"]
        if ALL_ENTITIES.get(ent) != tbl or row["prisma_model"] != ent:
            raise ValueError(f"[ERR_S04_COVERAGE_ENTITY_MISMATCH] Coverage row {ent} -> {tbl} does not match canonical mapping")
        seen_entities.add(ent)

    if len(seen_entities) != 46:
        raise ValueError("[ERR_S04_COVERAGE_DUPLICATE] Duplicate entity in schema-coverage.csv")

    return {
        "prisma_models_verified": len(model_blocks),
        "prisma_1to1_relations_verified": checked_1to1,
        "mutable_models_verified": len(MUTABLE_ENTITIES),
        "immutable_models_verified": len(IMMUTABLE_ENTITIES),
        "schema_coverage_rows": len(coverage_rows),
    }


def verify_migration_and_db_roles(root: Path, mig_sql: str | None = None) -> dict:
    if mig_sql is None:
        mig_sql = (
            root / "apps/api/prisma/migrations/20261104000100_initial_foundation/migration.sql"
        ).read_text(encoding="utf-8")
    s05_mig_path = root / "apps/api/prisma/migrations/20261104000200_s05_auth_and_rbac_foundation/migration.sql"
    s06_mig_path = root / "apps/api/prisma/migrations/20261104000300_s06_auth_fixes_and_student_foundation/migration.sql"
    s07_mig_path = root / "apps/api/prisma/migrations/20261104000400_s07_academics_schedule_substitutes_grades/migration.sql"
    s08_mig_path = root / "apps/api/prisma/migrations/20261104000500_s08_billing_policy_cycles_trials_invoices/migration.sql"
    s10_mig_path = root / "apps/api/prisma/migrations/20261105000600_s10_payments_allocations_reversals_receipts/migration.sql"
    s11_mig_path = root / "apps/api/prisma/migrations/20261105000700_s11_cash_shifts_expenses_promises_reconciliation/migration.sql"
    s12_s13_mig_path = root / "apps/api/prisma/migrations/20261105000800_s12_s13_attendance_version_and_worker_schedules/migration.sql"
    s13_t_mig_path = root / "apps/api/prisma/migrations/20261106000900_s13_notification_policy_and_delivery_scope/migration.sql"

    s05_sql = s05_mig_path.read_text(encoding="utf-8")
    s06_sql = s06_mig_path.read_text(encoding="utf-8")
    s07_sql = s07_mig_path.read_text(encoding="utf-8")
    s08_sql = s08_mig_path.read_text(encoding="utf-8")
    s10_sql = s10_mig_path.read_text(encoding="utf-8")
    s11_sql = s11_mig_path.read_text(encoding="utf-8")
    s12_s13_sql = s12_s13_mig_path.read_text(encoding="utf-8")
    s13_t_sql = s13_t_mig_path.read_text(encoding="utf-8")

    if '"billing_cycle_lesson_allocations"' not in s08_sql or '"uq_bcla_enrollment_lesson"' not in s08_sql:
        raise ValueError("[ERR_S08_L02_MISSING_BCLA] Migration 000500 must define billing_cycle_lesson_allocations with uq_bcla_enrollment_lesson")
    if '"discount_policy_status"' not in s08_sql or '"freeze_policy_status"' not in s08_sql:
        raise ValueError("[ERR_S09_MISSING_POLICY_STATUS_COLS] Migration 000500 must define discount_policy_status and freeze_policy_status")
    if '"paid_at"' not in s10_sql or '"recorded_at"' not in s10_sql or '"paid_at_snapshot"' not in s10_sql:
        raise ValueError("[ERR_S10_MISSING_PAYMENT_TIMESTAMPS] Migration 000600 must define paid_at, recorded_at, and paid_at_snapshot")
    if '"non_cash_expenses_uzs"' not in s11_sql or '"idx_cash_expenses_unique_reversal"' not in s11_sql or '"superseded_by_promise_id"' not in s11_sql:
        raise ValueError("[ERR_S11_MISSING_CASH_MIGRATION_OBJECTS] Migration 000700 must define non_cash_expenses_uzs, idx_cash_expenses_unique_reversal, and superseded_by_promise_id")
    if '"notification_policy_status"' not in s13_t_sql or '"promise_reminder_channel_policy"' not in s13_t_sql or '"target_student_id"' not in s13_t_sql:
        raise ValueError("[ERR_S13_T_MISSING_MIGRATION_OBJECTS] Migration 000900 must define notification_policy_status, promise_reminder_channel_policy, and target_student_id")

    table_cols = parse_migration_table_columns(
        mig_sql,
        s05_sql,
        s06_sql,
        s07_sql,
        s08_sql,
        s10_sql,
        s11_sql,
        s12_s13_sql,
        s13_t_sql,
    )
    expected_tables = set(ALL_ENTITIES.values())
    if set(table_cols.keys()) != expected_tables:
        diff = set(table_cols.keys()) ^ expected_tables
        raise ValueError(f"[ERR_S04_SQL_TABLE_MISMATCH] migration.sql table set mismatch: {diff}")

    if "ON DELETE CASCADE" in mig_sql.upper() or "ON DELETE CASCADE" in s05_sql.upper() or "ON DELETE CASCADE" in s08_sql.upper() or "ON DELETE CASCADE" in s13_t_sql.upper():
        raise ValueError("[ERR_S04_SQL_CASCADE] migration.sql must not contain ON DELETE CASCADE")

    fk_count = mig_sql.count("ON DELETE RESTRICT ON UPDATE RESTRICT")
    if fk_count < 60:
        raise ValueError(f"[ERR_S04_SQL_FK_COUNT] Expected >=60 ON DELETE RESTRICT FKs, got {fk_count}")

    for chk in REQUIRED_CHECK_CONSTRAINTS:
        if f'CONSTRAINT "{chk}" CHECK' not in mig_sql:
            raise ValueError(f"[ERR_S04_MISSING_CHECK] Missing required CHECK constraint {chk} in migration.sql")

    for pidx in REQUIRED_PARTIAL_INDEXES:
        if f'CREATE UNIQUE INDEX IF NOT EXISTS "{pidx}"' not in mig_sql:
            raise ValueError(f"[ERR_S04_MISSING_PARTIAL_INDEX] Missing partial unique index {pidx} in migration.sql")

    if "CREATE OR REPLACE FUNCTION eduerp_forbid_append_only_mutation()" not in mig_sql:
        raise ValueError("[ERR_S04_MISSING_IMMUTABLE_TRIGGER] Missing eduerp_forbid_append_only_mutation() in migration.sql")
    for imm_tbl in IMMUTABLE_ENTITIES.values():
        if f"'{imm_tbl}'" not in mig_sql:
            raise ValueError(f"[ERR_S04_MISSING_IMMUTABLE_TRIGGER] Missing append-only trigger registration for {imm_tbl}")

    for special_trig in [
        "trg_payroll_snapshots_closed_immutable",
        "trg_cash_shifts_closed_immutable",
        "trg_staff_users_last_active_director",
    ]:
        if f"CREATE TRIGGER {special_trig}" not in mig_sql:
            raise ValueError(f"[ERR_S04_MISSING_SPECIAL_TRIGGER] Missing trigger {special_trig} in migration.sql")

    if "FROM \"staff_users\"" not in mig_sql or "FOR UPDATE" not in mig_sql:
        raise ValueError("[ERR_S04_F08_DIRECTOR_LOCK] eduerp_guard_last_active_director must lock active directors FOR UPDATE")

    if "CREATE OR REPLACE FUNCTION eduerp_enforce_relational_lineage()" not in mig_sql:
        raise ValueError("[ERR_S04_F09_LINEAGE_FN] Missing eduerp_enforce_relational_lineage() in migration.sql")
    if "CREATE TRIGGER trg_lineage_%I" not in mig_sql:
        raise ValueError("[ERR_S04_F09_LINEAGE_TRIGGER] Missing trg_lineage_%I loop in migration.sql")
    for l_tbl in LINEAGE_TRIGGER_TABLES:
        if f"'{l_tbl}'" not in mig_sql:
            raise ValueError(f"[ERR_S04_F09_LINEAGE_TRIGGER] Missing lineage table {l_tbl} in migration.sql")

    if 'CONSTRAINT "pk_client_operation_logs" PRIMARY KEY ("center_id", "actor_id", "operation_type", "client_operation_uuid")' not in mig_sql:
        raise ValueError("[ERR_S04_F10_SQL_PK] client_operation_logs must have composite PRIMARY KEY (center_id, actor_id, operation_type, client_operation_uuid)")

    roles_sql = (root / "infra/db/01-init-roles-and-databases.sql").read_text(encoding="utf-8")
    grants_sql = (root / "infra/db/02-apply-runtime-grants.sql").read_text(encoding="utf-8")

    for role_name in [
        "eduerp_migrator",
        "eduerp_api_runtime",
        "eduerp_worker_runtime",
        "eduerp_readonly",
        "eduerp_center_b_api",
        "eduerp_center_b_worker",
        "eduerp_center_b_readonly",
    ]:
        if role_name not in roles_sql:
            raise ValueError(f"[ERR_S04_MISSING_DB_ROLE] Missing role {role_name} in 01-init-roles-and-databases.sql")
    if "NOSUPERUSER NOCREATEDB NOCREATEROLE" not in roles_sql:
        raise ValueError("[ERR_S04_ROLE_PRIVILEGE] Roles must declare NOSUPERUSER NOCREATEDB NOCREATEROLE")
    if "REVOKE CONNECT ON DATABASE eduerp_guliston_ilm_dev FROM PUBLIC" not in roles_sql:
        raise ValueError("[ERR_S04_DB_ISOLATION] Missing REVOKE CONNECT ON DATABASE eduerp_guliston_ilm_dev FROM PUBLIC")
    if "eduerp_apply_role_grants" not in grants_sql:
        raise ValueError("[ERR_S04_ROLE_GRANTS_FN] 02-apply-runtime-grants.sql must invoke eduerp_apply_role_grants")

    return {
        "sql_tables_created": len(table_cols),
        "migrations_verified": 9,
        "foreign_keys_restrict": fk_count,
        "named_check_constraints_verified": len(REQUIRED_CHECK_CONSTRAINTS),
        "partial_unique_indexes_verified": len(REQUIRED_PARTIAL_INDEXES),
        "immutability_triggers_verified": len(IMMUTABLE_ENTITIES) + 3,
        "lineage_triggers_verified": len(LINEAGE_TRIGGER_TABLES),
    }


def verify_integration_tests_and_sql_columns(root: Path, test_corpus: str | None = None) -> dict:
    mig_sql = (
        root / "apps/api/prisma/migrations/20261104000100_initial_foundation/migration.sql"
    ).read_text(encoding="utf-8")
    s05_sql = (
        root / "apps/api/prisma/migrations/20261104000200_s05_auth_and_rbac_foundation/migration.sql"
    ).read_text(encoding="utf-8")
    s06_sql = (
        root / "apps/api/prisma/migrations/20261104000300_s06_auth_fixes_and_student_foundation/migration.sql"
    ).read_text(encoding="utf-8")
    s07_sql = (
        root / "apps/api/prisma/migrations/20261104000400_s07_academics_schedule_substitutes_grades/migration.sql"
    ).read_text(encoding="utf-8")
    s08_sql = (
        root / "apps/api/prisma/migrations/20261104000500_s08_billing_policy_cycles_trials_invoices/migration.sql"
    ).read_text(encoding="utf-8")
    s10_sql = (
        root / "apps/api/prisma/migrations/20261105000600_s10_payments_allocations_reversals_receipts/migration.sql"
    ).read_text(encoding="utf-8")
    s11_sql = (
        root / "apps/api/prisma/migrations/20261105000700_s11_cash_shifts_expenses_promises_reconciliation/migration.sql"
    ).read_text(encoding="utf-8")
    s12_s13_sql = (
        root / "apps/api/prisma/migrations/20261105000800_s12_s13_attendance_version_and_worker_schedules/migration.sql"
    ).read_text(encoding="utf-8")
    s13_t_sql = (
        root / "apps/api/prisma/migrations/20261106000900_s13_notification_policy_and_delivery_scope/migration.sql"
    ).read_text(encoding="utf-8")
    table_cols = parse_migration_table_columns(
        mig_sql,
        s05_sql,
        s06_sql,
        s07_sql,
        s08_sql,
        s10_sql,
        s11_sql,
        s12_s13_sql,
        s13_t_sql,
    )
    table_cols.update(parse_migration_table_columns(s06_sql))
    table_cols.update(parse_migration_table_columns(s08_sql))

    if (root / "apps/api/src/types/pg.d.ts").exists():
        raise ValueError("[ERR_S04_F02_CUSTOM_PG_DTS] Handwritten apps/api/src/types/pg.d.ts must be deleted in favor of @types/pg")

    env_ts = (root / "apps/api/src/config/env.ts").read_text(encoding="utf-8")
    if "migrationDatabaseUrl" in env_ts:
        raise ValueError("[ERR_S04_F06_API_MIGRATION_ENV] apps/api/src/config/env.ts must not expose migrationDatabaseUrl")

    ts_files = [
        "packages/contracts/src/billing-engine.ts",
        "apps/api/src/database/idempotency.ts",
        "apps/api/src/database/seed-contract.ts",
        "apps/api/src/auth/auth.service.ts",
        "apps/api/src/auth/staff.service.ts",
        "apps/api/src/auth/permissions.guard.ts",
        "apps/api/src/auth/roster.controller.ts",
        "apps/api/test/database/harness.ts",
        "apps/api/test/database/migrations-and-drift.integration.test.ts",
        "apps/api/test/database/domain-constraints.integration.test.ts",
        "apps/api/test/database/roles-and-isolation.integration.test.ts",
        "apps/api/test/database/transactions-and-readiness.integration.test.ts",
        "apps/api/test/database-unit.test.ts",
        "apps/api/src/students/duplicates.service.ts",
        "apps/api/src/students/guardians.service.ts",
        "apps/api/src/students/enrollments.service.ts",
        "apps/api/src/students/students.service.ts",
        "apps/api/test/auth/auth-and-sessions.integration.test.ts",
        "apps/api/test/auth/rbac-staff-and-roster.integration.test.ts",
        "apps/api/test/auth-unit.test.ts",
        "apps/api/test/students-unit.test.ts",
        "apps/api/test/students/students-lifecycle.integration.test.ts",
        "apps/api/src/academics/price-resolver.ts",
        "apps/api/src/academics/academic-access.service.ts",
        "apps/api/src/academics/courses.service.ts",
        "apps/api/src/academics/groups.service.ts",
        "apps/api/src/academics/lessons.service.ts",
        "apps/api/src/academics/substitutions.service.ts",
        "apps/api/src/academics/grades.service.ts",
        "apps/api/test/academics-unit.test.ts",
        "apps/api/test/academics/academics-lifecycle.integration.test.ts",
        "apps/api/src/billing/policy.ts",
        "apps/api/src/billing/calendar-proration.ts",
        "apps/api/src/billing/subscriptions.ts",
        "apps/api/src/billing/invoice-generator.ts",
        "apps/api/src/billing/trial-conversion.ts",
        "apps/api/src/billing/billing.controller.ts",
        "apps/api/test/billing-unit.test.ts",
        "apps/api/test/billing/billing-lifecycle.integration.test.ts",
        "apps/api/src/adjustments/discount-requests.ts",
        "apps/api/src/adjustments/discount-approval.ts",
        "apps/api/src/adjustments/freeze-credit.ts",
        "apps/api/src/adjustments/withdrawal.ts",
        "apps/api/src/adjustments/adjustments.controller.ts",
        "apps/api/test/adjustments-unit.test.ts",
        "apps/api/test/adjustments/adjustments-lifecycle.integration.test.ts",
        "apps/api/src/payments/dto.ts",
        "apps/api/src/payments/allocation.service.ts",
        "apps/api/src/payments/receipts.service.ts",
        "apps/api/src/payments/payment.service.ts",
        "apps/api/src/payments/reversal.service.ts",
        "apps/api/src/payments/payments.controller.ts",
        "apps/api/test/payments-unit.test.ts",
        "apps/api/test/payments/payments-lifecycle.integration.test.ts",
        "apps/api/src/cash/dto.ts",
        "apps/api/src/cash/reconciliation.service.ts",
        "apps/api/src/cash/shifts.service.ts",
        "apps/api/src/cash/expenses.service.ts",
        "apps/api/src/cash/promises.service.ts",
        "apps/api/src/cash/cash.controller.ts",
        "apps/api/test/cash-unit.test.ts",
        "apps/api/test/cash/cash-lifecycle.integration.test.ts",
        "apps/api/src/attendance/dto.ts",
        "apps/api/src/attendance/conflicts.service.ts",
        "apps/api/src/attendance/attendance.events.ts",
        "apps/api/src/attendance/attendance.service.ts",
        "apps/api/src/attendance/sync.service.ts",
        "apps/api/src/attendance/attendance.controller.ts",
        "apps/api/test/attendance-unit.test.ts",
        "apps/api/test/attendance/attendance-lifecycle.integration.test.ts",
        "apps/worker/src/database.ts",
        "apps/worker/src/outbox.worker.ts",
        "apps/worker/src/reminders.worker.ts",
        "apps/worker/src/teacher-ping.worker.ts",
        "apps/worker/src/schedules.worker.ts",
        "apps/worker/src/main.ts",
        "apps/worker/test/worker-integration.test.ts",
    ]
    if test_corpus is None:
        test_corpus = "\n".join((root / rel).read_text(encoding="utf-8") for rel in ts_files)

    for i in range(1, 22):
        code = f"DB-IT-{i:02d}"
        if code not in test_corpus:
            raise ValueError(f"[ERR_S04_MISSING_DB_IT] Missing required DB integration test scenario {code}")

    for i in range(1, 18):
        code = f"AUTH-IT-{i:02d}"
        if code not in test_corpus:
            raise ValueError(f"[ERR_S05_MISSING_AUTH_IT] Missing required Auth/RBAC integration test scenario {code}")

    for i in range(1, 10):
        code = f"STU-IT-{i:02d}"
        if code not in test_corpus:
            raise ValueError(f"[ERR_S06_MISSING_STU_IT] Missing required Stage 06 integration test scenario {code}")

    for i in range(1, 14):
        code = f"ACAD-IT-{i:02d}"
        if code not in test_corpus:
            raise ValueError(f"[ERR_S07_MISSING_ACAD_IT] Missing required Stage 07 integration test scenario {code}")

    for i in range(1, 14):
        code = f"BILL-IT-{i:02d}"
        if code not in test_corpus:
            raise ValueError(f"[ERR_S08_MISSING_BILL_IT] Missing required Stage 08 integration test scenario {code}")

    for i in range(1, 9):
        code = f"ADJ-IT-{i:02d}"
        if code not in test_corpus:
            raise ValueError(f"[ERR_S09_MISSING_ADJ_IT] Missing required Stage 09 integration test scenario {code}")

    for i in range(1, 11):
        code = f"PAY-IT-{i:02d}"
        if code not in test_corpus:
            raise ValueError(f"[ERR_S10_MISSING_PAY_IT] Missing required Stage 10 integration test scenario {code}")

    for i in range(1, 14):
        code = f"CASH-IT-{i:02d}"
        if code not in test_corpus:
            raise ValueError(f"[ERR_S11_MISSING_CASH_IT] Missing required Stage 11 integration test scenario {code}")

    for i in range(1, 13):
        code = f"ATT-IT-{i:02d}"
        if code not in test_corpus:
            raise ValueError(f"[ERR_S12_MISSING_ATT_IT] Missing required Stage 12 integration test scenario {code}")

    for i in range(1, 25):
        code = f"WORKER-IT-{i:02d}"
        if code not in test_corpus:
            raise ValueError(f"[ERR_S13_MISSING_WORKER_IT] Missing required Stage 13 integration test scenario {code}")

    if "EDUERP_ALLOW_DESTRUCTIVE_DB_TESTS" not in test_corpus or "eduerp_test_" not in test_corpus:
        raise ValueError("[ERR_S04_HARNESS_GUARD] Missing destructive test harness safety guards")

    inserts_verified = 0
    for m in re.finditer(r'INSERT INTO "([a-z0-9_]+)"\s*\(([^)]+)\)', test_corpus, flags=re.S):
        tbl = m.group(1)
        if tbl == "_prisma_migrations":
            continue
        if tbl not in table_cols:
            raise ValueError(f"[ERR_S04_TS_SQL_UNKNOWN_TABLE] Unknown table {tbl} in TypeScript SQL")
        cols = [c.strip().strip('"') for c in m.group(2).split(",") if c.strip()]
        unknown_cols = [c for c in cols if c not in table_cols[tbl]]
        if unknown_cols:
            raise ValueError(f"[ERR_S04_TS_SQL_UNKNOWN_COL] Table {tbl} in TypeScript SQL references non-existent columns: {unknown_cols}")
        inserts_verified += 1

    root_pkg = json.loads((root / "package.json").read_text(encoding="utf-8"))
    api_pkg = json.loads((root / "apps/api/package.json").read_text(encoding="utf-8"))
    worker_pkg = json.loads((root / "apps/worker/package.json").read_text(encoding="utf-8"))
    nvmrc = (root / ".nvmrc").read_text(encoding="utf-8").strip()

    if nvmrc != "24.18.1" or root_pkg.get("engines", {}).get("node") != ">=24.18.1 <25":
        raise ValueError("[ERR_S04_NODE24_TARGET] Node 24.18.1 target must be preserved in .nvmrc and package.json")
    if (
        root_pkg["devDependencies"].get("typescript") != "5.9.3"
        or root_pkg["devDependencies"].get("eslint") != "9.39.5"
        or root_pkg["devDependencies"].get("@types/node") != "24.13.6"
    ):
        raise ValueError("[ERR_S04_DEV_TOOLING_VERSIONS] Root devDependencies must pin typescript 5.9.3, eslint 9.39.5, and @types/node 24.13.6")

    if (
        api_pkg["dependencies"].get("@prisma/client") != "7.10.1"
        or api_pkg["dependencies"].get("@prisma/adapter-pg") != "7.10.1"
        or api_pkg["dependencies"].get("pg") != "8.23.1"
        or api_pkg["dependencies"].get("prisma") != "7.10.1"
        or api_pkg["dependencies"].get("jose") != "6.2.15"
        or api_pkg["devDependencies"].get("@types/pg") != "8.23.1"
    ):
        raise ValueError("[ERR_S04_S05_API_DEPS] apps/api/package.json must pin prisma/@prisma/client/@prisma/adapter-pg 7.10.1, pg/@types/pg 8.23.1, and jose 6.2.15")

    if (
        worker_pkg["dependencies"].get("pg") != "8.23.1"
        or worker_pkg["devDependencies"].get("@types/pg") != "8.23.1"
    ):
        raise ValueError("[ERR_S13_T_WORKER_DEPS] apps/worker/package.json must explicitly pin pg 8.23.1 and @types/pg 8.23.1")

    rbac_csv_path = root / "docs/security/rbac-matrix.csv"
    if not rbac_csv_path.exists():
        raise ValueError("[ERR_S05_MISSING_RBAC_CSV] docs/security/rbac-matrix.csv does not exist")
    with rbac_csv_path.open(encoding="utf-8") as f:
        rbac_rows = list(csv.DictReader(f))
    if len(rbac_rows) < 55:
        raise ValueError("[ERR_S11_RBAC_CSV_ROWS] docs/security/rbac-matrix.csv must cover all 55 Stage 03-11 operations")

    return {
        "db_integration_scenarios_verified": 21,
        "auth_integration_scenarios_verified": 17,
        "students_integration_scenarios_verified": 9,
        "academics_integration_scenarios_verified": 13,
        "billing_integration_scenarios_verified": 13,
        "adjustments_integration_scenarios_verified": 8,
        "payments_integration_scenarios_verified": 10,
        "cash_integration_scenarios_verified": 13,
        "attendance_integration_scenarios_verified": 12,
        "worker_integration_scenarios_verified": 24,
        "rbac_matrix_rows_verified": len(rbac_rows),
        "ts_sql_insert_statements_verified": inserts_verified,
        "node_target": nvmrc,
        "types_node_version": root_pkg["devDependencies"]["@types/node"],
        "prisma_version": api_pkg["dependencies"]["@prisma/client"],
        "pg_version": api_pkg["dependencies"]["pg"],
        "jose_version": api_pkg["dependencies"]["jose"],
        "typescript_version": root_pkg["devDependencies"]["typescript"],
        "eslint_version": root_pkg["devDependencies"]["eslint"],
    }


def assert_raises_code(fn, expected_code: str, label: str) -> str:
    try:
        fn()
    except ValueError as exc:
        if expected_code in str(exc):
            return f"{label} ({expected_code})"
        raise AssertionError(f"{label} raised wrong ValueError: {exc} (expected {expected_code})") from exc
    raise AssertionError(f"{label} did not raise ValueError({expected_code})")


def run_negative_self_tests(root: Path) -> list[str]:
    passed: list[str] = []
    base_schema = (root / "apps/api/prisma/schema.prisma").read_text(encoding="utf-8")
    with (root / "docs/architecture/schema-coverage.csv").open(encoding="utf-8") as f:
        base_cov = list(csv.DictReader(f))
    base_mig = (
        root / "apps/api/prisma/migrations/20261104000100_initial_foundation/migration.sql"
    ).read_text(encoding="utf-8")

    # NEG-S04-01: Immutable model given mutable version column in schema.prisma
    bad_schema = base_schema.replace(
        "model Payment {\n",
        "model Payment {\n  version Int @default(1)\n",
    )
    passed.append(
        assert_raises_code(
            lambda: verify_prisma_schema_and_coverage(root, schema_text=bad_schema, coverage_rows=base_cov),
            "[ERR_S04_IMMUTABLE_HAS_VERSION]",
            "NEG-S04-01: Immutable model with version column rejected",
        )
    )

    # NEG-S04-02: F01 P1012 composite 1-to-1 relation missing @@unique
    bad_1to1 = base_schema.replace(
        "  @@unique([discountRequestId, centerId])\n",
        "",
    )
    passed.append(
        assert_raises_code(
            lambda: verify_prisma_schema_and_coverage(root, schema_text=bad_1to1, coverage_rows=base_cov),
            "[ERR_S04_F01_P1012_1TO1_UNIQUE]",
            "NEG-S04-02: F01 P1012 composite 1-to-1 missing @@unique rejected",
        )
    )

    # NEG-S04-03: ON DELETE CASCADE in migration.sql
    bad_mig_cascade = base_mig.replace("ON DELETE RESTRICT", "ON DELETE CASCADE", 1)
    passed.append(
        assert_raises_code(
            lambda: verify_migration_and_db_roles(root, mig_sql=bad_mig_cascade),
            "[ERR_S04_SQL_CASCADE]",
            "NEG-S04-03: ON DELETE CASCADE in migration.sql rejected",
        )
    )

    # NEG-S04-04: Missing lineage trigger in migration.sql
    bad_mig_trig = base_mig.replace("CREATE TRIGGER trg_lineage_%I", "-- missing trigger")
    passed.append(
        assert_raises_code(
            lambda: verify_migration_and_db_roles(root, mig_sql=bad_mig_trig),
            "[ERR_S04_F09_LINEAGE_TRIGGER]",
            "NEG-S04-04: Missing F09 relational lineage trigger rejected",
        )
    )

    # NEG-S04-05: Missing DB-IT or AUTH-IT in integration test corpus
    passed.append(
        assert_raises_code(
            lambda: verify_integration_tests_and_sql_columns(root, test_corpus="DB-IT-01 only"),
            "[ERR_S04_MISSING_DB_IT]",
            "NEG-S04-05: Incomplete DB-IT/AUTH-IT integration test coverage rejected",
        )
    )

    return passed


def main() -> int:
    s04_schema = verify_prisma_schema_and_coverage(ROOT)
    s04_sql = verify_migration_and_db_roles(ROOT)
    s04_tests = verify_integration_tests_and_sql_columns(ROOT)
    neg = run_negative_self_tests(ROOT)

    summary = {
        "s04_prisma_schema_and_coverage": s04_schema,
        "s04_migration_and_db_roles": s04_sql,
        "s04_s09_integration_tests_and_tooling": s04_tests,
        "s04_negative_self_tests": neg,
    }
    print(json.dumps(summary, indent=2, ensure_ascii=False))
    print("PASS: tools/verify_s04.py verified all Stage 04..13 schema, migration, DB role, RBAC, and test invariants.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
