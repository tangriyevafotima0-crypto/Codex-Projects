# S11S12FIX-Q — S11 va S12ni to‘liq ishlaydigan holatga keltirish

Bitta katta stabilization paketi. Avval P01–P06 topilmalarini yoping, so‘ng S11 va S12ning barcha qabul ssenariylari, G1–G9, kontraktlar va outputni birgalikda yakunlang. 11.01–12.05 scope; yangi S13 yozilmaydi. Bu mayda patch-only topshiriq emas: ikki bosqichning integratsiyasi, real testlari va ishonchli topshirish paketi to‘liq bajariladi. Oraliq manager javobini kutmang. Yakun IN_REVIEW, global approval/registrlar read-only.

## 0. Kirish va jarayonni o‘zgartirish

START_HERE, TASK_INPUT, VERIFY_INPUT.py; keyin AGENTS.md, OWNER_DECISIONS01–05, USER_WORKING_PREFERENCES, ARGON_LEARNING va S11-S12-P manager review/evidence. Input — approved S01–S10 + to‘liq P candidate + managerning AppModule tiklashi. Eski ZIP/chat talab qilinmaydi. Mavjud source oldingi reportdan ustuvor.

P paketda 25 ta strict TypeScript xato va reportda bor, ZIPda yo‘q ikki muhim test fayli topildi. Shuning uchun yakuniy report source va arxiv tayyorlangandan KEYIN yozilsin. `ARTIFACT_PROOF.md`da har closure uchun haqiqiy path, eksport/interface, actual test nomi, test fayli SHA256 va ZIP entry bo‘lsin. Funksiya nomini o‘ylab topib test yozish taqiqlanadi; source’da yo‘q API uchun production wrapper qo‘shib testni aldash ham yechim emas. Cash-unit testlarni avvalgi real source kontraktlari bilan moslang; mavjud API o‘rniga parallel «minor» model yaratmang, 1 integer=1 so‘m saqlansin.

P01–P06 closure jadvali: old finding, root cause, actual source diff, mustaqil regression, actual command/result yoki NOT_RUN, archive path/hash. Compile/typecheck bajarilmasa «closure verified» yozmang. Offline cheklov source/test tayyorlashga to‘sqinlik qilmaydi, ammo PASS da’vosiga asos emas. Global register read-only; ijrochi o‘ziga APPROVED/reviewer yozmaydi.

## P01 — yetishmayotgan output va testlar

P report `apps/api/test/cash/cash-lifecycle.integration.test.ts` hamda `apps/api/test/database/migrations-and-drift.integration.test.ts` o‘zgarganini aytgan, lekin ZIPda ikkalasi ham yo‘q. Inputdagi nusxalar O04dagi eski 8 fail va populated upgrade coverage bo‘shlig‘ini saqlagan. Shu fayllarning haqiqiy tuzatishlarini qiling va output delta ichiga kiriting.

CASH-IT-01 clock oldinga surilganda winner actor identity saqlanib yangi JWT ishlatilsin; finally clock/token tiklansin. CASH-IT-05 canonical response remaining_debt_uzs/promise_id, actual promise state bilan assertions; fake total_student_remaining_debt_uzs yo‘q. CASH-IT-06 birinchi invoice to‘langanda boshqa invoice qarzi bor, student-level promise_date talabi fixtureda bajarilsin. CASH-IT-08 real DTO/enum/qarz preconditionlari. CASH-IT-09 drift fixture SQL drawer CHECKni buzmay, immutable source bilan mos kelmaydigan stored receipts+expected qiymatlarini birga o‘zgartirsin, finally tiklansin. Guard yoki CHECKni o‘chirib PASS qilmang.

O01 status va invalid DATE; O02 true empty shift vs source bor/ledger yo‘q va wrong method/direction/record identity; O03 6 migrationdan qolgan repeated partial payment / duplicate ACTIVE history bilan real Prisma migration7 upgrade + qayta deploy; O04 actual close-vs-payment, close-vs-expense, close-vs-payment-reversal va mustaqil rollback; O05 expense/reversal outbox once/dedup/rollback testlari executable bo‘lsin. CASH-IT-11..13 / DB-IT-21 nomlari matnda emas, haqiqiy test declaration va ishlaydigan assertions bo‘lsin. Test sonini moslash uchun eski assertionni o‘chirmang.

## P02 — AppModule va xavfsizlikni saqlash

Raw P AppModule DatabaseModule.register(config, customDatabaseService), global APP_GUARD/useExisting PermissionsGuard va ReadinessControllerni olib tashlagan: baza providerlari topilmay app bootstrap to‘xtaydi, ruxsat guardi ham yo‘qolgan. Manager bu faylni oldingi ishlaydigan shaklga qaytarib, faqat AttendanceModule importini qo‘shdi. **Inputdagi manager fixni saqlang**; config/tokens, custom DB test seam, least-privilege DatabaseService singleton, auth va /ready ishlasin.

Regression: Nest app real boot, /health200, /ready runtime checks, JWTsiz protected endpoint401, Teacher financial403, crosscenter deny, READ_ONLY mutation403 yoki documented per-opblockedack. Yangi va eski barcha controller methodlar @PublicBootstrap yoki @RequireRoutePolicy bilan; decorated methodlar mavjudligi globalguard o‘rnini bosmaydi. Faqat yangi Attendance modulini ulash uchun ishlaydigan AppModuleni qayta loyihalamang.

## P03 — barcha 25 compile xatoni source kontraktlari bilan yopish

1. attendance/dto.ts assertPlainObject 2argumentli, yangi callsite3argument yuborgan. Haqiqiy helper imzosiga moslang.
2. attendance test fixture avval billing_policy_versions.confirmed_by_director_id degan mavjud bo‘lmagan ustunni UPDATE qiladi va G9 before hook shu yerda to‘xtaydi (10 test cancelled). Canonical policy confirmation DTO/service yoki mavjud schema ustunlari bilan haqiqiy fixture tuzing. attendance test SYNTHETIC_PASSWORD_HASH nonexistent import va CB.lessonId nonexistent field. Mavjud seed fixture/hash API ishlating yoki seeded DBdagi haqiqiy test hashni oling; production hash/pass import yo‘q. CenterB uchun haqiqiy lesson fixture yarating; yo‘q UUID bilan404 crosscenter izolatsiya dalili emas.
3. cash-unit.test.ts mavjud bo‘lmagan ValidationException path va computeExpectedClosingCashMinor, computePaymentMethodBreakdown, computeShiftNetTotals, validate*Dto singari ko‘plab fake eksportlarga tayanadi. Haqiqiy CashModule source va oldingi testlarni o‘qing. Existing computeCanonicalShiftReconciliation/evaluatePromiseReminderEligibility/validate*Input API bo‘yicha meaningful testsni yozing; asosiy funksiyalarni o‘ylab topilgan testlarga mos qayta nomlamang. Implicit anyni any-cast bilan yashirmang.

npm ci/prisma generate/lint/strict typecheck/build/unit mavjud muhitda actual; offline NOT_RUN. JSni TypeScript xatolariga qaramay emit qilish faqat manager diagnostikasi edi, build PASS emas. Yangi tsx/dependency kerak bo‘lmasa npm scriptga kiritmang; real zarurat bo‘lsa package/lock strategy va needs_manager_dependency_refreshni aniq yozing.

## P04 — haqiqiy DB va HTTP kontraktlar

AttendanceService SELECT license_mode FROM center_licenses ishlatadi, schema esa license_status. Canonical PermissionsGuard/AuthService live license semantics bilan moslang; yangi soxta ustun qo‘shib eski xatoni yashirmang. Barcha yangi SELECT/UPDATE ustunlari haqiqiy schema bilan mos bo‘lsin: typed row interface SQLni tekshirmaydi. Real runtime role bilan positive submit, replay, revoke, READ_ONLY va rollback testlari kerak.

Report/testlarda /lessons/:id/attendance/excel-import va /override aytilgan, lekin AttendanceController bu route’larni ulamaagan. Sababli Admin/Director override va Excel command seam uchun haqiqiy controller/action/decoratorni ulang; Teacher403, SYSTEM/source spoof403. Agar bitta command dizayni saqlansa OpenAPI/test/reportni aniq moslang, lekin talab qilingan ikkala behavior real HTTP orqali ochiq va tekshirilgan bo‘lsin. Initial Teacher submitga Admin/Direktor impersonation bypass yo‘q.

OpenAPI P ZIPda yangilanmagan; yangi GET attendance va correction/import schemas/path/security/object-scope/operation inventoryni haqiqiy controller bilan moslang. docs/architecture/events.md ExpenseRecorded/ExpenseReversed/AttendanceCorrected va ularning payload/version/dedup/ordering kontraktlari bilan yangilansin. Faqat JSON parsing/ref PASS controller coverage yoki event contract proof emas. Testlar haqiqiy response field va returned versiondan foydalansin.

## P05 — davomat versiyasi, subset override va provenance

Hozir override loop barcha existing recordlarni yangilaydi, hatto faqat bitta student yuborilsa ham source_channel/recorded_by/version hammasida o‘zgaradi; revision/event esa faqat incoming studentlar uchun. Bu tegilmagan o‘quvchilar Teacher confirmation tarixini revision yozmasdan yo‘qotadi.

Faqat haqiqatan override qilingan recordlar update/revision/audit/event olsin; boshqalar byte-level metadata/status/version/provenance bo‘yicha saqlansin. Lesson transaction version va per-record revision versiyalarini aniq ajrating. expected_version/current server version haqiqiy persisted qiymat, current+1ni stale response’da soxta «server_version» sifatida ko‘rsatmang. Bir xil expected versionli parallel Admin correctiondan biri yutadi, ikkinchisi409; lost update yo‘q. Same status correction uchun no-op yoki versioned re-confirmation qoidasini aniq va izchil tanlang; event/audit bilan mos bo‘lsin.

Regression: kamida3student roster; Teacher submit; Admin faqat1studentni sabab bilan override qiladi; qolgan2record/source/actor/version/revisioncount aynan o‘zgarmagan. Teacher response/log/SQLite’da raw telefon, invoice/financial snapshot yoki private guardian data yo‘q. Trial activation result Teacherga faqat kerakli safe attendance ack sifatida qaytsin; moliyaviy DTOni qaytarib yubormang.

## P06 — S12 to‘liq functional acceptance va output discipline

Davomat draft GET/default PRESENT yozuv/event/trial/invoice yaratmaydi. Bir kunda2lesson alohida lesson+student unique. Primary Teacher va aynan1lesson substitute vakolati live, revoke/reassign old-key replaydan oldin403. Enrollment/date/freeze eligibility authoritative. Roster completeness, duplicates, missing/studentcrosscenter typed denies va0writes.

Offline sync actor/center/op UUID/hash scope, same payload replay, changed body409; per-operation ack va current version. Timeout/lostresponse/retry/mixedbatch haqiqiy SQLite protokolida; ACKsiz yoki CONFLICT holatidagi row SYNCED bo‘lmasin. Invalid/null server_version yoki lesson/op identity mos kelmasa successack deb qabul qilmang. Har command uchun actual source/hash/ack deterministic, fake network «success» yo‘q. Mobil framework/UI va full Excel import wizard yangi scope emas.

Stale Excel yangi Teacher/mobile yozuvini overwrite qilmaydi. Admin reason/expectedversion majburiy. Immutable AttendanceRevision va truthfully attributed before/after; original xabar Telegramdan o‘chirildi degan claim yo‘q. Outbox consumer integration S14gacha pending, real xabar yubormang.

Trial:1haqiqiydistinct PRESENT/LATE0qarz;2distinct lesson bitta activation/invoice, first_trial_date dan. Mavjud transactional TrialConversionService, historicaltariff/policy/rounding va durable package ownership saqlansin. Policy unconfirmed yoki injected failure bo‘lsa tanlangan atomiklik modeli bo‘yicha attendance/revision/trial/invoice/ledger/outbox/audit hammasi rollback yoki haqiqiy durablepending protocol, test-only deferredstub yo‘q. Attendance correction old invoice/activationni tasdiqlanmagan compensation bilan o‘zgartirmaydi. Freeze/discount/refund business gates saqlansin.

G1–G9 haqiqiy Postgres/HTTP; test:cash va test:attendance root/workspace scripts muvaffaqiyatli locked builddan keyin ishlasin. Docker health/ready smoke va fresh/populated migration deploy. Parallel submit/override/replay+revoke, partial batch rollback, append-only protections, date/TZ va JWT expiry cases alohida mustaqil assertions bilan. Qayta-qayta source count yoki «test nomi bor» dalilini PASS demang.

## Yakuniy paket — talablar

- docs/verification/S11-Q.md va S12-Q.md: har finding closure source/test va actual run/NOT_RUN. Eski manager evidence yoki original reportni o‘zgartirmang.
- ADR-011/012, schema/API/events/RBAC, S11/S12 handoff va step hisobotlari real source bilan mos bo‘lsin; statuses IN_REVIEW. S13 boshlanmaydi.
- `ARTIFACT_PROOF.md` actual input-vs-output delta, original input filecount, changed/new/deleted files va har claimning ZIP entry/hashini ko‘rsatsin.
- Manager reference `audit_submission.py` bilan extracted sourcega nisbatan outputZIPni tekshiring. Bu faqat packaging proof, runtime test emas. Scriptni o‘zgartirib talabni chetlab o‘tmang. Missing claimed files chiqarilsa ZIPni tuzatib qayta tekshiring.
- `S11S12FIX_Q_SUBMISSION.zip`: faqat shu INPUT_MANIFESTdan keyingi loyiha source delta + SUBMISSION.json. Metadata:task_id/base_commit/candidate_input_commit/statusIN_REVIEW/files[path,sha256]/deleted_files/actual_tests/not_run/needs_manager_dependency_refresh. Fake lock/generatedclient/pyc/secret/node_modules/dist/oldinputZIP yo‘q.

Source+test+CI+docs+arxiv bir paketda yakunlansin. Owner05 manual tashqi to‘lov qaydi saqlanadi; provider integration, haqiqiy pultransfer, payroll, S13, liveTelegram yoki production yo‘q. Keyingi stagega o‘tish uchun manager acceptance talab qilinadi; ushbu paketda faqat ikki bosqichni to‘liq tuzating.
