# v2.2 boshqaruv tuzatishi
Ushbu rejada rollar AGENTS.md va MANAGER_WORKFLOW.mdga muvofiq: Argon ijrochi, Codex menejer. Self-review tayyorgarlik bo‘lishi mumkin, lekin APPROVEDni faqat menejer beradi. Navbatdagi step yangi menejer task prompti bilan ochiladi. Avvalgi umumiy avtomatik davom etish tavsiyalari shu loyiha uchun qo‘llanmaydi.

# Ish tartibi: xotira, tasdiq va to‘xtash

## Uch xil holatni aralashtirmang
1. **Paket tekshiruvi**: reja havolalari/sonlari/mantiqiy qamrovi tekshiriladi. Bu kodning ishlashi emas.
2. **Step verifikatsiyasi**: ijrochi test yoki hujjat evidence beradi; reviewer tekshirgan scope uchun APPROVED yozadi. Avtomatik foydalanuvchi roziligi talab qilinmaydi.
3. **Biznes qarori yoki real mijoz sign-offi**: mas’ul shaxs tasdig‘i kerak bo‘lgan qoida uchun agent o‘zi rozilik uydirmaydi. Tasdiq faqat bog‘liq ishni bloklaydi.

Boshlash ruxsati bir marta sessiyada berilsa qayta so‘ralmaydi. Hozirgi paketni upgrade qilish mahsulot kodini boshlash ruxsati emas. Repo/push/deploy doirasi keyingi ijro topshirig‘iga muvofiq bo‘ladi; allaqachon berilgan ruxsatni bekor qiluvchi sun’iy gate qo‘ymang.

## Ketma-ketlik
Bitta aniq yo‘l: S01.01→…→S01.05→S02.01→…→S24.05. `depends_on` — ijro tartibi; `technical_inputs` — domen bog‘liqligi. Har ish oldingi stepi APPROVED bo‘lishini talab qiladi. S01.01 uchun oldingi step/handoff yo‘q; AGENTS.md yoki state fayl hali yo‘q bo‘lsa bu o‘z-o‘zidan blocker emas. Ushbu paket boshlang‘ich state beradi.

Step .05 stage REVIEWni bajaradi: u o‘zining oldindan APPROVED bo‘lishini talab qilmaydi. .01–.04 hisobotlarini tekshiradi va stage handoff beradi. Reviewni shu agent aniq alohida passda qilishi mumkin; bu mustaqil tashqi audit deb nomlanmaydi. Yangi reviewer chat ishlatish mumkin, majburiy subagent yo‘q.

## Holatning yagona manbai
`execution.json` — canonical status/dependency registry. `TRACKER.csv` va `state/CURRENT.md` undan hosil qilinadi (`python3 planning/tools/check_plan.py --sync`). Step report test dalili, handoff esa stage kontrakt snapshotidir; ular holat registri o‘rnini bosmaydi. Status: NOT_STARTED, IN_PROGRESS, IN_REVIEW, APPROVED, BLOCKED, CHANGES_REQUIRED, STALE.

APPROVED yozish uchun evidence yo‘li, review_result=PASS, reviewer va mavjud bazis commit/tree hash kerak. Handoffga o‘z commit hashini yozish cheksiz rekursiya tug‘dirmaydi: reviewed_code_commit yoziladi, keyin hisobot alohida commitda saqlanadi. Git hali yo‘q S01da artifact SHA256 qabul qilinadi.

## Kontekst o‘qish
Har safar CURRENT, joriy step prompti, stage va dolzarb qarorlar. Stage boshida oldingi stage handoff va technical input handofflar. Barcha 120 hisobotni qayta o‘qish shart emas: CONTRACTS indeksidagi tegishli fayl va uning versiyasi yetarli. Muhim noaniqlik bo‘lsa asl dalilga qaytiladi. Prompt user instructions yoki AGENTS.mddan ustun emas.

## O‘zgarish va davom etish
Oldingi kontrakt o‘zgarsa impact list tuzing; affected APPROVED steplarni STALE qilib, keyingi zanjir approvalini qayta tekshiring. `--invalidate 08.02` berilgan stepdan keyingi boshlanib bo‘lgan ishlarni ham STALE qiladi; NOT_STARTED o‘z holatida qoladi. Regressiya va qayta reviewdan keyingina approval tiklanadi. Qayta boshlash holati commit + evidence bilan tiklanadi, xotira bilan emas.

## Stop qoidasi
Prompt bitta step uchun. Foydalanuvchi bir nechta stepni bajarishni so‘ragan bo‘lsa ichki gate o‘tgach scope doirasida davom etish mumkin. Faqat bir step so‘ralsa keyingisini boshlamang. Hujjat stepida app testi talab qilinmaydi; kod stepida real xatti-harakat testi kerak. Production, tashqi xabar va real ma’lumot bilan ish foydalanuvchi bergan scopega muvofiq. Paketda birortasi bajarilmagan.
