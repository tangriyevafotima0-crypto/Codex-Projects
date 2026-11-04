# S05 security references — manager checked 2026-11-04

Bu manbalar qo‘shimcha reference; scope va vakolat topshiriqdan olinadi.

[OWASP Password Storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html): scrypt uchun xotira talab qiluvchi parametr variantlari berilgan, jumladan N=2^17, r=8, p=1. Manager Node async scryptni tanlaydi; maxmem va concurrent hashing cheklovi real o‘lchanadi. SHA256 parol hashi emas.

[OWASP Session Management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html): sessiya credentiallari browser localStorage/sessionStorageda saqlanmaydi; cookie flags va session lifecycle nazorat qilinadi.

[OWASP CSRF Prevention](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html): cookie-based unsafe requests uchun session-bound token va Origin tekshiruvi; SameSite qo‘shimcha himoya, yagona mexanizm emas.

[OWASP JWT](https://cheatsheetseries.owasp.org/cheatsheets/JSON_Web_Token_Cheat_Sheet.html): tokenning imzosi va claimlari tekshiriladi, revoke semantics server tomonda aniq bo‘ladi.

Manager npm metadata orqali jose6.2.15, @types/pg8.23.1 va @types/node24.13.6 mavjudligini tekshirgan. jose ESM export qiladi; Node24 CommonJS interoperabilityni actual dist entrypoint bilan tekshiring. JWT qo‘lda yozilmaydi. Official API yoki actual package bilan mos kelmasa kerakli minimal konfiguratsiya o‘zgarishi ADRda yoziladi, ambient declaration bilan aldalmaydi.
