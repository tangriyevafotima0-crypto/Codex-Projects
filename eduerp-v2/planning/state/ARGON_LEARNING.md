# Argon review kuzatuvlari
Dataset: bitta yakunlangan submission ARGON-01.01-A, bitta manager review; fix hali olinmagan. Takroriy pattern yoki aniqlik oshgani haqida statistik da’vo yo‘q.

| ID | Kuzatuv | Manbasi | Promptdagi prevention | Keyingi tekshiruv |
|---|---|---|---|---|
| L01 | Source va taklif bo‘lsa ham role tableda definitive huquq | F01, executor synthesis | origin + decision_status; noaniq grant OPEN | FIX/BATCHda tekshiriladi |
| L02 | CSV119 ID bor, ammo anchorlar uydirma | F02, executor | explicit anchors + parser existence | FIX/BATCHda tekshiriladi |
| L03 | Sahifa xatosi source mappingdan ko‘chgan, yangi detail ham tekshirilmagan | F03, manager/executor shared | source matni ustuvor; upstream correction report | FIX/BATCHda tekshiriladi |
| L04 | Privacyda bir nechta muqobil ifoda qolgan | F04, executor wording | raw data boundary aniq, UI maskga tayanmaslik | FIX/BATCHda tekshiriladi |
| L05 | Birlik qisqartmasi va broad PASS semantik xatoni yashirgan | F05, executor | explicit unit + row count/semantic coverage separate | FIX/BATCHda tekshiriladi |

Kuchli natijalar: barcha ruxsat etilgan fayllar bor; 4 hash mos; 119 unique ID original setga teng; transport va scopega amal qilingan. Model nomiga qarab kuch/zaiflik bahosi berilmaydi.

Keyingi reviewda: qaysi finding yopildi, qaysisi takrorlandi/yangi issue, downstream ta’siri va promptga eng qisqa o‘zgarish yoziladi. Token yoki vaqt sarfi o‘lchanmagan; tejash hozir dizayn maqsadi.

## Ikkinchi artifact — S01-FULL-C (2026-11-04)
Improvement:68anchorning hammasi mavjud; role/channel origin ajratilgan; rawphoneboundary aniq; PDF/MDhash farqlangan; sourceexample R22.04to‘g‘ri. Hash/15file/119ID tartibi yana to‘g‘ri.
L03provenance vaL05broadPASS qisman takrorlandi. Yangi L06:published runnable command compile qilinmaydi, actualPASSclaim isbotsiz; prevention=executable file+realstdout+exactcoverage. L07:96Given/Whenboilerplate; prevention=konkretprecondition/trigger. L08:edgecases alohida to‘g‘ri, lekin cross-feature discountedfreeze/cycleidentity bo‘sh; prevention=discount×freeze,refund×method,trial×correction integration cases. Dataset2artifact; xato chastotasi/aniqlikfoizi yoki token sarfi o‘lchanmagan.
