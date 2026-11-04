import { defineConfig } from 'prisma/config';

const migrationDatabaseUrl =
  process.env.MIGRATION_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgresql://eduerp_migrator:EXAMPLE_DEV_ONLY_MIGRATOR_PASS@127.0.0.1:5432/eduerp_guliston_ilm_dev?schema=public';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: migrationDatabaseUrl,
  },
});
