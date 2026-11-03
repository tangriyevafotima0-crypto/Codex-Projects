# v2.1 kritik bughunt hisoboti

Audit obyekti: oldingi ZIP ichidagi reja va promptlar. **Bu mavjud ERP kodining bughunti emas: kod hali yozilmagan.** Audit muallifning o‘z rejasini qayta ko‘rishi; mustaqil tashqi xavfsizlik auditi deb talqin qilinmaydi.

Tekshiruv: 24 stage va 124 promptning tuzilishi, PDFga oldingi qamrov xaritasi, moliya/sync edge caselar, dependency va review protokoli, target fayllar, integratsiya egasi, real dalil va taxminning farqi.

28 ta rejalashtirish kamchiligi tuzatildi. P1 — noto‘g‘ri ijro qilinsa moliya, vakolat, ma’lumot yoki releasega jiddiy ta’sir; P2 — ijro noaniqligi/to‘liqlik. Bu ishlab turgan tizimda tasdiqlangan eksploitlar ro‘yxati emas.

| ID | Daraja | Oldingi kamchilik | Joyi | v2.1 tuzatishi |
|---|---|---|---|---|
| B01 | P1 | Promptlarning aksariyatida stage gate takrorlangan, stepga xos kutilgan natija yo‘q | prompts/S08/01.md va boshqa 96 ish | 96 alohida T-ID ssenariysi; har promptda konkret normal/chegara/race natijasi |
| B02 | P1 | Web/mobile hisobot backenddan oldin tayyor deb talqin qilinishi mumkin | S15,S17,S18 | S18.04 ikkala UI integratsiyasining aniq egasi; pending integratsiya registri |
| B03 | P1 | Payment va majburiy promise atomikligi aniqlanmagan | S10.01,S11.03 | Promise yo‘q bo‘lsa payment ham commit bo‘lmaydi; integratsiya testi |
| B04 | P1 | Trial activationning real attendance eventi bilan yopilishi sust | S08.03,S12.04 | Distinct lesson va event dedup; correction siyosati va yakuniy integration gate |
| B05 | P1 | Freeze/discount/credit/refund hisoblari bir-biriga ta’siri yetarlicha ajratilmagan | S08–S11 | 05_DOMAIN_RULES; invoice snapshot, credit note, unapplied credit va cash refund farqi |
| B06 | P1 | Holat bir nechta faylda mustaqil yuritilib drift xavfi bor | TRACKER,CURRENT,handoff | execution.json canonical; tracker/current generator |
| B07 | P1 | Tasdiqlangan eski bosqich o‘zgarsa downstream approval eskirishi belgilanmagan | Master change loop | STALE holati va --invalidate zanjiri |
| B08 | P2 | Texnik dependency bilan ketma-ket ish tartibi bir jadvalda aralash | Master dependency | depends_on sequential, technical_inputs alohida |
| B09 | P2 | S01 bootstrapda yo‘q fayl/commitni talab qilish xavfi | Common prompt | S01 istisnosi, artifact hash; yo‘q AGENTS blocker emas |
| B10 | P2 | Handoff o‘z commitini o‘zida saqlash noaniqligi | HANDOFF | reviewed_code_commit alohida; hisobot keyingi commitda |
| B11 | P2 | Har stepda barcha handofflarni qayta o‘qish kontekstni ortiqcha to‘ldiradi | Common prompt | Joriy step + relevant contract index + dependency handoff |
| B12 | P1 | Vendor panel uchun alohida auth tahdidi yetarli yozilmagan | S19.01 | Vendor auth/MFA siyosati, signing key va audit gate |
| B13 | P1 | Read-only system write va business write farqi noaniq | S19.03 | Allowlist; login/export/backup/system ack va business writes ajratildi |
| B14 | P1 | Restore eski bot navbatini qayta yuborishi ko‘rsatilmagan | S21.02 | Outbound disabled restore va replay reconciliation |
| B15 | P1 | Webhook auth va Telegram update dedup konkret emas | S14.04 | Webhook secret, update_id dedup va 429/403/timeout testlari |
| B16 | P1 | Guardian unlinkdan keyin eski callback/pending message xavfi | S06,S14 | Active link qayta tekshirish va eski chat revoke |
| B17 | P2 | Trial no-show topshirig‘i explicit ijro egasiz | S13.04 | Follow-up job aniq vazifaga qo‘shildi |
| B18 | P2 | Excel server tayyor, lekin UI integratsiya egasi yo‘q | S16.04 | ImportPage target va preview/commit/conflict UI gate |
| B19 | P1 | Import atomikligi bor, lekin cheksiz fayl/transaction xavfi ochiq | S16 | Row/file limit, zip bomb, token expiry va bounded transaction |
| B20 | P2 | Video vazifasi faqat ssenariy bo‘lib, mavjud kontentdek talqin qilinishi mumkin | S22.04 | Help registry/playback va CONTENT_PENDING; real asset bo‘lmasa tayyor deyilmaydi |
| B21 | P2 | Bitta lockfile g‘oyasi Flutter toolchainni qamramaydi | S03.01 | JS va Dart lock/SDK alohida |
| B22 | P1 | S20 deploy S21 restore tekshiruvdan avval real mijozga ketishi mumkin | S20–S23 | S20 synthetic staging; production uchun restore va release gate |
| B23 | P2 | Dublikat studentni mutlaq bloklash aka-ukalarni bloklashi mumkin | S06.04 | O‘xshashlik review; bitta telefonli ikki farzand testi |
| B24 | P1 | Overpayment, closed shift, partial refund va parallel approve yetarlicha konkret emas | S10–S11 | Har biriga alohida numeric/race acceptance |
| B25 | P2 | Onboarding rejasini real 1–3 oylik natija deb APPROVED qilish xavfi | S24 | Real vaqt/mijoz sign-offi dalilisiz faqat playbook; execution approval yo‘q |
| B26 | P2 | Paket strukturasi testi mahsulot testi bilan adashishi mumkin | PACKAGE_CHECK | Validator cheklovi, executable test va spec.md farqi aniq |
| B27 | P2 | Oldingi requirements faqat 23 katta guruh, step owner yetarli emas | requirements.csv | Original23 guruh saqlandi; 96 owner/test mapping qo‘shildi |
| B28 | P2 | 8 hafta va demo latency real baholashsiz va’daga aylanish xavfi | Master/source notes | Taxmin ekanligi saqlandi; capacity/latency policy va o‘lchov gate qo‘shildi |

## Hali yopilmagan haqiqiy masalalar
- D01–D25 biznes qarorlari foydalanuvchi/markaz tomonidan hali tasdiqlanmagan; paket ularni qabul qilingan deb ko‘rsatmaydi.
- Mavjud repo, CI, real DB, Telegram, mobile distribution, server va mijoz UAT yo‘q; ularga oid acceptance kelajak ijroga tegishli.
- Haqiqiy video yozuvlar, pilot natijalari va case study roziligi yaratilmadi.
- Test scenario spetsifikatsiyasi executable test o‘rnini bosmaydi; ijrochi mos frameworkda test yaratib natijasini berishi kerak.
- 96 mayda mapping asosiy ishlar xaritasi; PDFning har jumlasini avtomatik atomik talabga aylantirish emas. Original23 guruh manba xaritasi bilan birga o‘qiladi.
- Step validator evidence faylining mavjudligini tekshiradi, uning rostligi yoki testning mazmunini avtomatik isbotlamaydi. Reviewer real dalilni tekshiradi.

## Nima o‘zgarmadi
Mahsulot scopei staff-only; parent/student Telegram; center izolyatsiyasi va Compose; 24 stage/120 step raqamlanishi saqlandi. Eski ZIP saqlandi. Mahsulot kodi yozilmadi, GitHubga push yoki deploy bajarilmadi.
