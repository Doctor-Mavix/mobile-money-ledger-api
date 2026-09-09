import { describe, expect, it } from 'vitest';

import { GROUP_SEPARATOR, MAX_AMOUNT, amountSchema, formatMoney, minorUnitDigits } from './money';

const sep = GROUP_SEPARATOR;

describe('amountSchema', () => {
  it('reads digits as minor units', () => {
    expect(amountSchema.parse('1')).toBe(1n);
    expect(amountSchema.parse('750000')).toBe(750_000n);
  });

  /**
   * A single amount is capped below `Number.MAX_SAFE_INTEGER` (≈9·10¹⁵), so one movement would
   * in fact survive a double. Balances are what do not: a house wallet holds the negative of
   * everything ever issued, and nothing bounds that by `MAX_AMOUNT`. The string form is chosen
   * for the value that accumulates, not for the one that is validated.
   */
  it('caps a single amount below the range a double stops being exact in', () => {
    expect(MAX_AMOUNT).toBeLessThan(BigInt(Number.MAX_SAFE_INTEGER));
  });

  it('reads back a balance beyond the exact range of a double', () => {
    // 2⁵³+1, the smallest whole number a double cannot hold.
    const accumulated = BigInt(Number.MAX_SAFE_INTEGER) + 2n;

    expect(BigInt(accumulated.toString())).toBe(accumulated);
    expect(formatMoney(accumulated, 'XOF')).toBe(
      `9${sep}007${sep}199${sep}254${sep}740${sep}993 XOF`,
    );
    // The same value through a JSON number comes back as its neighbour, silently.
    expect(Number(accumulated).toString()).toBe('9007199254740992');
  });

  it.each(['0', '-1', '12.50', '1e3', '', ' 12', '0x10', '١٢'])('refuses %o', (input) => {
    expect(amountSchema.safeParse(input).success).toBe(false);
  });

  it('refuses an amount above the ceiling but accepts the ceiling itself', () => {
    expect(amountSchema.parse(MAX_AMOUNT.toString())).toBe(MAX_AMOUNT);
    expect(amountSchema.safeParse((MAX_AMOUNT + 1n).toString()).success).toBe(false);
  });

  it('refuses anything that is not a string', () => {
    for (const input of [1200, null, undefined, {}, ['12']]) {
      expect(amountSchema.safeParse(input).success).toBe(false);
    }
  });
});

describe('formatMoney', () => {
  it('prints a currency with no minor unit as whole units', () => {
    expect(minorUnitDigits('XOF')).toBe(0);
    expect(formatMoney(750_000n, 'XOF')).toBe(`750${sep}000 XOF`);
    expect(formatMoney(0n, 'XOF')).toBe('0 XOF');
  });

  it('places the decimal comma for a currency with two minor digits', () => {
    expect(minorUnitDigits('EUR')).toBe(2);
    expect(formatMoney(1_234_567n, 'EUR')).toBe(`12${sep}345,67 EUR`);
    // Padded, not truncated: five cents is 0,05 and never 5.
    expect(formatMoney(5n, 'EUR')).toBe('0,05 EUR');
    expect(formatMoney(0n, 'EUR')).toBe('0,00 EUR');
  });

  it('keeps the sign outside the digits, so a system wallet reads correctly', () => {
    expect(formatMoney(-750_000n, 'XOF')).toBe(`-750${sep}000 XOF`);
    expect(formatMoney(-5n, 'EUR')).toBe('-0,05 EUR');
  });

  it('groups only in threes, whatever the length', () => {
    expect(formatMoney(1n, 'XOF')).toBe('1 XOF');
    expect(formatMoney(1_000n, 'XOF')).toBe(`1${sep}000 XOF`);
    expect(formatMoney(1_000_000_000n, 'XOF')).toBe(`1${sep}000${sep}000${sep}000 XOF`);
  });

  it('separates groups with a narrow no-break space, not a space', () => {
    expect(GROUP_SEPARATOR.codePointAt(0)).toBe(0x202f);
    expect(formatMoney(1_000n, 'XOF')).not.toContain(' 000');
  });
});
