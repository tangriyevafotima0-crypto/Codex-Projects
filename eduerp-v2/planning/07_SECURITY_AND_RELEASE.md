# Xavfsizlik, migratsiya va release mezonlari

## Tahdid → tekshiruv
- Teacher IDOR: group/student/receipt/export IDlarini almashtirish; API DTO va query scope bilan rad.
- Guardian impersonation: contact user_id, single-use invite, revoke va webhook secret; har query/callbackda active link.
- Vendor compromise: alohida auth, MFA tanlovi, least privilege, audit va signing key rotatsiyasi; o‘quvchi bazasiga oddiy kirish yo‘q.
- Import hujumi: XLSX zip bomb, limit, formula, foreign UUID, stale version, token expiry; file protectionga ishonilmaydi.
- Moliyaviy race: double approve, timeout/retry, allocation sum, refund cap; DB invariant + tx testi.
- Backup leakage: encryption key alohida, offsite credential, retention, restore audit; Telegram opsiyasi alohida qaror.
- SSRF/command injection: deploy slug/domain allowlist, shell interpolationdan himoya, bot tokenni argument/logga chiqarish yo‘q.
- Session hijack: secure cookie/CSRF yoki mos token modeli, revoke, mobile secure store, rate limit, redact log.

## CI va release
JS lint/typecheck/unit/integration; Flutter analyze/test/build mavjud bo‘lgach; real PostgreSQL bilan constraint/tx test; e2e rol oqimlari. Vendor auth va migration alohida test target. App versionlar toolchain va lockfileda; aniq latest versiya bu rejada taxmin qilinmaydi.

Capacity target S01da yoziladi: student soni, concurrent staff, import row limit, bot queue volume, p95 latency. S23 aynan shu workloadni o‘lchaydi; demo240 performance benchmark o‘rnini bosmaydi.

Migration: expand → old/new compatible rollout → backfill → verify → contract keyingi release. DB down migration default rollback emas. App rollback schema-compatible bo‘lmasa restore/new migration qarori; restore RPOdagi yo‘qotish oynasi oshkor. Har center release version registri va canary rollout bor.

GO sharti: P0/P1 nol, critical requirement evidence to‘liq, pending integration yopilgan, backup restore real bajarilgan, migration rehearsal yashil, pilot UAT tasdiqli. NO_GO misollari: balance mismatch, unauthorized data, lost offline attendance, restore failure. P2 risk egasi/muddati bilan qabul qilinishi mumkin. Package validator yashil bo‘lishi bu GO emas.
