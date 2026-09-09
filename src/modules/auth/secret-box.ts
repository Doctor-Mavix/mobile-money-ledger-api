import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

import { env } from '@core/config/env';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const PREFIX = 'v1.';

/**
 * The configured key is a passphrase of any length; AES-256 needs exactly 32 bytes. SHA-256 is
 * enough here because the input is already a high-entropy secret, not a human password.
 */
const KEY = createHash('sha256').update(env.MFA_SECRET_KEY).digest();

/**
 * Authenticated encryption for the few values the server has to read back rather than verify —
 * today, the TOTP secrets. Hashing them is not an option: reproducing the code requires the
 * secret itself, so the only protection left is that a stolen database row is unreadable
 * without a key that lives in the environment.
 *
 * The version prefix is there so a future algorithm change can be told apart from this one
 * instead of failing as corruption.
 */
export function seal(plain: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);

  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url');
}

/**
 * Throws on a wrong key, a truncated value or a flipped bit alike — GCM authenticates, so there
 * is no way to return a plausible-looking wrong answer.
 */
export function open(sealed: string): string {
  if (!sealed.startsWith(PREFIX)) {
    throw new Error('Encrypted value has an unknown format');
  }

  const raw = Buffer.from(sealed.slice(PREFIX.length), 'base64url');
  const decipher = createDecipheriv(ALGORITHM, KEY, raw.subarray(0, IV_BYTES));

  decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));

  return (
    decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)).toString('utf8') + decipher.final('utf8')
  );
}
