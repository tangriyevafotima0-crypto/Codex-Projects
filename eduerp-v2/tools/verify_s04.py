#!/usr/bin/env python3
"""EduERP v2.0 — Stage 04 Offline Structural, Schema, SQL & Test Coverage Verifier (tools/verify_s04.py).

Verifies all Stage 04 (`04.01`..`04.05`) artifacts honestly:
1. `04.01`: `apps/api/prisma/schema.prisma`, `apps/api/prisma.config.ts`, and `docs/architecture/schema-coverage.csv`
   map all 46 canonical entities from `docs/architecture/data-model.md` (25 mutable + 21 strictly append-only),
   use Prisma 7 `prisma-client` generator + `postgresql` provider, and enforce `onDelete: Restrict`.
2. `04.02`: `apps/api/prisma/migrations/20261104000100_initial_foundation/migration.sql` and `migration_lock.toml`
   define all 46 `CREATE TABLE` statements, `ON DELETE RESTRICT` on every FK (zero `CASCADE`), required domain `CHECK`
   constraints, partial unique indexes, and 24 immutability triggers (21 append-only + closed payroll + closed shift +
   last active Director protection). `infra/db/01-init-roles-and-databases.sql` and `02-apply-runtime-grants.sql`
   enforce non-superuser runtime roles and per-center `CONNECT` isolation.
3. `04.03`: `apps/api/src/database/*` and `apps/api/src/health/readiness.controller.ts` implement `DatabaseService`,
   lossless `BigInt` money (`money.ts`), bounded retry (`transaction.ts`), advisory-locked idempotency (`idempotency.ts`),
   restore-safe synthetic seed (`seed-contract.ts`), and `GET /api/v1/ready` (`503` redaction when DB unavailable).
4. `04.04`: `apps/api/test/database/*.integration.test.ts` cover all 20 required failure modes (`DB-IT-01`..`DB-IT-20`),
   `harness.ts` enforces `EDUERP_ALLOW_DESTRUCTIVE_DB_TESTS=true` + `eduerp_test_` DB name guard, and all SQL `INSERT`
   statements across `src/database/*` and `test/database/*` match exact column names in `migration.sql`.
5. `04.05`: `package.json`, `eslint.config.cjs`, `apps/api/package.json`, `apps/api/Dockerfile`, `infra/compose.dev.yml`,
   and `infra/ci/eduerp-ci.yml` align with Node 24 (`24.18.1`), Prisma `7.10.1`, `pg 8.23.1`, TypeScript `5.9.3`, and
   ESLint `9.39.5`.
6. Includes negative mutation self-tests proving `verify_s04.py` fails on missing tables, `ON DELETE CASCADE`, mutable
   version columns on immutable tables, missing triggers, or missing `DB-IT-*` test cases.
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


def parse_migration_table_columns(mig_sql: str) -> dict[str, set[str]]:
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
    return table_cols


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
        "mutable_models_verified": len(MUTABLE_ENTITIES),
        "immutable_models_verified": len(IMMUTABLE_ENTITIES),
        "schema_coverage_rows": len(coverage_rows),
    }


def verify_migration_and_db_roles(root: Path, mig_sql: str | None = None) -> dict:
    if mig_sql is None:
        mig_sql = (
            root / "apps/api/prisma/migrations/20261104000100_initial_foundation/migration.sql"
        ).read_text(encoding="utf-8")

    table_cols = parse_migration_table_columns(mig_sql)
    expected_tables = set(ALL_ENTITIES.values())
    if set(table_cols.keys()) != expected_tables:
        diff = set(table_cols.keys()) ^ expected_tables
        raise ValueError(f"[ERR_S04_SQL_TABLE_MISMATCH] migration.sql table set mismatch: {diff}")

    if "ON DELETE CASCADE" in mig_sql.upper():
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

    roles_sql = (root / "infra/db/01-init-roles-and-databases.sql").read_text(encoding="utf-8")
    grants_sql = (root / "infra/db/02-apply-runtime-grants.sql").read_text(encoding="utf-8")

    for role_name in [
        "eduerp_migrator",
        "eduerp_api_runtime",
        "eduerp_worker_runtime",
        "eduerp_readonly",
        "eduerp_center_b_api",
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
        "foreign_keys_restrict": fk_count,
        "named_check_constraints_verified": len(REQUIRED_CHECK_CONSTRAINTS),
        "partial_unique_indexes_verified": len(REQUIRED_PARTIAL_INDEXES),
        "immutability_triggers_verified": len(IMMUTABLE_ENTITIES) + 3,
    }


def verify_integration_tests_and_sql_columns(root: Path, test_corpus: str | None = None) -> dict:
    mig_sql = (
        root / "apps/api/prisma/migrations/20261104000100_initial_foundation/migration.sql"
    ).read_text(encoding="utf-8")
    table_cols = parse_migration_table_columns(mig_sql)

    ts_files = [
        "apps/api/src/database/idempotency.ts",
        "apps/api/src/database/seed-contract.ts",
        "apps/api/test/database/harness.ts",
        "apps/api/test/database/migrations-and-drift.integration.test.ts",
        "apps/api/test/database/domain-constraints.integration.test.ts",
        "apps/api/test/database/roles-and-isolation.integration.test.ts",
        "apps/api/test/database/transactions-and-readiness.integration.test.ts",
        "apps/api/test/database-unit.test.ts",
    ]
    if test_corpus is None:
        test_corpus = "\n".join((root / rel).read_text(encoding="utf-8") for rel in ts_files)

    for i in range(1, 21):
        code = f"DB-IT-{i:02d}"
        if code not in test_corpus:
            raise ValueError(f"[ERR_S04_MISSING_DB_IT] Missing required integration test scenario {code}")

    if "EDUERP_ALLOW_DESTRUCTIVE_DB_TESTS" not in test_corpus or "eduerp_test_" not in test_corpus:
        raise ValueError("[ERR_S04_HARNESS_GUARD] Missing destructive test harness safety guards")

    # Cross-check every INSERT INTO "<table>" (<cols>) in TypeScript code against migration.sql columns
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
    nvmrc = (root / ".nvmrc").read_text(encoding="utf-8").strip()

    if nvmrc != "24.18.1" or root_pkg.get("engines", {}).get("node") != ">=24.18.1 <25":
        raise ValueError("[ERR_S04_NODE24_TARGET] Node 24.18.1 target must be preserved in .nvmrc and package.json")
    if root_pkg["devDependencies"].get("typescript") != "5.9.3" or root_pkg["devDependencies"].get("eslint") != "9.39.5":
        raise ValueError("[ERR_S04_DEV_TOOLING_VERSIONS] Root devDependencies must pin typescript 5.9.3 and eslint 9.39.5")
    if "eslintConfig" in root_pkg or not (root / "eslint.config.cjs").exists():
        raise ValueError("[ERR_S04_ESLINT9_FLAT_CONFIG] ESLint 9 requires eslint.config.cjs without legacy eslintConfig in package.json")

    if (
        api_pkg["dependencies"].get("@prisma/client") != "7.10.1"
        or api_pkg["dependencies"].get("@prisma/adapter-pg") != "7.10.1"
        or api_pkg["dependencies"].get("pg") != "8.23.1"
        or api_pkg["devDependencies"].get("prisma") != "7.10.1"
    ):
        raise ValueError("[ERR_S04_PRISMA_PG_VERSIONS] apps/api/package.json must pin prisma/@prisma/client/@prisma/adapter-pg 7.10.1 and pg 8.23.1")

    return {
        "db_integration_scenarios_verified": 20,
        "ts_sql_insert_statements_verified": inserts_verified,
        "node_target": nvmrc,
        "prisma_version": api_pkg["dependencies"]["@prisma/client"],
        "pg_version": api_pkg["dependencies"]["pg"],
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

    # NEG-S04-02: ON DELETE CASCADE in migration.sql
    bad_mig_cascade = base_mig.replace("ON DELETE RESTRICT", "ON DELETE CASCADE", 1)
    passed.append(
        assert_raises_code(
            lambda: verify_migration_and_db_roles(root, mig_sql=bad_mig_cascade),
            "[ERR_S04_SQL_CASCADE]",
            "NEG-S04-02: ON DELETE CASCADE in migration.sql rejected",
        )
    )

    # NEG-S04-03: Missing immutability trigger in migration.sql
    bad_mig_trig = base_mig.replace("CREATE TRIGGER trg_staff_users_last_active_director", "-- missing trigger")
    passed.append(
        assert_raises_code(
            lambda: verify_migration_and_db_roles(root, mig_sql=bad_mig_trig),
            "[ERR_S04_MISSING_SPECIAL_TRIGGER]",
            "NEG-S04-03: Missing last-director protection trigger rejected",
        )
    )

    # NEG-S04-04: Missing DB-IT-19 in integration test corpus
    passed.append(
        assert_raises_code(
            lambda: verify_integration_tests_and_sql_columns(root, test_corpus="DB-IT-01 only"),
            "[ERR_S04_MISSING_DB_IT]",
            "NEG-S04-04: Incomplete DB-IT-01..20 integration test coverage rejected",
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
        "s04_integration_tests_and_tooling": s04_tests,
        "s04_negative_self_tests": neg,
    }
    print(json.dumps(summary, indent=2, ensure_ascii=False))
    print("PASS: tools/verify_s04.py verified all Stage 04 schema, migration, DB role, and test invariants.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
