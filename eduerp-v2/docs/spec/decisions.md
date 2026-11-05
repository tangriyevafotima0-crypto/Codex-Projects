# EduERP v2.0 — Qarorlar Registri, Biznes Savollar va Upstream Manba Tuzatishlari (`docs/spec/decisions.md`)

<a id="dec-meta"></a>
- **Task / Step ID:** `S01-FIX-S02-FULL-D` / Step `01.04` (`T01.04` — `C03`–`C06` tuzatishlari bilan yangilangan tahrir)
- **Base Commit:** `dbd2a673cf70f915d2812f10d120e496167c5ae7`
- **Asosiy manbalar:** `planning/02_DECISIONS.md` (`D01`–`D25`), `planning/state/DECISIONS.md`, `planning/source/MASTER_SOURCE_TEXT.md`, `docs/spec/scope.md`, `docs/spec/business-rules.md`, `docs/spec/acceptance.md`.
- **Hujjat maqomi:** `IN_REVIEW` (**Muhim qoida:** `planning/state/DECISIONS.md` ga ko‘ra hozircha foydalanuvchi/mijoz tomonidan tasdiqlangan (`ACCEPTED`) biznes qarori yo‘q (`evidence = NONE_YET`). Shu sababli hech bir qaror uydirma ravishda `ACCEPTED` deb yozilmadi; barcha `D01`–`D25` hamda `OPEN_RBAC` / `OPEN_CHANNEL` savollari `PROPOSED` / `DECISION_REQUIRED` / `DEFERRED` maqomida, mas’ul rol egasi (`decision_owner`), ta’sirlangan steplar (`affected_steps`) va bloklash chegarasi (`due_before`) bilan qayd etildi).

---

<a id="sec-1-blocking-policy"></a>
## 1. Qaror Maqomlari va Tanlab Bloklash Qoidasi (`Selective Blocking Policy` — `T01.04`)

1. **Maqomlar (`Status`):**
   - **`PROPOSED`:** Muhandislik/arxitektura tavsiyasi mavjud va xavfsiz default/kontrakt sifatida loyihalashtirilishi mumkin, biroq yakuniy sign-off hali olinmagan.
   - **`DECISION_REQUIRED`:** Biznes/moliya hisob-kitobi yoki vakolat chegarasi tanlangan variantga (`A` vs `B`) qarab turli natija beradi; tegishli modul kodini yozishdan (`due_before`) oldin Product Owner / Markaz Rahbari qarori talab qilinadi.
   - **`DEFERRED`:** Pilot yoki keyingi bosqichga (`S21`/`S22`/`S24` yoki alohida shartnomaga) qoldirilishi mumkin bo‘lgan opsiyalar.
   - **`ACCEPTED`:** Faqat Product Owner yoki vakolatli mas’ulning haqiqiy tasdiq dalili (`state/DECISIONS.md` da sana va commit/xabar) bo‘lgandagina qo‘yiladi (**hozir: `0` ta `ACCEPTED`**).
2. **Tanlab Bloklash: Arxitektura Loyihasi (`S02`) vs Eng Erta Implementatsiya Darvozasi (`Earliest Implementation Gate` — `C05` tuzatishi, `T01.04`):**
   - **Stage 02 (`02.01`–`02.05` Arxitektura va Kontraktlar) bloklanmaydi:** Ochiq qarorlar (`DECISION_REQUIRED`) Stage 02 da `BillingPolicyVersion`, `PayrollModel`, `FreezeBasis` kabi konfiguratsiya portlari va shartli (`conditional`) sxema sifatida loyihalashtiriladi (`09_BATCH_POLICY.md`).
   - **Implementatsiya (`S04`–`S24`) darvozalari:** Har bir ochiq qaror butun reponi emas, balki aynan o‘zining **eng erta kod implementatsiya qadamini (`due_before_implementation`)** bloklaydi:
     - `D19` (Retention muddati): `04.01` da *cascade delete yo‘qligi* qat’iy invariant sifatida bajariladi; *arxiv/zaxira saqlash muddati (kun/yil)* esa `21.01` dan oldin tasdiqlanishi shart (`due_before_implementation = 04.01 (soft-archive invariant) / 21.01 (retention TTL)`).
     - `OPEN_RBAC_01` (Admin staff yaratish huquqi): `05.02` / `05.03` dan oldin.
     - `D11` (Payroll va zamena ulushi): `07.03` da *darsga `pay_recipient_teacher_id` snapshot yozish* strukturasi quriladi; *aniq pul/foiz hisoblash formulasi* esa `18.02` ni bloklaydi (`due_before_implementation = 07.03 (recipient snapshot) / 18.02 (payroll formula)`).
     - `D03`, `D14`, `D21` (Tarif, pro-rata, chegirma stacking, freeze basis/cap): `08.01` / `08.02` / `09.01` dan oldin.
     - `D22` (Refund va qarzni qayta ochish): `10.02` / `10.03` dan oldin.

---

<a id="sec-2-top-5-priority-questions"></a>
## 2. Biznes Egasiga (Product Owner) Beriladigan Eng Dolzarb 5 ta Savol (`Top-5 Priority Questions`)

Menejer (Codex) foydalanuvchidan tez va oson javob olishi uchun eng muhim 5 ta biznes savol birinchi o‘rinda jamlandi:

| № | Qaror ID | Qisqa Savol (Foydalanuvchi tanlashi uchun A / B / C variantlar) | Muhandislik Tavsiyasi (`PROPOSED`) | Qachongacha zarur (`Due Before`) |
| :-: | :-: | :--- | :--- | :---: |
| **1** | **`D03` & `D21`** | **Tarif va Abonement rejimi:** Markazlarda faqat **(A)** Kalendar oy (1-sana + pro-rata) va **(B)** 12-darslik paket ishlatiladimi yoki **(C)** Sanadan-sanaga (masalan, 12-noyabrdan 12-dekabrgacha) Rolling Month ham kerakmi? 12-dars paketida markaz bekor qilgan dars o‘quvchi balansidan **yechilmaydimi (`A`)** yoki keyingi oyga kredit bo‘ladimi (`B`)? | **Tavsiya:** Uchala rejimni guruh sozlamasida tanlanadigan qilish; 31-sana renewalda `31-anchor`ni saqlash (`A`); markaz bekor qilgan darsni 12-dars balansidan yechmaslik (`A`). | `08.01` / `08.02` (`Stage 08`) |
| **2** | **`D14`** | **Chegirma, Freeze va Yaxlitlash:** 1) Oilaviy + 50% chegirma ustma-ust tushsa **faqat eng kattasi (`A`)** ishlaydimi yoki ketma-ket qo‘shiladimi (`B: fiks->foiz`, `C: foiz->fiks`)? 2) Sababli Freeze krediti keyingi oyga **dars ulushi (`A: frozen/total`)** bo‘yichami yoki kalendar kun (`B`) bo‘yicha o‘tadimi? 3) Kasr summalar **1 so‘mgacha (`A`)** yoki **1 000 so‘mgacha (`B`)** yaxlitlanadimi? | **Tavsiya:** 1) `A (HIGHEST_ONLY)` — kassa adashmasligi uchun bitta eng katta chegirma; 2) `A (LESSON_PROPORTIONAL)` — pro-rata bilan bir xil mantiqda dars ulushi; 3) Hisobda `1 so‘m HALF_UP`. | `08.01` / `09.01` (`Stage 08–09`) |
| **3** | **`D11`** | **O‘qituvchi va Zamena Maoshi (`Payroll`):** O‘qituvchi oyligi **(A)** Darsbay (`Per-lesson`), **(B)** Fiks oylik (`Fixed`), **(C)** Tushumdan foiz (`Percentage`) — qaysi biri asosiy? Foizli maoshda 50% chegirma va 100% grant o‘quvchilar uchun o‘qituvchiga **haqiqiy tushgan puldan (`A`)** yoki **to‘liq bazaviy tarifdan (`B`)** foiz yoziladimi? | **Tavsiya:** Guruh/o‘qituvchi profilida `Fixed` / `Per-lesson` / `Percentage` tanlanadigan bo‘lsin; zamena o‘qituvchisiga o‘tilgan 1 dars ulushi (`1/total_lessons` yoki `per_lesson_rate`) avtomatik ajratilsin; foiz stavkasi `net_collected_cash` (`A`) + grant uchun fiks bonus opsiyasi bilan hisoblansin. | `07.03` / `18.02` (`Stage 07 / 18`) |
| **4** | **`D12` & `D22`** | **To‘lov Qaydi va Refund/Storno:** 1) v2.0 da Click/Payme to‘lovlarini Admin kassada **qo‘lda qayd etadimi (`A`)** yoki darhol jonli Click/Payme merchant API kerakmi (`B`)? 2) To‘lov qaytarilganda (`Refund`) xato to‘lov uchun **qarz qayta ochilishi (`A`)** va ketayotgan o‘quvchi uchun **CreditNote bilan qarz 0 yopilishi (`B`)** ma’qulmi? | **Tavsiya:** 1) `A (MANUAL_RECORDING)` — v2.0 da qo‘lda qayd etish (real gateway `DEFERRED`); 2) `A + B` — sabab turiga (`ERROR_STORNO` vs `WITHDRAWAL_REFUND`) qarab qarzni qayta ochish yoki CreditNote bilan yopish. | `10.01` / `10.02` (`Stage 10`) |
| **5** | **`D15` & `D24` & `OPEN_RBAC`** | **Mobil Ilova va Admin Vakolati:** 1) Staff mobil ilova **Flutter Android APK / Play Store (`A`)** bo‘ladimi yoki **PWA (`B`)**? 2) Admin yangi Teacher hisobini o‘zi yarata oladimi (`A`) yoki faqat Rahbar yaratadimi (`B`)? | **Tavsiya:** 1) `A (Flutter Android + SQLite)` — oflayn SQLite talabi uchun; 2) Admin Teacher hisobini yarata oladi, lekin Rahbar/Admin rolini bera olmaydi (`A`). | `05.02` / `17.01` (`Stage 05 / 17`) |

---

<a id="sec-3-decisions-registry-d01-d25"></a>
## 3. Kanonik Qarorlar Registri (`D01` – `D25`)

Har bir `D01`–`D25` qaror uchun `Muammo`, `Manba (Source)`, `Alternativalar`, `Tavsiya va Asos`, `Status`, `Decision Owner (Rol)`, `Affected Steps`, `Due Before` va `Evidence` to‘liq keltirilgan:

---

<a id="D01"></a>
### `D01` — Demo Markaz Talabalar Soni (`240` vs `250`)
- **Muammo:** PDF 2-sahifada Demo markazda `240` nafar o‘quvchi deyilgan, PDF 7-sahifada (5-Qadam) esa `250` talabali Demo markaz deyilgan.
- **Manba (`Source`):** `PDF p.2 Sec 2.1` vs `PDF p.7 Sec 6.1 (5-Qadam)`; `planning/02_DECISIONS.md#D01`.
- **Alternativalar:**
  - **A:** `240` nafar sintetik o‘quvchi — asosiy sotuv demo seed (`Sales Demo Pack`); `250` (yoki kattaroq) — yuklama/stress test fixture.
  - **B:** Demo seedni `250` nafar o‘quvchi qilib belgilash.
- **Tavsiya va sabab:** **A (`240` asosiy seed)** — `T22.01` qabul ssenariysida `240 synthetic student, 14 group, 6 teacher` invarianti allaqachon belgilangan (`14` guruhga o‘rtacha `17–18` o‘quvchidan to‘g‘ri taqsimlanadi).
- **Status:** `PROPOSED`
- **Decision Owner:** `Product Owner (User)` / `Tech Lead`
- **Affected Steps:** `01.04`, `22.01`, `22.03`
- **Due Before:** `22.01` (`Stage 22`)
- **Evidence:** `NONE_YET` (`state/DECISIONS.md`)

<a id="D02"></a>
### `D02` — Auto-Provisioning Vaqti (`5 daqiqa` vs `10 daqiqa`) va Old Shartlar
- **Muammo:** PDF 1-sahifada yangi markaz `10 daqiqada`, PDF 3- va 7-sahifalarda esa `5 daqiqada` avtomatik ko‘tarib beriladi deyilgan; DNS tarqalishi, VPS va BotFather token olish esa tashqi omillarga bog‘liq.
- **Manba (`Source`):** `PDF p.1 Sec 1 (band 2)`, `PDF p.3 Sec 2.2`, `PDF p.7 Sec 6.1 (5-Qadam)`; `planning/02_DECISIONS.md#D02`.
- **Alternativalar:**
  - **A:** `5–10 daqiqa` — VPS, DNS A-record, TLS va BotFather token tayyor bo‘lgandan keyin `deploy_center.sh` skriptining bajarilish maqsadi (SLO target), mutlaq SLA kafolati emas.
  - **B:** DNS va BotFather yaratishni ham skript vaqtiga qo‘shib hisoblash.
- **Tavsiya va sabab:** **A** — BotFather’da bot ochish Telegram qoidasiga ko‘ra qo‘lda (manual precondition) bajariladi (`T20.02`), DNS/TLS ham tashqi provayderga bog‘liq.
- **Status:** `PROPOSED`
- **Decision Owner:** `Product Owner (User)` / `DevOps Lead`
- **Affected Steps:** `01.04`, `02.01`, `20.01`, `20.02`
- **Due Before:** `20.02` (`Stage 20`)
- **Evidence:** `NONE_YET`

<a id="D03"></a>
### `D03` — Hisob-Kitob Rejimlari: Kalendar Oy (`1-sana`) vs Rolling Month (`12-dekabr`) vs `12 ta Dars` Paketi
- **Muammo:** PDF 4-sahifa `4.1-bo‘lim` B-Rejimida *"keyingi to‘lov muddati aniq 12-dekabr (yoki 12 ta dars tugaydigan kun)"* deb ikkita turli mexanizm (kalendar rolling oy va dars sanog‘i paketi) bitta qavs ichida yozilgan.
- **Manba (`Source`):** `PDF p.4 Sec 4.1`; `planning/02_DECISIONS.md#D03`; `docs/spec/business-rules.md#br-01`, `#br-02`.
- **Alternativalar:**
  - **A:** Uchta alohida rejimni (`CALENDAR_PRO_RATA`, `ROLLING_MONTH`, `LESSON_PACKAGE_12`) alohida siyosat sifatida modellashtirish va markaz/guruh sozlamasidan tanlash (`T08.02`).
  - **B:** Faqat ikkita rejim (`CALENDAR_PRO_RATA` va `LESSON_PACKAGE_12`) qoldirib, `12-dekabr`ni shunchaki haftada 3 marta dars bo‘lganda 12 ta dars tugaydigan taxminiy sana deb hisoblash.
- **Tavsiya va sabab:** **A** — `T08.02` qabul ssenariysi uchala rejimni alohida siyosat sifatida talab qiladi va turli o‘quv markazlari talabini to‘liq qondiradi.
- **Status:** `DECISION_REQUIRED`
- **Decision Owner:** `Product Owner (User)` / `Markaz Rahbari`
- **Affected Steps:** `01.02`, `01.04`, `08.01`, `08.02`, `08.04`, `15.03`, `23.01`
- **Due Before:** `08.01` (`Stage 08`)
- **Evidence:** `PARTIAL_ACCEPTED via OWNER-20261104-02 & OWNER-20261104-03 (per-center configurable billing_mode, due_date_rule ENROLLMENT_ANNIVERSARY vs CENTER_FIXED_DAY, collection_timing ADVANCE vs ARREARS, and per-center first_partial_charge_mode PRORATE_REMAINING_LESSONS vs FULL_CYCLE confirmed; initial prepaid fixed-day period and fixed-day short-month edge cases remain DECISION_REQUIRED fail-closed)`

<a id="D04"></a>
### `D04` — Edge Cases Soni (`8 ta` Deyilgan, Matnda `4.1`–`4.6` Oltita Bo‘lim Bor)
- **Muammo:** PDF 4-sahifa `4-bo‘lim` kirishida *"8 ta eng nozik hayotiy holat"* deyilgan, ammo faqat `4.1`–`4.6` oltita kichik bo‘lim raqamlangan (`4.5` va `4.6` ichida bir nechta qoida birlashtirilgan).
- **Manba (`Source`):** `PDF p.4–5 Sec 4 (4.1–4.6)`; `planning/02_DECISIONS.md#D04`.
- **Alternativalar:**
  - **A:** `4.1`–`4.6` ichidagi barcha ichki qoidalarni (1: Mid-month pro-rata/package, 2: Trial, 3: Family/50%/Grant, 4: Partial payment & Promise, 5: Immutable ledger & Storno, 6: Cash shift close, 7: Freeze, 8: Churn 5 sababi) to‘liq qamrab olish va uydirma `4.7`/`4.8` bo‘lim to‘qimaslik.
  - **B:** Sun’iy yangi edge-case bo‘limlari qo‘shish.
- **Tavsiya va sabab:** **A** — Manbaga 100% sodiq qoladi va barcha 8 ta mantiqiy holat `BR-01`..`BR-09` da qamrab olingan.
- **Status:** `PROPOSED`
- **Decision Owner:** `Tech Lead` / `Reviewer (Codex)`
- **Affected Steps:** `01.01`–`01.04`
- **Due Before:** `02.01` (`Stage 02`)
- **Evidence:** `NONE_YET`

<a id="D05"></a>
### `D05` — Self-Correction Loop Qadamlari (`4 bosqichli` Deyilgan, PDFda `A`–`C` Berilgan)
- **Muammo:** PDF 7–8-sahifalar `7-bo‘lim`da *"4 bosqichli algoritm"* deyilgan, lekin faqat `A-Bosqich (Real Kuzatuv)`, `B-Bosqich (Interfeysni Soddalashtirish)` va `C-Bosqich (Avto-Himoya / Guardrail)` yozilgan.
- **Manba (`Source`):** `PDF p.7–8 Sec 7`; `planning/02_DECISIONS.md#D05`.
- **Alternativalar:**
  - **A:** PDFdagi `A–C` bosqichlarni manba talabi sifatida saqlab, 4-bosqich sifatida **`D-Bosqich: Regressiya sinovi va natijani qayta o‘lchash`** (`kuzatuv -> ustuvorlik -> patch -> regression -> natijani o'lchash`, `T24.03`) ni muhandislik taklifi sifatida kiritish.
  - **B:** Faqat 3 ta bosqich (`A–C`) bilan cheklanish.
- **Tavsiya va sabab:** **A** — Har qanday patchdan keyin regressiya va samarani o‘lchash (`T24.03`) sifat nazorati siklini mantiqan yakunlaydi.
- **Status:** `PROPOSED`
- **Decision Owner:** `Product Owner (User)` / `Tech Lead`
- **Affected Steps:** `01.01`, `01.04`, `24.03`
- **Due Before:** `24.03` (`Stage 24`)
- **Evidence:** `NONE_YET`

<a id="D06"></a>
### `D06` — Telegram Bot Arxitekturasi ("Bot Bazani O‘zgartirmaydi" vs "Rahbar Botda Tasdiqlaydi")
- **Muammo:** PDF 6-sahifada *"Bot o‘zi bazani o‘zgartirmaydi — u faqat Markaziy Serverdagi tasdiqlangan ma’lumotni o‘qiydi"* deyilgan, PDF 4–5-sahifalarda esa Rahbar Telegram botda 50% chegirmani tugma bosib tasdiqlashi aytilgan.
- **Manba (`Source`):** `PDF p.4–5 Sec 4.3` vs `PDF p.6 Sec 5 (Komponent 4)`; `planning/02_DECISIONS.md#D06`.
- **Alternativalar:**
  - **A (`Backend Command API`):** Bot servisi (`apps/bot`) PostgreSQL bazasiga bevosita ulanmaydi va yozmaydi; Rahbarning tasdiqlash callbacki (`callback_query`) va vasiyning telefon bog‘lash so‘rovi Markaziy Serverning autentifikatsiyalangan **Backend Command API** siga yuboriladi (`03_ARCHITECTURE.md`, `T14.02`).
  - **B:** Tasdiqlashni faqat Veb/Staff Ilovada qoldirib, Botdagi tugmani Veb-ilovaga ssilka (deep-link) qilish.
- **Tavsiya va sabab:** **A** — Ham PDF 5-sahifadagi Rahbar qulayligini, ham PDF 6-sahifadagi "yagona haqiqat manbai — Markaziy Server" xavfsizlik qoidasini birdek bajaradi.
- **Status:** `PROPOSED`
- **Decision Owner:** `Tech Lead` / `Product Owner (User)`
- **Affected Steps:** `01.01`, `01.02`, `02.03`, `09.02`, `14.02`, `15.04`
- **Due Before:** `02.03` (`Stage 02` / `Stage 14`)
- **Evidence:** `NONE_YET`

<a id="D07"></a>
### `D07` — Davomat Dublikat Kaliti (`group_id + student_id + date` vs `lesson_id + student_id`)
- **Muammo:** PDF 6-sahifada oflayn davomat `group_id + student_id + date` kaliti bilan yozilishi aytilgan, ammo bitta guruhda bir kunda 2 marta dars (yoki ko‘chirilgan qo‘shimcha dars) bo‘lsa, `date` kaliti to‘qnashadi.
- **Manba (`Source`):** `PDF p.6 Sec 5 (Komponent 3)`; `planning/02_DECISIONS.md#D07`; `docs/spec/business-rules.md#br-11`.
- **Alternativalar:**
  - **A:** Har bir darsni alohida `LessonOccurrence (lesson_id)` sifatida modellashtirish va davomatni **`(lesson_id, student_id)`** + `client_operation_uuid` kaliti bilan dedup qilish (`T02.02`, `T07.02`, `T12.02`).
  - **B:** `group_id + student_id + date` kalitini qoldirib, bir kunda 2 ta dars o‘tishni taqiqlash.
- **Tavsiya va sabab:** **A** — Intensiv kurslar va ko‘chirilgan darslarda bir kunda 2 ta dars bo‘lishi tabiiy holat (`T07.05`).
- **Status:** `PROPOSED`
- **Decision Owner:** `Tech Lead`
- **Affected Steps:** `02.02`, `04.01`, `04.02`, `07.02`, `12.02`, `17.03`, `23.02`
- **Due Before:** `02.02` (`Stage 02`)
- **Evidence:** `NONE_YET`

<a id="D08"></a>
### `D08` — Immutable Ledger va "100% Firibgarlikdan Himoya" Chegarasi
- **Muammo:** PDF 5-sahifada *"Bazaga kiritilgan to‘lovni Admin ham, hech kim ham o‘chira olmaydi"* va *"100% himoya"* deyilgan; texnik jihatdan esa server root / DB superuser huquqiga ega odam bazani o‘zgartirishi mumkin.
- **Manba (`Source`):** `PDF p.5 Sec 4.5`; `planning/02_DECISIONS.md#D08`; `05_DOMAIN_RULES.md`.
- **Alternativalar:**
  - **A:** Ilova ishlatadigan runtime DB rolidan `ledger_entries` va `payments` uchun `UPDATE`/`DELETE` huquqini olib tashlash (`T04.02`), barcha o‘zgarishlarni append-only reversal va qizil Telegram alert + offsite audit log bilan himoyalash; OS root/DB superuser tahdidiga qarshi mutlaq 100% kafolat da’vo qilmaslik.
  - **B:** Tashqi WORM storage / kriptografik zanjir qo‘shish.
- **Tavsiya va sabab:** **A** — Ilova darajasida Admin/Kassir tomonidan to‘lovni o‘chirib yuborish xavfini texnik cheklov (DB runtime role `REVOKE UPDATE, DELETE` + append-only reversal + offsite audit + Rahbar qizil alert) bilan bartaraf etadi; shu bilan birga OS root / DB superuser huquqiga qarshi mutlaq 100% himoya da’vo qilinmaydi (`02_DECISIONS.md#D08`, `05_DOMAIN_RULES.md`).
- **Status:** `PROPOSED`
- **Decision Owner:** `Tech Lead` / `Security Reviewer`
- **Affected Steps:** `02.02`, `04.02`, `10.03`
- **Due Before:** `04.02` (`Stage 04`)
- **Evidence:** `NONE_YET`

<a id="D09"></a>
### `D09` — Telegram Xabar Tezligi ("1 Soniyada Xabar" va "25 Xabar/s")
- **Muammo:** PDF 3-sahifada *"1 soniya ichida... kelib tushadi"*, PDF 6-sahifada esa *"soniyasiga 25 ta xabar tezligida"* deyilgan; amalda yetkazib berish Telegram serverlari va bot rate-limitlariga (`429 Too Many Requests`) bog‘liq.
- **Manba (`Source`):** `PDF p.3 Sec 2.1`, `PDF p.6 Sec 5 (Komponent 4)`; `planning/02_DECISIONS.md#D09`.
- **Alternativalar:**
  - **A:** `25 msg/s` navbat limiterini va `1s` demo maqsadini pilot target sifatida olish; Telegram API `429 retry_after` javobini hurmat qilish va at-least-once outbox navbatini qo‘llash (`T13.01`, `T14.04`, `T22.03`).
  - **B:** Qattiq 1 soniyalik SLA kafolati berish.
- **Tavsiya va sabab:** **A** — Tashqi Telegram API ustidan 1 soniyalik qattiq SLA berib bo‘lmaydi (`03_ARCHITECTURE.md`).
- **Status:** `PROPOSED`
- **Decision Owner:** `Tech Lead` / `Product Owner (User)`
- **Affected Steps:** `02.04`, `13.01`, `14.03`, `14.04`, `22.03`
- **Due Before:** `02.04` / `13.01`
- **Evidence:** `NONE_YET`

<a id="D10"></a>
### `D10` — Baza Tiklash Vaqti ("1 Daqiqada Tiklash" vs `RPO ≤ 24 soat (24 h), RTO ≤ 60 daqiqa (60 min)`)
- **Muammo:** PDF 8-sahifa `5-Loop`da *"1 daqiqada istalgan kunni tiklab bera olasiz"* deyilgan; haqiqiy tiklash vaqti baza/fayl hajmiga va tungi arxiv davriyligiga bog‘liq (`F05`).
- **Manba (`Source`):** `PDF p.8 Sec 7 (5-Loop)`; `planning/02_DECISIONS.md#D10`; `docs/spec/business-rules.md#br-17`.
- **Alternativalar:**
  - **A (`PROPOSED`):** Tungi avto-arxiv uchun maqsadli ko‘rsatkich sifatida **`RPO ≤ 24 soat (24 h), RTO ≤ 60 daqiqa (60 min), PROPOSED`** belgilash va `S21.02` restore mashqida real vaqtni o‘lchash.
  - **B:** Har daqiqalik continuous WAL archiving o‘rnatib, RPO/RTO ni daqiqalarga tushirish (VPS va storage xarajatini oshiradi).
- **Tavsiya va sabab:** **A** — Tuman o‘quv markazlari uchun tungi backup (`RPO ≤ 24 soat (24 h)`) va 1 soat ichida toza muhitga tiklash (`RTO ≤ 60 daqiqa (60 min)`) tejamkor VPS arxitekturasiga to‘liq mos keladi.
- **Status:** `PROPOSED`
- **Decision Owner:** `Product Owner (User)` / `DevOps Lead`
- **Affected Steps:** `01.01`, `01.02`, `01.04`, `04.04`, `21.02`, `21.04`, `23.02`
- **Due Before:** `21.02` (`Stage 21`)
- **Evidence:** `NONE_YET`

<a id="D11"></a>
### `D11` — O‘qituvchi Oylik Maoshi (`Payroll`) va 1-Kunlik O‘rindosh (`Substitute`) Hisoblash Formulasi
- **Muammo:** PDF 3-, 7- va 8-sahifalarda o‘qituvchilarning oylik maoshi hisoblanishi hamda 1-kunlik o‘rindoshga o‘sha kunlik dars haqi yozilishi aytilgan, ammo maosh formulasi (fiks, darsbay, foiz) va chegirma/grant/refundning maoshga ta’siri berilmagan.
- **Manba (`Source`):** `PDF p.3 Sec 3`, `PDF p.7 Sec 6.2 (4-band)`, `PDF p.8 Sec 7 (4-Loop)`; `planning/02_DECISIONS.md#D11`; `docs/spec/business-rules.md#br-10`.
- **Alternativalar:**
  - **A (`Configurable 3-Mode Payroll`):** Guruh/o‘qituvchi uchun 3 ta rejimni (`FIXED_SALARY`, `PER_LESSON_RATE`, `REVENUE_PERCENTAGE`) qo‘llash; zamena darsi uchun dars ulushini (`per_lesson_rate` yoki `1 / total_lessons`) asosiy o‘qituvchidan ayirib o‘rindoshga yozish; foizli rejimda chegirma/grant/refund ta’sirini markaz sozlamasida (`NET_COLLECTED_CASH` vs `ACCRUED_NET_INVOICE` vs `BASE_TARIFF`) tanlash.
  - **B:** Faqat bitta qattiq maosh rejimini (masalan, faqat darsbay) qo‘llash.
- **Tavsiya va sabab:** **A** — O‘quv markazlarida o‘qituvchilar bilan shartnomalar turlicha bo‘ladi; tasdiqlanmaguncha `S18.02` yakuniy payroll yopilmaydi.
- **Status:** `DECISION_REQUIRED`
- **Decision Owner:** `Product Owner (User)` / `Markaz Rahbari`
- **Affected Steps:** `01.02`, `01.04`, `07.03`, `18.02`, `24.04`
- **Due Before:** `07.03` (data model snapshot) / `18.02` (payroll calculation)
- **Evidence:** `NONE_YET`

<a id="D12"></a>
### `D12` — Click / Payme / Perechisleniye: Qo‘lda Qayd Etish vs Real To‘lov Shlyuzi (`Payment Gateway`)
- **Muammo:** PDF 3- va 5-sahifalarda Admin naqd va karta (`Click/Payme/Perechisleniye`) to‘lovlarni qabul qilishi aytilgan; bu kassada to‘lov turini qo‘lda belgilashmi yoki avtomatik Click/Payme merchant webhook integratsiyasimi?
- **Manba (`Source`):** `PDF p.3 Sec 3 (Admin)`, `PDF p.5 Sec 4.5`; `planning/02_DECISIONS.md#D12`; `docs/spec/business-rules.md#br-05`, `#br-09`.
- **Alternativalar:**
  - **A (`Manual Payment Method Recording` — v2.0 bazasi):** Admin to‘lov kiritayotganda to‘lov usulini (`CASH`, `CARD`, `CLICK`, `PAYME`, `TRANSFER`) qo‘lda tanlaydi va tizim uni smena hisobotida naqd bo‘lmagan tushum sifatida alohida hisoblaydi.
  - **B (`Live Merchant Gateway`):** Har bir markaz uchun Click/Payme merchant API va webhook ulash.
- **Tavsiya va sabab:** **A** — Har bir o‘quv markazida merchant hisob bo‘lmasligi mumkin; v2.0 da qo‘lda qayd etish asosiy, jonli gateway esa alohida shartnoma (`DEFERRED`) sifatida qoladi.
- **Status:** `PROPOSED`
- **Decision Owner:** `Product Owner (User)`
- **Affected Steps:** `01.02`, `01.04`, `10.01`, `11.04`, `15.02`, `23.01`
- **Due Before:** `10.01` (`Stage 10`)
- **Evidence:** `NONE_YET`

<a id="D13"></a>
### `D13` — Elektron Kvitansiyaning Huquqiy va Fiskal Maqomi
- **Muammo:** PDF 3- va 4-sahifalarda ota-onaga *"rasmiy elektron kvitansiya"* borishi aytilgan; O‘zbekistonda rasmiy fiskal chek soliq organlari (OFD / fiskal modul) integratsiyasini talab qiladi.
- **Manba (`Source`):** `PDF p.3 Sec 2.1`, `PDF p.4 Sec 3 (Rol 4)`; `planning/02_DECISIONS.md#D13`; `T10.04`.
- **Alternativalar:**
  - **A (`Internal Electronic Receipt`):** Noyob kvitansiya raqami, markaz nomi, o‘quvchi, summa, to‘lov usuli, sana va qoldiq balans ko‘rsatilgan **markazning ichki elektron tasdiq kvitansiyasi**; fiskal soliq cheki deb da’vo qilinmaydi (`T10.04`).
  - **B:** OFD / Soliq fiskal QR integratsiyasini v2.0 ga qo‘shish.
- **Tavsiya va sabab:** **A** — `T10.04` qabul ssenariysida `fiscal chek deb belgilanmaydi` invarianti belgilangan.
- **Status:** `PROPOSED`
- **Decision Owner:** `Product Owner (User)`
- **Affected Steps:** `01.02`, `01.04`, `10.04`, `14.03`, `15.02`, `23.01`
- **Due Before:** `10.04` (`Stage 10`)
- **Evidence:** `NONE_YET`

<a id="D14"></a>
### `D14` — Freeze Kredit Sanasi/Ulushi, Yaxlitlash (`Rounding`), Chegirma Qo‘shilishi (`Stacking`) va Trial `No-Show` Muddati
- **Muammo:** PDF 4–5-sahifalarda pro-rata, trial follow-up, oilaviy + 50% chegirma va freeze keyingi oyga o‘tishi aytilgan, lekin kasr yaxlitlash birligi, ikki chegirma ustma-ust tushishi, trial no-show necha kunda/darsda trigger bo‘lishi va freeze krediti darsgami yoki kungami proporsional ekani ochiq.
- **Manba (`Source`):** `PDF p.4–5 Sec 4.1–4.3, 4.6`; `planning/02_DECISIONS.md#D14`; `docs/spec/business-rules.md#br-01`, `#br-03`, `#br-04`, `#br-08`.
- **Alternativalar:**
  - **1) Rounding:** `A1`: `1 so‘m HALF_UP`; `B1`: `1 000 so‘m` yaxlitlash.
  - **2) Discount Stacking:** `A2`: `HIGHEST_ONLY` (bitta eng katta chegirma); `B2`: `FIXED_THEN_PERCENT`; `C2`: `PERCENT_THEN_FIXED` (`CASE-09`).
  - **3) Trial No-Show Follow-Up:** `A3`: 2-rejalashtirilgan darsda `ABSENT` bo‘lishi bilan; `B3`: 1-sinov darsidan `48 soat` o‘tgach keyingi darsda qatnashuv bo‘lmasa.
  - **4) Freeze Credit:** `A4`: `LESSON_PROPORTIONAL` (`frozen_lessons / total_lessons * monthly_fee`); `B4`: `CALENDAR_DAY_PROPORTIONAL` (`CASE-15`).
- **Tavsiya va sabab:** **`A1 + A2 + A3 + A4`** — Barcha hisoblarni "rejalashtirilgan darslar ulushi (`lesson-based`)" va "bitta eng katta chegirma" tamoyiliga keltiradi, kassada tiyin/minglik kelishmovchiligi chiqmaydi.
- **Status:** `DECISION_REQUIRED`
- **Decision Owner:** `Product Owner (User)` / `Markaz Rahbari`
- **Affected Steps:** `01.02`, `01.04`, `08.01`, `08.03`, `08.04`, `09.01`, `09.02`, `09.03`, `09.04`, `12.04`, `13.04`, `23.01`
- **Due Before:** `08.01` (`Stage 08`) / `09.01` (`Stage 09`)
- **Evidence:** `PARTIAL_ACCEPTED via OWNER-20261104-03 #2 (non-negative UZS scale=0 rational integer HALF_UP rounding confirmed; discount stacking, freeze credit basis, and trial no-show follow-up remain DECISION_REQUIRED for Stage 09/12)`

<a id="D15"></a>
### `D15` — Staff Mobil Ilova Texnologiyasi (`Flutter + SQLite` vs `PWA`)
- **Muammo:** PDF 6-sahifada oflayn davomat telefon xotirasiga (`SQLite`) tushishi aytilgan, PDF 7-sahifada esa *"Flutter (yoki PWA) mobil ilovasi"* deyilgan.
- **Manba (`Source`):** `PDF p.6 Sec 5 (Komponent 3)`, `PDF p.7 Sec 6.1 (4-Qadam)`; `planning/02_DECISIONS.md#D15`.
- **Alternativalar:**
  - **A (`Flutter Native App + SQLite`):** O‘qituvchi va Rahbar uchun Flutter ilovasi (lokal SQLite va ishonchli oflayn queue bilan — `S03.01`, `S17`).
  - **B (`PWA + IndexedDB`):** Brauzer asosidagi PWA.
- **Tavsiya va sabab:** **A (`Flutter + SQLite`)** — PDF 6-sahifadagi aniq `SQLite` talabi va tuman sharoitida past internetda brauzer keshining o‘chib ketmasligi uchun Flutter ustuvor (`03_ARCHITECTURE.md`, `T17.01`–`T17.04`).
- **Status:** `PROPOSED`
- **Decision Owner:** `Product Owner (User)` / `Tech Lead`
- **Affected Steps:** `03.01`, `17.01`–`17.04`
- **Due Before:** `03.01` (toolchain pin) / `17.01` (`Stage 17`)
- **Evidence:** `NONE_YET`

<a id="D16"></a>
### `D16` — Tungi Baza Arxivini Shaxsiy Telegram Kanalga Yuborish (`.sql.gz` va `.xlsx`)
- **Muammo:** PDF 8-sahifa `5-Loop`da baza har kecha Cloud’ga va shaxsiy yopiq Telegram kanalga (`.sql.gz` va `.xlsx` sifatida) tashlanishi aytilgan; Telegram Bot API’da fayl hajmi limiti (50 MB) va uchinchi tomon bulutida shaxsiy ma’lumotlar (PII) xavfsizligi masalasi bor.
- **Manba (`Source`):** `PDF p.8 Sec 7 (5-Loop)`; `planning/02_DECISIONS.md#D16`; `docs/spec/business-rules.md#br-17`.
- **Alternativalar:**
  - **A (`Offsite Encrypted Cloud Primary + Optional Encrypted Telegram`):** Asosiy zaxira — shifrlangan offsite cloud storage (`S21.01`); Telegram kanalga yuborish opsiyasi faqat Kuchli shifrlash (kalit Telegramda saqlanmasligi), fayl hajmi limiti va mijoz roziligi tasdiqlansa yoqiladi (`T21.04`).
  - **B:** Shifrlanmagan `.xlsx` va `.sql.gz` fayllarni to‘g‘ridan-to‘g‘ri Telegramga yuborish (xavfsizlikka zid).
- **Tavsiya va sabab:** **A** — `07_SECURITY_AND_RELEASE.md` va `T21.01`/`T21.04` talablariga muvofiq kalit va dump alohida saqlanishi shart.
- **Status:** `DECISION_REQUIRED`
- **Decision Owner:** `Product Owner (User)` / `Security Reviewer`
- **Affected Steps:** `01.02`, `01.04`, `21.01`, `21.04`
- **Due Before:** `21.01` / `21.04` (`Stage 21`)
- **Evidence:** `NONE_YET`

<a id="D17"></a>
### `D17` — Litsenziya Uzilishi, `Signed Cached License`, `Grace Period` va Read-Only Rejimdagi Navbat Siyosati
- **Muammo:** Vendor serveri vaqtincha uzilganda markaz to‘xtab qolmasligi hamda `READ_ONLY` rejim yoqilganda navbatda turgan (pending) xabarlar va oflayn davomat taqdiri.
- **Manba (`Source`):** `PDF p.3 Sec 2.2`; `planning/02_DECISIONS.md#D17`; `docs/spec/business-rules.md#br-15`.
- **Alternativalar:**
  - **A:** Markazda kriptografik imzolangan litsenziya keshi (`signed cached license`) va kelishilgan `grace period` (masalan, `72 soat`) bo‘ladi; `READ_ONLY` rejimda login/read/export/backup ochiq, yangi yozishlar bloklanadi; `READ_ONLY`ga o‘tishdan oldin commit bo‘lgan xabarlar ketadi, yangi oflayn davomat esa litsenziya uzaytirilgach qayta tekshirilib (`revalidation`) qabul qilinadi (`T19.02`–`T19.04`).
  - **B:** Vendor ping uzilishi bilan darhol markazni bloklash.
- **Tavsiya va sabab:** **A** — Tarmoq uzilishida to‘lov qilgan mijoz markazining ishi to‘xtab qolmasligini ta’minlaydi (`T19.04`).
- **Status:** `DECISION_REQUIRED`
- **Decision Owner:** `Product Owner (User)` / `Tech Lead`
- **Affected Steps:** `01.02`, `01.04`, `17.03`, `19.02`, `19.03`, `19.04`
- **Due Before:** `19.02` (`Stage 19`)
- **Evidence:** `NONE_YET`

<a id="D18"></a>
### `D18` — Ota-ona Telefon Raqami O‘zgarishi va Eski Telegram Chat Huquqini Bekor Qilish (`Unlink / Revoke`)
- **Muammo:** PDF 8-sahifa `2-Loop`da ota-ona telefon raqami o‘zgarishi tilga olingan; eski raqam yoki eski Telegram chatda begona shaxs farzand ma’lumotlarini ko‘rishda davom etmasligi kerak (`B16`).
- **Manba (`Source`):** `PDF p.4 Sec 3 (Rol 4)`, `PDF p.8 Sec 7 (2-Loop)`; `planning/02_DECISIONS.md#D18`; `docs/spec/business-rules.md#br-13`.
- **Alternativalar:**
  - **A:** Telefon raqami o‘zgarganda Admin tekshiruvi bilan vasiy aloqasi yangilanadi, eski `GuardianTelegramLink` darhol `REVOKED` qilinadi, yangi bir martalik invite beriladi va har bir bot query/callback va navbatdagi xabar yuborishdan oldin `link.status == ACTIVE` ekani qayta tekshiriladi (`05_DOMAIN_RULES.md`, `T06.02`, `T14.01`, `T14.02`).
  - **B:** Eski chatni o‘chirmasdan yangi chatni qo‘shish.
- **Tavsiya va sabab:** **A** — Shaxsiy ma’lumotlar sizib chiqishini (`Guardian impersonation`) to‘liq yopadi (`07_SECURITY_AND_RELEASE.md`).
- **Status:** `PROPOSED`
- **Decision Owner:** `Tech Lead` / `Security Reviewer`
- **Affected Steps:** `01.01`, `01.02`, `06.02`, `14.01`, `14.02`, `14.04`, `23.03`
- **Due Before:** `06.02` (`Stage 06`) / `14.01` (`Stage 14`)
- **Evidence:** `NONE_YET`

<a id="D19"></a>
### `D19` — Ma’lumotlarni Saqlash Muddati (`Retention`), Guardian Unlink va Moliyaviy Arxiv Siyosati
- **Muammo:** Talaba markazdan ketganda, vasiy unlink qilinganda yoki yillar o‘tganda moliyaviy jurnal (`Ledger`), audit va shaxsiy ma’lumotlar qancha vaqt saqlanishi hamda `DELETE` so‘rovi moliya tarixini buzmasligi (`05_DOMAIN_RULES.md`).
- **Manba (`Source`):** `planning/02_DECISIONS.md#D19`, `05_DOMAIN_RULES.md`, `07_SECURITY_AND_RELEASE.md`.
- **Alternativalar:**
  - **A:** Student/Guardian o‘chirilmaydi, balki `ARCHIVED` / `UNLINKED` qilinadi (`T04.01`: *"student archive ledgerni cascade delete qilmaydi; guardian unlink qarzni o‘chirmaydi"*); moliya va audit yozuvlari kamida `3–5 yil` (yoki shartnoma muddati davomida) o‘zgarmas saqlanadi; tungi backup retention (masalan, kunlik `30 kun`, oylik `12 oy`) belgilanadi.
  - **B:** Ketgan talabalarni bazadan fizik (`CASCADE DELETE`) o‘chirish (moliyaviy balansni buzadi — taqiqlangan).
- **Tavsiya va sabab:** **A** — `T04.01` va `T06.01` invariantlariga ko‘ra moliyaviy tarix hech qachon cascade delete qilinmasligi shart.
- **Status:** `DECISION_REQUIRED`
- **Decision Owner:** `Product Owner (User)` / `Tech Lead`
- **Affected Steps:** `02.02`, `04.01`, `04.04`, `06.01`, `06.02`, `14.01`, `21.01`, `23.03`
- **Due Before:** `04.01` (cascade delete taqiqi — invariant) / `21.01` (backup retention muddati)
- **Evidence:** `NONE_YET`

<a id="D20"></a>
### `D20` — Yuklama Hajmi (`Capacity Target`) va `p95 Latency` Maqsadli Ko‘rsatkichlari
- **Muammo:** `07_SECURITY_AND_RELEASE.md` ga ko‘ra `S01` da bir markaz uchun mo‘ljallangan talaba soni, parallel xodimlar, Excel import qator limiti, bot navbat hajmi va API `p95` javob vaqti yozilishi hamda `S23.04` da o‘lchanishi kerak.
- **Manba (`Source`):** `planning/02_DECISIONS.md#D20`, `07_SECURITY_AND_RELEASE.md`.
- **Alternativalar:**
  - **A (`PROPOSED Baseline Capacity`):** Bitta o‘quv markazi uchun: `<= 1,000` faol o‘quvchi (`Demo = 240`), `<= 30` parallel faol xodim (`Staff`), Excel import bir faylda `<= 1,000` qator (`<= 5 MB`), Bot navbati `<= 25 msg/s`, asosiy read/write API `p95 <= 500 ms` (VPS lokal tarmoqda), Excel dry-run `p95 <= 5 s`.
  - **B:** Yirik tarmoq markazlari uchun `10,000+` o‘quvchi va dedicated server ko‘rsatkichlari.
- **Tavsiya va sabab:** **A** — Tuman/viloyat o‘quv markazlari (`200–800` o‘quvchi) va tejamkor VPS Docker Compose arxitekturasiga (`PDF p.1–2`) aynan mos.
- **Status:** `PROPOSED`
- **Decision Owner:** `Tech Lead` / `Product Owner (User)`
- **Affected Steps:** `01.04`, `02.01`, `16.02`, `16.04`, `23.04`
- **Due Before:** `16.02` (import limits) / `23.04` (benchmark gate)
- **Evidence:** `NONE_YET`

<a id="D21"></a>
### `D21` — `31-Sana`dagi Renewal, 12-Dars Paket Sarfi va Bekor Qilingan Dars (`Cancelled Lesson`) Siyosati
- **Muammo:** Rolling oyda `31-yanvar`da yozilgan o‘quvchining fevral/mart hisob sanasi hamda 12-darslik paketda markaz bekor qilgan dars balansdan yechilish-yechilmasligi (`BR-02`, `CASE-03`, `CASE-04`).
- **Manba (`Source`):** `PDF p.4 Sec 4.1`; `planning/02_DECISIONS.md#D21`; `docs/spec/business-rules.md#br-02`.
- **Alternativalar:**
  - **A (`Anchor Restore + Preserve Balance`):** 31-yanvar -> 28/29-fevral -> 31-mart (`billing_anchor_day = 31` saqlanadi); markaz bekor qilgan dars (`CANCELLED`) 12-dars balansidan yechilmaydi (`remaining_lessons` o‘zgarmaydi).
  - **B (`Drift Date + Credit Note`):** Fevraldan keyin sanalar 28/29 bo‘lib qoladi; bekor qilingan dars keyingi invoicega `CreditNote` beradi.
- **Tavsiya va sabab:** **A** — Ota-ona va Admin uchun eng adolatli hamda kutilgan xatti-harakat.
- **Status:** `DECISION_REQUIRED`
- **Decision Owner:** `Product Owner (User)` / `Markaz Rahbari`
- **Affected Steps:** `01.02`, `01.04`, `07.02`, `08.02`, `08.04`
- **Due Before:** `08.02` (`Stage 08`)
- **Evidence:** `PARTIAL_ACCEPTED via OWNER-20261104-03 #3 (rolling-month short-month renewal clamp continues from clamped day Jan31->Feb28/29->Mar28/29 without restoring 31 anchor; 12-lesson package cancelled-lesson CreditNote adjustment remains DECISION_REQUIRED fail-closed)`

<a id="D22"></a>
### `D22` — Refund Qarzni Qayta Ochishi va `Invoice` / `CreditNote` / `Cash Refund` Tartibi
- **Muammo:** Xato to‘lov qaytarilganda (`Storno`) va markazdan ketayotgan o‘quvchiga pul qaytarilganda (`Cash Refund`) invoice qarzi qanday o‘zgarishi (`BR-07`, `CASE-13`, `CASE-14`).
- **Manba (`Source`):** `PDF p.5 Sec 4.5`; `planning/02_DECISIONS.md#D22`, `05_DOMAIN_RULES.md`; `docs/spec/business-rules.md#br-07`.
- **Alternativalar:**
  - **A (`Reason-Based Dual Policy` — tavsiya):**
    1. `ERROR_REVERSAL` (Admin xato to‘lov kiritgan va o‘quvchi o‘qishda davom etmoqda): Allocation bekor qilinib, invoice qarzi qayta ochiladi (va to‘g‘ri to‘lov yoziladi);
    2. `WITHDRAWAL_OR_OVERPAYMENT_REFUND` (O‘quvchi ketayotgani uchun qolgan darslar puli yoki ortiqcha to‘lov qaytarilmoqda): Avval o‘qilmagan darslar uchun `CreditNote` bilan invoice net charge kamaytiriladi, so‘ng ortiqcha to‘langan qism `Cash Refund` qilinadi (natijada invoice qarzi `0` bo‘lib yopiladi).
  - **B:** Har qanday refundda qarzni qayta ochish.
- **Tavsiya va sabab:** **A** — `05_DOMAIN_RULES.md` dagi *"CreditNote (freeze/discount adjustment) va cash Refund bir narsa emas"* tamoyiliga to‘liq mos.
- **Status:** `DECISION_REQUIRED`
- **Decision Owner:** `Product Owner (User)` / `Markaz Rahbari`
- **Affected Steps:** `01.02`, `01.04`, `10.02`, `10.03`, `11.04`, `23.01`
- **Due Before:** `10.02` / `10.03` (`Stage 10`)
- **Evidence:** `NONE_YET`

<a id="D23"></a>
### `D23` — Vendor Panel Autentifikatsiyasi (`MFA`) va `Read-Only` Tizim Yozuvlari Ruxsat Ro‘yxati (`System-Write Allowlist`)
- **Muammo:** Markaziy Vendor Panel (`apps/vendor`) barcha markazlar litsenziyasini (`Kill-Switch`) boshqaradi; u buzilsa barcha markazlar bloklanishi mumkin (`B12`, `B13`).
- **Manba (`Source`):** `PDF p.3 Sec 2.2`; `planning/02_DECISIONS.md#D23`, `07_SECURITY_AND_RELEASE.md`; `docs/spec/business-rules.md#br-15`.
- **Alternativalar:**
  - **A:** Vendor auth markaz xodimlari authidan butunlay alohida bo‘lishi, TOTP MFA majburiyligi, litsenziya tokenlari assimetrik kalit (`Ed25519` / `RSA`) bilan imzolanishi (private key markaz konteyneriga berilmaydi — `T19.02`) va `READ_ONLY` rejimda faqat `auth login/logout, audit log, backup metadata, license refresh, health/telemetry ack` tizim yozuvlariga ruxsat berilishi (`T19.01`–`T19.03`).
  - **B:** Oddiy parol va symmetric secret.
- **Tavsiya va sabab:** **A** — `T19.01`–`T19.03` xavfsizlik mezonlarini to‘liq bajaradi.
- **Status:** `PROPOSED`
- **Decision Owner:** `Product Owner (User)` / `Security Reviewer`
- **Affected Steps:** `01.04`, `19.01`, `19.02`, `19.03`, `23.03`
- **Due Before:** `19.01` (`Stage 19`)
- **Evidence:** `NONE_YET`

<a id="D24"></a>
### `D24` — Mobil Ilova Platformasi (Android / iOS) va Tarqatish Usuli (`Store` vs `Enterprise APK`)
- **Muammo:** O‘qituvchi va Rahbar mobil ilovasi qaysi OS’larda (faqat Androidmi yoki iOS hammi) va qanday tarqatiladi (Google Play / App Store vs markaz ichida imzolangan APK) hamda developer akkauntlar egasi kim?
- **Manba (`Source`):** `PDF p.6–7 Sec 5–6`; `planning/02_DECISIONS.md#D24`.
- **Alternativalar:**
  - **A:** Pilotda Android (`.apk` / Google Play Internal Track) + iOS qurilmalar uchun Mobil Veb (`PDF p.4`: *"Mobil Ilova (Staff App) yoki Mobil Veb"*); keyinchalik rasmiy Store relizi.
  - **B:** Bir vaqtda ham Google Play, ham Apple App Store rasmiy relizi.
- **Tavsiya va sabab:** **A** — PDF 4-sahifada O‘qituvchi uchun *"Mobil Ilova yoki Mobil Veb"* allaqachon ko‘zda tutilgan; pilotni Apple Store review kechikishisiz tez boshlash imkonini beradi.
- **Status:** `DECISION_REQUIRED`
- **Decision Owner:** `Product Owner (User)`
- **Affected Steps:** `01.04`, `17.01`, `17.04`
- **Due Before:** `17.01` (`Stage 17`)
- **Evidence:** `NONE_YET`

<a id="D25"></a>
### `D25` — 45 Soniyalik Ichki Video-Qo‘llanmalarni (`Micro-Guides`) Yozib Beruvchi Mas’ul va Hosting
- **Muammo:** PDF 8-sahifa `3-Loop`da har bir asosiy sahifa tepasida `? Video qo'llanma (45 sek)` bo‘lishi aytilgan; dastur kodi video pleer va help registry’ni qursa ham (`S22.04`), haqiqiy ovozli/ekran yozuvli videolarni kim yozib beradi va ular qayerda saqlanadi (`B20`)?
- **Manba (`Source`):** `PDF p.8 Sec 7 (3-Loop)`; `planning/02_DECISIONS.md#D25`, `06_INTEGRATION_GATES.md`.
- **Alternativalar:**
  - **A:** `S22.04` da video ssenariylari, UI help registry va pleer + matnli fallback quriladi; haqiqiy video fayllar Product Owner / Vendor tomonidan `S15` UI tayyor bo‘lgach ekran yozuvi sifatida tayyorlanib, lokal static/CDN ga joylanadi (ungacha status `CONTENT_PENDING` bo‘lib turadi, soxta tayyor video deb da’vo qilinmaydi — `T22.04`).
  - **B:** Sintetik animatsiya generatsiya qilish.
- **Tavsiya va sabab:** **A** — `06_INTEGRATION_GATES.md` va `T22.04` talabiga aynan mos.
- **Status:** `DEFERRED` (UI tayyor bo‘lgunga qadar `CONTENT_PENDING` — `S22.04`)
- **Decision Owner:** `Product Owner (User)` / `Vendor`
- **Affected Steps:** `01.04`, `15.01`, `22.04`, `24.02`
- **Due Before:** `22.04` (`Stage 22`)
- **Evidence:** `NONE_YET`

---

<a id="open-rbac-channel-registry"></a>
## 4. `F01` Bo‘yicha Qo‘shimcha Granular RBAC va Kanal Transporti Savollari (`OPEN_RBAC` & `OPEN_CHANNEL`)

`S01-FULL-C.md` (82-satr) ko‘rsatmasiga binoan, `D01`–`D25` raqamlarini o‘zgartirmasdan, `F01` topilmasidagi granular rol va kanal savollari alohida bog‘langan reestrda qayd etildi:

| Savol ID | Bog‘liq D-ID / Amal | Muammo va Manba Bo‘shlig‘i | Alternativalar (`A` vs `B`) | Tavsiya va `Due Before` | Status |
| :---: | :---: | :--- | :--- | :--- | :---: |
| <a id="OPEN_RBAC_01"></a>**`OPEN_RBAC_01`** | `A2` (`scope.md#act-a2`), `R05.02`, `R05.03`, `OWNER-20261104-01` | **Adminning xodimlar (`Staff`) hisobini yaratish va boshqarish chegarasi:** `OWNER-20261104-01` qarori bilan xodim yaratish (`create_staff`) tasdiqlandi: **Rahbar (`DIRECTOR`) barcha staff rollarini (`DIRECTOR`, `ADMIN`, `TEACHER`) yaratadi; Admin (`ADMIN`) faqat `TEACHER` rolini yaratadi; Teacher hech qanday staff yaratmaydi.** Adminning boshqa staff boshqaruv huquqlari (`listStaffUsers`, `updateStaffStatus`, `revokeStaffSessions`) tasdiqlanmaguncha yopiq (`403 POLICY_DECISION_NOT_CONFIRMED` / `FORBIDDEN_ROLE`) qoladi. | **Tasdiqlangan `create_staff` (`OWNER-20261104-01`):** `DIRECTOR` -> `DIRECTOR \| ADMIN \| TEACHER`; `ADMIN` -> faqat `TEACHER`; `TEACHER` -> `NONE`.<br>**Qolgan Admin staff amallari:** `listStaffUsers`, `updateStaffStatus`, `revokeStaffSessions` faqat `DIRECTOR` uchun ochiq (`ADMIN` uchun `DECISION_REQUIRED` fail-closed). | **Qaror (`OWNER-20261104-01`):** `ACCEPTED` (`create_staff` qismi, 2026-11-04); qolgan Admin staff boshqaruv huquqlari fail-closed.<br>**Owner:** `Product Owner` | `ACCEPTED (create_staff: OWNER-20261104-01) / DECISION_REQUIRED (non-create admin staff ops)` |
| <a id="OPEN_RBAC_02"></a>**`OPEN_RBAC_02`** | `G1` (`scope.md#act-g1`), `R15.04`, `R18.01`, `R18.04` | **Adminning moliyaviy va smena hisobotlarini ko‘rish ko‘lami:** PDF 3-sahifada kunlik/haftalik/oylik tushum, maosh va churn tahlili Rahbar vakolatida, smena yopish va qarzdorlar ro‘yxati Admin vakolatida yozilgan. Admin oldingi yopilgan smenalarni yoki oylik umumiy tushumni ko‘ra oladimi? | **A (`Operational Scope`):** Admin faqat joriy/o‘z kassa smenasini va qarzdorlar ro‘yxatini ko‘radi; markazning umumiy foydasi, oylik tushum prognozi va o‘qituvchi maoshlari faqat Rahbarda.<br>**B:** Admin barcha kassa smenalari tarixini ham o‘qiy oladi. | **Tavsiya:** `A` (`PDF p.3` rol taqsimotiga eng mos).<br>**Owner:** `Product Owner`<br>**Due Before:** `15.04` / `18.01` | `DECISION_REQUIRED` |
| <a id="OPEN_CHANNEL_01"></a>**`OPEN_CHANNEL_01`** | `D1` (`scope.md#act-d1`), `BR-12`, `R17`, `R13.03` | **Teacher 20-daqiqalik Ping transporti:** PDF 8-sahifa `1-Loop`da *"O‘qituvchining telefoniga ... bildirishnoma yuboradi"* deyilgan, ammo bu Staff Mobile App Push bildirishnomasimi yoki Telegram Bot xabarimi? | **A:** Staff Mobile App Push + In-App Banner (va ixtiyoriy Telegram bot xabari, agar o‘qituvchi botga ulangan bo‘lsa).<br>**B:** Faqat Telegram Bot orqali ping yuborish. | **Tavsiya:** `A` (Staff App + Telegram fallback).<br>**Owner:** `Tech Lead` / `Product Owner`<br>**Due Before:** `13.03` (`Stage 13`) | `DECISION_REQUIRED` |
| <a id="OPEN_CHANNEL_02"></a>**`OPEN_CHANNEL_02`** | `E2`, `D1` (`scope.md#act-e2`), `BR-05`, `BR-12`, `R09`, `R13.02` | **Adminga `09:00` va’da eslatmasi va kechikkan davomat escalation transporti:** PDF 5- va 8-sahifalarda *"Adminga eslatma / xabar chiqadi"* deyilgan; Admin buni Veb/Staff App bildirishnomasida oladimi yoki Telegram botdami? | **A:** Staff Web + Staff App "Kunlik vazifalar / Eslatmalar" oynasi + ixtiyoriy Admin Telegram bildirishnomasi.<br>**B:** Faqat Veb panel ichida. | **Tavsiya:** `A` (Veb/App task list + Telegram xabarnoma).<br>**Owner:** `Tech Lead` / `Product Owner`<br>**Due Before:** `13.02` / `13.03` | `DECISION_REQUIRED` |
| <a id="OPEN_PRIVACY_01"></a>**`OPEN_PRIVACY_01`** | `F04`, `C05` (`scope.md#sec-4-3-teacher-phone-privacy`), `R05.04`, `R15.03` | **Bir xil ismli o‘quvchilarni farqlashda Teacher ekranida telefon raqami siyosati:** Kanonik qoida bo‘yicha Teacher DTO/SQLite/eksportda telefon raqami umuman yo‘q (`T02.03`, `T15.03`). Agar markazda bir xil ism-familiyali 2 o‘quvchi bitta guruhga tushsa, ularni farqlash qanday bo‘ladi? | **A (`Strict Zero-Phone Baseline` — tavsiya):** Telefon raqami (hatto qirqilgan holda ham) Teacherga hech qachon uzatilmaydi; bir xil ismli o‘quvchilar `student_code` / tug‘ilgan sana / ota ismi (patronymic) orqali farqlanadi.<br>**B:** Serverda qirqilgan oxirgi 2 raqamni ko‘rsatish (raw phone hech qachon uzatilmaydi). | **Tavsiya:** `A` (`T02.03` va `T15.03` talabiga 100% mos).<br>**Owner:** `Product Owner` / `Security Reviewer`<br>**Due Before:** `05.04` / `15.03` | `PROPOSED` |

---

<a id="sec-5-grouped-questions-for-business-owner"></a>
## 5. Mavzular Bo‘yicha Guruhlangan Qarorlar Xaritasi va Kanonik Hisob (`Authoritative Status Summary` — `C05`)

- **Kanonik `D01`–`D25` (25 ta qaror) maqomlar sanog‘i (`MANAGER_CHECKS.json` va `verify_s01_s02.py` bilan 100% mos):**
  - **`ACCEPTED`:** `0` ta
  - **`PROPOSED`:** `15` ta (`D01`, `D02`, `D04`, `D05`, `D06`, `D07`, `D08`, `D09`, `D10`, `D12`, `D13`, `D15`, `D18`, `D20`, `D23`)
  - **`DECISION_REQUIRED`:** `9` ta (`D03`, `D11`, `D14`, `D16`, `D17`, `D19`, `D21`, `D22`, `D24`)
  - **`DEFERRED`:** `1` ta (`D25`)
- **Qo‘shimcha Granular RBAC / Kanal / Privacy savollari (`5` ta):** `OPEN_RBAC_01` (`ACCEPTED` for `create_staff` via `OWNER-20261104-01`; non-create Admin staff ops remain `DECISION_REQUIRED` fail-closed), `OPEN_RBAC_02` (`DECISION_REQUIRED`), `OPEN_CHANNEL_01` (`DECISION_REQUIRED`), `OPEN_CHANNEL_02` (`DECISION_REQUIRED`), `OPEN_PRIVACY_01` (`PROPOSED`).

1. **Moliya, Tarif va Hisob-Kitob Siyosati (`Stage 08–10` dan oldin):** `D03` (Tarif rejimlari), `D12` (Click/Payme manual vs gateway), `D13` (Ichki elektron kvitansiya), `D14` (Rounding, stacking, trial no-show, freeze credit), `D21` (31-sana renewal va 12-dars cancelled lesson), `D22` (Refund va qarzni qayta ochish).
2. **O‘qituvchi Maoshi va O‘rindosh (`Stage 07 / 18` dan oldin):** `D11` (Payroll fixed/per-lesson/percentage, grant/refund ta’siri va 1-kunlik zamena ulushi).
3. **Rollar, Vakolatlar va Xabarnoma Kanallari (`Stage 05 / 13–15` dan oldin):** `D06` (Bot Backend Command API), `D18` (Telefon o‘zgarganda unlink/revoke), `OPEN_RBAC_01` (Admin xodim yaratishi), `OPEN_RBAC_02` (Admin hisobot ko‘lami), `OPEN_CHANNEL_01` (Teacher ping kanali), `OPEN_CHANNEL_02` (Admin eslatma kanali).
4. **Texnik Arxitektura, Mobil Ilova va Litsenziya (`Stage 02–04 / 17 / 19` dan oldin):** `D07` (`lesson_id+student_id` kaliti), `D08` (Runtime DB immutable ledger), `D09` (25 msg/s va 429 retry), `D15` (Flutter + SQLite), `D17` (Signed cached license va grace), `D19` (Retention va archive), `D20` (Capacity va p95 target), `D23` (Vendor MFA va allowlist), `D24` (Mobile OS va distribution).
5. **Infratuzilma, Zaxira, Demo va Onboarding (`Stage 20–24` dan oldin):** `D01` (240 vs 250 demo), `D02` (5–10 daqiqa deploy), `D04` (4.1–4.6 edge cases), `D05` (Loop D-bosqich taklifi), `D10` (`RPO ≤ 24 soat (24 h), RTO ≤ 60 daqiqa (60 min), PROPOSED`), `D16` (Telegram backup opsiyasi), `D25` (45s video kontent egasi).

---

<a id="sec-upstream-corrections"></a>
## 6. Upstream Reja Fayllarida (`planning/*.csv`) Aniqlangan Meros Sahifa Tafovutlari (`Upstream Correction Log` — `F03`)

`S01-FULL-C.md` (21- va 85-satrlar) ko‘rsatmasiga binoan, global `planning/requirements.csv` va `planning/SOURCE_REQUIREMENTS.csv` fayllari bu topshiriqda tahrirlanmadi, ammo `docs/spec/scope-traceability.csv` va `docs/spec/acceptance.csv` da quyidagi haqiqiy PDF sahifalari qo‘llandi (keyinchalik menejer global registrni yangilaganda foydalanishi uchun):

| ID | Fayl | Eski qiymat (`Inherited`) | To‘g‘rilangan qiymat (`Corrected in S01 specs`) | Manba Dalili (`MASTER_SOURCE_TEXT.md`) |
| :---: | :--- | :---: | :---: | :--- |
| **`R22.04`** | `planning/requirements.csv` | `source_pages = 2–3,7` | **`source_page = 8`** (`PDF p.8 Sec 7, 3-Loop`) | 45 soniyalik ichki video-qo‘llanmalar (`? Video qo'llanma (45 sek)`) faqat PDF 8-sahifa, 7-bo‘lim `3-Loop` jadvalida mavjud. |
| **`R24.03`** | `planning/requirements.csv` | `kuzatuv->ustuvorlik->patch->regression->natijani o'lchash` (`pages=7–8`) | **`PDF Loop A–C` (p.7–8) + `D05 taklifi` (4-qadam)** | PDF 7–8-sahifalarda faqat `A-Bosqich`, `B-Bosqich`, `C-Bosqich` yozilgan; `regression -> natijani o'lchash` `D05` muhandislik taklifidir. |
| **`R24.04`** | `planning/requirements.csv` | `source_pages = 7–8` | **`source_page = 7`** (`PDF p.7 Sec 6.2, 4-band`) | 2–3 oylar yakuni, maosh/moliya hisoboti, Case Study va 4–5 markaz rollout PDF 7-sahifa `6.2-bo‘lim, 4-band`da joylashgan. |
| **`R03.01`–`R03.03`** | `planning/requirements.csv` | `source_pages = 7` | **`1,6–7` / `5,7` / `1,3,5,7`** | Docker Compose (`p.1`), markaz konteyneri (`p.3`), PostgreSQL (`p.5`) va Flutter/PWA (`p.6–7`) bir nechta sahifada berilgan. |
| **`R07.03`** | `planning/requirements.csv` | `source_pages = 3–4,8` | **`source_page = 8`** (`PDF p.8 Sec 7, 4-Loop`) | 1-kunlik "O‘rindosh O‘qituvchi" (`Substitute Teacher`) faqat PDF 8-sahifa `4-Loop`da berilgan. |
| **`R07.04`** | `planning/requirements.csv` | `source_pages = 3–4,8` | **`source_page = 4`** (`PDF p.4 Sec 3, Rol 3`) | O‘qituvchining imtihon ballari va qisqa izoh kiritishi PDF 4-sahifa `3-bo‘lim`da berilgan. |
| **`R01.02`** | `planning/requirements.csv` | `source_pages = 1–8` | **`source_page = 3–5,7–8`** | Biznes qoidalari va maosh/o‘rindosh mantiqi PDF 3-, 4–5- va 7–8-sahifalarda joylashgan. |
| **`R11` & `R12`** | `planning/SOURCE_REQUIREMENTS.csv` | `source_pages = 5` | **`source_page = 3,5`** | Rahbar va Adminning smena hamda churn vakolatlari PDF 3-sahifada ham, 5-sahifada ham berilgan. |
| **`R08` & `R09`** | `planning/SOURCE_REQUIREMENTS.csv` | `4–5` / `5` | **`3–5` / `3,5`** | Rahbarning 50%/grant tasdig‘i va Adminning qarzdorlar/va’da sanasi bilan ishlashi PDF 3-sahifa (`Sec 3`) va 4–5-sahifalarda berilgan (`C06`). |
| **`R05.01`–`R05.03`** | `planning/requirements.csv` | `source_pages = 3–4` | **`source_page = 1,3–4`** | 100% Staff-Only tamoyili PDF 1-sahifa (`Sec 1, band 1`) va 3–4-sahifalarda (`Sec 2.2, Sec 3`) berilgan (`C06`). |
| **`R08.01`–`03`, `R09.03`, `R10.02`, `R10.04`, `R11.02`–`03`** | `planning/requirements.csv` | `4–5` / `3,5` | **Aniq sahifa (`4` / `5` / `3–4`)** | Har bir step qamragan aniq PDF bo‘limi (`4.1` p.4, `4.2` p.4, `4.4` p.5, `4.5` p.5, `4.6` p.5) bilan `source_page` va `source_section` 100% tenglashtirildi (`C06`). |
