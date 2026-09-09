import type { RedisConnection } from '@core/redis/redis.client';

export interface CacheEntryOptions {
  ttlSeconds: number;
  /**
   * Labels the entry so it can be dropped with everything else describing the same thing.
   * Cache invalidation by key alone forces callers to know every key a change affects,
   * which is how stale reads survive a deploy.
   */
  tags?: readonly string[];
}

const NAMESPACE = 'cache:';
const TAG_NAMESPACE = 'cache-tag:';

/**
 * Cache-aside on Redis, shared by every instance. `remember` is the only method most callers
 * need: it returns the cached value or computes, stores and returns it.
 */
export class CacheService {
  constructor(private readonly redis: RedisConnection) {}

  async get<T>(key: string): Promise<T | null> {
    const raw = await this.redis.client.get(NAMESPACE + key);

    return raw === null ? null : (JSON.parse(raw) as T);
  }

  async set(key: string, value: unknown, options: CacheEntryOptions): Promise<void> {
    const namespaced = NAMESPACE + key;

    await this.redis.client.set(namespaced, JSON.stringify(value), 'EX', options.ttlSeconds);

    for (const tag of options.tags ?? []) {
      // The tag index outlives the entry it points at; a dangling key simply misses.
      await this.redis.client.sadd(TAG_NAMESPACE + tag, namespaced);
    }
  }

  async remember<T>(
    key: string,
    options: CacheEntryOptions,
    compute: () => Promise<T>,
  ): Promise<T> {
    const cached = await this.get<T>(key);

    if (cached !== null) {
      return cached;
    }

    const value = await compute();
    await this.set(key, value, options);

    return value;
  }

  async forget(key: string): Promise<void> {
    await this.redis.client.del(NAMESPACE + key);
  }

  /** Drops every entry labelled with this tag. The unit of invalidation callers actually think in. */
  async invalidateTag(tag: string): Promise<number> {
    const indexKey = TAG_NAMESPACE + tag;
    const members = await this.redis.client.smembers(indexKey);

    if (members.length === 0) {
      return 0;
    }

    // Members are stored as written, without REDIS_KEY_PREFIX: ioredis adds it on the way in
    // and never on the way out, so they can be handed straight back to del.
    const removed = await this.redis.client.del(...members);
    await this.redis.client.del(indexKey);

    return removed;
  }
}
