# v2.1 paket tekshiruvi

Tekshiruv sanasi: 2026-11-03.

- 24 stage, 120 ketma-ket step, 124 prompt.
- 96 asosiy step uchun 96 turli qabul ssenariysi va talab/owner/test xaritasi.
- Original 23 PDF talab guruhi SOURCE_REQUIREMENTS.csvda saqlangan.
- Markdown havolalari, prompt mavjudligi, technical dependency yo‘nalishi va statuslar tekshirildi.
- Holat yordamchisining 15 tekshiruvi o‘tdi: baseline, duplicate ID, skipped predecessor, unknown status, dalilsiz approval, future dependency, prerequisite yo‘q work, missing prompt/acceptance, downstream invalidation, unknown invalidate ID, tracker/current sync, unique cases, missing review va complete synthetic approval.
- Barcha haqiqiy step statuslari NOT_STARTED. Synthetic approval testi vaqtinchalik xotirada, loyiha holatini o‘zgartirmaydi.
- Yordamchi evidence mazmunining rostligini tekshirmaydi. Reviewer actual test/diff va reviewed revisionni tekshirishi shart.
- ZIP CRC va fayl SHA256 manifesti tekshirildi. MANIFEST.sha256 o‘zini o‘z ichiga olmaydi.

Qayta tekshirish: `python3 tools/check_plan.py` va `python3 tools/test_plan.py`.
Bu ERP runtime, xavfsizlik, moliya yoki production testi emas. Mahsulot kodi yozilmagan.

## v2.2
Codex manager / Argon executor qoidalari qo‘shildi. Xuddi shu 15 holat tekshiruvi qayta o‘tdi. Product steps NOT_STARTED. Managerning SETUP-00si read-only. Repo uchun plaintext fayllar asosiy nusxa; ZIP foydalanuvchi nusxasi.
