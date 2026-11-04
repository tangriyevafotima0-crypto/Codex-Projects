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


## OWNER-20261104-03 — birinchi to‘lov, yaxlitlash va qisqa oy

Holat: **ACCEPTED**, faqat quyidagi aniq scope. Manba: userning S07FIX-J review davomida bergan uch javobi.

1. Oy o‘rtasida kelgandagi birinchi to‘lov: **“Har markaz o‘zi tanlasin”**. Center policy qolgan darslarga mutanosib yoki to‘liq abonementni aniq tanlaydi. Ikkalasidan birini global majburiy default qilib olmang; policy tanlanmaganida hisob chiqarish bloklanadi.
2. Kasr so‘m: **“Eng yaqin butun so‘mga; 0.5 yuqoriga”**. Nonnegative charge uchun rational integer HALF_UP. UZS scale0 saqlanadi, float bilan hisoblanmaydi. Manfiy adjustmentning tie-sign qoidasi bu javob bilan alohida tasdiqlanmagan; adjustment amount nonnegative+differentiated direction yoki kelajak alohida policy.
3. Oylik sana31 keyingi qisqa oyda yo‘q bo‘lsa: **“Oxirgi kundan davom etsin”**. Anniversary/rolling renewalda Jan31→Feb28(yoki29)→Mar28(yoki29), eski31anchoriga avtomatik qaytmaydi. Chained renewalni original startdan qayta hisoblash bu qarorga zid. Fixed due-day markaz har oy aniq tanlagan sana bo‘lib, anniversary bilan aralashtirilmaydi; invalid fixed-day oyiga oid alohida biznes edgecase noaniq bo‘lsa confirmed policy talab qiling.

Bu uch javob OWNER-20261104-02ga qo‘shimcha. Service period, due-date va collection timing alohida qoladi. Birinchi partial-period proration uchun planned/remaining lesson definition, cancelled lesson policy, 12-dars paket, trial compensation, freeze/discount/refund va penalty/grace shu javoblar bilan to‘liq ACCEPTED bo‘lmadi. S08 aniq variantlarni typed/versioned center policy sifatida implement qiladi; tasdiqlanmagan combinationlarni silent taxmin qilmaydi. Docs/spec/decisions.md’dagi D03/D21ni butunlay ACCEPTED qilib yubormang.
