import type { Env } from '@core/config/env';

/** The single switch that decides which persistence engine the application talks to. */
export type DbProvider = Env['DB_PROVIDER'];

/**
 * The only thing `core/` knows about a database. Everything engine-specific — Prisma models,
 * transactions, row locks — stays behind a repository in the module that needs it.
 */
export interface DatabaseAdapter {
  readonly provider: DbProvider;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  /** Cheap round-trip backing the readiness probe. Throws when the database is unreachable. */
  ping(): Promise<void>;
}
