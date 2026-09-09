import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma-client';

import { softDeleteExtension } from '@core/database/sql/soft-delete.extension';
import { slowQueryExtension } from '@core/database/sql/slow-query.extension';
import type { DatabaseAdapter, DbProvider } from '@core/database/types';
import type { Logger } from '@core/logger/logger';

export interface PrismaAdapterOptions {
  url: string;
  poolSize: number;
  connectTimeoutMs: number;
  slowQueryMs: number;
  /** Models carrying a `deletedAt` column, collected from the enabled modules. */
  softDeleteModels: readonly string[];
  logger: Logger;
}

// The extended client type is generated and has no nameable form, so it is captured from
// the factory instead of being written out.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
const buildClient = (options: PrismaAdapterOptions) =>
  new PrismaClient({
    adapter: new PrismaPg({
      connectionString: options.url,
      max: options.poolSize,
      connectionTimeoutMillis: options.connectTimeoutMs,
    }),
  })
    .$extends(softDeleteExtension(options.softDeleteModels))
    // Applied last so it measures the operation as rewritten by soft delete.
    .$extends(slowQueryExtension({ logger: options.logger, thresholdMs: options.slowQueryMs }));

export type SqlClient = ReturnType<typeof buildClient>;

export class PrismaAdapter implements DatabaseAdapter {
  readonly provider: DbProvider = 'postgres';
  readonly client: SqlClient;

  constructor(options: PrismaAdapterOptions) {
    this.client = buildClient(options);
  }

  async connect(): Promise<void> {
    await this.client.$connect();
  }

  async disconnect(): Promise<void> {
    await this.client.$disconnect();
  }

  async ping(): Promise<void> {
    await this.client.$queryRaw`SELECT 1`;
  }
}
