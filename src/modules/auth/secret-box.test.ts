import { describe, expect, it } from 'vitest';

import { open, seal } from './secret-box';

const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

describe('secret box', () => {
  it('reads back what it sealed', () => {
    expect(open(seal(SECRET))).toBe(SECRET);
  });

  it('does not leak the plaintext into the stored value', () => {
    expect(seal(SECRET)).not.toContain(SECRET);
  });

  // Same input twice must not produce the same output, or equal TOTP secrets would be visible
  // as equal rows without decrypting anything.
  it('produces a different value every time', () => {
    expect(seal(SECRET)).not.toBe(seal(SECRET));
  });

  it('refuses a tampered value instead of returning something plausible', () => {
    const sealed = seal(SECRET);
    const flipped = `${sealed.slice(0, -2)}${sealed.endsWith('a') ? 'bb' : 'aa'}`;

    expect(() => open(flipped)).toThrow();
  });

  it('refuses a value it did not write', () => {
    expect(() => open(SECRET)).toThrow(/unknown format/);
  });
});
