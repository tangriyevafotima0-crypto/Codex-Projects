# Foydalanuvchining doimiy loyiha afzalliklari
Qayd sanasi: 2026-11-04. Manba: shu loyiha chatidagi user ko‘rsatmalari.

1. Codex menejer/reviewer, Argon ijrochi. Userga har safar ko‘chirishga tayyor bitta prompt va bitta mustaqil ZIP beriladi.
2. Har topshiriqda ko‘proq bog‘liq ish tugatilsin: hujjatlarda odatda butun stage; implementatsiyada ishlaydigan, tekshiriladigan funksiya oqimi. Barcha katta ishni sun’iy ravishda bitta faylga bo‘lish kerak emas.
3. Oldingi lokal tuzatishlar keyingi mos ish paketiga qo‘shilsin. Muhim xato avval tekshirilsin; mustaqil draftlar davom etishi mumkin. Managerning oraliq javobi faqat paketdan tashqariga chiqish uchun kerak.
4. Argonning haqiqiy xato patternlari har reviewdan keyin ARGON_LEARNING.mdga yozilsin. Keyingi promptda aynan kuzatilgan xatoga qarshi qisqa talab yoki tekshiruv bo‘lsin. Bir martalik kuzatuvni statistik model zaifligi deb e’lon qilmaslik kerak.
5. Input/output token isrofi kamaytirilsin: to‘g‘ri ishni qayta yaratmaslik, relevant source, umumiy checker, qisqa chat yakuni, hujjat matnini chatda takrorlamaslik. Paket kattaligi o‘zi sifat yoki tezlik o‘lchovi emas.
6. GitHubda bosqichma-bosqich yig‘ilsin: kelgan artifact review branchida saqlanadi; manager review/qaror/main holati aniq yoziladi. Candidate mavjudligi approval yoki ishlab turgan mahsulot degani emas.
7. Har reviewdan keyin navbatdagi katta paket taklif qilinsin/tayyorlansin; real to‘siq faqat ta’sirlangan qismni to‘xtatsin.
8. Progress bayonoti dalilga tayansin. Fayl/ID count, ishlagan arifmetika, executable checker, semantic review va runtime test bir xil narsa emas.
9. Muddat va paket soni kafolat emas. Asosiy paket soni, rework va tashqi dependencylar alohida hisoblanadi.

## Joriy rejalashtirish modeli
24 stage /120 ichki step saqlanadi. Joriy topshiriq S01 fix +S02 full draft. S02..S24 bo‘yicha23 asosiy stage-paket qolgan deb hisoblash mumkin; S01 fix joriy paket ichida. Bu stage boshiga1 paket taxmini, o‘lchangan unumdorlik emas.

Ideal: taxminan23–25 yuborish/qabul sikli — bir stage bir paket,0–2 alohida qayta topshirish.
Amaliy rejalashtirish: taxminan28–35 sikl —23 asosiy paket+5–12 qayta ish yoki katta stage bo‘linishi.
Salbiy ssenariy:45–65+ sikl —22–42+ qo‘shimcha qayta topshirish/scope yoki muhit muammosi.
Matematik worst-case chegaralanmagan: user qarori, access, toolchain yoki production muammosi ishni tashqi sabab bilan to‘xtatishi mumkin. Yuqoridagi45–65 optimistik kafolat emas, stress scenario.

S24 real onboarding/pilotdagi1–3 oylik kuzatuvni o‘z ichiga oladi. Uni promptlar sonini kamaytirish bilan tugatib bo‘lmaydi. “Demo/release-ready mahsulot” va “real pilot sign-off” yakuni farqlanadi. Birinchi runtime bosqichlaridan so‘ng (S03–S05) ushbu baho haqiqiy natijaga qarab yangilanadi.

## S03 qabulidan keyingi yangilanish — 2026-11-04
S01, S02 va manager tuzatgan S03 qabul qilindi. Navbatdagi paket S04FULL-F; S04–S24 uchun 21 asosiy stage-paket qoladi. Avvalgi 23 paket hisob-kitobi o‘sha paytdagi holat edi. Hozir ideal 21–23, amaliy 26–33, salbiy 43–63+ almashinuv taxmini; o‘lchangan kafolat emas. Real pilot muddati va tashqi dependencylar saqlanadi.

## S04-F reviewdan keyin
F01–F10 closure va S05 full candidate bitta S04FIX-S05FULL-G paketga birlashtirildi. CriticalDBxatolarAPPROVEDemas; nextscopeexplicitdraft/IN_REVIEW. Main product source approvedS03, candidateS04reviewbranchda. Owner AdminfaqatTeachercreateqarorini bevosita berdi.

G reviewdan keyin navbatdagi katta paket:S04S05FIX-S06FULL-H. G01–G07fix+S06fullcandidate. Mechanicalcompilefixmanagertomonidaninputgaqo‘shilgan;authsemanticfixArgonda. Tasdiqlangan15/120step o‘zgarmagan, G1DB17testsPASS alohida progress sifatida qayd etiladi.
