# S04S05FIX-S06FULL-H — auth/deploy correction va to‘liq student/guardian bazasi

Task ID: **S04S05FIX-S06FULL-H**. Scope: S04/S05 residual **G01–G07** + **06.01–06.05**. Executor Argon, reviewer Codex. Status faqat IN_REVIEW. Exact base/candidate composition: root TASK_INPUT.json.

## 0. Kirish va bajarish tartibi

Bu self-contained paket: approved main S03 + unapproved S04/S05 candidate + manager compile assists va haqiqiy refreshed lock. Oldingi ZIPlar kerak emas. Input manifest hashlarini tekshiring. `AGENTS.md`, `MANAGER_WORKFLOW.md`, `planning/state/ACTIVE_TASK.md`, USER_WORKING_PREFERENCES.md, ARGON_LEARNING.md, OWNER_DECISIONS.md, `planning/state/reviews/S04-S05-G.md` va evidence JSONni o‘qing. So‘ng S04/S05 code/tests/ADR, S06 stage va acceptance, business-rules/decisions, OpenAPI/data-model/eventsni ko‘ring.

Avval correctionlarni bajarib auth/deploy asosini tuzating; keyin S06ni shu asosga qo‘shing. Bir paket ichida oraliq manager javobini kutmang. Online muhit bo‘lsa G1 DB va G2 auth gate’ni yashil qilib, keyin G3 S06 testlarini bajaring. Offline bo‘lsa barcha code/test/CI candidate tayyorlanadi, runtime NOT_RUN; bu approval emas. S07 guruh/dars CRUD va attendance, S08 billing, bot transport yoki frontend boshlanmaydi.

Manager allaqachon quyidagini inputda tuzatgan: unused import/property, readonly bind-array pg boundary, root typecheckdan oldin contracts build, canonical BillingMode union export, actual npm lock refresh. Prisma generate, strict build va22 unit/process test shu holatda o‘tgan. Ularni qayta yozmang, ambient declarations/casts orqali strictnessni pasaytirmang. Muhim auth semantikasi hali tuzatilmagan.

Global planning registrlari managerga tegishli. Eski individual promptdagi execution.json/--sync ko‘rsatmasi bu offline paketga qo‘llanmaydi. S04/S05 CHANGES_REQUIRED; S06 candidate yozishga explicit ruxsat bor, self-approval yo‘q.

## 1. G01 — authentication credential va idempotency boundary

Actual reproducer: bir username va Idempotency-Key bilan valid login200, keyin WRONG password yuborilsa ham200 va aynan oldingi token. Generic client_operation_logs response JSON raw access/refresh/CSRF token saqlayapti.

- Login/refresh kabi auth secret javoblarini **generic persistent replay cache**da saqlamang. Har yangi login request credential va current staff holatini tekshiradi. Idempotency-Key credential yoki session o‘rnini bosmaydi.
- Login uchun authga mos retry contractni aniq tanlang: generic auth-response replayni olib tashlang. Header qolsa credential tekshiruvini chetlab o‘ta olmaydi. OpenAPI/checker/test va ADRni bu texnik correctionga moslang; eski header talabi saqlansin deb raw tokenni yashirin cachega qo‘ymang.
- Token material faqat kerakli session-store digestida; raw access/refresh/CSRF, password yoki unkeyed password-intent digest generic idempotency/audit/request/error loglarga kirmaydi. Session IDs token emas, metadata sifatida saqlanishi mumkin.
- Testlar: good→wrong password same key401; unknown/disabled/deactivated/revoked state cache orqali o‘tmaydi; logout/password change/role change’dan keyin old login key eski credentialsni qaytarmaydi. Actual DB JSON va logsni scan qilib raw token yo‘qligini assert qiling. Old test fixture’da saqlangan tokenlar real customer emas; production cleanup/destructive migration yozmang.

## 2. G02 — failed login transaction va shared rate limit

Actual: fresh wrong password500, failed_login_count0. Outer transaction staff rowni FOR UPDATE tutadi, keyin alohida connection shu rowni UPDATE qilishni kutadi; outer innerni kutib turadi.

- Failure outcome bitta izchil transaction ichida counter/lockout/audit bilan commit qilinadi; HTTP401/429 exception **commitdan keyin** hosil bo‘ladi. Outer lockni ushlab nested independent transaction ochmang. Retry’da counter ikki marta oshmasin.
- Unknown username va disabled account ham safe response bilan; allowed lockout response account enumerationni cheklaydigan hujjatli boundaryga ega bo‘lsin. Lock expiry clock-controlled.
- In-memory Mapni sole security limit sifatida ishlatmang. IP/center va account limitlari shared/persisted yoki mos distributed store orqali, bounded storage/expiry bilan. Username+IP pairingni cheksiz almashtirish bilan IP limit chetlab o‘tilmasin. Two API instance va restart testini qo‘shing. Texnik limiter helper table kerak bo‘lsa additive migration va ADR, canonical46dan alohida helper deb belgilang.
- Raw phone/password/token limiter key/logga tushmaydi. Proxy trust explicit hop/network konfiguratsiya bilan; arbitrary client X-Forwarded-For sole identity emas. Test: rejected login401 yoki429,500 emas; parallel failurelar exact count, successful login reset, expired lock, disabled/unknown, bounded username flood.

## 3. G03 — ishlaydigan migrator image va bir xil config nomlari

- API runner production dependencylar bilan minimal. Prisma CLI devDependency production prune’dan keyin yo‘q: Compose migrator shu runnerni ishlatmasin. Alohida Docker `migrator` target/tooling image kerak; CLI/config/schema/migrations mavjud, Node24+Prisma7 aligned. API containerga migrator URL/password berilmaydi.
- Compose `.env.example` va `loadApiEnv()` o‘qiydigan nomlar bitta canonical ro‘yxatdan tekshirilsin. Hozir ALLOWED_WEB_ORIGINS/REFRESH_SESSION_TTL_SECONDS/AUTH_LOCKOUT_THRESHOLD/AUTH_IP_RATE_LIMIT_* bilan source nomlari farq qiladi; typo bo‘lsa defaultga jim tushishni muhim fieldlarda aniqlang. Hash concurrency ham config bilan real bog‘langan bo‘lsin.
- Fresh volume: bootstrap roles→actual CLI deploy→runtime grants→API readiness; existing volume: keyingi additive migration ham deploy bo‘ladi. Migration scripts atomic (shu jumladan S05 additive SQL); faultdan keyin partial schema/history yo‘q. Role bootstrap har startda customer data reset qilmaydi.
- Qabul CI’da full Docker build, migrator exit0, real health/readiness, API runtime non-owner/non-superuser, worker alive va trusted-origin browser auth smoke. PostgreSQL16 va pinned Node image baseline saqlanadi. Manager localda Docker yo‘q bo‘lsa CI bajaradi; NOT_RUNni yashirmang.

## 4. G04–G07 — temporal scope, expiry, request identity va test sifati

- Teacher substitute roster vakolati center timezone/clockga mos effective **joriy dars kuni** bilan cheklanadi. O‘tmish/future ACTIVE assignment doimiy ruxsat bermaydi. Testlar past/today/future, UTC kun-chegarasi, revoked substitute va other teacher group403. DTOda phone/financial field yo‘q.
- Refresh family uchun absolute expiry: rotationda asl deadline uzaymaydi. Parallel refresh, old token replay family revoke, expiry, staff deactivate/role change’dan keyin deny. DBda bir familyga mansub sessionlar izchil.
- Non-auth idempotent mutation request identity barcha semantik maydonlarni qamrasin. CreateStaff’da ikki turli phone yoki initial password bir `has_phone=true` bo‘lib qolmasin. Maxfiy payloadga keyed fingerprint zarur bo‘lsa versiyalangan server secret bilan; raw yoki unkeyed password hash generic logda yo‘q. Same key+same intent replay, changed phone/role/password intent409; o‘sha key boshqa scope bilan collision qilmaydi.
- Production password helper synthetic seed module’ni import qilmasin. Dummy verify cost actual server policy bilan mos, bounded concurrency/memory/queue. Test seed hashni production dummy qilish yo‘q. Hashing queue full safe429/503, raw error500 emas. Parametrlar attacker tomonidan cheksiz oshirilmaydi.
- Barcha yangi registered endpointlar default deny: global auth guard yoki unga teng ro‘yxatga asoslangan, explicit public health/ready/login/refresh metadata. `@UseGuards`ni unutgan yangi controller ochiq qolmasin. Controller inventory vs policy coverage executable testi; role/object checklar service/data layer bilan birga.
- AUTH IT’dagi ikki failing assertionni expected500 qilib “tuzatmang”; actual401/429 semantikasi tuzatiladi. Acceptance CI’da continue-on-error, fake HTTP server, emitted-JS build bypass, distga qo‘lda migration copy yo‘q. Diagnostic MANAGER_G_SECURITY_PROBES.cjs reference, product test o‘rniga ko‘chirilmaydi.

## 5. S06.01 — student yaratish, tahrir, archive va qidiruv

Fayllar `apps/api/src/students/{students.module,students.controller,students.service,...}.ts` va DTO/repositorylar. Existing OpenAPI `listStudentsForAdmin`, `registerStudentQuick15s`, `getStudentProfileForStaff`ga moslang; missing update/archive route’ni explicit kontrakt bilan qo‘shing, yashirin transport yo‘q.

- Director/Admin, current valid staff/session/center va license mutation guard. Teacher list/full profile/write amallariga existing contract bo‘yicha403; Teacher safe roster alohida saqlanadi. Parent/Student web staff login yo‘q.
- Server center_idni principal’dan oladi; client center/role override rad. UUID identity, opaque unique student_code; ism unique emas. Bir xil ismli ikki shaxs valid. Unicode NFKC/lowercase/apostrophe normalizatsiyasi deterministik va raw full_name saqlanadi; ism normalize’ni identity sifatida ishlatmang.
- Quick registration student+explicit guardian relation+optional enrollmentni bitta txda yaratsin; idempotency same request→bitta effect, different intent→409, concurrent calls ham bitta. Guardian phone existing bo‘lsa odamlarni avtomatik merge qilmang: authorized explicit guardian_id/reuse intent yoki aniq conflict/selection response.
- `expected_version` bilan edit/archive. Archive soft; default list/searchda yashirin, authorized historyda saqlanadi. Ledger/invoice/enrollment history o‘chmaydi; archive qarzni nol qilmaydi. Qidiruv by UUID/code/name, phone faqat authorized staff uchun, pagination deterministic va center-scoped. Query wildcard/length/limit/cursor validation; SQL parametrlar bilan.
- “15s quick” typing/onboarding targetini backend unit timing bilan isbotlamang. Real endpoint response natijasi va measured server latency alohida; UI bu scopega kirmaydi.

## 6. S06.02 — guardian va telefon lifecycle

`guardians.service.ts` + kerakli protected controller/DTO. Guardian ko‘p child, child ko‘p guardian bilan bog‘lanadi; link center lineage va unique pairga rioya qiladi. Guardian phone canonical E.164; UZ local format qo‘llansa +998 qoidasi explicit va testlangan, ambiguous input rad; xalqaro raqamni taxmin bilan qayta yozmang. Telefon identity bo‘yicha siblinglar bloklanmaydi.

- Phone update `updateGuardianPhoneAndRevokeBot`: guardian phone/version, barcha tegishli eski Telegram link/invite revoke, pending recipient authorization invalidation, audit va **GuardianLinkRevoked** outbox event bir txda. Raw telefon outbox payloadiga shunchaki qo‘shilmaydi; existing event contract saqlanadi. Bu botga real xabar yuborish emas.
- Bir child’ni guardian’dan unlink qilganda link soft inactive, child financial history saqlanadi. Guardian boshqa siblingga hali bog‘langan bo‘lsa o‘sha valid relationni yo‘qotmang. Telefon o‘zgarishi esa guardian credentialni barcha childlar uchun invalid qiladi. Shu ikki holatni bitta global deletega aylantirmang.
- Duplicate normalized phone conflict aniq, cross-center phone bir xil bo‘lishi mumkin. Multi-guardian relationda authorized mavjud guardian reuse explicit; client taxmini bilan boshqa odam ma’lumoti yoki telefon responsega chiqmaydi.
- Bot transport/OTP/link approval engine S14da: bu yerda faqat revoke state/event va keyingi consumer kontrakti. Existing workerga fake delivered status qo‘ymang.

## 7. S06.03 — enrollment lifecycle va tarix

`enrollments.service.ts`, controller/DTO; `createStudentEnrollment` va `withdrawEnrollmentWithChurnReason` kontraktlari. TRIAL/ACTIVE/FROZEN/LEFT uchun explicit transition matrix, effective dates va version.

- Student/group/center lineage DBda va service’da. Active uniqueness, LEFTdan keyin yangi enrollment (old rowni qayta yozib tarixni yo‘qotmang). Transfer eski enrollmentni yopib yangi row bilan bog‘laydi; old ledger/invoice reference saqlanadi. Transfer atomic, overlapping duplicate active rows rad.
- TRIAL→ACTIVE avtomatik ikki dars conversioni S12da, billing formula S08da. Bu scope’da attendance/billingni qayta implement qilmang. ACTIVE/FROZEN amali tasdiqlanmagan business calculationga bog‘liq bo‘lsa explicit policy gate/typed boundary: `POLICY_DECISION_NOT_CONFIRMED`, to‘g‘ri qolgan lifecycle ishlari davom etadi. Existing policy parametrini yoritmasdan bir billing mode’ni tanlamang.
- Withdraw reason1..5, effective date, exact debt snapshot va audit. Tarixiy debt/ledger o‘chmaydi yoki avtomatik kechirilmaydi. Money bigint/string, Numberga tushmaydi. Past sanadagi invoice correction yoki prorata/refund D03/D14/D21/D22 tasdiqsiz bajarilmaydi. Ochiq policy natijasi per-action verificationda qayd etilsin, butun S06 yopildi deb kengaytirilmasin.
- Zarur canonical eventlar va outbox dedup/version oldingi events kontraktiga mos, DB tx bilan. New event zarur bo‘lsa catalog/version/schema/checker/handoff izchil; legacy15 countni saqlash uchun noto‘g‘ri event ishlatmang. Real network effect yo‘q.

## 8. S06.04 — duplicate ogohlantirishi

`duplicates.service.ts`: exact code/UUID identitydan tashqari normalized name/phone combination bo‘yicha possible duplicate suggestions. Bir familiya va bitta guardian phone’li ikki sibling valid; warning hard unique/full-name block emas. Cross-center candidate yoki Teacherga phone bilan candidate yo‘q. Warning response authorized minimum fields va aniq reasonlar.

Auto merge, financial history physical delete yoki destructive cleanup yo‘q. Merge hali implement qilinmasa explicit UNSUPPORTED/deferred, success emas; hujjatdagi “merge tarixni yo‘qotmaydi” invarianti saqlanadi. Request exact replay idempotency orqali duplicate bo‘lmasin, odam dublikati esa ogohlantirish bilan alohida masala.

## 9. S06.05 — real testlar, CI va handoff

`apps/api/test/students/*.integration.test.ts` + `test:students`, real Nest HTTP va PostgreSQL. Existing harness/fixturesni qayta ishlating; fake request handler bilan production route o‘rnini bosmang. Dedicated ephemeral test DB safety va failed-setup cleanup saqlansin.

Majburiy failure-mode matrix:

1. Director/Admin create/update/archive allow; Teacher/full-profile/list/write deny, expired/deactivated staff deny, cross-center tampering deny.
2. Same-key concurrent quick register one student+one relation+one event; different payload409; inject fault rollback all rows/audit/outbox.
3. Same-name students allowed, normalized possible-duplicate warning; sibling same guardian phone allowed, child two guardians, guardian two children.
4. Phone normalization valid/ambiguous/invalid inputs, same center phone collision, other center valid.
5. Phone change atomically revokes old links/invites and queues correct event; fault rolls everything back. Raw phone/token logs/payloadlarda yo‘q.
6. Unlink one child keeps sibling relation and debt/history; archive hides by default and preserves authorized history/ledger.
7. Valid/invalid enrollment matrix/effective dates; duplicate active reject; LEFT→new enrollment; transfer preserves old references and rolls back on fault.
8. Withdraw reason/date/version, high BIGINT debt snapshot precision, policy-blocked finance adjustment no partial effect.
9. Search Unicode/apostrophe, UUID/code, cursor/limit/unknown query, archived inclusion; no cross-center rows/count/private fields.
10. G01 auth replay/persistence, G02 counter/shared limiter, G03 real migrator+config, G04 time-scoped substitute va family absolute deadline regressiyalari.

Bu ro‘yxatni label count bilan almashtirmang: har behavior test path/assertion/resultga bog‘lansin. API request/response DTO ham contract validator bilan actual fixturelarda tekshirilsin; fake structured fieldlar yo‘q. OpenAPI/operation inventory/RBAC matrixga yangi S06 routelar qo‘shilsin.

CI template `infra/ci/eduerp-ci.yml`: strict npm ci, generate, lint/typecheck/build/unit, G1 DB, G2 auth, G3 students va real Docker deployment. Manager root .github copy qiladi. Node24.18.1/npm11/Prisma7.10.1/TS5.9.3 baseline saqlanadi. Yangi dependency kerak bo‘lsa sabab/compatible exact version; offline lock qo‘lda edit emas, needs_manager_dependency_refresh=true.

Hujjatlar: `docs/verification/H-closure.md`, `docs/verification/S06.md`, `docs/architecture/adr/ADR-006-auth-correction-and-student-lifecycle.md`, S06 state/step06.01–06.05.md va handoffs/S06.md; S04/S05 handoff correction ham kerakli delta bilan IN_REVIEW. Actual command/result, NOT_RUN sabab, policy-gated actions, schema/event ta’siri va S07ga prerequisites aniq.

## Output va to‘xtash

Ruxsat etilgan: S04/S05 correction source/test/deploy/config/contract deltalari; `apps/api/src/students/**`, students tests; schema va alohida S06 additive migration, kerakli lineage/ACLlar; relevant DTO/auth guard; docs/spec/architecture/security/checker updates; package/real lock, Docker/CI/env/README; S06 reports va correction handofflar. Yangi feature uchun deployed migrationni silent rewrite qilmang; old initial candidate correction zarur bo‘lsa checksum sababi alohida.

Global execution.json/TRACKER/CURRENT/ACTIVE_TASK/APPROVALS, manager reviews/learning, OWNER_DECISIONS va AGENTS read-only. Business D01–D25/OPEN holatini uydirma ACCEPTED qilmang. Owner staff-create qarori o‘zgarmagan: Director barcha rollar, Admin faqat Teacher yaratadi.

Bitta `S04S05FIX_S06FULL_H_SUBMISSION.zip`: shu inputga nisbatan faqat changed/new source + SUBMISSION.json; task_id, exact base_commit, candidate_input_commit, IN_REVIEW, raw-byte files SHA256, deleted_paths, needs_manager_dependency_refresh, actual checks, not_run va policy gates. Root yoki bitta eduerp-v2/ prefixdan bittasini izchil tanlang. Unchanged input, generated client, node_modules/dist/.git/real.env/private data/dump kirmaydi. S07ni boshlamasdan to‘xtang. Chat yakuni qisqa, fayllarni to‘liq qayta chop etmang.
