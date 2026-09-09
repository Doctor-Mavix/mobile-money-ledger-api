import { randomUUID } from 'node:crypto';

import type { Redis } from 'ioredis';

import { ConflictError } from '@core/errors/app-error';
import type { RedisConnection } from '@core/redis/redis.client';

/**
 * Releasing compares the token before deleting, so a lock whose TTL expired and was taken by
 * someone else is never released by its previous owner. Without this check, a slow holder
 * silently unlocks the section a second holder is inside.
 */
const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`;

const NAMESPACE = 'lock:';

interface RedisWithRelease extends Redis {
  releaseLock(key: string, token: string): Promise<number>;
}

export interface LockOptions {
  ttlMs: number;
  /** Attempts before giving up. One attempt means fail immediately if the lock is taken. */
  attempts?: number;
  retryDelayMs?: number;
}

export interface HeldLock {
  key: string;
  token: string;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Distributed mutual exclusion for sections that must run once across every instance:
 * minting a sequential number, running a migration, sending a daily digest.
 */
export class LockService {
  private readonly client: RedisWithRelease;

  constructor(redis: RedisConnection) {
    // defineCommand rather than a raw eval: it is the one path where ioredis still applies
    // REDIS_KEY_PREFIX to the keys of a Lua script.
    redis.client.defineCommand('releaseLock', { numberOfKeys: 1, lua: RELEASE_SCRIPT });
    this.client = redis.client as RedisWithRelease;
  }

  async acquire(key: string, options: LockOptions): Promise<HeldLock | null> {
    const namespaced = NAMESPACE + key;
    const token = randomUUID();
    const attempts = options.attempts ?? 1;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const result = await this.client.set(namespaced, token, 'PX', options.ttlMs, 'NX');

      if (result === 'OK') {
        return { key: namespaced, token };
      }

      if (attempt < attempts - 1) {
        await sleep(options.retryDelayMs ?? 50);
      }
    }

    return null;
  }

  async release(lock: HeldLock): Promise<boolean> {
    return (await this.client.releaseLock(lock.key, lock.token)) === 1;
  }

  /** Runs `work` under the lock and always releases it, including when `work` throws. */
  async withLock<T>(key: string, options: LockOptions, work: () => Promise<T>): Promise<T> {
    const lock = await this.acquire(key, options);

    if (lock === null) {
      throw new ConflictError(`Another process is already holding the lock "${key}"`);
    }

    try {
      return await work();
    } finally {
      await this.release(lock);
    }
  }
}
