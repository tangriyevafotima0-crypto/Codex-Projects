# Mahsulot egasining bevosita qarorlari

## OWNER-20261104-01 — xodim hisobini yaratish

- Holat: **ACCEPTED**, faqat quyida ko‘rsatilgan scope uchun.
- Manba: ushbu loyiha suhbatidagi foydalanuvchining 2026-11-04 javobi.
- Savol: “S05 uchun: yangi xodim hisobini kim yarata olsin?”
- Exact javob: **“Rahbar barcha rollarni, Admin faqat Teacherni”**.
- Qaror: Director/Rahbar DIRECTOR, ADMIN va TEACHER yaratishi mumkin. Admin faqat TEACHER yaratishi mumkin. Teacher xodim yaratmaydi.
- OPEN_RBAC_01 dagi create_staff qismi shu qaror bilan yopildi. Adminning staff role/status o‘zgartirish, deaktivatsiya, boshqa xodim sessionlarini revoke qilish yoki keng staff ro‘yxatini olish huquqi bu javobdan kelib chiqmaydi; alohida tasdiqqacha deny.
- OPEN_RBAC_02, OPEN_PRIVACY_01, channel va D01–D25 qarorlari bu javob bilan tasdiqlanmadi.
- S05 ijrochisi docs/spec/decisions.md, RBAC matrix, OpenAPI x-object-scope, semantic checker va executable testlarni aynan shu scopega moslashtiradi. Eski hujjatdagi “hech qanday biznes qarori ACCEPTED emas” matni endi tarixiy holat, joriy create_staff qarori uchun ustuvor emas.
- Bu initial production Director seed qilish, parolni chatga chiqarish yoki Vendor MFA implementatsiyasiga ruxsat emas.
