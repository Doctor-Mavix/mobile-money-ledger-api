import { afterEach, describe, expect, it, vi } from 'vitest';

import { HttpClientService } from './http-client.service';
import { I18nService } from './i18n.service';
import { IdService } from './id.service';
import { PhoneService } from './phone.service';
import { SlugService } from './slug.service';

describe('I18nService', () => {
  const i18n = new I18nService('fr');

  it('interpolates the placeholders it is given and leaves the others alone', () => {
    expect(i18n.translate('auth.verify.body', { code: '123456' })).toBe(
      'Votre code de confirmation est 123456. Il expire dans 24 heures.',
    );
    expect(i18n.translate('auth.verify.body')).toBe(
      'Votre code de confirmation est {code}. Il expire dans 24 heures.',
    );
  });

  it('falls back to the default locale, then to the key itself', () => {
    expect(i18n.translate('email.greeting', {}, 'en')).toBe('Hello');
    // A missing key must be visible in the interface, not silently blank.
    expect(i18n.translate('nothing.here')).toBe('nothing.here');
  });

  it('picks the first supported tag of Accept-Language', () => {
    expect(i18n.resolve('en-GB,en;q=0.9,fr;q=0.8')).toBe('en');
    expect(i18n.resolve('de-DE,de;q=0.9')).toBe('fr');
    expect(i18n.resolve(undefined)).toBe('fr');
  });
});

describe('SlugService', () => {
  const slugs = new SlugService();

  it('strips accents and punctuation', () => {
    expect(slugs.slugify('Lampadaire éteint, carrefour Étoile !')).toBe(
      'lampadaire-eteint-carrefour-etoile',
    );
  });

  it('suffixes until the candidate is free', async () => {
    const taken = new Set(['voirie', 'voirie-2']);

    expect(await slugs.unique('Voirie', (candidate) => Promise.resolve(taken.has(candidate)))).toBe(
      'voirie-3',
    );
  });
});

describe('PhoneService', () => {
  const phones = new PhoneService();

  it('reads a local Benin number as E.164', () => {
    expect(phones.toE164('01 97 00 00 00')).toBe('+2290197000000');
    expect(phones.toE164('+229 01 97 00 00 00')).toBe('+2290197000000');
  });

  it('rejects what is not a real number', () => {
    expect(phones.toE164('12')).toBeNull();
    expect(phones.isValid('not a phone')).toBe(false);
    // Benin moved to 10 digits in 2024: the old 8-digit form is now invalid, and accepting it
    // would let us store numbers nobody can call.
    expect(phones.toE164('97 00 00 00')).toBeNull();
  });
});

describe('IdService', () => {
  const ids = new IdService();

  it('mints time-ordered uuids', () => {
    const first = ids.uuid();
    const second = ids.uuid();

    // v7 sorts by creation time as a string, which is the whole point of using it as a key.
    expect(first < second).toBe(true);
    expect(first).toHaveLength(36);
  });

  it('mints short codes without the characters that get misread', () => {
    expect(ids.code(10)).toMatch(/^[0-9A-HJ-KM-NP-TV-Z]{10}$/);
    expect(ids.reference('PLT', 6, new Date('2026-08-20T00:00:00Z'))).toMatch(
      /^PLT-2026-[0-9A-HJ-KM-NP-TV-Z]{6}$/,
    );
  });
});

describe('HttpClientService', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const jsonResponse = (status: number): Response =>
    new Response(JSON.stringify({ ok: status < 400 }), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  it('retries a 500 and returns the answer that finally works', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(500))
      .mockResolvedValueOnce(jsonResponse(200));
    vi.stubGlobal('fetch', fetchMock);

    const client = new HttpClientService({ attempts: 3, retryDelayMs: 1 });

    await expect(client.request('https://provider.test/pay')).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry a 400: the answer would be identical', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(400));
    vi.stubGlobal('fetch', fetchMock);

    const client = new HttpClientService({ attempts: 3, retryDelayMs: 1 });
    const response = await client.send('https://provider.test/pay');

    expect(response.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('opens the breaker and stops calling a provider that keeps failing', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(503));
    vi.stubGlobal('fetch', fetchMock);

    const client = new HttpClientService({
      attempts: 1,
      retryDelayMs: 1,
      failureThreshold: 2,
      breakerResetMs: 10_000,
    });

    await expect(client.send('https://down.test/a')).rejects.toThrow();
    await expect(client.send('https://down.test/b')).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Third call is refused locally: the host is known to be down.
    await expect(client.send('https://down.test/c')).rejects.toThrow('Circuit open for down.test');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
