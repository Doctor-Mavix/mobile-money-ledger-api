import { customAlphabet } from 'nanoid';
import { v7 as uuidv7 } from 'uuid';

/**
 * Crockford base32 minus the characters that collide when a code is read aloud or copied
 * by hand: I and 1, O and 0, U and V.
 */
const READABLE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const DEFAULT_CODE_LENGTH = 8;

const readableCode = customAlphabet(READABLE_ALPHABET, DEFAULT_CODE_LENGTH);

/**
 * The two kinds of identifier an application needs, and the reason they are not the same one.
 */
export class IdService {
  /**
   * UUID v7: time-ordered, so rows inserted in sequence land next to each other in the index
   * instead of scattering random pages the way v4 does. Use it for primary keys.
   */
  uuid(): string {
    return uuidv7();
  }

  /**
   * A short code a human will read, dictate or type: an order reference, an invitation code.
   * Not a primary key — it trades collision resistance for being copyable.
   */
  code(length: number = DEFAULT_CODE_LENGTH): string {
    return length === DEFAULT_CODE_LENGTH
      ? readableCode()
      : customAlphabet(READABLE_ALPHABET, length)();
  }

  /** `INV-2026-7Q4XKB` — a prefixed, dated reference for anything an account holder keeps. */
  reference(prefix: string, length = 6, now = new Date()): string {
    return `${prefix.toUpperCase()}-${now.getUTCFullYear()}-${this.code(length)}`;
  }
}
