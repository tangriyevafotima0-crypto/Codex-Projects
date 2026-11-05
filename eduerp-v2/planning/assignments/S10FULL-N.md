# S10FULL-N — qo‘lda to‘lov qaydi, taqsimlash, tuzatish va kvitansiya

Codex manager topshirig‘i. Argon ijrochi; natija IN_REVIEW. Bu topshiriq bitta paketda 10.01–10.05ni bajarishga ruxsat beradi. S11 to‘liq kassa boshqaruvi, gateway, Telegram va production boshlanmaydi. BASE_COMMIT va inputning aniq tarkibi root TASK_INPUT.jsonda. Oldingi ZIP yoki chat talab qilinmaydi.

## 1. Avval kontekst va saqlanishi shart bo‘lgan ishlanmalar

START_HERE, TASK_INPUT, VERIFY_INPUT.py; so‘ng AGENTS.md, OWNER_DECISIONS.md (01–05), ARGON_LEARNING.md, joriy review, 10.01–10.05 promptlari, OpenAPI va haqiqiy SQL CHECK/Prisma/helper interfeyslarini o‘qing. INPUT_MANIFEST hashlarini tekshiring. Paketdagi manager fixlar, lockfile, auth, ClockService, DATE parser, config/tokens.ts, tenant isolation, durable package ownership, immutable yozuvlar va barcha G1–G6 testlarini saqlang. Global execution/TRACKER/CURRENT/APPROVALS/manager review fayllari read-only; o‘zingiz APPROVED yozmang.

Owner05: EduERP pul o‘tkazmaydi. Naqd, karta, Click, Payme yoki bank transferi tashqarida qilingan to‘lovning usuli sifatida xodim tomonidan qayd etiladi. Hech qanday checkout, provider SDK, webhook, autocharge, payment-link yoki bank refund endpointi yo‘q. `paid_at` — haqiqiy tashqi to‘lov vaqti; `recorded_at` — tizimga kiritilgan vaqt, server tomonidan. Kech kiritilgan yozuvning ikkala vaqti saqlansin. Ichki kvitansiya fiskal chek emas.

## 2. 10.01 — Payments modul va atomik yozish

Asosiy fayllar: apps/api/src/payments/{payments.module.ts,payments.controller.ts,payment.service.ts,dto.ts}; mavjud arxitekturaga mos nom kerak bo‘lsa sababini handoffda yozing. AppModule/RBAC/contracts/OpenAPI/inventoryni birga ulang. Canonical Payment model, center/actor/student/enrollment/session lineage va migrationlarni o‘qing; ikkinchi parallel payment modeli yaratmang.

Summa decimal-stringdan BigInt UZS (1 int=1 so‘m), float/number, nol/manfiy va BIGINT overflow rad etiladi. Xodimning jonli statusi, center/license va rol ruxsati kesh javobidan oldin tekshirilsin; Teacher to‘lov/moliyaga kira olmaydi. Oldingi API kontraktidagi Director/Admin chegarasini saqlang, tasdiqlanmagan qo‘shimcha vakolat yopiq qolsin. Har payment: actor, method, paid_at, recorded_at, reason/reference, immutable source; secret/log/teacher DTOga pul yoki raw telefon sizmasin.

Bitta tranzaksiyada Payment, allocation, ledger, kerakli audit va outbox; exception istalgan yozuvdan keyin hammasini rollback qilsin. Bir xil actor/operation/key+body replay bitta natija; boshqa body409. Yangi key bilan qonuniy bir xil summali ikkinchi to‘lovni tasodifan dedup qilmang. Confirmed external reference unique bo‘lsa aniq scope va conflict kerak; bo‘lmasa amount/date bo‘yicha soxta biznes identity yasamang.

S11da cash shift to‘liq bo‘ladi. Hozir typed haqiqiy shift guard/seam yozing: mavjud ochiq tegishli shift talab qilingan operatsiyada yo‘qligi/yopiqligi rad etilsin. Avtomatik shift yaratish, always-open stub yoki test uchun production bypass yo‘q. Test fixture haqiqiy guarded DBda explicit shift yaratishi mumkin. Old `paid_at` yopilgan shift ledgerini yashirin qayta yozmasin; kech qayd bugungi ochiq shiftga audit bilan kiritilishi mumkin bo‘lgan kontrakt bo‘lsin, tasdiqlanmagan backfill/reconciliation financial mutatsiyasi yopiq qolsin.

## 3. 10.02 — Allocation va qoldiq

apps/api/src/payments/allocation.service.ts. 500000 invoicega300000→200000 qarz;600000→0qarz+100000 unapplied balance. Ko‘p invoice uchun allocation yig‘indisi paymentdan, invoice outstandingdan oshmasin; cross-student/center allocation403 yoki typedvalidation. Explicit invoice selection va deterministic locking; parallel turli keylardan over-allocation bo‘lmasin. UI number arifmetikasidan foydalanmang.

Credit note bilan payment/unapplied cash creditni bir xil iqtisodiy hodisa deb aralashtirmang. Invoice gross, discount, freeze, actual payments va reversals mustaqil ledger sabablariga ega. Existing immutable invoice/tariff snapshots UPDATE qilinmasin. Outstanding projectionni haqiqiy ledger/allocationsdan canonical hisoblang, cached responsega tayanmang.

Qarz qolsa promise_date bo‘yicha mavjud source/OpenAPI talabini saqlang. S11ning to‘liq ishini boshlab yubormasdan kerakli typed persistence seam va validatsiyani shu atomik operatsiyaga qo‘shing; mavjud modeldan foydalaning. Qarzdor positive pathni doim403 yoki soxta success qilib qoldirmang. Policy noaniq kombinatsiya bo‘lsa aniq pending deb ajrating.

## 4. 10.03 — Tuzatish so‘rovi va append-only reversal

apps/api/src/payments/reversal.service.ts. Xato qayd uchun sababli request, Director approval va yangi immutable execution/allocation reversal/ledger yozuvi; original payment o‘chmaydi yoki amounti tahrirlanmaydi. Request yaratuvchi o‘ziga mavjud bo‘lmagan tasdiqlash huquqini olmasin; Admin approve qilolmasin. Duplicate approval va turli keyli parallel approval bitta execution, version conflict/idempotency aniq.

4 000 000 noto‘g‘ri qayd→tasdiqlangan reversal→400 000 to‘g‘ri yangi qayd: net400000, original history saqlangan. Allocation reversal qarzni faqat bekor qilingan payment ulushicha qayta ochadi; qisman correctionda jami reversals originaldan oshmasin. Pul bankdan qaytarildi deb tizim o‘zi operatsiya bajarmaydi. Tashqi qaytarish qaydi bilan xizmat/invoice cancellation alohida hodisa; D22ning tasdiqlanmagan service refund qismi fail-closed. Owner05 barcha refund formulalarini tasdiqladi deb yozmang.

## 5. 10.04 — Ichki kvitansiya

apps/api/src/payments/receipts.service.ts. Faqat committed ledger asosidagi ichki elektron kvitansiya; center-scoped unique raqam parallel so‘rovlarda ham takrorlanmasin, retry yangi kvitansiya chiqarmasin. Amount/method/paid_at/recorded_at va issue paytidagi remaining balance snapshoti bo‘lsin. Faqat ruxsatli staff/student scope; Teacher va begona center/studentga deny. Fiskal raqam/provider status/Telegram yuborish uydirmang. Rollback bo‘lgan paymentga kvitansiya yo‘q. Reversal eski kvitansiyani o‘chirmaydi, bog‘langan correction holati/history ko‘rinadi.

## 6. 10.05 — Mustaqil test, regressiya va handoff

apps/api/test/payments/{harness.ts,payments-lifecycle.integration.test.ts,...}, payments-unit.test.ts; npm run test:payments va GateG7ni infra/ci/eduerp-ci.ymlga qo‘shing. Haqiqiy Nest HTTP/PostgreSQL, runtime role va mavjud helper interfeyslari ishlasin. Har asosiy ijobiy scenario mustaqil bo‘lsin; oldingi fixture yiqilgani uchun yashirin coveragega PASS yozilmasin.

Majburiy assertions: barcha manual methods; role/center/student scope va revoked session/key replay; partial/full/overpay/multiinvoice; amount overflow va dates; two simultaneous same key/different keys/approval; wrong payload409; closed shift deny; late entry paid_at!=recorded_at; promise_date; reversal restoring exact ledger debt; partial correction cap; receipt uniqueness; rollback injection har write bosqichida; append-only UPDATE/DELETE rad etilishi; all persisted totals = expected BigInt. Mutatsiyadan oldingi/so‘nggi barcha tegishli jadval soni va balance tekshirilsin.

Promptdagi oldingi xato patternlari: helper imzosini ixtiro qilmang (returningColumnsSql yo‘q); createApiApplicationning ikkinchi argumenti logger, DatabaseService emas. SQL SELECT FOR UPDATE immutable jadvalda UPDATE privilege talab qiladi: grantni kengaytirmang, canonical mutable owner rowni bir xil lock tartibida bloklang. Key replaydan oldin jonli authorization. Cumulative rounded sumsni request bo‘linishiga bog‘lamang. future date flagni emas haqiqiy sanani validate qiling. Clock oldinga surilganda JWT yangilang; test DTO/enum/constraintlarini source bilan solishtiring. AST/textcountPASS strictbuild/liveDBproof emas.

Real mavjud muhitda npm ci, prisma:generate, lint, typecheck, build, unit, G1–G7, migrate deploy fresh+upgrade va Docker tekshirilsin. Offline bajarilmagani NOT_RUN; node transpilationni tsc PASS demang. Lock yoki generatedclient yasamang; dependency kerak bo‘lsa aniq needs_manager_dependency_refresh va package o‘zgarishi. Migrationlar endi history: yangisini additive yozing, old migrationni qayta tahrirlamang. Rowcount checker va exact immutable helper catalogni yangilang, testni yumshatmang.

Docs: ADR-010, docs/verification/S10.md (command/actual output/NOT_RUN), 10.01..05 step hisobotlari va planning/state/handoffs/S10.md. Contract/ER/events/RBAC kerakli o‘zgarishlar source bilan mos bo‘lsin. Ochiq qarorlar ro‘yxati va S11ga typed seam tushuntirilsin.

Output S10FULL_N_SUBMISSION.zip: faqat ushbu INPUT_MANIFESTdan keyingi yangi/o‘zgargan eduerp-v2/ source (root loyiha-relative yo‘llar) + SUBMISSION.json. Metadata: task_id, base_commit, candidate_input_commit, statusIN_REVIEW, files[path,sha256], deleted_files, actual_tests, not_run, needs_manager_dependency_refresh. Cache/dist/node_modules/pyc/generated client/secret/full input ZIP yo‘q. Har delta hash va arxiv xavfsizligi tekshirilsin. Bir paket ichida oraliq manager javobini kutmang; S11ni boshlamang.
