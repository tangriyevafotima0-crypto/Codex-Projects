# S04FULL-F — baza poydevorini to‘liq implementatsiya qilish

Task ID: `S04FULL-F`  
Scope: **04.01–04.05**, bir paket ichida ketma-ket, oraliq manager javobini kutmasdan.  
Rol: Argon — ijrochi. Yakun: `IN_REVIEW`. Base commit: paket ildizidagi `TASK_INPUT.json`.

## Maqsad va vakolat

S01 spetsifikatsiyasi, S02 kontraktlari va manager tuzatgan S03 ishga tushadigan asos ustida haqiqiy PostgreSQL baza qatlamini yarating: schema, migration, ajratilgan DB rollari, transaction helper, integration testlar va CI. Butun S04 bu topshiriqda implementatsiyaga ruxsat etilgan. AGENTS.md oxiridagi tarixiy SETUP-00 cheklovi shu scopega tatbiq etilmaydi; bu yangi topshiriq uni S04 uchun almashtiradi. S05 autentifikatsiya/login, S08 biznes billing servisi va production migratsiya boshlanmaydi.

Bu self-contained paket: oldingi ZIP yoki suhbatni talab qilmang. Manager allaqachon API/worker/Docker xatolarini tuzatdi. Tayyor asosni qayta yozish emas, unga baza qatlamini qo‘shish kerak. Global reja registrlari managerga tegishli; eski step promptidagi execution.json ni yangilash ko‘rsatmasi bu offline topshiriqda qo‘llanmaydi.

## 0. Avval o‘qish va tekshirish

1. Ildizdagi START_HERE.txt, TASK_INPUT.json va INPUT_MANIFEST.json; fayl hashlarini tekshiring.
2. AGENTS.md, MANAGER_WORKFLOW.md, planning/state/ACTIVE_TASK.md, USER_WORKING_PREFERENCES.md va ARGON_LEARNING.md.
3. planning/state/reviews/S02-S03-E.md, planning/state/handoffs/S03.md, docs/architecture/adr/ADR-003-runtime-baseline.md.
4. planning/stages/04.md, S04 step promptlari, docs/spec/business-rules.md va decisions.md. Ushbu topshiriq yo‘l mappingi va batch chegaralari eski umumiy promptdan aniqroq.
5. docs/architecture/data-model.md, system.md, events.md, openapi.yaml, operation-inventory.csv. Canonical katalog: **46 entity**; mutable request va append-only execution tasnifini saqlang.
6. planning/reference/S04_PRISMA_BASELINE.md; mavjud API application factory, config/health/real bootstrap testlari, worker process testi, root package.json, lockfile, Dockerfilelar va CI template.

Bir marta boshlang‘ich inventar qiling. Qaysi talab qayerda bajarilishini ichki jadvalda belgilang, keyin kod yozing. Ma’lum to‘g‘ri hujjatlarni shunchaki katta diff uchun qayta formatlamang. Ochiq biznes qarorlariga `ACCEPTED` qo‘ymang. Texnik xatoni aniq tuzating; biznes policy noaniq bo‘lsa shu policy implementatsiyasini ajrating va qaror dependency sifatida qayd eting.

## 04.01 — Prisma schema va izchillik

- `apps/api/prisma/schema.prisma`: canonical 46 entityning har birini model/tablega bog‘lang. FK, optionality, actor turi, arxiv holati, enrollment lifecycle, billing cycle identity, trial activation sequence va lesson identity oldingi kontraktga mos bo‘lsin. Yordamchi entity kerak bo‘lsa asosini ADRda yozing; canonical modelni sanash uchun sun’iy bo‘lmang.
- `docs/architecture/schema-coverage.csv`: entity, model, table, mutability, FK/check/index migration locator va integration test ID. Barcha 46 entity uchun qator; column nomlari hujjatda izohlangan bo‘lsin. Bu jadval actual DB tekshiruvining o‘rnini bosmaydi.
- Pul UZS integer `BIGINT`; amount turiga qarab positive/nonnegative/signed cheklovlar. JavaScript Number orqali aniqlik yo‘qotmang. API JSON chegarasida bigintni kontraktga mos lossless ko‘rinishga aylantiring. Barcha pulni bir xil positive deb belgilamang.
- Invoice period/BillingCycle unique, lesson+student attendance unique, active enrollment partial unique; archive/guardian unlink tarixiy ledgerni cascade delete qilmasin. Bir kunda ikki lesson valid bo‘lsin. Cross-entity center/parent lineage xatolari FK yoki aniq DB constraint bilan rad etilsin.
- Prisma ifodalay olmaydigan CHECK/partial index/immutable trigger custom SQLda yozilsin va schema-coveragega bog‘lansin. Muhim invariantni faqat service validatorga tashlamang.
- `apps/api/prisma.config.ts`: Prisma 7 CLI konfiguratsiyasi, migratsiya yo‘llari va `MIGRATION_DATABASE_URL`. Runtime `DATABASE_URL` alohida, bootstrap administrator URL APIga berilmaydi.
- Tasdiqlangan texnik versiyalar: `prisma`, `@prisma/client`, `@prisma/adapter-pg` **7.10.1**; `pg` **8.23.1**. Node **24.18.1**, npm 11 saqlanadi. CLI `@latest` ishlatmang: reference tekshirilganda u 8 RC edi. Prisma generator `prisma-client`, output `../src/generated/prisma`, `moduleFormat = "cjs"`; mavjud CommonJS loyiha bilan haqiqiy compile mosligini tekshiring. Generated clientni qo‘lda yozmang yoki ZIPga qo‘shmang.
- Prisma client TypeScript >=5.4 talab qiladi: TS **5.9.3**, ESLint **9.39.5**, @typescript-eslint parser/plugin **8.72.1** bilan dev toolingni moslang. Flat config yarating, zid eski configlarni olib tashlang. Mavjud meaningful lint qoidalari saqlansin; xatoni suppress/any bilan yashirmang. Boshqa majburiy dependency kerak bo‘lsa mosligi va sababini qayd eting.

## 04.02 — Migration va haqiqiy DB huquqlari

- `apps/api/prisma/migrations/<ordered-id>/migration.sql` va `migration_lock.toml`: to‘liq bo‘sh bazaga deploy bo‘ladigan PostgreSQL16 migration. `initial` nomi ishlatilsa mappingni ADRda yozing. SQLni qo‘lda yozish mumkin; CLI ishlamasa uni generated deb ko‘rsatmang.
- `infra/db/*.sql`: faqat dev/test bootstrap uchun role/schema/database ACL. Administrator/bootstrap, schema owner/migrator, API runtime, worker va readonly huquqlari alohida. Parollar real secret emas, faqat xavfsiz test/example qiymatlari; production credentials paketga kirmaydi.
- Hozir Compose POSTGRES_USER development superuser. Uni API yoki worker runtime sifatida ishlatish **taqiqlanadi**. Schema ownership runtimega berilmaydi. Runtime URL bilan to‘g‘ridan-to‘g‘ri ulangan integration test bo‘lsin; administrator ulanishida SET ROLE qilish yetarli dalil emas.
- Append-only 21 canonical entityga UPDATE/DELETE/TRUNCATE huquqini rad eting; kerakli insert/select rolga mos. Mutable 25 entityda legitimate request/status o‘zgarishi ishlasin. `ReversalOrRefundRequest` mutable; execution/allocation reversal/ledger/audit immutable tamoyilni saqlang. Har rolga blanket ALL bermang. FK va serial/identity sequence huquqlarini ham hisobga oling.
- Staff yoki SYSTEM_WORKER actor: nullable staff FK + explicit actor kind/check kabi modeli kontraktga mos bo‘lsin. Worker actorini mavjud bo‘lmagan staffga bog‘lash bilan cheklovni aldash mumkin emas.
- Center A/B fizik DB izolyatsiyasi: alohida runtime identifikatorlari va CONNECT huquqlari. Center A credential B bazasiga ulana olmasin; default PUBLIC CONNECTni hisobga oling. Vendor plane schema center bazasiga tasodifan qo‘shilmasin.
- Migrations atomic va qayta `migrate deploy` noop bo‘lsin. Immute triggers/ACL deploydan keyin ham mavjudligini catalog orqali tekshiring. D19 retention policy ochiq: avtomatik purging/delete policy yoki muddat o‘ylab topmang. Production down/reset/dump import yozmang.

## 04.03 — Database modul va tranzaksiya chegarasi

- `apps/api/src/database/**`: Prisma/adapter-pg lifecycle, runtime config va pool shutdown. Proper Nest provider/token/moduledan foydalaning. Manager yaratgan yagona application factory va real controller metadatasini saqlang.
- `transaction.ts`: bounded retry, PostgreSQL serialization/deadlock va Prisma muvofiq error-code mapping. Faqat retryable xatolar; maksimal attempt, timeout/backoff nazoratli. Callback ichida Telegram/network/irreversible effect bo‘lmasin. DB payment/allocation/audit/outbox synthetic fixture bir ACID tx ichida rollback bo‘lishi tekshirilsin. Bu billing mahsulot funksiyasi emas, baza invariant testi.
- Generic idempotency infrastructure: scope+key uniqueness, request hash, same-key/same-hash one effect, same-key/different-hash conflict; concurrent write semantikasini yozing. Client inputni transaction retryda o‘z-o‘zidan ikki marta qo‘llamang.
- Liveness avvalgidek DBsiz ham ishlasin. DB readiness kerak bo‘lsa `/api/v1/ready` real connection/schema holatini ko‘rsatsin, xatoda safe503 va secret-free body. Route qo‘shilsa OpenAPI, operation inventory va public-operation allowlist chekerni birga moslang. DB har unit testda majburiy ulanib eski testlarni buzmasin; readiness esa disconnected DBni ready demasin.
- SIGTERM pool va app shutdownni tugatsin. Log/errorlarda URL paroli, token yoki raw telefon chiqmasin. Ochiq RBAC/channel policyga ruxsat o‘ylab topmang.

## 04.04 — Haqiqiy PostgreSQL integration sinovlari

Joy: `apps/api/test/database/*.integration.test.ts`, alohida `test:db` script. Nested path mappingini ADRda yozing: eski bitta database.integration.spec.ts nomining maqsadi saqlanadi. Unit test globi tasodifan DBga tegmasin. Compile nested testlarni qamrasin. Testlar pg/Prisma orqali haqiqiy PostgreSQLga ulansin. Matn substringi yoki arithmetic model PASS real DB PASS emas.

Quyidagi mustaqil failure mode uchun aniq executable dalil tayyorlang; count yig‘ish uchun bir testni takrorlamang:

1. Bo‘sh dedicated DBga migration; keyingi deploy noop, data saqlanadi.
2. Schema catalogda table/FK/unique/check/index/immutable himoya coverage.
3. Test fixture sifatida oldingi schema snapshotidan additive migration; existing row saqlanadi. Hozir production oldingi versiya yo‘q bo‘lsa buni synthetic fixture deb yozing, real customer upgrade deb ko‘rsatmang.
4. Schema drift ataylab kiritilganda detection. Oddiy migrate deploy barcha driftni aniqlaydi deb da’vo qilmang; alohida diff/catalog assertion qo‘llang.
5. Bir student/group uchun ikkita active enrollment rad; LEFTdan keyin valid reenroll ishlaydi.
6. Bitta guardian bilan siblings va unlinkdan keyin saqlangan qarz/tarix.
7. Bir kunda ikkita lesson valid; bir lesson/student duplicate attendance rad.
8. Invoice/BillingCycle duplicate rad, boshqa valid cycle qabul.
9. API credential bilan append-only UPDATE, DELETE va TRUNCATE rad; ishlatgan real loginni dalil qiling.
10. Worker credential chegarasi va readonly write denial; mutable approval request status transition DBda mumkin, immutable execution protected.
11. Payment/allocation/audit/outbox fixture o‘rtasida fault: hammasi rollback.
12. Parallel idempotency: same-key one effect va differing hash conflict.
13. Ikki mustaqil connection orqali serialization/deadlock retry va retry limit; faqat mock error yetarli emas. Takroran fail qiluvchi test uchun deterministic barrier/lock tartibi qo‘llang, flaky timing sleepga suyanmang.
14. MAX_SAFE_INTEGERdan katta, BIGINT chegarasidagi valid signed/nonnegative money lossless roundtrip; invalid negative/overflow rad.
15. STAFF va SYSTEM_WORKER actor valid/invalid kombinatsiyalari.
16. Cash/non-cash kontraktida allaqachon tasdiqlangan schema invariantlari; yangi salary/refund policy formulasi qo‘shmang.
17. Center A credential bilan B database CONNECT/query rad.
18. Real readiness DB unavailable holati va error/log redaction.
19. Archive/delete orqali financial FK tarixini buzish rad.
20. Restore-compatible synthetic seed/version kontrakti va second-run xavfsizligi.

Test harness dedicated `eduerp_test_*` nom va aniq opt-in flag talab qilsin. Noma’lum mavjud bazani DROP/reset qilmang; faqat ushbu run yaratgan ephemeral test resurslarini cleanup qiling. Dev/prod URL almashtirilsa test oldindan rad etsin. Seed faqat synthetic, real telefon yoki student yo‘q. Ochiq biznes policy kerak bo‘lgan fixture `TEST_ONLY`, biznes default emas.

## CI, Docker va lockfile — S04ning bir qismi

- `infra/ci/eduerp-ci.yml` template o‘zgartiring; manager uni repo-root `.github/workflows/eduerp-ci.yml`ga joylaydi. Mavjud uch yashil tekshiruvni saqlang va PostgreSQL16 service bilan role bootstrap + migrate + DB integration job qo‘shing.
- `npm ci --ignore-scripts`dan keyin **explicit Prisma generate**, keyin lint/typecheck/build/test. Generate uchun connection talab qilmaydigan dummy config bo‘lishi mumkin; migration va DB testda haqiqiy dedicated URL shart. Dummy bilan DB test passed deyilmaydi.
- Docker builder generate qilishdan oldin Prisma schema/configni ko‘rsin. Client generated TS buildga kirsin. Manager fixidagi workspace-local node_modules runnerga yetib borishi va prod prune saqlansin. Prisma CLI devDependency: production runnerdan yo‘qolsa migrationni alohida tooling/builder target yoki CI jobda bajaring; prod APIga CLI kerak deb blanket devdeps qo‘shmang.
- Compose dev startup: role bootstrap va migration prerequisites API DB usage oldidan bajarilsin. API URL superuserniki emas. Existing API/worker/Postgres smoke ishlashini saqlang. Liveness DB readinessni almashtirmaydi.
- `.gitignore`/`.dockerignore`: generated client, node_modules, dist, real .env/dump/keysni chiqarib tashlang; `apps/api/prisma/migrations/**/migration.sql` va `infra/db/*.sql` source ruxsati saqlansin. Contract assetlarni yashirmang.
- Online environment bo‘lsa haqiqiy npm install bilan lock yangilang, npm ci tekshiring. Offline cache yo‘q bo‘lsa **mavjud lockni qo‘lda o‘zgartirmang**, fake lock yaratmang. Manifest package o‘zgarganini `needs_manager_dependency_refresh: true` bilan topshiring. Manager network muhitida refresh/generate/build/CI qilib keyin approval beradi. Argon VM Node18 ekanligi loyiha Node24 targetini pasaytirishga sabab emas.

## 04.05 — Self-review, hujjat va topshirish

- `docs/verification/S04.md`: har talab uchun test ID, actual command/result yoki `NOT_RUN`+aniq sabab. Original model checker va actual PostgreSQL testlari natijasini farqlang. Eski 14 regression testning har biri saqlansin yoki aniq mos test bilan almashtirilgani isbotlansin.
- `docs/architecture/adr/ADR-004-database-foundation.md`: schema/model mapping, role grants, migration/restore-version contract, CJS client/config tanlovi, retry va idempotency semantikasi. Qo‘shimcha servis funksiyasi yozmang.
- `planning/state/steps/04.01.md` … `04.05.md` va `planning/state/handoffs/S04.md`: `IN_REVIEW`, aniq delta, schema/API/event ta’siri, executed/not-run, S05ga prerequisites. Self-review manager approval emas.
- `python3 planning/tools/check_plan.py` va planning testlarini read-only bajaring; `--sync` yoki registr edit yo‘q. Kerak bo‘lsa cross-file checker qo‘shing, ammo uni DB test o‘rnida ko‘rsatmang.
- D01–D25/OPEN savollar statusini tasdiqlamang. D19 destructive delete policy, salary/refund/business formula, real gateway/auth implementatsiyasi keyingi scopega qolsin.

## Ruxsat etilgan output va o‘zaro bog‘liq o‘zgartirishlar

Asosiy yangi fayllar: Prisma config/schema/migrations, `apps/api/src/database/**`, `apps/api/test/database/**`, `infra/db/*.sql`, schema-coverage/ADR004, S04 verification/step/handoff. Zarur moslashtirish: root/API/contracts/worker package manifestlari, haqiqiy lock, TS/ESLint config, API module/config/health/readiness tests, CI template, Dockerfile/Compose, .env.example, README, ignore fayllari. OpenAPI/inventory/checker faqat qo‘shilgan DB readiness route yoki concrete schema tuzatishiga mos ravishda o‘zgarishi mumkin. Har mavjud fayl o‘zgarishining sababini qisqa yozing. Oldingi S01/S02 hujjatlarini ommaviy qayta yozmang.

Global `planning/execution.json`, TRACKER.csv, CURRENT.md, ACTIVE_TASK.md, APPROVALS.md, manager review/learning va AGENTS.md o‘zgarmaydi. Bularni manager yangilaydi. Repo-root `.github` fayli offline outputga kirmaydi; template yetarli. Scope tashqarisida zarur fundamental kontrakt xatosi chiqsa aniq blocker yozing, yashirmang; mustaqil qolgan DB ishlarini tugating.

## Yakuniy arxiv formati

Bitta `S04FULL_F_SUBMISSION.zip`: faqat yangi/o‘zgargan matn source fayllari, loyiha ildiziga nisbatan yo‘llar bilan, va `SUBMISSION.json`. Oldingi o‘zgarmagan paketni qaytarmang. Delete kerak bo‘lsa JSONda `deleted_paths` bilan sanang; jim yo‘qotmang. Symlink/path traversal/duplicate ZIP entries yo‘q. Generated client/node_modules/dist/.git/real.env/dump kiritilmaydi.

SUBMISSION.json: `task_id`, `base_commit` (TASK_INPUTdan exact), `status: IN_REVIEW`, `files: [{path, sha256}]`, `deleted_paths`, `needs_manager_dependency_refresh`, `executed_checks`, `not_run_checks`, `open_questions`. SHA256 faylning haqiqiy raw byte bo‘yicha. Har topshirilgan source fayl ro‘yxatda aynan bir marta; JSON o‘zini hash qilmaydi. Lock eski qolsa dependency refresh field sababni aytsin.

Chat yakuni qisqa: TASK/BASE/STATUS, changed/new/deleted count, eng muhim implemented oqimlar, actual test natijasi, NOT_RUN va blocker. Hujjatlarni chatda takrorlamang. Biror muhit cheklovi bo‘lsa ishlagan va ishlamagan tekshiruvlar aniq ajratilsin. Paket ichidagi 04.01→04.05ni bitta sessiyada tugating, keyin S05ni boshlamasdan to‘xtang.
