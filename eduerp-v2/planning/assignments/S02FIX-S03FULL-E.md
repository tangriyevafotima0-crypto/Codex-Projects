# S02FIX-S03FULL-E — kontraktlar tuzatishi va butun S03

TASK_ID: S02FIX-S03FULL-E
BASE_COMMIT: TASK_INPUT.json qiymati.
Ishchi papka: eduerp-v2/.
Scope: S2F01–S2F07 tuzatishlari +03.01–03.05 poydevor scaffoldi.

## Kirish va ish tartibi

START_HERE.txt → ACTIVE_TASK.md → reviews/S01-S02-D.md → ARGON_LEARNING.mdni o‘qi. Paketda oxirgi27 ta candidate fayl bor; eski C/D topshiriqlarini qayta boshlama. S01 hujjat bosqichi APPROVED, lekin S2F06 bo‘yicha kichik coverage-label tuzatishi saqlangan. Bu biznes siyosatlari yoki runtime ishlashini tasdiqlash emas.

S02 fixdan keyin mustaqil S03 poydevorini oraliq manager javobisiz tayyorla. Ochiq policylarni yashirin defaultga aylantirma. Mavjud to‘g‘ri ishni qayta yozma; faqat topilmalar va yangi bosqichga tegishli qismlarni o‘zgartir.

## A. S2F01–S2F07ni tuzat

Reviewdagi aniq misollar asosida:
- Login bootstrap va session lifecycle: credential login oldindan bearer talab qilmasin. Public endpointlar qat’iy allowlist; protected write security saqlansin. Login, refresh, logout va revoke oqimlari aniq bo‘lsin.
- Har protected GET/POST uchun object scope: Teacher boshqa guruhni ko‘rmasin; safe DTOning o‘zi authorization emas. Guardian link va Vendor boundary tekshirilsin. Ochiq role policy tasdiqlanmaguncha grant berilmasin.
- Mutable request/approval bilan immutable execution/ledgerni ajrat. Allocation reversal, credit application va SystemWorker actor modelini table grants bilan mosla.
- Outbox consumer receipt, effect+receipt atomikligi, fanout progress, ordering va lease/late ACK fencing kontraktini yoz. Producer dedupni consumer dedup o‘rniga ishlatma.
- Operation inventory bo‘yicha yo‘q use-case kontraktlarini to‘ldir. Center/Vendor server boundary alohida bo‘lsin.
- CASE coverage yorliqlari haqiqiy bajarilgan oracle/modelga mos bo‘lsin. Case matni mavjudligini model ishladi deb sanama. Event headingini domain event deb hisoblama.
- Positive/signed/nonnegative money turlari, BIGINT chegarasi, OpenAPI3.1 null union va optional farqi to‘g‘ri bo‘lsin.

`docs/architecture/operation-inventory.csv` qo‘sh. Ustunlar:
use_case_id,actor,scenario,operation_ids,object_scope,owner_stage,status

Source flow → actual operation mapping ber. Yetishmagan required operationni qo‘sh yoki aniq future owner/gate bilan qayd et; yashirin TBDni complete deb ko‘rsatma. Model/API/event/BR/acceptance bir-biriga mos bo‘lsin. Global planning registrlarini o‘zgartirma.

## B. 03.01 — workspace va ishlab chiqish poydevori

Root package.json bilan npm workspaces: apps/api, apps/worker, packages/contracts. Bitta JS lockfile, tsconfig.base.json, runtime pin, .env.example, .gitignore va root README setup bo‘lsin. Flutter SDK/pubspec keyin alohida boshqariladi; bu bosqichda Flutter yoki web funksiyasi yozilmaydi.

Versiyalar available official/cached metadata bilan aniq tanlansin; “latest” deb taxmin qilma. Lockfile faqat haqiqiy package manager orqali yaratiladi. Qo‘lda integrity hash yoki install natijasini ixtiro qilma. Dependency o‘rnatish imkoni bo‘lmasa source/CI tayyorlab, aniq NOT_RUN sababi bilan topshirish mumkin; manager buildni tarmoq mavjud muhitda yakunlaydi.

## C. 03.02 — API va worker scaffoldi

NestJS API entry/module, typed config validation, request ID va health endpoint yoz. Majburiy config yo‘q yoki noto‘g‘ri bo‘lsa aniq fail-fast. Request ID uzunligi/formatini chekla; error va loglarda secretlar chiqmasin. `/api/v1/health` minimal xavfsiz javob qaytarsin.

DB schema hali yo‘q: DB tayyorligini tekshirmasdan “database healthy” deb ko‘rsatma. Liveness/readiness chegarasini READMEda tushuntir. Stage05 auth yoki payment/student funksiyalarini implement qilma.

Worker faqat config/startup/graceful shutdown skeletoni; hali outbox business job emas. packages/contractsda corrected OpenAPI location/export mapping bo‘lsin; soxta generated client yaratma.

## D. 03.03 — lokal dev muhiti

`infra/compose.dev.yml`: PostgreSQL healthcheck, API/worker dev build, private DB network va persistent volume. API va worker Dockerfilelari, .dockerignore kerak. Dev credentiallar faqat example placeholder; real secret yo‘q.

Build context va ishchi papka repo ichidagi eduerp-v2 loyihasiga mos bo‘lsin. Production TLS/deploy kirmaydi. Migratsiya Stage04da boshlanishi ochiq ko‘rsatilsin; mavjud bo‘lmagan jadvallar yaratilgan deb yozilmasin.

## E. 03.04 — haqiqiy CI shabloni

`infra/ci/eduerp-ci.yml` tayyorla. Muhim: Git repo rooti Codex-Projects, loyiha esa eduerp-v2. GitHub faqat repo-root `.github/workflows/` ichidagi workflowlarni ishga tushiradi. Bu taskda shablon loyiha ichidagi infra/ci/da topshiriladi; manager reviewdan so‘ng uni repo-root `.github/workflows/eduerp-ci.yml`ga joylaydi.

Trigger/path filter/working-directory/cache path eduerp-v2ga mos. npm ci, lint, typecheck, test, build haqiqiy buyruqlar bo‘lsin. `echo PASS` yoki hamma testni unconditional skip qilish yo‘q. Secret scan kerakli example fayllarni hisobga olsin. CI hozir real run bo‘lmagan bo‘lsa NOT_RUN deb yoz; VMdagi internet cheklovi GitHub CI ishlaganiga dalil emas.

## F. 03.05 — tekshiruv va handoff

API health request/response, secretsiz javob, request ID korrelyatsiyasi va invalid config failure uchun real executable testlar. Worker config/signal exit uchun zarur darajadagi testlar. Test runner va package.json buyruqlari bir-biriga mos bo‘lsin.

Dependencies mavjud bo‘lsa haqiqiy install, lint, typecheck, build, test bajar. Internet/kesh/toolchain yo‘q bo‘lsa source va CI tayyorla; qaysi buyruq nega bajarilmaganini, qaysi dependency yetishmaganini aniq yoz. Lockfile yoki test stdoutini qo‘lda yozma. Bunday artifact IN_REVIEW bo‘lib qaytishi mumkin, lekin real build tekshiruvisiz stage APPROVED deb aytilmaydi.

`docs/verification/S03.md`, step03.01–03.05 hisobotlari va S03 handoff tayyorlansin. Handoff S04 uchun aniq source/config/contract fayllari, risk va kelishilmagan qarorlarni ko‘rsatsin.

## G. Checker sifati va topshirish

Public login exception bilan protected security invariantini alohida tekshir. GET rosterning object scopei bo‘lsin. Typed relation, consumer receipt, positive amount, null sample va schema entity reference tekshiruvlarini qo‘sh. Neg test kerakli xatoni kerakli sabab bilan ushlasin.

CASE21 stale version va CASE22 paid reminder uchun model bo‘lmasa DOC_REVIEWED deb belgilash halol natija. JSON parse + local refs full OpenAPI validation emas. Scaffold runtime testlari document checkerdan alohida natija sifatida yozilsin.

OUTPUTS manifesti ruxsat etilgan yo‘llarni ko‘rsatadi. Mavjud27 candidate fayldan faqat o‘zgarganlarini, yangi operation inventory va zarur S03 source/test/config/doc fayllarini qaytar. Kerakli qo‘shimcha TS config/test/helper fayli bo‘lsa faqat apps/api, apps/worker yoki packages/contracts ichida, sababi bilan qo‘shish mumkin. node_modules, .git, build output, .env, real token yoki boshlang‘ich ZIP qaytarilmasin. Symlink, ../ yoki absolutepath bo‘lmasin.

SUBMISSION.json: task_id, base_commit, steps, status=IN_REVIEW yoki PARTIAL_IN_REVIEW, files[path+sha256], actual checks, not_run, closed_findings va open_issues. Output: S02FIX_S03FULL_E_SUBMISSION.zip. Yo‘llar project rootga nisbatan, wrapper papkasiz.

Execution/CURRENT/TRACKER/AGENTSni edit qilma. Lokal dev README va .gitignore bu taskda ruxsat etilgan. S04 migratsiyasi yoki real auth/business funksiyasiga o‘tma. Yakuniy chat12 satrgacha: tekshiruvlar, qolgan masalalar va ZIP link. Source fayllarni chatda takrorlama.
