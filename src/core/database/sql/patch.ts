/** A patch with the keys that were never set removed, rather than set to `undefined`. */
export type Defined<T> = { [K in keyof T]?: Exclude<T[K], undefined> };

/**
 * Drops the keys whose value is `undefined`.
 *
 * Prisma generates its update inputs as `name?: string` — without `| undefined` — while
 * `exactOptionalPropertyTypes` makes a missing key and an explicit `undefined` two different
 * types. Spreading a Zod `.partial()` body produces the second, so a repository handing a patch
 * straight to `update()` does not compile. The two ways around that are turning the compiler
 * flag off for the whole project, or removing the keys; this removes the keys.
 *
 * It is also the behaviour a PATCH endpoint should have anyway: a field the client did not
 * mention must not reach the database at all.
 */
export function definedOnly<T extends object>(patch: T): Defined<T> {
  return Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  ) as Defined<T>;
}
