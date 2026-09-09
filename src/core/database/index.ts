import { env } from '@core/config/env';
import { PrismaAdapter } from '@core/database/sql/prisma.adapter';
import type { SqlClient } from '@core/database/sql/prisma.adapter';
import type { DatabaseAdapter } from '@core/database/types';
import { ConfigurationError } from '@core/errors/app-error';
import { logger } from '@core/logger/logger';

export interface CreateDatabaseAdapterOptions {
  /** Prisma models carrying a `deletedAt` column, collected from the enabled modules. */
  softDeleteModels: readonly string[];
}

/**
 * The template ships two engines; money is not a document store. A transfer has to debit and
 * credit inside one transaction the database itself guarantees, and a balance has to be
 * refused by a constraint rather than by application code, so this project keeps only the SQL
 * half. `DB_PROVIDER` is validated down to `postgres` in the environment schema, which is what
 * makes this function a single branch.
 */
export function createDatabaseAdapter(options: CreateDatabaseAdapterOptions): DatabaseAdapter {
  return new PrismaAdapter({
    url: env.DATABASE_URL,
    poolSize: env.DB_POOL_SIZE,
    connectTimeoutMs: env.DB_CONNECT_TIMEOUT_MS,
    slowQueryMs: env.DB_SLOW_QUERY_MS,
    logger,
    softDeleteModels: options.softDeleteModels,
  });
}

/**
 * Narrows an adapter to its engine client. A repository asks for the client it was written
 * against; asking for the wrong one is a wiring bug and stops the boot instead of failing
 * on the first request.
 */
export function sqlClientOf(adapter: DatabaseAdapter): SqlClient {
  if (!(adapter instanceof PrismaAdapter)) {
    throw new ConfigurationError(
      `A SQL repository was wired while DB_PROVIDER is "${adapter.provider}"`,
    );
  }

  return adapter.client;
}

export type { DatabaseAdapter, DbProvider } from '@core/database/types';
export type { SqlClient } from '@core/database/sql/prisma.adapter';
