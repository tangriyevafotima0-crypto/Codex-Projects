# EduERP v2.0 — B2B Turnkey O‘quv Markazi Platformasi (`eduerp-v2/`)

Ishchi loyiha rooti: ushbu `eduerp-v2/` papkasi. Git repozitoriy rooti `Codex-Projects` bo‘lib, barcha npm workspace, Docker Compose va tekshiruv buyruqlari `eduerp-v2/` ichidan ishga tushiriladi.

---

## 1. Monorepo Tuzilmasi va Toolchain Chegarasi (`03.01` / `T03.01`)

```text
eduerp-v2/
  package.json                # Root npm workspaces (packages/contracts, apps/api, apps/worker)
  tsconfig.base.json          # Umumiy strict TypeScript konfiguratsiyasi
  .nvmrc                      # Pin qilingan Node.js LTS runtime (18.20.4)
  .env.example                # Haqiqiy kalitlardan xoli lokal dev namuna
  packages/
    contracts/                # Kanonik OpenAPI 3.1.0 kontrakt eksporti va umumiy tiplar
  apps/
    api/                      # NestJS Center Data Plane API poydevori (config, X-Request-Id, /api/v1/health)
    worker/                   # Outbox/Scheduler Worker poydevori (config, startup, graceful shutdown)
  infra/
    compose.dev.yml           # Lokal PostgreSQL + API + Worker dev muhiti (private DB network + volume)
    ci/eduerp-ci.yml          # GitHub Actions CI shabloni (repo-root .github/workflows/ uchun)
  docs/                       # Stage 01 spetsifikatsiyasi, Stage 02 arxitekturasi va verifikatsiya dalillari
  planning/                   # Bosqichlar, promptlar, qarorlar va handoff hisobotlari
  tools/
    verify_s01_s02.py         # S01 va S02 kontrakt/invariant tekshiruvchisi
```

- **JS Workspace vs Flutter Toolchain Ajratilishi (`T03.01`, `B21`, `D15`):**
  - JavaScript/TypeScript paketlari (`packages/contracts`, `apps/api`, `apps/worker`) yagona root `package.json` (va `npm install` yaratadigan yagona root `package-lock.json`) orqali boshqariladi.
  - Staff mobil ilovasi (`apps/mobile/` — Flutter + SQLite) Stage 17 da alohida Dart/Flutter SDK va `pubspec.lock` bilan boshqariladi hamda JS lockfile ichiga aralashtirilmaydi.

---

## 2. Liveness (`/api/v1/health`) va Database Readiness Chegarasi (`03.02` / `T03.02`)

- **Liveness (`GET /api/v1/health` — Stage 03):**
  - `apps/api` ishga tushishidan oldin `loadApiEnv()` orqali barcha majburiy konfiguratsiyalarni (`CENTER_ID`, `CENTER_SLUG`, `DATABASE_URL`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `INTERNAL_BOT_HMAC_SECRET`, `TELEGRAM_WEBHOOK_SECRET`) qat’iy (`fail-fast`) tekshiradi.
  - `GET /api/v1/health` faqat xavfsiz minimal liveness javobini (`status: "OK"`, `center_slug`, `license_mode`, `request_id`, `timestamp_utc`) qaytaradi va `X-Request-Id` korrelyatsiya sarlavhasini aks ettiradi.
  - **Muhim chegara:** Stage 03 da ma’lumotlar bazasi jadvallari va migratsiyalari hali yaratilmagan (ular Stage 04 da yoziladi). Shu sababli `/api/v1/health` bazani tekshirmasdan turib `"database": "healthy"` deb yolg‘on ma’lumot qaytarmaydi va hech qachon `DATABASE_URL` yoki maxfiy kalitlarni javobda/logda chiqarmaydi.

---

## 3. Ishga Tushirish, Tekshirish va Lokal Dev Compose Buyruqlari (`03.01` – `03.04`)

1. **Hujjat va Arxitektura Kontraktlarini Tekshirish (Offline Python 3 stdlib):**
   ```bash
   python3 -m py_compile tools/verify_s01_s02.py && python3 tools/verify_s01_s02.py
   ```
2. **JS Workspace O‘rnatish, Typecheck, Lint, Build va Test (Tarmoq/kesh mavjud muhitda):**
   ```bash
   npm install
   npm run lint
   npm run typecheck
   npm run build
   npm test
   ```
3. **Lokal Docker Compose Dev Muhiti (`03.03` / `T03.03`):**
   ```bash
   cp .env.example .env
   docker compose -f infra/compose.dev.yml --env-file .env up --build -d
   docker compose -f infra/compose.dev.yml ps
   ```
   - `postgres` servisi faqat ichki `eduerp_dev_private_net` (`internal: true`) tarmog‘iga ulangan bo‘lib, tashqi internetga (`0.0.0.0:5432`) ochilmaydi va ma’lumotlarni `eduerp_dev_pgdata` persistent volume’ida saqlaydi.
4. **GitHub Actions CI Joylashuvi (`03.04` / `T03.04`):**
   - GitHub Actions faqat Git repozitoriy rootidagi (`Codex-Projects/.github/workflows/`) workflow fayllarini ishga tushiradi. Loyiha ichidagi `infra/ci/eduerp-ci.yml` shabloni manager reviewdan so‘ng repo-root `.github/workflows/eduerp-ci.yml` ga ko‘chiriladi.
