> Current manager status: S01–S12 approved (60/120 =50%). S13 changes required: S candidate184PASS/4FAIL; next S13FIX-T. Evidence planning/state/reviews/S13-S.md. No production release approval.

# EduERP v2.0 — B2B Turnkey O‘quv Markazi Platformasi (`eduerp-v2/`)

Ishchi loyiha rooti: ushbu `eduerp-v2/` papkasi. Git repozitoriy rooti `Codex-Projects` bo‘lib, barcha npm workspace, Prisma, Docker Compose va tekshiruv buyruqlari `eduerp-v2/` ichidan ishga tushiriladi.

---

## 1. Monorepo Tuzilmasi va Toolchain Chegarasi (`S03`–`S05`)

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
        schema.prisma         # Prisma 7.10.1 kanonik 46-entity sxemasi (0 P1012 xato)
        migrations/           # PostgreSQL 16 DDL migratsiyalari (S04 + S05), CHECK, partial UNIQUE, 24+11 trigger
      prisma.config.ts        # Prisma 7 CLI konfiguratsiyasi (MIGRATION_DATABASE_URL ?? DATABASE_URL)
      src/
        auth/                 # Stage 05 Staff Auth, Session Rotation/Replay, RBAC Guard, Staff CRUD, Safe Roster
        database/             # DatabaseService (real PrismaClient), BigInt Money, Transaction retry, Idempotency
        health/               # Liveness (/api/v1/health) va DB Readiness (/api/v1/ready)
      test/
        auth/                 # Real HTTP + PostgreSQL Auth & RBAC integratsion testlari (AUTH-IT-01..AUTH-IT-17)
        database/             # Real PostgreSQL DB integratsion testlari (DB-IT-01..DB-IT-25)
    worker/                   # Outbox/Scheduler Worker poydevori (config, startup, graceful shutdown)
  infra/
    db/                       # Least-privilege PostgreSQL rollari (migrator, api_runtime, worker_runtime, readonly)
    compose.dev.yml           # Lokal PostgreSQL 16 + Migrator + API + Worker dev muhiti
    ci/eduerp-ci.yml          # GitHub Actions CI shabloni (G1 test:db va G2 test:auth bilan)
  docs/                       # Spetsifikatsiya, arxitektura, ADR-004/ADR-005, RBAC matritsasi va verifikatsiya
  planning/                   # Bosqichlar, promptlar, qarorlar va handoff hisobotlari
  tools/
    verify_s01_s02.py         # S01 va S02 kontrakt/invariant tekshiruvchisi
    verify_s04.py             # S04 va S05 sxema, SQL migratsiya, DB rollari, RBAC va test tekshiruvchisi
```

---

## 2. Liveness (`/api/v1/health`), Database Readiness (`/api/v1/ready`) va Staff Auth (`S03`–`S05`)

- **Liveness (`GET /api/v1/health` — Stage 03):**
  - `GET /api/v1/health` faqat jarayonning tirikligini (`status: "OK"`, `center_slug`, `license_mode`, `request_id`, `timestamp_utc`) qaytaradi.
- **Database Readiness (`GET /api/v1/ready` — Stage 04 `F06`):**
  - `GET /api/v1/ready` jonli PostgreSQL ulanishini, joriy ulanish roli superuser emasligini (`rolsuper = false`), `public` sxema egasi emasligini (`schema_owner = false`), `staff_users` va `audit_logs` ACL huquqlarini, barcha `46` ta kanonik jadval hamda `24` ta yoqilgan (`tgenabled != 'D'`) immutability trigger mavjudligini tekshiradi.
  - Baza uzilgan yoki talab buzilgan bo‘lsa ichki tizim tafsilotlarini oshkor qilmaydigan xavfsiz statik `503 Service Unavailable` (`error_code: "DATABASE_UNAVAILABLE"`) qaytaradi.
- **Staff Auth, Session Lifecycle, RBAC va Safe Roster (`Stage 05`):**
  - `POST /api/v1/auth/login`, `POST /api/v1/auth/refresh`, `POST /api/v1/auth/logout`, `POST /api/v1/auth/password` (`scrypt N=131072, r=8, p=1`, Cookie+CSRF va Bearer transportlari, family replay aniqlash, brute-force lockout, birinchi kirishda `must_change_password` darvozasi).
  - `POST /api/v1/staff` (`OWNER-20261104-01`: `DIRECTOR` barcha staff rollarini yaratadi; `ADMIN` faqat `TEACHER` yaratadi; `TEACHER` yaratmaydi), `GET /api/v1/staff`, `PATCH /api/v1/staff/:staff_id/status` (race-safe last-Director himoyasi bilan), `POST /api/v1/staff/:staff_id/sessions/revoke`.
  - `GET /api/v1/groups/:group_id/roster` (`TeacherStudentView` — telefon va moliya maydonlarisiz, Teacher faqat o‘zining primary yoki bugungi active substitute guruhini ko‘ra oladi).

---

## 3. Ishga Tushirish, Migratsiya va Test Buyruqlari (`S04` – `S05`)

1. **Hujjat, Arxitektura va S04/S05 Sxema/SQL/RBAC Kontraktlarini Tekshirish (Offline Python 3 stdlib):**
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
3. **PostgreSQL Rollari, Migratsiya va Real DB + Auth/RBAC Integratsion Testlari (`G1` va `G2`):**
   ```bash
   psql -h 127.0.0.1 -U eduerp_pg_superuser -d postgres -v ON_ERROR_STOP=1 -f infra/db/01-init-roles-and-databases.sql
   MIGRATION_DATABASE_URL="postgresql://eduerp_migrator:eduerp_migrator_local_dev@127.0.0.1:5432/eduerp_center_a?schema=public" npm run migrate:deploy
   psql -h 127.0.0.1 -U eduerp_pg_superuser -d eduerp_center_a -v ON_ERROR_STOP=1 -f infra/db/02-apply-runtime-grants.sql
   EDUERP_ALLOW_DESTRUCTIVE_DB_TESTS=true TEST_DATABASE_ADMIN_URL="postgresql://eduerp_pg_superuser:pass@127.0.0.1:5432/eduerp_test_admin" npm run test:db
   EDUERP_ALLOW_DESTRUCTIVE_DB_TESTS=true TEST_DATABASE_ADMIN_URL="postgresql://eduerp_pg_superuser:pass@127.0.0.1:5432/eduerp_test_admin" npm run test:auth
   ```
4. **Lokal Docker Compose Dev Muhiti (`03.03`, `04.05`, `05.05`):**
   ```bash
   cp .env.example .env
   docker compose -f infra/compose.dev.yml --env-file .env up --build -d
   curl --fail http://127.0.0.1:3000/api/v1/health
   curl --fail http://127.0.0.1:3000/api/v1/ready
   ```

## Manager verification baseline
Node24.18.1 /npm11, Nest12.3.2, Prisma7.10.1, pg8.23.1, jose6.2.15, TypeScript5.9.3, ESLint9.39.5. package-lock.json is generated by npm. Real Nest bootstrap and worker subprocess tests are required; a handwritten HTTP helper is not the deployed API. SQL migrations are allowed as source files; secret/dump scanning must not reject every .sql file. Docker execution is pending where no Docker daemon exists.
