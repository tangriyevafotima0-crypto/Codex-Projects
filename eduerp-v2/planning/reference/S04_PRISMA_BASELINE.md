# S04 uchun tekshirilgan texnik manba

Tekshiruv sanasi: 2026-11-04. Bu tashqi ko‘rsatma emas, manager tanlagan versiyalar va rasmiy hujjatlarning qisqa bayoni.

| Dependency | Tanlangan exact versiya |
|---|---|
| prisma / @prisma/client / @prisma/adapter-pg | 7.10.1 |
| pg | 8.23.1 |
| TypeScript | 5.9.3 |
| ESLint | 9.39.5 |
| @typescript-eslint/parser / eslint-plugin | 8.72.1 |
| Node | 24.18.1 |

Versiyalar npm metadata orqali tekshirildi. Prisma 7.10.1 Node ^20.19, ^22.12 yoki >=24 talab qiladi; client TypeScript >=5.4 talab qiladi. `prisma@latest` tekshiruv vaqtida 8 RC edi: aligned stable versiyani exact ishlating. Argon muhitining Node18 ekanligi loyiha targetini o‘zgartirmaydi.

[Prisma 7 overview](https://www.prisma.io/docs/orm/v7): PostgreSQL uchun driver adapter ishlatiladi, CLI/client versiyalari muvofiq bo‘lishi kerak.

[Prisma config reference](https://www.prisma.io/docs/orm/v7/reference/prisma-config-reference): datasource URL va migration yo‘llari prisma.config.tsda; nisbiy yo‘llar config joylashuviga nisbatan. Migration credentials runtime credentialsdan alohida saqlanadi. Generate muvaffaqiyati connection/migration ishlaganini isbotlamaydi.

[Prisma generator](https://www.prisma.io/docs/orm/v7/prisma-schema/overview/generators): prisma-client explicit output talab qiladi; cjs/esm moduleFormatni qo‘llaydi va TypeScript generatsiya qiladi. Clientni qo‘lda yozmang.

Joylashuv: `apps/api/prisma.config.ts`, `apps/api/prisma/schema.prisma`; generator output `../src/generated/prisma`, moduleFormat `cjs`. Compile import sozlamalarini actual generated output bilan tekshiring. Offline NOT_RUN — PASS emas; manager dependency refresh va CI uchun aniq handoff bering.
