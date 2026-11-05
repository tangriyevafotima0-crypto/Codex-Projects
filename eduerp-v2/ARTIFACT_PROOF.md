# EduERP v2.0 — `S11S12FIX-Q` Artifact & Packaging Proof (`ARTIFACT_PROOF.md`)

- **Task ID:** `S11S12FIX-Q`
- **Base Commit:** `e61f3adff3540c93d46a9fe5aa515c687b0cf4a9`
- **Candidate Input Commit:** `4f4ede44c7b670440816714dbd388cd755d9ac30`
- **Submission Status:** `IN_REVIEW` (Stop before `S13`)
- **Audit Script:** `python3 -B manager_reference/audit_submission.py --source /tmp/work_s12q --zip S11S12FIX_Q_SUBMISSION.zip` -> `PACKAGING PASS`

## 1. Preserved Manager-Restored & Read-Only Governance Files
- `apps/api/src/app.module.ts`: Preserved Manager's restore untouched (`DatabaseModule.register(config, customDatabaseService)`, `APP_GUARD` -> `PermissionsGuard`, `ReadinessController`, `AttendanceModule`).
- `package-lock.json`, `planning/state/CURRENT_STATUS.md`, `planning/state/stage-registry.json`, `planning/state/execution.json`, and migrations `000100`..`000600`: Unmodified.

## 2. Modified / Added Files in `S11S12FIX_Q_SUBMISSION.zip` (Excluding Self Hash)

| Relative Path (`eduerp-v2/...`) | SHA256 |
| :--- | :--- |
| `apps/api/package.json` | `9a938e529444d6057771dc14b009a94f717c689dce5312c6307c5f9ae7a4a691` |
| `apps/api/src/attendance/attendance.controller.ts` | `1d92879d063ef14af2cf5131ce34d6bec1153b7da8fdaec46e65da6d7fb0f0ea` |
| `apps/api/src/attendance/attendance.service.ts` | `17d5b833aa72a6e36875ea8996371d1513a19b0d4f1f71c80d1817d5c6df712d` |
| `apps/api/src/attendance/conflicts.service.ts` | `6d2f36b9a72e20c67256369326862c0ad2e07644f401c2c1d625730e919888fd` |
| `apps/api/src/attendance/dto.ts` | `b189c3570fbb1da2bb565ca8e9e02b078e0e6d4ed72accc3b5a264264326044b` |
| `apps/api/src/cash/promises.service.ts` | `88f7665d41ee4f4bbfef254240a21f149c2e17b852f1506164cda55885b4d162` |
| `apps/api/test/attendance/attendance-lifecycle.integration.test.ts` | `3f253e43af6285654ef66c29cb22d054cf737c9ff89b94f662e7f1bcb6080ed3` |
| `apps/api/test/attendance-unit.test.ts` | `ad11520f6feddb1e38d294fd194e0e5bf98e20fc98960a50d2b30c96a7a3b868` |
| `apps/api/test/cash/cash-lifecycle.integration.test.ts` | `6c2ad218fbf29f198c3da9520049b0e9f10ea4a88d07c5ba5bcedd3a1dec8ec9` |
| `apps/api/test/cash-unit.test.ts` | `59670db6fa6d9d7b3b568f40b16961cc0e39d3f509e1ca34cc9225c234fe7702` |
| `apps/api/test/database/migrations-and-drift.integration.test.ts` | `ac90500ed44d083c7ea4bbe3769e0612f73c6698242680b0be9af76d6460a2c9` |
| `docs/architecture/adr/ADR-012-attendance-offline-sync-and-conflict-resolution.md` | `c196858b637bdeee36d97bcc9bc4ce9de0bba473883ed1a417d7df09d07af047` |
| `docs/architecture/events.md` | `64f1c7ea87b2ddb7f0834d2e541516770adfddbdcbc614c5927f0b0410370d09` |
| `docs/architecture/openapi.yaml` | `744dfce0d03944f1fdedd285f69be51af71bbd5bfb19b360cbf63c93ebf5c88d` |
| `docs/architecture/operation-inventory.csv` | `1c1634d19d7f7231fa75fc5171a3f9d374887ce58d3be6e3535e86d55958e99e` |
| `docs/security/rbac-matrix.csv` | `8094dc0925327c57dc32fe01740c2dc2b3e3c6ffd9d6e6684531dc6b75f206d3` |
| `docs/verification/S11-P.md` | `bf6bab858675a2dab6801fcf40ff279e5e6047d766c8d457c7fd035da6396b2f` |
| `docs/verification/S11-Q.md` | `bf6bab858675a2dab6801fcf40ff279e5e6047d766c8d457c7fd035da6396b2f` |
| `docs/verification/S12-Q.md` | `b3730a1e97e0efdeb5f4e7acd4e73f108a52c7eb1707d877d4e8bdf32abd47db` |
| `docs/verification/S12.md` | `b3730a1e97e0efdeb5f4e7acd4e73f108a52c7eb1707d877d4e8bdf32abd47db` |
| `package.json` | `0efc71d38a71441af1c93a920fbfc5e28df0be7b2056c615b5fad0ea0e8242c5` |
| `packages/contracts/src/index.ts` | `29517d7f94599604bb18fab97a3e028436bf66e0a0dba23fcb7dbb6c292d9f59` |
| `packages/contracts/test/contracts.test.ts` | `14eb8cdfd19162ac7a4bbbc8d763bf5788df8f228fd3e58565cd74e42273f822` |
| `planning/state/handoffs/S11.md` | `f7241286a421b4fa9969c0a52b75a0ad28b77106b6faef5af28a96c1cca1f57b` |
| `planning/state/handoffs/S12.md` | `19f345885a714b2732ed5ba5c26c282335098bfa12fa22d5e082c131b50b20b2` |
| `planning/state/steps/12.01.md` | `158c540e319d18b5b37dc9f68cfc65539419923f8b970141c9f8c4d02c6cc5ca` |
| `planning/state/steps/12.02.md` | `10640e324ae318d9c75d33f6cb911a6ad5fabc9c0cd420abb33697fb8d042c0d` |
| `planning/state/steps/12.03.md` | `06f5197946391c8f9787d736740937a0438f32da19c015045bef383916bd1c8f` |
| `planning/state/steps/12.04.md` | `4cdfd9708ec264717cd7fb5341a50b1d84b5277430a936ff42d15428e4437666` |
| `planning/state/steps/12.05.md` | `d10fda8affb3a330a4a895b0b0486016b0ce634d56d0b31cf63b34ea96ed25f7` |
| `tools/verify_s04.py` | `96e3a6a70566ef4d13bc6778ff547df22237a2178ce722c17a07b29fe79fea0e` |

## 3. Executed Checks vs `NOT_RUN` Boundaries
- `python3 -B VERIFY_INPUT.py`: `PASS` (`527` input files verified)
- `python3 -B tools/verify_s01_s02.py`: `PASS` (`75` OpenAPI operations, `1092` `$ref`s, `15` canonical event anchors + `ExpenseRecorded`/`ExpenseReversed`)
- `python3 -B tools/verify_s04.py`: `PASS` (`46` Prisma models, `7` migrations, `DB-IT-01..21`, `CASH-IT-01..13`, `ATT-IT-01..10`, `260` SQL `INSERT`s verified)
- `python3 -B planning/tools/check_plan.py` & `python3 -B planning/tools/test_plan.py`: `PASS`
- `python3 -B manager_reference/audit_submission.py`: `PACKAGING PASS`
- Live PostgreSQL & npm/tsc runtime suites (`npm ci`, `npm run typecheck`, `npm run test:db`, `npm run test:cash`, `npm run test:attendance`, Gates `G1`–`G9`): `NOT_RUN` in offline sandbox (no `node_modules` or PostgreSQL daemon in container; all 25 compile errors and SQL/test mismatches fixed for Manager CI execution).
