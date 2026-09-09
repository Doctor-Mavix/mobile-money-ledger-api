import { hash, verify } from '@node-rs/argon2';

import { env } from '@core/config/env';

/**
 * argon2id, with the cost read from the environment so a deployment can raise it without a
 * code change. The parameters are stored inside the hash string, so raising them later does
 * not invalidate existing passwords: old hashes keep verifying with their own settings.
 */
export class PasswordService {
  private readonly options = {
    memoryCost: env.ARGON2_MEMORY_COST,
    timeCost: env.ARGON2_TIME_COST,
    parallelism: env.ARGON2_PARALLELISM,
  };

  hash(plain: string): Promise<string> {
    return hash(plain, this.options);
  }

  async verify(digest: string, plain: string): Promise<boolean> {
    try {
      return await verify(digest, plain, this.options);
    } catch {
      // A malformed hash is a corrupt row, not a valid password. Returning false keeps the
      // caller on the single "credentials are wrong" path instead of leaking a 500 that would
      // tell an attacker this particular account exists and is broken.
      return false;
    }
  }

  /**
   * Burns roughly the time a real verification would, so a request for an unknown account is
   * not visibly faster than one for an existing account. Without it, response timing alone
   * enumerates the user base and the uniform error message buys nothing.
   *
   * Hashing rather than verifying a canned digest: argon2 rejects a malformed digest before
   * doing any work, so a hard-coded one would cost nothing and silently defeat the purpose.
   */
  async wasteTime(): Promise<void> {
    await this.hash(TIMING_EQUALIZER);
  }
}

const TIMING_EQUALIZER = 'timing-equalizer';
