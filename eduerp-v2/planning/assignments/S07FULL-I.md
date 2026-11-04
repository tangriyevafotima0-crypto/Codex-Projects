# S07FULL-I — kurslar, guruhlar, dars jadvali, o‘rindosh va baholar

TASK: **S07FULL-I**. Scope: **07.01–07.05**, shu paketdagi R1–R3 local hardening bilan. Executor Argon, manager Codex. Exact base va verified code revision: root TASK_INPUT.json. Output: IN_REVIEW. Bir stage ichida oraliq manager javobi kutilmaydi.

## Avval o‘qing va baseline’ni saqlang

START_HERE.txt va input manifest; AGENTS.md, MANAGER_WORKFLOW.md, ACTIVE_TASK.md, USER_WORKING_PREFERENCES.md, ARGON_LEARNING.md, OWNER_DECISIONS.md. `planning/state/reviews/S04-S06-H.md`, manager evidence, `docs/verification/H-manager.md`, S06 handoff. S07 stage/acceptance, data-model/system/events/OpenAPI va operation inventory, business-rules/decisions. Faqat kerakli source bo‘limlarni o‘qing, oldingi to‘g‘ri ishlarni qayta yaratmang.

Input manager tekshirgan poydevorni o‘z ichiga oladi: mustaqil config/tokens.ts, real Nest DI, global guard, actual Prisma/pg types, corrected student credit SELECT, role-bootstrap privilege ajratilishi, workspace-local Docker dependencies va DATE parser. Avvalgi H original source managerdan oldin ishlamagan; joriy paket uni almashtiradi. O‘sha xatolarni qayta “soddalashtirib” kiritmang.

S06 telefon almashtirishi credentiallarni revoke qiladi, `relink_required=true`, `single_use_invite_deeplink=null` qaytaradi. Haqiqiy invite issuance/validation S14da. Taxminiy bot username yoki saqlangan hashga mos bo‘lmagan tokenli havolani qaytarmang. DATE qiymatlari API poolda timezone-independent YYYY-MM-DD string, timestamp esa UTC instant.

Global execution/TRACKER/CURRENT/ACTIVE_TASK/APPROVALS, manager review/learning va OWNER_DECISIONS read-only. Individual eski promptdagi --sync bu offline paketga tatbiq etilmaydi. S08 billing, attendance/sync UI, Telegram live xabarlari va production deploy/migration scopega kirmaydi.

## R1–R3 — shu ish bilan birga yopiladigan kichik residuallar

**R1: shared limiter fail-closed.** AuthService shared rate table querysidagi barcha PG xatolarini in-memory fallback bilan yashiryapti. Faqat migration yo‘q deb taxmin qilmang. Store/permission/schema failureda safe503 va secret-free diagnostics; productionda local Map bilan distributed policy jim almashtirilmaydi. Test actual role privilege failure yoki dedicated unavailable store injection bilan; 401/429 uchun oddiy invalid credential oqimi o‘zgarmasin. Unknown username/IP flood va ikki instance regression saqlansin. Helper table bounded expiry/cleanup aniq, real customer retention policy deb talqin qilinmaydi.

**R2: explicit reuse intent va typed booleans.** Quick registration `sameGuardianName` bilan explicit guardian reuse tasdig‘ini chetlab o‘tishi mumkin; `Boolean('false')` ham true bo‘ladi. Existing guardian uchun aniq guardian_id yoki strict boolean reuse/confirmation talab qiling. Student duplicate warningni hard name-uniquega aylantirmang: sibling va bir xil ismli boshqa bolalar valid. Invalid boolean/string rad. Existing positive tests explicit reuse flag bilan moslashtiriladi; unauthorized automatic merge bo‘lmasin.

**R3: packaging va failure-mode evidence.** ZIPga __pycache__/*.pyc qo‘shmang. INSERT columns checker SELECT/projection va function privilege to‘g‘riligini tekshirmaydi: real PG tests saqlanadi. Commentdagi so‘z import deb topilmaydi; policy test static importni AST bilan ajratadi. H manager regressionlari va test typing tuzatishlari qaytarilmaydi.

## 07.01 — kurs, narx tarixi va guruh

`apps/api/src/academics/{academics.module,courses.controller,courses.service,groups.controller,groups.service,...}.ts`, DTO/repositorylar. Existing listCourses/createCourse/updateCoursePrice/createCourseGroup/listCourseGroups kontraktlarini implement qiling; update/archive zarur yo‘llari OpenAPI/inventoryga explicit qo‘shilsin. Current Director/Admin role grantlari source matrixga mos; Teacher write deny. Owner Admin faqat Teacher staff-create qarori academic boshqaruvni o‘zicha kengaytirmaydi.

- Course/group center_id server principal’dan; FK lineage va optimistic expected_version. Primary teacher faqat shu center’dagi ACTIVE TEACHER. Deactivated/other-center/non-teacher staff assignment rad.
- Narx UZS bigint/string, int64 bounds, negative rad; zero validity existing contract bo‘yicha. Price history append-only, old/new amount va effective calendar date, actor/reason/version. Old invoice/ledger/tariff snapshots UPDATE qilinmaydi. Future effective narx bugundan historical pricega aylanmasin; current vs as-of narx aniqlash yo‘li yozilsin.
- Base monthly fee/per-cycle mode parametrlarini saqlash billing engine emas. OWNER-20261104-02 center-configurable tartibni tasdiqladi: 12-avgust→12-sentabr yoki fixed due day misolida15-sentabr, advance collection ham alohida timing parametri. D03/D21 pul formulalari qisman ochiq; global business default o‘ylab topmang. Period boundary, due date va advance/arrearsni ajrating; misol due-dayni charge formulasi deb talqin qilmang. Maosh/payroll formula D11 bu scopega kirmaydi.
- Course/group archive soft; mavjud enrollment va dars tarixini cascade delete qilmaydi. Teacher deactivate bo‘lganda uning open scheduled lessons uchun warning/audit ko‘rinadi; darsni jim boshqa teacherga bermang, tarixiy snapshotlar o‘zgarmasin. Kerak bo‘lsa StaffService mutation bilan typed transactional hook/refactor; tashqi xabar yo‘q.
- Read/search/pagination consistent, archived default filter, fields role-safe. Existing safe roster DTOga raw guardian/student phone yoki financial summary qo‘shmang.

## 07.02 — lesson occurrence, timezone, bayram, ko‘chirish va bekor qilish

`lessons.service.ts` va protected controller/DTO. Existing `scheduleGroupLessonOccurrence` va `listGroupLessons`ga mos. Har dars stable UUID; bir kunda ikki dars occurrence_seq yoki actual starts_at orqali alohida identity. Group+date bir dars deb qabul qilinmaydi.

- Calendar day, local wall time va UTC instant alohida. Center IANA timezone explicit, server TZga bog‘liq emas; ISO offsetni taxmin qilmang. DATE parser manager fixi saqlansin. Invalid/local ambiguous yoki nonexistent DST time uchun aniq reject/disambiguation contract; default test center Asia/Tashkent, qo‘shimcha DST timezone regressiyasi. Yangi timezone library zarur bo‘lsa compatible exact dependency, offline lock qo‘lda emas.
- End>start, duration/window bounds, group ACTIVE, teacher valid va teacher/time conflicts uchun explicit invariant. Ikki parallel schedule call conflict detectionni chetlab o‘tmasin; DB constraint yoki serialized transaction. Batch/recurring generator bo‘lsa deterministic idempotent, public holiday input explicit; tashqi taqvim/API ixtiro qilinmaydi. Holiday sabab cancel/skip sababi va manbasi qayd etiladi.
- Reschedule eski lesson IDni saqlash yoki `rescheduled_from` aniq replacement relation bilan, hujjatdagi bitta usul izchil. Old attendance/grade/audit/pay snapshot orphan bo‘lmaydi. Cross-center/self/cycle replacement rad. O‘tgan/completed darsni ko‘chirish policy noaniq bo‘lsa fail-closed, history rewrite emas.
- Cancelled lesson yangi ping/trial conversion/billing jobni noto‘g‘ri qo‘zg‘atmaydi. S13/S08 worker hali yozilmagan bo‘lsa status/event/contract predicate va executable fixture ko‘rsating; “Telegram yuborildi” yoki “invoice qayta hisoblandi” demang.
- Mutation+audit+zarur canonical outbox effect bitta ACID tx; fault hammasini rollback. Bir xil idempotency+intent replay, changed payload409. New event kerak bo‘lsa schema/catalog/dedup/version/traceabilityga izchil qo‘shilsin; count saqlash uchun noto‘g‘ri existing event ishlatmang.

## 07.03 — aynan bitta lesson uchun substitute

`substitutions.service.ts` + controller, existing `assignSingleLessonSubstitute`. Bir active assignment bir lesson, original/replacement teacher va approved actor, assigned/revoked timestamp/reason/version, pay_recipient_teacher snapshot.

- Current center’dagi ACTIVE TEACHER, o‘zini almashtirish/other-center/invalid state rad. Concurrent assignmentsda bitta winner yoki izchil replace policy; double active row DBda rad.
- Temporary entitlement aynan assigned lesson/enrollments bilan. Group roster legacy day rule boshqa lessonlar yoki butun tarixga ruxsat bermaydi. Teacher bir kunda ikki lesson’dan faqat bittasiga substitute bo‘lsa ikkinchisiga write/read orqali kirishi rad. Revoked assignment offline yuborilgan grade/kelajak attendance commandini qayta authorize qiladi; cached JWT role claim yetmaydi.
- Primary teacher va pay recipient farqi actual lesson snapshotda. Payroll amount hisoblamang. Completed lesson uchun historical recipientni o‘zboshimcha o‘zgartirmang. Assignment/revoke va lesson pay snapshot/audit atomic; race’da privilege stale bo‘lib qolmasin. Shared authorization resolverni roster/lesson/gradesga ulang, nusxa policies tarqalmasin.
- Teacher deactivate/role change’dan keyin eski session/assignment bilan command rad; S05 revoke behavior saqlanadi. Group teacher change historical dars snapshotini buzmasin.

## 07.04 — imtihon/grade va revision tarixi

`grades.service.ts`, controller/DTO, existing submitLessonGrades; authorized read/history route zarur bo‘lsa explicit kontrakt. Source schema’dagi score/max_score yoki existing OpenAPI rangega mos; yangi grading policy yoki salary formula o‘ylab topmang.

- Teacher faqat current principal va authorized lesson/enrollmentga baho qo‘yadi. Enrollment.student_id/group_id, lesson.group_id va center lineage DB va service’da mos. Subject other-group/student ID tampering va active substitute scope regressiyasi.
- Batch hammasi valid bo‘lsa commit yoki aniq per-item contract; silent partial success yo‘q. Same request idempotent, stale expected_version409. Concurrent update bitta winner, old score/comment revisioni saqlanadi.
- GradeEntry mutable bo‘lsa history canonical append-only AuditLogda old/new values+version bilan yoki asoslangan append-only revision table’da; oddiy row overwrite tarix emas. Kerakli migration/index/ACL va actual revision retrieval testi. Canonical46+qo‘shimcha helper/revision jadval farqini ADRda yozing.
- Score numeric type/range/finite checks, duplicate same enrollment/exam identity, comment length/control chars. Comment plain text; API JSON va frontend render-text contract, HTML execution yoki raw HTML endpoint yo‘q. `<script>`/event-handler input UI’da bajarilmaydi degan da’vo frontend hali yo‘q bo‘lsa faqat server/plaintext boundary sifatida yozilsin.
- Actor/teacher snapshot hamda reason/request ID audit. Phone/hash/token raw logga chiqmaydi. Read/history qidiruv/cursor teacher vakolatini chetlab o‘tmasin.

## 07.05 — executable gate va handoff

`apps/api/test/academics/*.integration.test.ts`, alohida `test:academics`, existing real Nest+PG harness. Static substring/label count product acceptance emas. Majburiy failure-mode matrix:

1. Director/Admin permitted course/group actions, Teacher denied writes; center/role/status/input tampering.
2. Price effective dates va bigint bounds; update’dan keyin previous invoice/history unchanged; append-only history UPDATE/DELETE denied.
3. Teacher deactivate open-lesson warnings; historical teacher/pay snapshot unchanged.
4. Same day two lesson IDs valid; collision/parallel schedule, bad duration/date/timezone, explicit holiday/cancel.
5. UTC vs Asia/Tashkent process TZ’da bir xil calendar dates; DST ambiguous/nonexistent rejection; old server-timezone bug qaytmasin.
6. Reschedule stable relation, forbidden cycles/cross-center, existing grade/attendance linkage preserved; cancellation stops eligible future event fixture.
7. One-lesson substitute allowed; same-group other lesson denied; past/future/revoked entitlement va one-day roster boundary.
8. Concurrent assignment/revoke/grade authorization; atomic pay-recipient snapshot and rollback on injected fault.
9. Grade range/comment/duplicate/version/lineage; idempotency replay/mismatch; immutable revision history.
10. Search/pagination/history/error fieldsda Teacher raw phone/financial data leak yo‘q; public bootstrap va default-deny route inventory regressiya qilmaydi.
11. R1 store failure503 and multi-instance rate limit; R2 explicit strict reuse intent/siblings; prior26 unit/runtime+G1/G2/G3 suites saqlansin.

Acceptance CI strict: npm ci→Prisma generate→lint/typecheck/build/unit→DB/auth/students/academics suites→real Docker migrator/API/worker smoke. `infra/ci/eduerp-ci.yml` template update; manager repo-root copy qiladi. Default env aliases, source asset paths, workspace-local node_modules va privileged bootstrap boundary yana buzilmasin. No continue-on-error/bypass. Test fixture mustaqil, bir case yiqilishi keyingi case versionini soxta buzmasin. Fault injection test-only dependency/config orqali, production request fieldni security bypassga aylantirmang.

Offline bo‘lsa barcha code/test/CI tayyor, actual NOT_RUN va aniq sabab. Node24.18.1/npm11/Prisma7.10.1/TS5.9.3 saqlanadi. Dependency qo‘shilsa online haqiqiy lock; offline fake lock/client emas. Generated output repoga/ZIPga kirmaydi.

Docs: `docs/verification/S07.md`, `docs/architecture/adr/ADR-007-academics-and-lesson-entitlements.md`, relevant API/schema/event/RBAC/operation inventory, `planning/state/steps/07.01..07.05.md`, handoffs/S07.md. Status IN_REVIEW. Policy-gated future integrations, actual commands/results, schema impact va S08 prerequisitesni aniq yozing. Manager review/APPROVEDga taqlid qilmang.

## Output

Ruxsat: academics source/test/DTO/module, relevant auth/staff/roster authorization refactor, R1/R2 source/tests, alohida S07 additive migration/schema/index/ACL, meaningful checker updates, package/env/Docker/CI needed delta, yuqoridagi docs/step/handoff. Approved initial migrationsni yangi feature uchun rewrite qilmang. Student/guardian history va date/parser/core auth fixes saqlansin.

Bitta `S07FULL_I_SUBMISSION.zip`: faqat inputdan keyingi changed/new source + SUBMISSION.json. task_id/base_commit/candidate_input_commit/IN_REVIEW/files raw SHA256/deleted_paths/needs_manager_dependency_refresh/executed/not_run/policy gates. Root yoki eduerp-v2/ prefix izchil, no __pycache__/pyc/generated client/node_modules/dist/.git/real.env/dump. Chat yakuni qisqa. S08ni boshlamasdan to‘xtang.
