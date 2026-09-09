import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  buildCursorPage,
  cursorQuerySchema,
  decodeCursor,
  encodeCursor,
} from '@core/database/pagination';
import { BadRequestError } from '@core/errors/app-error';

const cursor = { value: '2026-08-20T10:00:00.000Z', id: 'abc' };

describe('cursor encoding', () => {
  it('round-trips a cursor', () => {
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it('produces a URL-safe token', () => {
    expect(encodeCursor(cursor)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('rejects a token that is not base64url JSON', () => {
    expect(() => decodeCursor('not-a-cursor')).toThrow(BadRequestError);
  });

  it('rejects a token whose payload has the wrong shape', () => {
    const tampered = Buffer.from(JSON.stringify({ v: 1 }), 'utf8').toString('base64url');

    expect(() => decodeCursor(tampered)).toThrow(BadRequestError);
  });
});

describe('cursorQuerySchema', () => {
  it('applies defaults when the query is empty', () => {
    expect(cursorQuerySchema.parse({})).toEqual({
      cursor: null,
      limit: DEFAULT_PAGE_SIZE,
      direction: 'desc',
    });
  });

  it('decodes the cursor it receives', () => {
    const parsed = cursorQuerySchema.parse({ cursor: encodeCursor(cursor) });

    expect(parsed.cursor).toEqual(cursor);
  });

  it('caps the page size', () => {
    expect(() => cursorQuerySchema.parse({ limit: String(MAX_PAGE_SIZE + 1) })).toThrow();
  });
});

describe('buildCursorPage', () => {
  const toCursor = (item: { id: string }): { value: string; id: string } => ({
    value: item.id,
    id: item.id,
  });

  it('drops the probe row and exposes the next cursor', () => {
    const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

    const page = buildCursorPage(rows, 2, toCursor);

    expect(page.items).toEqual([{ id: 'a' }, { id: 'b' }]);
    expect(page.hasMore).toBe(true);
    expect(decodeCursor(page.nextCursor ?? '')).toEqual({ value: 'b', id: 'b' });
  });

  it('reports the last page without a cursor', () => {
    const page = buildCursorPage([{ id: 'a' }], 2, toCursor);

    expect(page.items).toHaveLength(1);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it('handles an empty result', () => {
    expect(buildCursorPage([], 2, toCursor)).toEqual({
      items: [],
      hasMore: false,
      nextCursor: null,
    });
  });
});
