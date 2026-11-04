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

## OWNER-20261104-02 — har markazga mos abonement va to‘lov tartibi

Holat: **ACCEPTED_REQUIREMENT**, quyidagi aniq scope uchun. Manba: userning shu loyiha chatidagi 2026-11-04 javoblari.

- Markazlar turli tartibda ishlaydi; platforma bitta global majburiy abonement tartibini qo‘llamaydi. Center-level policy va zarur group override/version boundary bo‘lsin.
- Tasdiqlangan 1-variant misoli: “o‘quvchi 12-avgustda keldi. 12-sentyabrda to‘laydi”. Anniversary/rolling monthly due date, misolda birinchi to‘lov keyingi oyda. Bu misolni avtomatik oldindan to‘lovga aylantirmang.
- Tasdiqlangan 2-variant misoli: “o‘quv markaz talab qilgan sanada ... 12-avgustda keldi ... 15-sentyabrda oladi”. Center-fixed due day (misolda15), joining daydan alohida.
- User oldindan olish variantini ham talab qildi: center belgilagan sanada advance collection. Period boundary, due-date rule va advance/arrears timing alohida parametrlar; prepaymentni yangi billing period turi deb aralashtirmang.
- Hali ochiq: 2-variantda birinchi charge qaysi service periodni qoplashi va partial-period amount; oldindan variantning birinchi enrollmentdagi aniq misoli; 29/30/31→qisqa oy clamp/roll rule; transfer/withdraw/freeze/discount/refund va penalty/grace. Hech biri o‘z-o‘zidan ACCEPTED emas.
- 12-dars paketiga nisbatan bu javob qo‘llash/olib tashlash qarori emas; mavjud D21 alohida ochiq.
- D03/D21/D14/D22 butun qarorini yopmang: yuqoridagi configurable policy va due-date misollari aniq tasdiqlangan, pul formulasi qolgan qismlar bo‘yicha pending.
- S07 policy konfiguratsiyasi/typed boundaryda buni hisobga oladi; real billing engine va open formula clarification S08da. Hech qanday avtomatik late fee yoki access block shu javobdan kelib chiqmaydi.
