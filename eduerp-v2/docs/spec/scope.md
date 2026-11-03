# EduERP v2.0 — Mahsulot Ko‘lami, Foydalanuvchi Rollari va Kanal Chegaralari (`docs/spec/scope.md`)

- **Step ID:** `01.01` (`TASK_ID: ARGON-01.01-A`)
- **Test / Qabul ssenariysi:** `T01.01`
- **Asosiy manba:** `EduERP_v2_Master_Reja_va_Arxitektura.pdf` (8 sahifa, SHA256: `883859251660c1e8dd90a89f7f90011177fc97b7787023eb763889363963f3e4` — `planning/source/MASTER_SOURCE_TEXT.md`)
- **Bog‘liq reja hujjatlari:** `planning/SOURCE_REQUIREMENTS.csv` (`R01`–`R23`), `planning/requirements.csv` (`R01.01`–`R24.04`), `planning/02_DECISIONS.md` (`D01`–`D25`), `planning/03_ARCHITECTURE.md`, `planning/05_DOMAIN_RULES.md`, `planning/07_SECURITY_AND_RELEASE.md`
- **Hujjat maqomi:** `IN_REVIEW` (Step `01.01` doirasida faqat ko‘lam va chegara qoidalari; moliyaviy hisob-kitob formulalari `01.02`da, qabul mezonlari `01.03`da, ochiq qarorlar registri `01.04`da yopiladi).

---

## 1. Mahsulot Maqsadi va v2.0 Tarkibi

### 1.1. Biznes maqsadi va maqsadli bozor
EduERP v2.0 — tuman va viloyat o‘quv markazlari uchun mo‘ljallangan **B2B Turnkey (tayyor o‘rnatib beriladigan)** ichki boshqaruv platformasi va xizmat paketi (`PDF 1–2-sahifalar`, `R01`, `R02`). Loyihaning asosiy maqsadi:
1. O‘quv markazlarida o‘quvchilar hisobi, guruhlar va dars jadvali, 30 soniyalik davomat, murakkab to‘lov turlari (pro-rata, 12-dars abonement, sinov darsi, chegirma/grant, qisman to‘lov va va’da sanasi), o‘zgarmas kassa/jurnal (immutable ledger) hamda ota-onalar bilan Telegram xabarnomalarini yagona markaziy server (PostgreSQL) atrofida adashmasdan boshqarish (`PDF 1, 4–6-sahifalar`, `R05`–`R18`).
2. v1.0 konsepsiyasidagi 4 ta asosiy amaliy xatoni (ota-ona/o‘quvchi mobil ilovasi muammosi, umumiy aralash baza ishonchsizligi, og‘ir Kubernetes/CRDT xarajati, erkin Excel import tartibsizligi) bartaraf etib, **100% Staff-Only** (faqat xodimlar uchun) veb/mobil interfeys va **izolyatsiyalangan Docker Compose** arxitekturasiga o‘tish (`PDF 1–2-sahifalar`, `R01`, `R02`, `R14`).
3. B2B sotuv uchun tayyor jonli demo bazasi ("Namuna Akademiyasi"), 1-buyruqli auto-provisioning skripti va 1–3 oylik onboarding hamda 4-bosqichli sifat/kuzatuv sikli (Evolutionary Feedback Loop) bilan markazlarni tezkor ishga tushirish (`PDF 2–3, 6–8-sahifalar`, `R03`, `R22`, `R23`).

### 1.2. EduERP v2.0 tizim tarkibi (4-tomonlama markaz konturi + Vendor va infratuzilma)
Manba (`PDF 3, 5–7-sahifalar`) va rejalashtirish arxitekturasi (`planning/03_ARCHITECTURE.md`) bo‘yicha v2.0 quyidagi tarkibiy qismlardan iborat:

| Komponent | Manba asosi (`PDF` vs `Muhandislik taklifi`) | v2.0 dagi vazifasi va chegarasi | Bog‘liq R-ID va Stage |
| :--- | :--- | :--- | :--- |
| **1. Markaziy Server va PostgreSQL bazasi** | **PDF talabi:** PostgreSQL yagona haqiqat manbai, UUID va version (`PDF 5–7-sahifalar`).<br>**Muhandislik taklifi:** TypeScript NestJS API, Prisma ORM, DB Outbox worker (`03_ARCHITECTURE.md`). | Barcha hisob-kitoblar, balans, davomat, qarzlar, o‘zgarmas jurnal (immutable ledger) va audit loglar faqat serverda yakuniy tasdiqdan o‘tadi. Hech bir klient qurilma server ruxsatisiz balansni o‘zgartira olmaydi. | `R02`, `R10`, `R13`<br>(`S02`–`S13`) |
| **2. Xodimlar Veb Boshqaruv Paneli (Staff Web)** | **PDF talabi:** Rahbar va Admin uchun kompyuter/mobil veb-sayt (`PDF 1, 3–4, 7-sahifalar`).<br>**Muhandislik taklifi:** React TypeScript SPA (`apps/web`). | 15 soniyada ro‘yxatga olish, 1-bosishda to‘lov va va’da sanasi, smena yopish, guruh/jadval/o‘rindosh boshqaruvi, kassa/churn/maosh hisobotlari, chegirma/storno tasdiqlash, mikro-video yordamchi. | `R01`, `R05`–`R11`, `R15`, `R19`, `R20`<br>(`S15`, `S18`) |
| **3. Qulflangan Excel Shablon va Validator Engine** | **PDF talabi:** Locked Excel Template, 1-ustunda yashirin `student_id`, qizil/yashil Dry-Run Validator (`PDF 2, 5–7-sahifalar`).<br>**Muhandislik taklifi:** row version, SHA256 upload hash, preview token, zip-bomb/formula injection himoyasi (`S16`). | Kompyuterda ommaviy o‘quvchi ro‘yxatini kiritish, oylik davomat jadvalini ko‘rish/to‘ldirish va buxgalteriya eksporti. Ismga emas, `student_id` (UUID) ga qarab moslaydi; xatosiz bo‘lsagina qabul qiladi; o‘qituvchi ilovada kiritgan davomatni eski Excel buzib yubormaydi. | `R13`, `R14`, `R15`<br>(`S12`, `S16`) |
| **4. Xodimlar Mobil Ilovasi (Staff Mobile App & Offline)** | **PDF talabi:** Faqat Rahbar, Admin, O‘qituvchi uchun mobil ilova (Flutter yoki PWA), SQLite oflayn davomat (`PDF 1, 3–4, 6–7-sahifalar`).<br>**Muhandislik taklifi:** Flutter + local SQLite, client operation UUID, foreground/manual sync (`D15`, `D24`, `S17`). | O‘qituvchilar internet past sinfda 30 soniyada davomat olishi (SQLite’ga yozib, internet yonganda serverga sinxronlash), imtihon bali/izoh kiritishi; Rahbar telefonda real-vaqt tushum/hisobot ko‘rishi va tasdiqlashi; Admin asosiy tezkor amallari. | `R01`, `R05`, `R13`, `R15`<br>(`S12`, `S17`) |
| **5. Telegram Bot Konturi (Ota-ona & Rahbar & O‘qituvchi xabarlari)** | **PDF talabi:** Ota-ona/o‘quvchi uchun faqat Telegram Bot (ilovasiz); Rahbar Bot (ogohlantirish, tasdiq, kechki kassa); 25 xabar/s navbat (`PDF 1, 3–6, 8-sahifalar`).<br>**Muhandislik taklifi:** Bot bevosita DB yozmaydi, backend command API ga murojaat qiladi (`D06`, `S13`, `S14`). | Ota-ona telefon raqamini 1 marta tasdiqlaydi, kelmadi/kechikdi xabari, elektron kvitansiya, va’da eslatmasi (09:00), "Balans va Davomat" tugmasi. Rahbar uchun 50%/grant va storno tasdiqlash tugmalari, qizil xavfsizlik signali va kechki smena hisoboti. | `R01`, `R08`–`R10`, `R16`–`R18`<br>(`S13`, `S14`) |
| **6. Markaziy Vendor Panel va Litsenziya (Kill-Switch)** | **PDF talabi:** Vendor panelidan bitta tugma bilan markazni "Faqat o‘qish" (Read-Only) rejimiga o‘tkazish (`PDF 3-sahifa`).<br>**Muhandislik taklifi:** Alohida `apps/vendor`, MFA, signed cached license, grace period (`D17`, `D23`, `S19`). | B2B platforma egasi (Vendor) uchun markazlar reestrini va obuna litsenziyasini boshqarish. To‘lov kechiksa markaz ma’lumotlari o‘chmaydi, lekin yangi yozish amallari (to‘lov/davomat/import) bloklanib, faqat o‘qish/eksport/zaxira saqlanadi. | `R04`, `R19.01`–`R19.04`<br>(`S19`) |
| **7. Auto-Provisioning, Ikki Qatlamli Zaxira va Demo Zavod** | **PDF talabi:** Docker Compose, `deploy_center.sh`, SSL/domen/bot biriktirish, Cloud + shifrlangan Telegram `.sql.gz`/`.xlsx` backup, Demo markaz (`PDF 1–3, 7–8-sahifalar`). | Har bir markazni alohida konteyner/DB/bot bilan ko‘tarish, har kecha shifrlangan zaxira olish va toza muhitga tiklashni tekshirish, sotuv uchrashuvlari uchun "Namuna Akademiyasi" demo bazasi. | `R02`, `R03`, `R21`–`R23`<br>(`S20`–`S24`) |

---

## 2. Foydalanuvchi Rollari va Kanal–Amal–Ruxsat Matritsasi

EduERP v2.0 da **100% Staff-Only** tamoyili amal qiladi: Veb-sayt, Xodimlar mobil ilovasi va Excel shablon faqat markaz xodimlari (**Rahbar**, **Admin**, **O‘qituvchi**) uchundir (`PDF 1, 3–4-sahifalar`, `R01`). Har bir endpoint, eksport, worker buyrug‘i va bot callbackida server tomonidan bir xil rol va obyekt darajasidagi vakolat (RBAC + object ownership) tekshiriladi; frontendda tugmani yashirish xavfsizlik hisoblanmaydi (`03_ARCHITECTURE.md`, `R05.02`).

### 2.1. Kanal kirish huquqlari (Umumiy ko‘rinish)

| Foydalanuvchi roli | Kompyuter / Mobil Veb (`apps/web`) | Staff Mobil Ilova (`apps/mobile` — Offline SQLite) | Locked Excel Shablon (`.xlsx` Export/Import) | Telegram Bot (`apps/bot`) | Markaziy Vendor Panel (`apps/vendor`) |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **1. Markaz Rahbari (Direktor / Ega)** | **RUXSAT** (To‘liq moliya, tahlil, tasdiqlash va audit) | **RUXSAT** (Hisobotlar, kassa, qarz, tasdiqlash va alertlar) | **RUXSAT** (Moliyaviy/hisobot eksportlarini yuklab olish; `R18.04`) | **RUXSAT** (Rahbar Bot: kassa hisoboti, qizil alert, 50%/grant va storno tasdiqlash) | **TAQIQLANGAN** (Faqat o‘z markazi ichida ishlaydi) |
| **2. Boshqaruvchi Menejer (Admin / Kassir)** | **RUXSAT** (Asosiy ish quroli: qabul, to‘lov, smena, guruh, qarzdorlar) | **RUXSAT** (Asosiy tezkor operatsiyalar; `PDF 3-sahifa`, `R17.04`) | **RUXSAT** (Shablon yuklab olish, to‘ldirish, Dry-Run tekshirish va import) | **RUXSAT / BILDIRISHNOMA** (09:00 va’da eslatmasi, kechikkan davomat escalation, bot ulanmaganlar haqida alert) | **TAQIQLANGAN** |
| **3. O‘qituvchi (Teacher / O‘rindosh)** | **RUXSAT (Cheklangan Mobil Veb)** (Faqat o‘z guruhlari, davomat va ballar; `PDF 4-sahifa`) | **RUXSAT (Asosiy qurol)** (Faqat o‘z guruhlari, 30s oflayn/onlayn davomat, ball/izoh) | **TAQIQLANGAN** (Ommaviy eksport/import va talaba bazasini ko‘chirish yopiq) | **BILDIRISHNOMA** (Darsdan 20 daqiqa o‘tgach davomat kiritilmasa Avto-Turtki / Ping; `PDF 8-sahifa`) | **TAQIQLANGAN** |
| **4. Ota-ona va O‘quvchi (Parent / Student)** | **QAT’IY TAQIQLANGAN** (Web login yo‘q, v3.0 gacha) | **QAT’IY TAQIQLANGAN** (Mobil ilova yo‘q, v3.0 gacha) | **QAT’IY TAQIQLANGAN** | **FAQAT SHU KANAL** (Telefonni 1 marta tasdiqlash, avto-xabar, kvitansiya, balans va davomat) | **TAQIQLANGAN** |
| **5. Platforma Vendori (B2B Turnkey Egasi)** | **TAQIQLANGAN** (Mijoz markazining kundalik o‘quv/kassa xodimi emas) | **TAQIQLANGAN** | **TAQIQLANGAN** (Faqat onboarding 1–3-kun yoki tiklashda mijoz topshirig‘i bilan) | **SHAXSIY ARXIV KANALI** (Shifrlangan tungi zaxira `.sql.gz`/`.xlsx` — `D16` tasdiqlansa) | **FAQAT VENDOR** (Alohida auth/MFA, markazlar reestri, Read-Only Kill-Switch) |

### 2.2. Rahbar, Admin va Teacher uchun Kanal–Amal–Ruxsat Jadvali

Quyidagi jadval har bir biznes amali bo‘yicha **Rahbar (Direktor)**, **Admin (Menejer/Kassir)** va **O‘qituvchi (Teacher)** vakolatlarini, qaysi kanal orqali bajarilishini va manba talabini belgilaydi:

| № | Amal guruhi va aniq operatsiya | Kanal(lar) | Rahbar (Direktor) | Admin (Menejer / Kassir) | O‘qituvchi (Teacher) | Manba va R-ID |
| :-: | :--- | :--- | :--- | :--- | :--- | :--- |
| **A1** | **Tizimga kirish (Staff Login), parol almashtirish, sessiya boshqaruvi** | Veb, Staff Ilova | **RUXSAT** (O‘z profili + xodimlar boshqaruvi) | **RUXSAT** (O‘z profili, birinchi kirishda parol yangilash) | **RUXSAT** (Faqat o‘z profili va biriktirilgan guruhlar scope’i) | `PDF 3–4`<br>`R01`, `R05.01` |
| **A2** | **Xodim (Staff) yaratish, rol berish va deaktivatsiya qilish (o‘chirish o‘rniga)** | Veb | **RUXSAT (To‘liq)** (Admin va Teacher hisoblarini boshqarish) | **CHEKLANGAN / READ** (Rahbar/Admin huquqini o‘zgartira olmaydi; `R05.02`, `R05.03`) | **TAQIQLANGAN** | `PDF 3, 7`<br>`R05.02`, `R05.03` |
| **B1** | **Yangi o‘quvchini 15 soniyada ro‘yxatga olish, guruhga qo‘shish, ota-onani biriktirish** | Veb, Staff Ilova | **RUXSAT** (Ko‘rish va zaruratda boshqarish) | **ASOSIY IJRОCHI** (15s forma, sinov/faol status, vasiy telefoni, dublikat ogohlantiruvi) | **TAQIQLANGAN** | `PDF 3–4, 8`<br>`R05`, `R06.01`–`04`, `R15.01` |
| **B2** | **Ota-ona (Guardian) telefon raqami o‘zgarganda qayta bog‘lash va eski chatni bekor qilish** | Veb + Telegram Bot | **RUXSAT** (Auditda ko‘rish va nazorat) | **ASOSIY IJROCHI** (Admin tekshiruvi bilan yangi raqamni bog‘lash, eski chat linkini uzish; `D18`) | **TAQIQLANGAN** (Telefon raqamlarini ko‘ra/ko‘chira olmaydi) | `PDF 4, 8`<br>`R16`, `R18`, `D18` |
| **B3** | **O‘quvchi guruhdan chiqishida (Churn / Drop-out) 5 ta majburiy sababdan birini kiritish** | Veb, Staff Ilova | **RUXSAT** (Sabablar va o‘qituvchilar kesimida churn tahlilini ko‘rish) | **MAJBURIY IJROCHI** (Chiqarishda 5 sababdan birini tanlash shart: to‘lov, o‘qituvchi, vaqt, boshqa markaz, tugatdi/ko‘chdi) | **TAQIQLANGAN** | `PDF 3, 5`<br>`R12`, `R09.04`, `R18.03` |
| **C1** | **Kurslar, tariflar, guruhlar va dars jadvalini yaratish / tahrirlash** | Veb | **RUXSAT** (Tasdiqlash va ko‘rish) | **ASOSIY IJROCHI** (Guruh ochish, asosiy o‘qituvchi va jadval biriktirish) | **FAQAT O‘QISH (O‘z guruhlari)** (Faqat o‘ziga biriktirilgan guruh va dars jadvalini ko‘radi; `PDF 4`) | `PDF 3–4`<br>`R05`, `R07.01`–`02`, `R15.03` |
| **C2** | **1-kunlik "O‘rindosh O‘qituvchi" (Substitute Teacher / Zamena) biriktirish** | Veb, Staff Ilova | **RUXSAT** (Ko‘rish, maosh ta’sirini nazorat qilish) | **ASOSIY IJROCHI** (1 tugma bilan bugungi darsni o‘rindosh o‘qituvchiga vaqtincha biriktirish) | **VAQTINCHA KIRISH** (O‘rindosh o‘qituvchiga faqat o‘sha 1 kunlik dars davomati huquqi va haqi ochiladi) | `PDF 8`<br>`R20`, `R07.03`, `R15.03` |
| **D1** | **Dars boshlanganda 30 soniyada davomat belgilash (standart "Keldi", kelmagan/kechikkan ustiga bosish)** | Staff Ilova (Oflayn SQLite / Onlayn), Mobil Veb | **RUXSAT (Ko‘rish / Intizom tahlili)** (O‘qituvchilar davomat intizomini kuzatish) | **CHEKLANGAN OVERRIDE** (Eski Excel o‘qituvchi davomatini buzmaydi; Admin faqat sababli override qila oladi; `R12.03`) | **ASOSIY IJROCHI** (Faqat o‘z guruhi yoki 1-kunlik zamena darsi uchun; submit qilingach serverga yoziladi) | `PDF 4, 6, 8`<br>`R05`, `R12.01`–`04`, `R15`, `R17` |
| **D2** | **O‘quvchilarning imtihon ballari va qisqa izohlarini kiritish** | Staff Ilova, Mobil Veb, Veb | **RUXSAT (Ko‘rish)** | **RUXSAT (Ko‘rish)** | **ASOSIY IJROCHI** (Faqat o‘ziga biriktirilgan guruh o‘quvchilari uchun ball va izoh kiritish) | `PDF 4`<br>`R05`, `R07.04`, `R17.04` |
| **D3** | **Sinov darsi (Trial Lesson) 1- va 2-dars davomati hamda qaytib kelmaganlar bilan ishlash** | Staff Ilova, Veb | **RUXSAT (Konversiya va tushumda ko‘rish)** | **ASOSIY IJROCHI** (Trialga yozish; 1-darsdan keyin kelmasa qo‘ng‘iroq qilish follow-up vazifasini bajarish) | **DAVOMAT BELGILASH** (2-darsda o‘qituvchi "Keldi" deb submit qilganda tizim avto "Faol"ga o‘tkazib 1-darsdan to‘lov hisoblaydi) | `PDF 4`<br>`R07`, `R08.03`, `R12.04`, `R13.04` |
| **E1** | **To‘lov qabul qilish (Naqd, Plastik/Karta, Click, Payme, Perechisleniye) va elektron kvitansiya chiqarish** | Veb, Staff Ilova | **RUXSAT (Real-vaqtda tushumni ko‘rish)** | **ASOSIY IJROCHI** (1-bosishda to‘lov qayd etish; tizim kvitansiya yaratib ota-ona botiga yuboradi) | **QAT’IY TAQIQLANGAN** (Moliya va to‘lovlarga umuman kira olmaydi) | `PDF 3, 5`<br>`R10.01`, `R10.04`, `R15.02` |
| **E2** | **Qisman to‘lov (Bo‘lib to‘lash) va majburiy "Va’da sanasi" (Promise-to-Pay) belgilash** | Veb, Staff Ilova | **RUXSAT** (Umumiy qarz va kutilayotgan tushum prognozini ko‘rish) | **MAJBURIY IJROCHI** (Qarz qolsa va’da sanasini kiritish shart; qarzdorlarga qo‘ng‘iroq qilish; 09:00 da eslatma tushadi) | **QAT’IY TAQIQLANGAN** | `PDF 3, 5`<br>`R09`, `R11.03`, `R13.02`, `R15.02` |
| **E3** | **Chegirma (Oilaviy, 50% maxsus) va 100% Bepul (Grant) kiritish hamda tasdiqlash** | Veb, Staff Ilova, Rahbar Bot | **YAKUNIY TASDIQLOVCHI** (50% chegirma va 100% grant faqat Rahbar ilovada yoki Botda "Tasdiqlash" tugmasini bosgach kuchga kiradi!) | **SO‘ROV YUBORUVCHI** (Sababi va amal qilish muddatini kiritib so‘rov yuboradi; o‘zboshimchalik bilan kuchga kirita olmaydi) | **QAT’IY TAQIQLANGAN** | `PDF 3, 4–5`<br>`R08`, `R09.01`–`02`, `R14.02`, `R15.04` |
| **E4** | **Dars qoldirishni Muzlatish (Freeze — kasallik ma’lumotnomasi yoki oldindan ogohlantirish bilan)** | Veb | **RUXSAT (Ko‘rish va nazorat)** | **ASOSIY IJROCHI** (Sababli/hujjatli bo‘lganda Freeze rasmiylashtirish; sababsiz dars qoldirilsa qayta hisoblanmaydi) | **TAQIQLANGAN** (Faqat darsda davomat belgilaydi, moliyaviy freeze qila olmaydi) | `PDF 5`<br>`R12`, `R09.03` |
| **E5** | **To‘lovni o‘chirish (Delete) vs Xatoni to‘g‘irlash so‘rovi (Storno / Refund)** | Veb, Staff Ilova, Rahbar Bot | **TASDIQLOVCHI VA NAZORATCHI** (Har bir tuzatish so‘rovi va bekor qilingan to‘lov haqida darhol Telegramga qizil ogohlantirish oladi va tasdiqlaydi) | **FAQAT TUZATISH SO‘ROVI** (Bazaga kiritilgan to‘lovni hech kim o‘chira olmaydi! Admin faqat sababini yozib "Tuzatish so‘rovi" yuboradi) | **QAT’IY TAQIQLANGAN** | `PDF 3, 5`<br>`R10`, `R10.03`, `R14.03`, `R15.02`, `R15.04` |
| **E6** | **Kunlik xarajatlarni kiritish va Kechki kassa smenasini yopish (Cash Shift Close)** | Veb + Rahbar Bot | **QABUL QILUVCHI** (Kechqurun Naqd, Plastik/Click, Xarajat va Kassada qolishi kerak bo‘lgan qoldiq hisobotini oladi) | **MAJBURIY IJROCHI** (Xarajatlarni qayd etish va har kuni kechqurun "Smenani yopish" tugmasini bosib hisobot topshirish) | **QAT’IY TAQIQLANGAN** | `PDF 3, 5`<br>`R11`, `R11.01`–`02`, `R11.04` |
| **F1** | **Locked Excel shablonni yuklab olish, to‘ldirish, Dry-Run tekshirish va ommaviy import qilish** | Kompyuter Veb + Excel | **RUXSAT (Hisobot/eksport)** | **ASOSIY IJROCHI** (Yashirin `student_id` li shablonni yuklab olish, to‘ldirib yuklash, qizil/yashil jadvalda tekshirib tasdiqlash) | **QAT’IY TAQIQLANGAN** | `PDF 2, 3, 6–7`<br>`R14`, `R16.01`–`04` |
| **G1** | **Kunlik/haftalik/oylik tushum, qarzdorlar prognozi, o‘qituvchi maoshi va xavfsizlik auditi** | Veb, Staff Ilova, Rahbar Bot | **ASOSIY FOYDALANUVCHI** (Barcha moliyaviy dashboardlar, o‘qituvchi intizomi va hisoblangan maoshlar, churn va qizil audit log) | **CHEKLANGAN (Operatsion)** (Faqat o‘z kassa smenasi va qarzdorlar bilan ishlash ro‘yxati; markazning to‘liq foyda/strategik tahlili Rahbarda) | **QAT’IY TAQIQLANGAN** | `PDF 3, 5, 7`<br>`R01`, `R10`, `R18.01`–`04`, `R20` |
| **H1** | **Ichki 1-daqiqalik Video-Yordamchi (`? Video qo‘llanma (45 sek)`) ko‘rish** | Veb (va Staff UI) | **RUXSAT** | **ASOSIY FOYDALANUVCHI** (To‘lov olish, Excel yuklash, Guruh ochish sahifalarida) | **RUXSAT** | `PDF 8`<br>`R19`, `R22.04` |

---

## 3. Ota-ona va O‘quvchi (Parent / Student) Uchun Faqat Telegram Chegarasi

Manbaning 1-, 3-, 4- va 6-sahifalarida (`R01`, `R16`, `R18`) ota-onalar va o‘quvchilar bilan ishlash chegarasi qat’iy belgilangan:

1. **Veb va Mobil Ilova Qat’iy Scope Tashqarisida (`Staff-Only` qoidasi):**
   - Ota-onalar va o‘quvchilarga **hech qanday mobil ilova (iOS/Android/PWA) ham, veb-kabinet (web login/parol) ham berilmaydi** (`PDF 1-sahifa, 1-band`; `PDF 4-sahifa, 4-band`).
   - **Sababi (Root-Cause):** Amaliyotda tuman/viloyat sharoitida ota-onalar telefoniga qo‘shimcha ilova o‘rnatmaydi, login/parolni unutadi va bu markaz ma’muriyatiga ortiqcha yuk tug‘diradi. Shu bois o‘quvchi/ota-ona ilovasi uzoq kelajakdagi **v3.0** ga qoldirilgan (`PDF 1-sahifa`).
2. **Yagona Tashqi Kanal — Markazning Rasmiy Telegram Boti:**
   - Har bir o‘quv markaziga BotFather orqali shu markaz nomi va logotipi bilan alohida Telegram Bot (masalan, `@GulistonIlm_Bot`) ulanadi (`PDF 3-sahifa`, `R02`).
   - **1 marta telefon tasdiqlash (Verification):** Ota-ona botga kirib `/start` bosadi va markazda ro‘yxatdan o‘tgan telefon raqamini 1 marta tasdiqlaydi (`PDF 4-sahifa`, `R16`, `R14.01`). Muhandislik qoidasiga ko‘ra, bir martalik invite va Telegram `contact.user_id` tekshiruvi qo‘llanadi; telefon raqami o‘zgarsa Admin tekshiruvi bilan qayta bog‘lanadi va eski chat huquqi bekor qilinadi (`D18`, `07_SECURITY_AND_RELEASE.md`).
3. **Ota-ona Telegram Bot orqali oladigan xabarlar va bajaradigan amallar:**
   - **Davomat avto-xabari:** Farzandi darsga **kelmaganda (absent)** yoki **kechikkanda (late)** o‘qituvchi davomatni tasdiqlashi (submit) bilan avto-xabar oladi (`PDF 2–4, 6-sahifalar`, `R12.04`, `R14.03`).
   - **Elektron kvitansiya:** To‘lov qabul qilinganda rasmiy ichki elektron kvitansiya va keyingi to‘lov muddati haqida xabar oladi (`PDF 3–4-sahifalar`, `R10.04`, `R16`).
   - **Va’da sanasi eslatmasi:** Qisman to‘lovda belgilangan va’da sanasi kuni ertalab soat **09:00 da** muloyim eslatma oladi (`PDF 5-sahifa`, `R09`, `R13.02`).
   - **Interaktiv "Balans va Davomat" tugmasi:** Ota-ona botdagi tugmani bosib, farzandining davomati, joriy balansi/qarzi va dars jadvalini ko‘radi (`PDF 4, 6-sahifalar`, `R16`, `R14.02`).
4. **Botning Texnik va Xavfsizlik Chegarasi:**
   - Ota-ona bot orqali markaz bazasidagi ma’lumotlarni (balans, davomat, guruh) **o‘zgartira olmaydi** (`PDF 6-sahifa`: *"Bot o‘zi bazani o‘zgartirmaydi — u faqat Markaziy Serverdagi tasdiqlangan ma’lumotni o‘qiydi"*).
   - Agar ota-ona botga ulanmagan bo‘lsa yoki botni bloklab qo‘ysa (`403 Forbidden`), talaba profili yonida sariq belgi (**"Bot ulanmagan"**) yonadi va Adminga telefon orqali bog‘lanish uchun alohida ro‘yxat chiqariladi (`PDF 8-sahifa, 2-Loop`, `R18`, `R14.04`).

---

## 4. O‘qituvchi (Teacher) Uchun Maxfiylik, Moliya va Boshqa Guruhlarga Cheklovlar

O‘quv markazlarida mijozlar bazasi (talabalar va ota-onalar kontaktlari) o‘g‘irlanishi hamda moliyaviy ma’lumotlar tarqalishining oldini olish uchun O‘qituvchi roliga qat’iy cheklovlar o‘rnatiladi (`PDF 4-sahifa, 3-band`, `R01`, `R05.04`, `07_SECURITY_AND_RELEASE.md`):

1. **Boshqa guruhlarni ko‘rish va o‘zgartirish taqiqi (Strict Group Ownership & IDOR Prevention):**
   - O‘qituvchi ilovada yoki mobil vebda **faqat o‘ziga biriktirilgan faol guruhlar va dars jadvalini** ko‘radi (`PDF 4-sahifa`).
   - Boshqa o‘qituvchining guruhiga, talabalar ro‘yxatiga, davomatiga yoki baholariga API orqali ID almashtirib (IDOR) murojaat qilinsa, server DTO/query scope darajasida `403 Forbidden` / `404` qaytaradi (`R05.02`, `R05.04`, `07_SECURITY_AND_RELEASE.md`).
   - **Yagona istisno — 1-kunlik "O‘rindosh O‘qituvchi" (Substitute Teacher / Zamena):** Admin kasal bo‘lgan o‘qituvchi o‘rniga boshqa o‘qituvchini 1 ta tugma bilan **faqat bugungi dars (aniq `lesson_id` occurrence)** uchun vaqtincha biriktirsa, o‘rindosh o‘qituvchiga faqat o‘sha darsning davomat huquqi va 1 kunlik dars haqi ochiladi (`PDF 8-sahifa, 4-Loop`, `R20`, `R07.03`). Muddati tugagach yoki vakolat olib tashlangach, oflayn keshdan kelgan kechikkan yozuvlar ham server tomonidan rad etiladi (`05_DOMAIN_RULES.md`).
2. **Markaz moliyasi, kassa va to‘lovlarga kirish taqiqi:**
   - O‘qituvchi markazning umumiy tushumini, kassa smenasini, o‘quvchilarning to‘lov summalarini, qarzlarini, chegirma/grantlarini yoki kvitansiyalarini **ko‘ra olmaydi va tahrirlay olmaydi** (`PDF 4-sahifa`, `R05.04`).
3. **Ota-onalar va o‘quvchilarning shaxsiy telefon raqamlarini ko‘rish/ko‘chirish taqiqi:**
   - O‘qituvchi ekranida va unga qaytadigan API javoblarida (shu jumladan oflayn SQLite bazasida; `R17.02`) ota-onalarning shaxsiy telefon raqamlari **berilmaydi / maskalanadi** va ommaviy eksport (Excel/CSV) funksiyasi o‘qituvchi uchun butunlay yopiq bo‘ladi (`PDF 4-sahifa`: *"O‘qituvchi markazning umumiy pulini, boshqa guruhlarni va ota-onalarning shaxsiy telefon raqamlarini ko‘chira olmaydi — bazani o‘g‘irlashdan himoya"*, `R05.04`).

---

## 5. Har Bir Markaz Izolyatsiyasi va Vendorning Markaz Xodimlaridan Farqi

### 5.1. Har bir o‘quv markazining B2B Turnkey izolyatsiyasi (`R02`, `R20.01`–`R20.04`)
v1.0 dagi "barcha markazlarni bitta aralash bazada saqlash" g‘oyasi v2.0 da rad etilgan, chunki o‘quv markazi rahbarlari o‘z moliyasi va talabalar bazasi begona markazlar bilan bitta joyda turishiga ishonmaydi (`PDF 1-sahifa, 2-band`). Shu sababli v2.0 da har bir mijoz markaz (masalan, `guliston-ilm`) uchun:
1. **Alohida PostgreSQL ma’lumotlar bazasi va DB foydalanuvchisi** (masalan, `db_guliston_ilm` va alohida DB credentials).
2. **Alohida fayllar papkasi / Docker volume va ichki Docker tarmog‘i (network)**.
3. **Alohida Backend API va Worker konteyneri** (Docker Compose stack).
4. **Alohida subdomen / veb-manzil va SSL sertifikati** (masalan, `guliston-ilm.eduerp.uz`).
5. **Alohida Telegram Bot va token** (masalan, `@GulistonIlm_Bot`) ajratiladi (`PDF 1, 3-sahifalar`, `03_ARCHITECTURE.md`).
- **Infratuzilma chegarasi (Shared VPS vs Dedicated VPS):** Tejamkorlik uchun bitta VPS serverda bir nechta izolyatsiyalangan Docker Compose stack ishlashi mumkin, biroq bitta jismoniy VPS nosozligi shu serverdagi stacklarga ta’sir qilishi arxitektura va runbookda ochiq qayd etiladi; kuchliroq izolyatsiya talab qilinsa alohida VPS ajratiladi (`03_ARCHITECTURE.md`, `S02.01`). Hech bir holatda Center A xodimi yoki API’si Center B bazasiga yoki fayllariga kira olmaydi (`T20.04`, `T23.03`).

### 5.2. Platforma Vendori va Markaz Xodimlari (Rahbar/Admin/Teacher) O‘rtasidagi Farq (`R04`, `S19`)
Manbada (`PDF 2–3, 7–8-sahifalar`) "Siz" deb murojaat qilingan subyekt — **Platforma Vendori (B2B Turnkey yetkazib beruvchi)** bo‘lib, u o‘quv markazining ichki xodimlaridan (Rahbar, Admin, Teacher) tubdan farq qiladi:

| Mezon | Markaz Xodimlari (`Rahbar`, `Admin`, `Teacher`) | Platforma Vendori (`Vendor` / B2B Provayder) |
| :--- | :--- | :--- |
| **Yuridik va biznes maqomi** | Muayan bitta o‘quv markazining egasi yoki yollanma xodimi (masalan, "Guliston Ilm" markazi direktori, kassiri, o‘qituvchisi). | EduERP v2.0 dasturiy mahsulotini yaratuvchi, sotuvchi, o‘rnatib beruvchi va texnik xizmat ko‘rsatuvchi tashqi B2B provayder. |
| **Autentifikatsiya va kirish konturi** | Faqat o‘z markazining domenidagi (`<center>.eduerp.uz`) Staff Web va Staff Mobile App ga kiradi (`S05`). | Alohida **Markaziy Vendor Panel (`apps/vendor`)** ga alohida Vendor Auth va MFA siyosati bilan kiradi (`03_ARCHITECTURE.md`, `07_SECURITY_AND_RELEASE.md`, `D23`, `S19.01`). |
| **Ma’lumotlarni ko‘rish chegarasi (Privacy)** | O‘z roli doirasida markazning o‘quvchilari, guruhlari, davomati va kassasi bilan ishlaydi. | **Vendor registri markazlarning ta’lim va moliya ma’lumotlarini (talabalar, to‘lovlar) yig‘maydi va oddiy rejimda ko‘rmaydi** (`03_ARCHITECTURE.md`, `07_SECURITY_AND_RELEASE.md`). Vendor faqat markaz metama’lumotlari (center slug, domen, litsenziya muddati, holati) bilan ishlaydi. |
| **Litsenziya va Read-Only Kill-Switch vakolati** | Litsenziya holatini o‘zgartira olmaydi. Litsenziya muddati tugasa yoki Vendor Read-Only yoqsa, yangi to‘lov/davomat/import kirita olmaydi; faqat tizimga kirish (login), ko‘rish (read) va eksport huquqi saqlanadi (`PDF 3-sahifa`, `D17`, `S19.03`). | Markaz oylik texnik xizmat to‘lovini vaqtida to‘lamasa, Vendor panelidan bitta tugma bilan markaz litsenziyasini **Read-Only** rejimiga o‘tkazadi va to‘lov qilingach qayta faollashtiradi (`PDF 3-sahifa`, `R04`, `S19.02`–`04`). |
| **O‘rnatish, Zaxira va Onboarding ishlari** | Server deploy yoki DB restore qilmaydi; kundalik o‘quv va moliya jarayonini yuritadi. | `deploy_center.sh` orqali yangi markazni ko‘taradi (`S20`), tungi shifrlangan zaxira va monitoringni boshqaradi (`S21`), hamda dastlabki 1–3 oyda mijoz roziligi bilan eski Excel/qog‘oz bazani tozalab kiritish va xodimlarni o‘rgatish (onboarding) xizmatini bajaradi (`PDF 7–8-sahifalar`, `S24`). |

---

## 6. v3.0 ga Qoldirilgan, Tashqi Scope va Tasdiqlanmagan Funksiyalar

Loyiha ko‘lamini shishirib yubormaslik (scope creep oldini olish) va S01.05 darvozasidan ("tasdiqlanmagan qoida kodga aylantirilmaydi") o‘tish uchun quyidagi chegaralar qat’iy qayd etiladi:

### 6.1. v3.0 ga qoldirilgan va v2.0 da QAT’IY TAQIQLANGAN funksiyalar
1. **O‘quvchi va Ota-ona Mobil Ilovasi hamda Veb-Kabineti (`v3.0`):**
   - Ota-onalar yoki o‘quvchilar uchun iOS/Android mobil ilova, PWA yoki veb-saytda shaxsiy kabinet / login yaratish v2.0 ga kirmaydi (`PDF 1-sahifa`: *"Ota-ona & O‘quvchi Aloqasi: Faqat Telegram Bot (Ilovasiz, v3.0 gacha)"*, `PDF 4-sahifa`).
2. **Og‘ir Klaster va Murakkab Sinxronizatsiya Texnologiyalari (Rad etilgan v1.0 yondashuvi):**
   - Kubernetes (K8s) klasterlari va murakkab CRDT algoritmlari v2.0 da ishlatilmaydi; ularning o‘rniga Docker Compose va server-truth + UUID + version + `(lesson_id, student_id)` dedup modeli qo‘llanadi (`PDF 1, 5–6-sahifalar`, `D07`).
3. **Erkin formatdagi ("Har qanday") Excel faylni avtomatik tushunish (Rad etilgan v1.0 yondashuvi):**
   - Ustunlari siljigan yoki ixtiyoriy strukturadagi Excel fayllarni taxminiy (heuristic/AI) import qilish v2.0 da taqiqlanadi; faqat tizim generatsiya qilgan **Locked Excel Template** (yashirin `student_id` va versiya bilan) qabul qilinadi (`PDF 2, 6-sahifalar`, `R14`).
4. **Umumiy aralash (Shared Multi-Tenant Database) arxitektura:**
   - Barcha o‘quv markazlarini bitta PostgreSQL bazasida `tenant_id` ustuni bilan aralash saqlash v2.0 da qo‘llanmaydi (`PDF 1, 3-sahifalar`, `R02`).

### 6.2. v2.0 da tasdiqlanmagan (Biznes/Ega qarorini kutayotgan) funksiyalar va da’volar
Quyidagi funksiyalar manba PDFda tilga olingan yoki muhandislik tahlilida aniqlangan bo‘lsa-da, `planning/02_DECISIONS.md` ва `planning/state/DECISIONS.md` ga ko‘ra **hali tasdiqlanmagan (`PROPOSED` / ochiq)**. Ularni Step `01.02` va `01.04` da biznes egasi tasdiqlamaguncha kodda default qoida sifatida implementatsiya qilish mumkin emas:

| Yo‘nalish | PDFdagi ifoda | Ochiq qaror / Cheklov (`02_DECISIONS.md`) | Qaysi Step / Stage’da yopiladi |
| :--- | :--- | :--- | :--- |
| **Click / Payme / Perechisleniye integratsiyasi** | Admin naqd va karta (Click/Payme/Perechisleniye) to‘lovlarni qabul qiladi (`PDF 3, 5-sahifalar`). | **`D12`:** v2.0 bazaviy ko‘lami — to‘lov usulini kassada **qo‘lda qayd etish (manual recording)**. Real to‘lov shlyuzi (live payment gateway, merchant hisob, webhook) alohida scope va tasdiq talab qiladi. | Qaror: `01.04` (`D12`)<br>To‘lov qaydi: `10.01` |
| **Elektron kvitansiyaning huquqiy/fiskal maqomi** | 1 soniyada "rasmiy elektron kvitansiya" boradi (`PDF 3–4-sahifalar`). | **`D13`:** v2.0 dagi kvitansiya — **ichki elektron kvitansiya**. Davlat soliq qo‘mitasi (fiskal QR chek / OFD) integratsiyasi tasdiqlanmagan va rasmiy fiskal chek maqomi da’vo qilinmaydi. | Qaror: `01.04` (`D13`)<br>Kvitansiya: `10.04` |
| **O‘qituvchi oylik maoshi (Payroll) formulasi** | Rahbar "hisoblangan oylik maoshlari"ni ko‘radi; o‘rindoshga 1 kunlik haq yoziladi (`PDF 3, 7–8-sahifalar`). | **`D11`:** PDFda maosh hisoblashning aniq matematik formulasi (fixed, per-lesson, foiz, grant/chegirma/refund ta’siri) berilmagan. Markaz bilan tasdiqlanmaguncha payroll yopilmaydi. | Biznes qoida: `01.02`<br>Qaror: `01.04` (`D11`)<br>Implementatsiya: `18.02` |
| **Tarif, Pro-rata, 12-dars abonement, Trial, Freeze, Chegirma, Refund hisoblari** | 4.1–4.6 bo‘limlardagi misollar (`PDF 4–5-sahifalar`). | **`D03`, `D14`, `D21`, `D22`:** Kalendar oy vs rolling month vs 12-dars paketi, yaxlitlash birligi, chegirmalar qo‘shilishi (stacking), trial no-show muddati, freeze kredit sanasi, 31-sana renewal va refund qarzni qayta ochishi tasdiqlanishi kerak. | Biznes qoida: `01.02`<br>Qaror: `01.04`<br>Implementatsiya: `S08`–`S10` |
| **Shaxsiy Telegram kanalga tungi baza zaxirasi (`.sql.gz` va `.xlsx`)** | Har kecha Cloud va shaxsiy yopiq Telegram kanalga shifrlangan holda tashlanadi (`PDF 8-sahifa, 5-Loop`). | **`D16`:** Offsite shifrlangan cloud backup — asosiy; Telegram kanalga ikkinchi nusxa yuborish faqat fayl hajmi (Telegram bot limitlari), maxfiylik va shifrlash kalitlarini boshqarish tasdiqlansa yoqiladi. | Qaror: `01.04` (`D16`)<br>Zaxira: `21.01`, `21.04` |
| **Vaqt va tezlik ko‘rsatkichlari (SLOs vs Marketing da’volari)** | "1 soniyada xabar", "25 xabar/s", "5/10 daqiqada o‘rnatish", "1 daqiqada tiklash", "8 haftada qurish" (`PDF 1, 3, 6–8-sahifalar`). | **`D02`, `D08`, `D09`, `D10`, `D20`, `B28`:** Bular mutlaq texnik kafolat emas, balki mo‘ljal (target). Real ko‘rsatkichlar DNS/VPS tayyorligi, Telegram API rate-limitlari (`429`), baza hajmi (RPO ≤24s, RTO ≤60d taklifi) va superuser chegarasiga bog‘liq. | Qaror: `01.04`<br>Sinov: `S20`, `S21`, `S23` |
| **Demo bazadagi talabalar soni (240 vs 250) va Mikro-video yozuvlar** | 2-sahifada 240 nafar, 7-sahifada 250 nafar talaba; 8-sahifada 45 soniyalik video qo‘llanmalar. | **`D01`, `D25`:** 240 — asosiy demo seed, 250 — stress fixture taklifi; real video kontentni kim yozib berishi va qayerda saqlanishi (`CONTENT_PENDING`) ochiq. | Qaror: `01.04` (`D01`, `D25`)<br>Implementatsiya: `S22` |

---

## 7. PDF Manba Sahifalari (1–8) Qamrovi va Traceability Xulosasi

`EduERP_v2_Master_Reja_va_Arxitektura.pdf` hujjatining barcha **8 sahifasi** to‘liq ko‘rib chiqildi va `docs/spec/scope-traceability.csv` faylida `R01`–`R23` (manba talab guruhlari) hamda `R01.01`–`R24.04` (96 ta step talablari) bilan 100% bog‘landi:

- **Sahifa 1:** Loyiha pasporti, v2.0 Staff-Only tamoyili, ota-ona/o‘quvchi uchun faqat Telegram Bot (v3.0 gacha ilovasiz), v1.0 xatolar auditi (1–3-yo‘nalishlar: Staff-Only, Izolyatsiyalangan B2B Turnkey, Docker Compose) $
ightarrow$ `Bo‘lim 1, 2, 3, 5, 6` (`R01`, `R02`).
- **Sahifa 2:** v1.0 xatolar auditi (4-yo‘nalish: Locked Excel Template + Validator), B2B sotuv maqsadi, 2.1 "Jonli Demo" (240 o‘quvchi, 14 guruh, 6 o‘qituvchi, 50% chegirma, grant, qarzdorlar, 3 daqiqalik fokus) $
ightarrow$ `Bo‘lim 1, 2, 6` (`R02`, `R03`, `R14`).
- **Sahifa 3:** 3 daqiqalik demo davomi (400,000 so‘m to‘lov va kvitansiya), 2.2 Auto-Provisioning (`deploy_center.sh`, alohida DB/fayl/bot/domen/login) va Subscription Kill-Switch (Read-Only), 3-bo‘lim: Foydalanuvchi rollari (1. Markaz Rahbari, 2. Boshqaruvchi Menejer / Admin) $
ightarrow$ `Bo‘lim 1, 2, 5, 6` (`R01`–`R05`, `R08`–`R11`, `R14`, `R20`).
- **Sahifa 4:** 3-bo‘lim davomi (3. O‘qituvchi va cheklovlar; 4. Tashqi kanal — Ota-ona va O‘quvchi faqat Telegram Bot), 4-bo‘lim: Real-World Edge Cases (4.1 Mid-Month Enrollment A/B rejimlari, 4.2 Trial Lesson, 4.3 Chegirmalar va Grant — Rahbar tasdig‘i) $
ightarrow$ `Bo‘lim 2, 3, 4, 6` (`R01`, `R05`–`R08`, `R16`).
- **Sahifa 5:** 4.3 davomi (Rahbar Telegram/ilova tasdig‘i), 4.4 Qisman to‘lov va Va’da sanasi (09:00 eslatma), 4.5 Anti-Fraud Cash Control (Immutable Ledger, Storno/Refund, Smena yopish), 4.6 Dars qoldirish, Freeze va Churn (5 sabab), 5-bo‘lim: 4-Tomonlama Integratsiya (1. Markaziy Server PostgreSQL, UUID, version) $
ightarrow$ `Bo‘lim 1, 2, 6` (`R08`–`R14`).
- **Sahifa 6:** 5-bo‘lim davomi (2. Kompyuter Excel shablon `student_id`, 3. Staff Mobil Ilova SQLite oflayn va `group_id+student_id+date` / `D07`, 4. Telegram Bot — bazani o‘zgartirmaydi, 25 xabar/s), 6-bo‘lim: Bosqichma-bosqich ishlab chiqish va 1–3 oylik joriy etish $
ightarrow$ `Bo‘lim 1, 2, 3, 6` (`R13`–`R16`).
- **Sahifa 7:** 6.1 Dasturni qurish ketma-ketligi (1–5-qadamlar, 8 hafta mo‘ljal, 250 talabali Demo markaz), 6.2 Onboarding Playbook (1–3 kunlar, 4–7 kunlar, 2–4 haftalar, 2–3 oylar), 7-bo‘lim: Loop Tahlili (A-Bosqich Real Kuzatuv, B-Bosqich Interfeysni Soddalashtirish) $
ightarrow$ `Bo‘lim 1, 5, 6` (`R02`, `R03`, `R14`, `R15`, `R20`, `R22`, `R23`).
- **Sahifa 8:** 7-bo‘lim davomi (C-Bosqich Avto-Himoya / dublikat bloklash) va 5 ta Loop xavf-yechim jadvali (1-Loop Teacher Ping 20 daqiqa va Admin escalation; 2-Loop Bot blocked / Delivery status sariq belgi; 3-Loop 45s In-App Micro-Guides; 4-Loop 1-kunlik Substitute Teacher / Zamena; 5-Loop Ikki qatlamli Cloud + Telegram `.sql.gz`/`.xlsx` avto-arxiv) $
ightarrow$ `Bo‘lim 1, 2, 3, 4, 5, 6` (`R17`–`R21`, `R23`).
