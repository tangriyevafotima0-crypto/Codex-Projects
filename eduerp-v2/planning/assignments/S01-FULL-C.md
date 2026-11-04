# S01-FULL-C — Butun birinchi bosqich

TASK_ID: S01-FULL-C
MODE: DOCUMENT_STAGE_OFFLINE
Scope: 01.01 fix + 01.02 + 01.03 + 01.04 + 01.05 review readiness
Project root: eduerp-v2/
BASE_COMMIT: paket rootidagi TASK_INPUT.jsonda.
Supersedes: oldingi single-step/fix va BATCH-01.01-01.02-B topshiriqlari shu stage doirasida.

## Ishlash tartibi va kirish
Bitta topshiriq, bitta yakuniy ZIP. Stage ichida managerning oraliq javobini kutmang. Yakuniy approval managerda. Paketdan tashqari S02 yoki mahsulot kodini boshlamang.

ZIP mustaqil ishlashga yetadi: baseline reja, PDF8 sahifa matni, manager review va original candidate4 fayl overlay mavjud. Candidate canonical APPROVED kod/hujjat emas. Agar oldingi fix/batch ishini allaqachon bajargan bo‘lsangiz, yangi ZIPni alohida papkaga oching, yangilangan topshiriq/qoidalarni o‘qing va yangi lokal natijangizni saqlang; uni eski candidate bilan ustidan yozmang. Hash/asos farqini hisobotda qayd eting. To‘g‘ri ishni boshidan qayta yaratmang.

Avval faqat AGENTS.md, ACTIVE_TASK.md, 09_BATCH_POLICY.md, ARGON_LEARNING.md va reviews/01.01-A.mdni o‘qing. Manba va tegishli qoidalar: source/MASTER_SOURCE_TEXT.md, SOURCE_REQUIREMENTS.csv, requirements.csv, execution.jsonning faqatS01 acceptance qismi, 02_DECISIONS.md, 05_DOMAIN_RULES.md. stage01 va prompts/S01 eski shablonlari qo‘shimcha; ushbu assignment sanab bergan batch scopeida oldingi single-step stop/approval kutish talabi qo‘llanmaydi. Barcha124 promptni o‘qish kerak emas.

## 01.01 — Mavjud natijani tuzatish
reviews/01.01-A.md F01–F05ni yoping. Muhim joylar:
- Role/channel policy: PDF talabi, engineering taklif va OPEN qarorni ajrating. Admin staff READ, faqat o‘z smenasi, ping/eslatma transporti kabi granular tafsilotlarni avtomatik tasdiqlamang. Deny-by-default xavfsizlik qoidasini aniq biznes grantiga tenglashtirmang.
- CSV locatori bitta yoki `;` bilan ajratilgan haqiqiy file#anchor. scope.mdga stable explicit anchorlar.7 ustun va119 ID saqlansin. Keyingi stepga deferred mazmun scope boundary anchoriga borsin.
- R22.04 video PDF8; source_page va source_section mos; PDF Loop A–C, D taklif. Managerdan meros page xatolarini takrorlamang; upstream correction list yozing.
- Raw guardian phone Teacher API/export/SQLite/logga berilmasin; UI maska uning o‘rnini bosmaydi.
- RPO24 soat(24 h), RTO60 daqiqa(60 min), PROPOSED; PDF fayli hashini extracted Markdown hashidan farqlang; ID count semantik coverage isboti emas.
Tuzatilgan scope, traceability, verification01.01 va step01.01 reportni saqlang.

## 01.02 — Biznes qoidalari loyihasi
A tuzatishlarini mahalliy tekshirganingizdan keyin, alohida manager javobini kutmay quyidagini yozing. Bu draft, user qabul qilgan biznes siyosati emas.

Yangi asosiy fayl: docs/spec/business-rules.md.
Har qoida uchun: BR-ID; source page/section yoki engineering origin; D-ID; status (SOURCE_RULE / PROPOSED / OPEN / ACCEPTED faqat haqiqiy dalil bo‘lsa); actor; trigger; precondition; input/unit; hisoblash yoki transition; expected effect; reject/rollback; idempotency; affected steps. SOURCE_RULE manba aytgan qoida ekanini bildiradi, barcha tafsilotlar qabul qilingan degani emas. Bog‘liq bo‘lmagan bo‘sh maydonni N/A bilan qisqa belgilang.

Qamrov:
- Calendar pro-rata / rolling month / 12 lesson package farqi; start/end boundary, timezone, cancelled lesson va month-end.
- Trial first lesson/no debt → second distinct attended lesson activation; duplicate event va attendance correction; no-show follow-up.
- Oilaviy, fixed/percent,50%,grant; approval, expiry va stacking.
- Partial payment, promise, overpayment/unapplied credit; shift bilan atomiklik.
- Immutable payment/reversal/refund/credit-note farqi; rahbar tasdig‘i, partial refund va debt reopening alternatives.
- Freeze, overlap va next-period credit; unexcused absence; withdrawal/re-enrollment va eski qarz.
- Opening cash/receipt/refund/expense/closing reconciliation.
- Payrollning fixed/per-lesson/percentage alternativalari, substitute allocation, discount/grant/refund ta’siri; yopilgan snapshot correctioni.

Kamida20 ixcham, mustaqil qabul holati jadvali bo‘lsin:
1. 480000×7/12=280000 pro-rata.
2. Qolgan0 dars va denominator0 alohida.
3. 31-yanvar renewal, leap-year va non-leap alternativalari aniq sanalar bilan.
4. 12-dars paketida cancelled lesson sarfi (OPEN policyga ikki variant).
5. Birinchi trial va ikkinchi DISTINCT attended lesson.
6. Bir event retryda qo‘shimcha invoice yo‘q.
7. Tasdiqsiz50% chegirma effect yo‘q; tasdiqlansa misol.
8. 100% grant →net charge0, cash payment/refund avtomatik yo‘q.
9. Fixed+percent stacking ikki tartibda turli natija, OPEN qaror.
10. Expired discount yangi davrga qo‘llanmaydi.
11. 500000 invoice−300000 payment=200000 debt; promise yo‘q bo‘lsa command commit bo‘lmaydi.
12. 600000 payment→500000 allocation+100000 unapplied credit.
13. 4000000 xato payment→reversal+400000 correction, net400000.
14. Partial refund cap va ikki parallel approve bitta effect.
15. Overlap freeze bir darsga ikki kredit bermaydi; kredit policy OPEN misol bilan.
16. Unexcused absence reprice qilmaydi.
17. Withdrawal eski qarzni o‘chirmaydi, re-enrollment eski tarixni almashtirmaydi.
18. Opening0+cash3200000−expense150000=3050000; card1800000 naqdga qo‘shilmaydi.
19. Substitute bitta lesson ulushi; maosh parametrlarini PROPOSED qilib raqamli misol.
20. Closed payroll correction yangi adjustment, eski snapshot o‘zgarmaydi.

Hisob natijasi qarorga bog‘liq bo‘lsa qiymatni universal qoida sifatida yozmang: «A policy ostida …, B policy ostida …, DECISION_REQUIRED». Yo‘q foiz, maosh yoki rounding policyini fakt sifatida ixtiro qilmang. Faqat aniq arifmetik misollarni Python stdlib bilan tekshirish mumkin.

Ochiq savollarni shu faylning oxirida jamlang: decision ID, variantlar, tavsiya+asos, affected steps, qaysi implementatsiyadan oldin zarur. Biznes qoidalarini tuzish va user tasdiqlashi turli ish; javob yo‘qligi butun hujjat draftini bloklamaydi.


## 01.03 — Qabul mezonlari va talablar xaritasi
`docs/spec/acceptance.md`: acceptance qoidasi, source vs engineering statusi, tasdiqlovchi rol, regression guruhlari va stage chegaralari. Mavjud96 stepdan tayyor acceptance matnlarini tegishli joyda foydalaning; scope maqsadlarini takrorlab119ta yuzaki bir xil test yozmang.

`docs/spec/acceptance.csv` ustunlari aynan:
requirement_id,criterion_id,actor,given,when,then,owner_steps,source_locator,decision_ids,validation_status

119 unique requirement ID: SOURCE_REQUIREMENTSdagi23 guruh + requirementsdagi96 ish. Bu119 mustaqil PDF talabi degani emas; ikki darajali coverage map. Har rowga tekshiriladigan aniq input/trigger/natija; haqiqiy owner step; role (technical stepda Developer/Reviewer ham mumkin). Manba locatori PDF page/section yoki engineering hujjatning haqiqiy anchoriga borsin. Bitta source group bir nechta owner stepga ega bo‘lishi mumkin. Criterion ID unique. Oldingi T01.01–T24.05 identifikatorlari o‘zgartirilmasin; kerak bo‘lsa yangi AC prefiksli ID yarating va mapping yozing.

Future app davranishi test qilingan deb yozilmang: PLANNED/DECISION_REQUIRED. Hozir tekshirilgan hujjat/arifmetika dalilini docs/verificationda alohida ko‘rsating. Qarorga bog‘liq expected value conditional yozilsin; mustaqil invariant esa aniq bo‘lsin.

## 01.04 — Qarorlar registri va javob berish oson savollar
`docs/spec/decisions.md`: D01–D25ning hammasi, mos anchorlar bilan. Har biriga: muammo; source; alternativalar; tavsiya va sabab; status; decision owner; affected_steps; due_before; qaror evidence. Ownerni rol sifatida ko‘rsatish mumkin; odam nomini ixtiro qilmang.
- ACCEPTED faqat user yoki vakolatli mas’ulning haqiqiy dalili bo‘lsa. Hozir yo‘q qarorlarni PROPOSED/DECISION_REQUIRED/DEFERRED bilan saqlang.
- F01 role/channel savollari zarur bo‘lsa OPEN_RBAC/OPEN_CHANNEL sifatida mavjud qarorlarga bog‘langan alohida savol registriga kirsin; D01–D25ni renumber qilmang.
- Har ochiq qaror butun stage/reponi bloklamaydi. Qaysi hisob, endpoint yoki implementatsiyadan oldin zarurligi aniq bo‘lsin.
- Manager keyin ko‘rib business ownerga berishi uchun savollarni mavzular bo‘yicha guruhlang, eng dolzarb5ta savolni birinchi ko‘rsating. Variant/tavsiya bor, user nomidan tanlov yo‘q.
- Traceability/source registryda noto‘g‘ri inherited page bo‘lsa upstream correction sectionda ID+eski+yangi+dalil. Bu taskda global registrni edit qilmang.

## 01.05 — Butun stage uchun sifat tekshiruvi va handoff
01.01–01.04ni o‘zaro solishtiring: rol/scope, biznes qoida, AC, D qaror va manba bir-biriga zid bo‘lmasin. D qarori OPEN bo‘lsa boshqa faylda yashirin ACCEPTED default bo‘lmasin. ACda owner va expected bo‘lsin; source locator va anchor haqiqiy; units va date boundaries aniq.

`docs/verification/S01.md`: actual command, actual result, F01–F05 closure,119 ID/criteria checks,20+ case check, source-page semantic sample/all review usuli, D01–D25 completeness va cross-document conflict natijasi. Qayta bajariladigan Python stdlib buyruqlari shu Markdown ichida bo‘lsin, boshqa executable code fayli kerak emas. Barcha bir xil tekshiruvni har stepda qayta yugurtirish o‘rniga umumiy dalilga havola bering. Run bo‘lmaganini RUN_NOT_EXECUTED deb yozing.

`planning/state/steps/01.01.md`–`01.05.md`: qisqa alohida hisobotlar, IN_REVIEW, umumiy dalilga bog‘langan. `.05` — ijrochi self-check, mustaqil audit yoki manager approval emas.

`planning/state/handoffs/S01.md`: reviewed input commit, input/candidate versiyasi, scope/rules/AC/decisions indeksi, actual evidence, ochiq blocker va ta’siri, S02 o‘qishi kerak bo‘lgan konkret fayllar/qarorlar. Status IN_REVIEW yoki READY_FOR_MANAGER_REVIEW. User hali qaror bermagan bo‘lsa stage fully APPROVED deb yozmang; hujjat to‘liqligi bilan policy sign-offni ajrating.

## Topshirish formati va o‘zgarish chegarasi
Faqat quyidagi14 to‘liq hujjat + SUBMISSION.json =15 fayl. Repo yoki boshlang‘ich ZIPni qayta topshirmang:
- docs/spec/scope.md
- docs/spec/scope-traceability.csv
- docs/spec/business-rules.md
- docs/spec/acceptance.md
- docs/spec/acceptance.csv
- docs/spec/decisions.md
- docs/verification/01.01.md
- docs/verification/S01.md
- planning/state/steps/01.01.md
- planning/state/steps/01.02.md
- planning/state/steps/01.03.md
- planning/state/steps/01.04.md
- planning/state/steps/01.05.md
- planning/state/handoffs/S01.md

SUBMISSION.json: task_id=S01-FULL-C; steps=[01.01..01.05]; base_commit=TASK_INPUTdagi qiymat; status=IN_REVIEW; files[path,sha256] faqat14 hujjat. Qo‘shimcha completion_by_step va unresolved_decisions ro‘yxati mumkin. ZIP o‘zini yoki SUBMISSION.json o‘z hashini manifestga kiritmaydi.

Output: S01_FULL_C_SUBMISSION.zip. Fayl yo‘llari project rootga nisbatan, ichida yana eduerp-v2 wrapper bo‘lmasin.

execution.json/CURRENT/TRACKER, AGENTS, source va global decision/requirement registrlarini o‘zgartirmang. Mahsulot kodi, package install, DB, deploy, real contact yoki pullik servis bu topshiriqqa kirmaydi. Python stdlib lokal doc/arithmetic tekshiruvi ruxsat etilgan.

Yakuniy chat≤12 satr: task/status, step completion, F01–F05 closure, actual checks, open decisions/blockers soni, ZIP link.14 fayl matnini chatda qayta takrorlamang. Ish sig‘masa yangi mavzuni boshlamasdan tayyor fayllar va aniq checkpointni PARTIAL_IN_REVIEW bilan qaytaring; bajarilmagan ishni DONE deb yozmang.
