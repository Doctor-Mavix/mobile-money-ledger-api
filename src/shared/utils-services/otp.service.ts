import { createHash, randomInt, timingSafeEqual } from 'node:crypto';

import type { RedisConnection } from '@core/redis/redis.client';

const NAMESPACE = 'otp:';
const DIGITS = '0123456789';

export interface OtpOptions {
  length?: number;
  ttlSeconds?: number;
  /** Wrong guesses tolerated before the code is destroyed. */
  maxAttempts?: number;
}

export type OtpVerdict = 'valid' | 'invalid' | 'expired' | 'too-many-attempts';

interface StoredOtp {
  hash: string;
  attempts: number;
  maxAttempts: number;
}

const DEFAULTS = { length: 6, ttlSeconds: 300, maxAttempts: 5 } as const;

function hashCode(purpose: string, subject: string, code: string): string {
  // The purpose and subject are part of the digest, so a code issued to verify a phone
  // cannot be replayed against a password reset.
  return createHash('sha256').update(`${purpose}:${subject}:${code}`).digest('hex');
}

function equalsInConstantTime(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);

  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * One-time codes for phone verification, MFA and step-up confirmation. Codes are stored
 * hashed, expire on their own, and die after a handful of wrong guesses — a 6-digit code is
 * only safe while brute force is bounded.
 */
export class OtpService {
  constructor(private readonly redis: RedisConnection) {}

  async issue(purpose: string, subject: string, options: OtpOptions = {}): Promise<string> {
    const length = options.length ?? DEFAULTS.length;
    const ttlSeconds = options.ttlSeconds ?? DEFAULTS.ttlSeconds;
    const maxAttempts = options.maxAttempts ?? DEFAULTS.maxAttempts;

    let code = '';
    for (let index = 0; index < length; index += 1) {
      code += DIGITS.charAt(randomInt(DIGITS.length));
    }

    const stored: StoredOtp = { hash: hashCode(purpose, subject, code), attempts: 0, maxAttempts };

    await this.redis.client.set(
      this.key(purpose, subject),
      JSON.stringify(stored),
      'EX',
      ttlSeconds,
    );

    return code;
  }

  async verify(purpose: string, subject: string, candidate: string): Promise<OtpVerdict> {
    const key = this.key(purpose, subject);
    const raw = await this.redis.client.get(key);

    if (raw === null) {
      return 'expired';
    }

    const stored = JSON.parse(raw) as StoredOtp;

    if (equalsInConstantTime(stored.hash, hashCode(purpose, subject, candidate))) {
      await this.redis.client.del(key);
      return 'valid';
    }

    const attempts = stored.attempts + 1;

    if (attempts >= stored.maxAttempts) {
      await this.redis.client.del(key);
      return 'too-many-attempts';
    }

    // Rewriting the counter must not extend the code's life, so the remaining TTL is kept.
    const ttl = await this.redis.client.ttl(key);
    await this.redis.client.set(
      key,
      JSON.stringify({ ...stored, attempts }),
      'EX',
      ttl > 0 ? ttl : 1,
    );

    return 'invalid';
  }

  async revoke(purpose: string, subject: string): Promise<void> {
    await this.redis.client.del(this.key(purpose, subject));
  }

  private key(purpose: string, subject: string): string {
    return `${NAMESPACE}${purpose}:${subject}`;
  }
}
