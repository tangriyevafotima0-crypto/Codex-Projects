# BATCH-01.01-01.02-B — Argonning amaldagi topshirig‘i

TASK_ID: BATCH-01.01-01.02-B
MODE: DOCUMENT_FIX_AND_NEXT_DRAFT_OFFLINE
Steps: 01.01 fix + 01.02 business rules draft
Base commit: managerning jonli promptidagi SHA va delta TASK_INPUT.json.
Project root: eduerp-v2/

## Kirish va ortiqcha takrorni cheklash
Agar oldingi input ZIP shu muhitda bo‘lsa uni qayta ochmang yoki hammasini qayta o‘qimang. Delta paketdagi o‘zgargan qoidalarni qo‘llang. Oldingi to‘rtta candidate natijangiz ishchi papkada saqlansin. Yangi sessiya bo‘lsa ARGON_01.01_FIX_01_INPUT.zipni ochib, so‘ng batch deltani ustidan qo‘ying. Oldingi natija yetishmasa uni uydirmang.

Hozir o‘qish: 09_BATCH_POLICY, state/ACTIVE_TASK, state/ARGON_LEARNING, reviews/01.01-A. 01.02 uchun prompts/S01/02.md va 05_DOMAIN_RULESni tekshiring. Manbaning faqat tegishli bo‘limlariga qayting: PDF4–5 (4.1–4.6), PDF3 (rollar), PDF8 (substitute). Zarur aniq qoida uchun 02_DECISIONS va source matni ustuvor.

## A. 01.01ni tuzatish
F01–F05ni to‘liq yoping; ishning to‘g‘ri qismini boshidan yozmang. Har permissionda PDF/engineering/OPEN qarori tushunarli bo‘lsin; noaniq huquqni o‘zingiz tasdiqlamang. Explicit scope anchorlar, haqiqiy CSV locatorlari, R22.04 video PDF8, PDF A–C vs taklif D, Teacher raw phone chegarasi, RPO24 soat/RTO60 daqiqa PROPOSED tuzatilsin.
119 ID va7 CSV ustuni saqlansin. Anchor existence va source-page/section mosligini tekshiring; ID soni semantic coverage isboti emas. F01–F05 → changed location → actual check jadvali verificationda bo‘lsin. Source mappingdan meros xato bo‘lsa upstream correction deb qayd eting; planning registrini o‘zgartirmang.

## B. 01.02 biznes qoidalari loyihasi
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

## C. Paketni tekshirish va topshirish
Faqat quyidagi7 hujjat + SUBMISSION.json:
1 docs/spec/scope.md
2 docs/spec/scope-traceability.csv
3 docs/verification/01.01.md
4 planning/state/steps/01.01.md
5 docs/spec/business-rules.md
6 docs/verification/01.02.md
7 planning/state/steps/01.02.md
8 SUBMISSION.json

01.02 verificationda: case ID→BR-ID→policy status→expected→actual arithmetic/doc check; test buyruqlari qayta bajariladigan ko‘rinishda. Semantic approval bo‘lmasa uni arifmetika PASSi bilan almashtirmang. Step hisobotlari IN_REVIEW; Argon manager nomidan APPROVED qo‘ymaydi. 01.01 fixdan keyin01.02ga ta’sirini qisqa qayd eting. execution.json/CURRENT/TRACKER, canonical decisions va boshqa fayllarni o‘zgartirmang.

SUBMISSION.json: task_id, steps[01.01,01.02], base_commit, status=IN_REVIEW, files[path+sha256]; submission zip o‘zini manifestga kiritmaydi. Output: BATCH_01.01_01.02_B_SUBMISSION.zip, faqat8 fayl. ZIPda yo‘l project rootga nisbatan bo‘lsin. Qo‘shimcha original paket/manifests, secrets yoki real student data kirmasin.

Yakuniy chat ≤12 satr: task/status, yopilgan findinglar, yangi business rules/case soni, actual check summary, ochiq qarorlar soni, artifact link. Hujjatlarning to‘liq matnini chatda yana takrorlamang.

STOP: 01.03 yoki app kodiga o‘tish yo‘q. Muhim manba ziddiyati qolsa faqat unga bog‘liq qoidani OPEN qoldiring va sababini yozing. Limit yaqin bo‘lsa yangi mavzu boshlamang: tugagan ish va aniq qolgan qism checkpointi bilan qaytaring.
