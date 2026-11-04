# Argon review kuzatuvlari
Holat: 2026-11-04. Dataset: 2 ta olingan artifact — ARGON-01.01-A va S01-FULL-C. Joriy S01-FIX-S02-FULL-D hali topshirilmagan. Model aniqligi yoki token sarfi bo‘yicha statistik o‘lchov yo‘q.

| ID | Kuzatuv | Hozirgi dalil | Keyingi promptga moslashuv |
|---|---|---|---|
| L01 | Taklif rol huquqi sifatida qat’iy yozilgan | Birinchi artifactda bor; ikkinchisida asosiy origin/status ajratilishi tuzatilgan | Source/proposal/OPEN aniq ajratiladi |
| L02 | Mavjud bo‘lmagan anchorlar | Birinchisida bor; ikkinchisidagi68 anchor va barcha scope locatorlar manager tekshiruvida o‘tdi | Haqiqiy anchor parseri; to‘g‘ri ish qayta yozilmaydi |
| L03 | Source page/section nomuvofiqligi | R22.04/R24.03/R03.01 yaxshilangan; R05.03 kabi residual bor. Bir qismi manager mappingidan meros | Asl manba ustuvor; inherited xatoni takrorlamaslik |
| L04 | Raw phone maxfiyligi noaniq | Ikkinchi artifactda boundary aniq; aloqasiz OPEN_RBAC ID qayta ishlatilgan | Privacy baseline va unique qaror ma’nosi tekshiriladi |
| L05 | Keng PASS da’vosi isbotdan katta | Ikkala reviewda turli ko‘rinishda uchragan | Har checkning real qamrovi va run natijasi |
| L06 | Published checker compile bo‘lmaydi | Ikkinchi artifact literal skripti line5 SyntaxError; PASS matni buni oqlamaydi | Executable file + syntax check + aynan shu fayl stdouti |
| L07 | Given/When umumiy vazifani takrorlaydi | Ikkinchi artifactda96 row | Konkret precondition, command va observable natija |
| L08 | Cross-feature biznes chegaralari yetarli emas | Discount×freeze, refund×method, cycle×reactivation | S02ga shu misollar bilan schema/API/event mosligi |

Kuchli natijalar: ikkala artifactda fayl/transport tartibi, hashlar va119 ID set mos. Ikkinchi artifact hajmi sezilarli kattaroq bo‘lsa ham bu struktura saqlangan.
Keyingi review: qaysi finding yopildi, qaysisi takrorlandi, yangi issue, manager/ijrochi/shared sabab va promptga eng qisqa foydali o‘zgarish yoziladi.
