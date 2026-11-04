# S01-FIX-S02-FULL-D — S01 tuzatishlari va butun S02

TASK_ID: S01-FIX-S02-FULL-D
MODE: DOCUMENT_AND_ARCHITECTURE_DRAFT_OFFLINE
BASE_COMMIT: paketdagi TASK_INPUT.json qiymati.
Ishchi papka: eduerp-v2/.
Scope: S01 uchun C01–C06 tuzatishlari va S02 uchun 02.01–02.05 arxitektura loyihasi.

## Kirish va ish tartibi

Avval START_HERE.txt, ACTIVE_TASK.md, reviews/S01-FULL-C.md va ARGON_LEARNING.mdni o‘qi. Paketda oxirgi S01 natijasining 14 fayli bor. Ularni eski bir-step candidate bilan almashtirma. Mavjud to‘g‘ri matnni qayta yozma. S02 uchun stages/02.md, 03_ARCHITECTURE.md, 05_DOMAIN_RULES.md, 06_INTEGRATION_GATES.md, 07_SECURITY_AND_RELEASE.md va tegishli manba bo‘limlarini o‘qi. Barcha 124 promptni qayta o‘qish kerak emas.

Bitta topshiriq ichida fix → local check → architecture draft → cross-check → bitta ZIP tartibida ishlagin. Oraliqda manager javobini kutma. S01 hali APPROVED emas; manager yakunda avval S01ni, keyin S02ni tekshiradi. Ochiq siyosatni tanlangan defaultga aylantirma. Mustaqil ishlar davom etadi, faqat noaniq qarorga bog‘liq qism conditional/proposal bo‘lib qoladi.

## A. S01 — C01–C06ni tuzatish

Manager reviewdagi har topilmani yop va verifikatsiyada issue → changed location → actual check jadvalini ber.

- C01: berilgan Python buyrug‘i compile bo‘lmaydi. Uni bitta `tools/verify_s01_s02.py` faylga ko‘chir, sintaksisini tekshir va aynan shu faylni ishga tushir. Eski PASS xulosasiga superseding correction yoz. 22 casening hammasi uchun tekshiruv turini ajrat: ARITHMETIC_CHECKED, MODEL_CHECKED, DOC_REVIEWED yoki NOT_RUN. Matnda case borligi uning xatti-harakati testdan o‘tganini bildirmaydi. Database concurrency/transaction testi app yo‘qligida runtime PASS bo‘lmaydi. Buzilgan LaTeX, U+000C va boshqa control belgilarni tozala; oddiy code-formula yetarli.
- C02: 96 ta step mezonining generic Given/When qismini konkret precondition va trigger bilan almashtir. Mavjud yaxshi Then, ID va mappinglarni saqla. Masalan: bitta active Director va session bor; o‘zini deactivate qilish buyrug‘i; reject va hech qanday state effect yo‘q. Kelajak app testlari PLANNED bo‘lib qoladi.
- C03: chegirma/pro-rata/oldingi kredit bilan freeze hisobining asosi va capini aniq taklif qil. Misol: 480000 gross, 50% discount →240000 net; 6/12 dars uchun net-proportional policy ostida kredit120000. Bu D14 ostidagi taklif, qabul qilingan qoida emas. Grant yoki avval berilgan kredit sun’iy ortiqcha kredit bermasin. Refund payment methodni ko‘rsatsin; faqat cash refund cash shiftga ta’sir qiladi. Money contractda so‘m va tiyin100 marta chalkashmasin: scale/unit va conversion misoli aniq bo‘lsin.
- C04: calendar, rolling month va lesson package uchun billing-cycle identity yoz. Bir oyda ikki alohida 12-dars cycle ikki invoice olishi, bir cycle retry esa bittaligicha qolishi kerak. Trial activation → compensation → valid reactivation oqimida unique key yangi haqiqiy aktivlashishni xato to‘smasin; eski charge ikki marta hisoblanmasin. S02 model va eventlar shu oqimga mos bo‘lsin.
- C05: registr haqiqiy15 PROPOSED /9 DECISION_REQUIRED /1 DEFERRED ekanini summarylar bilan mosla; raqamlarni qo‘lda ko‘paytirib yozma. D11 va D19 uchun earliest implementation gate bilan architecture draft farqini aniq yoz. OPEN_RBAC_01ni staff yaratish va boshqa aloqasiz telefon savoli uchun bir xil ma’noda ishlatma. Fraudga100% kafolat da’vosini olib tashla.
- C06: source_page, source_section, acceptance source_locator va originni mosla. Masalan R05.03 page3–4 deydi, section esa p1 va3–4ga havola beradi. Global planning registrini bu taskda o‘zgartirma; kerakli upstream correctionlarni alohida qayd et.

S01ning barcha14 hujjatini oxirgi mos holatida qaytar; o‘zgarmaganlari ham lineage uchun paketda bo‘lsin. O‘zgartirilgan fayl hashlarini yangila, oldingi handoffdagi eski hashlar qolib ketmasin.

## B. 02.01 — docs/architecture/system.md

Har markazning API, worker, DB, fayl, bot, network va credential chegaralarini yoz. Shared VPS nosozlik domeni, alohida Vendor control plane, staff web, Flutter/SQLite, Excel va Telegram data flowlari ko‘rsatilsin. Mermaid system va deployment diagrammalari bo‘lsin.

Single DB truth, session/object permission, policy version, timezone, currency scale, queue, privacy, restore va license chegaralarini izohla. Payment, allocation, required promise, audit va outbox transaction chegarasi aniq bo‘lsin. Qaysi tanlov mavjud engineering proposal, qaysisi user qarori ekanini ajrat. Marketingdagi latency va’da sifatida yozilmasin.

## C. 02.02 — docs/architecture/data-model.md

ER diagramma va entitylar uchun field/type/nullability, PK/FK, unique/check/index, ownership va retention yoz. Quyidagilar qamralsin:

Staff/Session; Student/Guardian/TelegramLink; Course/Group/Enrollment; Lesson/Assignment/Substitute; Attendance/Revision/ClientOperation; BillingPolicyVersion/BillingCycle; Invoice/Line; DiscountRequest/Approval; Freeze/Credit; Payment/Allocation/Reversal/Refund/UnappliedCredit; Promise; Shift/Expense; PayrollSnapshot/Adjustment; Audit/Outbox/Delivery; ImportBatch; CenterLicense.

Mutable entity version/status, immutable ledger va qayta quriladigan projection farqini yoz. Unique keylar correction/reopen oqimlarini ko‘tarsin. Teacher uchun alohida xavfsiz DTO proyeksiyasi belgilang. Ikki package bir oyda, trial reactivation, discounted freeze, noncash refund va bekor qilingan offline permission holatlarini model bilan tekshir.

Retention D19 ochiq: guardian privacy deletion bilan financial/audit retentionni aralashtirma. Financial cascade delete yo‘q. Bu bosqichda migration SQL yoki app kodi yozilmaydi.

## D. 02.03 — docs/architecture/openapi.yaml

Tanlangan OpenAPI versiyasini deklaratsiya qil. Offline YAML parser bo‘lmasa fayl strict JSON ko‘rinishida yozilishi mumkin: bu YAML-compatible format va stdlib json bilan o‘qiladi. JSON parse va reference checks full OpenAPI specification validator o‘rnini bosmaydi; cheklov aniq aytilsin.

Faqat sample fragment emas, ushbu domainlar uchun paths, operations, schemas, errors, security va object-scope kontraktlari bo‘lsin:

Auth/session/staff; student/guardian/enrollment; group/lesson/substitution/grades; attendance/batch sync; policy/billing/invoice; discount/freeze; partial payment+promise; allocation/receipt/reversal/refund; cash shift/expense; Excel template/preview/commit; reports/payroll/churn; guardian bot link/query va Director approval command; license holati va read-only policy.

Center API va Vendor API trust boundary ajratilsin. Vendor operationlari alohida server/security yoki explicit boundaryga ega bo‘lsin, markaz PII response bermasin. Actor roli client bodydan trusted olinmaydi. Teacher DTOda telefon/moliya yo‘q. Telegram webhook va guardian link revoke kontraktlari bor bo‘lsin.

Har write uchun idempotency yoki expected_version semantikasi; bir key+boshqa body409; duplicate event effect; error envelope va400/401/403/404/409/422/429 holatlari. Pagination, limit, async job/import holati, currency/scale, date/UTC timestamp, read-only xatosi va batch ACK semantikasi aniq yozilsin. Ochiq policyga bog‘liq qism conditional kontrakt/gate sifatida qayd etilsin.

## E. 02.04 — docs/architecture/events.md

Versioned catalog: PaymentRecorded/AllocationAdjusted/RefundRecorded; AttendanceSubmitted/Corrected; TrialActivated/Compensated; DiscountApproved; FreezeCreditIssued; PromiseDue/Fulfilled; TeacherPingDue; ShiftClosed; GuardianLinkRevoked; LicenseStateChanged.

Har eventda event ID, aggregate ID/version, center context, occurred UTC, source operation va PII-minimal payload. Producer transaction/outbox, consumer/dedup scope, ordering, lease/retry/backoff/DLQ, replay/retention va schema evolution yozilsin.

External Telegram exactly-once kafolati yo‘q: senddan keyingi crash, duplicate ehtimoli, unlinkdan keyingi eski chat va restoreda outbound disabled holatlarini ko‘rsat. Read-only system ACK bilan business mutation farqini yoz. Trial correction/reactivation hamda refund method modeli bilan eventlar mos bo‘lsin.

## F. 02.05 — Cross-check, dalil va handoff

`docs/architecture/traceability.csv` ustunlari:
requirement_id,criterion_id,architecture_locator,api_operation_ids,schema_entities,event_names,decision_ids,status

Barcha119 ID saqlansin. Hozir arxitekturaga aloqasiz demo/video/training tafsilotida N/A(reason)+future owner mumkin; soxta architecture detail qo‘shma. Tegishli talablarda operationId, entity, event va anchorlar haqiqiy bo‘lsin. Source mappingni mexanik ko‘chirmasdan C06ga amal qil.

`docs/verification/S02.md`: checks, payload misollari, noto‘g‘ri role/cross-center/duplicate/retry holatlari va haqiqiy checker stdout. `planning/state/steps/02.01.md`–`02.05.md`: qisqa alohida hisobotlar, umumiy dalilga havola. `planning/state/handoffs/S02.md`: S03 uchun aniq fayl/kontrakt/qaror/risk indeksi. App ishladi degan da’vo yo‘q.

## Tekshiruv usuli va natija

`tools/verify_s01_s02.py` faqat Python stdlib bilan lokal hujjat/arifmetika/reference tekshiradi. Appni mutate/deploy/install qilmaydi, networkga chiqmaydi. Faylni syntax-checkdan so‘ng real run qil. ID/status/count/anchor/reference tekshiruvlari; JSON OpenAPI uchun local $ref, operationId va required security checks; arifmetika uchun integer/Fraction/Decimal/date oracles. Har case bo‘yicha haqiqiy coverage ko‘rsatilsin. Checker noto‘g‘ri kirishda fail qilishini vaqtinchalik nusxalarda namoyish qil. Semantic source review alohida, full OpenAPI validation bo‘lmasa NOT_RUN.

OUTPUTS.jsondagi27 fayl +SUBMISSION.json =28 fayl. SUBMISSIONda task_id, steps, base_commit, status=IN_REVIEW, files[path+sha256]. Output: S01_FIX_S02_FULL_D_SUBMISSION.zip. Fayl yo‘llari project rootga nisbatan, qo‘shimcha wrapper papkasiz.

Execution/CURRENT/TRACKER, global decisions va requirements registrlarini manager boshqaradi; ularni o‘zgartirma. S03/app kodi, real ma’lumot va servis operatsiyalari bu taskga kirmaydi. Yakuniy chat12 satrgacha: actual checks, qolgan masalalar va ZIP. Tugamagan ish bo‘lsa checkpoint bilan PARTIAL_IN_REVIEW, uni PASS deb yozma.
