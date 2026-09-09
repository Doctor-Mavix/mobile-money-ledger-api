import type { CountryCode } from 'libphonenumber-js';
import { parsePhoneNumberFromString } from 'libphonenumber-js';
import { z } from 'zod';

import { env } from '@core/config/env';

export interface ParsedPhone {
  /** `+22997000000` — the only form worth storing. */
  e164: string;
  country: string | null;
  type: 'mobile' | 'fixed-line' | 'unknown';
}

function classify(type: string | undefined): ParsedPhone['type'] {
  if (type === 'MOBILE') {
    return 'mobile';
  }

  return type === 'FIXED_LINE' ? 'fixed-line' : 'unknown';
}

/**
 * Users type `97 00 00 00`, `+229 97 00 00 00` and `0022997000000` for the same person.
 * Normalising to E.164 at the boundary is what keeps a phone number a usable lookup key.
 */
export class PhoneService {
  private readonly defaultCountry = env.DEFAULT_COUNTRY_CODE as CountryCode;

  parse(input: string, country?: string): ParsedPhone | null {
    const parsed = parsePhoneNumberFromString(
      input,
      (country as CountryCode | undefined) ?? this.defaultCountry,
    );

    if (!parsed?.isValid()) {
      return null;
    }

    return {
      e164: parsed.number,
      country: parsed.country ?? null,
      type: classify(parsed.getType()),
    };
  }

  isValid(input: string, country?: string): boolean {
    return this.parse(input, country) !== null;
  }

  /** Returns E.164, or null when the input is not a real number in that country. */
  toE164(input: string, country?: string): string | null {
    return this.parse(input, country)?.e164 ?? null;
  }
}

/**
 * Zod schema normalising as it validates, so a handler never sees an unformatted number.
 * Uses DEFAULT_COUNTRY_CODE, which is why it is a factory rather than a constant.
 */
export const zPhone = (country?: string): z.ZodType<string, string> =>
  z.string().transform((value, ctx) => {
    const e164 = new PhoneService().toE164(value, country);

    if (e164 === null) {
      ctx.addIssue({ code: 'custom', message: 'is not a valid phone number' });
      return z.NEVER;
    }

    return e164;
  });
