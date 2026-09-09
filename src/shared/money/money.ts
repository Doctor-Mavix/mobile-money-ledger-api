import { z } from 'zod';

/**
 * Money is a `bigint` of minor units from the database row to the JSON boundary, and never a
 * `number`: 0.1 + 0.2 is not 0.3 in a float, and a balance that is off by a hundredth of a
 * franc once a day is a reconciliation job nobody asked for.
 *
 * It leaves as a string of digits rather than a JSON number, because `JSON.stringify` throws on
 * a bigint and silently rounds anything past 2^53 once you convert it to a number to avoid the
 * throw. A string of minor units survives both.
 */
export const CURRENCIES = ['XOF', 'EUR', 'USD'] as const;

export type Currency = (typeof CURRENCIES)[number];

/**
 * How many digits of the minor unit each currency carries. The franc CFA has none — 1 XOF is
 * one indivisible unit — which is exactly why the exponent has to be data and not a hard-coded
 * `100` somewhere in a formatter.
 */
const MINOR_UNIT_DIGITS: Record<Currency, number> = { XOF: 0, EUR: 2, USD: 2 };

/**
 * A ceiling on a single amount, well under the `BIGINT` column and far above any legitimate
 * movement. It exists so a caller cannot post 10^300 and turn every later balance arithmetic
 * into a number the column cannot hold.
 */
export const MAX_AMOUNT = 10n ** 15n;

const DIGITS = /^\d+$/;

export const currencySchema = z.enum(CURRENCIES);

/**
 * Accepts the wire form — a plain string of minor-unit digits — and refuses everything a
 * `Number()` cast would have quietly accepted: an empty string, a sign, an exponent, a decimal
 * point, whitespace.
 */
export const amountSchema = z
  .string()
  .regex(DIGITS, 'must be a whole number of minor units, written as digits only')
  .transform((value) => BigInt(value))
  .refine((value) => value > 0n, 'must be greater than zero')
  .refine((value) => value <= MAX_AMOUNT, `must not exceed ${MAX_AMOUNT.toString()} minor units`);

export function minorUnitDigits(currency: Currency): number {
  return MINOR_UNIT_DIGITS[currency];
}

/**
 * Narrow no-break space (U+202F): the French thousands separator, and one a PDF will not break
 * across a line. Written as an escape rather than as the character itself — a literal U+202F is
 * indistinguishable from a space on screen, so no reviewer could check it and any editor that
 * normalises whitespace would silently change every printed amount.
 */
export const GROUP_SEPARATOR = '\u202f';

/**
 * Human form, for the statement and nothing else. Built by slicing the digits rather than by
 * dividing, so it stays exact for amounts a `number` could not represent.
 */
export function formatMoney(amount: bigint, currency: Currency): string {
  const digits = MINOR_UNIT_DIGITS[currency];
  const negative = amount < 0n;
  const raw = (negative ? -amount : amount).toString().padStart(digits + 1, '0');
  const whole = raw.slice(0, raw.length - digits);
  const fraction = raw.slice(raw.length - digits);
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/gu, GROUP_SEPARATOR);
  const sign = negative ? '-' : '';

  return `${sign}${grouped}${fraction === '' ? '' : `,${fraction}`} ${currency}`;
}
