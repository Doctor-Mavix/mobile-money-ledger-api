import { createHash, randomBytes } from 'node:crypto';

import type { RedisConnection } from '@core/redis/redis.client';

const NAMESPACE = 'token:';
const DEFAULT_BYTES = 32;

export interface IssueTokenOptions {
  ttlSeconds: number;
  byteLength?: number;
  /** Travels with the token and comes back on consume: a user id, an email, a role. */
  payload?: Record<string, string>;
}

export interface ConsumedToken {
  subject: string;
  payload: Record<string, string>;
}

interface StoredToken {
  subject: string;
  payload: Record<string, string>;
}

const digest = (token: string): string => createHash('sha256').update(token).digest('hex');

/**
 * Opaque, single-use, unguessable links: password reset, invitation, unsubscribe, email
 * confirmation. Only the digest is stored, so a dump of Redis does not hand over live links,
 * and consuming is a delete — a reset link cannot be replayed.
 */
export class TokenService {
  constructor(private readonly redis: RedisConnection) {}

  async issue(purpose: string, subject: string, options: IssueTokenOptions): Promise<string> {
    const token = randomBytes(options.byteLength ?? DEFAULT_BYTES).toString('base64url');
    const stored: StoredToken = { subject, payload: options.payload ?? {} };

    await this.redis.client.set(
      this.key(purpose, token),
      JSON.stringify(stored),
      'EX',
      options.ttlSeconds,
    );

    return token;
  }

  /** Returns null when the token is unknown, expired, or already used. */
  async consume(purpose: string, token: string): Promise<ConsumedToken | null> {
    const key = this.key(purpose, token);
    // getdel is atomic: two concurrent clicks on the same reset link cannot both win.
    const raw = await this.redis.client.getdel(key);

    if (raw === null) {
      return null;
    }

    const stored = JSON.parse(raw) as StoredToken;

    return { subject: stored.subject, payload: stored.payload };
  }

  async revoke(purpose: string, token: string): Promise<void> {
    await this.redis.client.del(this.key(purpose, token));
  }

  private key(purpose: string, token: string): string {
    return `${NAMESPACE}${purpose}:${digest(token)}`;
  }
}
