import { z } from 'zod';

import { BadRequestError } from '@core/errors/app-error';

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

export type SortDirection = 'asc' | 'desc';

/**
 * Keyset cursor. Offset pagination is forbidden on list endpoints: `OFFSET n` makes the
 * database walk n rows it will throw away, so the last pages of a large table get slower
 * and slower. A keyset compares against the last row seen, which stays index-speed forever.
 */
export interface Cursor {
  /** Sort column of the last item of the previous page, serialized as a string. */
  value: string;
  /** Tie-breaker, so rows sharing a sort value are still paginated exactly once. */
  id: string;
}

export interface CursorQuery {
  cursor: Cursor | null;
  limit: number;
  direction: SortDirection;
}

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

const cursorPayloadSchema = z.object({
  v: z.string().min(1),
  i: z.string().min(1),
});

export function encodeCursor(cursor: Cursor): string {
  const payload = JSON.stringify({ v: cursor.value, i: cursor.id });

  return Buffer.from(payload, 'utf8').toString('base64url');
}

export function decodeCursor(raw: string): Cursor {
  let parsed: unknown;

  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new BadRequestError('The "cursor" parameter is not a valid cursor');
  }

  const result = cursorPayloadSchema.safeParse(parsed);
  if (!result.success) {
    throw new BadRequestError('The "cursor" parameter is not a valid cursor');
  }

  return { value: result.data.v, id: result.data.i };
}

/** Query-string schema shared by every list endpoint. */
export const cursorQuerySchema = z.object({
  cursor: z
    .string()
    .optional()
    .transform((raw) => (raw === undefined || raw === '' ? null : decodeCursor(raw))),
  limit: z.coerce.number().int().positive().max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  direction: z.enum(['asc', 'desc']).default('desc'),
});

/**
 * Turns the `limit + 1` rows a repository fetched into a page. Reading one extra row is how
 * `hasMore` is answered without a second COUNT query.
 */
export function buildCursorPage<T>(
  rows: readonly T[],
  limit: number,
  toCursor: (item: T) => Cursor,
): CursorPage<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : [...rows];
  const last = items.at(-1);

  return {
    items,
    hasMore,
    nextCursor: hasMore && last !== undefined ? encodeCursor(toCursor(last)) : null,
  };
}
