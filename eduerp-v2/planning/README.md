# Joriy loyiha holati — 2026-11-04

S01–S07 approved:35/120step,7/24stage (reja sanog‘i29.17%). S07FIX-J manager-assisted REVIEW-PASS; navbat S08FULL-K. Exact joriy vazifa state/ACTIVE_TASK.md, dalil state/reviews/S07-J.md. Repo tangriyevafotima0-crypto/Codex-Projects ichida eduerp-v2/; planning/planning yaratmang. Product source apps/,packages/,infra/,docs/ loyiha ildizida.

Quyidagi v2.1 matni tarixiy boshlang‘ich reja; undagi NOT_STARTED yoki “GitHubga yuklanmagan” bayonotlari joriy holat emas. Joriy source va status uchun execution.json/ACTIVE_TASK/APPROVALS/manager review ustuvor.

---

# v2.2 — menejer/ijrochi bilan ishlash
Avval loyiha rootidagi MANAGER_WORKFLOW.md va AGENTS.mdni o‘qing. Quyidagi v2.1 hujjatlari mazmuni saqlangan, promptlarda v2.2 rol qoidasi qo‘shilgan.

# EduERP v2 — reja paketi v2.1
**Mahsulot hali NOT_STARTED. Bu kritik auditdan so‘ng yangilangan reja, tayyor ERP emas.**

## Oson foydalanish
1. [Master-reja](01_MASTER_PLAN.md) — 24 bosqich.
2. [Audit va tuzatishlar](08_BUGHUNT_REPORT.md) — oldingi paketdagi kamchiliklar.
3. [Qarorlar](02_DECISIONS.md), [arxitektura](03_ARCHITECTURE.md), [ish tartibi](04_EXECUTION_PROTOCOL.md).
4. [Moliya/sync qoidalari](05_DOMAIN_RULES.md), [integratsiya gate](06_INTEGRATION_GATES.md), [release](07_SECURITY_AND_RELEASE.md).
5. `stages/01.md` → `24.md`: ishlar. Har stage ichida 4 maqsadli ish va 1 review.
6. Implementatsiyani boshlashga topshiriq berganingizdan keyin `prompts/00_START.md`, so‘ng navbatdagi step prompti.

**120 ish paketi, 124 prompt** saqlandi. Har bir asosiy 96 step endi o‘ziga xos T-ID qabul ssenariysiga ega. 24 review prompti aynan shu dalillarni tekshiradi. Bu ish hajmi bahosi yoki 120 ta bir xil kattalikdagi vazifa degani emas.

## Repo va status
Tavsiya private `eduerp-v2` repo. ZIPdagi ushbu papka ichidagilarni repo **planning/** ichiga qo‘ying; target kod yo‘llari repo rootiga nisbatan. `planning/planning/` hosil qilmang. Kod keyinchalik apps/, packages/, infra/, docs/ ichida yoziladi. Paket GitHubga yuklanmagan.

`execution.json` holatning yagona manbai; `TRACKER.csv` va `state/CURRENT.md` undan hosil qilinadi. Paket papkasida `python3 tools/check_plan.py`; repo rootida `python3 planning/tools/check_plan.py` bilan tekshiriladi. `--sync` derived fayllarni yangilaydi. `--invalidate 08.02` o‘sha va undan keyingi boshlangan ishlarni STALE qiladi. Bu yordamchi faqat reja holatini boshqaradi, ERP kodini ishga tushirmaydi.

`requirements.csv` — 96 ishga bog‘langan qamrov xaritasi; `SOURCE_REQUIREMENTS.csv` — PDFdagi 23 asosiy talab guruhining saqlangan xaritasi. Engineering detail va PDF talabini bir xil manba deb qabul qilmang. Real dastur dalili hozir mavjud emas.

`python3 tools/test_plan.py` — holat yordamchisining 15 ta tekshiruvini qayta ishlatish. Bu vaqtinchalik nusxalarda ishlaydi, asosiy ish holatini o‘zgartirmaydi.

`PACKAGE_CHECK.md` — paket tekshiruvi. Fayllarni ZIPdan ochib foydalaning; eski v2 paketini bu v2.1 bilan aralashtirmang. Original ZIP o‘zgartirilmadi.
