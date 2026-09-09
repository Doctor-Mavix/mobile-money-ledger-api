import type { Request, RequestHandler } from 'express';

import type { RedisConnection } from '@core/redis/redis.client';
import { TooManyRequestsError } from '@core/errors/app-error';
import type { Logger } from '@core/logger/logger';

/**
 * INCR then PEXPIRE on the first hit of a window, atomically. Doing it in two round trips
 * lets a crash between them leave a counter with no TTL, which locks a client out forever.
 */
const FIXED_WINDOW_SCRIPT = `
local hits = redis.call('INCR', KEYS[1])
if hits == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return { hits, redis.call('PTTL', KEYS[1]) }
`;

export interface RateLimitOptions {
  redis: RedisConnection;
  logger: Logger;
  windowMs: number;
  max: number;
  /** Requests for which the limiter is skipped entirely, such as the probes. */
  skip?: (req: Request) => boolean;
}

function identify(req: Request): string {
  // req.ip already honours `trust proxy`, which app.ts configures from TRUST_PROXY.
  return req.ip ?? 'unknown';
}

export function rateLimitMiddleware(options: RateLimitOptions): RequestHandler {
  const { redis, logger, windowMs, max } = options;

  return async (req, res, next) => {
    if (options.skip?.(req) === true) {
      next();
      return;
    }

    const window = Math.floor(Date.now() / windowMs);
    const key = `ratelimit:${identify(req)}:${String(window)}`;

    let hits: number;
    let ttlMs: number;

    try {
      const [rawHits, rawTtl] = (await redis.client.eval(
        FIXED_WINDOW_SCRIPT,
        1,
        key,
        String(windowMs),
      )) as [number, number];

      hits = rawHits;
      ttlMs = rawTtl;
    } catch (error) {
      // Fail open: a Redis blip must not take the whole API down. It is logged loudly
      // because running unprotected is a condition someone has to act on.
      logger.error({ err: error }, 'rate limiter unavailable, request allowed through');
      next();
      return;
    }

    const resetSeconds = Math.max(1, Math.ceil(ttlMs / 1000));

    res.setHeader('RateLimit-Limit', max);
    res.setHeader('RateLimit-Remaining', Math.max(0, max - hits));
    res.setHeader('RateLimit-Reset', resetSeconds);

    if (hits > max) {
      res.setHeader('Retry-After', resetSeconds);
      next(new TooManyRequestsError());
      return;
    }

    next();
  };
}
