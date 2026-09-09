import slugify from 'slugify';

const MAX_SUFFIX = 50;

export interface SlugOptions {
  maxLength?: number;
}

const DEFAULT_MAX_LENGTH = 80;

/** Whether a candidate slug is already taken. Usually a repository lookup. */
export type SlugExists = (candidate: string) => Promise<boolean>;

export class SlugService {
  slugify(input: string, options: SlugOptions = {}): string {
    const slug = slugify(input, { lower: true, strict: true, trim: true, locale: 'fr' });

    return slug.slice(0, options.maxLength ?? DEFAULT_MAX_LENGTH).replace(/-+$/, '');
  }

  /**
   * Appends -2, -3 ... until the slug is free. The caller owns the uniqueness check because
   * only it knows the scope: unique per site, per tenant, or per author.
   */
  async unique(input: string, exists: SlugExists, options: SlugOptions = {}): Promise<string> {
    const base = this.slugify(input, options);

    if (!(await exists(base))) {
      return base;
    }

    for (let suffix = 2; suffix <= MAX_SUFFIX; suffix += 1) {
      const candidate = `${base}-${suffix}`;

      if (!(await exists(candidate))) {
        return candidate;
      }
    }

    // Past fifty near-identical titles, a readable suffix is no longer worth the round trips.
    return `${base}-${Date.now().toString(36)}`;
  }
}
