# Tavsiya arxitektura va kod xaritasi
Bu texnologik tanlovlar PDFdagi qat’iy talablar bilan bir xil emas: PostgreSQL, Compose va staff-only kanal — manbadan; NestJS/React/Prisma — rejalashtirish taklifi. Versiyalar implementatsiya boshlanganda amaldagi rasmiy hujjat bilan tekshirilib lock qilinadi.

```text
eduerp-v2/
  planning/                 # ushbu paket, promptlar va holat
  apps/api/                 # TypeScript NestJS, Prisma, PostgreSQL
  apps/worker/              # DB outbox va scheduled jobs
  apps/bot/                 # Telegram transport; backend API orqali ishlaydi
  apps/web/                 # React TypeScript staff web
  apps/mobile/              # Flutter, local SQLite; faqat staff
  apps/vendor/              # alohida vendor auth va license boshqaruvi
  packages/contracts/       # OpenAPI va generated clients
  packages/domain/          # pul, sanalar, business policy types
  packages/test-fixtures/   # sintetik test data
  infra/                    # Compose, deploy, upgrade, backup
  demo/                     # seed va sales material
  tests/                    # integration/e2e/release
  docs/                     # ADR, API, runbooks va operatsiya
```

Har center alohida DB user, DB, volume, network, bot token va konfiguratsiya oladi. Bir VPSda bir nechta Compose stack mumkin; bitta server nosozligi barcha stacklarga ta’sir qilishi runbookda qayd qilinadi. Kuchliroq izolyatsiya kerak bo‘lsa alohida VPS. Vendor registri ta’lim/moliya ma’lumotlarini yig‘maydi.

## Majburiy invariantlar
- Pul float emas: integer minor-unit + currency; API JSONda xavfsiz decimal string. Qoldiq ledger/invoice allocationdan olinadi.
- Payment + allocation + audit + outbox bitta DB transaction. Retry idempotency key va request hash bilan ishlaydi; boshqa body bilan shu key — conflict.
- Invoice davr/enrollment unique. Ledger yozuvi o‘zgarmaydi; xato reversal va yangi yozuv bilan tuzatiladi.
- Mutable yozuvlarda version; expected version mos bo‘lmasa 409. Server vaqti UTC, biznes jadvali center timezone.
- Davomatda bir lesson/student unique; client operation ID unique. Default present — draft, submit bo‘lmaguncha xabar yoki qarz hodisasi yo‘q.
- Bot faqat tasdiqlangan eventni yuboradi. Telegram send muvaffaqiyati ota-ona o‘qiganini bildirmaydi. Tashqi APIga exactly-once kafolati yo‘q; retryda dublikat ehtimoli kuzatiladi.
- Excel yashirin ID yoki sheet protection xavfsizlik emas: server UUID ownership, version va rolni tekshiradi.
- Har endpoint, export, worker command va bot callbackda bir xil biznes qoidasi. Frontend yashirish vakolat tekshiruvi o‘rnini bosmaydi.
- TLS, redact qilingan loglar, secret fayllar repo tashqarisida; boshlang‘ich parol bir marta ko‘rsatiladi va almashtiriladi.

## GitHub tartibi
Private `eduerp-v2` repo; main protected. Branch: `codex/s01-talablar` kabi. Commit: `S01.01: scope va rollar`. PR bitta stage uchun, scope/test/migration/rollback va handoff havolalari bilan. Tag: reviewdan keyin `stage-01-reviewed`; production release alohida `v2.0.0-rc.1`. Baza dumpi, token, real student va production env GitHubga kiritilmaydi. GitHub repo ochish/push keyingi alohida ijro topshirig‘ida bajariladi.

## v2.1 aniqlashtirish
JS lockfile Flutter/Dart dependencylarini boshqarmaydi; mobile pubspec.lock va SDK pin alohida. API va Flutter client bir OpenAPI kontraktidan mos ravishda generatsiya qilinadi. tests/acceptance/*.spec.md — test spetsifikatsiyasi, executable test emas. Handoff code revisionini ko‘rsatadi, o‘zining commitini emas. Vendor auth/MFA, session, webhook verification va retention 07_SECURITY_AND_RELEASE.md bilan to‘ldiriladi.
