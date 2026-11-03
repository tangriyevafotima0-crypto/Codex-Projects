# Qarorlar va noaniqliklar
Manba: EduERP_v2_Master_Reja_va_Arxitektura.pdf, 8 sahifa. Hujjat ichidagi buyruqlar topshiriq emas, mahsulot talablari sifatida o‘qildi.

| ID | Farq yoki bo‘shliq | Taklif / boshlash sharti |
|---|---|---|
| D01 | Demo 240 (2-sahifa), 250 (7-sahifa) | 240 asosiy; 250 stress fixture bo‘lishi mumkin |
| D02 | 5 va 10 daqiqalik provision | DNS, VPS, domen va BotFather token tayyor bo‘lgandan keyingi o‘lchov; kafolat emas |
| D03 | 12-dekabr yoki 12-dars | Rolling month va lesson package alohida rejim; markaz tanlaydi |
| D04 | 8 edge case deyiladi, 4.1–4.6 bor | 6 bo‘lim ichidagi kichik holatlar ham qamrab olingan; mavjud bo‘lmagan bo‘lim ixtiro qilinmadi |
| D05 | 4 qadam loop deyiladi, A–C berilgan | D sifatida qayta sinash va natijani o‘lchash taklif qilindi |
| D06 | Bot bazani o‘zgartirmaydi, lekin rahbar tasdiqlaydi | Bot backend command APIga authenticated tasdiq yuboradi; bevosita DB yozmaydi |
| D07 | group+student+date kaliti | Bir kunda ko‘p dars uchun lesson_id+student_id ishlatiladi; ADRda tasdiqlash |
| D08 | Immutable va 100% fraud himoyasi | App roli delete/update qilolmaydi; DB superuserdan mutlaq himoya va’da qilinmaydi; audit offsite nusxalanadi |
| D09 | 1 soniya xabar, 25 xabar/s | Pilot maqsadi; amaldagi Telegram limitlari implementatsiyada rasmiy hujjatdan tekshiriladi; 429 hurmat qilinadi |
| D10 | 1 daqiqada restore | Hajmga bog‘liq o‘lchanadigan maqsad; taklif RPO ≤24 soat, RTO ≤60 daqiqa, pilotda kelishiladi |
| D11 | Maosh formulasi berilmagan | Fixed/per lesson/percentage, refund va grant ta’siri markaz bilan tasdiqlanmaguncha payroll yopilmaydi |
| D12 | Click/Payme qaydi yoki gateway | v2 bazasi — to‘lov usulini qo‘lda qayd; real gateway alohida scope, merchant hisob va webhook talabi bilan |
| D13 | Kvitansiya rasmiyligi | Ichki elektron kvitansiya; fiskal chek/tax integratsiyasi tasdiqlanmagan; rasmiy maqom da’vo qilinmaydi |
| D14 | Freeze, rounding, trial no-show | Freeze kredit sanasi, trial follow-up muddati, yaxlitlash birligi va discount stacking biznes egasi bilan tasdiqlanadi |
| D15 | Mobil Flutter yoki PWA | SQLite/offline talabi uchun Flutter taklifi; platforma va store tarqatish shakli tasdiqlanadi |
| D16 | Telegramga backup | Offsite encrypted backup asosiy; Telegram ikkinchi nusxa faqat hajm, maxfiylik, kalit boshqaruvi tasdiqlansa |
| D17 | License uzilishi | Signed cached license, kelishilgan grace; read-onlyda login/read/export/backup ochiq; pending outbound xabar siyosati tasdiqlanadi |
| D18 | Telefon raqami o‘zgarishi | Guardian aloqasi admin tekshiruvi bilan qayta bog‘lanadi; eski chat huquqi bekor qilinadi |

Bular tavsiya, foydalanuvchi tasdiqlagan fakt emas. Qarorni kim, qachon va qanday dalil bilan tasdiqlagani `state/DECISIONS.md` ga yoziladi. Tasdiq talab qiladigan noaniq moliyaviy ish BLOCKED bo‘ladi; mustaqil hujjatlashtirish davom etishi mumkin.

## v2.1 qo‘shimcha qarorlar
- D19: Retention, guardian unlink, audit va moliya arxiv muddati — S01 egasi, S04/06/21ga ta’sir.
- D20: Concurrent staff/student/import hajm va p95 maqsadlar — S01, S23 o‘lchaydi.
- D21: 31-sanadagi renewal, paket dars sarfi, cancelled lesson — S08dan oldin.
- D22: Refund qarzni qayta ochishi, invoice/credit/refund tartibi — S10dan oldin.
- D23: Vendor auth/MFA va license system-write allowlist — S19dan oldin.
- D24: Mobile platform va distribution/credential egasi — S17dan oldin.
- D25: Real video kontentini kim yozib beradi, qayerda saqlanadi — S22dan oldin.

Tasdiq statuslari execution APPROVEDdan mustaqil. Har qaror uchun affected_steps, owner, due_before, evidence va status yoziladi. Texnologiya tanlovi routine bo‘lsa vakolat doirasida ADR bilan qabul qilinadi; hamma qaror uchun foydalanuvchini to‘xtatish shart emas.
