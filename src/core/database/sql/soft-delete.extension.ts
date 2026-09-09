import { Prisma } from '@prisma-client';

/** Operations that must never see, touch or return a soft-deleted row. */
const SCOPED_OPERATIONS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
  'update',
  'updateMany',
]);

interface WhereArgs {
  where?: Record<string, unknown>;
}

/**
 * Scopes every read and every update of the listed models to rows that are still alive, so
 * a soft-deleted row cannot leak through a query that forgot to filter on `deletedAt`.
 *
 * Writing the timestamp is left to the repository, which keeps `delete` meaning a real delete
 * when one is genuinely needed (an erasure request, for instance).
 *
 * Opt-in per model, because injecting `deletedAt` into a model that has no such column
 * would fail at runtime, and silently *not* injecting it into one that does is the exact
 * data leak this extension exists to prevent.
 */
// See slow-query.extension.ts: the inferred extension type must not be annotated.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export const softDeleteExtension = (models: readonly string[]) => {
  const scoped = new Set(models);

  return Prisma.defineExtension({
    name: 'softDelete',
    query: {
      $allModels: {
        $allOperations({ model, operation, args, query }) {
          if (!scoped.has(model) || !SCOPED_OPERATIONS.has(operation)) {
            return query(args);
          }

          const typed = args as WhereArgs;
          const scopedArgs = { ...typed, where: { ...typed.where, deletedAt: null } };

          // Cast because no model in this project declares `deletedAt` yet, so the generated
          // where inputs reject the key outright. Drop it once one does.
          return query(scopedArgs as typeof args);
        },
      },
    },
  });
};
