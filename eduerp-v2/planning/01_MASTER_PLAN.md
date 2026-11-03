# Bosqichli master-reja

Har stage 4 maqsadli ish va 1 mustaqil review/handoffdan iborat. Har step alohida qabul qilinadi. Muddat: PDFdagi 8 hafta — tekshirilmagan boshlang‘ich taxmin. Jamoa, platforma, integratsiya va pilot sharoiti aniqlanmaguncha qat’iy va’da berilmaydi. 1–3 oylik onboarding qurilishdan keyin hisoblanadi. Stage 01 yakunida ishlar hajmi baholanib, har stage tugaganda prognoz yangilanadi.

| Stage | Ish | Bog‘liqlik | Step |
|---|---|---|---|
| 01 | [Talablar va biznes qarorlari](stages/01.md) | — | 01.01–01.05 |
| 02 | [Arxitektura va kontraktlar](stages/02.md) | 01 | 02.01–02.05 |
| 03 | [Repo va ishlab chiqish poydevori](stages/03.md) | 02 | 03.01–03.05 |
| 04 | [Baza va migratsiyalar](stages/04.md) | 03 | 04.01–04.05 |
| 05 | [Kirish va vakolatlar](stages/05.md) | 04 | 05.01–05.05 |
| 06 | [O‘quvchi va ota-ona bazasi](stages/06.md) | 05 | 06.01–06.05 |
| 07 | [Guruh, jadval va o‘rindosh](stages/07.md) | 06 | 07.01–07.05 |
| 08 | [Tarif va hisoblash yadrosi](stages/08.md) | 07 | 08.01–08.05 |
| 09 | [Chegirma, grant va muzlatish](stages/09.md) | 08 | 09.01–09.05 |
| 10 | [To‘lov va o‘zgarmas jurnal](stages/10.md) | 09 | 10.01–10.05 |
| 11 | [Kassa, xarajat va qarzdorlar](stages/11.md) | 10 | 11.01–11.05 |
| 12 | [Davomat va konfliktlar](stages/12.md) | 07,08,09 | 12.01–12.05 |
| 13 | [Navbat va rejalashtirilgan ishlar](stages/13.md) | 10,11,12 | 13.01–13.05 |
| 14 | [Telegram aloqasi](stages/14.md) | 13,05 | 14.01–14.05 |
| 15 | [Xodimlar veb interfeysi](stages/15.md) | 11,12,14 | 15.01–15.05 |
| 16 | [Excel generator va xavfsiz import](stages/16.md) | 15 | 16.01–16.05 |
| 17 | [Staff mobil ilova va offline](stages/17.md) | 12,15 | 17.01–17.05 |
| 18 | [Hisobot, maosh va churn](stages/18.md) | 11,12,17 | 18.01–18.05 |
| 19 | [Vendor panel va litsenziya](stages/19.md) | 18 | 19.01–19.05 |
| 20 | [Izolyatsiya va bir buyruqli o‘rnatish](stages/20.md) | 19 | 20.01–20.05 |
| 21 | [Zaxira, tiklash va monitoring](stages/21.md) | 20 | 21.01–21.05 |
| 22 | [Demo va sotuv materiali](stages/22.md) | 21 | 22.01–22.05 |
| 23 | [Yakuniy sifat va pilotga ruxsat](stages/23.md) | 22 | 23.01–23.05 |
| 24 | [Mijoz onboarding va evolyutsiya](stages/24.md) | 23 | 24.01–24.05 |

## Release chegaralari
- S01–S05: tasdiqlangan spetsifikatsiya va himoyalangan poydevor.
- S06–S14: sinovdan o‘tgan domen va aloqa; hali tayyor mahsulot emas.
- S15–S18: web, Excel, mobil va hisobotlar.
- S19–S23: litsenziya, deploy, tiklash, demo va release dalillari.
- S24: real mijozda onboarding va qayta aloqa; haqiqiy mijoz sign-offisiz DONE emas.

## Eski qisqa holat tavsifi (batafsil va ustuvor tartib: 04_EXECUTION_PROTOCOL.md)
NOT_STARTED → IN_PROGRESS → IN_REVIEW → APPROVED; BLOCKED, CHANGES_REQUIRED va STALE holatlari ham bor. Stage review tasdiqlangandagina keyingi stage boshlanadi. Agent o‘z xotirasiga emas, repo ichidagi dalil va commitlarga tayanadi. Review alohida yangi chatda berilishi mumkin; subagent shart emas.

## O‘zgarish kelganda
Talab o‘zgarsa decision ID va impact yoziladi → tegishli API/schema/testlar aniqlanadi → avvalgi stage qayta ochiladi → regressiya o‘tkaziladi → yangi handoff eski handoffni supersede qiladi → downstream stage qaysi kontraktga moslashgani qayd etiladi. Boshlangan stage uchun bazis o‘zgarsa ish avtomatik davom etmaydi: diff tahlili va qayta rejalashtirish qilinadi.

## v2.1 ijro tartibi
Jadvaldagi bog‘liqliklar texnik kirishdir; ijro har doim raqam tartibida. Canonical step tartibi va holati execution.jsonda. Har stepning alohida qabul ssenariysi bor. Dashboard, Excel UI, license va video integratsiya yopilish nuqtalari 06_INTEGRATION_GATES.md da.
