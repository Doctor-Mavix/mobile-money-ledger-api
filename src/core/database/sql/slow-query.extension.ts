import { Prisma } from '@prisma-client';

import type { Logger } from '@core/logger/logger';

export interface SlowQueryOptions {
  logger: Logger;
  thresholdMs: number;
}

/**
 * Logs any model operation slower than the threshold, with the requestId already attached by
 * the logger. Timing lives in an extension rather than Prisma's `query` event because the
 * event fires per SQL statement, while what a developer needs to see is the slow *operation*.
 */
// Annotating the return type here collapses it to `unknown` and breaks `$extends` downstream:
// Prisma's extension type has to stay inferred.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export const slowQueryExtension = (options: SlowQueryOptions) =>
  Prisma.defineExtension({
    name: 'slowQuery',
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          const startedAt = performance.now();

          try {
            return await query(args);
          } finally {
            const durationMs = Math.round(performance.now() - startedAt);

            if (durationMs >= options.thresholdMs) {
              options.logger.warn({ model, operation, durationMs }, 'slow database operation');
            }
          }
        },
      },
    },
  });
