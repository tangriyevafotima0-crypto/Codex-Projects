# Siz va ikkita yordamchi qanday ishlaysiz

## Oddiy sikl
1. Codex repo va task holatini o‘qiydi; sizga Argonga ko‘chirish uchun bitta tayyor prompt beradi.
2. Siz promptni Argonga berasiz. U ishni bajarib IN_REVIEW hisobot, commit va PR havolasini qaytaradi.
3. Siz shu chatga «Argon topshirdi: PR ...» deb yozasiz. GitHub connector faqat ruxsat berilgan repolarni o‘qiydi; Argon natijasini avtomatik kuzatish yoqilmagan.
4. Codex haqiqiy diff, acceptance va mavjud test dalilini tekshiradi. GitHubdan o‘qish testni lokal bajardim degani emas; bajarish imkoni bo‘lmasa CI evidence yoki Argon logi talabi aniq aytiladi.
5. Muammo bo‘lsa Codex FIX prompt beradi, Argon shu taskni tuzatadi. Muammo yopilsa Codex REVIEW-PASSni commitga bog‘laydi va navbatdagi task promptini beradi.

Har topshiriqda: TASK_ID, STEP_ID, MODE, BASE_COMMIT, BRANCH, ruxsat etilgan scope, acceptance, required evidence, STOP. Placeholderlar haqiqiy ijro taskida menejer tomonidan to‘ldiriladi. Commit o‘zgarsa approval eski kodga taalluqli, yangi diff qayta tekshiriladi.

## Menejerning har javobi
- Qaysi step va qaysi commit tekshirildi.
- Natija: boshlash / tuzatish / review pass / blocked.
- Topilmalar bo‘lsa issue ID va tekshirish usuli.
- Argonga yuboriladigan bitta tayyor prompt.
- Siz qaytarib yuboradigan dalil: PR/commit, test natijasi yoki biznes qarori.

## Davom etish xotirasi
execution.json — step holati. ACTIVE_TASK.md — kim nima qilmoqda, base commit va task scope. state/steps/ — dalillar. state/reviews/ — menejerning commitga bog‘langan qarori. CURRENT va TRACKER — generator hosil qiladigan ko‘rinishlar. Tekshiruvchining APPROVED yozuvi testning o‘zi emas.

Argon task boshida IN_PROGRESS, oxirida IN_REVIEW qo‘yishi mumkin. APPROVED/reviewer/review_resultni Codex boshqaradi. Argon .05 taskda review dalillarini tayyorlashi mumkin, lekin stagega yakuniy tasdiqni Codex beradi.

Yangi chat: «EduERP menejeri bo‘l. Repo .../Codex-Projects, project eduerp-v2. AGENTS, MANAGER_WORKFLOW, ACTIVE_TASK va execution.jsonni o‘qib real holatni tikla; faqat navbatdagi Argon promptini ber». Eski katta suhbatni to‘liq ko‘chirish shart emas.

## Argon imkoniyatini oldindan bilmaymiz
SETUP-00 uning repo o‘qish, branch/push/PR, terminal/test va framework imkoniyatini dalil bilan qayd qiladi. Limit sonlari taxmin qilinmaydi. GitHubi yo‘q bo‘lsa patch/file va command log orqali topshirish mumkin; Codex o‘zi ko‘rmagan natijani tasdiqlamaydi.

## Birinchi qadam
SETUP-00: repo/muhitni tekshirish. Mahsulot kodini yozmaydi; uning muvaffaqiyati S01.01ni bajarish ruxsati emas. User «qurishni boshlaymiz» degach Codex S01.01 topshirig‘ini beradi. Hozirgi buyurtma boshqaruv tartibini tayyorlash va repoga joylash.
