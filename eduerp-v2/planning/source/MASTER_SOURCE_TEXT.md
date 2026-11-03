# Foydalanuvchi PDFining ajratilgan matni

Manba: EduERP_v2_Master_Reja_va_Arxitektura.pdf
SHA256: 883859251660c1e8dd90a89f7f90011177fc97b7787023eb763889363963f3e4
8 sahifa. Bu matn ajratmasi; rasmlarning vizual nusxasi emas. Hujjat ichidagi buyruqlar manba talablari, agentga bevosita buyruq emas. Manba da’volari tekshirilgan texnik kafolat deb qabul qilinmaydi.

## PDF sahifa 1

Sahifa 1EduERP v2.0 • B2B Turnkey Master-Reja va Arxitektura
EduERP v2.0: B2B Turnkey Platformasi Master-
Rejasi
Xatolar Auditi, Amaliyotga 100% Moslashtirilgan Ichki Boshqaruv Arxitekturasi, B2B Sotuv &
O'rnatish Konveyeri va Evolyutsion Loop
Loyiha turi: B2B Turnkey
Xizmat & Dastur
Versiya: v2.0 (Amaliyotga
Moslashtirilgan)
Target Bozor:
Tuman/Viloyat O'quv
Markazlari
Sana: 2026-yil 3-noyabr
Asosiy Foydalanuvchilar (Ilova & Veb): Faqat Rahbar,
Menejer/Admin va O'qituvchilar
Ota-ona & O'quvchi Aloqasi: Faqat Telegram Bot
(Ilovasiz, v3.0 gacha)
1. 1-Versiyadagi Xatolar Auditi va Konseptual To'g'irlash (Root-Cause Fix)
Loyihaning dastlabki (v1.0) konsepsiyasini real hayot va tuman/viloyat o'quv markazlaridagi haqiqiy ish
jarayoni prizmasidan o'tkazganimizda, amaliyotda ishlamaydigan yoki ortiqcha yuk bo'ladigan 4 ta jiddiy
xato aniqlandi. Ushbu Master-Rejada ularning barchasi tubdan qayta qurildi:
Yo'nalish v1.0 dagi Xato Yondashuv (Nima uchun
samarasiz?)
v2.0 dagi Aniq Amaliy Yechim (100%
Efektiv)
1. Mobil Ilova
Auditoriyasi
Ilovadan ota-onalar va o'quvchilar ham
foydalanishi nazarda tutilgan edi.
Amaliyotda ota-onalar telefoniga
qo'shimcha ilova o'rnatmaydi, parolni
unutadi va bu markaz ma'muriyatiga
ortiqcha muammo tug'diradi.
100% Staff-Only Ilova: Mobil ilova va Veb-
sayt faqat va faqat markazning Boshlig'i
(Direktor), Menejeri (Admin) va
O'qituvchilari uchun xizmat qiladi. Ota-ona
va o'quvchilarga hech qanday ilova
berilmaydi — ularga faqat Telegram Bot
orqali avto-xabar boradi (O'quvchi ilovasi
uzoq kelajakdagi v3.0 ga qoldirildi).
2. Biznes Model va
Alohida O'rnatish
Barcha markazlarni bitta umumiy tizimda
(aralash) tasavvur qilish. O'quv markazi
rahbarlari o'z moliyasi va talabalar bazasi
begona markazlar bilan bitta joyda
turishiga ishonmaydi.
Izolyatsiyalangan B2B Turnkey (Har bir
markazga alohida): Tuman va qo'shni
tumanlardagi har bir mijoz (4-5 ta va undan
ko'p o'quv markazi) uchun alohida
ma'lumotlar bazasi, alohida
domen/server muhiti va alohida Telegram
Bot 10 daqiqada avtomatik ko'tarib beriladi.
3. Ortiqcha Og'ir
Texnologiyalar
Murakkab Kubernetes klasterlari va og'ir
CRDT algoritmlari kiritilgan edi. Bu bitta
dasturchi/jamoa uchun server xarajatini
oshiradi va texnik xizmat ko'rsatishni
qiyinlashtiradi.
Tejamkor va Temirdek Mustahkam Docker
Arxitekturasi: Oddiy, arzon VPS
serverlarda Docker Compose orqali har bir
o'quv markazini izolyatsiyalangan
konteynerda yuritish. Server xarajati
minimal, tezligi maksimal, boshqaruvi 100%
sizning qo'lingizda.

## PDF sahifa 2

Sahifa 2EduERP v2.0 • B2B Turnkey Master-Reja va Arxitektura
Yo'nalish v1.0 dagi Xato Yondashuv (Nima uchun
samarasiz?)
v2.0 dagi Aniq Amaliy Yechim (100%
Efektiv)
4. Excel
Sinxronizatsiya
Tartibsizligi
"Har qanday Excel faylni yuklasa tizim
o'zi tushunib oladi" degan xomxayol.
Amaliyotda admin bitta ustunni siljitib
qo'ysa yoki ismni boshqacha yozsa,
baza buziladi.
Qulflangan Shablon (Locked Excel
Template) + Validator: Tizimning o'zi
maxsus himoyalangan Excel shablon
beradi. Admin uni to'ldirib yuklaganda,
tizim avval qizil/yashil tekshiruv jadvalini
ko'rsatadi va xatosiz bo'lsagina qabul
qiladi.
2. B2B Sotuv, "Tayyor Zavod" Ko'rgazmasi va 1-Buyruq Bilan O'rnatish
Sizning asosiy maqsadingiz — tumaningizdagi va boshqa tumanlardagi o'quv markazlari rahbarlariga borib,
og'zaki va'da emas, balki 100% tayyor ishlab turgan mahsulotni ("kimyoviy zavodda tayyorlangan tayyor
tizimni") jonli ko'rsatish, kelishilgan narxga sotish, o'rnatib berish va 1–3 oy davomida ularga boshqaruvni
o'rgatib, amaliyotdagi muammolarni sayqallab borishdir.
1-rasm: Har bir o'quv markazi uchun alohida izolyatsiyalangan B2B arxitektura va xodimlar/ota-onalar kanali ajratilishi
2.1. Uchrashuvda Mijozni Rom Qiluvchi "Jonli Demo" (Sales Demo Pack)
O'quv markazi rahbari oldiga borganda tizim bo'sh bo'lmasligi shart. Sizning noutbukingiz va telefoningizda
"Namuna Akademiyasi" (Demo Markaz) tayyor turadi:
Tayyor Jonli Baza: Ichida 240 nafar o'quvchi, 14 ta guruh (Ingliz tili, Matematika, Kimyo, IT), 6 nafar
o'qituvchi, 50% chegirmali o'quvchilar, bepul (grant) o'quvchilar va qarzdorlar ro'yxati tayyor kiritilgan
bo'ladi.
3 Daqiqalik Jonli Fokus (Wow-Effect): Uchrashuv vaqtida o'quv markazi rahbariga: "Telefoningizdan
mana bu Demo Telegram botga Start bosing" deysiz. U bosishi bilan siz o'z telefoningizdagi O'qituvchi
ilovasidan uning "virtual farzandini" darsga kelmadi deb belgilaysiz va Admin panelidan 400,000 so'm

## PDF sahifa 3

Sahifa 3EduERP v2.0 • B2B Turnkey Master-Reja va Arxitektura
to'lov qabul qilasiz. 1 soniya ichida rahbarning telefoniga rasmiy elektron kvitansiya va davomat xabari
kelib tushadi. Bu har qanday rahbarni darhol sotib olishga undaydigan eng kuchli amaliy isbotdir.
2.2. Har Bir Mijoz Uchun Alohida Server/Konteyner va Bot Ochish (Auto-Provisioning)
Mijoz bilan narx kelishilib, oldindan to'lov olingach, siz har bir markaz uchun 3 kunlab kod yozib o'tirmaysiz.
Maxsus tayyorlangan avtomatlashtirish skripti (deploy_center.sh) quyidagi ishlarni 5 daqiqada bajaradi:
 Mijoz uchun alohida ma'lumotlar bazasi (masalan: db_guliston_ilm) va alohida fayllar papkasini
yaratadi.
 BotFather orqali shu o'quv markazi nomi va logotipi bilan ochilgan yangi Telegram Bot tokenini (masalan:
@GulistonIlm_Bot) shu bazaga bog'laydi.
 Markazga maxsus veb-manzil (masalan: guliston-ilm.eduerp.uz) va SSL xavfsizlik sertifikatini
biriktiradi.
 Rahbar va Menejer uchun boshlang'ich Login/Parolni generatsiya qilib beradi.
Moliya va Litsenziya Himoyasi (Subscription Kill-Switch): Agar o'quv markazi siz bilan kelishilgan oylik
texnik xizmat to'lovini yoki shartnoma summasini vaqtida to'lamasa, siz o'z markaziy Vendor panelingizdan
bitta tugma bilan markaz tizimini "Faqat o'qish" (Read-Only) rejimiga o'tkazib qo'ya olasiz (ma'lumotlar
o'chmaydi, lekin yangi to'lov/davomat kiritish uchun obunani uzaytirish so'raladi).
3. Foydalanuvchi Rollari va Interfeyslar (100% Faqat Xodimlar Uchun)
Tizimda ortiqcha murakkablik yo'q. Har bir xodim faqat o'z vazifasiga kerakli ekranni ko'radi:
Rol Nomi Ishlatadigan
Qurilmasi
Aniq Vakolatlari va Kunlik Qiladigan Ishlari
1. Markaz Rahbari
(Direktor / Ega)
Mobil Ilova (Staff App)
+ Veb-Sayt + Rahbar
Bot
• Kunlik, haftalik va oylik kassa tushumini real-vaqtda ko'rish;
• Qarzdorlar umumiy summasi va kutilayotgan tushum prognozi;
• 50% chegirma va 100% bepul (grant) o'quvchilarni tasdiqlash;
• O'qituvchilarning davomat intizomi va hisoblangan oylik
maoshlari;
• Ketgan o'quvchilar (Churn) soni va sabablari tahlili;
• Xavfsizlik Auditi: Admin tomonidan o'zgartirilgan yoki bekor
qilingan har bir to'lov haqida darhol Telegramga qizil
ogohlantirish olish.
2. Boshqaruvchi
Menejer (Admin /
Kassir)
Kompyuter Veb-Sayt
+ Excel + Mobil Ilova
• Yangi kelgan o'quvchini 15 soniyada ro'yxatga olish va
guruhga qo'shish;
• Naqd, karta (Click/Payme/Perechisleniye) to'lovlarni qabul
qilish va chek chiqarish;
• Qarzdorlar ro'yxati bilan ishlash (qo'ng'iroq qilish va to'lov
va'da sanasini belgilash);
• Kompyuterdagi Excel shablon orqali ommaviy davomat va
ro'yxatlarni yuklash/yuklab olish;
• Kechqurun kassa smenasini yopish va kunlik hisobotni
Rahbarga topshirish.

## PDF sahifa 4

Sahifa 4EduERP v2.0 • B2B Turnkey Master-Reja va Arxitektura
Rol Nomi Ishlatadigan
Qurilmasi
Aniq Vakolatlari va Kunlik Qiladigan Ishlari
3. O'qituvchi
(Teacher)
Mobil Ilova (Staff App)
yoki Mobil Veb
• Faqat o'ziga biriktirilgan guruhlar va dars jadvalini ko'rish;
• Dars boshlanganda 30 soniya ichida davomat belgilash
(standart hamma "Keldi" turadi, faqat kelmagan o'quvchi ustiga
1 marta bosiladi);
• O'quvchilarning imtihon ballari yoki qisqa izohni kiritish;
• Cheklov: O'qituvchi markazning umumiy pulini, boshqa
guruhlarni va ota-onalarning shaxsiy telefon raqamlarini ko'chira
olmaydi (bazani o'g'irlashdan himoya).
4. Tashqi Kanal
(Ota-ona &
O'quvchi)
Faqat Telegram Bot
(Ilova yo'q!)
• Ota-ona botga kirib, markazda ro'yxatdan o'tgan telefon
raqamini 1 marta tasdiqlaydi;
• Farzandi darsga kelmaganda yoki kechikkanda avto-xabar
oladi;
• To'lov qilinganda elektron kvitansiya va keyingi to'lov sanasini
oladi;
• Botdagi "Balans va Davomat" tugmasini bosib, farzandining
davomati va qarzini ko'radi.
4. Amaliyotda Yuzaga Chiqadigan Eng Mayda Detallar va Yechimlar (Real-
World Edge Cases)
Dastur qog'ozda chiroyli ko'rinib, amaliyotga kirganda "qotib" qolmasligi uchun tuman o'quv markazlarida har
kuni uchraydigan 8 ta eng nozik hayotiy holat algoritmga oldindan kiritiladi:
4.1. Oyning O'rtasida Kelgan O'quvchi Hisob-Kitobi (Mid-Month Enrollment)
O'quv markazlarida o'quvchi har doim ham oyning 1-sanasida kelmaydi. Masalan, 12-noyabrda kelib guruhga
qo'shiladi. Tizimda markaz qoidasiga qarab 2 xil hisoblash rejimi bo'ladi (sozlamalardan tanlanadi):
A-Rejim (Kalendar Oy + Pro-Rata): Hamma o'quvchilar har oyning 1-sanasida to'lov qiladi. 12-noyabrda
kelgan o'quvchiga tizim noyabr oyida qolgan 7 ta dars uchun avtomatik proporsional summani (masalan,
480,000 so'm o'rniga 280,000 so'm) hisoblab beradi. 1-dekabrdan boshlab to'liq oylik yoziladi.
B-Rejim (Individual 12 ta Dars / Abonement): O'quvchi 12-noyabrda to'lov qilsa, keyingi to'lov muddati
aniq 12-dekabr (yoki 12 ta dars tugaydigan kun) etib belgilanadi.
4.2. Sinov Darsi (Trial Lesson) Mantiqi
Yangi kelgan o'quvchi 1-darsga "Sinov" (Trial) statusida kiradi. Bu dars uchun unga qarz yozilmaydi. Agar 2-
darsga ham kelsa va o'qituvchi uni davomatda "Keldi" qilsa, tizim avtomatik ravishda o'quvchini "Faol"
statusiga o'tkazadi va 1-darsdan boshlab oylik to'lovni hisoblaydi. Agar 1-darsdan keyin kelmasa, Adminga
"Sinov darsidan keyin qaytib kelmadi — qo'ng'iroq qilib sababini so'rang" vazifasi tushadi.
4.3. Chegirmalar (50%, Oilaviy) va 100% Bepul (Grant) O'quvchilar
Bir nechta kursda o'qiydigan yoki oilaviy o'quvchilar: Bitta ota-onaning telefon raqamiga 2 yoki 3 nafar
farzand biriktirilsa, tizim avtomatik ravishda "Oilaviy chegirma" (masalan, 10% yoki 50,000 so'm) taklif
qiladi.
50% Maxsus chegirma va 100% Bepul talabalar: Har bir bunday talabaga "Chegirma sababi" va "Amal
qilish muddati" kiritiladi. Eng muhimi — Admin o'zboshimchalik bilan tanish-bilishiga chegirma yoza
olmaydi: Admin chegirma kiritishi bilan Rahbarning ilovasiga va Telegram botiga "Admin Фалончиевга

## PDF sahifa 5

Sahifa 5EduERP v2.0 • B2B Turnkey Master-Reja va Arxitektura
50% chegirma bermoqchi. Tasdiqlaysizmi?" degan tugma boradi. Rahbar tasdiqlamaguncha chegirma
kuchga kirmaydi!
4.4. Qisman To'lov (Bo'lib To'lash), Qarz va "Va'da Sanasi" (Promise-to-Pay)
Tuman sharoitida ko'p ota-onalar kurs pulini birdaniga emas, ikkiga bo'lib beradi (masalan, 500,000 so'mdan
hozir 300,000 so'm berib, "qolgan 200,000 so'mni oylik chiqqanda, 15-sana kuni beraman" deydi).
Tizimda to'lov kiritilayotganda qarz qolsa, Admin majburiy ravishda "Qolgan qismini to'lash va'da
sanasi"ni belgilaydi.
O'sha va'da qilingan sana (masalan, 15-noyabr) ertalab soat 09:00 da tizim avtomatik ravishda ham
Adminga, ham ota-onaning Telegram botiga muloyim eslatma yuboradi.
4.5. Kassadagi Xatolar va Firibgarlikdan 100% Himoya (Anti-Fraud Cash Control)
O'quv markazi rahbarlarining eng katta og'rig'i — kassadagi pulning yo'qolishi yoki Admin to'lovni olib,
bazadan o'chirib yuborishidir. Tizim buni temir qoida bilan yopadi:
O'chirish Taqiqlanadi (Immutable Ledger): Bazaga kiritilgan to'lovni Admin ham, hech kim ham o'chira
olmaydi.
Xatoni To'g'irlash (Storno / Refund): Agar Admin rostdan ham adashib 400,000 so'm o'rniga 4,000,000
so'm yozib yuborgan bo'lsa, u "Tuzatish so'rovi" tugmasini bosib, sababini yozadi. Bu darhol Rahbarga
boradi va tarixda qizil yozuv bilan qoladi.
Kechki Kassa Topshirish (Smena Yopish): Har kuni kechqurun Admin "Smenani yopish" tugmasini
bosadi. Tizim: "Bugun Naqd: 3,200,000 so'm, Plastik/Click: 1,800,000 so'm, Xarajat: 150,000 so'm.
Kassada qolishi kerak: 3,050,000 so'm" deb Rahbarga hisobot yuboradi.
4.6. Dars Qoldirish, Muzlatish (Freeze) va Ketgan O'quvchilar (Drop-out)
Sababli va Sababsiz Qoldirish: Agar o'quvchi shunchaki darsga kelmasa, puli kuyadi (qayta
hisoblanmaydi). Agar kasalligi haqida ma'lumotnoma keltirsa yoki oldindan ogohlantirib 2 haftaga
muzlatsa, Admin "Muzlatish" (Freeze) qiladi va o'sha kunlarning puli keyingi oyga o'tadi.
Ketganlar (Churn) Tahlili: O'quvchi guruhdan chiqayotganda tizim Admin oldiga 5 ta aniq sababdan birini
tanlash shartini qo'yadi: 1) To'lovga qiynaldi, 2) O'qituvchi yoqmadi, 3) Vaqti to'g'ri kelmadi, 4) Boshqa
markazga o'tdi, 5) Kursni tugatdi / Ko'chib ketdi. Oy oxirida Rahbar qaysi o'qituvchidan ko'p o'quvchi
ketayotganini aniq raqamda ko'radi.
5. 4-Tomonlama Uzviy Integratsiya: Veb + Ilova + Excel + Bot
Siz ta'kidlaganingizdek, umumiy kompyuterdagi Excel, Veb-sayt, Xodimlar mobil ilovasi va Telegram bot bir-
biri bilan adashib ketmasdan, soatdek aniq algoritm asosida ishlashi shart:
Komponent Asosiy Vazifasi va Ma'lumot Kiritish Sinxronizatsiya va Adashmaslik
Qoidasi
1. Markaziy Server
(Yagona Haqiqat
Manbai)
PostgreSQL bazasi. Barcha hisob-
kitoblar, qarzlar va tarix faqat shu yerda
yakuniy tasdiqdan o'tadi.
Har bir yozuvga yagona UUID va
version raqami beriladi. Hech bir
qurilma server ruxsatisiz balansni
o'zgartira olmaydi.

## PDF sahifa 6

Sahifa 6EduERP v2.0 • B2B Turnkey Master-Reja va Arxitektura
Komponent Asosiy Vazifasi va Ma'lumot Kiritish Sinxronizatsiya va Adashmaslik
Qoidasi
2. Kompyuter Excel
Shablon
Ommaviy talabalar ro'yxatini kiritish,
oylik davomat jadvalini kompyuterda
ko'rish/to'ldirish va buxgalteriya uchun
yuklab olish.
Qat'iy Shablon Qoidasi: Tizimdan yuklab
olingan Excel faylning 1-ustunida
yashirin student_id bo'ladi. Qayta
yuklanganda tizim ismga qarab emas
(chunki ismda harf xatosi bo'lishi
mumkin), aynan student_id ga qarab
xatosiz moslaydi.
3. Staff Mobil Ilova
(Oflayn Rejim bilan)
O'qituvchilar sinfda internet past
bo'lganda ham davomat olishi va Rahbar
telefonda hisobot ko'rishi.
Oflayn paytda davomat telefon
xotirasiga (SQLite) tushadi. Internet
yonishi bilan group_id + student_id
+ date kaliti bo'yicha serverga yoziladi.
Agar shu kun uchun o'qituvchi ilovada
belgilagan bo'lsa, kechikib yuklangan
eski Excel fayl o'qituvchi davomatini
buzib yubormaydi!
4. Telegram Bot (Ota-
ona & Rahbar)
Bir tomonlama bildirishnoma va
interaktiv ma'lumot so'rash (balans,
jadval, kvitansiya).
Bot o'zi bazani o'zgartirmaydi — u faqat
Markaziy Serverdagi tasdiqlangan
ma'lumotni o'qib, soniyasiga 25 ta xabar
tezligida (navbat bilan, bloklanmasdan)
ota-onalarga yetkazadi.
6. Bosqichma-Bosqich Ishlab Chiqish va 1–3 Oylik Amaliyotga Joriy Etish
Rejasi
Tizimni noldan eng yuqori darajaga olib chiqish, uni mijozlarga sotish va amaliyotda xatosiz ishlashini
ta'minlash uchun Versiyalangan Evolyutsiya va Feedback Loop strategiyasi qo'llaniladi (2-rasm):
2-rasm: EduERP tizimini versiyama-versiya kuchaytirish va 1–3 oylik amaliyot feedback sikli

## PDF sahifa 7

Sahifa 7EduERP v2.0 • B2B Turnkey Master-Reja va Arxitektura
6.1. Dasturni Qurish Ketma-Ketligi (Build Step-by-Step)
1-Qadam (Ma'lumotlar Bazasi va Backend Yadro — 1-2 hafta): PostgreSQL sxemasi, Foydalanuvchilar
(Rahbar, Admin, O'qituvchi), Talabalar, Guruhlar, Murakkab To'lov mantiqi (Pro-rata, 50% chegirma, Grant,
Qarz) va O'zgarmas Audit Log API larini yozish.
2-Qadam (Veb Boshqaruv Paneli va Excel Dvigateli — 3-4 hafta): Admin va Direktor uchun tezkor Veb-
sayt, 1-bosishda to'lov qabul qilish, Qulflangan Excel shablon generatori va import tekshiruvchisini (Dry-
Run Validator) qurish.
3-Qadam (Telegram Bot va Avto-Xabarnomalar — 5-hafta): Ota-onalarni telefon raqami orqali avto-
bog'lash, darsga kelmaganda va to'lov qilinganda chiroyli kvitansiya jo'natish hamda Rahbar uchun
kechki kassa hisoboti botini ulash.
4-Qadam (Xodimlar Mobil Ilovasi & Oflayn Rejim — 6-7 hafta): O'qituvchilar va Rahbar uchun Flutter
(yoki PWA) mobil ilovasi, oflayn davomat kiritish va foniy sinxronizatsiya.
5-Qadam ("Tayyor Zavod" Demo Bazasi va 1-Buyruqli O'rnatish Skripti — 8-hafta): Mijozlarga
ko'rsatish uchun 250 talabali Demo markazni to'ldirish va yangi mijozni 5 daqiqada ko'tarib beruvchi
Docker skriptini yakunlash.
6.2. Mijozga O'rnatib Berish va 1–3 Oylik O'rgatish Protokoli (Onboarding Playbook)
Siz o'quv markazi bilan kelishib, pulni olganingizdan keyin qiladigan aniq qadamlaringiz:
 1–3 Kunlar (Tozalash va Ko'chirish): Markazning eski qog'oz daftarlari yoki tarqoq Excel fayllarini olib,
maxsus shablon orqali 1 kunda tozalab, yangi bazaga kiritib berasiz. Markaz nomiga Telegram bot ochib
ulaysiz.
 4–7 Kunlar (Xodimlarni O'rgatish): Admin bilan 1 soat o'tirib, yangi o'quvchi qo'shish va to'lov olishni
o'rgatasiz. O'qituvchilarga 15 daqiqalik yig'ilishda telefonda davomat olishni ko'rsatasiz. Ota-onalarga
guruhlarda bot ssilkasini tarqatib, 80-90% ota-onani botga ulab berasiz.
 2–4 Haftalar (Ikki Tomonlama Tekshiruv): Birinchi oy davomida haftada 2 marta masofadan (yoki borib)
loglarni tekshirasiz: qaysi o'qituvchi davomatni kech kirityapti, Admin qayerga adashyapti. Chiqqan har
bir kichik noqulaylikni darhol kodda to'g'irlab borasiz.
 2–3 Oylar (To'liq Avtopilot va Qo'shni Markazlarga Kengayish): 1-oy yakunida tizim Rahbarga birinchi
aniq moliyaviy va o'qituvchi maoshi hisobotini chiqarib beradi. Rahbar natijadan mamnun bo'lgach, undan
tavsiya (keyingi o'quv markazlariga ko'rsatish uchun Case Study) olasiz va keyingi 4-5 ta markazga
o'rnatishni boshlaysiz.
7. Rejaning "Loop" Tahlili: Zaifliklarni Qayta Tekshirish va To'ldirish
Topshirig'ingizga binoan, tuzilgan ushbu rejaning o'zini tanqidiy ko'z bilan (Self-Correction Loop) qayta
tekshirib chiqdik: "Amaliyotda yana qayerda tizim oqsashi yoki sizga ortiqcha ish tug'dirishi mumkin?"
Quyidagi jadvalda ana shu yashirin xavflar va ularni tizim ichida oldindan yopib ketish yechimlari keltirilgan.
Ushbu sikl (Loop) har bir yangi o'quv markaziga o'rnatilganda quyidagi 4 bosqichli algoritm bo'yicha uzluksiz
takrorlanadi:
A-Bosqich (Real Kuzatuv): Dastlabki 14 kun ichida Admin va O'qituvchilarning har bir kechikkan yoki
xato kiritgan amali tizim loglaridan avtomatik saralab olinadi.
B-Bosqich (Interfeysni Soddalashtirish): Agar xodim biror tugmani topishga 5 soniyadan ko'p vaqt
sarflasa, keyingi kichik yangilanishda (Patch) o'sha tugma eng ko'rinarli joyga chiqariladi.

## PDF sahifa 8

Sahifa 8EduERP v2.0 • B2B Turnkey Master-Reja va Arxitektura
C-Bosqich (Avto-Himoya / Guardrail): Inson xatosi tufayli kelib chiqqan har qanday holat (masalan, bir
o'quvchini ikki marta kiritib qo'yish) telefon raqami va ism-sharif dublikatini tekshiruvchi kod orqali
butunlay bloklanadi.
Yashirin Amaliy Xavf
(Loop Tahlilda Topilgan)
Agar Oldi Olinmasa Nima Bo'ladi? Rejaga Kiritilgan Aniq Yechim (To'ldirish)
1-Loop: O'qituvchi
darsda davomat qilishni
unutib qo'yishi
O'qituvchi dars o'tib uyiga ketib
qoladi, davomat kiritilmaydi, ota-
onaga xabar bormaydi va tizim
ishonchsiz ko'rinadi.
Avto-Turtki (Teacher Ping): Dars
boshlanganidan 20 daqiqa o'tgach
davomat hali kiritilmagan bo'lsa, tizim
avtomatik ravishda O'qituvchining
telefoniga "Dars boshlandi, 30 soniyada
davomatni belgilang!" deb bildirishnoma
yuboradi. Dars tugaguncha ham kiritmasa,
Adminga xabar chiqadi.
2-Loop: Ota-ona
Telegram botni bloklab
qo'yishi yoki raqami
o'zgarishi
Markaz "xabar ketdi" deb o'ylaydi,
lekin ota-ona xabarni olmagan
bo'ladi.
Yetkazib Berish Statusi (Delivery
Tracking): Agar ota-ona botga ulanmagan
bo'lsa yoki botni bloklagan bo'lsa, talaba
profili yonida sariq belgi (Bot ulanmagan)
yonib turadi va Adminga "Ushbu 5 ta
qarzdor ota-onada bot yo'q, ularga telefon
qiling" deb alohida ro'yxat chiqaradi.
3-Loop: 5-10 ta o'quv
markazi sizga har kuni
mayda savollar bilan
telefon qilishi
Siz yangi markazlarga sotish va
dasturni rivojlantirish o'rniga, har kuni
adminlarga bir xil narsani tushuntirish
bilan band bo'lib qolasiz.
Ichki 1-Daqiqalik Video-Yordamchi (In-
App Micro-Guides): Har bir sahifaning
(To'lov olish, Excel yuklash, Guruh ochish)
tepasida ? Video qo'llanma (45 sek)
tugmasi bo'ladi. Yangi Admin kelsa ham
sizni bezovta qilmasdan videoni ko'rib
o'rganib oladi.
4-Loop: O'qituvchi kasal
bo'lib qolsa va boshqa
o'qituvchi darsga kirsa
(Zamena)
O'rindosh o'qituvchiga u guruh
ko'rinmaydi va oylik hisoblashda
chalkashlik bo'ladi.
1-Kunlik "O'rindosh O'qituvchi"
(Substitute Teacher) funksiyasi: Admin 1
ta tugma bilan bugungi darsni vaqtincha
boshqa o'qituvchiga biriktiradi. Davomat
huquqi va shu 1 kunlik dars haqi avtomatik
o'rindosh o'qituvchiga yoziladi.
5-Loop: Markaz
kompyuteri buzilib
qolishi yoki elektr
o'chishi
Kompyuterdagi Excel fayllar o'chib
ketsa, markaz sizdan ma'lumotlarni
tiklab berishni so'raydi.
Ikki Qatlamli Avto-Arxiv: Baza har kecha
nafaqat bulutga (Cloud), balki sizning
shaxsiy yopiq Telegram kanalingizga (har
bir markaz bo'yicha alohida shifrlangan
.sql.gz va .xlsx fayl sifatida) avtomatik
tashlab boriladi. 1 daqiqada istalgan kunni
tiklab bera olasiz!