import { env } from '@core/config/env';
import type { RedisConnection } from '@core/redis/redis.client';

const FAILURE_KEY = 'auth:fail:';
const LOCK_KEY = 'auth:lock:';

export interface ThrottleVerdict {
  locked: boolean;
  retryAfterSeconds: number;
}

/**
 * Counts failed logins per account **and** per IP, because neither alone is enough: locking
 * only the account lets an attacker spray one password across thousands of accounts, and
 * locking only the IP lets a botnet through one request at a time.
 *
 * The backoff doubles rather than locking outright, so a legitimate user who mistypes twice
 * waits seconds while a script sees minutes, and no support ticket is needed to unlock.
 */
export class LoginThrottle {
  constructor(private readonly redis: RedisConnection) {}

  async check(scopes: readonly string[]): Promise<ThrottleVerdict> {
    const ttls = await Promise.all(
      scopes.map(async (scope) => this.redis.client.ttl(LOCK_KEY + scope)),
    );
    const retryAfterSeconds = Math.max(0, ...ttls);

    return { locked: retryAfterSeconds > 0, retryAfterSeconds };
  }

  async recordFailure(scopes: readonly string[]): Promise<ThrottleVerdict> {
    const verdicts = await Promise.all(scopes.map(async (scope) => this.punish(scope)));
    const retryAfterSeconds = Math.max(0, ...verdicts);

    return { locked: retryAfterSeconds > 0, retryAfterSeconds };
  }

  async clear(scopes: readonly string[]): Promise<void> {
    await Promise.all(
      scopes.map(async (scope) => this.redis.client.del(FAILURE_KEY + scope, LOCK_KEY + scope)),
    );
  }

  private async punish(scope: string): Promise<number> {
    const key = FAILURE_KEY + scope;
    const failures = await this.redis.client.incr(key);

    // The counter itself expires, so an account that fails twice today and once next month is
    // never locked out by the accumulated history.
    await this.redis.client.expire(key, env.LOGIN_LOCKOUT_MAX_SECONDS);

    if (failures < env.LOGIN_MAX_ATTEMPTS) {
      return 0;
    }

    const overshoot = failures - env.LOGIN_MAX_ATTEMPTS;
    const delay = Math.min(
      env.LOGIN_LOCKOUT_BASE_SECONDS * 2 ** overshoot,
      env.LOGIN_LOCKOUT_MAX_SECONDS,
    );

    await this.redis.client.set(LOCK_KEY + scope, String(failures), 'EX', delay);

    return delay;
  }
}
