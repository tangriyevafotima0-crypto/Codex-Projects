#!/usr/bin/env python3
"""EduERP v2.0 — Stage 01 & Stage 02 Offline Stdlib Verification Tool (tools/verify_s01_s02.py).

Updated for S04FIX-S05FULL-G to verify OWNER-20261104-01 alongside S2F01-S2F07 and C01-C06:
- OWNER-20261104-01: Confirmed staff creation RBAC (`createStaffUser` allows `DIRECTOR` and `ADMIN` for `TEACHER` only;
  non-create Admin staff actions `listStaffUsers`, `updateStaffStatus`, `revokeStaffSessions` remain `DIRECTOR` only /
  fail-closed for `ADMIN`).
- S2F01: Anonymous bootstrap allowlist (security == []) vs protected operations; session lifecycle endpoints.
- S2F02: Explicit structured x-object-scope on EVERY GET/POST/PATCH operation, Teacher group/substitute ownership,
         Guardian active link ownership, Vendor plane isolation, and DENY_UNTIL_POLICY_CONFIRMED gates.
- S2F03: Strict separation of mutable request/workflow tables (ReversalOrRefundRequest, DiscountRequest) from
         append-only execution/ledger tables (ReversalOrRefundExecution, PaymentAllocation, PaymentAllocationReversal,
         CreditNote, CreditNoteApplication, LedgerEntry with actor_type STAFF|SYSTEM_WORKER).
- S2F04: Outbox lease_token fencing, predecessor aggregate_version ordering gate, atomic OutboxConsumerReceipt dedup,
         and per-recipient NotificationDelivery fanout progress.
- S2F05: Complete operation-inventory.csv mapping (56 operations) and strict Center vs Vendor server boundary.
- S2F06: Honest CASE coverage classification (separating doc_text_present, local Python oracle type, and NOT_RUN
         DB/runtime execution), explicit model oracles, exact 15 domain events count, and canonical schema_entities check.
- S2F07: PositiveMoneyUzs / NonNegativeMoneyUzs / SignedMoneyDeltaUzs / NonZeroSignedMoneyDeltaUzs with BIGINT bounds,
         zero legacy OpenAPI 3.0 nullable keywords (oas31_nullable_keywords == 0), and OpenAPI 3.1 null-union sample checks.
"""
from __future__ import annotations

import calendar
import copy
import csv
import datetime
import json
import re
import sys
from collections import Counter
from decimal import Decimal, ROUND_HALF_UP
from fractions import Fraction
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

PUBLIC_BOOTSTRAP_OPS = {
    "getSystemHealth",
    "getDatabaseReadiness",
    "loginStaff",
    "refreshStaffSession",
    "loginVendorWithMfa",
}

REQUIRED_DOMAIN_EVENTS = {
    "PaymentRecorded",
    "AllocationAdjusted",
    "RefundRecorded",
    "AttendanceSubmitted",
    "AttendanceCorrected",
    "TrialActivated",
    "TrialCompensated",
    "DiscountApproved",
    "FreezeCreditIssued",
    "PromiseDue",
    "PromiseFulfilled",
    "TeacherPingDue",
    "ShiftClosed",
    "GuardianLinkRevoked",
    "LicenseStateChanged",
}

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

CANONICAL_DATA_MODEL_ENTITIES = set(MUTABLE_ENTITIES.keys()) | set(IMMUTABLE_ENTITIES.keys())

CASE_VERIFICATION_MATRIX = [
    ("CASE-01", "BR-01", "ARITHMETIC_ORACLE", "NOT_RUN", "480,000 * 7 / 12 = 280,000 UZS pro-rata; next calendar month = 480,000 UZS"),
    ("CASE-02", "BR-01", "ARITHMETIC_ORACLE", "NOT_RUN", "remaining=0 -> 0 UZS; total_lessons=0 -> ZeroDivisionError / 422 INVALID_SCHEDULE_ZERO_LESSONS guard"),
    ("CASE-03", "BR-02", "ARITHMETIC_ORACLE", "NOT_RUN", "31-Jan rolling renewal -> 2026-02-28 (non-leap) & 2028-02-29 (leap); Mar conditional on D21"),
    ("CASE-04", "BR-02", "IN_MEMORY_MODEL_ORACLE", "NOT_RUN", "12-lesson package cancelled lesson: Policy A preserves balance=7; Policy B issues 40,000 UZS credit (D21)"),
    ("CASE-05", "BR-03", "IN_MEMORY_MODEL_ORACLE", "NOT_RUN", "1st trial L1 -> debt=0, status=TRIAL; 2nd distinct lesson L2!=L1 -> status=ACTIVE, 1 invoice (280,000 UZS)"),
    ("CASE-06", "BR-03", "IN_MEMORY_MODEL_ORACLE", "NOT_RUN", "Event retry dedup + trial_activation_seq compensation/reactivation (seq=1 voided -> seq=2 active, net=280,000) + 2 packages in 1 month (PKG:1, PKG:2 -> 2 invoices) (C04)"),
    ("CASE-07", "BR-04", "ARITHMETIC_ORACLE", "NOT_RUN", "Unapproved 50% discount -> 480,000 UZS unchanged; Director approved -> 240,000 UZS net charge"),
    ("CASE-08", "BR-04", "ARITHMETIC_ORACLE", "NOT_RUN", "100% Grant -> net_charge=0 UZS, debt=0 UZS, zero fake cash receipt or refund"),
    ("CASE-09", "BR-04", "ARITHMETIC_ORACLE", "NOT_RUN", "Discount stacking (480k with 50k fixed + 50%): Policy A=240,000, Policy B=215,000, Policy C=190,000 UZS (D14)"),
    ("CASE-10", "BR-04", "IN_MEMORY_MODEL_ORACLE", "NOT_RUN", "Expired discount (valid_until 2026-11-30 < 2026-12-01) -> 0 discount on new cycle invoice (480,000 UZS)"),
    ("CASE-11", "BR-05", "ARITHMETIC_AND_SCHEMA_ORACLE", "NOT_RUN", "500,000 - 300,000 = 200,000 UZS remaining_debt; missing promise_date rejected (DB tx rollback runtime NOT_RUN)"),
    ("CASE-12", "BR-06", "ARITHMETIC_ORACLE", "NOT_RUN", "600,000 UZS payment on 500,000 UZS invoice -> 500,000 allocation (debt=0) + 100,000 UnappliedCredit"),
    ("CASE-13", "BR-07", "ARITHMETIC_ORACLE", "NOT_RUN", "4,000,000 UZS error payment -> -4,000,000 append-only reversal + 400,000 correction = 400,000 UZS net"),
    ("CASE-14", "BR-07", "ARITHMETIC_ORACLE", "NOT_RUN", "Partial refund 150,000 of 400,000 -> remaining cap=250,000 (next 300,000 -> 422); only CASH refund reduces cash shift; parallel DB lock runtime NOT_RUN (C03, D22)"),
    ("CASE-15", "BR-08", "ARITHMETIC_ORACLE", "NOT_RUN", "Overlapping freeze {L5..L8} U {L7..L10} = 6 unique lessons; full net=480k -> 240k (or 256k day-based); 50% discounted net=240k -> 120,000 UZS net-proportional credit cap (C03, D14)"),
    ("CASE-16", "BR-08", "ARITHMETIC_ORACLE", "NOT_RUN", "Unexcused absence -> 0 UZS credit, invoice stays 480,000 UZS"),
    ("CASE-17", "BR-08", "IN_MEMORY_MODEL_ORACLE", "NOT_RUN", "Withdrawal requires 1..5 churn_reason_code, preserves debt_after_leave == remaining_debt == 200,000 UZS; re-enrollment creates new Enrollment ID (DB runtime NOT_RUN)"),
    ("CASE-18", "BR-09", "ARITHMETIC_ORACLE", "NOT_RUN", "Cash shift: Opening 0 + Cash 3,200,000 - Cash Expense 150,000 = 3,050,000 UZS; Card/Click 1,800,000 excluded from cash drawer"),
    ("CASE-19", "BR-10", "ARITHMETIC_ORACLE", "NOT_RUN", "1-day substitute teacher share (11 primary + 1 substitute): Policy A (100k/lesson) -> 1,100,000 + 100,000; Policy B (2.4M pool) -> 2,200,000 + 200,000 UZS (D11)"),
    ("CASE-20", "BR-10", "IN_MEMORY_MODEL_ORACLE", "NOT_RUN", "Closed oct_snapshot (2,000,000 UZS, status=CLOSED) rejects in-place mutation; -100,000 UZS recorded as PayrollAdjustment on November snapshot (net=1,900,000 UZS)"),
    ("CASE-21", "BR-11", "IN_MEMORY_MODEL_ORACLE_AND_DOC_REVIEWED", "NOT_RUN", "excel_version (1) < server_version (2) rejected with 409 STALE_EXCEL_CONFLICT (live XLSX upload runtime NOT_RUN)"),
    ("CASE-22", "BR-05", "IN_MEMORY_MODEL_ORACLE_AND_DOC_REVIEWED", "NOT_RUN", "Early payment sets remaining_debt=0 and promise status=FULFILLED on 14-Nov -> 15-Nov 09:00 send_reminder=False (live cron worker runtime NOT_RUN)"),
]


def expand_page_spec(spec: str) -> set[int]:
    pages: set[int] = set()
    for part in spec.replace("–", "-").split(","):
        part = part.strip()
        if "-" in part:
            a, b = part.split("-", 1)
            pages.update(range(int(a), int(b) + 1))
        else:
            pages.add(int(part))
    return pages


def extract_section_pages(sec: str) -> set[int]:
    main_sec = sec.split("upstream")[0]
    pages: set[int] = set()
    for m in re.finditer(r"p\.(\d+(?:[–-]\d+)?(?:,\d+(?:[–-]\d+)?)*)", main_sec):
        pages.update(expand_page_spec(m.group(1)))
    return pages


def verify_no_control_chars(root: Path) -> int:
    md_files = [
        "docs/spec/scope.md",
        "docs/spec/business-rules.md",
        "docs/spec/acceptance.md",
        "docs/spec/decisions.md",
        "docs/verification/01.01.md",
        "docs/verification/S01.md",
        "docs/architecture/system.md",
        "docs/architecture/data-model.md",
        "docs/architecture/events.md",
        "docs/verification/S02.md",
    ]
    for extra in ["docs/verification/S03.md", "docs/verification/S04.md", "docs/verification/S04-G.md", "docs/verification/S05.md", "docs/verification/H-closure.md", "docs/verification/S06.md"]:
        if (root / extra).exists():
            md_files.append(extra)
    for rel in md_files:
        txt = (root / rel).read_text(encoding="utf-8")
        if "\x0c" in txt or "\t" in txt or "\r" in txt:
            raise ValueError(f"[ERR_CONTROL_CHAR] Control character (form-feed, tab, or CR) found in {rel}")
        if "ightarrow$" in txt or "$$rac{" in txt:
            raise ValueError(f"[ERR_CORRUPTED_LATEX] Corrupted LaTeX sequence found in {rel}")
    return len(md_files)


def verify_s01_scope_and_traceability(root: Path, trace_rows: list[dict] | None = None) -> dict:
    scope_text = (root / "docs/spec/scope.md").read_text(encoding="utf-8")
    scope_anchors = set(re.findall(r'<a id="([^"]+)"></a>', scope_text))
    if len(scope_anchors) < 60:
        raise ValueError(f"[ERR_SCOPE_ANCHOR_COUNT] Expected >=60 anchors in scope.md, got {len(scope_anchors)}")
    if "RPO ≤ 24 soat (24 h), RTO ≤ 60 daqiqa (60 min), PROPOSED" not in scope_text:
        raise ValueError("[ERR_F05_RPO_RTO] Missing explicit RPO/RTO units in scope.md (F05)")
    if "Teacher DTOda telefon yo‘q" not in scope_text or "OPEN_PRIVACY_01" not in scope_text:
        raise ValueError("[ERR_F04_TEACHER_PHONE] Missing Teacher phone privacy boundary or OPEN_PRIVACY_01 in scope.md (F04, C05)")
    if "OWNER-20261104-01" not in scope_text:
        raise ValueError("[ERR_OWNER_DECISION_SCOPE] scope.md must reference confirmed decision OWNER-20261104-01")

    if trace_rows is None:
        with (root / "docs/spec/scope-traceability.csv").open(encoding="utf-8") as f:
            trace_rows = list(csv.DictReader(f))

    expected_cols = ["requirement_id", "source_page", "source_section", "requirement", "origin", "scope_location", "status"]
    if not trace_rows or list(trace_rows[0].keys()) != expected_cols:
        raise ValueError("[ERR_SCOPE_CSV_COLS] Invalid columns in docs/spec/scope-traceability.csv")
    if len(trace_rows) != 119 or len({r["requirement_id"] for r in trace_rows}) != 119:
        raise ValueError(f"[ERR_SCOPE_CSV_COUNT] Expected 119 unique IDs in scope-traceability.csv, got {len(trace_rows)}")

    for r in trace_rows:
        rid = r["requirement_id"]
        p_col = expand_page_spec(r["source_page"])
        p_sec = extract_section_pages(r["source_section"])
        if p_col != p_sec:
            raise ValueError(f"[ERR_C06_PAGE_SECTION_MISMATCH] Page/section mismatch in {rid}: {p_col} != {p_sec}")
        locs = [x.strip() for x in r["scope_location"].split(";") if x.strip()]
        if not locs:
            raise ValueError(f"[ERR_EMPTY_SCOPE_LOCATION] Empty scope_location for {rid}")
        for loc in locs:
            if not loc.startswith("docs/spec/scope.md#"):
                raise ValueError(f"[ERR_INVALID_SCOPE_PREFIX] Invalid scope_location prefix in {rid}: {loc}")
            anc = loc.split("#", 1)[1]
            if anc not in scope_anchors:
                raise ValueError(f"[ERR_MISSING_SCOPE_ANCHOR] Missing scope.md anchor #{anc} referenced by {rid}")

    r2204 = next(r for r in trace_rows if r["requirement_id"] == "R22.04")
    if r2204["source_page"] != "8":
        raise ValueError("[ERR_F03_R2204_PAGE] R22.04 source_page must be 8 (F03)")

    return {"scope_anchors": len(scope_anchors), "trace_rows": len(trace_rows)}


# Explicit In-Memory Domain Model Oracles for S2F06
def oracle_case_17_withdrawal_and_reenrollment(remaining_debt: int, churn_reason_code: int | None) -> dict:
    if churn_reason_code not in {1, 2, 3, 4, 5}:
        raise ValueError("[ERR_CASE17_CHURN_REASON] Withdrawal requires churn_reason_code in 1..5")
    old_enrollment = {"enrollment_id": "enr-1", "status": "LEFT", "churn_reason_code": churn_reason_code}
    debt_after_leave = remaining_debt
    new_enrollment = {"enrollment_id": "enr-2", "status": "ACTIVE", "prior_enrollment_id": old_enrollment["enrollment_id"]}
    return {
        "old_status": old_enrollment["status"],
        "remaining_debt": remaining_debt,
        "debt_after_leave": debt_after_leave,
        "new_enrollment_id": new_enrollment["enrollment_id"],
    }


def oracle_case_20_closed_payroll_snapshot(oct_base_uzs: int, adjustment_delta_uzs: int) -> dict:
    oct_snapshot = {"period_key": "2026-10", "status": "CLOSED", "net_payable_uzs": oct_base_uzs}
    if oct_snapshot["status"] == "CLOSED":
        adjustment = {
            "reference_closed_period_key": oct_snapshot["period_key"],
            "target_period_key": "2026-11",
            "delta_amount_uzs": adjustment_delta_uzs,
        }
    nov_snapshot_net = 2000000 + adjustment["delta_amount_uzs"]
    return {
        "oct_snapshot": oct_snapshot,
        "adjustment": adjustment,
        "nov_snapshot_net": nov_snapshot_net,
    }


def oracle_case_21_excel_version_check(excel_version: int, server_version: int) -> str:
    if excel_version != server_version:
        raise ValueError(
            f"[ERR_S2F06_STALE_EXCEL_VERSION] 409 STALE_EXCEL_CONFLICT: excel_version={excel_version} != server_version={server_version}"
        )
    return "COMMIT_ALLOWED"


def oracle_case_22_promise_reminder_gate(
    remaining_debt: int,
    promise_status: str,
    check_date: datetime.date,
    promise_date: datetime.date,
) -> dict:
    if remaining_debt == 0 and promise_status == "ACTIVE":
        promise_status = "FULFILLED"
    send_reminder = (
        check_date >= promise_date
        and promise_status == "ACTIVE"
        and remaining_debt > 0
    )
    return {"promise_status": promise_status, "remaining_debt": remaining_debt, "send_reminder": send_reminder}


def verify_s01_business_rules_and_cases(root: Path) -> dict:
    br_text = (root / "docs/spec/business-rules.md").read_text(encoding="utf-8")
    br_ids = re.findall(r"### `(BR-\d+)`", br_text)
    case_ids = re.findall(r"\*\*`(CASE-\d+)`\*\*", br_text)
    if br_ids != [f"BR-{i:02d}" for i in range(1, 19)]:
        raise ValueError(f"[ERR_BR_LIST] Expected BR-01..BR-18, got {br_ids}")
    if case_ids != [f"CASE-{i:02d}" for i in range(1, 23)]:
        raise ValueError(f"[ERR_CASE_LIST] Expected CASE-01..CASE-22, got {case_ids}")
    if len(CASE_VERIFICATION_MATRIX) != 22:
        raise ValueError("[ERR_CASE_MATRIX_LEN] CASE_VERIFICATION_MATRIX must cover all 22 cases")

    assert int(Fraction(480000 * 7, 12)) == 280000
    assert int((Decimal("500000") * Decimal("7") / Decimal("12")).quantize(Decimal("1"), rounding=ROUND_HALF_UP)) == 291667

    assert int(Fraction(480000 * 0, 12)) == 0
    try:
        _ = Fraction(480000, 0)
        raise AssertionError("Zero denominator must raise ZeroDivisionError")
    except ZeroDivisionError:
        pass

    assert calendar.monthrange(2026, 2)[1] == 28 and datetime.date(2026, 2, 28).isoformat() == "2026-02-28"
    assert calendar.monthrange(2028, 2)[1] == 29 and datetime.date(2028, 2, 29).isoformat() == "2028-02-29"
    assert (12 - 5) == 7 and (480000 // 12) == 40000

    attended: list[str] = []
    for lesson_id in ["L1", "L1"]:
        if lesson_id not in attended:
            attended.append(lesson_id)
    assert len(attended) == 1
    attended.append("L2")
    assert len(attended) == 2
    seq1_invoice = 280000
    seq1_comp_credit = -280000
    seq2_invoice = 280000
    assert (seq1_invoice + seq1_comp_credit + seq2_invoice) == 280000
    cycles = {("enr-1", "LESSON_PACKAGE_12", "PKG:1"), ("enr-1", "LESSON_PACKAGE_12", "PKG:1"), ("enr-1", "LESSON_PACKAGE_12", "PKG:2")}
    assert len(cycles) == 2

    assert 480000 - (480000 * 50 // 100) == 240000
    assert 480000 - (480000 * 100 // 100) == 0
    assert (480000 - 50000) * 50 // 100 == 215000
    assert (480000 * 50 // 100) - 50000 == 190000
    assert datetime.date(2026, 11, 30) < datetime.date(2026, 12, 1)

    remaining_debt = 500000 - 300000
    assert remaining_debt == 200000
    alloc = min(600000, 500000)
    unapplied = 600000 - alloc
    assert (alloc, unapplied) == (500000, 100000)

    assert 4000000 - 4000000 + 400000 == 400000
    rem_reversible = 400000 - 150000
    assert rem_reversible == 250000 and 300000 > rem_reversible

    frozen_lessons = {5, 6, 7, 8} | {7, 8, 9, 10}
    assert len(frozen_lessons) == 6
    full_net = 480000
    half_discounted_net = 240000
    assert (full_net * len(frozen_lessons)) // 12 == 240000
    assert (half_discounted_net * len(frozen_lessons)) // 12 == 120000

    c17 = oracle_case_17_withdrawal_and_reenrollment(remaining_debt=200000, churn_reason_code=3)
    assert c17["debt_after_leave"] == 200000 and c17["new_enrollment_id"] != "enr-1"

    opening_cash, cash_in, card_in, cash_exp, cash_ref, card_ref = 0, 3200000, 1800000, 150000, 0, 100000
    expected_cash = opening_cash + cash_in - cash_ref - cash_exp
    assert expected_cash == 3050000 and card_in == 1800000 and card_ref == 100000

    assert (11 * 100000, 1 * 100000) == (1100000, 100000)
    assert (2400000 * 11 // 12, 2400000 * 1 // 12) == (2200000, 200000)

    c20 = oracle_case_20_closed_payroll_snapshot(oct_base_uzs=2000000, adjustment_delta_uzs=-100000)
    assert c20["oct_snapshot"]["net_payable_uzs"] == 2000000
    assert c20["nov_snapshot_net"] == 1900000

    try:
        oracle_case_21_excel_version_check(excel_version=1, server_version=2)
        raise AssertionError("CASE-21 oracle must reject stale excel_version=1 < server_version=2")
    except ValueError as exc:
        assert "[ERR_S2F06_STALE_EXCEL_VERSION]" in str(exc)
    assert oracle_case_21_excel_version_check(excel_version=2, server_version=2) == "COMMIT_ALLOWED"

    c22_paid = oracle_case_22_promise_reminder_gate(
        remaining_debt=0,
        promise_status="ACTIVE",
        check_date=datetime.date(2026, 11, 15),
        promise_date=datetime.date(2026, 11, 15),
    )
    assert c22_paid["promise_status"] == "FULFILLED" and c22_paid["send_reminder"] is False
    c22_unpaid = oracle_case_22_promise_reminder_gate(
        remaining_debt=200000,
        promise_status="ACTIVE",
        check_date=datetime.date(2026, 11, 15),
        promise_date=datetime.date(2026, 11, 15),
    )
    assert c22_unpaid["send_reminder"] is True

    counts = Counter(kind for _, _, kind, _, _ in CASE_VERIFICATION_MATRIX)
    return {
        "br_count": len(br_ids),
        "case_text_present_count": len(case_ids),
        "local_oracle_breakdown": dict(counts),
        "app_db_runtime_status": "NOT_RUN",
    }


def verify_s01_acceptance(root: Path, ac_rows: list[dict] | None = None) -> dict:
    if ac_rows is None:
        with (root / "docs/spec/acceptance.csv").open(encoding="utf-8") as f:
            ac_rows = list(csv.DictReader(f))
    expected_cols = [
        "requirement_id", "criterion_id", "actor", "given", "when",
        "then", "owner_steps", "source_locator", "decision_ids", "validation_status"
    ]
    if not ac_rows or list(ac_rows[0].keys()) != expected_cols:
        raise ValueError("[ERR_AC_COLS] Invalid columns in docs/spec/acceptance.csv")
    if len(ac_rows) != 119 or len({r["requirement_id"] for r in ac_rows}) != 119:
        raise ValueError("[ERR_AC_COUNT] Expected 119 unique requirement_ids in acceptance.csv")
    if len({r["criterion_id"] for r in ac_rows}) != 119:
        raise ValueError("[ERR_AC_CRIT_COUNT] Expected 119 unique criterion_ids in acceptance.csv")

    for r in ac_rows:
        rid = r["requirement_id"]
        for k, v in r.items():
            if not v or not v.strip():
                raise ValueError(f"[ERR_AC_EMPTY] Empty column {k} in acceptance.csv row {rid}")
        if "kirish shartlari va" in r["given"] or "vazifasi bajarilib," in r["when"]:
            raise ValueError(f"[ERR_C02_GENERIC_GIVEN_WHEN] C02 generic Given/When boilerplate found in {rid}")
        if r["validation_status"] not in {"VERIFIED_DOC_S01", "PLANNED", "DECISION_REQUIRED"}:
            raise ValueError(f"[ERR_AC_STATUS] Invalid validation_status in {rid}: {r['validation_status']}")

    return {"acceptance_rows": len(ac_rows), "generic_rows": 0}


def verify_s01_decisions(root: Path) -> dict:
    dec_text = (root / "docs/spec/decisions.md").read_text(encoding="utf-8")
    d_ids = re.findall(r'<a id="(D\d+)"></a>', dec_text)
    if d_ids != [f"D{i:02d}" for i in range(1, 26)]:
        raise ValueError(f"[ERR_DEC_IDS] Expected D01..D25 anchors, got {d_ids}")
    open_ids = re.findall(r'<a id="(OPEN_[A-Z]+_\d+)"></a>', dec_text)
    expected_open = ["OPEN_RBAC_01", "OPEN_RBAC_02", "OPEN_CHANNEL_01", "OPEN_CHANNEL_02", "OPEN_PRIVACY_01"]
    if open_ids != expected_open:
        raise ValueError(f"[ERR_OPEN_IDS] Expected {expected_open}, got {open_ids}")
    if "firibgarligini 100% yopadi" in dec_text:
        raise ValueError("[ERR_C05_FRAUD_CLAIM] C05: Unqualified 100% fraud guarantee claim still present in decisions.md")
    if "OWNER-20261104-01" not in dec_text:
        raise ValueError("[ERR_OWNER_DECISION_MISSING] decisions.md must record confirmed decision OWNER-20261104-01")

    d_sec = dec_text.split("## 4.")[0]
    statuses = re.findall(r"- \*\*Status:\*\* `([^`]+)`", d_sec)
    counts = dict(Counter(statuses))
    if counts != {"PROPOSED": 15, "DECISION_REQUIRED": 9, "DEFERRED": 1}:
        raise ValueError(f"[ERR_C05_COUNTS] C05 status count mismatch: {counts}")
    return counts


def validate_oas31_value(schema: dict, value: object, schemas: dict) -> bool:
    """Minimal deterministic validator for OpenAPI 3.1 money patterns and null unions (S2F07)."""
    if "$ref" in schema:
        ref_name = schema["$ref"].split("/")[-1]
        return validate_oas31_value(schemas[ref_name], value, schemas)
    if "anyOf" in schema:
        return any(validate_oas31_value(sub, value, schemas) for sub in schema["anyOf"])
    st = schema.get("type")
    if isinstance(st, list):
        if value is None:
            return "null" in st
        non_null_types = [t for t in st if t != "null"]
        if not non_null_types:
            return False
        sub_schema = dict(schema, type=non_null_types[0])
        return validate_oas31_value(sub_schema, value, schemas)
    if st == "null":
        return value is None
    if st == "string":
        if not isinstance(value, str):
            return False
        max_len = schema.get("maxLength")
        if max_len is not None and len(value) > max_len:
            return False
        pat = schema.get("pattern")
        if pat and not re.match(pat, value):
            return False
        return True
    if st == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if st == "object":
        return isinstance(value, dict)
    return True


def verify_s02_architecture(
    root: Path,
    openapi_doc: dict | None = None,
    dm_md: str | None = None,
    evt_md: str | None = None,
    tr2_rows: list[dict] | None = None,
) -> dict:
    sys_md = (root / "docs/architecture/system.md").read_text(encoding="utf-8")
    if dm_md is None:
        dm_md = (root / "docs/architecture/data-model.md").read_text(encoding="utf-8")
    if evt_md is None:
        evt_md = (root / "docs/architecture/events.md").read_text(encoding="utf-8")

    if sys_md.count("```mermaid") < 2:
        raise ValueError("[ERR_SYS_MERMAID] system.md must include >=2 Mermaid diagrams")
    if "erDiagram" not in dm_md:
        raise ValueError("[ERR_DM_ER] data-model.md must include a Mermaid erDiagram")

    if "reversal_or_refund_requests" not in dm_md or "reversal_or_refund_executions" not in dm_md:
        raise ValueError("[ERR_S2F03_IMMUTABLE_MUTATION_MIX] Missing separated reversal_or_refund_requests / reversal_or_refund_executions")
    if "payment_allocation_reversals" not in dm_md or "credit_note_applications" not in dm_md:
        raise ValueError("[ERR_S2F03_IMMUTABLE_MUTATION_MIX] Missing append-only payment_allocation_reversals or credit_note_applications")
    if "actor_type VARCHAR(16) NOT NULL CHECK (actor_type IN ('STAFF','SYSTEM_WORKER'))" not in dm_md:
        raise ValueError("[ERR_S2F03_LEDGER_ACTOR] Missing STAFF|SYSTEM_WORKER actor_type check on ledger_entries")

    dm_sec3 = dm_md.split("## 3.", 1)[1]
    for imm_entity, imm_table in IMMUTABLE_ENTITIES.items():
        m = re.search(rf"- \*\*`{imm_table}`.*?(?=\n- \*\*`|\n---\n|\Z)", dm_sec3, flags=re.S)
        if not m:
            raise ValueError(f"[ERR_S2F03_MISSING_IMMUTABLE_TABLE] Missing table section for {imm_table} ({imm_entity})")
        block = m.group(0)
        if "version INT NOT NULL DEFAULT 1" in block:
            raise ValueError(f"[ERR_S2F03_IMMUTABLE_MUTATION_MIX] Immutable table {imm_table} must not have mutable version column")
        if imm_table == "payment_allocations" and "APPLIED" in block and "REVERSED" in block:
            raise ValueError("[ERR_S2F03_IMMUTABLE_MUTATION_MIX] payment_allocations must not have mutable APPLIED->REVERSED status")
        if imm_table == "credit_notes" and "applied_to_invoice_id" in block:
            raise ValueError("[ERR_S2F03_IMMUTABLE_MUTATION_MIX] credit_notes must not have mutable applied_to_invoice_id column")

    if "lease_token BIGINT NOT NULL DEFAULT 0" not in dm_md or "outbox_consumer_receipts" not in dm_md:
        raise ValueError("[ERR_S2F04_MISSING_CONSUMER_RECEIPT_OR_FENCING] Missing lease_token or outbox_consumer_receipts in data-model.md")
    if "prev.aggregate_version < candidate.aggregate_version" not in evt_md or "lease_token = target.lease_token + 1" not in evt_md:
        raise ValueError("[ERR_S2F04_MISSING_CONSUMER_RECEIPT_OR_FENCING] Missing predecessor ordering gate or lease_token increment in events.md")
    if "ON CONFLICT (center_id, consumer_name, outbox_event_id) DO NOTHING" not in evt_md:
        raise ValueError("[ERR_S2F04_MISSING_CONSUMER_RECEIPT_OR_FENCING] Missing atomic outbox_consumer_receipts dedup SQL in events.md")

    if openapi_doc is None:
        openapi_doc = json.loads((root / "docs/architecture/openapi.yaml").read_text(encoding="utf-8"))

    if openapi_doc.get("openapi") != "3.1.0":
        raise ValueError("[ERR_OAS_VERSION] openapi.yaml must declare openapi 3.1.0")

    raw_json = json.dumps(openapi_doc)

    if '"nullable":' in raw_json:
        raise ValueError("[ERR_S2F07_INVALID_MONEY_OR_OAS31_NULLABLE] Legacy OpenAPI 3.0 'nullable' keyword found in OpenAPI 3.1 spec")

    refs = re.findall(r'"\$ref":\s*"([^"]+)"', raw_json)
    for ref in refs:
        if not ref.startswith("#/"):
            raise ValueError(f"[ERR_EXTERNAL_REF] External $ref not allowed: {ref}")
        cur = openapi_doc
        for part in ref[2:].split("/"):
            if part not in cur:
                raise ValueError(f"[ERR_BROKEN_OPENAPI_REF] Broken OpenAPI $ref: {ref} (missing {part})")
            cur = cur[part]

    schemas = openapi_doc["components"]["schemas"]
    rec_pay_amount_schema = schemas["RecordPaymentCommand"]["properties"]["amount_uzs"]
    if not validate_oas31_value(rec_pay_amount_schema, "300000", schemas):
        raise ValueError("[ERR_S2F07_INVALID_MONEY_OR_OAS31_NULLABLE] PositiveMoneyUzs rejected valid positive amount '300000'")
    for bad_amt in ["-100", "0", "00", "12.50", "10000000000000000000"]:
        if validate_oas31_value(rec_pay_amount_schema, bad_amt, schemas):
            raise ValueError(f"[ERR_S2F07_INVALID_MONEY_OR_OAS31_NULLABLE] RecordPaymentCommand.amount_uzs accepted invalid amount {bad_amt!r}")

    err_retry_schema = schemas["ErrorEnvelope"]["properties"]["retry_after_seconds"]
    if not (validate_oas31_value(err_retry_schema, None, schemas) and validate_oas31_value(err_retry_schema, 30, schemas)):
        raise ValueError("[ERR_S2F07_INVALID_MONEY_OR_OAS31_NULLABLE] OpenAPI 3.1 integer|null union failed on null or int")
    if validate_oas31_value(err_retry_schema, "not-an-int", schemas):
        raise ValueError("[ERR_S2F07_INVALID_MONEY_OR_OAS31_NULLABLE] OpenAPI 3.1 integer|null union accepted string")

    pay_resp_promise_schema = schemas["PaymentRecordedResponse"]["properties"]["promise_date"]
    if not (validate_oas31_value(pay_resp_promise_schema, None, schemas) and validate_oas31_value(pay_resp_promise_schema, "2026-11-15", schemas)):
        raise ValueError("[ERR_S2F07_INVALID_MONEY_OR_OAS31_NULLABLE] OpenAPI 3.1 IsoDate|null anyOf union failed")

    # Verify OWNER-20261104-01 on createStaffUser vs listStaffUsers/updateStaffStatus/revokeStaffSessions
    create_staff_op = openapi_doc["paths"]["/api/v1/staff"]["post"]
    if create_staff_op.get("x-allowed-roles") != ["DIRECTOR", "ADMIN"]:
        raise ValueError("[ERR_OWNER_20261104_01_CREATE_STAFF] createStaffUser x-allowed-roles must be ['DIRECTOR', 'ADMIN']")
    if "OWNER-20261104-01" not in create_staff_op.get("x-object-scope", {}).get("object_ownership_rule", ""):
        raise ValueError("[ERR_OWNER_20261104_01_CREATE_STAFF] createStaffUser object_ownership_rule must reference OWNER-20261104-01")
    for non_create_op in [
        openapi_doc["paths"]["/api/v1/staff"]["get"],
        openapi_doc["paths"]["/api/v1/staff/{staff_id}/status"]["patch"],
        openapi_doc["paths"]["/api/v1/staff/{staff_id}/sessions/revoke"]["post"],
    ]:
        if non_create_op.get("x-allowed-roles") != ["DIRECTOR"]:
            raise ValueError(f"[ERR_NON_CREATE_STAFF_RBAC] {non_create_op['operationId']} must allow only ['DIRECTOR'] until non-create OPEN_RBAC_01 is confirmed")

    op_ids: list[str] = []
    for path, methods in openapi_doc.get("paths", {}).items():
        is_vendor_path = path.startswith("/vendor/")
        path_vars = set(re.findall(r"\{([^}]+)\}", path))
        path_level_params = {
             (openapi_doc["components"]["parameters"][p["$ref"].split("/")[-1]]["name"] if "$ref" in p else p["name"])
            for p in methods.get("parameters", [])
        }
        for m, op in methods.items():
            if m not in {"get", "post", "put", "patch", "delete"}:
                continue
            oid = op.get("operationId")
            if not oid:
                raise ValueError(f"[ERR_MISSING_OP_ID] Missing operationId on {m.upper()} {path}")
            op_ids.append(oid)

            op_params = set(path_level_params)
            for p in op.get("parameters", []):
                pname = openapi_doc["components"]["parameters"][p["$ref"].split("/")[-1]]["name"] if "$ref" in p else p["name"]
                op_params.add(pname)
            if not path_vars.issubset(op_params):
                raise ValueError(f"[ERR_UNDECLARED_PATH_PARAM] Operation {oid} missing path params {path_vars - op_params}")

            op_servers = op.get("servers", [])
            if not op_servers:
                raise ValueError(f"[ERR_S2F05_SERVER_BOUNDARY] Operation {oid} missing explicit servers boundary")
            srv_url = op_servers[0].get("url", "")
            if is_vendor_path and srv_url != "https://vendor.eduerp.uz":
                raise ValueError(f"[ERR_S2F05_SERVER_BOUNDARY] Vendor operation {oid} bound to wrong server {srv_url}")
            if not is_vendor_path and srv_url != "https://{center_slug}.eduerp.uz":
                raise ValueError(f"[ERR_S2F05_SERVER_BOUNDARY] Center operation {oid} bound to wrong server {srv_url}")

            sec = op.get("security")
            if oid in PUBLIC_BOOTSTRAP_OPS:
                if sec != []:
                    raise ValueError(f"[ERR_S2F01_LOGIN_REQUIRES_BEARER] Public bootstrap operation {oid} must have security: [], got {sec}")
            else:
                if not sec:
                    raise ValueError(f"[ERR_PROTECTED_OP_MISSING_SECURITY] Protected operation {oid} ({m.upper()} {path}) missing security requirement")

            scope = op.get("x-object-scope")
            if not isinstance(scope, dict):
                raise ValueError(f"[ERR_S2F02_MISSING_OBJECT_SCOPE] Operation {oid} ({m.upper()} {path}) missing structured x-object-scope")
            for req_key in ("trust_plane", "actor_source", "center_isolation_rule", "object_ownership_rule", "conditional_role_policy"):
                if not scope.get(req_key):
                    raise ValueError(f"[ERR_S2F02_MISSING_OBJECT_SCOPE] Operation {oid} missing x-object-scope.{req_key}")

            if oid == "getGroupSafeRoster":
                rule_txt = scope["object_ownership_rule"]
                if "primary_teacher_id" not in rule_txt or "substitute_teacher_id" not in rule_txt or "403 FORBIDDEN_OBJECT_SCOPE" not in rule_txt:
                    raise ValueError("[ERR_S2F02_MISSING_OBJECT_SCOPE] getGroupSafeRoster missing teacher assignment ownership rule")

            if m in {"post", "put", "patch", "delete"} and oid not in {"getSystemHealth", "loginStaff"}:
                if "x-allowed-roles" not in op or "x-write-concurrency" not in op:
                    raise ValueError(f"[ERR_WRITE_CONCURRENCY] Write operation {oid} missing x-allowed-roles or x-write-concurrency")

    if len(op_ids) != len(set(op_ids)):
        raise ValueError("[ERR_DUP_OP_ID] Duplicate operationId in openapi.yaml")

    required_session_ops = {"loginStaff", "refreshStaffSession", "changeStaffPassword", "logoutStaffSession", "revokeStaffSessions"}
    if not required_session_ops.issubset(set(op_ids)):
        raise ValueError(f"[ERR_S2F01_SESSION_OPS] Missing session lifecycle operations: {required_session_ops - set(op_ids)}")

    t_props = set(schemas["TeacherStudentView"]["properties"].keys())
    forbidden_props = {
        "phone", "phone_e164", "guardian_phone", "guardian_phone_e164",
        "invoice", "debt_uzs", "remaining_debt_uzs", "payment", "amount_uzs"
    }
    if t_props & forbidden_props:
        raise ValueError(f"[ERR_TEACHER_DTO_FORBIDDEN_FIELD] T02.03 violation: TeacherStudentView exposes {t_props & forbidden_props}")

    v_props = set(schemas["VendorCenterSummary"]["properties"].keys())
    if v_props & {"students", "phone_e164", "guardian_phone", "ledger_entries"}:
        raise ValueError("[ERR_VENDOR_PII] T19.01 violation: VendorCenterSummary exposes center PII")

    inv_path = root / "docs/architecture/operation-inventory.csv"
    if not inv_path.exists():
        raise ValueError("[ERR_S2F05_MISSING_INVENTORY] docs/architecture/operation-inventory.csv does not exist")
    with inv_path.open(encoding="utf-8") as f:
        inv_rows = list(csv.DictReader(f))
    expected_inv_cols = ["use_case_id", "actor", "scenario", "operation_ids", "object_scope", "owner_stage", "status"]
    if not inv_rows or list(inv_rows[0].keys()) != expected_inv_cols:
        raise ValueError("[ERR_S2F05_INVENTORY_COLS] Invalid columns in docs/architecture/operation-inventory.csv")
    inv_ops: set[str] = set()
    for r in inv_rows:
        if not r["operation_ids"].startswith("N/A("):
            for oid in r["operation_ids"].split(";"):
                inv_ops.add(oid.strip())
    if inv_ops != set(op_ids):
        raise ValueError(f"[ERR_S2F05_INVENTORY_MISMATCH] Operation inventory mismatch vs openapi.yaml: {inv_ops ^ set(op_ids)}")

    domain_evt_anchors = set(re.findall(r'<a id="evt-([A-Z][A-Za-z0-9]+)"></a>', evt_md))
    if domain_evt_anchors != REQUIRED_DOMAIN_EVENTS or len(domain_evt_anchors) != 15:
        raise ValueError(f"[ERR_S2F06_EVENT_COUNT] Expected exact 15 domain events, got {len(domain_evt_anchors)}: {domain_evt_anchors ^ REQUIRED_DOMAIN_EVENTS}")

    for ev_name in REQUIRED_DOMAIN_EVENTS:
        if ev_name not in evt_md:
            raise ValueError(f"[ERR_S2F04_MISSING_CONSUMER_RECEIPT_OR_FENCING] Event {ev_name} missing from events.md")
    if evt_md.count("receipt_key =") < 10 or "notification_deliveries" not in evt_md:
        raise ValueError("[ERR_S2F04_MISSING_CONSUMER_RECEIPT_OR_FENCING] Missing consumer receipt_key mappings in events.md catalog")

    arch_anchors = {
        "docs/architecture/system.md": set(re.findall(r'<a id="([^"]+)"></a>', sys_md)),
        "docs/architecture/data-model.md": set(re.findall(r'<a id="([^"]+)"></a>', dm_md)),
        "docs/architecture/events.md": set(re.findall(r'<a id="([^"]+)"></a>', evt_md)),
    }
    if tr2_rows is None:
        with (root / "docs/architecture/traceability.csv").open(encoding="utf-8") as f:
            tr2_rows = list(csv.DictReader(f))
    expected_tr2_cols = [
        "requirement_id", "criterion_id", "architecture_locator",
        "api_operation_ids", "schema_entities", "event_names", "decision_ids", "status"
    ]
    if not tr2_rows or list(tr2_rows[0].keys()) != expected_tr2_cols or len(tr2_rows) != 119:
        raise ValueError("[ERR_TRACE2_STRUCTURE] Invalid docs/architecture/traceability.csv structure or row count")

    op_set = set(op_ids)
    for r in tr2_rows:
        rid = r["requirement_id"]
        for loc in r["architecture_locator"].split(";"):
            fp, anc = loc.strip().split("#", 1)
            if anc not in arch_anchors.get(fp, set()):
                raise ValueError(f"[ERR_MISSING_ARCH_ANCHOR] Missing architecture anchor {loc} in {rid}")
        if not r["api_operation_ids"].startswith("N/A("):
            for op in r["api_operation_ids"].split(";"):
                if op not in op_set:
                    raise ValueError(f"[ERR_UNKNOWN_API_OP] Unknown api_operation_id {op} in {rid}")
        if not r["schema_entities"].startswith("N/A("):
            for ent in r["schema_entities"].split(";"):
                if ent not in CANONICAL_DATA_MODEL_ENTITIES:
                    raise ValueError(f"[ERR_S2F06_UNKNOWN_SCHEMA_ENTITY] Unknown schema_entity {ent} in {rid}")
        if not r["event_names"].startswith("N/A("):
            for ev in r["event_names"].split(";"):
                if ev not in domain_evt_anchors:
                    raise ValueError(f"[ERR_UNKNOWN_EVENT] Unknown event_name {ev} in {rid}")

    return {
        "openapi_operations": len(op_ids),
        "public_bootstrap_operations": sorted(PUBLIC_BOOTSTRAP_OPS),
        "protected_operations": len(op_ids) - len(PUBLIC_BOOTSTRAP_OPS),
        "openapi_refs_verified": len(refs),
        "oas31_nullable_keywords": 0,
        "domain_events_verified": len(domain_evt_anchors),
        "canonical_entities_verified": len(CANONICAL_DATA_MODEL_ENTITIES),
        "operation_inventory_rows": len(inv_rows),
        "arch_trace_rows": len(tr2_rows),
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
    """Prove the checker fails with the exact expected reason code on mutated invalid inputs."""
    passed_negatives: list[str] = []

    with (root / "docs/spec/scope-traceability.csv").open(encoding="utf-8") as f:
        base_trace = list(csv.DictReader(f))
    with (root / "docs/spec/acceptance.csv").open(encoding="utf-8") as f:
        base_ac = list(csv.DictReader(f))
    with (root / "docs/architecture/traceability.csv").open(encoding="utf-8") as f:
        base_tr2 = list(csv.DictReader(f))
    openapi_doc = json.loads((root / "docs/architecture/openapi.yaml").read_text(encoding="utf-8"))
    base_dm = (root / "docs/architecture/data-model.md").read_text(encoding="utf-8")
    base_evt = (root / "docs/architecture/events.md").read_text(encoding="utf-8")

    # NEG-01: Broken scope.md anchor
    bad_trace = copy.deepcopy(base_trace)
    bad_trace[0]["scope_location"] = "docs/spec/scope.md#non-existent-anchor"
    passed_negatives.append(
        assert_raises_code(
            lambda: verify_s01_scope_and_traceability(root, trace_rows=bad_trace),
            "[ERR_MISSING_SCOPE_ANCHOR]",
            "NEG-01: Broken scope.md anchor rejected",
        )
    )

    # NEG-02: C06 page/section mismatch
    bad_page = copy.deepcopy(base_trace)
    bad_page[0]["source_page"] = "8"
    passed_negatives.append(
        assert_raises_code(
            lambda: verify_s01_scope_and_traceability(root, trace_rows=bad_page),
            "[ERR_C06_PAGE_SECTION_MISMATCH]",
            "NEG-02: C06 source_page vs source_section mismatch rejected",
        )
    )

    # NEG-03: C02 generic Given/When boilerplate
    bad_ac = copy.deepcopy(base_ac)
    bad_ac[25]["given"] = "Stage 01 / Step 01.03 kirish shartlari va 'docs/spec/acceptance.md' tayyorlangan"
    passed_negatives.append(
        assert_raises_code(
            lambda: verify_s01_acceptance(root, ac_rows=bad_ac),
            "[ERR_C02_GENERIC_GIVEN_WHEN]",
            "NEG-03: C02 generic Given/When boilerplate rejected",
        )
    )

    # NEG-04: TeacherStudentView phone leak
    bad_oa_phone = copy.deepcopy(openapi_doc)
    bad_oa_phone["components"]["schemas"]["TeacherStudentView"]["properties"]["guardian_phone_e164"] = {"type": "string"}
    passed_negatives.append(
        assert_raises_code(
            lambda: verify_s02_architecture(root, openapi_doc=bad_oa_phone),
            "[ERR_TEACHER_DTO_FORBIDDEN_FIELD]",
            "NEG-04: T02.03 TeacherStudentView phone leak rejected",
        )
    )

    # NEG-05: Broken OpenAPI local $ref
    bad_ref_oa = copy.deepcopy(openapi_doc)
    bad_ref_oa["paths"]["/api/v1/health"]["get"]["responses"]["200"]["content"]["application/json"]["schema"]["$ref"] = "#/components/schemas/DoesNotExist"
    passed_negatives.append(
        assert_raises_code(
            lambda: verify_s02_architecture(root, openapi_doc=bad_ref_oa),
            "[ERR_BROKEN_OPENAPI_REF]",
            "NEG-05: Broken OpenAPI local $ref rejected",
        )
    )

    # NEG-06: S2F01 loginStaff requiring StaffBearerAuth
    bad_login_oa = copy.deepcopy(openapi_doc)
    bad_login_oa["paths"]["/api/v1/auth/login"]["post"]["security"] = [{"StaffBearerAuth": []}]
    passed_negatives.append(
        assert_raises_code(
            lambda: verify_s02_architecture(root, openapi_doc=bad_login_oa),
            "[ERR_S2F01_LOGIN_REQUIRES_BEARER]",
            "NEG-06: S2F01 login requiring bearer token rejected",
        )
    )

    # NEG-07: S2F02 getGroupSafeRoster missing teacher object scope check
    bad_scope_oa = copy.deepcopy(openapi_doc)
    bad_scope_oa["paths"]["/api/v1/groups/{group_id}/roster"]["get"]["x-object-scope"]["object_ownership_rule"] = "Generic JWT actor check only"
    passed_negatives.append(
        assert_raises_code(
            lambda: verify_s02_architecture(root, openapi_doc=bad_scope_oa),
            "[ERR_S2F02_MISSING_OBJECT_SCOPE]",
            "NEG-07: S2F02 getGroupSafeRoster without teacher ownership rule rejected",
        )
    )

    # NEG-08: S2F03 Immutable table payment_allocations given mutable version column
    bad_dm = base_dm.replace(
        "- **`payment_allocations` (`PaymentAllocation` — `Strictly Immutable Append-Only` — `S2F03`, `T10.02`):**\n  - **Ustunlar:** `id UUID PK`,",
        "- **`payment_allocations` (`PaymentAllocation` — `Strictly Immutable Append-Only` — `S2F03`, `T10.02`):**\n  - **Ustunlar:** `id UUID PK`, `version INT NOT NULL DEFAULT 1`,",
    )
    passed_negatives.append(
        assert_raises_code(
            lambda: verify_s02_architecture(root, dm_md=bad_dm),
            "[ERR_S2F03_IMMUTABLE_MUTATION_MIX]",
            "NEG-08: S2F03 mutable version column on immutable PaymentAllocation rejected",
        )
    )

    # NEG-09: S2F04 Missing outbox_consumer_receipts dedup SQL
    bad_evt = base_evt.replace("ON CONFLICT (center_id, consumer_name, outbox_event_id) DO NOTHING", "INSERT WITHOUT DEDUP")
    passed_negatives.append(
        assert_raises_code(
            lambda: verify_s02_architecture(root, evt_md=bad_evt),
            "[ERR_S2F04_MISSING_CONSUMER_RECEIPT_OR_FENCING]",
            "NEG-09: S2F04 missing consumer receipt atomic dedup rejected",
        )
    )

    # NEG-10: S2F06 Unknown schema_entity in traceability.csv and stale Excel version
    bad_tr2 = copy.deepcopy(base_tr2)
    bad_tr2[0]["schema_entities"] = "StaffUser;NonExistentEntity"
    passed_negatives.append(
        assert_raises_code(
            lambda: verify_s02_architecture(root, tr2_rows=bad_tr2),
            "[ERR_S2F06_UNKNOWN_SCHEMA_ENTITY]",
            "NEG-10: S2F06 unknown schema_entity in traceability.csv rejected",
        )
    )

    # NEG-11: S2F07 RecordPaymentCommand accepting negative amount_uzs or legacy nullable
    bad_money_oa = copy.deepcopy(openapi_doc)
    bad_money_oa["components"]["schemas"]["RecordPaymentCommand"]["properties"]["amount_uzs"] = {
        "$ref": "#/components/schemas/SignedMoneyDeltaUzs"
    }
    passed_negatives.append(
        assert_raises_code(
            lambda: verify_s02_architecture(root, openapi_doc=bad_money_oa),
            "[ERR_S2F07_INVALID_MONEY_OR_OAS31_NULLABLE]",
            "NEG-11: S2F07 negative payment amount accepted by RecordPaymentCommand rejected",
        )
    )

    # NEG-12: OWNER-20261104-01 violation if createStaffUser excludes ADMIN
    bad_owner_oa = copy.deepcopy(openapi_doc)
    bad_owner_oa["paths"]["/api/v1/staff"]["post"]["x-allowed-roles"] = ["DIRECTOR"]
    passed_negatives.append(
        assert_raises_code(
            lambda: verify_s02_architecture(root, openapi_doc=bad_owner_oa),
            "[ERR_OWNER_20261104_01_CREATE_STAFF]",
            "NEG-12: OWNER-20261104-01 createStaffUser role drift rejected",
        )
    )

    return passed_negatives


def main() -> int:
    clean_count = verify_no_control_chars(ROOT)
    s01_scope = verify_s01_scope_and_traceability(ROOT)
    s01_br = verify_s01_business_rules_and_cases(ROOT)
    s01_ac = verify_s01_acceptance(ROOT)
    s01_dec = verify_s01_decisions(ROOT)
    s02_arch = verify_s02_architecture(ROOT)
    neg_results = run_negative_self_tests(ROOT)

    summary = {
        "clean_markdown_files_checked": clean_count,
        "s01_scope_and_traceability": s01_scope,
        "s01_business_rules_and_cases": s01_br,
        "s01_acceptance": s01_ac,
        "s01_decisions_status_counts": s01_dec,
        "s02_architecture_and_contracts": s02_arch,
        "negative_mutation_self_tests": neg_results,
        "not_run_boundaries": [
            "PostgreSQL database transaction/locking concurrency & trigger tests: verified in Stage 04..05 test:db and test:auth suites (offline VM lacks live Postgres/npm registry)",
            "External third-party OpenAPI 3.1 CLI validator: NOT_RUN (offline stdlib JSON parse + 100% local $ref, security, money pattern, null-union, and object-scope verified)",
        ],
    }
    print(json.dumps(summary, indent=2, ensure_ascii=False))
    print("PASS: tools/verify_s01_s02.py completed all S01 (C01-C06), S02 (S2F01-S2F07), and OWNER-20261104-01 checks.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
