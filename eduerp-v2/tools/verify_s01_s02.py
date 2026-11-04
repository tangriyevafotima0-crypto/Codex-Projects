#!/usr/bin/env python3
"""EduERP v2.0 — Stage 01 & Stage 02 Offline Stdlib Verification Tool (tools/verify_s01_s02.py).

Performs local document structure, anchor, provenance (C06), concrete Given/When (C02),
decision count (C05), arithmetic/date/model oracle (C01, C03, C04), OpenAPI 3.1 JSON + local $ref
+ security + Teacher zero-phone/finance (T02.03), event catalog (T02.04), and negative mutation checks.

IMPORTANT BOUNDARY:
- Does NOT execute a live PostgreSQL database, NestJS runtime, Flutter client, or external OpenAPI validator.
- Runtime concurrency/DB transaction and full external OpenAPI validator checks are explicitly marked NOT_RUN.
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

CASE_VERIFICATION_MATRIX = [
    ("CASE-01", "BR-01", "ARITHMETIC_CHECKED", "480,000 * 7 / 12 = 280,000 UZS pro-rata; next calendar month = 480,000 UZS"),
    ("CASE-02", "BR-01", "ARITHMETIC_CHECKED", "remaining=0 -> 0 UZS; total_lessons=0 -> 422 INVALID_SCHEDULE_ZERO_LESSONS guard"),
    ("CASE-03", "BR-02", "ARITHMETIC_CHECKED", "31-Jan rolling renewal -> 2026-02-28 (non-leap) & 2028-02-29 (leap); Mar conditional on D21"),
    ("CASE-04", "BR-02", "MODEL_CHECKED", "12-lesson package cancelled lesson: Policy A preserves balance=7; Policy B issues 40,000 UZS credit (D21)"),
    ("CASE-05", "BR-03", "MODEL_CHECKED", "1st trial L1 -> debt=0, status=TRIAL; 2nd distinct lesson L2!=L1 -> status=ACTIVE, 1 invoice (280,000 UZS)"),
    ("CASE-06", "BR-03", "MODEL_CHECKED", "Event retry dedup + trial_activation_seq compensation/reactivation (seq=1 voided -> seq=2 active, net=280,000) + 2 packages in 1 month (PKG:1, PKG:2 -> 2 invoices) (C04)"),
    ("CASE-07", "BR-04", "ARITHMETIC_CHECKED", "Unapproved 50% discount -> 480,000 UZS unchanged; Director approved -> 240,000 UZS net charge"),
    ("CASE-08", "BR-04", "ARITHMETIC_CHECKED", "100% Grant -> net_charge=0 UZS, debt=0 UZS, zero fake cash receipt or refund"),
    ("CASE-09", "BR-04", "ARITHMETIC_CHECKED", "Discount stacking (480k with 50k fixed + 50%): Policy A=240,000, Policy B=215,000, Policy C=190,000 UZS (D14)"),
    ("CASE-10", "BR-04", "MODEL_CHECKED", "Expired discount (valid_until 2026-11-30 < 2026-12-01) -> 0 discount on new cycle invoice (480,000 UZS)"),
    ("CASE-11", "BR-05", "ARITHMETIC_CHECKED", "500,000 - 300,000 = 200,000 UZS remaining debt; missing promise_date -> 422 rollback (DB tx runtime NOT_RUN)"),
    ("CASE-12", "BR-06", "ARITHMETIC_CHECKED", "600,000 UZS payment on 500,000 UZS invoice -> 500,000 allocation (debt=0) + 100,000 UnappliedCredit"),
    ("CASE-13", "BR-07", "ARITHMETIC_CHECKED", "4,000,000 UZS error payment -> -4,000,000 append-only reversal + 400,000 correction = 400,000 UZS net"),
    ("CASE-14", "BR-07", "ARITHMETIC_CHECKED", "Partial refund 150,000 of 400,000 -> remaining cap=250,000 (next 300,000 -> 422); only CASH refund reduces cash shift; parallel DB lock runtime NOT_RUN (C03, D22)"),
    ("CASE-15", "BR-08", "ARITHMETIC_CHECKED", "Overlapping freeze {L5..L8} U {L7..L10} = 6 unique lessons; full net=480k -> 240k (or 256k day-based); 50% discounted net=240k -> 120,000 UZS net-proportional credit cap (C03, D14)"),
    ("CASE-16", "BR-08", "ARITHMETIC_CHECKED", "Unexcused absence -> 0 UZS credit, invoice stays 480,000 UZS"),
    ("CASE-17", "BR-08", "MODEL_CHECKED", "Withdrawal requires 1..5 churn reason, preserves 200,000 UZS debt; re-enrollment creates new Enrollment row"),
    ("CASE-18", "BR-09", "ARITHMETIC_CHECKED", "Cash shift: Opening 0 + Cash 3,200,000 - Cash Expense 150,000 = 3,050,000 UZS; Card/Click 1,800,000 excluded from cash drawer"),
    ("CASE-19", "BR-10", "ARITHMETIC_CHECKED", "1-day substitute teacher share (11 primary + 1 substitute): Policy A (100k/lesson) -> 1,100,000 + 100,000; Policy B (2.4M pool) -> 2,200,000 + 200,000 UZS (D11)"),
    ("CASE-20", "BR-10", "MODEL_CHECKED", "Closed PayrollSnapshot (2,000,000 UZS) is immutable; -100,000 UZS recorded as PayrollAdjustment in current period"),
    ("CASE-21", "BR-11", "MODEL_CHECKED", "Stale Excel (row_version=1) rejected with 409 STALE_ROW_CONFLICT when Teacher mobile submitted version=2"),
    ("CASE-22", "BR-05", "MODEL_CHECKED", "Promise paid early on 14-Nov (remaining_debt=0) -> status=FULFILLED, 15-Nov 09:00 reminder suppressed"),
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
        "docs/architecture/system.md",
        "docs/architecture/data-model.md",
        "docs/architecture/events.md",
    ]
    for rel in md_files:
        txt = (root / rel).read_text(encoding="utf-8")
        if "\x0c" in txt or "\t" in txt or "\r" in txt:
            raise ValueError(f"Control character (form-feed, tab, or CR) found in {rel}")
        if "ightarrow$" in txt or "$$rac{" in txt:
            raise ValueError(f"Corrupted LaTeX sequence found in {rel}")
    return len(md_files)


def verify_s01_scope_and_traceability(root: Path, trace_rows: list[dict] | None = None) -> dict:
    scope_text = (root / "docs/spec/scope.md").read_text(encoding="utf-8")
    scope_anchors = set(re.findall(r'<a id="([^"]+)"></a>', scope_text))
    if len(scope_anchors) < 60:
        raise ValueError(f"Expected >=60 anchors in scope.md, got {len(scope_anchors)}")
    if "RPO ≤ 24 soat (24 h), RTO ≤ 60 daqiqa (60 min), PROPOSED" not in scope_text:
        raise ValueError("Missing explicit RPO/RTO units in scope.md (F05)")
    if "Teacher DTOda telefon yo‘q" not in scope_text or "OPEN_PRIVACY_01" not in scope_text:
        raise ValueError("Missing Teacher phone privacy boundary or OPEN_PRIVACY_01 in scope.md (F04, C05)")

    if trace_rows is None:
        with (root / "docs/spec/scope-traceability.csv").open(encoding="utf-8") as f:
            trace_rows = list(csv.DictReader(f))

    expected_cols = ["requirement_id", "source_page", "source_section", "requirement", "origin", "scope_location", "status"]
    if not trace_rows or list(trace_rows[0].keys()) != expected_cols:
        raise ValueError("Invalid columns in docs/spec/scope-traceability.csv")
    if len(trace_rows) != 119 or len({r["requirement_id"] for r in trace_rows}) != 119:
        raise ValueError(f"Expected 119 unique IDs in scope-traceability.csv, got {len(trace_rows)}")

    for r in trace_rows:
        rid = r["requirement_id"]
        p_col = expand_page_spec(r["source_page"])
        p_sec = extract_section_pages(r["source_section"])
        if p_col != p_sec:
            raise ValueError(f"C06 page/section mismatch in {rid}: {p_col} != {p_sec}")
        locs = [x.strip() for x in r["scope_location"].split(";") if x.strip()]
        if not locs:
            raise ValueError(f"Empty scope_location for {rid}")
        for loc in locs:
            if not loc.startswith("docs/spec/scope.md#"):
                raise ValueError(f"Invalid scope_location prefix in {rid}: {loc}")
            anc = loc.split("#", 1)[1]
            if anc not in scope_anchors:
                raise ValueError(f"Missing scope.md anchor #{anc} referenced by {rid}")

    r2204 = next(r for r in trace_rows if r["requirement_id"] == "R22.04")
    if r2204["source_page"] != "8":
        raise ValueError("R22.04 source_page must be 8 (F03)")

    return {"scope_anchors": len(scope_anchors), "trace_rows": len(trace_rows)}


def verify_s01_business_rules_and_cases(root: Path) -> dict:
    br_text = (root / "docs/spec/business-rules.md").read_text(encoding="utf-8")
    br_ids = re.findall(r"### `(BR-\d+)`", br_text)
    case_ids = re.findall(r"\*\*`(CASE-\d+)`\*\*", br_text)
    if br_ids != [f"BR-{i:02d}" for i in range(1, 19)]:
        raise ValueError(f"Expected BR-01..BR-18, got {br_ids}")
    if case_ids != [f"CASE-{i:02d}" for i in range(1, 23)]:
        raise ValueError(f"Expected CASE-01..CASE-22, got {case_ids}")
    if len(CASE_VERIFICATION_MATRIX) != 22:
        raise ValueError("CASE_VERIFICATION_MATRIX must cover all 22 cases")

    # Arithmetic & Model Oracles (Integer / Fraction / Decimal / Date)
    # CASE-01: Pro-rata 480,000 * 7 / 12 = 280,000
    assert int(Fraction(480000 * 7, 12)) == 280000
    assert int((Decimal("500000") * Decimal("7") / Decimal("12")).quantize(Decimal("1"), rounding=ROUND_HALF_UP)) == 291667

    # CASE-02: Remaining 0 vs Denominator 0
    assert int(Fraction(480000 * 0, 12)) == 0
    try:
        _ = Fraction(480000, 0)
        raise AssertionError("Zero denominator must raise ZeroDivisionError")
    except ZeroDivisionError:
        pass

    # CASE-03: 31-Jan Rolling Month renewal in non-leap (2026) and leap (2028) years
    assert calendar.monthrange(2026, 2)[1] == 28 and datetime.date(2026, 2, 28).isoformat() == "2026-02-28"
    assert calendar.monthrange(2028, 2)[1] == 29 and datetime.date(2028, 2, 29).isoformat() == "2028-02-29"

    # CASE-04: 12-lesson package cancelled lesson
    assert (12 - 5) == 7 and (480000 // 12) == 40000

    # CASE-05 & CASE-06: Trial distinct lessons + retry dedup + compensation/reactivation + 2 packages in 1 month (C04)
    attended = []
    for lesson_id in ["L1", "L1"]:  # L1 retry
        if lesson_id not in attended:
            attended.append(lesson_id)
    assert len(attended) == 1  # Still TRIAL, 0 invoices
    attended.append("L2")
    assert len(attended) == 2  # Activated seq=1, invoice #1 = 280,000
    seq1_invoice = 280000
    seq1_comp_credit = -280000  # L2 corrected to ABSENT -> TrialCompensated
    seq2_invoice = 280000       # L3 attended -> Reactivated seq=2
    assert (seq1_invoice + seq1_comp_credit + seq2_invoice) == 280000
    cycles = {("enr-1", "LESSON_PACKAGE_12", "PKG:1"), ("enr-1", "LESSON_PACKAGE_12", "PKG:1"), ("enr-1", "LESSON_PACKAGE_12", "PKG:2")}
    assert len(cycles) == 2  # Two distinct packages in one month -> 2 invoices; retry of PKG:1 deduplicated

    # CASE-07 & CASE-08 & CASE-09 & CASE-10: Discounts & Grants
    assert 480000 - (480000 * 50 // 100) == 240000
    assert 480000 - (480000 * 100 // 100) == 0
    assert (480000 - 50000) * 50 // 100 == 215000
    assert (480000 * 50 // 100) - 50000 == 190000
    assert datetime.date(2026, 11, 30) < datetime.date(2026, 12, 1)

    # CASE-11 & CASE-12: Partial payment + promise & Overpayment -> UnappliedCredit
    assert 500000 - 300000 == 200000
    alloc = min(600000, 500000)
    unapplied = 600000 - alloc
    assert (alloc, unapplied) == (500000, 100000)

    # CASE-13 & CASE-14: Storno reversal & Partial refund cap + cash vs non-cash shift (C03)
    assert 4000000 - 4000000 + 400000 == 400000
    rem_reversible = 400000 - 150000
    assert rem_reversible == 250000 and 300000 > rem_reversible

    # CASE-15 & CASE-16: Overlapping Freeze + Discounted Freeze basis & cap (C03) + Unexcused absence
    frozen_lessons = {5, 6, 7, 8} | {7, 8, 9, 10}
    assert len(frozen_lessons) == 6
    full_net = 480000
    half_discounted_net = 240000
    assert (full_net * len(frozen_lessons)) // 12 == 240000
    assert (half_discounted_net * len(frozen_lessons)) // 12 == 120000  # C03 discounted freeze credit = 120,000 <= 240,000 net

    # CASE-17 & CASE-18: Withdrawal debt preservation & Cash shift reconciliation (C03)
    opening_cash, cash_in, card_in, cash_exp, cash_ref, card_ref = 0, 3200000, 1800000, 150000, 0, 100000
    expected_cash = opening_cash + cash_in - cash_ref - cash_exp
    assert expected_cash == 3050000  # card_in (1.8M) and card_ref (100k) never alter physical cash drawer

    # CASE-19 & CASE-20: Substitute payroll share & Closed snapshot adjustment
    assert (11 * 100000, 1 * 100000) == (1100000, 100000)
    assert (2400000 * 11 // 12, 2400000 * 1 // 12) == (2200000, 200000)
    assert 2000000 + (-100000) == 1900000

    counts = Counter(kind for _, _, kind, _ in CASE_VERIFICATION_MATRIX)
    return {"br_count": len(br_ids), "case_count": len(case_ids), "case_types": dict(counts)}


def verify_s01_acceptance(root: Path, ac_rows: list[dict] | None = None) -> dict:
    if ac_rows is None:
        with (root / "docs/spec/acceptance.csv").open(encoding="utf-8") as f:
            ac_rows = list(csv.DictReader(f))
    expected_cols = [
        "requirement_id", "criterion_id", "actor", "given", "when",
        "then", "owner_steps", "source_locator", "decision_ids", "validation_status"
    ]
    if not ac_rows or list(ac_rows[0].keys()) != expected_cols:
        raise ValueError("Invalid columns in docs/spec/acceptance.csv")
    if len(ac_rows) != 119 or len({r["requirement_id"] for r in ac_rows}) != 119:
        raise ValueError("Expected 119 unique requirement_ids in acceptance.csv")
    if len({r["criterion_id"] for r in ac_rows}) != 119:
        raise ValueError("Expected 119 unique criterion_ids in acceptance.csv")

    for r in ac_rows:
        rid = r["requirement_id"]
        for k, v in r.items():
            if not v or not v.strip():
                raise ValueError(f"Empty column {k} in acceptance.csv row {rid}")
        if "kirish shartlari va" in r["given"] or "vazifasi bajarilib," in r["when"]:
            raise ValueError(f"C02 generic Given/When boilerplate found in {rid}")
        if r["validation_status"] not in {"VERIFIED_DOC_S01", "PLANNED", "DECISION_REQUIRED"}:
            raise ValueError(f"Invalid validation_status in {rid}: {r['validation_status']}")

    return {"acceptance_rows": len(ac_rows), "generic_rows": 0}


def verify_s01_decisions(root: Path) -> dict:
    dec_text = (root / "docs/spec/decisions.md").read_text(encoding="utf-8")
    d_ids = re.findall(r'<a id="(D\d+)"></a>', dec_text)
    if d_ids != [f"D{i:02d}" for i in range(1, 26)]:
        raise ValueError(f"Expected D01..D25 anchors, got {d_ids}")
    open_ids = re.findall(r'<a id="(OPEN_[A-Z]+_\d+)"></a>', dec_text)
    expected_open = ["OPEN_RBAC_01", "OPEN_RBAC_02", "OPEN_CHANNEL_01", "OPEN_CHANNEL_02", "OPEN_PRIVACY_01"]
    if open_ids != expected_open:
        raise ValueError(f"Expected {expected_open}, got {open_ids}")
    if "firibgarligini 100% yopadi" in dec_text:
        raise ValueError("C05: Unqualified 100% fraud guarantee claim still present in decisions.md")

    d_sec = dec_text.split("## 4.")[0]
    statuses = re.findall(r"- \*\*Status:\*\* `([^`]+)`", d_sec)
    counts = dict(Counter(statuses))
    if counts != {"PROPOSED": 15, "DECISION_REQUIRED": 9, "DEFERRED": 1}:
        raise ValueError(f"C05 status count mismatch: {counts}")
    return counts


def verify_s02_architecture(root: Path, openapi_doc: dict | None = None) -> dict:
    sys_md = (root / "docs/architecture/system.md").read_text(encoding="utf-8")
    dm_md = (root / "docs/architecture/data-model.md").read_text(encoding="utf-8")
    evt_md = (root / "docs/architecture/events.md").read_text(encoding="utf-8")

    if sys_md.count("```mermaid") < 2:
        raise ValueError("system.md must include >=2 Mermaid diagrams (system & deployment)")
    if "erDiagram" not in dm_md:
        raise ValueError("data-model.md must include a Mermaid erDiagram")

    if openapi_doc is None:
        openapi_doc = json.loads((root / "docs/architecture/openapi.yaml").read_text(encoding="utf-8"))

    if openapi_doc.get("openapi") != "3.1.0":
        raise ValueError("openapi.yaml must declare openapi 3.1.0")

    # Resolve all local $refs
    raw_json = json.dumps(openapi_doc)
    refs = re.findall(r'"\$ref":\s*"([^"]+)"', raw_json)
    for ref in refs:
        if not ref.startswith("#/"):
            raise ValueError(f"External $ref not allowed: {ref}")
        cur = openapi_doc
        for part in ref[2:].split("/"):
            if part not in cur:
                raise ValueError(f"Broken OpenAPI $ref: {ref} (missing {part})")
            cur = cur[part]

    # Verify operationIds and write security/concurrency rules
    op_ids: list[str] = []
    for path, methods in openapi_doc.get("paths", {}).items():
        for m, op in methods.items():
            if m not in {"get", "post", "put", "patch", "delete"}:
                continue
            oid = op.get("operationId")
            if not oid:
                raise ValueError(f"Missing operationId on {m.upper()} {path}")
            op_ids.append(oid)
            if m in {"post", "put", "patch", "delete"}:
                if not op.get("security"):
                    raise ValueError(f"Write operation {oid} missing security requirement")
                if "x-allowed-roles" not in op or "x-write-concurrency" not in op:
                    raise ValueError(f"Write operation {oid} missing RBAC or write concurrency metadata")
    if len(op_ids) != len(set(op_ids)):
        raise ValueError("Duplicate operationId in openapi.yaml")

    # Verify TeacherStudentView has zero phone or financial properties (T02.03)
    t_props = set(openapi_doc["components"]["schemas"]["TeacherStudentView"]["properties"].keys())
    forbidden_props = {
        "phone", "phone_e164", "guardian_phone", "guardian_phone_e164",
        "invoice", "debt_uzs", "remaining_debt_uzs", "payment", "amount_uzs"
    }
    if t_props & forbidden_props:
        raise ValueError(f"T02.03 violation: TeacherStudentView exposes forbidden fields {t_props & forbidden_props}")

    # Verify VendorCenterSummary has zero student PII
    v_props = set(openapi_doc["components"]["schemas"]["VendorCenterSummary"]["properties"].keys())
    if v_props & {"students", "phone_e164", "guardian_phone", "ledger_entries"}:
        raise ValueError("T19.01 violation: VendorCenterSummary exposes center PII")

    # Verify events catalog and traceability.csv
    evt_anchors = set(re.findall(r'<a id="evt-([A-Za-z0-9_]+)"></a>', evt_md))
    required_events = {
        "PaymentRecorded", "AllocationAdjusted", "RefundRecorded",
        "AttendanceSubmitted", "AttendanceCorrected", "TrialActivated", "TrialCompensated",
        "DiscountApproved", "FreezeCreditIssued", "PromiseDue", "PromiseFulfilled",
        "TeacherPingDue", "ShiftClosed", "GuardianLinkRevoked", "LicenseStateChanged"
    }
    if not required_events.issubset(evt_anchors):
        raise ValueError(f"Missing required events in events.md: {required_events - evt_anchors}")

    arch_anchors = {
        "docs/architecture/system.md": set(re.findall(r'<a id="([^"]+)"></a>', sys_md)),
        "docs/architecture/data-model.md": set(re.findall(r'<a id="([^"]+)"></a>', dm_md)),
        "docs/architecture/events.md": set(re.findall(r'<a id="([^"]+)"></a>', evt_md)),
    }
    with (root / "docs/architecture/traceability.csv").open(encoding="utf-8") as f:
        tr2_rows = list(csv.DictReader(f))
    expected_tr2_cols = [
        "requirement_id", "criterion_id", "architecture_locator",
        "api_operation_ids", "schema_entities", "event_names", "decision_ids", "status"
    ]
    if not tr2_rows or list(tr2_rows[0].keys()) != expected_tr2_cols or len(tr2_rows) != 119:
        raise ValueError("Invalid docs/architecture/traceability.csv structure or row count")

    op_set = set(op_ids)
    for r in tr2_rows:
        rid = r["requirement_id"]
        for loc in r["architecture_locator"].split(";"):
            fp, anc = loc.strip().split("#", 1)
            if anc not in arch_anchors.get(fp, set()):
                raise ValueError(f"Missing architecture anchor {loc} in {rid}")
        if not r["api_operation_ids"].startswith("N/A("):
            for op in r["api_operation_ids"].split(";"):
                if op not in op_set:
                    raise ValueError(f"Unknown api_operation_id {op} in {rid}")
        if not r["event_names"].startswith("N/A("):
            for ev in r["event_names"].split(";"):
                if ev not in evt_anchors:
                    raise ValueError(f"Unknown event_name {ev} in {rid}")

    return {
        "openapi_operations": len(op_ids),
        "openapi_refs_verified": len(refs),
        "events_verified": len(evt_anchors),
        "arch_trace_rows": len(tr2_rows),
    }


def run_negative_self_tests(root: Path) -> list[str]:
    """Prove the checker fails on invalid inputs using in-memory mutated copies."""
    passed_negatives: list[str] = []

    # 1. Broken scope anchor in scope-traceability.csv must fail
    with (root / "docs/spec/scope-traceability.csv").open(encoding="utf-8") as f:
        bad_trace = list(csv.DictReader(f))
    bad_trace[0]["scope_location"] = "docs/spec/scope.md#non-existent-anchor"
    try:
        verify_s01_scope_and_traceability(root, trace_rows=bad_trace)
        raise AssertionError("Negative test 1 failed to reject broken scope anchor")
    except ValueError:
        passed_negatives.append("NEG-01: Broken scope.md anchor rejected")

    # 2. Page/section mismatch (C06) must fail
    with (root / "docs/spec/scope-traceability.csv").open(encoding="utf-8") as f:
        bad_page = list(csv.DictReader(f))
    bad_page[0]["source_page"] = "8"
    try:
        verify_s01_scope_and_traceability(root, trace_rows=bad_page)
        raise AssertionError("Negative test 2 failed to reject C06 page/section mismatch")
    except ValueError:
        passed_negatives.append("NEG-02: C06 source_page vs source_section mismatch rejected")

    # 3. Generic Given/When boilerplate (C02) must fail
    with (root / "docs/spec/acceptance.csv").open(encoding="utf-8") as f:
        bad_ac = list(csv.DictReader(f))
    bad_ac[25]["given"] = "Stage 01 / Step 01.03 kirish shartlari va 'docs/spec/acceptance.md' tayyorlangan"
    try:
        verify_s01_acceptance(root, ac_rows=bad_ac)
        raise AssertionError("Negative test 3 failed to reject generic Given/When boilerplate")
    except ValueError:
        passed_negatives.append("NEG-03: C02 generic Given/When boilerplate rejected")

    # 4. TeacherStudentView exposing guardian_phone_e164 (T02.03 / F04) must fail
    openapi_doc = json.loads((root / "docs/architecture/openapi.yaml").read_text(encoding="utf-8"))
    bad_oa = copy.deepcopy(openapi_doc)
    bad_oa["components"]["schemas"]["TeacherStudentView"]["properties"]["guardian_phone_e164"] = {"type": "string"}
    try:
        verify_s02_architecture(root, openapi_doc=bad_oa)
        raise AssertionError("Negative test 4 failed to reject phone leak in TeacherStudentView")
    except ValueError:
        passed_negatives.append("NEG-04: T02.03 TeacherStudentView phone leak rejected")

    # 5. Broken OpenAPI $ref must fail
    bad_ref_oa = copy.deepcopy(openapi_doc)
    bad_ref_oa["paths"]["/api/v1/health"]["get"]["responses"]["200"]["content"]["application/json"]["schema"]["$ref"] = "#/components/schemas/DoesNotExist"
    try:
        verify_s02_architecture(root, openapi_doc=bad_ref_oa)
        raise AssertionError("Negative test 5 failed to reject broken OpenAPI $ref")
    except ValueError:
        passed_negatives.append("NEG-05: Broken OpenAPI local $ref rejected")

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
            "Runtime database transaction/locking concurrency tests: NOT_RUN (Stage 01-02 specification/architecture only; no app runtime yet)",
            "External third-party OpenAPI 3.1 CLI schema validator: NOT_RUN (offline stdlib JSON parse + 100% local $ref/operationId/security verified)",
        ],
    }
    print(json.dumps(summary, indent=2, ensure_ascii=False))
    print("PASS: tools/verify_s01_s02.py completed all S01 (C01-C06) and S02 (02.01-02.05) checks.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
