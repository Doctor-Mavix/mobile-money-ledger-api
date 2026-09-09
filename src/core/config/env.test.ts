import { describe, expect, it } from 'vitest';

import { EnvValidationError } from '@core/config/env-validation-error';
import { parseEnv } from '@core/config/env';

const base = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  JWT_ACCESS_SECRET: 'access-secret-0123456789abcdef0123456789',
  JWT_REFRESH_SECRET: 'refresh-secret-0123456789abcdef0123456789',
  MFA_SECRET_KEY: 'mfa-secret-key-0123456789abcdef0123456789',
} satisfies NodeJS.ProcessEnv;

describe('parseEnv', () => {
  it('applies documented defaults', () => {
    const env = parseEnv(base);

    expect(env.PORT).toBe(3000);
    expect(env.API_PREFIX).toBe('/api/v1');
    expect(env.MODULES_ENABLED).toEqual(['*']);
    expect(env.LOG_PRETTY).toBe(false);
  });

  it('splits comma separated lists and trims entries', () => {
    const env = parseEnv({ ...base, CORS_ORIGINS: 'https://a.bj , https://b.bj' });

    expect(env.CORS_ORIGINS).toEqual(['https://a.bj', 'https://b.bj']);
  });

  it('rejects a port outside the valid range', () => {
    expect(() => parseEnv({ ...base, PORT: '70000' })).toThrow(EnvValidationError);
  });

  it('rejects an API prefix that is not a path', () => {
    expect(() => parseEnv({ ...base, API_PREFIX: 'api/v1' })).toThrow(EnvValidationError);
  });

  it('rejects a body limit that is not a byte size', () => {
    expect(() => parseEnv({ ...base, BODY_LIMIT: 'huge' })).toThrow(EnvValidationError);
  });

  it('refuses to boot in production without a CORS whitelist', () => {
    expect(() => parseEnv({ ...base, NODE_ENV: 'production' })).toThrow(/CORS_ORIGINS/);
  });

  it('refuses a wildcard CORS whitelist in production', () => {
    expect(() => parseEnv({ ...base, NODE_ENV: 'production', CORS_ORIGINS: '*' })).toThrow(
      /CORS_ORIGINS/,
    );
  });

  it('accepts an explicit production whitelist', () => {
    const env = parseEnv({
      ...base,
      NODE_ENV: 'production',
      CORS_ORIGINS: 'https://app.bj',
      DOCS_PASSWORD: 'docs-secret',
    });

    expect(env.CORS_ORIGINS).toEqual(['https://app.bj']);
  });

  it('refuses to publish the docs without a password in production', () => {
    const production = { ...base, NODE_ENV: 'production', CORS_ORIGINS: 'https://app.bj' };

    expect(() => parseEnv(production)).toThrow(/DOCS_PASSWORD/);
    expect(parseEnv({ ...production, DOCS_ENABLED: 'false' }).DOCS_ENABLED).toBe(false);
  });

  it('requires DATABASE_URL', () => {
    expect(() => parseEnv({ NODE_ENV: 'development' })).toThrow(/DATABASE_URL/);
  });

  it('refuses the same secret for access and refresh tokens', () => {
    expect(() => parseEnv({ ...base, JWT_REFRESH_SECRET: base.JWT_ACCESS_SECRET })).toThrow(
      /JWT_REFRESH_SECRET/,
    );
  });

  it('refuses an MFA key that is also a JWT secret', () => {
    expect(() => parseEnv({ ...base, MFA_SECRET_KEY: base.JWT_ACCESS_SECRET })).toThrow(
      /MFA_SECRET_KEY/,
    );
    expect(() => parseEnv({ ...base, MFA_SECRET_KEY: base.JWT_REFRESH_SECRET })).toThrow(
      /MFA_SECRET_KEY/,
    );
  });

  it('rejects a DATABASE_URL that is not PostgreSQL', () => {
    expect(() => parseEnv({ ...base, DATABASE_URL: 'mongodb://localhost:27017/fintech' })).toThrow(
      /DATABASE_URL.*DB_PROVIDER is "postgres"/s,
    );
  });

  // The template accepts `mongodb`; this project removed that half, so the value has to be
  // refused at boot rather than accepted into a wiring that no longer exists.
  it('refuses DB_PROVIDER=mongodb', () => {
    expect(() => parseEnv({ ...base, DB_PROVIDER: 'mongodb' })).toThrow(/DB_PROVIDER/);
  });
});
