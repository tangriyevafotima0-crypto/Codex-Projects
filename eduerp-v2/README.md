# EduERP v2.0 — B2B Turnkey O‘quv Markazi Platformasi (`eduerp-v2/`)

Ishchi loyiha rooti: ushbu `eduerp-v2/` papkasi. Git repozitoriy rooti `Codex-Projects` bo‘lib, barcha npm workspace, Prisma, Docker Compose va tekshiruv buyruqlari `eduerp-v2/` ichidan ishga tushiriladi.

---

## 1. Monorepo Tuzilmasi va Toolchain Chegarasi (`03.01` / `T03.01`, `04.01` / `T04.01`)

```text
eduerp-v2/
  package.json                # Root npm workspaces (packages/contracts, apps/api, apps/worker)
  eslint.config.cjs           # ESLint 9 flat config (@typescript-eslint v8)
  tsconfig.base.json          # Umumiy strict TypeScript 5.9 konfiguratsiyasi
  .nvmrc                      # Pin qilingan Node.js LTS runtime (24.18.1)
  .env.example                # Haqiqiy kalitlardan xoli lokal dev namuna (least-privilege DB rollari bilan)
  packages/
    contracts/                # Kanonik OpenAPI 3.1.0 kontrakt eksporti va umumiy tiplar
  apps/
    api/
      prisma/
        schema.prisma         # Prisma 7.10.1 kanonik 46-entity sxemasi
        migrations/           # PostgreSQL 16 DDL migratsiyasi, CHECK, partial UNIQUE va 24 ta trigger
      prisma.config.ts        # Prisma 7 CLI konfiguratsiyasi (MIGRATION_DATABASE_URL ?? DATABASE_URL)
      src/
        database/             # DatabaseService, BigInt Money, Transaction retry, Idempotency, Seed contract
        health/               # Liveness (/api/v1/health) va DB Readiness (/api/v1/ready)
      test/
        database/             # Real PostgreSQL integratsion testlari (DB-IT-01..DB-IT-20)
    worker/                   # Outbox/Scheduler Worker poydevori (config, startup, graceful shutdown)
  infra/
    db/                       # Least-privilege PostgreSQL rollari (migrator, api_runtime, worker_runtime, readonly)
    compose.dev.yml           # Lokal PostgreSQL 16 + API + Worker dev muhiti (private DB network + volume)
    ci/eduerp-ci.yml          # GitHub Actions CI shabloni (repo-root .github/workflows/ uchun)
  docs/                       # Stage 01 spetsifikatsiyasi, Stage 02/04 arxitekturasi va verifikatsiya dalillari
  planning/                   # Bosqichlar, promptlar, qarorlar va handoff hisobotlari
  tools/
    verify_s01_s02.py         # S01 va S02 kontrakt/invariant tekshiruvchisi
    verify_s04.py             # S04 Prisma sxema, SQL migratsiya, DB rollari va DB-IT-01..20 tekshiruvchisi
```

- **JS Workspace vs Flutter Toolchain Ajratilishi (`T03.01`, `B21`, `D15`):**
  - JavaScript/TypeScript paketlari (`packages/contracts`, `apps/api`, `apps/worker`) yagona root `package.json` va `package-lock.json` orqali boshqariladi.
  - Staff mobil ilovasi (`apps/mobile/` — Flutter + SQLite) Stage 17 da alohida Dart/Flutter SDK va `pubspec.lock` bilan boshqariladi hamda JS lockfile ichiga aralashtirilmaydi.

---

## 2. Liveness (`/api/v1/health`) va Database Readiness (`/api/v1/ready`) Chegarasi (`03.02`, `04.03`, `04.05`)

- **Liveness (`GET /api/v1/health` — Stage 03):**
  - `GET /api/v1/health` faqat jarayonning tirikligini (`status: "OK"`, `center_slug`, `license_mode`, `request_id`, `timestamp_utc`) qaytaradi va ma’lumotlar bazasiga bog‘liq bo‘lmaydi.
- **Database Readiness (`GET /api/v1/ready` — Stage 04):**
  - `GET /api/v1/ready` jonli PostgreSQL ulanishini, joriy ulanish roli superuser emasligini (`rolsuper = false`), barcha `46` ta kanonik jadval va `24` ta immutability trigger mavjudligini tekshiradi.
  - Baza tayyor bo‘lsa `200 OK` (`status: "READY"`, `schema_tables_verified: 46`, `immutable_triggers_verified: 24`), baza uzilgan yoki sxema to‘liq bo‘lmasa maxfiy ma’lumotlari tozalangan (`[REDACTED]`) `503 Service Unavailable` (`error_code: "DATABASE_UNAVAILABLE"`) qaytaradi.

---

## 3. Ishga Tushirish, Migratsiya va Test Buyruqlari (`04.01` – `04.05`)

1. **Hujjat, Arxitektura va Stage 04 Sxema/SQL Kontraktlarini Tekshirish (Offline Python 3 stdlib):**
   ```bash
   python3 -m py_compile tools/verify_s01_s02.py tools/verify_s04.py
   python3 tools/verify_s01_s02.py
   python3 tools/verify_s04.py
   ```
2. **JS Workspace O‘rnatish, Prisma Generate, Lint, Typecheck, Build va Unit Testlar:**
   ```bash
   npm install
   npm run prisma:generate
   npm run lint
   npm run typecheck
   npm test
   ```
3. **PostgreSQL Rollari, Migratsiya va Real DB Integratsion Testlari (`DB-IT-01`..`DB-IT-20`):**
   ```bash
   psql -h 127.0.0.1 -U eduerp_pg_superuser -d postgres -v ON_ERROR_STOP=1 -f infra/db/01-init-roles-and-databases.sql
   MIGRATION_DATABASE_URL="postgresql://eduerp_migrator:eduerp_migrator_local_dev@127.0.0.1:5432/eduerp_center_a?schema=public" npm run migrate:deploy
   psql -h 127.0.0.1 -U eduerp_pg_superuser -d eduerp_center_a -v ON_ERROR_STOP=1 -f infra/db/02-apply-runtime-grants.sql
   EDUERP_ALLOW_DESTRUCTIVE_DB_TESTS=true TEST_DATABASE_ADMIN_URL="postgresql://eduerp_pg_superuser:pass@127.0.0.1:5432/eduerp_test_admin" npm run test:db
   ```
4. **Lokal Docker Compose Dev Muhiti (`03.03`, `04.05`):**
   ```bash
   cp .env.example .env
   docker compose -f infra/compose.dev.yml --env-file .env up --build -d
   curl --fail http://127.0.0.1:3000/api/v1/health
   curl --fail http://127.0.0.1:3000/api/v1/ready
   ```

## Manager verification baseline
Node24.18.1 /npm11, Nest12.3.2, Prisma7.10.1, pg8.23.1, TypeScript5.9.3, ESLint9.39.5. package-lock.json is generated by npm. Real Nest bootstrap and worker subprocess tests are required; a handwritten HTTP helper is not the deployed API. SQL migrations are allowed as source files; secret/dump scanning must not reject every .sql file. Docker execution is pending where no Docker daemon exists.
