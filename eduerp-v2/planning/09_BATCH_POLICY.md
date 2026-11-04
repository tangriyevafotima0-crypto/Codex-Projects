# Moslashtiriladigan paket tartibi — user yangilanishi

## Maqsad
User katta hajmdagi Argon topshiriqlarini, tuzatish + keyingi ishni bitta yurishda bajarishni so‘radi. Manager bitta prompt ichida bir nechta stepni aniq sanab beradi; har biri uchun oraliq chat tasdig‘i talab qilinmaydi. Bitta paketdagi stepga o‘tish — yangi alohida promptni kutish qoidasining ruxsat etilgan istisnosi. Paketdan tashqariga chiqish yo‘q.

## Qanday paket tanlanadi
- Hujjat/izolyatsiyalangan UI: boshlang‘ich 2–4 bog‘liq step, hajm haqiqiy natijaga qarab moslanadi.
- Moliya, auth, DB migratsiya va production operatsiyalar: kichikroq, aniq atomik scope; xato sonidan tashqari ta’siri va bog‘liqligi baholanadi.
- 1–3 lokal P2/P3 topilma: fixni keyingi mos step bilan birlashtirish odatiy. Bu qattiq sonli threshold emas.
- P0/P1 yoki kontraktni o‘zgartiruvchi xato: avval paket ichida tuzatish+tegishli self-check. Keyingi mustaqil hujjat/draft davom etishi mumkin; xavfli implementatsiya isbotlanmagan taxminga qurilmaydi. Faqat ta’sirlangan qism bloklanadi.
- Tasdiqlanmagan biznes qoidasida alternativalar va raqamli PROPOSED misol yozish mumkin; bu qoidani ACCEPTED yoki executable default qilish emas.

## Draft bilan approvalni ajratish
Argon paket ichida ketma-ket ishlaydi: fix → local verify → next draft → cross-check → bitta submission. O‘z ishiga APPROVED qo‘ymaydi. Offline paketda execution.json/CURRENT/TRACKERni manager boshqaradi. Canonical step holati bilan yetib kelmagan draftning holati bir xil bo‘lishi shart emas. Candidate ishlar ACTIVE_TASKda aniq yoziladi.
Manager natijani ketma-ket ko‘radi: avval01.01, keyin01.02. Birinchi step o‘tmasa, unga bog‘liq ikkinchi natijaga yakuniy approval berilmaydi; mustaqil foydali qism saqlanadi. Tasdiq darhol merge/deploy degani emas.

## Tokenni tejash
- Har safar katta ZIP va PDFni qayta o‘qitmang. Bazis SHA, active task va relevant source section yetarli; noaniqlik bo‘lsa sourcega qaytiladi.
- Bir xil Argon chatida o‘zgargan qoidalar uchun kichik delta ZIP; yangi chat/muhitda full baseline kerak.
- Yetkaziladigan artifact to‘liq o‘zgargan fayllar; chat javobi ≤12 satr. Fayllar mazmunini chatda yana takrorlamang.
- Barcha stepga barcha test emas: o‘zgargan acceptance va ta’sirlangan regressiya. Oldingi dalil eski hash/commitga tegishli ekanini saqlang.
- Ishlayotgan to‘g‘ri hujjatni boshidan yozmang. Kerakli satr/bo‘limni tahrirlang. Haqiqiy qaror kerak bo‘lgan savollarni bir jadvalga yig‘ing.
- Vaqt/token limitiga yaqinlashsa yangi ish boshlamasdan mavjud ish+aniq checkpointni topshiring; tugamagan qismni yashirmang.

## Prompt o‘rganish sikli
Review finding → origin (executor/manager/shared) → kuzatilgan holat → keyingi promptda qisqa prevention → yangi artifactda recurrence/fix tekshiruvi. Taxminiy xatoni isbotlangan pattern deb yozmang. Fayl/anchor xatosi uchun avtomatik tekshiruv; biznes semantikasi uchun real source/qaror tekshiruvi kerak.

Joriy batch: S01-FULL-C — butun01.01–01.05 hujjat bosqichi. Oldingi BATCH-01.01-01.02-B superseded. Eski ARGON-01.01-FIX-01ning faqat to‘xtab topshirish talabi o‘rniga shu batch qo‘llanadi; fix talablari saqlanadi. Argon oldingi fixni allaqachon bajargan bo‘lsa, bor natijani tekshiradi va faqat yetishmagan joyni to‘ldiradi.
