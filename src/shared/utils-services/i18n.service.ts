import { env } from '@core/config/env';
import en from './locales/en.json' with { type: 'json' };
import fr from './locales/fr.json' with { type: 'json' };

export const LOCALES = ['fr', 'en'] as const;
export type Locale = (typeof LOCALES)[number];

const CATALOGUES: Record<Locale, Record<string, string>> = { fr, en };

const isLocale = (value: string): value is Locale => LOCALES.some((locale) => locale === value);

/**
 * `fr-FR,fr;q=0.9,en;q=0.8` — quality values are ignored on purpose: the first supported tag
 * wins. Ordering by q against a two-locale catalogue is complexity nobody would notice.
 */
function fromAcceptLanguage(header: string): Locale | null {
  for (const part of header.split(',')) {
    const tag = part.split(';')[0]?.trim().slice(0, 2).toLowerCase() ?? '';

    if (isLocale(tag)) {
      return tag;
    }
  }

  return null;
}

/**
 * Flat key/value catalogues with `{placeholder}` interpolation. Deliberately not a full i18n
 * framework: error messages and notification templates are all this template needs to
 * localise, and a missing key must be loud rather than silently blank.
 */
export class I18nService {
  constructor(private readonly defaultLocale: Locale = env.DEFAULT_LOCALE) {}

  resolve(acceptLanguage: string | undefined): Locale {
    return acceptLanguage === undefined
      ? this.defaultLocale
      : (fromAcceptLanguage(acceptLanguage) ?? this.defaultLocale);
  }

  translate(key: string, values: Record<string, string | number> = {}, locale?: Locale): string {
    const active = locale ?? this.defaultLocale;
    // Falling back to the key surfaces a missing translation in the UI instead of hiding it.
    const template = CATALOGUES[active][key] ?? CATALOGUES[this.defaultLocale][key] ?? key;

    return template.replace(/\{(\w+)\}/g, (match, name: string) => {
      const value = values[name];

      return value === undefined ? match : String(value);
    });
  }
}
