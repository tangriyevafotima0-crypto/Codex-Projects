# EduERP umumiy ish qoidalari — v2.2

Bu fayl faqat eduerp-v2/ loyihasiga tegishli. User topshirig‘i ustuvor. Argon avtomatik AGENTS.md o‘qiydi deb taxmin qilinmaydi: boshlang‘ich prompt uni aniq o‘qitadi.

## Rollar
- User: mahsulot egasi, biznes qarorlari va real mijoz tasdig‘i.
- Codex: menejer/reviewer; joriy repo holatini tekshiradi, issue chiqaradi, acceptance asosida tasdiqlaydi va navbatdagi aniq promptni beradi.
- Argon: ijrochi; faqat menejer task packetidagi ishni bajaradi, test va hisobot bilan IN_REVIEWga topshiradi.

Argon o‘z ishiga APPROVED qo‘ymaydi, menejer imzosini yozmaydi, keyingi stepni o‘zi tanlamaydi. Eski stage/promptda self-review yoki avtomatik davom etish yozilgan bo‘lsa v2.2dagi bu rol taqsimoti qo‘llanadi. User yangi scope bersa u ustuvor.

## Har ishning kirishi
planning/state/ACTIVE_TASK.md, execution.json, joriy stage/step, tegishli qaror va predecessor handoffni o‘qing. Task ID, base commit va target branchni tekshiring. Berilgan commit bilan HEAD farq qilsa sababini aniqlang; remote branchni force bilan qaytarmang. Faqat taskga tegishli fayllarni o‘zgartiring; foydalanuvchi o‘zgarishlarini saqlang.

## Ish va topshirish
Bir vaqtda bitta ijrochi yozadi. Argon branch: argon/sXX-YY-short-name; Codex yozadigan tuzatish: codex/sXX-YY-fix. Bitta vazifa bitta branch/PRda; fix o‘sha PRda davom etadi. Diffni kichik saqlang. Tasdiqlanmagan ishni main bilan birlashtirmang. Menejer approvali o‘z-o‘zidan merge ruxsati emas; userning mavjud merge vakolatiga amal qiling.

Qabul ssenariysini real tekshiring. Actual command/result va skipped sababini yozing. Faqat hujjat stepida keraksiz app testi yozmang. Kod stepida acceptance spec executable test o‘rnini bosmaydi.

Handoff: task ID, base/head commit, o‘zgargan fayllar, actual test, contract/migration ta’siri, muammo va savollar. Argon branchiga push/PR imkoniyati berilgan bo‘lsa topshirsin; bo‘lmasa lokal commit/fayl dalilini bersin. Ulanmagan GitHubni ulangan deb ko‘rsatmasin.

## Scope va limit
Limitga yaqinlashganda yangi vazifani boshlamang; kodni yo‘qotmasdan checkpoint yozing. Build/test bajarilmaganini ochiq ko‘rsating. Keyingi agent checkpointni repo bilan solishtirib oladi. Hech biri boshqasining chatiga avtomatik kirishini taxmin qilmasin.

Production deploy, real Telegram xabari, real student importi va pullik servis faqat user scopeiga muvofiq. Hozir mahsulotni implementatsiya qilish ruxsati yo‘q; SETUP-00 faqat read-only tekshiruv.
