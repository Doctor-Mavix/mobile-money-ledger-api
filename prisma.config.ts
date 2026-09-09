import { existsSync } from 'node:fs';

import { defineConfig } from 'prisma/config';

// Prisma 7 no longer reads .env on its own, and the CLI runs outside the application,
// so it never goes through src/core/config/env.ts.
if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  // Left empty when unset so `prisma generate` still runs on a machine with no database
  // (it needs no connection). The migration commands report the missing URL themselves.
  datasource: { url: process.env['DATABASE_URL'] ?? '' },
});
