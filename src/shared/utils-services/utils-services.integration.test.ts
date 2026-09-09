import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { env } from '@core/config/env';
import { ConflictError } from '@core/errors/app-error';
import { logger } from '@core/logger/logger';
import { RedisConnection } from '@core/redis/redis.client';
import { CacheService } from './cache.service';
import { LockService } from './lock.service';
import { OtpService } from './otp.service';
import { TokenService } from './token.service';

// A prefix of its own, so a failing run never wipes keys the dev stack is using.
const KEY_PREFIX = 'test-kit:';

const redis = new RedisConnection({
  url: env.REDIS_URL,
  keyPrefix: KEY_PREFIX,
  connectTimeoutMs: env.DB_CONNECT_TIMEOUT_MS,
  logger,
});

beforeAll(async () => {
  await redis.connect();
});

beforeEach(async () => {
  const keys = await redis.client.keys(`${KEY_PREFIX}*`);

  if (keys.length > 0) {
    // keys() returns them prefixed, unlike every other read, so unprefix before deleting.
    await redis.client.del(...keys.map((key) => key.slice(KEY_PREFIX.length)));
  }
});

afterAll(async () => {
  await redis.disconnect();
});

describe('CacheService', () => {
  const cache = new CacheService(redis);

  it('computes once then serves the stored value', async () => {
    let calls = 0;
    const compute = (): Promise<number> => {
      calls += 1;
      return Promise.resolve(calls);
    };

    expect(await cache.remember('counter', { ttlSeconds: 60 }, compute)).toBe(1);
    expect(await cache.remember('counter', { ttlSeconds: 60 }, compute)).toBe(1);
    expect(calls).toBe(1);
  });

  it('drops every entry sharing a tag', async () => {
    await cache.set('entity:1', { label: 'a' }, { ttlSeconds: 60, tags: ['entities'] });
    await cache.set('entity:2', { label: 'b' }, { ttlSeconds: 60, tags: ['entities'] });
    await cache.set('other:1', { label: 'c' }, { ttlSeconds: 60, tags: ['others'] });

    expect(await cache.invalidateTag('entities')).toBe(2);
    expect(await cache.get('entity:1')).toBeNull();
    // The other tag is untouched: invalidation is scoped, not a flush.
    expect(await cache.get('other:1')).toEqual({ label: 'c' });
  });

  it('forgets a single key', async () => {
    await cache.set('one', 'value', { ttlSeconds: 60 });
    await cache.forget('one');

    expect(await cache.get('one')).toBeNull();
  });
});

describe('LockService', () => {
  const locks = new LockService(redis);

  it('lets only one holder in', async () => {
    const first = await locks.acquire('tracking-number', { ttlMs: 5_000 });
    const second = await locks.acquire('tracking-number', { ttlMs: 5_000 });

    expect(first).not.toBeNull();
    expect(second).toBeNull();

    expect(await locks.release(first!)).toBe(true);
    expect(await locks.acquire('tracking-number', { ttlMs: 5_000 })).not.toBeNull();
  });

  it('never releases a lock a second holder now owns', async () => {
    const held = await locks.acquire('expiring', { ttlMs: 30 });
    await new Promise((resolve) => setTimeout(resolve, 60));

    const next = await locks.acquire('expiring', { ttlMs: 5_000 });
    expect(next).not.toBeNull();

    // The stale owner's release must be a no-op, or it unlocks the section `next` is inside.
    expect(await locks.release(held!)).toBe(false);
    expect(await redis.client.get('lock:expiring')).toBe(next!.token);
  });

  it('releases even when the work throws', async () => {
    await expect(
      locks.withLock('report', { ttlMs: 5_000 }, () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');

    expect(await locks.acquire('report', { ttlMs: 5_000 })).not.toBeNull();
  });

  it('refuses to run the work when the lock is taken', async () => {
    await locks.acquire('digest', { ttlMs: 5_000 });

    await expect(
      locks.withLock('digest', { ttlMs: 5_000 }, () => Promise.resolve('never')),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});

describe('OtpService', () => {
  const otp = new OtpService(redis);

  it('accepts the right code once', async () => {
    const code = await otp.issue('phone', '+2290197000000');

    expect(code).toMatch(/^\d{6}$/);
    expect(await otp.verify('phone', '+2290197000000', code)).toBe('valid');
    // Consuming destroys it: a code replayed is a code that was never one-time.
    expect(await otp.verify('phone', '+2290197000000', code)).toBe('expired');
  });

  it('refuses a code issued for another purpose', async () => {
    const code = await otp.issue('phone', 'subject');
    await otp.issue('password-reset', 'subject');

    expect(await otp.verify('password-reset', 'subject', code)).toBe('invalid');
  });

  it('destroys the code after too many wrong guesses', async () => {
    await otp.issue('phone', 'brute', { maxAttempts: 3 });

    expect(await otp.verify('phone', 'brute', '000000')).toBe('invalid');
    expect(await otp.verify('phone', 'brute', '000000')).toBe('invalid');
    expect(await otp.verify('phone', 'brute', '000000')).toBe('too-many-attempts');
    expect(await otp.verify('phone', 'brute', '000000')).toBe('expired');
  });

  it('does not let a wrong guess extend the code lifetime', async () => {
    await otp.issue('phone', 'ttl', { ttlSeconds: 60 });
    await otp.verify('phone', 'ttl', '000000');

    const ttl = await redis.client.ttl('otp:phone:ttl');
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);
  });

  it('reports an unknown subject as expired', async () => {
    expect(await otp.verify('phone', 'never-issued', '123456')).toBe('expired');
  });
});

describe('TokenService', () => {
  const tokens = new TokenService(redis);

  it('hands back the payload exactly once', async () => {
    const token = await tokens.issue('password-reset', 'user-1', {
      ttlSeconds: 60,
      payload: { email: 'a@orangcode.local' },
    });

    expect(await tokens.consume('password-reset', token)).toEqual({
      subject: 'user-1',
      payload: { email: 'a@orangcode.local' },
    });
    expect(await tokens.consume('password-reset', token)).toBeNull();
  });

  it('stores only the digest, never the token', async () => {
    const token = await tokens.issue('invitation', 'user-2', { ttlSeconds: 60 });
    const keys = await redis.client.keys(`${KEY_PREFIX}token:*`);

    expect(keys).toHaveLength(1);
    expect(keys[0]).not.toContain(token);
  });

  it('rejects a token replayed against another purpose', async () => {
    const token = await tokens.issue('invitation', 'user-3', { ttlSeconds: 60 });

    expect(await tokens.consume('password-reset', token)).toBeNull();
  });
});
