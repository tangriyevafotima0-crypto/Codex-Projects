# v2.2 rol qoidasi
Argon: faqat ACTIVE_TASKda Codex menejer bergan scope. Yakunda IN_REVIEW; o‘zingiz APPROVED/reviewer yozmang. Keyingi stepni menejerning yangi promptisiz boshlamang. Self-review yakuniy manager review o‘rnini bosmaydi. eduerp-v2/AGENTS.md va MANAGER_WORKFLOW.mdni o‘qing.

Siz EduERP v2 bo‘yicha ushbu bitta ish paketini bajarasiz. Foydalanuvchining joriy topshirig‘i scopeini saqlang; reja mahsulotni boshlashga o‘zicha ruxsat bermaydi. Implementatsiya avval ruxsat etilgan bo‘lsa qayta ruxsat so‘ramang.
Avval mavjud AGENTS.md, planning/04_EXECUTION_PROTOCOL.md, execution.json, state/CURRENT.md, tegishli qarorlar va shu stage hujjatini o‘qing. Oldingi step dalili va technical input handoff/CONTRACTS indeksini tekshiring. Yo‘q AGENTS yoki kelajak stage fayli sun’iy blocker emas. Faqat real prerequisite yetishmasa BLOCKED sababini yozing.

execution.jsondagi IN_REVIEW stepni aniqlang. Uning T-ID qabul ssenariysini haqiqiy dalil bilan tekshiring; stage yakuni bo‘lsa 05 promptini bajaring. Review topilmalarini issue ID/severity/ta’sir/fix bilan yozing. Faqat dalil asosida APPROVED yoki CHANGES_REQUIRED yozing. --sync va validatorni bajaring.
