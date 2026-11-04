# S04FIX-S05FULL-G — baza tuzatishlari + to‘liq kirish va vakolatlar

Task: `S04FIX-S05FULL-G`. Scope: S04 F01–F10 closure va **05.01–05.05 full implementation candidate**. Owner: Argon. Manager: Codex. Yakun: `IN_REVIEW`. Exact base: paket ildizidagi TASK_INPUT.json.

## A. Kirish, tartib va vakolat

Paket ichidagi `eduerp-v2/` — manager main snapshotiga original S04 candidate + haqiqiy refreshed lock qo‘shilgan holat. S04 source hali main’dagi approved mahsulot emas. TASK_INPUT.json base/candidate/hash farqini aniq beradi. Oldingi ZIP kerak emas. Kirish hashlarini tekshiring; oldingi to‘g‘ri ishni qayta yaratmang.

O‘qing: AGENTS.md, MANAGER_WORKFLOW.md, ACTIVE_TASK.md, USER_WORKING_PREFERENCES.md, ARGON_LEARNING.md; planning/state/reviews/S04-F.md va S04-F-evidence.json; OWNER_DECISIONS.md; S03 handoff va ADR003; S04 schema/migration/test/ADR004; S05 stage/prompt/acceptance; S02 data-model, events, OpenAPI va operation inventory.

Tartib: avval F01–F10ni tuzating, keyin shu tuzatilgan baza ustida S05ni implementatsiya qiling. Bir paket ichida managerning oraliq javobini kutmang. Real runtime muhit mavjud bo‘lsa G1 baza gate o‘tsin, so‘ng G2 auth gate. Offline bo‘lsa kod/test/CI draftini to‘liq tayyorlash mumkin, ammo gate `NOT_RUN` bo‘ladi: manager bajarib tasdiqlamaguncha hech bir stage APPROVED emas. Runtime muhit yo‘qligi testni mock bilan almashtirishga asos emas. S06 CRUD, financial billing, Telegram yoki Vendor plane boshlanmaydi.

Global registrlarni o‘zgartirmang; eski individual promptdagi execution.json/--sync ko‘rsatmasi bu offline paketda qo‘llanmaydi. S04 source va S05 candidate birlikda qaytariladi, ammo faqat kirish paketidan keyingi changed/new delta; original49 faylni o‘zgarmagan bo‘lsa yana qaytarmang.

## B. S04 closure — majburiy tuzatishlar

`planning/state/reviews/S04-F.md`dagi F01–F10 uchun closure jadval yarating: finding, root cause, source path, executable assertion, actual result/NOT_RUN.

### F01–F04: real schema, real client va haqiqiy bootstrap

1. Prisma 7.10.1 schema relation P1012larning beshalasini tuzating. One-to-one composite relation defining side unique invariantini schema va SQLda bir xil qiling; noto‘g‘ri cardinalityni shunchaki arrayga aylantirib biznes unique talabini yo‘qotmang. `prisma validate`, `generate`, real generated-client query testi kerak.
2. DatabaseService.getPrismaClient() haqiqiy generated `PrismaClient`ni adapter bilan qaytarsin. `{adapter,pool}`ga cast bo‘lmasin. Client/poolning yagona owneri, lazy init va disconnect/shutdown aniq bo‘lsin. ORM create/read va `$transaction` real PG bilan tekshirilsin.
3. Qo‘lda yozilgan `declare module '@prisma/adapter-pg'`ni olib tashlang. pg uchun rasmiy `@types/pg` **8.23.1**, Node uchun **@types/node 24.13.6** ishlating (manager npm orqali mavjudligini tekshirgan). Implementatsiya xatosini ambient declaration bilan yashirmang. Generated fayllar lint scopeidan chiqarilishi mumkin; handwritten source strictligi pasaymaydi.
4. Nest module graphda config provider DB modulega aniq ko‘rinsin; bitta DatabaseService yaratiladi. Parent eksporti child importga avtomatik ko‘rinadi deb taxmin qilmang. AppModule/DatabaseModule dynamic registration yoki aniq ConfigModule bilan to‘g‘ri bog‘lansin. Actual compiled entrypoint, `/health`, `/ready` va OS shutdown testi saqlansin.
5. transaction.ts exhaustive return/throwni tuzating; Buffer type muammosini rasmiy Node24 types bilan yeching. Strict TS flags o‘chirilmaydi. Generated Prisma CJS importlari compile va dist runtime bilan ishlasin; kerak bo‘lsa generator importFileExtension sozlamasini official generatorga moslang. Generated clientni qo‘lda yozmang.

### F05–F07: migration, credentials va test semantikasi

6. Harness migration pathi root cwd, apps/api cwd va compiled distdan ishlasin. Bitta aniq path resolver; apps/api/apps/api yoki distga qo‘lda copy bypass kerak bo‘lmasin. Center Bga bitta rolni API/worker/readonly sifatida uch marta berib huquqlarni bir-biriga bekor qilmang. Setup failureda ham yaratilgan pool/role/ephemeral DBlar cleanup qilinsin. Dedicated eduerp_test_* + opt-in guard saqlansin; test URLga production hostni qo‘yish rad etilsin yoki explicit approved test-host allowlist ishlatilsin.
7. Canonical migration runner: CLI `prisma migrate deploy` haqiqiy metadata/checksum/historyni boshqarsin. Test harness qo‘lda _prisma_migrations jadvaliga muvaffaqiyat satri yozmasin. Raw SQLni ayni migration loader sifatida testlash mumkin, ammo CLI deploy/redeploy o‘rnini bosmaydi. Docker dev init faqat roles/database bootstrap qilsin; migration alohida migrator service/job orqali, API startupdan oldin. Existing volume qayta ishga tushganda yangi migration ham qo‘llansin. Har migration atomic: fault injectiondan keyin partial table/ACL qolmasin. Initial SQL hali productionga chiqmagan: kerakli boshlang‘ich correctionni qilish mumkin; hujjatda checksum baseline o‘zgarganini qayd eting. S05 schema deltalari alohida keyingi migrationda bo‘lsin.
8. API container/env/configga migrator paroli/URL kerak emas. Migration credentials faqat migrator jobda. Readiness runtime loginning superuser yoki schema-owner emasligini tekshirsin; enabled triggerlar va kerakli ACLlar ham tekshirilsin, faqat trigger nomi count emas. Disabled trigger bilan READY qaytarmasin. Public 503 body static safe message; arbitrary PG error satrini regex bilan tozalab publicga berishdan qoching. Ichki diagnostika secretsiz bo‘lsin.
9. T04.03 actual payment + allocation + audit + outbox transaction fixture o‘rtasida fault, barcha effect rollback. Student/outbox testi qo‘shimcha bo‘lishi mumkin. Drift uchun ataylab constraint/index/trigger o‘zgartirib detection isboti; old synthetic snapshotdan additive migration va row preservation; actor STAFF/SYSTEM_WORKER valid/invalid, active enrollment LEFT→reenroll, bir kundagi ikki lesson va duplicate attendance. Retry exhaustionni real PG SQLSTATE bilan bounded sinang; faqat isRetryable() modeli emas. SQL timeout/backoff/isolation input validation, broken connection release va callback ichida tashqi effect yo‘qligi aniq bo‘lsin.

### F08–F10: manager actual DBda qayta chiqargan invariantlar

10. Last active Director: ikki transaction ikki Directorni parallel deaktivatsiya qilganda kamida bittasi qoladi. Markaz darajasidagi stable lock/guard row yoki unga teng race-safe yechim. BEFORE row COUNTning o‘zi yetmaydi. To‘g‘ridan-to‘g‘ri runtime SQL ham himoyalansin; oddiy HTTP service mutex yetmaydi. Deadlock/serialization error boshqaruvi va direct SQL uchun retry/rad etish semantikasi yozilsin. HTTP role/status mutation audit+session revoke bilan bir txda bo‘lsin.
11. Attendance student/enrollment/lesson group lineage DB darajasida mos bo‘lsin. Manager bir enrollmentni boshqa student davomatiga bog‘lab INSERT qila oldi. Xuddi shu redundant identity patternni invoice, billing cycle, payment/allocation, freeze/credit/ledger bo‘yicha tekshiring: bir center ichida boshqa student/enrollment/invoicega noto‘g‘ri bog‘lash ham rad. Buning uchun composite keys/check trigger tanlovi ADRda; yangi biznes formula o‘ylab topmang. Har tuzatilgan relationga negative va valid positive test.
12. UUID idempotency scopeini aniqlang. Manager bir UUIDni PROBE_A va PROBE_Bda ishlatganda ikkinchisi global PK23505 bilan yiqildi, lookup esa actor/operation scoped edi. Key derivation va storage/lookup/lock bitta scopega moslansin. Client UUIDni saqlash kerak bo‘lsa composite identity yoki alohida internal PK bilan contractni saqlang; o‘zboshimcha client identityni almashtirmang. Same scope/hash one persisted effect; changed hash 409; boshqa actor/operation/centerda cross-scope collision yo‘q. Test callback counter emas, DBdagi real effectni tekshirsin.

## C. S05 uchun foydalanuvchi tasdiqlagan RBAC

`OWNER-20261104-01`: **Rahbar barcha rollarni, Admin faqat Teacherni yaratadi.** Teacher staff yaratmaydi. Client yuborgan role/center_id hech qachon ishonch manbasi emas. Admin DIRECTOR/ADMIN yaratish, payloadni o‘zgartirib yuqori rol berish yoki boshqa centerga yozish rad etiladi.

Bu qaror faqat create_staff scopei. Adminning staff status/role edit, deactivate, broad staff listing yoki boshqa sessionni revoke qilishi tasdiqlanmagan: deny until separately confirmed. Director uchun manbada ko‘rsatilgan boshqaruv ishlaydi. Self profile/logout/password va o‘z sessioni bo‘yicha auth semanticsni alohida belgilang. OPEN_RBAC_02 va privacy/channel/biznes savollar ochiq; Teacherga raw/qirqilgan telefon yoki moliya uzatilmaydi. Proposeddan ACCEPTEDni ixtiro qilmang.

S05 boshida docs/spec/decisions.md, scope RBAC qismi, OpenAPI x-object-scope va relevant semantic checkerlarni aynan create_staff uchun yangilang. Tarixiy “0 accepted” jumlasi joriy owner qarorini inkor qilmasin. Eski Python checker pass qolsin deb noto‘g‘ri deny qoidasini saqlamang; accepted va still-open holatlar uchun alohida negative assertions yozing.

## 05.01 — parol, login va session lifecycle

Fayllar: `apps/api/src/auth/{auth.module,auth.service,auth.controller,password,session-store,token-service,...}.ts`. Kerakli yangi configlar env example/redaction/validation bilan.

- Rasmiy kriptografik primitive: Node async `crypto.scrypt`; OWASP tavsiya parametrlaridan masalan N=2^17,r=8,p=1, mos maxmem. Random salt, versioned hash format, timing-safe compare va bounded hashing concurrency. Parametrlar server tomonidan nazoratli; attacker hash stringdan cheksiz memory/CPU boshqarmasin. Bitta hashni shared synthetic fixture uchun ishlatish mumkin, ammo production seed/password chat/logda yo‘q. DIY SHA256 password hash yo‘q.
- JWT uchun tekshirilgan kutubxona, masalan npm metadata orqali verified **jose 6.2.15**. Node24/CommonJS runtime interoperabilityni real build bilan tekshiring. JWT sign/verify qo‘lda yozilmaydi. Algorithm allowlist, issuer/audience/center, token_use, sub/sid, iat/exp, jti va role/session version nazorati. `decode` verification o‘rnida ishlatilmaydi. JWTda telefon/parol/moliya yo‘q.
- Opaque random refresh token, DBda faqat digest, absolute TTL va rotation. Original row/family tarixini replay detection uchun saqlang; old token qayta ishlatilsa active family ham revoke qilinadi. Parallel refreshda bitta winner; loser replay natijasida yangi family sessiyasi qanday bekor qilinishini aniq testlang. Staff deactivated yoki role o‘zgarganidan keyin eski access token expiry kutmay kuchini yo‘qotsin: guard DB/session/staff holatini tekshiradi.
- Login account lockout atomic failed count + rate limit; noma’lum username va disabled staff uchun account enumerationga yo‘l bermaydigan javob. IP limiterda trusted proxy aniq, attacker X-Forwarded-Forga to‘liq ishonmang. Security tuning technical defaults/config sifatida ADRda; biznes sign-off deb ko‘rsatmang. Concurrent failed login va restart/multiple API instance holatini hisobga oling. Test clock controllable; expiry testida uzun sleep yo‘q.
- Birinchi login mustChangePassword: faqat password change/logout va zarur self session amallari, qolgan protected amallar rad. Current password va expected_version tekshiriladi; change transactionda hash/version/audit va session invalidation. Security material request logger yoki audit JSONga kirmaydi.
- Real HTTP endpointlar existing OpenAPI bilan: login, refresh, password change, logout, staff session revoke. Token transport extension kerak bo‘lsa contractni explicit yangilang, yashirin boshqacha endpoint yaratmang. Public bootstrap auth guarddan o‘ta olsin; qolgan endpoints default deny.

## 05.02 — RBAC va obyekt scope

`permissions.guard.ts`, principal/context decoratorlari va server-side object resolver yarating. Faqat JWT role claimini tekshirish yetmaydi. Current staff/session/center holati, Teacher group ownership/effective teacher va kerakli action birga tekshiriladi. Center/Vendor token audiences ajratiladi; Vendor login/MFA implementatsiyasi bu paketga kirmaydi.

Teacher A Teacher B group/lesson/student/enrollment IDlarini URL/query/bodyda almashtirib kira olmasin. Minimal read-only real safe roster yo‘lini S02 getGroupSafeRoster kontraktiga mos ulang, S06dagi CRUDni boshlamang. Teacher javoblari allowlist DTO, explicit SQL/ORM select: raw Student yoki Staff entity serialize qilinmaydi. Teacher DTOda phone/guardian/chat/financial fields bo‘lmaydi. Parent/Student staff web logini yo‘q. Ochiq policy branchlar deny bo‘lib qoladi.

Search/pagination/ordering/cursor/total_count va error body orqali boshqa group yoki private fieldlar sizmasin. Exist/nonexist foreign IDs uchun contractdagi izchil 403/404 semantikasi; aniq other-teacher group request `403 FORBIDDEN_OBJECT_SCOPE`. IDni o‘zgartirish authorizationni chetlab o‘tmasin. Qo‘shilgan route va object resolverlar test coverage jadvaliga kirsin. Existing unimplemented product endpointsni fake success bilan yopmang.

## 05.03 — xodim boshqaruvi, deaktivatsiya va audit

- `staff.controller.ts` + service/repository: accepted create matrix; Director list/create/status/role va authorized revoke, optimistic concurrency expected_version, uniqueness error mapping. Admin faqat Teacher create; Teacher deny.
- Soft deactivate; history delete/cascade yo‘q. Last Director invariant F08 yechimi HTTPda ham real ishlasin. O‘zini oxirgi Director sifatida demote/deactivate qilish rad.
- Status/role change, audit va session revoke atomic; old tokenlar keyingi requestda rad. Mass-assignment, passwordHash/refreshHash return, fake center override va privilege escalation rad.
- Audit actor/action/entity/request-id va redacted diff bilan, credentials/raw phone/initial password yo‘q. S05 security auditni shu tranzaksiyada yozing; Telegram/outbox joblar ixtiro qilinmaydi. Yangi event zarur bo‘lsa sababi/version/contract bilan; existing15 eventni soxta nomlar bilan buzmaydi.
- Bootstrap Director uchun test-only fixture yetarli; production default admin/password yaratilmaydi. Security test data seed oldingi non-real hashni login ishlaydi deb ko‘rsatmasin; real scrypt test hash ishlatsin.

## Browser, mobile va CSRF kontrakti

Hali frontend/mobile yozilmaydi, lekin server transporti real HTTP test bilan tekshiriladi. Browserda refresh token HttpOnly/Secure/SameSite cookie, access token memory; localStorage/sessionStoragega credential saqlash yo‘q. Cookie auth ishlatilgan unsafe amallarda session-bound CSRF token + trusted Origin tekshiruvi; SameSite yagona himoya emas. Header bearer mobile mode explicit bo‘lsin, browser cookie bilan noaniq aralashmaydi. Cross-origin CORS explicit allowlist; credentials bilan wildcard yo‘q. Mobile refresh storage kontrakti OS keystore/keychain, sync/SQLitega token qo‘yilmaydi. Local HTTP dev uchun Secure cookie istisnosi faqat explicit development; production bypass yo‘q.

Existing StaffAuthResponse transporti bilan bu farqni OpenAPI success/error/cookie/header schema orqali hujjatlashtiring. Browserga qaytarilgan bodyda HttpOnly refresh nusxasi bo‘lmasin. Mobilega token body explicit qaytishi mumkin. Ikkala transport ham alohida testlanadi. Login/logout/refresh CSRF boundarylarining har birini belgilang.

## 05.04 — executable security regressiyalar

`apps/api/test/auth/*.integration.test.ts` va shared fixture/harness; `test:auth` alohida command. Haqiqiy Nest HTTP + haqiqiy PostgreSQL, mocked guard yoki createServer emas. Fast pure password/hash/token negative unit testlari qo‘shimcha bo‘lishi mumkin.

Majburiy mustaqil holatlar:
1. Valid login, invalid/unknown/disabled login bir xil safe xato; concurrent brute-force lockout va rate-limit.
2. Password hash salt farqi, wrong password va corrupted/hostile parameter hash xavfsiz rad.
3. Expired/wrong signature/alg/issuer/audience/center/token_use access token rad.
4. First-login restriction, current password/expected version, successful change va eski credential/session invalidation.
5. Refresh rotation, replay/family revoke, parallel refresh one-winner va revoked/expired session rad.
6. Logout/revoke idempotent va eski access tokenning keyingi requesti rad.
7. Director barcha staff rollarini yaratadi; Admin faqat Teacher; Teacher hech birini yarata olmaydi.
8. Admin payload role/center tampering, status/role escalation va unauthorized revoke rad.
9. Concurrent two-Director demotion/deactivation at least-one invariant, direct DB testi ham saqlanadi.
10. Role/status change bilan audit/revoke atomic; injected failureda hech qanday partial effect yo‘q.
11. Teacher A own group safe roster success, Teacher B group 403, other-center principal/ID rad.
12. Mixed search/cursor/pagination va nonexistent IDs orqali phone/financial/foreign roster sizmaydi.
13. Staff output/audit/request/error logsda password, access/refresh token va hashes yo‘q; Teacher outputda raw/qirqilgan telefon yo‘q.
14. Browser cookie flags, invalid/missing CSRF/Origin denial, allowed same-origin path; mobile bearer mode cookie pathni chetlab o‘tmaydi.
15. Invalid extra fields, duplicate username, stale expected_version, bad UUID va bad content/body bounds structured error bilan.
16. Public /health va /ready/logins auth guard bilan tasodifan yopilmaydi; unimplemented route fake success emas.
17. Existing S03 runtime va S04 DB tests regressiya qilmaydi. Scope matrixdagi har allowed actionga positive, har forbidden branchga negative test.

Bajarilmaganini PASS demang. Matrix rows yoki ID count executable test natijasi emas. G1 va G2ni alohida actual commands bilan topshiring.

## 05.05 — kontraktlar, CI va topshirish

- OpenAPI/security transport/object-scope, operation inventory, role matrix va docs/spec/decisions.md joriy owner qaroriga mos. Shared checker yangi semanticsni negative mutation bilan tekshirsin; guard/DB testining o‘rnini bosmaydi. Student/guardian phone redaction baseline saqlansin.
- S05 auth schema deltalari alohida additive migration. Canonical46 entity mappingi saqlanadi; texnik yangi session family/rate limit entity kerak bo‘lsa 46ga kirmaydigan qo‘shimcha sifatida ADRda asoslang, tekshiruvlarni shu farqga moslang. S04ni count saqlash uchun noto‘g‘ri cheklamang.
- `infra/ci/eduerp-ci.yml`: strict locked install, explicit generate, lint/typecheck/build/unit, real migration/DB/auth integration va Docker health/readiness. Diagnostic manager workflowidagi continue-on-error, emitted JSdan keyin source build failni chetlab o‘tish va distga migration copy **qabul workflowiga ko‘chirilmaydi**. Manager root .github copy qiladi.
- Toolchain: Node24.18.1/npm11; Prisma CLI/client/adapter7.10.1; TS5.9.3; existing ESLint9 flat config. Input lock manager tomonidan haqiqiy npm orqali yangilangan, CI npm ci PASS. Yangi dependency qo‘shilsa online actual lock refresh; offline holda eski lockni qo‘lda edit emas, needs_manager_dependency_refresh=true.
- `docs/verification/S04-G.md`, `docs/verification/S05.md`, `docs/architecture/adr/ADR-005-auth-and-session.md`, `docs/security/rbac-matrix.csv`, `planning/state/steps/04.01..05.md` correction va `05.01..05.md`, handoffs/S04.md va S05.md — IN_REVIEW. S04 original reportni manager review bilan yopgan deb o‘zingiz APPROVED qilmang.
- G1: validate/generate/lint/typecheck/build/old tests + full actual DB gate. G2: real HTTP+PG auth suite, contract validator, Docker stack and runtime-role test. Offline bo‘lsa source/tests/CI ready, G1/G2=NOT_RUN va aniq sabab; manager keyin bajaradi.

## Fayl chegaralari

S04 source/test/migration/Docker/CI/config correctionlari; `apps/api/src/auth/**`, minimal safe roster route/service, auth tests, security DTO/error/guard, relevant app module/config/middleware; package manifests/real lock, TS/ESLint official types; S05 additive migration; relevant OpenAPI/spec/inventory/semantic checker; yuqoridagi verification/ADR/RBAC/step/handoff. Schema coverage va S04 checker yangi texnik deltalarga mos bo‘lsin.

Global execution.json, TRACKER, CURRENT, ACTIVE_TASK, APPROVALS, manager review/learning, OWNER_DECISIONS va AGENTSni o‘zgartirmang. Inputda owner qarori read-only manba; specga moslashini ijrochi qiladi. Real customer, production migration/deploy, live Telegram, Vendor login/MFA va S06+ scope yo‘q.

Bitta `S04FIX_S05FULL_G_SUBMISSION.zip`: faqat yangi/o‘zgargan fayllar + SUBMISSION.json. Raw-byte SHA256, task_id, exact base_commit, candidate_input_commit, IN_REVIEW, files, deleted_paths, dependency_refresh, executed_checks, not_run_checks va open_questions. JSON o‘zini hash qilmaydi. Unchanged inputlarni qaytarmang. Generated client/node_modules/dist/.git/real.env/dump/private keys yo‘q. Chat yakuni qisqa; hujjatlarni chatda qayta chop etmang.
