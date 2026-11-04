# ADR-003 — ishlaydigan S03 baseline
Status: ACCEPTED_TECHNICAL (Codex-manager,2026-11-04). Bu biznes qoidasi sign-offi emas.
Node24.18.1/npm11, Nest12.3.2,reflect-metadata0.2.2,rxjs7.8.2. npm generated lockfile. Exactimage tags/digestlari Dockerfile vaCompose ichida. CI run41802562459yashil.
Sabab:originalAPI DI error va workerimmediateexit manager tomonidan qayta chiqarildi; Node18EOL va originalproductiondepsaudit6high topildi. Manual Nest decoratorlar va fakeHTTPserver actualbootstrap o‘rnini bosmaydi. Publichealth haqiqiyNestapplication orqali testlanadi.
DevPostgres imageidagi POSTGRES_USER hozir developmentbootstrap hisobidir. S04da u API runtime rolidan ajratilishi shart: runtime/migrator/worker/readonly credentials alohida; API hech qachon superuser URL bilan yurmaydi.
S03ESLint8/TS5.3baseline builddan o‘tdi; Prisma7TS>=5.4talabi uchun S04tooling5.9.3+/ESLintflatconfigga moslashtiriladi. Mavjud14 runtime/unit regressiya saqlanadi.
