# EduERP v2.0 — Qabul Mezonlari, Talablar Xaritasi va Regressiya Guruhlari (`docs/spec/acceptance.md`)

<a id="acc-meta"></a>
- **Task / Step ID:** `S01-FIX-S02-FULL-D` / Step `01.03` (`T01.03` — `C02` va `C06` tuzatishlari bilan yangilangan tahrir)
- **Base Commit:** `dbd2a673cf70f915d2812f10d120e496167c5ae7`
- **Juftlikdagi jadval fayli:** `docs/spec/acceptance.csv` (119 ta noyob `requirement_id`: 23 ta `R01`–`R23` manba talab guruhi + 96 ta `R01.01`–`R24.04` step talabi)
- **Manbalar:** `planning/execution.json` (`T01.01`–`T24.05`), `planning/SOURCE_REQUIREMENTS.csv`, `planning/requirements.csv`, `docs/spec/scope.md`, `docs/spec/business-rules.md`, `docs/spec/decisions.md`
- **Hujjat maqomi:** `IN_REVIEW` (Step `01.03` spetsifikatsiyasi; kelajakdagi dastur xatti-harakati hali bajarilmagan va `PLANNED` / `DECISION_REQUIRED` sifatida belgilangan).

---

<a id="sec-1-two-level-coverage-model"></a>
## 1. Ikki Darajali Qamrov Modeli (`119 Unique ID` va Criterion ID Qoidasi)

1. **119 ta ID — 119 ta mustaqil PDF jumlasi emas, balki ikki darajali qamrov xaritasi (`Two-Level Coverage Map`):**
   - **1-daraja (Manba talab guruhlari — `R01`..`R23`, 23 ta qator):** `planning/SOURCE_REQUIREMENTS.csv` dagi 23 ta yirik talab guruhi bo‘lib, PDFning 1–8-sahifalaridagi biznes maqsadlarini jamlaydi. Har bir `R01`..`R23` guruh bitta yoki bir nechta aniq ijro steplariga (`owner_steps`) bog‘langan va ular uchun `AC-R01`..`AC-R23` noyob mezon identifikatorlari (`criterion_id`) yaratilgan.
   - **2-daraja (Ijro qadamlari talablari — `R01.01`..`R24.04`, 96 ta qator):** `planning/requirements.csv` va `planning/execution.json` dagi 96 ta asosiy ish qadami bo‘lib, ularning kanonik `T01.01`..`T24.04` identifikatorlari o‘zgartirilmasdan aynan `criterion_id` sifatida saqlangan (`T01.05`..`T24.05` stage review mezonlari esa 4-bo‘limda keltirilgan).
2. **`AC-R01`..`AC-R23` <-> `T01.01`..`T24.04` Mapping Qoidasi:**
   - Mavjud `T01.01`–`T24.05` identifikatorlaridan birortasi o‘zgartirilmadi.
   - `R01`–`R23` manba guruhlari CSVda `criterion_id = AC-R01..AC-R23` ga ega bo‘lib, `owner_steps` ustuni orqali o‘zining tegishli `TXX.YY` step mezonlariga to‘g‘ridan-to‘g‘ri bog‘langan (masalan, `R01` / `AC-R01` -> `01.01,05.01,05.02,05.03,05.04,15.03,17.01` -> `T01.01`, `T05.01`–`T05.04`, `T15.03`, `T17.01`).

---

<a id="sec-2-validation-status-and-source-distinction"></a>
## 2. Manba vs Muhandislik Statusi va `validation_status` Qoidalari

Har bir qabul mezoni uchun haqiqiy tekshiruv holati bilan kelajakdagi runtime testi qat’iy farqlanadi (`S01-FULL-C.md` 77-satr):

| `validation_status` qiymati | Ma’nosi va Qo‘llanish chegarasi | Misollar |
| :--- | :--- | :--- |
| **`VERIFIED_DOC_S01`** | Stage 01 (`01.01`–`01.04`) hujjat va arifmetik qamrov talablari bo‘lib, ularning dalili `docs/verification/01.01.md` va `docs/verification/S01.md` da Python stdlib skriptlari bilan real tekshirilgan. | `R01.01` (`T01.01`), `R01.02` (`T01.02`), `R01.03` (`T01.03`), `R01.04` (`T01.04`) |
| **`PLANNED`** | Mezon va invariant aniq (`03_ARCHITECTURE.md`, `05_DOMAIN_RULES.md`, `07_SECURITY_AND_RELEASE.md`), ammo mahsulot kodi hali yozilmagan (`S02`–`S24` da bajariladi va executable test bilan tasdiqlanadi). | `R02.01`–`R05.04`, `R06.01`–`R07.02`, `R10.01`, `R12.01`–`R13.03`, `R16.01`–`R16.04` va b. |
| **`DECISION_REQUIRED`** | Mezon ichida o‘zgarmas texnik invariantlar (masalan, idempotency, atomic tx, append-only) aniq yozilgan, biroq yakuniy raqamli yoki siyosiy natija (`A policy ostida ..., B policy ostida ...`) `D01`–`D25` / `OPEN_RBAC` / `OPEN_CHANNEL` qarorining biznes egasi tomonidan tasdiqlanishiga bog‘liq. | `R06` (`D03`/`D21`), `R08` (`D14`), `R20` (`D11`), `R08.01` (`D14`), `R08.02` (`D03`/`D21`), `R09.02` (`D14`), `R09.03` (`D14`), `R10.03` (`D22`), `R18.02` (`D11`), `R22.04` (`D25`) va b. |

---

<a id="sec-3-accepting-roles"></a>
## 3. Tasdiqlovchi va Sinovchi Rollar (`Actor` Ustuni Qoidasi)

`docs/spec/acceptance.csv` dagi `actor` ustuni har bir talabni kim bajarishi va kim qabul qilishini belgilaydi:
1. **Biznes / Foydalanuvchi rollari (`PDF 3–4-sahifalar`):**
   - `Rahbar (Director)`: Moliya/kassa tushumi, qarz prognozi, 50% chegirma va 100% grant tasdig‘i, Storno/Refund tasdig‘i, qizil xavfsizlik auditi, o‘qituvchi maoshi va churn hisobotlari.
   - `Admin (Manager/Cashier)`: 15s ro‘yxatga olish, to‘lov va majburiy va’da sanasi, kechki smena yopish, guruh/jadval va 1-kunlik o‘rindosh tayinlash, Locked Excel import/export, bot ulanmagan qarzdorlar va trial no-show bilan bog‘lanish.
   - `Teacher (yoki Substitute Teacher)`: Faqat o‘z guruhi (yoki 1-kunlik zamena darsi) uchun 30s oflayn/onlayn davomat va imtihon ballari/izohlari.
   - `Parent (Guardian via Telegram Bot)`: 1 marta telefon tasdiqlash, davomat/kvitansiya/va’da xabarlarini olish, "Balans va Davomat" tugmasi.
   - `Vendor (Platform Owner)`: Markazni auto-provisioning (`deploy_center.sh`) bilan ko‘tarish, `apps/vendor` orqali Read-Only Kill-Switch litsenziyasini boshqarish, tungi zaxira/restore va 1–3 oylik onboarding.
2. **Texnik / Sifat nazorati rollari (`Technical Steps`):**
   - `Developer / Reviewer (Codex)`: Arxitektura kontraktlari (`S02`), repo/CI poydevori (`S03`), PostgreSQL sxema/migratsiya/constraintlar (`S04`), DB outbox/worker mexanizmlari (`S13.01`) va regressiya/xavfsizlik testlari (`S23`).

---

<a id="sec-4-regression-suites-and-stage-gates"></a>
## 4. Regressiya Guruhlari va Bosqich Darvozalari (`T01.05` – `T24.05`)

Har bir stage yakunidagi `.05` review stepi oldingi steplar dalilini va quyidagi stage-level regressiya darvozasini tekshiradi (`planning/execution.json` va `06_INTEGRATION_GATES.md`):

| Stage | Review Test ID | Stage Darvozasi va Regressiya Mezonlari (`T01.05`–`T24.05`) | Bog‘liq Integratsiya Darvozasi (`06_INTEGRATION_GATES.md`) |
| :-: | :-: | :--- | :--- |
| **`S01`** | `T01.05` | Barcha ochiq moliyaviy qarorlar egasi bilan belgilangan; tasdiqlanmagan qoida kodga aylantirilmaydi. | Stage 02–24 uchun kirish spetsifikatsiyasi |
| **`S02`** | `T02.05` | Har API uchun rol va xato kodi bor; boshqa markaz bazasiga marshrut yo‘q. | `packages/contracts` (OpenAPI & Events) |
| **`S03`** | `T03.05` | Toza checkout hujjatdagi buyruqlar bilan ishga tushadi; CI yashil. | JS va Flutter alohida toolchain lock |
| **`S04`** | `T04.05` | Bo‘sh bazada migratsiya o‘tadi; runtime DB roli ledgerni o‘chira olmaydi. | PostgreSQL FK/unique + append-only ledger |
| **`S05`** | `T05.05` | ID almashtirib kirish urinishlari `403`/`404`; response va exportlarda ham shaxsiy telefon yashirilgan (`raw phone` Teacher DTO/SQLite/logda yo‘q). | Staff-only RBAC + IDOR himoyasi |
| **`S06`** | `T06.05` | Bitta telefonli ikki farzand saqlanadi; bir o‘quvchini ikki marta qo‘shish aniqlanadi. | Guardian-Student M:N + sibling-safe dedup |
| **`S07`** | `T07.05` | Bir kunda ikki dars to‘qnashmaydi; o‘rindosh huquqi darsdan tashqari amal qilmaydi. | `LessonOccurrence` + 1-darslik Substitute |
| **`S08`** | `T08.05` | `480000 × 7/12 = 280000`; qayta ishga tushirishda ikkinchi qarz yozilmaydi. | `S08.03` trial port -> `S12.04` attendance; `S08.04` adjustment port -> `S09` |
| **`S09`** | `T09.05` | Tasdiqsiz chegirma ishlamaydi; overlapping freeze ikki kredit bermaydi; grant qarzi nol. | `S08.04` invoice adjustment portini yopadi |
| **`S10`** | `T10.05` | Ikki parallel bir xil idempotency key bitta to‘lov yaratadi; reversal originalni o‘zgartirmaydi. | `S10.01` payment command -> `S11.01` shift & `S11.03` promise |
| **`S11`** | `T11.05` | `3200000 naqd − 150000 xarajat = 3050000`; karta naqd qoldiqqa qo‘shilmaydi. | `S10.01` payment + shift + promise atomik integratsiyasi |
| **`S12`** | `T12.05` | Eski Excel yangi mobil davomatni buzmaydi; retransmit yangi hodisa yaratmaydi. | `S08.03` trial conversion portini submitted attendance bilan yopadi |
| **`S13`** | `T13.05` | Worker to‘xtab qaytsa hodisalar yo‘qolmaydi; bekor qarzga eslatma ketmaydi. | Outbox lease + 09:00 promise + 20m teacher ping |
| **`S14`** | `T14.05` | Begona raqam bilan bola ochilmaydi; API `accepted` holati o‘qildi deb ko‘rsatilmaydi. | Bot callback -> Backend Command API (`D06`) |
| **`S15`** | `T15.05` | Rollar bo‘yicha end-to-end oqim; double click ikki to‘lov yaratmaydi; xato va loading holatlari bor. | `S15` web shell -> `S16.04` Excel UI, `S18.04` reports, `S22.04` help slot |
| **`S16`** | `T16.05` | Previewdan keyin o‘zgargan qator conflict; xatoli fayl bazaga qisman tushmaydi; ism bo‘yicha match yo‘q. | `S15` web shell ichida `ImportPage` to‘liq preview/commit UI |
| **`S17`** | `T17.05` | Airplane mode -> app restart -> reconnectda davomat saqlanadi; konflikt ko‘rinadi; logout eski akkaunt queue sini yubormaydi. | `S17.04` mobile report port -> `S18.04`; `S17` mutation UX -> `S19` license |
| **`S18`** | `T18.05` | Hisobot ledger bilan teng; grant, refund va substitute maoshga tasdiqlangan qoida bo‘yicha ta’sir qiladi. | `S15.04` va `S17.04` dashboard portlarini haqiqiy API bilan yopadi |
| **`S19`** | `T19.05` | Read-onlyni worker yoki sync orqali chetlab bo‘lmaydi; ma’lumot o‘chmaydi; xabar navbati siyosati sinovdan o‘tadi. | `S15`/`S17` mutation UX + offline queue revalidation |
| **`S20`** | `T20.05` | Ikki markaz testida baza/fayl/bot aralashmaydi; yarim deploydan qayta ishga tushirish xavfsiz. | Synthetic staging deploy -> `S21.02` restore drill & `S23` release |
| **`S21`** | `T21.05` | Zaxiradan alohida muhitda to‘liq restore qilinadi; RPO/RTO o‘lchanadi; kalit backup bilan birga saqlanmaydi. | Production deploy ruxsati uchun restore gate |
| **`S22`** | `T22.05` | Demo kontaktlar real shaxslarga yubormaydi; tasdiqli demo chatda to‘liq ssenariy ishlaydi. | `S15` help slot (`CONTENT_PENDING` yoki tayyor video asset) |
| **`S23`** | `T23.05` | Pul yo‘qolishi, begona ma’lumot yoki restore xatosi ochiq bo‘lsa release bloklanadi. | Barcha `REQUIRED` integratsiyalar `CLOSED` bo‘lishi shart |
| **`S24`** | `T24.05` | Birinchi oy hisoblari rahbar bilan solishtirilgan; muammolar egasi va patch natijasi yozilgan. | Haqiqiy mijoz sign-offisiz `DONE` / `APPROVED` berilmaydi (`B25`) |
