import { randomBytes, randomUUID } from 'node:crypto';

import { Secret, TOTP } from 'otpauth';

import { env } from '@core/config/env';
import { BadRequestError, ConflictError, UnauthorizedError } from '@core/errors/app-error';
import type { RedisConnection } from '@core/redis/redis.client';
import type { QrCodeService } from '@shared/utils-services/qrcode.service';
import type { AuthRepository } from './auth.repository';
import type { PasswordService } from './password.service';
import { open, seal } from './secret-box';
import type { ActorType, ActorWithSecrets } from './auth.types';

const CHALLENGE_KEY = 'auth:mfa-challenge:';
const BACKUP_CODE_COUNT = 10;
const BACKUP_CODE_BYTES = 5;
/** One step of tolerance: phone clocks drift, and 30 seconds either way is the usual allowance. */
const TOTP_WINDOW = 1;
const MAX_CHALLENGE_ATTEMPTS = 5;

export interface MfaSetup {
  secret: string;
  otpauthUrl: string;
  qrCodeDataUrl: string;
}

export interface MfaActivation {
  backupCodes: readonly string[];
}

interface StoredChallenge {
  actorId: string;
  actorType: ActorType;
  attempts: number;
}

export class MfaService {
  constructor(
    private readonly repository: AuthRepository,
    private readonly redis: RedisConnection,
    private readonly passwords: PasswordService,
    private readonly qrCodes: QrCodeService,
  ) {}

  /**
   * Stores the secret but leaves MFA off until a first code proves the phone actually holds it.
   * Enabling on setup would lock out anyone who scans a QR code and loses the phone before the
   * first login.
   */
  async beginSetup(actorId: string): Promise<MfaSetup> {
    const found = await this.require(actorId);

    if (found.actor.mfaEnabledAt !== null) {
      throw new ConflictError('Two-factor authentication is already enabled');
    }

    const secret = new Secret({ size: 20 });
    const totp = this.totp(found.actor.email, secret.base32);

    await this.repository.updateActor(actorId, { mfaSecret: seal(secret.base32) });

    const otpauthUrl = totp.toString();

    return {
      secret: secret.base32,
      otpauthUrl,
      qrCodeDataUrl: await this.qrCodes.toDataUrl(otpauthUrl),
    };
  }

  async confirmSetup(actorId: string, code: string): Promise<MfaActivation> {
    const found = await this.require(actorId);

    if (found.secrets.mfaSecret === null) {
      throw new BadRequestError('Start the two-factor setup first');
    }

    if (!this.isValidTotp(found.actor.email, found.secrets.mfaSecret, code)) {
      throw new UnauthorizedError('This code is not valid');
    }

    const codes = Array.from({ length: BACKUP_CODE_COUNT }, () =>
      randomBytes(BACKUP_CODE_BYTES).toString('hex'),
    );
    const hashes = await Promise.all(codes.map(async (code) => this.passwords.hash(code)));

    await this.repository.updateActor(actorId, {
      mfaEnabledAt: new Date(),
      mfaBackupCodes: hashes,
    });

    // Returned once and never again: they are stored hashed, so the server cannot show them
    // a second time even if asked.
    return { backupCodes: codes };
  }

  /** Used for step-up outside a login challenge, where there is no challenge token to spend. */
  async verifyForActor(found: ActorWithSecrets, code: string): Promise<boolean> {
    if (
      found.secrets.mfaSecret !== null &&
      this.isValidTotp(found.actor.email, found.secrets.mfaSecret, code)
    ) {
      return true;
    }

    return this.spendBackupCode(found, code);
  }

  async disable(actorId: string): Promise<void> {
    await this.repository.updateActor(actorId, {
      mfaEnabledAt: null,
      mfaSecret: null,
      mfaBackupCodes: [],
    });
  }

  /** Short-lived, single-purpose, and worth nothing on its own — it is not an access token. */
  async issueChallenge(actorId: string, actorType: ActorType): Promise<string> {
    const token = randomUUID();
    const challenge: StoredChallenge = { actorId, actorType, attempts: 0 };

    await this.redis.client.set(
      CHALLENGE_KEY + token,
      JSON.stringify(challenge),
      'EX',
      env.MFA_CHALLENGE_TTL_SECONDS,
    );

    return token;
  }

  /**
   * Accepts a TOTP code or a backup code. Backup codes are argon2 hashes checked one by one,
   * which is slow by design; there are ten of them, so the cost is bounded.
   */
  async verifyChallenge(
    token: string,
    code: string,
  ): Promise<{ actor: ActorWithSecrets; usedBackupCode: boolean }> {
    const key = CHALLENGE_KEY + token;
    const raw = await this.redis.client.get(key);

    if (raw === null) {
      throw new UnauthorizedError('This challenge has expired, sign in again');
    }

    const challenge = JSON.parse(raw) as StoredChallenge;
    const found = await this.require(challenge.actorId);

    if (
      found.secrets.mfaSecret !== null &&
      this.isValidTotp(found.actor.email, found.secrets.mfaSecret, code)
    ) {
      await this.redis.client.del(key);
      return { actor: found, usedBackupCode: false };
    }

    const spent = await this.spendBackupCode(found, code);

    if (spent) {
      await this.redis.client.del(key);
      return { actor: found, usedBackupCode: true };
    }

    await this.registerFailedAttempt(key, challenge);

    throw new UnauthorizedError('This code is not valid');
  }

  private async spendBackupCode(found: ActorWithSecrets, code: string): Promise<boolean> {
    for (const hash of found.secrets.mfaBackupCodes) {
      if (await this.passwords.verify(hash, code)) {
        await this.repository.updateActor(found.actor.id, {
          mfaBackupCodes: found.secrets.mfaBackupCodes.filter((entry) => entry !== hash),
        });

        return true;
      }
    }

    return false;
  }

  private async registerFailedAttempt(key: string, challenge: StoredChallenge): Promise<void> {
    const attempts = challenge.attempts + 1;

    // Destroying the challenge rather than the account: the attacker has to go back through
    // the password step, and the legitimate owner is never locked out by someone else's guesses.
    if (attempts >= MAX_CHALLENGE_ATTEMPTS) {
      await this.redis.client.del(key);
      return;
    }

    const ttl = await this.redis.client.ttl(key);

    await this.redis.client.set(
      key,
      JSON.stringify({ ...challenge, attempts }),
      'EX',
      ttl > 0 ? ttl : 1,
    );
  }

  /** Takes the stored value, so decryption happens in the one place secrets come back from. */
  private isValidTotp(email: string, sealedSecret: string, code: string): boolean {
    return (
      this.totp(email, open(sealedSecret)).validate({ token: code, window: TOTP_WINDOW }) !== null
    );
  }

  private totp(email: string, secret: string): TOTP {
    return new TOTP({
      issuer: env.APP_NAME,
      label: email,
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret: Secret.fromBase32(secret),
    });
  }

  private async require(actorId: string): Promise<ActorWithSecrets> {
    const found = await this.repository.findById(actorId);

    if (found === null) {
      throw new UnauthorizedError('Your session is no longer valid');
    }

    return found;
  }
}
