# EduERP v2.0 — Biznes Qoidalari, Moliyaviy Hisob-Kitoblar va Davomat/Kassa O‘tishlari Loyihasi (`docs/spec/business-rules.md`)

<a id="br-meta"></a>
- **Task / Step ID:** `S01-FIX-S02-FULL-D` / Step `01.02` (`T01.02` — `C01`, `C03`, `C04` tuzatishlari bilan yangilangan tahrir)
- **Base Commit:** `dbd2a673cf70f915d2812f10d120e496167c5ae7`
- **Asosiy manbalar:** `planning/source/MASTER_SOURCE_TEXT.md` (`PDF 3–6, 8-sahifalar`), `planning/05_DOMAIN_RULES.md`, `planning/02_DECISIONS.md` (`D03`–`D22`), `docs/spec/scope.md` (Step `01.01` `F01`–`F05` tuzatishlari bilan).
- **Hujjat maqomi:** `IN_REVIEW` (**Loyiha / Draft** — ushbu hujjat foydalanuvchi/markaz rahbari tomonidan tasdiqlangan yakuniy biznes siyosati emas. `SOURCE_RULE` manba PDFda aytilgan qoidani bildiradi; `PROPOSED` muhandislik/domen taklifini bildiradi; `OPEN` / `DECISION_REQUIRED` esa biznes egasi tasdig‘ini talab qiladigan siyosat bo‘lib, hech bir ochiq qaror yashirin `ACCEPTED` sifatida kodga kiritilmaydi).

---

<a id="sec-1-general-invariants"></a>
## 1. Umumiy Domen Invariantlari, Birliklar va Vaqt Chegaralari

1. **Pul birligi, Valyuta Scale va 100x xatolikdan himoya (`C03` tuzatishi, `03_ARCHITECTURE.md`, `05_DOMAIN_RULES.md`):**
   - **Aniq Pul Kontrakti (`PROPOSED Technical Baseline`):** O‘zbekiston so‘mi (`currency = "UZS"`) amaliyotda tiyinsiz (`scale = 0`, `minor_unit = 1 so'm`, ya’ni **1 butun son = 1 so‘m**) yuritiladi:
     - **PostgreSQL DB ustunlari:** `BIGINT` (`*_uzs`, masalan `amount_uzs = 280000` -> aniq `280,000 so'm`).
     - **OpenAPI / JSON kontraktlari:** kasrsiz butun sonli string (`pattern: "^-?[0-9]+$"`, masalan `"amount_uzs": "280000"`, `"currency": "UZS"`, `"scale": 0`).
     - **100 baravar (`so'm` vs `tiyin`) adashishdan himoya:** Bitta maydonda "so‘m yoki tiyin" deb ikki xil scale ishlatish **qat’iy taqiqlanadi**. Agar kelajakda tashqi to‘lov shlyuzi (`Click`/`Payme` — `D12`) tiyin (`1 so'm = 100 tiyin`, `scale = 2`) talab qilsa, konvertatsiya faqat tashqi gateway adapter chegarasida (`amount_tiyin = amount_uzs * 100`, masalan `400,000 so'm <-> 40,000,000 tiyin`) bajariladi; ichki domen va DB doimo `scale = 0` (`1 integer = 1 so'm`) da qoladi.
   - Bo‘lish amali qatnashgan hisoblarda (`(monthly_fee * remaining_lessons) / total_lessons` yoki foizli chegirma/maosh) yaxlitlash qoidasi `D14` qaroriga bog‘liq (`DECISION_REQUIRED`: `1 so'm HALF_UP` vs `1 000 so'm` yaxlitlash).
2. **Vaqt mintaqasi (Timezone) va sana chegaralari (`03_ARCHITECTURE.md`, `05_DOMAIN_RULES.md`):**
   - Server va DB timestamp’lari `UTC` da saqlanadi (`created_at`, `submitted_at`).
   - Dars jadvali (`LessonOccurrence`), kalendar oy boshlanishi/tugashi (`01`–`28/29/30/31`), kassa smenasi va ertalabki **soat `09:00`** va’da eslatmasi **markazning mahalliy vaqt mintaqasi (`center.timezone`, standart `Asia/Tashkent`, `UTC+05:00`)** bo‘yicha hisoblanadi.
   - Agar markaz vaqt mintaqasi o‘zgarsa, yopilgan tarixiy moliyaviy davrlar eski timezone snapshotini saqlaydi (`05_DOMAIN_RULES.md`).
3. **O‘zgarmaslik (Immutability) va Idempotency:**
   - Har qanday pul harakati (`Payment`, `Allocation`, `Refund`, `CashExpense`, `LedgerEntry`) **append-only** (faqat qo‘shiladi, `UPDATE`/`DELETE` taqiqlanadi — `D08`, `R10`).
   - Eski hisob-faktura (`Invoice`), yopilgan kassa smenasi (`CashShift`) va yopilgan oylik maosh (`PayrollSnapshot`) yashirincha qayta yozilmaydi; har qanday tuzatish sababli `CreditNote` / `DebitAdjustment` / `Reversal` orqali yangi yozuv sifatida kiritiladi.

---

<a id="sec-2-business-rules-catalog"></a>
## 2. Biznes Qoidalari Katalogi (`BR-01` – `BR-18`)

Har bir qoida barcha 13 ta majburiy atribut (`BR-ID`, `Manba / Origin`, `D-ID`, `Status`, `Actor`, `Trigger`, `Precondition`, `Input / Unit`, `Hisoblash yoki Transition`, `Expected Effect`, `Reject / Rollback`, `Idempotency`, `Affected Steps`) bilan tavsiflangan:

---

<a id="br-01"></a>
### `BR-01` — Kalendar Oy + Pro-Rata Hisob-Kitobi (A-Rejim)
- **BR-ID:** `BR-01`
- **Manba / Origin:** `PDF p.4 Sec 4.1 (A-Rejim: Kalendar Oy + Pro-Rata)` + `planning/05_DOMAIN_RULES.md` (`SOURCE_RULE` + `ENGINEERING_PROPOSAL`)
- **D-ID:** `D03`, `D14`, `D21`
- **Status:** `SOURCE_RULE` (Asosiy formula manbadan; yaxlitlash birligi va bekor qilingan dars ta’siri — `OPEN` / `DECISION_REQUIRED`)
- **Actor:** `Admin` (o‘quvchini guruhga qo‘shishda) yoki `Billing Worker` (oyning 1-sanasida navbatdagi oy uchun invoice chiqarishda); tekshiruvchi: `Rahbar`
- **Trigger:** O‘quvchi `A-Rejim (CALENDAR_PRO_RATA)` o‘rnatilgan guruhga oy o‘rtasida (masalan, 12-noyabrda) biriktirilishi yoki sinov darsidan (`TRIAL`) `ACTIVE` holatga o‘tishi; keyingi oylarda har oyning `1-sanasi` (`00:00` center timezone).
- **Precondition:** Guruh aktiv; o‘quvchi `Enrollment` statusi `ACTIVE` (yoki 2-trial darsda aktivlashgan); hisob-kitob davri (`billing_period = YYYY-MM`) uchun ushbu `enrollment_id` bo‘yicha aktiv `Invoice` hali mavjud emas; davrda rejalashtirilgan jami darslar soni `total_planned_lessons > 0`.
- **Input / Unit:**
  - `monthly_fee` — kursning 1 oylik bazaviy narxi (integer `UZS`, masalan `480000` so‘m);
  - `total_planned_lessons` — shu kalendar oyda guruh jadvali bo‘yicha rejalashtirilgan jami darslar soni (butun son, masalan `12` dars);
  - `remaining_Billable_lessons` — o‘quvchi qo‘shilgan (yoki 1-trialga kirgan) sanadan oy oxirigacha qolgan darslar soni (butun son, masalan `7` dars);
  - `rounding_policy` (`D14` — `OPEN`).
- **Hisoblash yoki Transition:**
  1. Agar o‘quvchi oyning 1-darsidan boshlab o‘qisa (`remaining == total`): `base_charge = monthly_fee`.
  2. Agar oy o‘rtasida qo‘shilsa (`0 < remaining < total`):
     $$ ext{raw\_charge} = rac{ ext{monthly\_fee}  imes  ext{remaining\_billable\_lessons}}{ ext{total\_planned\_lessons}}$$
     Manba misoli (`PDF p.4`): `480000 * 7 / 12 = 280000` so‘m (qoldiqsiz bo‘linadi).
  3. Agar bo‘linma kasr chiqsa (masalan, `500000 * 7 / 12 = 291666.66...`):
     - **A policy ostida (`ROUND_1_UZS_HALF_UP`):** `291667` so‘m;
     - **B policy ostida (`ROUND_1000_UZS_NEAREST`):** `292000` so‘m (`DECISION_REQUIRED: D14`).
  4. Agar `remaining_billable_lessons == 0` bo‘lsa: joriy oy uchun `base_charge = 0` so‘m (yoki keyingi oyning 1-sanasidan boshlanadi).
  5. Keyingi kalendar oyning 1-sanasidan (masalan, `1-dekabr`) boshlab to‘liq `monthly_fee` (`480000` so‘m) yoziladi (`PDF p.4`).
- **Expected Effect:** `Invoice` va `InvoiceLine` yaratiladi (`price_snapshot`, `policy_snapshot = CALENDAR_PRO_RATA`, `total_lessons = 12`, `billed_lessons = 7`, `gross_amount = 280000`); o‘quvchi qarzi `+280000` so‘mga oshadi; `AuditLog` yoziladi.
- **Reject / Rollback:** Agar `total_planned_lessons <= 0` bo‘lsa — `422 Unprocessable Entity (INVALID_SCHEDULE_ZERO_LESSONS)`, hisob chiqarish bloklanadi va DB o‘zgarmaydi (`T08.01`). Agar `remaining_billable_lessons > total_planned_lessons` bo‘lsa — `422`.
- **Idempotency va Billing-Cycle Identity (`C04` tuzatishi):**
  - Har bir hisob-kitob davri alohida `BillingCycle` yozuvi (`billing_cycle_id`) bilan ifodalanadi va `unique (enrollment_id, cycle_type, cycle_key)` chekloviga ega:
    1. **Kalendar oy (`cycle_type = CALENDAR_MONTH`):** `cycle_key = "YYYY-MM"` (masalan, `"2026-11"`). Bir oyda bitta enrollment uchun faqat 1 ta asosiy invoice chiqadi.
    2. **Rolling month (`cycle_type = ROLLING_MONTH`):** `cycle_key = "ROLLING:<period_start_date>:<period_end_date>"` (masalan, `"ROLLING:2026-11-12:2026-12-11"`).
    3. **12-darslik paket (`cycle_type = LESSON_PACKAGE_12`):** `cycle_key = "PKG:<package_seq>"` (`PKG:1`, `PKG:2`, ...). Agar intensiv guruhda o‘quvchi bitta kalendar oyda birinchi 12-darslik paketni (`PKG:1`) tugatib, shu oyning o‘zida ikkinchi 12-darslik paketni (`PKG:2`) boshlasa, `cycle_key` (`PKG:1` vs `PKG:2`) farqli bo‘lgani uchun bitta oyda **2 ta alohida qonuniy `Invoice`** yaratiladi; ayni `PKG:1` uchun retry kelganda esa dublikat yaratilmaydi (`1 invoice`).
- **Affected Steps:** `01.02`, `01.04`, `02.02`, `04.01`, `08.01`, `08.02`, `08.04`, `23.01`.

---

<a id="br-02"></a>
### `BR-02` — Individual Davr (Rolling Month) va 12 ta Dars Abonement Rejimlari (B-Rejim)
- **BR-ID:** `BR-02`
- **Manba / Origin:** `PDF p.4 Sec 4.1 (B-Rejim: Individual 12 ta Dars / Abonement)` + `planning/02_DECISIONS.md` (`D03`, `D21`)
- **D-ID:** `D03`, `D21`
- **Status:** `OPEN` / `DECISION_REQUIRED` (PDFda *"keyingi to‘lov muddati aniq 12-dekabr (yoki 12 ta dars tugaydigan kun)"* deb ikki xil mexanizm bitta jumlada berilgan; `D03` va `D21` ularni ikkita alohida siyosat sifatida ajratadi)
- **Actor:** `Admin` (enrollment yaratishda), `Attendance Service` / `Billing Worker` (dars sarfi yoki muddat yangilanishida)
- **Trigger:** O‘quvchi B-Rejimdagi guruhga `start_date` sanasida (masalan, `2026-11-12` yoki `2026-01-31`) qabul qilinishi yoki joriy paket/oy tugashi.
- **Precondition:** Markaz yoki guruh sozlamasida `BILLING_MODE` aniq tanlangan bo‘lishi kerak: `B1_ROLLING_MONTH` yoki `B2_LESSON_PACKAGE_12`.
- **Input / Unit:** `start_date` (`YYYY-MM-DD`), `package_price` (integer `UZS`), `package_size` (standart `12` dars), `lesson_status` (`PRESENT`, `LATE`, `ABSENT_UNEXCUSED`, `ABSENT_FROZEN`, `LESSON_CANCELLED_BY_CENTER`).
- **Hisoblash yoki Transition:**
  1. **Variant B1 (`ROLLING_MONTH` — Sanadan-sanaga kalendar oy, `D03`/`D21`):**
     - `12-noyabr` da boshlasa -> keyingi to‘lov sanasi `12-dekabr`.
     - **Oy oxiri (Month-end `31-sana` -> `28/29/30-sana`) chegarasi (`D21` — `DECISION_REQUIRED`):** O‘quvchi `31-yanvar` da qo‘shilsa:
       - **A policy ostida (`CLAMP_TO_MONTH_END_ANCHOR_31`):** Kabisa bo‘lmagan yili (masalan, `2026-02-28`) keyingi to‘lov `28-fevral`, kabisa yili (`2028-02-29`) `29-fevral`, mart oyida esa dastlabki anchor tiklanib `31-mart` (yoki doimiy `28-sana` — `B policy`);
       - Qaror qabul qilinmaguncha testda ikkala alternativa aniq sanalar bilan tekshiriladi (`CASE-03`).
  2. **Variant B2 (`LESSON_PACKAGE_12` — 12 ta darslik abonement paketi, `D03`/`D21`):**
     - O‘quvchi hisobiga `remaining_package_lessons = 12` yoziladi.
     - **Dars sarflanishi (`D21` — `DECISION_REQUIRED`):**
       - `PRESENT`, `LATE` va sababsiz kelmaslik (`ABSENT_UNEXCUSED`) -> `remaining_package_lessons` 1 taga kamayadi (`-1`).
       - Sababli muzlatish (`ABSENT_FROZEN`) -> dars sarflanmaydi (`0`).
       - Markaz/o‘qituvchi tomonidan dars bekor qilinsa (`LESSON_CANCELLED_BY_CENTER`):
         - **A policy ostida (`CENTER_CANCEL_PRESERVES_BALANCE` — tavsiya):** O‘quvchining 12 ta dars balansidan **yechilmaydi** (`remaining` o‘zgarmaydi, paket tugash sanasi 1 darsga suriladi);
         - **B policy ostida (`CENTER_CANCEL_CREDITS_NEXT_INVOICE`):** Jadval davri o‘zgarmaydi, keyingi invoicega 1 darslik `CreditNote` beriladi (`DECISION_REQUIRED: D21`).
- **Expected Effect:** Tanlangan rejim `Invoice.policy_snapshot` da muhrlanadi; keyingi to‘lov sanasi (`next_due_date`) ota-ona kvitansiyasida va Admin jadvalida ko‘rinadi (`PDF p.4`).
- **Reject / Rollback:** Guruhda billing rejimi (`A`, `B1`, `B2`) tanlanmagan bo‘lsa — enrollment/invoice yaratish `422 BILLING_POLICY_NOT_CONFIGURED` bilan rad etiladi.
- **Idempotency:** Har bir `lesson_id` + `student_id` davomat hodisasi paket balansidan ko‘pi bilan 1 marta dars yechadi (`package_consumption_ledger` unique `(enrollment_id, lesson_id)`).
- **Affected Steps:** `01.02`, `01.04`, `07.02`, `08.02`, `08.04`, `12.04`.

---

<a id="br-03"></a>
### `BR-03` — Sinov Darsi (`Trial Lesson`), 2-Darsda Faollashish va Qaytib Kelmaganlar (`No-Show Follow-Up`)
- **BR-ID:** `BR-03`
- **Manba / Origin:** `PDF p.4 Sec 4.2 (Sinov Darsi / Trial Lesson Mantiqi)` + `planning/05_DOMAIN_RULES.md`, `06_INTEGRATION_GATES.md`, `08_BUGHUNT_REPORT.md` (`B04`, `B17`)
- **D-ID:** `D07`, `D14`
- **Status:** `SOURCE_RULE` (1-darsda qarz yozilmasligi va 2-darsda faollashib 1-darsdan hisoblanishi manbadan; no-show muddati va xato davomatni bekor qilish — `OPEN: D14`)
- **Actor:** `Admin` (Trial ro‘yxatga olish va follow-up qo‘ng‘iroq), `Teacher` (davomatni submit qilish), `Billing / Scheduler Worker`
- **Trigger:**
  1. Yangi o‘quvchi guruhga `status = TRIAL` bilan qo‘shilishi;
  2. O‘qituvchi dars davomatini submit qilishi (`AttendanceSubmitted`);
  3. Rejalashtirilgan `TrialNoShowFollowUpJob` ishga tushishi.
- **Precondition:** O‘quvchi `Enrollment.status == TRIAL`; dars occurrence `Lesson.status != CANCELLED`.
- **Input / Unit:** `enrollment_id`, `lesson_id`, `attendance_status` (`PRESENT` | `LATE` | `ABSENT`), `first_trial_lesson_date`.
- **Hisoblash yoki Transition:**
  1. **1-haqiqiy qatnashuv (`attended_trial_count == 1`, status `PRESENT` yoki `LATE`):**
     - `Enrollment.status` `TRIAL` ligicha qoladi; `first_trial_lesson_id` va `first_trial_date` saqlanadi;
     - **Qarz va Invoice = `0` so‘m** (`PDF p.4`: *"Bu dars uchun unga qarz yozilmaydi"*).
  2. **2-alohida (distinct) haqiqiy qatnashuv (`attended_trial_count == 2`, `lesson_id != first_trial_lesson_id`, status `PRESENT` yoki `LATE`):**
     - `Enrollment.status`: `TRIAL` -> `ACTIVE`;
     - `Billing Service` ga `ActivateTrialEnrollmentCommand` yuboriladi va **1-sinov darsi sanasidan (`first_trial_date`) boshlab** (1-darsni ham qo‘shgan holda) `BR-01` yoki `BR-02` bo‘yicha bitta `Invoice` chiqariladi (`PDF p.4`: *"1-darsdan boshlab oylik to‘lovni hisoblaydi"*).
  3. **1-darsdan keyin kelmasa (`No-Show / Drop after 1st trial`):**
     - `Enrollment.status` `ACTIVE` ga o‘tmaydi, qarz = `0` so‘m;
     - Adminga *"Sinov darsidan keyin qaytib kelmadi — qo‘ng‘iroq qilib sababini so‘rang"* follow-up vazifasi yaratiladi (`PDF p.4`, `R07`, `R13.04`). Follow-up qachon ochilishi (`D14` — `OPEN`): **A policy:** 2-rejalashtirilgan darsda `ABSENT` bo‘lishi bilan; **B policy:** 1-sinov darsidan `N` soat/kun o‘tgach (`DECISION_REQUIRED: D14`).
  4. **Davomat xatosini tuzatish, Kompensatsiya va Qayta Faollashish (`Trial Activation -> Compensation -> Valid Reactivation` — `C04` tuzatishi, `B04`):**
     - Agar o‘qituvchi `L2` darsda adashib `PRESENT` bosgani sababli `Enrollment` `ACTIVE` ga o‘tgan (`trial_activation_seq = 1`, `Invoice #1 = 280,000` so‘m) bo‘lsa va Admin sababli override bilan `L2` davomatini `ABSENT` ga tuzatsa (`AttendanceCorrected`):
       1. `TrialCompensated` hodisasi chiqariladi; `Invoice #1` to‘liq `CreditNote (-280,000 so'm, reason = TRIAL_CORRECTION_VOID)` bilan kompensatsiya qilinib (`net_charge = 0`, status `VOID_COMPENSATED`), `Enrollment.status` yana `TRIAL` holatiga qaytariladi (`active_trial_activation_id = NULL`).
       2. Agar o‘quvchi keyingi `L3` (`L3 != L1, L3 != L2`) darsga haqiqatan kelsa (`2-distinct haqiqiy qatnashuv`), tizim yangi aktivlashishni xato bloklamaydi: `trial_activation_seq = 2` bilan `TrialActivated` hodisasi va yangi `BillingCycle` (`Invoice #2 = 280,000` so‘m, `L1` sanasidan boshlab) chiqariladi; yakuniy sof hisob (`Net Charge`) = `280,000 - 280,000 + 280,000 = 280,000` so‘m (eski bekor qilingan invoice ikki marta qarz yozmaydi).
- **Expected Effect:** 1-darsda `debt = 0`; 2-distinct darsda aniq 1 ta faol `Invoice` va `ACTIVE` holat; noto‘g‘ri davomat tuzatilganda kompensatsiya va keyingi haqiqiy darsda to‘siqsiz qayta aktivlashish.
- **Reject / Rollback:** Bir xil `lesson_id` uchun davomat qayta yuborilsa (retransmit/retry) yoki bitta dars ichida draft/submit takrorlansa, u "2-dars" sifatida hisoblanmaydi (`distinct lesson_id` tekshiruvi — `T08.03`, `T12.04`).
- **Idempotency (`C04` tuzatishi):** Doimiy `(enrollment_id, "TRIAL_ACTIVATION")` kaliti o‘rniga **`unique (enrollment_id, trial_activation_seq)`** va PostgreSQL partial unique index **`UNIQUE (enrollment_id) WHERE status = 'ACTIVE_ACTIVATION'`** ishlatiladi. Shu sababli ayni `trial_activation_seq` retryda ikkinchi invoice yaratmaydi, ammo `COMPENSATED` bo‘lgandan keyin yangi `trial_activation_seq + 1` bilan qonuniy qayta aktivlashishga ruxsat beradi (`CASE-05`, `CASE-06`).
- **Affected Steps:** `01.02`, `01.04`, `06.03`, `08.03`, `12.04`, `13.04`.

---

<a id="br-04"></a>
### `BR-04` — Oilaviy Chegirma, Foiz/Fiks Chegirmalar, 50% Maxsus Chegirma va 100% Grant (Rahbar Tasdig‘i)
- **BR-ID:** `BR-04`
- **Manba / Origin:** `PDF p.3 Sec 3 (Rahbar)` & `p.4–5 Sec 4.3 (Chegirmalar va 100% Grant)` + `planning/05_DOMAIN_RULES.md`
- **D-ID:** `D06`, `D14`
- **Status:** `SOURCE_RULE` (Sabab, amal qilish muddati va Rahbar tasdig‘isiz kuchga kirmasligi manbadan; oilaviy chegirma miqdori va bir nechta chegirma qo‘shilishi / stacking — `OPEN: D14`)
- **Actor:** `Admin` (so‘rov yaratuvchi), `Rahbar / Direktor` (Staff App, Veb yoki Rahbar Bot orqali tasdiqlovchi — `D06`)
- **Trigger:**
  1. Bitta ota-ona (`Guardian`) telefon raqamiga 2 yoki undan ortiq farzand (yoki bitta o‘quvchi bir nechta kursga) biriktirilganda tizim "Oilaviy chegirma" taklifini chiqaradi (`PDF p.4`);
  2. Admin 50% maxsus chegirma, fiks/foiz chegirma yoki 100% bepul (`GRANT`) talaba so‘rovini kiritadi;
  3. Rahbar tasdiqlash (`APPROVE`) yoki rad etish (`REJECT`) tugmasini bosadi.
- **Precondition:** `reason` (chegirma sababi) va `valid_until` / `period_scope` (amal qilish muddati) majburiy to‘ldirilgan bo‘lishi shart (`PDF p.4`, `T09.01`). Foizli chegirma `0 < percent <= 100`, fiks chegirma `0 < fixed_amount <= base_charge`.
- **Input / Unit:** `discount_type` (`FAMILY` | `SPECIAL_PERCENT` | `FIXED_AMOUNT` | `FULL_GRANT_100`), `value` (foiz yoki integer `UZS`), `reason` (string), `valid_from`, `valid_until`, `approved_by_director_id`.
- **Hisoblash yoki Transition:**
  1. **So‘rov bosqichi (`PENDING_APPROVAL`):** Admin chegirma kiritganda `DiscountRequest.status = PENDING_APPROVAL` yaratiladi. **Bu bosqichda `Invoice` summasi va o‘quvchi qarzi O‘ZGARMAYDI** (`PDF p.4–5`: *"Rahbar tasdiqlamaguncha chegirma kuchga kirmaydi!"*, `T09.01`).
  2. **Rahbar tasdig‘i (`APPROVED`):** Rahbar Veb/Ilovada yoki Rahbar Telegram botidagi inline tugma orqali (Backend Command API — `D06`) tasdiqlagach:
     - **50% chegirma misoli:** `base_charge = 480000` so‘m -> `discount = 240000` so‘m -> `net_charge = 240000` so‘m (`CASE-07`).
     - **100% Grant (`FULL_GRANT_100`) misoli:** `base_charge = 480000` so‘m -> `discount = 480000` so‘m -> `net_charge = 0` so‘m, `debt = 0` so‘m. Grant o‘quvchiga hech qanday soxta naqd to‘lov (`Cash Receipt`) yoki pul qaytarish (`Cash Refund`) yozilmaydi (`T09.03`, `T18.01`, `CASE-08`).
  3. **Bir nechta chegirma qo‘shilishi (Discount Stacking — `D14` `DECISION_REQUIRED`):** Agar o‘quvchida ham oilaviy chegirma (masalan, `50000` so‘m fiks), ham `50%` chegirma bo‘lsa (`base = 480000` so‘m):
     - **A policy ostida (`EXCLUSIVE_HIGHEST_WINS` — faqat eng kattasi qo‘llanadi):** `net_charge = 240000` so‘m;
     - **B policy ostida (`FIXED_THEN_PERCENT` — avval fiks, keyin foiz):** `(480000 - 50000) * 50% = 215000` so‘m;
     - **C policy ostida (`PERCENT_THEN_FIXED` — avval foiz, keyin fiks):** `(480000 * 50%) - 50000 = 190000` so‘m (`CASE-09`).
  4. **Amal qilish muddati tugashi (`EXPIRED`):** `valid_until < current_period_start` bo‘lganda chegirma yangi davr invoice’iga avtomatik qo‘llanmaydi (`CASE-10`).
- **Expected Effect:** Rahbarga tasdiqlash so‘rovi boradi; tasdiqlanganda `DiscountApplication` / `CreditNote` yozilib `net_charge` kamayadi va `AuditLog` ga Rahbar IDsi hamda vaqti muhrlanadi.
- **Reject / Rollback:** Admin yoki Teacher `APPROVE` endpointini chaqirsa — `403 Forbidden`. Sabab yoki muddat bo‘sh bo‘lsa — `422`. Ikki marta parallel `APPROVE` bosilsa (`05_DOMAIN_RULES.md`) — atomic `status/version` compare orqali faqat birinchisi o‘tadi, ikkinchisi `409 Conflict` / idempotent `200` qaytaradi (`T09.02`).
- **Idempotency:** `(invoice_id, discount_request_id)` unique; bitta tasdiq bitta marta chegirma yozadi.
- **Affected Steps:** `01.02`, `01.04`, `09.01`, `09.02`, `14.02`, `15.04`.

---

<a id="br-05"></a>
### `BR-05` — Qisman To‘lov (Bo‘lib To‘lash), Majburiy "Va’da Sanasi" (`Promise-to-Pay`) va 09:00 Eslatma
- **BR-ID:** `BR-05`
- **Manba / Origin:** `PDF p.5 Sec 4.4 (Qisman To'lov, Qarz va Va'da Sanasi)` + `planning/05_DOMAIN_RULES.md`, `08_BUGHUNT_REPORT.md` (`B03`)
- **D-ID:** `D12`, `OPEN_CHANNEL_02`
- **Status:** `SOURCE_RULE` (Qarz qolganda va’da sanasi majburiyligi va 09:00 da Admin + ota-ona botiga eslatma manbadan; payment+promise atomik tranzaksiyasi — `B03` muhandislik invarianti)
- **Actor:** `Admin` (to‘lov va va’da sanasini kirituvchi), `Scheduler Worker` (`09:00` eslatma yuboruvchi), `Ota-ona` (Telegram botda eslatma oluvchi)
- **Trigger:**
  1. Admin o‘quvchi uchun to‘lov kiritganda to‘lov summasi mavjud qarzdan kam bo‘lishi (`payment_amount < current_debt`);
  2. Markaz vaqti bilan va’da sanasi (`promise_date`) kuni ertalab soat `09:00` bo‘lishi.
- **Precondition:** Ochiq kassa smenasi (`CashShift.status == OPEN`, naqd to‘lov uchun — `T11.01`); `payment_amount > 0`. Agar to‘lovdan keyin `remaining_debt = net_invoice_charge - total_allocated_payments - applied_credits > 0` qolsa, komanda ichida yaroqli `promise_date` (`promise_date >= today_center_tz`) bo‘lishi shart.
- **Input / Unit:** `student_id`, `invoice_id`, `payment_amount` (integer `UZS`, masalan `300000`), `payment_method` (`CASH` | `CARD` | `CLICK` | `PAYME` | `TRANSFER`), `promise_date` (`YYYY-MM-DD`, masalan `2026-11-15`), `idempotency_key`.
- **Hisoblash yoki Transition:**
  1. Manba misoli (`PDF p.5`): Kurs narxi `500000` so‘m, hozir to‘landi `300000` so‘m -> `remaining_debt = 500000 - 300000 = 200000` so‘m (`CASE-11`).
  2. **Atomiklik (`B03`, `T11.03`):** `RecordPaymentCommand` bitta DB tranzaksiyasida `Payment` + `Allocation` + `PromiseToPay(due_date = 2026-11-15, amount = 200000, status = ACTIVE)` + `AuditLog` + `Outbox(Receipt)` yozuvlarini yaratadi.
  3. **Qarz muddatidan oldin yopilsa:** Agar ota-ona `15-noyabr` soat `09:00` gacha qolgan `200000` so‘mni to‘lasa (yoki grant/credit bilan `remaining_debt == 0` bo‘lsa), `PromiseToPay.status` avtomatik `FULFILLED` / `CANCELLED` ga o‘tadi (`T11.03`).
  4. **Soat `09:00` eslatmasi (`T13.02`):** `promise_date` kuni soat `09:00` (center timezone) da worker bazadan `remaining_debt` ni qayta o‘qiydi. Agar `remaining_debt > 0` bo‘lsa, Adminga va ota-onaning Telegram botiga muloyim eslatma yuboriladi; agar `remaining_debt == 0` bo‘lsa, eslatma yuborilmaydi.
- **Expected Effect:** `300000` so‘m to‘lov, `200000` so‘m qarz va `15-noyabr` va’da sanasi saqlanadi; kvitansiya ketadi; va’da kuni qarz qolgan bo‘lsagina `09:00` da eslatma yuboriladi.
- **Reject / Rollback:** Agar `remaining_debt > 0` bo‘lib, `promise_date` berilmagan yoki o‘tib ketgan sana bo‘lsa — butun tranzaksiya rollback qilinadi (`422 PROMISE_DATE_REQUIRED_FOR_PARTIAL_PAYMENT`, to‘lov ham bazaga yozilmaydi — `T11.03`, `CASE-11`).
- **Idempotency:** Payment `idempotency_key` (`actor + center + key`); `09:00` eslatmasi uchun `(promise_id, reminder_date)` unique outbox key (`T13.02`).
- **Affected Steps:** `01.02`, `10.01`, `10.02`, `11.03`, `13.02`, `14.03`, `15.02`.

---

<a id="br-06"></a>
### `BR-06` — Ortiqcha To‘lov (`Overpayment`), `Unapplied Credit` va Ko‘p Invoicega Taqsimlash (`Allocation`)
- **BR-ID:** `BR-06`
- **Manba / Origin:** `planning/05_DOMAIN_RULES.md` + `requirements.csv` (`R10.02`, `T10.02`, `B24`) (`ENGINEERING_PROPOSAL`)
- **D-ID:** `D22`
- **Status:** `PROPOSED` (`05_DOMAIN_RULES.md` majburiy domen invarianti)
- **Actor:** `Admin` (to‘lov kirituvchi), `Billing Worker` (keyingi oy invoice chiqarilganda kreditni qo‘llovchi)
- **Trigger:** To‘lov summasi joriy ochiq invoice qarzidan katta bo‘lganda (`payment_amount > open_invoice_debt`).
- **Precondition:** `payment_amount > 0`.
- **Input / Unit:** `invoice_debt = 500000` so‘m, `payment_amount = 600000` so‘m (`CASE-12`).
- **Hisoblash yoki Transition:**
  1. Joriy invoicega `allocated_amount = min(payment_amount, invoice_debt) = 500000` so‘m yo‘naltiriladi -> `invoice_debt = 0` (`PAID`).
  2. Ortiqcha qolgan `600000 - 500000 = 100000` so‘m manfiy qarz (`-100000`) sifatida emas, balki alohida **`UnappliedCredit = 100000` so‘m** sifatida o‘quvchi balansida saqlanadi (`05_DOMAIN_RULES.md`: *"Overpayment manfiy qarz emas, unapplied credit"*, `T10.02`).
  3. Agar o‘quvchining bir nechta ochiq invoice’i bo‘lsa, to‘lov eng eski invoice’dan boshlab (`FIFO` bo‘yicha yoki Admin tanlagan invoice’larga) taqsimlanadi; barcha `Allocation` summalari yig‘indisi `payment_amount` dan oshmasligi shart (`sum(allocations) + unapplied_credit == payment_amount`).
- **Expected Effect:** `Invoice` qarzi `0` so‘m, `UnappliedCredit = 100000` so‘m; keyingi davr invoice chiqqanda ushbu kredit avtomatik (yoki tasdiqlangan tartibda) qo‘llanadi.
- **Reject / Rollback:** `sum(allocations) > payment_amount` bo‘lsa — DB constraint / xizmat darajasida `422 ALLOCATION_EXCEEDS_PAYMENT` bilan rollback qilinadi.
- **Idempotency:** Payment `idempotency_key` va `Allocation` unique `(payment_id, invoice_id)`.
- **Affected Steps:** `01.02`, `04.01`, `08.04`, `10.02`, `18.01`.

---

<a id="br-07"></a>
### `BR-07` — O‘zgarmas Jurnal (`Immutable Ledger`), Xatoni To‘g‘irlash (`Storno / Reversal`), `Refund` va Rahbar Qizil Ogohlantirishi
- **BR-ID:** `BR-07`
- **Manba / Origin:** `PDF p.3 Sec 3 (Rahbar Xavfsizlik Auditi)` & `p.5 Sec 4.5 (Anti-Fraud Cash Control: Immutable Ledger, Storno / Refund)` + `planning/05_DOMAIN_RULES.md`
- **D-ID:** `D06`, `D08`, `D22`
- **Status:** `SOURCE_RULE` (O‘chirish taqiqi, sababli tuzatish so‘rovi va Rahbarga qizil ogohlantirish manbadan; `CreditNote` vs `Cash Refund` hamda refunddan keyin qarzni qayta ochish — `PROPOSED` / `OPEN: D22`)
- **Actor:** `Admin` (tuzatish/storno so‘rovi yuboruvchi), `Rahbar` (tasdiqlovchi va qizil alert oluvchi)
- **Trigger:** Admin to‘lov kiritishda xato qilsa (manba misoli: `400,000` so‘m o‘rniga `4,000,000` so‘m yozib yuborsa — `PDF p.5`) yoki o‘quvchiga pul qaytarish (`Cash Refund`) talab qilinsa.
- **Precondition:** Asl `Payment` bazada mavjud; `reversal_reason` bo‘sh emas; qaytarilayotgan summa asl to‘lovning qaytarilmagan qoldig‘idan oshmasligi shart (`refund_or_reversal_amount <= payment.remaining_reversible_amount`).
- **Input / Unit:** `original_payment_id`, `reason` (string), `correction_type` (`FULL_STORNO_REVERSAL` | `PARTIAL_CASH_REFUND`), `new_correct_amount` (ixtiyoriy, masalan `400000` so‘m).
- **Hisoblash yoki Transition:**
  1. **O‘chirish qat’iy taqiqlangan (`Immutable Ledger`):** Runtime DB foydalanuvchisida `ledger_entries` va `payments` jadvallarida `UPDATE` / `DELETE` huquqi yo‘q (`D08`, `T04.02`).
  2. **So‘rov va Qizil Alert (`PDF p.3, 5`):** Admin "Tuzatish so‘rovi" tugmasini bosib sababini yozishi bilan `ReversalRequest(status = PENDING)` ochiladi va **darhol Rahbarning ilovasiga hamda Telegram botiga qizil ogohlantirish** yuboriladi.
  3. **Manba misoli (`4,000,000` -> `400,000` so‘m — `CASE-13`, `T10.03`):**
     - Asl yozuv: `Payment #1 = +4,000,000` so‘m (o‘zgarmasdan qoladi, tarixda qizil storno belgisi bilan ko‘rinadi);
     - Rahbar tasdiqlagach: append-only `Reversal Entry = -4,000,000` so‘m (`reverses_payment_id = #1`) va to‘g‘ri `Payment #2 = +400,000` so‘m yoziladi;
     - **Yakuniy sof tushum (`Net Paid`):** `4,000,000 - 4,000,000 + 400,000 = 400,000` so‘m.
  4. **Haqiqiy pul qaytarish (`Refund`), Qaytarish Usuli (`refund_method`) va Qarzni qayta ochish (`C03` tuzatishi, `D22` — `DECISION_REQUIRED`):**
     - Har bir `Refund` yozuvida majburiy **`refund_method` (`CASH` | `CARD` | `CLICK` | `PAYME` | `TRANSFER`)** maydoni bo‘ladi (standart qoida: asl to‘lovning `payment_method` iga teng yoki Rahbar tasdiqlagan usul).
     - **Kassa smenasiga ta’siri (`C03` invarianti):** Faqat va faqat **`refund_method == CASH`** bo‘lgan qaytarishlar smenaning fizik naqd qoldig‘idan (`expected_closing_cash`) ayiriladi (`cash_refunds`). Agar `refund_method` naqd bo‘lmasa (`CARD`, `CLICK`, `PAYME`, `TRANSFER`), u `non_cash_refunds` satrida hisobga olinadi va fizik naqd kassani kamaytirmaydi (`BR-09`, `CASE-14`, `CASE-18`).
     - Invoice qarzi qanday o‘zgarishi `D22` qaroriga bog‘liq:
       - **A policy ostida (`REOPEN_INVOICE_DEBT` — xato to‘lov qaytarilganda, o‘quvchi o‘qishni davom ettirsa):** Allocation bekor qilinib, invoice qarzi `+R` so‘mga qayta ochiladi;
       - **B policy ostida (`WITHDRAWAL_CREDIT_NOTE_CLOSE` — o‘quvchi markazdan ketayotgani uchun qolgan darslar puli qaytarilsa):** Avval qolgan darslar uchun `CreditNote (-R)` bilan invoice charge kamaytiriladi, so‘ng `+R` ortiqcha to‘lov `Cash Refund (-R)` bilan qaytariladi, yakuniy qarz `0` so‘m bo‘lib qoladi (`CASE-14`).
- **Expected Effect:** Asl yozuv saqlanadi; append-only reversal yoziladi; Rahbarga qizil Telegram alert ketadi; audit logda qizil tarix qoladi.
- **Reject / Rollback:** `DELETE` / `UPDATE` urinishi DB darajasida rad etiladi; `sum(reversals) > original_payment` bo‘lsa `422 REFUND_CAP_EXCEEDED`; ikki Rahbar parallel tasdiqlasa atomic lock orqali faqat bitta reversal yoziladi (`CASE-14`, `T10.03`).
- **Idempotency:** `reversal_request_id` bo‘yicha unique ledger entry.
- **Affected Steps:** `01.02`, `01.04`, `04.02`, `10.03`, `11.04`, `14.03`, `15.04`.

---

<a id="br-08"></a>
### `BR-08` — Dars Qoldirish (`Unexcused Absence`), Sababli Muzlatish (`Freeze`) va Ketgan O‘quvchilar (`Churn` 5 Sababi)
- **BR-ID:** `BR-08`
- **Manba / Origin:** `PDF p.5 Sec 4.6 (Dars Qoldirish, Muzlatish va Ketgan O'quvchilar)` + `planning/05_DOMAIN_RULES.md`
- **D-ID:** `D14`
- **Status:** `SOURCE_RULE` (Sababsiz dars puli kuyishi, sababli Freeze keyingi oyga o‘tishi va ketishda 5 ta sababdan birini tanlash shartligi manbadan; Freeze kreditini hisoblash formulasi — `OPEN: D14`)
- **Actor:** `Admin` (Freeze va Churn rasmiylashtiruvchi), `Teacher` (davomat belgilovchi), `Rahbar` (oy oxirida churn tahlilini ko‘ruvchi)
- **Trigger:**
  1. O‘quvchi sababsiz darsga kelmasligi (`ABSENT_UNEXCUSED`);
  2. O‘quvchi kasallik ma’lumotnomasi keltirishi yoki oldindan ogohlantirib (masalan, 2 haftaga) muzlatishi (`FREEZE`);
  3. O‘quvchi guruhdan chiqishi (`WITHDRAW` / `LEFT`).
- **Precondition:** Freeze uchun `freeze_start_date <= freeze_end_date` va asos (`medical_note` yoki `prior_notice_reason`) kiritilgan bo‘lishi shart. Churn uchun 5 ta sabab kodidan aniq bittasi tanlanishi shart.
- **Input / Unit:** `enrollment_id`, `freeze_start_date`, `freeze_end_date`, `churn_reason_code` in `{1, 2, 3, 4, 5}`.
- **Hisoblash yoki Transition:**
  1. **Sababsiz dars qoldirish (`Unexcused Absence` — `CASE-16`):**
     - O‘quvchi ogohlantirishsiz/hujjatsiz darsga kelmasa, **puli kuyadi (qayta hisoblanmaydi)** (`PDF p.5`). `Invoice` summasi kamaymaydi, kredit berilmaydi.
  2. **Sababli Muzlatish (`Freeze` — `CASE-15`, `T09.03`):**
     - `[freeze_start_date, freeze_end_date]` oralig‘iga tushgan rejalashtirilgan va bekor qilinmagan (`status != CANCELLED`) darslar soni `frozen_lessons` aniqlanadi.
     - **Kesishgan (Overlapping) Freeze himoyasi:** Agar bitta dars sanasi ikki marta freeze oralig‘iga tushsa yoki o‘sha dars markaz tomonidan bekor qilingan bo‘lsa, har bir `lesson_id` uchun ko‘pi bilan **1 marta** kredit hisoblanadi (`no double credit` — `T09.03`).
     - **Chegirma, Pro-Rata va Oldingi Kredit bilan Freeze Hisobining Asosi hamda Yuqori Chegarasi (`Freeze Basis & Cap` — `C03` tuzatishi, `D14` `DECISION_REQUIRED`):**
       - **Muammo (`C03`):** Agar `gross_tariff = 480,000` so‘m (`12` dars) bo‘lgan o‘quvchida `50%` chegirma bo‘lsa (`invoice.net_charge = 240,000` so‘m) va u `6` ta darsni muzlatsa, kredit `gross_tariff` (`480,000 * 6 / 12 = 240,000`) dan hisoblansa, o‘quvchi o‘qigan `6` ta darsi uchun ham `0` so‘m to‘lagan bo‘lib chiqadi.
       - **Muhandislik taklifi (`NET_EARNED_PROPORTIONAL_CREDIT` — `PROPOSED` under `D14`):** Freeze krediti `gross_tariff` dan emas, balki ushbu davr `Invoice` ining chegirma va pro-ratadan keyingi **haqiqiy sof summasi (`invoice.effective_net_charge`)** va o‘sha invoice’dagi **haqiqiy hisoblangan darslar soni (`invoice.billed_lessons`)** asosida hisoblanadi:
         `freeze_credit_uzs = (invoice.effective_net_charge * frozen_billable_lessons) / invoice.billed_lessons`
       - **Aniq raqamli misollar (`C03`):**
         1. *Chegirmasiz to‘liq oy:* `gross = 480,000`, `discount = 0` -> `net_charge = 480,000` (`12` dars); `6` dars freeze -> `credit = 480,000 * 6 / 12 = 240,000` so‘m.
         2. *50% chegirmali o‘quvchi (`C03` misoli):* `gross = 480,000`, `50% discount = 240,000` -> `net_charge = 240,000` (`12` dars); `6` dars freeze -> **A1 (`NET_PROPORTIONAL` — tavsiya):** `credit = 240,000 * 6 / 12 = 120,000` so‘m (o‘qilgan 6 dars qiymati `120,000` so‘m saqlanadi); **A2 (`GROSS_PROPORTIONAL_CAPPED`):** grossdan hisoblansa ham kredit `net_charge - earned_lessons_net` dan oshmasligi shart (`DECISION_REQUIRED: D14`).
         3. *Pro-rata bilan kelgan o‘quvchi:* `12-noyabr`da kelib `7` dars uchun `net_charge = 280,000` so‘m yozilgan bo‘lsa va `3` dars freeze qilinsa -> `credit = 280,000 * 3 / 7 = 120,000` so‘m.
         4. *100% Grant o‘quvchi:* `net_charge = 0` -> `credit = 0 * 6 / 12 = 0` so‘m (sun’iy pul krediti yoki cash refund yaratilmaydi — `T09.03`).
       - **Qat’iy Cap (Yuqori Chegara Invarianti):** Bir davr (`BillingCycle`) ichida berilgan barcha freeze va tuzatish kreditlari yig‘indisi hech qachon `invoice.effective_net_charge - already_credited_uzs` dan oshmasligi shart (`total_cycle_credits_uzs <= invoice.effective_net_charge`). Avval kredit berilgan dars (`lesson_id`) yoki oldingi davrdan o‘tgan kredit ikkinchi marta qayta kreditlanmaydi.
  3. **Ketganlar (`Churn / Drop-out`) va 5 ta majburiy sabab (`PDF p.5`, `CASE-17`, `T09.04`):**
     - Admin o‘quvchini guruhdan chiqarayotganda quyidagi **5 ta sababdan birini** tanlashi majburiy:
       1. `1_FINANCIAL_DIFFICULTY` — To‘lovga qiynaldi;
       2. `2_DISLIKED_TEACHER` — O‘qituvchi yoqmadi;
       3. `3_SCHEDULE_MISMATCH` — Vaqti to‘g‘ri kelmadi;
       4. `4_MOVED_TO_COMPETITOR` — Boshqa markazga o‘tdi;
       5. `5_COMPLETED_OR_RELOCATED` — Kursni tugatdi / Ko‘chib ketdi.
     - **Moliya va tarix invarianti (`CASE-17`):** `effective_leave_date` dan keyingi davrlar uchun yangi invoice chiqarilmaydi, lekin **oldingi to‘lanmagan qarz (`existing_debt`) o‘chib ketmaydi**; agar o‘quvchi keyinchalik qayta kelsa (`re-enrollment`), yangi `Enrollment` tarixi ochiladi va eski enrollment/moliya tarixi ustidan yozilmaydi (`T06.03`, `T09.04`).
- **Expected Effect:** Freeze kredit yozuvi keyingi davrga bog‘lanadi; Churn sababi o‘qituvchi va guruh snapshotiga bog‘lanib Rahbar hisobotida (`S18.03`) ko‘rinadi.
- **Reject / Rollback:** Churn sababi tanlanmasa yoki `1..5` dan tashqari bo‘lsa — `422 CHURN_REASON_REQUIRED`.
- **Idempotency:** `(enrollment_id, lesson_id)` bo‘yicha freeze credit unique (`T09.03`).
- **Affected Steps:** `01.02`, `01.04`, `06.03`, `09.03`, `09.04`, `18.03`.

---

<a id="br-09"></a>
### `BR-09` — Kechki Kassa Topshirish (`Cash Shift Close`), Xarajatlar va Naqd/Karta Balansi
- **BR-ID:** `BR-09`
- **Manba / Origin:** `PDF p.3 Sec 3 (Admin)` & `p.5 Sec 4.5 (Kechki Kassa Topshirish / Smena Yopish)` + `planning/05_DOMAIN_RULES.md`
- **D-ID:** `D12`
- **Status:** `SOURCE_RULE` (Naqd, Plastik/Click, Xarajat va Kassada qolishi kerak bo‘lgan qoldiq hisoboti manbadan; opening cash va discrepancy — `05_DOMAIN_RULES.md` invarianti)
- **Actor:** `Admin` (xarajat kirituvchi va smena yopuvchi), `Rahbar` (hisobot oluvchi)
- **Trigger:** Admin kunlik naqd xarajat (`CashExpense`) kiritganda va kechqurun **"Smenani yopish"** tugmasini bosganda.
- **Precondition:** Smena `OPEN` holatda; xarajat uchun toifa (`category`), sabab/hujjat va summa (`amount > 0`) kiritilgan bo‘lishi shart (`T11.02`).
- **Input / Unit:** `opening_cash` (smena boshidagi naqd qoldiq, integer `UZS`), `cash_receipts` (smenadagi naqd tushumlar), `card_click_payme_receipts` (plastik/Click/Payme/o‘tkazma tushumlari), `cash_refunds` (naqd qaytarilgan pullar), `cash_expenses` (naqd xarajatlar), `counted_closing_cash` (haqiqiy sanalgan naqd pul).
- **Hisoblash yoki Transition:**
  1. **Kutilayotgan naqd qoldiq (`expected_closing_cash`) formulasi (`05_DOMAIN_RULES.md`, `T11.04`):**
     $$ ext{expected\_closing\_cash} =  ext{opening\_cash} +  ext{cash\_receipts} -  ext{cash\_refunds} -  ext{cash\_expenses} \pm  ext{audited\_cash\_adjustments}$$
  2. **Plastik / Click / Payme / Perechisleniye cheklovi:** Naqd bo‘lmagan tushumlar va xarajatlar alohida hisobot satrida ko‘rsatiladi, lekin **fizik naqd kassa qoldig‘iga (`expected_closing_cash`) QO‘SHILMAYDI va undan AYIRILMAYDI** (`T11.02`, `T11.04`).
  3. **Manba misoli (`PDF p.5`, `CASE-18`, `T11.04`):**
     - `opening_cash = 0` so‘m;
     - `cash_receipts (Naqd) = 3,200,000` so‘m;
     - `card_click_receipts (Plastik/Click) = 1,800,000` so‘m;
     - `cash_expenses (Xarajat) = 150,000` so‘m;
     - `cash_refunds = 0` so‘m;
     - **Kassada qolishi kerak (Naqd):** `0 + 3,200,000 - 150,000 = 3,050,000` so‘m (jami kunlik tushum: `5,000,000` so‘m, shundan naqd kassada: `3,050,000` so‘m).
  4. **Smenani qulflash (`Lock`):** Smena yopilgach (`status = CLOSED`), u o‘zgarmas bo‘lib qulflanadi; yopiq smenaga yangi naqd to‘lov kiritib bo‘lmaydi (`T11.01`). Agar sanalgan pul (`counted_closing_cash`) `expected_closing_cash` dan farq qilsa, `discrepancy` va sababi auditga yozilib Rahbarga boradi.
- **Expected Effect:** Smena `CLOSED` bo‘ladi; Rahbarning ilovasiga va Telegram botiga kunlik kassa hisoboti yuboriladi (`PDF p.5, 7`).
- **Reject / Rollback:** Yopiq smenaga naqd to‘lov/xarajat yozish — `409 SHIFT_CLOSED`. Parallel ikki marta smena yopish — bitta natija (`T11.01`).
- **Idempotency:** `shift_id` bo‘yicha close command idempotent.
- **Affected Steps:** `01.02`, `11.01`, `11.02`, `11.04`, `14.03`, `18.01`.

---

<a id="br-10"></a>
### `BR-10` — O‘qituvchi Oylik Maoshi (`Payroll`), 1-Kunlik O‘rindosh (`Substitute / Zamena`) Ulushi va Snapshot Tuzatishi
- **BR-ID:** `BR-10`
- **Manba / Origin:** `PDF p.3 Sec 3 (Rahbar)`, `p.7 Sec 6.2 (4-band)` & `p.8 Sec 7 (4-Loop: 1-Kunlik O'rindosh O'qituvchi)` + `planning/02_DECISIONS.md` (`D11`), `05_DOMAIN_RULES.md`
- **D-ID:** `D11`
- **Status:** `OPEN` / `DECISION_REQUIRED` (PDFda o‘qituvchi maoshi hisoblanishi va 1-kunlik o‘rindoshga o‘sha kunlik dars haqi yozilishi talab qilingan, ammo aniq maosh stavkasi/foizi PDFda berilmagan — `D11`)
- **Actor:** `Admin` (1-kunlik o‘rindoshni biriktiruvchi), `Rahbar` (maosh qoidasini tasdiqlovchi va hisobotni ko‘ruvchi), `Payroll Service`
- **Trigger:**
  1. Admin bugungi darsga (`lesson_id`) o‘rindosh o‘qituvchi (`substitute_teacher_id`) biriktirishi va davomat submit qilinishi;
  2. Oy yakunida o‘qituvchilar maoshi (`PayrollSnapshot`) hisoblanishi;
  3. Yopilgan payroll davriga keyinchalik tuzatish kiritilishi.
- **Precondition:** Har bir guruh/o‘qituvchi uchun markaz rahbari tomonidan tasdiqlangan maosh modeli (`PAYROLL_MODEL`: `FIXED_SALARY` | `PER_LESSON_RATE` | `REVENUE_PERCENTAGE`) mavjud bo‘lishi shart (`D11`, `T18.02`).
- **Input / Unit:** `primary_teacher_id`, `substitute_teacher_id`, `total_group_lessons_in_month` (masalan `12`), `primary_taught_lessons` (masalan `11`), `substitute_taught_lessons` (masalan `1`), parametrlar (`PROPOSED` misol uchun).
- **Hisoblash yoki Transition:**
  1. **1-kunlik O‘rindosh (`Substitute Teacher / Zamena`) ulushi (`PDF p.8, 4-Loop`, `CASE-19`, `T07.03`, `T18.02`):**
     - Admin `lesson_id` uchun o‘rindosh tayinlaganda, o‘sha darsning `pay_recipient_teacher_id` snapshoti `substitute_teacher_id` ga o‘tadi.
     - **A policy ostida (`PER_LESSON_RATE`, `PROPOSED` misol: 1 dars = `100,000` so‘m, 12 dars = `1,200,000` so‘m):**
       - Asosiy o‘qituvchi (`11` dars): `11 * 100,000 = 1,100,000` so‘m;
       - O‘rindosh o‘qituvchi (`1` dars): `1 * 100,000 = 100,000` so‘m.
     - **B policy ostida (`FIXED_OR_REVENUE_SHARE_PROPORTIONAL`, `PROPOSED` misol: guruh oylik maosh fondi = `2,400,000` so‘m, 12 dars):**
       - Asosiy o‘qituvchi (`11/12`): `2,400,000 * 11 / 12 = 2,200,000` so‘m;
       - O‘rindosh o‘qituvchi (`1/12`): `2,400,000 * 1 / 12 = 200,000` so‘m (`DECISION_REQUIRED: D11`).
  2. **Chegirma, 100% Grant va Refundning foizli maoshga ta’siri (`D11` — `DECISION_REQUIRED`):**
     - Agar o‘qituvchi tushumdan foiz (`REVENUE_PERCENTAGE`) olsa, 50% chegirma va 100% grant o‘quvchilar uchun maosh `net_collected_cash` (haqiqiy tushgan pul) danmi yoki `net_accrued_invoice` danmi yoki `gross_tariff` dan hisoblanishi `D11` da markaz rahbari bilan tasdiqlanadi.
  3. **Yopilgan Payroll Snapshot o‘zgarmasligi (`05_DOMAIN_RULES.md`, `CASE-20`, `T18.02`):**
     - Oy yakunida tasdiqlangan `PayrollSnapshot` (`status = CLOSED`) **o‘zgarmaydi (immutable)**.
     - Agar keyinchalik o‘tgan oy to‘lovi refund qilinsa yoki davomat tuzatilsa, eski oyning `PayrollSnapshot` yozuvi tahrirlanmaydi; farq joriy/keyingi oy maoshida alohida `PayrollAdjustmentEntry` (`+/-` tuzatish satri) sifatida aks ettiriladi (`CASE-20`).
- **Expected Effect:** Har bir o‘tilgan dars haqi haqiqiy dars o‘tgan o‘qituvchiga (asosiy yoki o‘rindosh) yoziladi; yopilgan maosh snapshoti buzilmaydi.
- **Reject / Rollback:** Maosh qoidasi (`D11`) markaz uchun tasdiqlanmagan bo‘lsa — yakuniy payroll yopish `422 PAYROLL_POLICY_NOT_CONFIRMED` bilan bloklanadi (`02_DECISIONS.md`).
- **Idempotency:** `(lesson_id)` bo‘yicha dars haqi faqat bitta o‘qituvchiga (`pay_recipient_teacher_id`) bir marta hisoblanadi; `(center_id, period_key, teacher_id)` bo‘yicha snapshot unique.
- **Affected Steps:** `01.02`, `01.04`, `07.03`, `18.02`, `24.04`.

---

<a id="br-11"></a>
### `BR-11` — 30 Soniyada Davomat (`Default Present Draft` -> `Submit`), Oflayn SQLite Sinxronizatsiya va Eski Excel Konflikti
- **BR-ID:** `BR-11`
- **Manba / Origin:** `PDF p.4 Sec 3 (Rol 3 Teacher)` & `p.6 Sec 5 (Komponent 2 va 3: SQLite Offline va Stale Excel)` + `planning/03_ARCHITECTURE.md`, `05_DOMAIN_RULES.md`
- **D-ID:** `D07`, `D15`
- **Status:** `SOURCE_RULE` (Standart "Keldi" turishi, oflayn SQLite’ga tushishi va kechikkan Excel o‘qituvchi davomatini buzmasligi manbadan; `lesson_id+student_id` kaliti va `client_operation_uuid` — `D07` muhandislik taklifi)
- **Actor:** `Teacher` (yoki 1-kunlik `Substitute Teacher`), `Admin` (Excel import va sababli override)
- **Trigger:** O‘qituvchi darsni ochganda (`Draft`), davomatni tasdiqlaganda (`Submit`), internet yonganda oflayn navbat sinxronlanganda yoki Admin Excel yuklaganda.
- **Precondition:** O‘qituvchi shu `lesson_id` uchun vakolatli (guruhning asosiy o‘qituvchisi yoki bugungi `lesson_id` uchun faol o‘rindosh — `BR-10`).
- **Input / Unit:** `lesson_id` (UUID), `student_id` (UUID), `status` (`PRESENT` | `LATE` | `ABSENT`), `client_operation_uuid`, `expected_version`.
- **Hisoblash yoki Transition:**
  1. **Draft vs Submit (`03_ARCHITECTURE.md`, `T12.01`):** Dars ekrani ochilganda barcha o‘quvchilar lokal ravishda `DRAFT (PRESENT)` ko‘rinadi. O‘qituvchi "Tasdiqlash / Submit" tugmasini bosmaguncha serverda tasdiqlangan davomat yaratilmaydi, ota-onaga xabar ketmaydi va trial aktivlashmaydi.
  2. **Oflayn SQLite va Dedup kaliti (`D07`, `T12.02`):** Internet past/yo‘q bo‘lganda submit amali lokal SQLite navbatiga `client_operation_uuid` bilan tushadi. Serverga yetib kelganda `(lesson_id, student_id)` yagona kaliti (PDFdagi `group_id+student_id+date` o‘rniga bir kunda bir nechta darsni qo‘llab-quvvatlash uchun — `D07`) va `client_operation_uuid` orqali idempotent yoziladi.
  3. **Kechikkan (Stale) Exceldan himoya (`PDF p.6`, `T12.03`):** Agar `lesson_id` uchun o‘qituvchi ilovada davomatni submit qilgan bo‘lsa (`version >= 1`, `source = TEACHER_APP`), keyinroq yuklangan eski Excel fayl o‘sha kun/dars davomatini **ustidan yozib buzib yubora olmaydi** (`409 STALE_ROW_CONFLICT`). Tasdiqlangan Teacher davomatini faqat Admin UI da aniq sabab kiritib (`Admin Override with Reason`) o‘zgartira oladi (`AuditLog` bilan).
- **Expected Effect:** Davomat saqlanadi; `ABSENT` va `LATE` o‘quvchilarning ota-onalariga Telegram xabari navbatga (`Outbox`) qo‘yiladi (`BR-13`).
- **Reject / Rollback:** Vakolati olib tashlangan o‘qituvchining oflayn keshdan kelgan davomati serverda joriy ruxsat tekshiruvidan o‘tmaydi va `403 Forbidden` bilan rad etiladi (`05_DOMAIN_RULES.md`, `T07.03`).
- **Idempotency:** `client_operation_uuid` unique; bir xil UUID qayta yuborilsa avvalgi natija qaytadi, boshqa body bilan shu UUID kelsa `409 Conflict` (`T12.02`).
- **Affected Steps:** `01.02`, `02.02`, `12.01`–`12.04`, `16.02`–`16.04`, `17.02`–`17.03`.

---

<a id="br-12"></a>
### `BR-12` — 20 Daqiqalik Davomat Eslatmasi (`Teacher Ping`) va Dars Yakunida `Admin Escalation`
- **BR-ID:** `BR-12`
- **Manba / Origin:** `PDF p.8 Sec 7 (1-Loop: Avto-Turtki / Teacher Ping)` + `requirements.csv` (`R17`, `R13.03`)
- **D-ID:** `OPEN_CHANNEL_01`, `OPEN_CHANNEL_02`
- **Status:** `SOURCE_RULE` (20 daqiqada ping va dars tugaguncha kiritilmasa Adminga xabar chiqishi manbadan; ping transport kanali — `OPEN_CHANNEL_01`)
- **Actor:** `Scheduler Worker`, `Teacher` (yoki `Substitute Teacher`), `Admin`
- **Trigger:** Dars boshlangan vaqtdan (`lesson.starts_at`) `20 daqiqa` o‘tganda hamda dars tugagan vaqtda (`lesson.ends_at`).
- **Precondition:** `Lesson.status == SCHEDULED` (dars bekor qilinmagan — `T07.02`, `T13.03`) va `Lesson.attendance_submitted_at IS NULL`.
- **Input / Unit:** `lesson_id`, `starts_at + 20 min`, `ends_at`, `effective_teacher_id` (agar zamena bo‘lsa, asosiy o‘qituvchi emas, aynan o‘rindosh o‘qituvchi — `T13.03`).
- **Hisoblash yoki Transition:**
  1. `now >= starts_at + 20 min` va davomat submit qilinmagan bo‘lsa: `effective_teacher_id` ga *"Dars boshlandi, 30 soniyada davomatni belgilang!"* ping xabari yuboriladi (`PDF p.8`).
  2. `now >= ends_at` va davomat hali ham submit qilinmagan bo‘lsa: Adminga kechikkan davomat bo‘yicha escalation xabari/vazifasi chiqariladi (`PDF p.8`, `T13.03`).
- **Expected Effect:** Har bir kechikkan dars uchun ko‘pi bilan 1 ta Teacher Ping va 1 ta Admin Escalation yaratiladi.
- **Reject / Rollback:** Bekor qilingan (`CANCELLED`) darsga yoki almashtirilgan (eski) o‘qituvchiga ping yuborilmaydi (`T13.03`).
- **Idempotency:** Unique outbox keys `(lesson_id, "TEACHER_PING_20M")` va `(lesson_id, "ADMIN_ESCALATION_END")`.
- **Affected Steps:** `01.02`, `07.02`, `13.03`.

---

<a id="br-13"></a>
### `BR-13` — Ota-ona Telegram Bot Bog‘lash (`Verification`), Navbat Tezligi va Bloklangan Bot (`Delivery Status`)
- **BR-ID:** `BR-13`
- **Manba / Origin:** `PDF p.4 Sec 3 (Rol 4)`, `p.6 Sec 5 (Komponent 4)` & `p.8 Sec 7 (2-Loop: Yetkazib Berish Statusi)` + `planning/02_DECISIONS.md` (`D09`, `D18`)
- **D-ID:** `D06`, `D09`, `D18`, `D19`
- **Status:** `SOURCE_RULE` (1 marta telefon tasdiqlash, sariq belgi va Admin qo‘ng‘iroq ro‘yxati manbadan; single-use invite, `contact.user_id` va `429 retry_after` — `ENGINEERING_PROPOSAL`)
- **Actor:** `Ota-ona (Guardian)`, `Admin`, `Bot / Outbox Worker`
- **Trigger:** Ota-ona botda telefon tasdiqlaganda, telefon raqami o‘zgarganda (`D18`), yoki navbatdan xabar yuborilganda (`25 xabar/s` maqsadli tezlik — `D09`).
- **Precondition:** Ota-ona yuborgan Telegram `contact.user_id` xabar yuboruvchining `from.id` siga teng bo‘lishi va bir martalik invite / ro‘yxatdagi telefon raqami aktiv bo‘lishi shart (`T14.01`).
- **Input / Unit:** `guardian_id`, `phone_e164`, `telegram_user_id`, `telegram_chat_id`, `delivery_result` (`API_ACCEPTED` | `403_BOT_BLOCKED` | `429_RATE_LIMITED` | `UNLINKED`).
- **Hisoblash yoki Transition:**
  1. **Bog‘lash va qayta bog‘lash (`D18`, `T14.01`):** Tasdiq muvaffaqiyatli bo‘lsa `GuardianTelegramLink.status = ACTIVE` bo‘ladi. Agar ota-ona telefon raqami o‘zgarsa, Admin tekshiruvi bilan yangi raqam bog‘lanadi va **eski `telegram_chat_id` huquqi darhol `REVOKED` qilinadi** (eski chatdan bosilgan callbacklar ma’lumot qaytarolmaydi — `T14.02`).
  2. **Yetkazib berish statusi va Sariq belgi (`PDF p.8, 2-Loop`, `T14.04`):**
     - Agar ota-ona botga ulanmagan (`UNLINKED`) bo‘lsa yoki botni bloklagan (`403 Forbidden` qaytsa) bo‘lsa, link statusi `BLOCKED_OR_UNLINKED` ga o‘tadi;
     - O‘quvchi profilida **sariq belgi ("Bot ulanmagan")** yonadi va qarzdor ota-onalar uchun Adminga alohida qo‘ng‘iroq ro‘yxati chiqariladi (`PDF p.8`).
     - Telegram API `200 OK` qaytarishi `API_ACCEPTED` deb saqlanadi, ota-ona xabarni o‘qidi (`READ`) deb yolg‘on da’vo qilinmaydi (`T14.04`, `T14.05`).
     - `429 Too Many Requests` qaytsa, `retry_after` soniyasiga amal qilib navbatda qayta yuboriladi (`D09`, `T14.04`).
- **Expected Effect:** Faqat aktiv va tasdiqlangan vasiy farzand ma’lumotini oladi; bot yo‘q/bloklangan qarzdorlar Admin call-listiga tushadi.
- **Reject / Rollback:** Begona `contact.user_id` yoki eskirgan invite — `403 Forbidden` (`T14.01`, `T14.05`).
- **Idempotency:** Telegram `update_id` dedup va outbox `event_id` tracking (`B15`, `T14.04`).
- **Affected Steps:** `01.02`, `01.04`, `06.02`, `14.01`–`14.04`, `15.04`.

---

<a id="br-14"></a>
### `BR-14` — Qulflangan Excel Shablon (`Locked XLSX`), Yashirin `student_id` va `Dry-Run` Import
- **BR-ID:** `BR-14`
- **Manba / Origin:** `PDF p.2 Sec 1 (band 4)`, `p.6 Sec 5 (Komponent 2)` & `p.7 Sec 6.1 (2-Qadam)` + `planning/08_BUGHUNT_REPORT.md` (`B18`, `B19`)
- **D-ID:** `N/A` (Barcha talablar manba va xavfsizlik baseline’idan)
- **Status:** `SOURCE_RULE` (Yashirin `student_id` bo‘yicha moslash va qizil/yashil tekshiruv jadvali manbadan; row version, upload hash va formula injection himoyasi — `ENGINEERING_PROPOSAL`)
- **Actor:** `Admin`
- **Trigger:** Admin shablonni yuklab olganda (`Export`), to‘ldirib tekshirishga yuklaganda (`Dry-Run Preview`) va tasdiqlaganda (`Commit Import`).
- **Precondition:** Fayl hajmi va qatorlar soni ruxsat etilgan chegarada (`B19`); fayl shu markaz (`center_id`) va qo‘llab-quvvatlanadigan `template_version` ga tegishli.
- **Input / Unit:** `.xlsx` fayl, 1-ustunda yashirin `student_id` (UUID, yangi o‘quvchi uchun bo‘sh), `row_version`, `upload_sha256`, `preview_token`.
- **Hisoblash yoki Transition:**
  1. **Ismga emas, `student_id` ga qarab moslash (`PDF p.6`, `T16.01`):** Mavjud o‘quvchilar ism-familiyasidagi harf o‘zgarishidan qat’i nazar 1-ustundagi `student_id` (UUID) orqali topiladi.
  2. **Qizil/Yashil `Dry-Run` (`PDF p.2, 7`, `T16.03`):** Yuklangan fayl bazani o‘zgartirmasdan tekshiriladi; har bir qator `VALID (Yashil)` yoki `ERROR / CONFLICT (Qizil)` sababi bilan ko‘rsatiladi va `upload_sha256` ga bog‘langan `preview_token` beriladi.
  3. **Atomik `Commit` (`T16.04`):** Faqat barcha qatorlar xatosiz bo‘lib, `Commit` bosilganda `upload_sha256` va `row_version` qayta tekshiriladi (preview va commit orasida mobil ilovadan o‘zgarish bo‘lgan bo‘lsa `409 Conflict` qaytadi — `05_DOMAIN_RULES.md`) va bitta tranzaksiyada bazaga yoziladi.
- **Expected Effect:** Xatosiz fayl atomik import qilinadi va `AuditLog` yoziladi; xatoli fayl bazani qisman buzmaydi (`T16.05`).
- **Reject / Rollback:** Bitta xato qator, begona markaz UUIDsi, stale version yoki `=`, `+`, `-`, `@` formula injection/zip-bomb bo‘lsa — butun import rad etiladi (`T16.02`, `T16.04`).
- **Idempotency:** `preview_token` / `upload_sha256` bo‘yicha retry ikkinchi marta dublikat import yaratmaydi (`T16.04`).
- **Affected Steps:** `01.02`, `12.03`, `16.01`–`16.05`.

---

<a id="br-15"></a>
### `BR-15` — Litsenziya Himoyasi (`Subscription Kill-Switch`) va `Read-Only` Rejim Chegarasi
- **BR-ID:** `BR-15`
- **Manba / Origin:** `PDF p.3 Sec 2.2 (Moliya va Litsenziya Himoyasi / Subscription Kill-Switch)` + `planning/02_DECISIONS.md` (`D17`, `D23`), `08_BUGHUNT_REPORT.md` (`B13`)
- **D-ID:** `D17`, `D23`
- **Status:** `SOURCE_RULE` (Vendor bitta tugma bilan Read-Only rejimiga o‘tkazishi va ma’lumotlar o‘chmasligi manbadan; grace muddati va pending xabarlar — `OPEN: D17`, `D23`)
- **Actor:** `Vendor` (Kill-Switch boshqaruvchisi), `Center Staff` (`Rahbar`, `Admin`, `Teacher`)
- **Trigger:** Markaz obuna to‘lovini kechiktirganda Vendor panelidan `READ_ONLY` yoqilishi yoki imzolangan litsenziya muddati + grace period (`D17`) tugashi; to‘lov qilingach qayta `ACTIVE` ga o‘tkazilishi.
- **Precondition:** Vendor alohida `apps/vendor` auth/MFA orqali tasdiqlangan (`D23`, `T19.01`).
- **Input / Unit:** `center_id`, `license_status` (`ACTIVE` | `GRACE_PERIOD` | `READ_ONLY`), `signed_license_token`, `grace_hours` (`D17`).
- **Hisoblash yoki Transition:**
  1. **`READ_ONLY` rejimda ruxsat etilgan amallar (`Allowlist` — `B13`, `T19.03`):** Tizimga kirish (`Login`), barcha mavjud ma’lumotlar va hisobotlarni o‘qish (`Read`), ma’lumotlarni eksport qilish (`Export`), tungi zaxira (`Backup`) va tizim health/telemetry ack.
  2. **`READ_ONLY` rejimda bloklanadigan amallar (`Blocklist`):** Yangi to‘lov, xarajat, smena ochish/yopish, davomat submit qilish, talaba/guruh qo‘shish yoki tahrirlash, Excel import va oflayn navbatdagi biznes yozuvlarini serverga commit qilish (`403 LICENSE_READ_ONLY_MODE` bilan rad etiladi; mobil ilovadagi lokal navbat o‘chib ketmaydi, faqat `PENDING_LICENSE` bo‘lib kutadi — `T17.03`, `T19.04`).
  3. **Obuna uzaytirilgach (`ACTIVE`):** Kutilayotgan oflayn amallar blind replay qilinmasdan, joriy `version` va `permission` bilan qayta tekshirilib sinxronlanadi (`05_DOMAIN_RULES.md`, `T19.04`).
- **Expected Effect:** Ma’lumotlar 100% saqlanadi; barcha yozish yo‘llari (API, Excel, Mobile sync, Worker business mutations) bloklanadi.
- **Reject / Rollback:** Read-only rejimni API, Excel yoki offline sync orqali chetlab o‘tish urinishi `403` bilan qaytariladi (`T19.05`).
- **Idempotency:** Litsenziya status o‘zgarishi versiyalangan va auditlangan (`T19.02`).
- **Affected Steps:** `01.02`, `01.04`, `17.03`, `19.01`–`19.05`.

---

<a id="br-16"></a>
### `BR-16` — Ehtimoliy Dublikat O‘quvchini Aniqlash va Aka-Ukalarni (`Siblings`) Xato Bloklamaslik
- **BR-ID:** `BR-16`
- **Manba / Origin:** `PDF p.4 Sec 4.3 (Oilaviy o'quvchilar)` & `p.8 Sec 7 (C-Bosqich: Avto-Himoya / Guardrail)` + `planning/08_BUGHUNT_REPORT.md` (`B23`)
- **D-ID:** `N/A`
- **Status:** `SOURCE_RULE` + `ENGINEERING_PROPOSAL` (`B23`: PDF 8-sahifada telefon va ism-sharif dublikatini tekshirish aytilgan, PDF 4-sahifada esa bitta ota-ona raqamiga 2–3 nafar farzand biriktirilishi aytilgan)
- **Actor:** `Admin`
- **Trigger:** Admin yangi o‘quvchi qo‘shayotganda yoki Excel orqali import qilayotganda.
- **Precondition:** O‘quvchi `full_name` va `guardian_phone` kiritilgan.
- **Input / Unit:** `normalized_student_name`, `normalized_guardian_phone`, `confirm_not_duplicate` (boolean flag).
- **Hisoblash yoki Transition:**
  1. **Aynan bir xil o‘quvchi (`same normalized_student_name` + `same normalized_guardian_phone`):** Tizim dublikat sifatida bloklaydi yoki Adminning ongli tasdig‘ini talab qiladi (`PDF p.8`, `T06.04`).
  2. **Aka-ukalar (`different student first_name` + `same guardian_phone` va/yoki bir xil familiya):** Tizim buni xato bloklamaydi (`B23`, `T06.04`, `T06.05`), balki mavjud vasiy (`Guardian`) profiliga ikkinchi farzand sifatida bog‘lab, `BR-04` bo‘yicha "Oilaviy chegirma" taklifini chiqaradi (`PDF p.4`).
- **Expected Effect:** Bir o‘quvchini ikki marta kiritish oldi olinadi; aka-ukalar bitta ota-ona telefoniga muammosiz biriktiriladi.
- **Reject / Rollback:** Tasdiqlanmagan to‘liq dublikat `409 DUPLICATE_STUDENT_DETECTED` qaytaradi.
- **Idempotency:** Student yaratishda `idempotency_key` bir xil so‘rovda bitta student yaratadi (`T06.01`).
- **Affected Steps:** `01.02`, `06.01`, `06.02`, `06.04`, `15.01`, `16.02`.

---

<a id="br-17"></a>
### `BR-17` — Tungi Ikki Qatlamli Zaxira (`Backup`), Tiklashda `Outbound Disabled` va RPO/RTO Maqsadlari
- **BR-ID:** `BR-17`
- **Manba / Origin:** `PDF p.8 Sec 7 (5-Loop: Ikki Qatlamli Avto-Arxiv)` + `planning/02_DECISIONS.md` (`D10`, `D16`), `05_DOMAIN_RULES.md`, `08_BUGHUNT_REPORT.md` (`B14`)
- **D-ID:** `D10`, `D16`, `D19`
- **Status:** `SOURCE_RULE` + `OPEN` (`D10`: `RPO ≤ 24 soat (24 h), RTO ≤ 60 daqiqa (60 min), PROPOSED`; `D16`: Telegram kanalga ikkinchi nusxa yuborish maxfiylik/hajm tasdig‘iga bog‘liq)
- **Actor:** `Backup / Restore Operator (Vendor)`, `Backup Cron Worker`
- **Trigger:** Har kecha tungi zaxira vaqti kelganda yoki avariya holatida toza muhitga baza tiklanganda (`Restore`).
- **Precondition:** Shifrlash kaliti zaxira fayli bilan bir joyda saqlanmagan bo‘lishi shart (`T21.01`, `T21.05`).
- **Input / Unit:** `.sql.gz` (PostgreSQL dump), `.xlsx` / fayl biriktirmalari, `SHA256 checksum`, shifrlash kaliti.
- **Hisoblash yoki Transition:**
  1. **Offsite Cloud Backup (Asosiy):** Har kecha har bir markaz bazasi va fayllari shifrlanib, checksum bilan offsite cloud storage’ga yuklanadi (`R21.01`).
  2. **Telegram Arxiv Kanali (`D16` — `DECISION_REQUIRED`):** Faqat fayl hajmi, maxfiylik va kalit rotatsiyasi tasdiqlansa ikkinchi shifrlangan nusxa yopiq Telegram kanalga yuboriladi (`T21.04`).
  3. **Tiklashda (`Restore`) eski xabarlar qayta ketib qolishidan himoya (`B14`, `05_DOMAIN_RULES.md`, `T21.02`):** Zaxiradan tiklash vaqtida `BOT_OUTBOUND_ENABLED = false` (o‘chiq) holatda start beriladi; eski outbox navbati audit/reconciliation qilinib, ota-onalarga eski kvitansiya/davomat xabarlari qayta spam bo‘lib ketmasligi ta’minlanadi.
- **Expected Effect:** Toza muhitga tiklanganda ledger va qatorlar soni 100% mos keladi (`T21.02`).
- **Reject / Rollback:** Checksum yoki schema versiyasi mos kelmasa restore abort qilinadi (`T21.02`).
- **Idempotency:** Restore reconciliation outbox eventlarini `SUPERSEDED_BY_RESTORE` qilib belgilaydi.
- **Affected Steps:** `01.02`, `01.04`, `21.01`–`21.05`.

---

<a id="br-18"></a>
### `BR-18` — Boshlang‘ich Bazani Ko‘chirish (`Opening Balance Reconciliation`) va Demo Markaz Izolyatsiyasi
- **BR-ID:** `BR-18`
- **Manba / Origin:** `PDF p.2–3 Sec 2.1 (Sales Demo Pack)` & `p.7 Sec 6.2 (1-band: 1–3 kunlar eski bazani tozalash va ko'chirish)` + `requirements.csv` (`R22.01`–`03`, `R24.01`)
- **D-ID:** `D01`
- **Status:** `SOURCE_RULE` + `PROPOSED` (`D01`: 240 asosiy demo student, 250 stress fixture)
- **Actor:** `Vendor` + `Rahbar / Admin` (onboarding sign-off)
- **Trigger:** Yangi mijoz markazning eski qog‘oz/Excel bazasini kiritish (`S24.01`) yoki sotuv uchrashuvida Demo markazni qayta tiklash (`S22.02`).
- **Precondition:** Onboardingda markazning boshlang‘ich qarzdorlik/haqdorlik (`Opening Debt / Credit`) ro‘yxati Rahbar bilan kelishilgan bo‘lishi; Demo resetda `DEMO=true` va alohida demo DB identiteti tasdiqlangan bo‘lishi shart (`T22.02`).
- **Input / Unit:** `opening_debt` / `opening_credit` (integer `UZS`), `DEMO` flag.
- **Hisoblash yoki Transition:**
  1. **Tarixiy qarzni joriy kunlik naqd tushumga aralashtirmaslik (`T24.01`):** Eski daftardan ko‘chirilgan boshlang‘ich qarz yoki avans `OPENING_BALANCE_SNAPSHOT` sifatida kiritiladi; tarixiy to‘lovlar bugungi kassa smenasining yangi naqd tushumi (`cash_receipts`) sifatida hisoblanmaydi.
  2. **Demo Markaz ("Namuna Akademiyasi" — `T22.01`–`03`):** `240` nafar sintetik o‘quvchi (`D01`), `14` guruh, `6` o‘qituvchi; hech qanday real shaxsiy telefon raqami bo‘lmaydi va demo bot faqat ruxsat etilgan `demo_recipient_allowlist` chatlariga xabar yuboradi (`400,000` so‘m demo to‘lov va virtual farzand davomati — `T22.02`, `T22.03`).
- **Expected Effect:** Mijoz bazasi Rahbar imzoli reconciliation bilan boshlanadi; Demo reset production bazada hech qachon ishga tushmaydi (`T22.02`).
- **Reject / Rollback:** Production muhitda demo seed/reset chaqirilsa — darhol `ABORT / 403 PRODUCTION_DEMO_RESET_FORBIDDEN` (`T22.02`).
- **Idempotency:** Deterministik demo seed va idempotent opening balance batch.
- **Affected Steps:** `01.02`, `01.04`, `22.01`–`22.03`, `24.01`.

---

<a id="sec-3-acceptance-cases-table"></a>
## 3. Mustaqil Qabul Holatlari Jadvali (`CASE-01` – `CASE-22`, kamida 20 ta holat talabi)

Quyidagi jadval `S01-FULL-C.md` (42–63-satrlar) da talab qilingan barcha 20 ta majburiy ssenariyni va 2 ta qo‘shimcha chegara ssenariysini (**jami 22 ta mustaqil holat**) qamrab oladi. Qarorga bog‘liq holatlarda natija universal qoida deb emas, balki **`A policy ostida ..., B policy ostida ..., DECISION_REQUIRED`** shaklida berilgan:

| Case ID | BR-ID | Ssenariy va Kirish Qiymatlari (`Given / Input`) | Kutilgan Hisoblash / Transition va Natija (`Expected Outcome`) | Qaror Maqomi (`Policy Status`) | Bog‘liq Test ID |
| :-: | :-: | :--- | :--- | :---: | :---: |
| <a id="case-01"></a>**`CASE-01`** | `BR-01` | **Kalendar oy pro-rata (Manba misoli):** Kurs narxi `480,000` so‘m, noyabr oyida jami rejalashtirilgan darslar `12` ta, 12-noyabrda kelgan o‘quvchi uchun oy oxirigacha qolgan darslar `7` ta (`PDF p.4`). | `charge = 480,000 * 7 / 12 = 280,000` so‘m. Noyabr invoice = `280,000` so‘m; 1-dekabrdan keyingi oy invoice = `480,000` so‘m. | `SOURCE_RULE` (Exact arithmetic) | `T01.02`, `T08.01`, `T08.05` |
| <a id="case-02"></a>**`CASE-02`** | `BR-01` | **Nol qolgan dars vs Nol maxraj (`remaining=0` vs `denominator=0`):**<br>2a) `monthly_fee=480,000`, `total_lessons=12`, `remaining_lessons=0`;<br>2b) `monthly_fee=480,000`, `total_lessons=0` (jadval xatosi). | **2a (`remaining=0`):** `480,000 * 0 / 12 = 0` so‘m (joriy oy uchun qarz yozilmaydi).<br>**2b (`total_lessons=0`):** Bo‘lish bajarilmaydi (`ZeroDivision` oldi olinadi), hisob chiqarish `422 INVALID_SCHEDULE_ZERO_LESSONS` xatosi bilan bloklanadi. | `PROPOSED` (`T08.01` invariant) | `T08.01` |
| <a id="case-03"></a>**`CASE-03`** | `BR-02` | **Rolling Month `31-yanvar` renewal (Kabisa va kabisa bo‘lmagan yil):** O‘quvchi B1 (`ROLLING_MONTH`) rejimda `31-yanvar` kuni o‘qishni boshladi. | **Non-leap yil (`2026-01-31`):** 2-davr sanasi = `2026-02-28`.<br>**Leap yil (`2028-01-31`):** 2-davr sanasi = `2028-02-29`.<br>**3-davr (Mart) sanasi:** **A policy ostida (`ANCHOR_31_RESTORE`):** `31-mart`; **B policy ostida (`DRIFT_TO_28_29`):** `28-mart` / `29-mart` (`DECISION_REQUIRED: D21`). | `DECISION_REQUIRED` (`D03`, `D21`) | `T08.02` |
| <a id="case-04"></a>**`CASE-04`** | `BR-02` | **12-dars paketida (`B2_LESSON_PACKAGE_12`) markaz bekor qilgan dars (`Cancelled Lesson`):** O‘quvchida `12` darslik paket bor (`balance=12`), `5` ta dars o‘tildi (`balance=7`), 6-dars markaz tomonidan bekor qilindi (`CANCELLED`). | **A policy ostida (`PRESERVE_PACKAGE_BALANCE` — tavsiya):** Bekor qilingan dars paketdan yechilmaydi, `remaining_lessons = 7` saqlanadi (paket tugashi 1 darsga suriladi).<br>**B policy ostida (`CONSUME_AND_CREDIT_NEXT`):** Jadval davri o‘zgarmaydi, keyingi invoicega `1/12` (`40,000` so‘m) kredit beriladi (`DECISION_REQUIRED: D21`). | `DECISION_REQUIRED` (`D03`, `D21`) | `T07.02`, `T08.02` |
| <a id="case-05"></a>**`CASE-05`** | `BR-03` | **Sinov darsi (`Trial`): 1-dars va 2-alohida (`DISTINCT`) qatnashuv:** O‘quvchi `TRIAL` bo‘lib `L1` (`2026-11-12`) darsda `PRESENT` bo‘ldi; keyin `L2` (`2026-11-14`, `L2 != L1`) darsda ham `PRESENT` bo‘lib submit qilindi. | **1-dars (`L1`) submitdan keyin:** `status = TRIAL`, `invoice_count = 0`, `debt = 0` so‘m.<br>**2-distinct dars (`L2`) submitdan keyin:** `status = ACTIVE`, `L1` sanasidan (`2026-11-12`, 7 ta dars) boshlab aniq `1` ta `Invoice` (`280,000` so‘m) yaratiladi. | `SOURCE_RULE` (`PDF p.4 Sec 4.2`) | `T01.02`, `T08.03`, `T12.04` |
| <a id="case-06"></a>**`CASE-06`** | `BR-03`, `BR-02` | **Cycle Identity, Trial Retry hamda `Activation -> Compensation -> Reactivation` (`C04`):**<br>6a) `L1` yoki `L2` davomat hodisasi retry bo‘ldi;<br>6b) `L2` xato `PRESENT` bo‘lib aktivlashdi (`seq=1`, `280,000`), Admin `L2=ABSENT` deb tuzatdi (`TrialCompensated`, `-280,000`), keyin o‘quvchi `L3` da haqiqatan qatnashdi (`seq=2`);<br>6c) Intensiv guruhda o‘quvchi 1 oyda 2 ta `12-dars` paketini (`PKG:1` va `PKG:2`) o‘qidi. | **6a (Retry):** `invoice_count` o‘zgarmaydi (`L1->0`, `L2->1`).<br>**6b (Reactivation):** `seq=1` invoice `VOID_COMPENSATED` (`net=0`) bo‘ladi va `seq=2` yangi aktivlashishni bloklamaydi (`net_charge = 280,000 - 280,000 + 280,000 = 280,000` so‘m).<br>**6c (2 Packages in 1 Month):** `PKG:1` va `PKG:2` alohida `BillingCycle` bo‘lgani uchun `2` ta qonuniy invoice chiqadi (`retry`da esa `1` ta). | `PROPOSED` (`B04`, `C04` invariant) | `T08.03`, `T08.04`, `T08.05`, `T12.04` |
| <a id="case-07"></a>**`CASE-07`** | `BR-04` | **Tasdiqsiz 50% chegirma vs Rahbar tasdiqlagan 50% chegirma:** Kurs narxi `480,000` so‘m; Admin 50% chegirma so‘rovi kiritdi (`PENDING_APPROVAL`), keyin Rahbar uni `APPROVE` qildi (`PDF p.4–5`). | **Rahbar tasdiqlamaguncha (`PENDING_APPROVAL`):** Chegirma effekti `0` so‘m, o‘quvchi qarzi `480,000` so‘m.<br>**Rahbar tasdiqlagach (`APPROVED`):** `discount = 480,000 * 50% = 240,000` so‘m, yakuniy `net_charge = 240,000` so‘m. | `SOURCE_RULE` (`PDF p.4–5 Sec 4.3`) | `T09.01`, `T09.02`, `T09.05` |
| <a id="case-08"></a>**`CASE-08`** | `BR-04` | **100% Bepul (`Grant`) o‘quvchi hisobi:** Kurs narxi `480,000` so‘m; Rahbar 100% Grantni tasdiqladi (`APPROVED`). | `discount = 480,000` so‘m -> `net_charge = 0` so‘m, `debt = 0` so‘m. Kassaga soxta naqd tushum (`cash_receipt = 0`) ham, soxta qaytarish (`cash_refund = 0`) ham yozilmaydi. | `SOURCE_RULE` + `PROPOSED` (`T09.03`, `T09.05`) | `T01.02`, `T09.03`, `T09.05`, `T18.01` |
| <a id="case-09"></a>**`CASE-09`** | `BR-04` | **Fixed + Percent chegirma qo‘shilishi (`Discount Stacking`):** Kurs narxi `480,000` so‘m; o‘quvchida `50,000` so‘m fiks oilaviy chegirma va `50%` maxsus chegirma bor. | **A policy ostida (`HIGHEST_ONLY`):** `net_charge = 480,000 - 240,000 = 240,000` so‘m.<br>**B policy ostida (`FIXED_FIRST`):** `(480,000 - 50,000) * 50% = 215,000` so‘m.<br>**C policy ostida (`PERCENT_FIRST`):** `(480,000 * 50%) - 50,000 = 190,000` so‘m (`DECISION_REQUIRED: D14`). | `DECISION_REQUIRED` (`D14`) | `T09.02` |
| <a id="case-10"></a>**`CASE-10`** | `BR-04` | **Muddati tugagan (`Expired`) chegirma:** O‘quvchining 50% chegirmasi `valid_until = 2026-11-30` edi; `2026-12-01` da dekabr oyi uchun yangi invoice (`480,000` so‘m) chiqarildi. | Eskirgan chegirma dekabr invoice’iga qo‘llanmaydi: `discount = 0` so‘m, dekabr `net_charge = 480,000` so‘m (yangi chegirma uchun yangi Rahbar tasdig‘i talab qilinadi). | `SOURCE_RULE` (`PDF p.4 Sec 4.3`) | `T09.01`, `T09.02` |
| <a id="case-11"></a>**`CASE-11`** | `BR-05` | **Qisman to‘lov (`500,000 - 300,000 = 200,000` qarz) va majburiy `Promise-to-Pay` atomikligi:** Invoice = `500,000` so‘m, Admin `300,000` so‘m to‘lov kiritmoqda (`PDF p.5`).<br>11a) `promise_date` berilmagan;<br>11b) `promise_date = 2026-11-15` berilgan. | **11a (`promise_date` yo‘q):** `422 PROMISE_DATE_REQUIRED`, tranzaksiya rollback bo‘ladi (`Payment` ham yozilmaydi, DB o‘zgarishi nol).<br>**11b (`promise_date` bor):** `paid = 300,000` so‘m, `remaining_debt = 200,000` so‘m va `PromiseToPay(2026-11-15, 200,000)` bitta tranzaksiyada saqlanadi. | `SOURCE_RULE` + `PROPOSED` (`B03`, `T11.03`) | `T10.02`, `T11.03` |
| <a id="case-12"></a>**`CASE-12`** | `BR-06` | **Ortiqcha to‘lov (`Overpayment` -> `Unapplied Credit`):** Ochiq invoice qarzi `500,000` so‘m; ota-ona `600,000` so‘m to‘ladi. | Invoicega `allocation = 500,000` so‘m (`invoice_debt = 0`, status `PAID`); ortiqcha `100,000` so‘m `unapplied_credit = 100,000` so‘m sifatida saqlanadi (manfiy qarz emas). | `PROPOSED` (`05_DOMAIN_RULES.md`, `T10.02`) | `T10.02` |
| <a id="case-13"></a>**`CASE-13`** | `BR-07` | **Xato to‘lovni Storno/Reversal qilish (`4,000,000` -> `400,000` so‘m):** Admin adashib `400,000` o‘rniga `4,000,000` so‘m yozdi, sababli tuzatish so‘rovi yubordi va Rahbar tasdiqladi (`PDF p.5`). | Asl `+4,000,000` so‘m yozuv o‘chirilmaydi; Rahbar tasdig‘i bilan `-4,000,000` so‘m append-only `Reversal` va `+400,000` so‘m yangi to‘g‘ri `Payment` yoziladi. Yakuniy sof to‘lov: `4,000,000 - 4,000,000 + 400,000 = 400,000` so‘m; Rahbarga qizil Telegram alert ketadi. | `SOURCE_RULE` (`PDF p.5 Sec 4.5`) | `T01.02`, `T10.03`, `T10.05` |
| <a id="case-14"></a>**`CASE-14`** | `BR-07`, `BR-09` | **Qisman qaytarish (`Partial Refund`) cap, parallel `Approve`, `refund_method` (`CASH` vs `CARD/CLICK`) va qarzni qayta ochish (`C03`, `D22`):** To‘langan `400,000` so‘mdan `150,000` so‘m refund so‘raldi (parallel 2 ta approve); keyin yana `300,000` so‘m so‘raldi. | **Parallel Approve & Cap:** Faqat bitta `-150,000` o‘tadi (`remaining=250,000`); keyingi `300,000 > 250,000` -> `422 REFUND_CAP_EXCEEDED`.<br>**Usul (`C03`):** `refund_method=CASH` bo‘lsagina smena naqd qoldig‘i `-150,000` ga kamayadi; `CARD/CLICK` refund naqd kassani kamaytirmaydi.<br>**Qarz (`D22`):** **A policy:** qarz `+150,000` qayta ochiladi; **B policy:** `CreditNote (-150,000)` bilan qarz `0` qoladi (`DECISION_REQUIRED: D22`). | `PROPOSED` + `DECISION_REQUIRED` (`C03`, `D22`, `B24`) | `T01.02`, `T10.03`, `T11.04` |
| <a id="case-15"></a>**`CASE-15`** | `BR-08`, `BR-04` | **Kesishgan (`Overlapping`) Freeze hamda Chegirmali (`50% Discount`) Freeze Basis & Cap (`C03`, `D14`):** Oyda `12` dars (`gross = 480,000` so‘m). `[L5..L8]` va `[L7..L10]` ustma-ust freeze qilindi (`6` ta noyob dars).<br>15a) Chegirmasiz (`net = 480,000`);<br>15b) `50%` chegirmali (`net = 240,000`). | Kesishgan `L7, L8` ga ikki marta kredit berilmaydi (`6` ta noyob dars).<br>**15a (Chegirmasiz, `net=480,000`):** **A policy (`LESSON_PROPORTIONAL`):** `480,000 * 6 / 12 = 240,000` so‘m; **B policy (`DAY_PROPORTIONAL`, 16/30 kun):** `256,000` so‘m.<br>**15b (50% chegirmali, `net=240,000`, `C03`):** `NET_EARNED_PROPORTIONAL` taklifi ostida `credit = 240,000 * 6 / 12 = 120,000` so‘m (o‘qilgan 6 dars tekin bo‘lib qolmaydi; jami kredit `net_charge` dan oshmaydi — `DECISION_REQUIRED: D14`). | `SOURCE_RULE` + `DECISION_REQUIRED` (`C03`, `D14`) | `T01.02`, `T09.03`, `T09.05` |
| <a id="case-16"></a>**`CASE-16`** | `BR-08` | **Sababsiz dars qoldirish (`Unexcused Absence`):** O‘quvchi (`invoice = 480,000` so‘m) ogohlantirishsiz va kasallik ma’lumotnomasisiz 3 ta darsga kelmadi (`ABSENT_UNEXCUSED`). | Dars puli kuyadi (`PDF p.5 Sec 4.6`): `credit = 0` so‘m, `invoice_charge = 480,000` so‘m o‘zgarmaydi. | `SOURCE_RULE` (`PDF p.5 Sec 4.6`) | `T09.03` |
| <a id="case-17"></a>**`CASE-17`** | `BR-08` | **Guruhdan chiqish (`Withdrawal`), eski qarz saqlanishi va qayta yozilish (`Re-enrollment`):** O‘quvchi `200,000` so‘m qarzi bor holatda `2026-11-20` da guruhdan chiqdi (`sabab = 1: To'lovga qiynaldi`), `2026-12-10` da qayta yozildi. | Chiqishda sabab tanlanmasa `422`. Chiqqandan keyin eski `200,000` so‘m qarz o‘chirilmaydi (`debt = 200,000` so‘m saqlanadi). `2026-12-10` da qayta yozilganda yangi `Enrollment` ochiladi, noyabrdagi eski enrollment va ledger tarixi o‘zgarmaydi. | `SOURCE_RULE` + `PROPOSED` (`T06.03`, `T09.04`) | `T06.03`, `T09.04` |
| <a id="case-18"></a>**`CASE-18`** | `BR-09` | **Kechki kassa smena yopish (`Cash Shift Reconciliation` — Manba misoli):** `Opening = 0` so‘m, `Naqd tushum = 3,200,000` so‘m, `Plastik/Click = 1,800,000` so‘m, `Naqd xarajat = 150,000` so‘m (`PDF p.5`). | `expected_closing_cash = 0 + 3,200,000 - 150,000 = 3,050,000` so‘m. Plastik/Click (`1,800,000` so‘m) alohida satrda ko‘rsatiladi va naqd kassa qoldig‘iga qo‘shilmaydi. | `SOURCE_RULE` (`PDF p.5 Sec 4.5`) | `T11.04`, `T11.05` |
| <a id="case-19"></a>**`CASE-19`** | `BR-10` | **1-kunlik O‘rindosh O‘qituvchi (`Substitute Teacher`) dars haqi taqsimoti:** Guruhda oyda `12` dars bor; asosiy o‘qituvchi `T_main` `11` ta dars o‘tdi, `1` kun kasal bo‘lganida `T_sub` o‘rindosh bo‘lib dars o‘tdi (`PDF p.8, 4-Loop`). | **A policy ostida (`PER_LESSON_RATE`, `PROPOSED` stavka = `100,000` so‘m/dars):** `T_main = 1,100,000` so‘m (`11` dars), `T_sub = 100,000` so‘m (`1` dars).<br>**B policy ostida (`POOL_SHARE`, `PROPOSED` guruh maosh fondi = `2,400,000` so‘m):** `T_main = 2,200,000` so‘m (`11/12`), `T_sub = 200,000` so‘m (`1/12`) (`DECISION_REQUIRED: D11`). | `SOURCE_RULE` + `DECISION_REQUIRED` (`D11`) | `T07.03`, `T18.02`, `T18.05` |
| <a id="case-20"></a>**`CASE-20`** | `BR-10` | **Yopilgan oylik maosh (`Closed Payroll Snapshot`) ga keyingi oyda tuzatish kiritish:** Oktabr oyi payroll snapshoti `2,000,000` so‘m bilan yopilgan (`CLOSED`). Noyabrda oktabr oyiga tegishli `-100,000` so‘m maosh tuzatishi aniqlandi. | Oktabr oyining `PayrollSnapshot` yozuvi (`2,000,000` so‘m) **o‘zgarmaydi (`immutable`)**; noyabr oyi payroll hisobida alohida `PayrollAdjustmentEntry = -100,000` so‘m (`reference_period = 2026-10`) yaratiladi. | `PROPOSED` (`05_DOMAIN_RULES.md`, `T18.02`) | `T18.02` |
| <a id="case-21"></a>**`CASE-21`** | `BR-11` | **Oflayn davomat va kechikkan (`Stale`) Excel to‘qnashuvi:** O‘qituvchi `L5` darsi uchun mobil ilovada `Student A = ABSENT` deb submit qildi (`version = 2`). Keyin Admin `version = 1` da yuklab olingan eski Excel faylni (`Student A = PRESENT`) import qilmoqda. | Excel import `L5 / Student A` qatorini `409 STALE_ROW_CONFLICT` sifatida qizil ko‘rsatadi va o‘qituvchi davomatini buzib yubormaydi (`PDF p.6`). O‘zgartirish faqat Admin UI da sababli override orqali mumkin. | `SOURCE_RULE` (`PDF p.6 Sec 5`) | `T12.03`, `T12.05`, `T16.05` |
| <a id="case-22"></a>**`CASE-22`** | `BR-05` | **Va’da sanasidan oldin to‘langan qarzga `09:00` eslatmasini bekor qilish:** `15-noyabr` ga `200,000` so‘m va’da berilgan edi; ota-ona `14-noyabr` kuni `200,000` so‘m to‘ladi (`remaining_debt = 0`). `15-noyabr` soat `09:00` da worker ishga tushdi. | `14-noyabr` to‘lovi vaqtida `PromiseToPay` statusi `FULFILLED`/`CANCELLED` bo‘ladi; `15-noyabr 09:00` da worker qarz `0` ekanini ko‘rib, ota-onaga ham, Adminga ham eslatma **yubormaydi**. | `PROPOSED` (`05_DOMAIN_RULES.md`, `T11.03`, `T13.02`) | `T11.03`, `T13.02`, `T13.05` |

---

<a id="sec-4-open-questions-summary"></a>
## 4. Biznes Egasi (User / Markaz Rahbari) Tasdig‘ini Kutayotgan Ochiq Savollar Jamlanmasi

Quyidagi jadvalda `01.02` biznes qoidalaridagi barcha ochiq qarorlar (`DECISION_REQUIRED`) variantlari, muhandislik tavsiyasi + asosi, ta’sirlangan steplar va qaysi implementatsiyadan oldin zarurligi bilan jamlangan (to‘liq reestr: `docs/spec/decisions.md`):

| Decision ID | Bog‘liq BR-ID | Ochiq biznes savoli va Variantlar (`Alternatives`) | Muhandislik tavsiyasi va Asosi (`Recommendation & Rationale`) | Affected Steps | Due Before (Qaysi stepdan oldin zarur) |
| :---: | :---: | :--- | :--- | :--- | :---: |
| **`D03`** | `BR-01`, `BR-02` | **Tarif rejimlari:** Markazda (A) Kalendar oy + Pro-rata, (B1) Sanadan-sanaga Rolling Month va (B2) 12-dars abonement paketlarining qaysilari yoqiladi? | **Tavsiya:** Uchala rejimni guruh/kurs sozlamasida tanlanadigan alohida siyosat (`CALENDAR_PRO_RATA`, `ROLLING_MONTH`, `LESSON_PACKAGE_12`) sifatida qo‘llab-quvvatlash (`02_DECISIONS.md`). *Asos:* PDF 4.1 da markaz qoidasiga qarab tanlanishi aytilgan. | `08.01`, `08.02`, `08.04`, `15.03` | `S08.01` (`Stage 08`) |
| **`D21`** | `BR-02` | **31-sana renewal va 12-dars paketida bekor qilingan dars:**<br>1) 31-yanvarda boshlangan rolling oy fevraldan keyin martda `31-mart`ga qaytadimi (`A`) yoki `28/29`da qoladimi (`B`)?<br>2) Markaz bekor qilgan dars 12-dars balansidan yechilmaydimi (`A`) yoki keyingi oyga kredit beriladimi (`B`)? | **Tavsiya:** 1) `A (ANCHOR_31_RESTORE)` — boshlang‘ich billing anchor kunini saqlash; 2) `A (PRESERVE_PACKAGE_BALANCE)` — markaz aybi bilan o‘tilmagan darsni o‘quvchi paketidan yechmaslik. *Asos:* Ota-ona uchun eng tushunarli va adolatli hisob. | `07.02`, `08.02`, `08.04` | `S08.02` (`Stage 08`) |
| **`D14`** | `BR-01`, `BR-03`, `BR-04`, `BR-08` | **Yaxlitlash, Chegirma stacking, Trial no-show va Freeze krediti:**<br>1) Kasr summalar qanday yaxlitlanadi (`1 so‘m` vs `100 so‘m` vs `1 000 so‘m`)?<br>2) Oilaviy + 50% chegirma ustma-ust tushsa qaysi tartib ishlaydi (`A: eng kattasi`, `B: fiks->foiz`, `C: foiz->fiks`)?<br>3) Trial 1-darsdan keyin necha kunda/darsda Admin follow-up ochiladi?<br>4) Freeze krediti dars soniga (`A`) yoki kalendar kunga (`B`) proporsionalmi? | **Tavsiya:** 1) Ichki hisobda `1 so‘m HALF_UP` (yoki naqd kassa uchun `1 000 so‘m` opsiyasi); 2) `A (HIGHEST_ONLY)` yoki Rahbar tasdiqlash ekranida aniq yakuniy summani ko‘rsatish; 3) 2-rejalashtirilgan darsda `ABSENT` bo‘lishi bilan (yoki `48 soat` ichida); 4) `A (LESSON_PROPORTIONAL)` — pro-rata bilan bir xil mantiqda dars ulushi bo‘yicha. | `08.01`, `08.03`, `09.01`–`09.03`, `13.04` | `S08.01` / `S09.01` |
| **`D22`** | `BR-06`, `BR-07` | **Refund va Storno qarzni qayta ochishi:** Xato to‘lov storno qilinganda va haqiqiy pul qaytarilganda (`Cash Refund`) invoice qarzi qanday o‘zgaradi? | **Tavsiya:** Xato kiritilgan to‘lov reversal qilinganda (`A`) allocation yechilib invoice qarzi qayta ochiladi; o‘quvchi ketayotganda qolgan darslar uchun pul qaytarilsa (`B`), avval `CreditNote` bilan hisob kamaytirilib, keyin ortiqcha pul `Cash Refund` qilinadi (qarz `0` qoladi). | `10.02`, `10.03`, `11.04` | `S10.02` (`Stage 10`) |
| **`D11`** | `BR-10` | **O‘qituvchi va O‘rindosh maoshi (`Payroll`) formulasi:** Maosh stavkasi (`Fixed` / `Per-lesson` / `Percentage`), 50% chegirma va 100% grant o‘quvchilarning foizli maoshga ta’siri hamda 1-kunlik o‘rindosh ulushi qanday hisoblanadi? | **Tavsiya:** Guruh/o‘qituvchi shartnomasida 3 ta rejimdan birini tanlash; o‘rindoshga o‘tilgan 1 dars stavkasini (`per_lesson_rate` yoki `1 / total_lessons` ulushini) avtomatik ajratish; grant/chegirma ta’sirini markaz sozlamasida (`collected_cash` vs `base_tariff`) tanlanadigan qilish. | `07.03`, `18.02`, `24.04` | `S18.02` (`Stage 18`) |
| **`D12`** | `BR-05`, `BR-09` | **Click / Payme / Perechisleniye:** v2.0 da faqat kassada to‘lov usulini qo‘lda qayd etishmi (`A`) yoki real merchant API/webhook integratsiyasimi (`B`)? | **Tavsiya:** `A (MANUAL_METHOD_RECORDING)` — v2.0 bazasida Admin to‘lov usulini qo‘lda tanlab qayd etadi (`02_DECISIONS.md`). Real gateway merchant shartnomasi bo‘lganda alohida modul sifatida ulanadi. | `10.01`, `11.04`, `15.02` | `S10.01` (`Stage 10`) |
| **`D13`** | `BR-05`, `BR-07` | **Elektron kvitansiya maqomi:** Botdan boradigan kvitansiya markazning ichki elektron kvitansiyasimi (`A`) yoki soliq (OFD/fiskal QR) integratsiyasimi (`B`)? | **Tavsiya:** `A (INTERNAL_ELECTRONIC_RECEIPT)` — noyob raqamli ichki elektron kvitansiya (`02_DECISIONS.md`, `T10.04`); fiskal chek deb da’vo qilinmaydi. | `10.04`, `14.03` | `S10.04` (`Stage 10`) |
