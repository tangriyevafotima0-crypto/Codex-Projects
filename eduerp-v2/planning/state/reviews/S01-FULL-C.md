# S01-FULL-C — manager review
Reviewer: Codex-manager
Decision: CHANGES_REQUIRED; S02 ruxsati faqat architecture candidate draft
Baseline:28ec895ea641287a0a45d19aafe4ff1ca70e9c78
Artifact SHA256:f726c482cf3c1766e08d5e6c4bf8cda8aeb4623f8bf60123dbba406636ec6b89

## Managerning haqiqiy tekshiruvlari
-15 ruxsat etilgan file, ZIP CRC/path/duplicate va14 SHA256 PASS.
-Trace va acceptance119 unique requirement ID to‘plamlari original23+96 bilan teng.
-Scope68 explicit anchor; barcha scope CSV locatorlari haqiqiy; acceptance explicit source anchorlari ham mavjud.
-6 mustaqil arifmetika tekshiruvi o‘tdi (pro-rata,2 stacking,16kun freeze,discounted freeze bound,kassa). Bu app yoki domain model testi emas.
-Submitted docs/verification/S01.md ichidagi Pythonni ajratib compile qildim: line5 SyntaxError: unterminated string literal. U asl holida ishga tushmaydi.
-Decision registrining haqiqiy status sanog‘i15 PROPOSED,9 DECISION_REQUIRED,1 DEFERRED. Report13/11/1 deydi.
-Acceptance96 step rowning given+when qismi generic task bajarilishi haqida; aniq domen kirish va trigger emas. Then ko‘pincha yaxshi mavjud step acceptance matnidan olingan.

## Oldingi F01–F05 natijasi
F01 asosiy role/channel ajratilishi tuzatilgan. F02 anchor tuzatilgan. F03 R22.04/R24.03 va R03.01 tuzatilgan, ayrim page/section mismatch qolgan. F04 raw phone boundary tuzatilgan. F05 unit va PDF/MD hash farqi tuzatilgan; semantic verification dalili quyidagi C01 sabab to‘liq emas. Hammasi mutlaq yopildi deb yozish hozir erta.

## Yangi paketda yopiladigan topilmalar
### C01 — P1 — Qayta bajariladigan dalil asl holida ishlamaydi
S01.md Python blockida `re.findall(r"<a id="([^"]+)"></a>",...)` quote xatosi; D-ID regexlarida ham shunday. CompileFAIL. Shu fayl esa ALL CHECKS PASSED va22 case/cross-document conflict_count0 tekshirildi deydi. Skript asosan file substring/row count va7ta oddiy arithmetic assertdan iborat;22case yoki semantic consistency isbotlanmaydi. business-rules.md formulalarida literal form-feed U+000C, tabdan buzilgan LaTex va newlinega aylangan rightarrowlar bor.
Fix: bitta oddiy tools/verify_s01_s02.py faylga stdlib checker yozish; o‘sha aniq faylni run qilib stdoutni saqlash. Hammasini test qildim emas, qaysi case ARITHMETIC_CHECKED/MODEL_CHECKED/DOC_REVIEWED/NOT_RUN ekanini alohida ko‘rsatish.22casening hammasiga tekshiruv turi xaritasi; concurrency/DB atomicligi hali app yo‘qligida runtime PASS emas. Semantic review automated countdan ajratiladi. Formula ko‘rinishlarini plain text/codega aylantirish mumkin; broken control belgilarni tozalash.

### C02 — P2 — Given/When96 rowda vazifani qayta nomlaydi
Masalan T05.03 `Stage05 artefakti tayyor` va `staff yaratish vazifasi bajarilib tekshirilganda` actual precondition/command emas. Future test yozuvchi yana taxmin qiladi.
Fix:96 rowning given/when qismini konkretlashtirish, existing then/IDni imkon qadar saqlash. Misol T05.03:given bitta active Director va uning sessioni;when o‘sha Directorni deactivate command;then reject+no state effect. T08.03:TRIAL+L1present+noinvoice;L2distinctsubmit;oneinvoice. Barcha119mezonga unique trigger/natija mosligi doc review; app testPLANNED.

### C03 — P1 — Moliya muqobillari cheklovi yetarli emas
BR08 gross480000×frozen6/12=240000, ammo50% discountli net240000studentga shu formula240000kredit bersa o‘qilgan6dars ham tekin bo‘lib qolishi mumkin. Grant0 maxsus case bor, lekin oddiy discounted charge, pro-rata va oldcredit uchun cap/policy yo‘q. BR07 haqiqiy refundni doim naqd kassadan ayiradi; karta/transfer refund method ko‘rsatilmagan. General invariantdagi `integer minor-unit/so‘m yoki tiyin` bitta numeric API maydoni uchun100baravar xatoga ochiq.
Fix: freeze basis/cap tanlovi D14 ostida OPEN; net-earned-credit tavsiya misoli480000gross−50%=240000net,6/12refundcredit120000 (faqat shu proposed policy ostida). Credit invoice/studentga avval berilgan kreditni ikki marta qaytarmasligi. Refund method=paid method yoki authorized alternative alohida maydon; faqat cashrefund cash shiftdan chiqadi, noncashalohida. Currency scale ochiq technical proposal yoki aniq kontrakt; example amount+unit conversionlari100xambiguous bo‘lmasin. Mijoz siyosatini o‘zing qabul qilma.

### C04 — P2 — Billing-cycle identity va reactivation kontrakti ochiq qolgan
BR01unique(enrollment_id,billing_period_key=YYYY-MM) calendar uchun;12lessonpackage bir oyda2cycle bo‘lishi mumkin, rollingmonth ham alohida anchor talab qiladi. Trialactivation(enrollment_id,TRIAL_ACTIVATION) permanent unique; attendance correctiondan keyin trialga qaytgan student yana validactivation qilsa nima bo‘lishi yozilmagan. Bu hali koddagi bug emas, S02schema oldidan yopiladigan kontrakt bo‘shlig‘i.
Fix: calendar/rolling/package uchun cycle identity, issued invoice snapshot va correction/reactivation version/compensation flow. Ikki package bitta oyda2invoice, bitta cycle retry1invoice. Activating→compensating→valid reactivation netcharge to‘g‘ri va duplicatecash yo‘q. Version/event unique keysni ular bilan moslash.

### C05 — P2 — Registr va self-check xulosalari o‘zaro zid
decisions.md15/9/1, handoff/userreport13/11/1;15taPROPOSED ID15sifatida sanalgan. D11due_before ayrim joy07.03, boshqa18.02; D19due04.01 bo‘lsa umumiy S02–S07 hechqachon bloklanmaydi iborasi noto‘g‘ri. Scope Teacherphone redaction savolida OPEN_RBAC_01 ishlatilgan, lekin o‘shaIDstaff creation delegationga tegishli. D08tavsiyasi fraudni100%yopadi deydi, shuqaror o‘zi100%kafolatni radetadi.
Fix: qarorlar uchun1authoritative row/section va generated/verified summary; earliestaffected implementation vs architecture draft farqi; phone question alohida unique alias yoki qat’iy baselinega qaytish; nofakeACCEPTED. Absolutefraud100%da’vosini olib tashlash.

### C06 — P2 — Ayrim page/section provenance mismatch qolgan
Misol R05.03source_page3–4,source_sectionp1 va3–4. Butun source_page/section,ACsource_locator va originni sync tekshirish. R03.01yangimapping yaxshilangan, mavjud to‘g‘ri ishni qayta yozish shart emas. Engineering detailning PDFsahifasi faqat goal uchun ekanini aniq ajratish. Globalcanonicalmappingga correctionlistberish, IDsrenumberyo‘q.

## Next scope
S01fix+butunS02architecture draft. Finance/auth detailga ta’sir qiluvchi noaniqliklar explicit policy ports/conditional schema sifatida qoladi. S01stage APPROVED emas; manager nextartifactda S01avval, S02keyin tekshiradi. Product app kodi/deploy ruxsati yo‘q.

Candidate lineage: GitHub branch `argon/s01-full-c-review` contains the14 original documents and transport manifest. They are not merged as approved specifications.
