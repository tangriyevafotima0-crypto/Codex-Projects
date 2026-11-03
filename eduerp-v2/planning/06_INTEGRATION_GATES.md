# Oldin interfeys, keyin haqiqiy integratsiya
Stage yakuni faqat uning scopeini tasdiqlaydi; kelajak backendini hozir tayyor deb ko‘rsatmaydi.

| Kontrakt beruvchi | Kechroq ulanadigan ish | Yakuniy tekshiruv |
|---|---|---|
| S08.03 trial conversion port | S12.04 submitted attendance | ikkinchi distinct lesson bitta invoice |
| S08.04 invoice adjustment port | S09.02–03 discount/freeze | grant, overlap va period credit |
| S10.01 payment command | S11.01 shift va S11.03 promise | missing promise yoki closed shiftda nol DB effect |
| S15 web shell | S16.04 Excel UI | preview/commit/conflict to‘liq UI |
| S15.04, S17.04 reports port | S18.04 web/mobile dashboard | haqiqiy finance/payroll/churn va eksport |
| S15/S17 mutation UX | S19.03–04 license | read-only + offline pending qayta tiklash |
| S20 deploy | S21.02 restore drill, S23 release | productionga ruxsat faqat backup/release gate bilan |
| S15 help slot | S22.04 help media | video borligi yoki ochiq CONTENT_PENDING |

Mavjud bo‘lmagan backend o‘rniga test adapter faqat test/devda. Production sahifasida mock raqamlar bo‘lmaydi. `state/INTEGRATIONS.md` har portning owner, implementer, contract version va dalilini saqlaydi. Release oldidan barcha REQUIRED integratsiyalar CLOSED bo‘lishi kerak; video kabi content holati aniq qabul qilinadi yoki blocker sifatida qoladi.
