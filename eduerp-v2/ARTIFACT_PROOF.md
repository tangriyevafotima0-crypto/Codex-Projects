# EduERP v2.0 — `S12FIX-S13FULL-R` Artifact & Packaging Proof (`ARTIFACT_PROOF.md`)

- **Task ID:** `S12FIX-S13FULL-R`
- **Base Commit:** `6c42213499d463631c432505b8bdf55eff72b754`
- **Candidate Input Commit:** `191339dba68b0cfbaf23251d8a2a894868b55e2e`
- **Submission Status:** `IN_REVIEW` (Stop before `S14`; no live Telegram calls)
- **Audit Script:** `python3 -B manager_reference/audit_submission.py --source /tmp/work_s13r --zip S12FIX_S13FULL_R_SUBMISSION.zip` -> `PACKAGING PASS`

## 1. Preserved Manager-Assisted & Read-Only Governance Files
- Preserved all 6 Manager-assisted files (`apps/api/src/attendance/dto.ts`, `apps/api/src/attendance/sync.service.ts`, `apps/api/test/database/migrations-and-drift.integration.test.ts` with 8-migration update, `apps/api/test/cash-unit.test.ts`, `apps/api/test/cash/cash-lifecycle.integration.test.ts`, and `apps/api/test/attendance/attendance-lifecycle.integration.test.ts` with `ATT-IT-11` and `ATT-IT-12` added).
- Preserved `apps/api/src/app.module.ts`, `package-lock.json`, migrations `000100`..`000700`, and all manager-owned governance registries untouched.

## 2. Modified / Added Files in `S12FIX_S13FULL_R_SUBMISSION.zip` (Excluding Self Hash)

| Relative Path (`eduerp-v2/...`) | SHA256 |
| :--- | :--- |
| `apps/api/prisma/migrations/20261105000800_s12_s13_attendance_version_and_worker_schedules/migration.sql` | `ab1215f4e7fc7c998cc3be165a55cf789c0b3fe06815b85a400a8d5450f1468b` |
| `apps/api/prisma/schema.prisma` | `2d4fa34c7dba679f536f016805b35391da3e1d19e39c83c76d3ee9fa03c5446e` |
| `apps/api/src/academics/academic-access.service.ts` | `82c0f2ca827f36bf237e1112e8e650a3af7b678ea151902a143afba784e40546` |
| `apps/api/src/attendance/attendance.service.ts` | `fcfb5b7512e842a3007fff755f2a653c9dabb3c84f940f66ba244552a876cf58` |
| `apps/api/src/attendance/conflicts.service.ts` | `812d2cd81c6e08c0ac0ba191b1c43de7f49933fe074ad50f3b8b2fecb139dd09` |
| `apps/api/test/attendance/attendance-lifecycle.integration.test.ts` | `d61d10a814f112a8416adb9fe55af8ec1c8e7b66e951cdedd9ab8414812ef018` |
| `apps/api/test/attendance-unit.test.ts` | `160abe48f9a05f727c151700c1dcff3a2acf49ab2582acd5b75d117e9fd50c79` |
| `apps/api/test/database/migrations-and-drift.integration.test.ts` | `76e217cb3d73acdb07d8d4b5b2ddde2d38487306b595e4939177b2f453178da7` |
| `apps/worker/package.json` | `5e7c2843411a94f064ff1a0a556061898c78c555fd59a28b2b25718884e34c62` |
| `apps/worker/src/database.ts` | `d693dcbf438d1cd93129216bb414d21fcf2bff255f7e911f84b3c52b2e6652ff` |
| `apps/worker/src/main.ts` | `12ede6a1391ee329699124c973fdac96c5a08d32d3a3a013752d5d214a94d2d7` |
| `apps/worker/src/outbox.worker.ts` | `4d8b8a0966eb9370584fe5afe292f45a0ed1f63761071dee9be86af6ad4c3792` |
| `apps/worker/src/reminders.worker.ts` | `36bca838afe18fd5d081068e0158da2e2f352517cd15144f5f30d96a30ee307b` |
| `apps/worker/src/schedules.worker.ts` | `046797d26bc9ab899e9965d58a041792b23e78f1ad74abf8f7620adf0b97f10e` |
| `apps/worker/src/teacher-ping.worker.ts` | `e7f83cab81b90ed7cfe65c04eb443f6554d9783b5139e141a8e96abc6d19b46d` |
| `apps/worker/test/worker-integration.test.ts` | `5ae8f377a2f82153076a121c5760c9dc657302c186a8b035c197813e11a0e117` |
| `apps/worker/test/worker.test.ts` | `163a5c79e9f49d9721fa175b79dd46a405e9a28b10ddc4afb0110534e2ed4208` |
| `docs/architecture/adr/ADR-012-attendance-offline-sync-and-conflict-resolution.md` | `13733bfc8ec889d6bfecb879ee19397f4cf80effcbc09add6866c6656870e20b` |
| `docs/architecture/adr/ADR-013-outbox-worker-lease-fencing-reminders-and-scheduler.md` | `850b416cb9ffb1f8ecdd25b548cce88c27b3b52c349648e50f5fa9c3704b1769` |
| `docs/verification/S12-R.md` | `022c01e224b5e8794d1d9893335898666291058078913bd5eabda973c8449317` |
| `docs/verification/S13.md` | `3972075683bdb1b767c8c6453899d1dbd0a44bd7ad31c07fba689079e9a78567` |
| `infra/ci/eduerp-ci.yml` | `5af7bce0930649e651646a2ae9bbfb1c8e62b478eac4addc17fe2c39dcc68705` |
| `package.json` | `d3bb550ac758d5dcf435da97a80bb12d3183a33f3bfe4c9c181f366da156adc7` |
| `packages/contracts/src/index.ts` | `acdea640741935f9d66863d6938034f89dac4e8f6a47984a7736b0aad2d02667` |
| `planning/state/handoffs/S12.md` | `055f9e3fbf22aef90d0450e036da1d8679656da74e0866c189d9ab41aadd0d1f` |
| `planning/state/handoffs/S13.md` | `5dfb6c28b1ee3da043f1f445746e5568db2139bb062c9426becacf56194d3467` |
| `planning/state/steps/12.01.md` | `90077ba655f41a2eadeb3bfbc25014514d5c2024deed15acd4644a8cdca389c0` |
| `planning/state/steps/12.02.md` | `4c569228c1ffd0594ce4eb947a7a3821f0d98d0bd2ae06edbc35adbeb8d49ac2` |
| `planning/state/steps/12.03.md` | `e13de62633df7cd5ff6c8acf6a3ce854ad934e475a35d2c08cc94c09efc252d1` |
| `planning/state/steps/12.04.md` | `83c8a918e3b890d530c2482f71876eea5321307b389f6dd9a63ff337d827a3b9` |
| `planning/state/steps/12.05.md` | `90f95008b4e2dbce747df22ff67d18052fd2dfeaf706c7adc18fda4f913eb597` |
| `planning/state/steps/13.01.md` | `9096bec3ca67e1aa92764b9513c93aae0a92fe45624247ecd8313f51f4fa6d93` |
| `planning/state/steps/13.02.md` | `28f190504838151ddb4172ee40e71c180c48151196e126189ebb6daedf1d3753` |
| `planning/state/steps/13.03.md` | `5367f19d9212af3cb3cdaa6127713d61a42a8eb7322c7aff5ccbf8d320521d6c` |
| `planning/state/steps/13.04.md` | `1f387c181f356e77ebd48925ba7bfd5ba1f3b918ec0dd6db7393fc3a0870ef4c` |
| `planning/state/steps/13.05.md` | `8451ed4a73b7a3ab4a85f608f74387b8bd6357bdac0986d846124d8d65c9eabd` |
| `tools/verify_s04.py` | `a1f92772c66cefe914bd755d430145453350ac1bedf1056b2fcd523780e03385` |

## 3. Required Executable Test Declarations Verified
- `apps/api/test/attendance/attendance-lifecycle.integration.test.ts`: `ATT-IT-11`, `ATT-IT-12` (plus `ATT-IT-01..10` preserved)
- `apps/worker/test/worker-integration.test.ts`: `WORKER-IT-01`, `WORKER-IT-02`, `WORKER-IT-03`, `WORKER-IT-04`, `WORKER-IT-05`, `WORKER-IT-06`, `WORKER-IT-07`, `WORKER-IT-08`

## 4. Executed Checks vs `NOT_RUN` Boundaries
- `python3 -B VERIFY_INPUT.py`: `PASS` (`532` input files verified)
- `python3 -B tools/verify_s01_s02.py`: `PASS` (`75` OpenAPI operations, `1092` `$ref`s, `15` canonical event anchors)
- `python3 -B tools/verify_s04.py`: `PASS` (`46` Prisma models, `8` migrations, `DB-IT-01..21`, `CASH-IT-01..13`, `ATT-IT-01..12`, `WORKER-IT-01..08`, `305` SQL `INSERT`s verified)
- `python3 -B planning/tools/check_plan.py` & `python3 -B planning/tools/test_plan.py`: `PASS`
- `python3 -B manager_reference/audit_submission.py`: `PACKAGING PASS`
- Live PostgreSQL & npm/tsc runtime suites (`npm ci`, `npm run typecheck`, `npm test`, `npm run test:db`..`test:attendance`, `npm run test:worker`, Gates `G1`–`G10`, Docker smoke): `NOT_RUN` in offline sandbox (no `node_modules` or PostgreSQL daemon in container).
