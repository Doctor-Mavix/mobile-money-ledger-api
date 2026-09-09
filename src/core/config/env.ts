import { z } from 'zod';

import type { EnvIssue } from '@core/config/env-validation-error';
import { EnvValidationError } from '@core/config/env-validation-error';

const booleanFlag = (defaultValue: 'true' | 'false'): z.ZodType<boolean, string | undefined> =>
  z
    .enum(['true', 'false', '1', '0'])
    .default(defaultValue)
    .transform((value) => value === 'true' || value === '1');

const csvList = (defaultValue: string): z.ZodType<string[], string | undefined> =>
  z
    .string()
    .default(defaultValue)
    .transform((value) =>
      value
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
    );

const durationMs = (defaultValue: number): z.ZodType<number> =>
  z.coerce.number().int().positive().max(600_000).default(defaultValue);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_NAME: z.string().min(1).default('orangcode-api'),
  APP_VERSION: z.string().min(1).default('0.1.0'),
  API_PREFIX: z.string().startsWith('/').default('/api/v1'),

  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  TRUST_PROXY: z.string().min(1).default('loopback'),
  BODY_LIMIT: z
    .string()
    .regex(/^\d+(b|kb|mb)$/i, 'must be a byte size such as "100kb" or "1mb"')
    .default('1mb'),

  CORS_ORIGINS: csvList(''),
  MODULES_ENABLED: csvList('*'),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  LOG_PRETTY: booleanFlag('false'),

  REQUEST_TIMEOUT_MS: durationMs(30_000),
  HEADERS_TIMEOUT_MS: durationMs(35_000),
  KEEP_ALIVE_TIMEOUT_MS: durationMs(65_000),
  SHUTDOWN_TIMEOUT_MS: durationMs(15_000),

  /**
   * Narrowed to a single value, unlike the template it comes from. A ledger needs the
   * database to enforce that a balance never goes negative and that a transfer either debits
   * and credits or does neither; the MongoDB half was removed rather than left as a trap.
   */
  DB_PROVIDER: z.enum(['postgres']).default('postgres'),
  DATABASE_URL: z.string().min(1),
  DB_POOL_SIZE: z.coerce.number().int().min(1).max(1_000).default(10),
  DB_CONNECT_TIMEOUT_MS: durationMs(10_000),
  /** Queries slower than this are logged at warn level so hot spots surface without a profiler. */
  DB_SLOW_QUERY_MS: durationMs(200),

  REDIS_URL: z.string().min(1).default('redis://127.0.0.1:6379'),
  /** Namespaces every key so several apps can share one Redis instance safely. */
  REDIS_KEY_PREFIX: z.string().default('orangcode:'),

  RATE_LIMIT_ENABLED: booleanFlag('true'),
  RATE_LIMIT_WINDOW_MS: durationMs(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(120),

  /**
   * Background jobs. Disabled means the queues are never created and every job runs inline;
   * useful in tests, never in production, where a slow email would block a request.
   */
  QUEUE_ENABLED: booleanFlag('true'),
  QUEUE_PREFIX: z.string().min(1).default('jobs'),
  QUEUE_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(5),
  QUEUE_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(3),

  /** Empty SMTP_HOST selects the no-op mailer, which logs instead of sending. */
  SMTP_HOST: z.string().default(''),
  SMTP_PORT: z.coerce.number().int().min(1).max(65_535).default(1025),
  SMTP_SECURE: booleanFlag('false'),
  SMTP_USER: z.string().default(''),
  SMTP_PASSWORD: z.string().default(''),
  MAIL_FROM: z.string().default('OrangCode <no-reply@orangcode.local>'),

  /** Empty S3_ENDPOINT selects the no-op storage: uploads then fail with a clear message. */
  S3_ENDPOINT: z.string().default(''),
  S3_REGION: z.string().min(1).default('us-east-1'),
  S3_BUCKET: z.string().min(1).default('orangcode-media'),
  S3_ACCESS_KEY: z.string().default(''),
  S3_SECRET_KEY: z.string().default(''),
  /** MinIO needs path-style addressing; AWS S3 does not. */
  S3_FORCE_PATH_STYLE: booleanFlag('true'),
  S3_URL_EXPIRY_SECONDS: z.coerce.number().int().min(60).max(604_800).default(3600),

  MEDIA_MAX_UPLOAD_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .max(200 * 1024 * 1024)
    .default(10 * 1024 * 1024),

  REALTIME_ENABLED: booleanFlag('true'),
  REALTIME_PATH: z.string().startsWith('/').default('/realtime'),

  /**
   * Swagger UI and the document it reads. An empty DOCS_PASSWORD leaves them open, which is
   * convenient locally and refused in production: a route map is free reconnaissance.
   */
  DOCS_ENABLED: booleanFlag('true'),
  DOCS_PATH: z.string().startsWith('/').default('/docs'),
  DOCS_USER: z.string().min(1).default('docs'),
  DOCS_PASSWORD: z.string().default(''),

  /**
   * No default, ever. A signing key with a fallback value is a signing key an attacker already
   * has, and it would only be noticed the day someone forges a token in production.
   * Access and refresh use distinct secrets so leaking one does not yield the other.
   */
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  JWT_ISSUER: z.string().min(1).default('orangcode'),
  JWT_AUDIENCE: z.string().min(1).default('orangcode-api'),
  /** Short on purpose: revocation is carried by the session, not by the access token. */
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3_600).default(900),
  REFRESH_TOKEN_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(3_600)
    .max(90 * 86_400)
    .default(30 * 86_400),
  MFA_CHALLENGE_TTL_SECONDS: z.coerce.number().int().min(60).max(1_800).default(300),
  /**
   * Encrypts the TOTP secrets at rest. A password can be hashed, a TOTP secret cannot: the
   * server has to reproduce the code, so it must be able to read it back. Without this key
   * a database dump would hand over every second factor along with it.
   *
   * Rotating it makes the stored secrets unreadable and forces everyone to enrol again.
   */
  MFA_SECRET_KEY: z.string().min(32),

  /** OWASP: length beats arbitrary composition rules, which only push users to Passw0rd!. */
  PASSWORD_MIN_LENGTH: z.coerce.number().int().min(8).max(128).default(12),
  /** ~64 MiB and 3 passes: the OWASP argon2id baseline. Raise once the host is known. */
  ARGON2_MEMORY_COST: z.coerce.number().int().min(8_192).default(65_536),
  ARGON2_TIME_COST: z.coerce.number().int().min(2).max(10).default(3),
  ARGON2_PARALLELISM: z.coerce.number().int().min(1).max(16).default(1),

  /** Failed logins are counted per account AND per IP: neither alone stops a spray attack. */
  LOGIN_MAX_ATTEMPTS: z.coerce.number().int().min(3).max(50).default(5),
  LOGIN_LOCKOUT_BASE_SECONDS: z.coerce.number().int().min(1).max(3_600).default(30),
  LOGIN_LOCKOUT_MAX_SECONDS: z.coerce.number().int().min(60).max(86_400).default(3_600),

  DEFAULT_LOCALE: z.enum(['fr', 'en']).default('fr'),
  /** Used by PhoneService to read local numbers such as 97 00 00 00 as +229 97 00 00 00. */
  DEFAULT_COUNTRY_CODE: z.string().length(2).toUpperCase().default('BJ'),
});

export type Env = z.infer<typeof envSchema>;

const DATABASE_URL_PROTOCOLS = {
  postgres: ['postgres:', 'postgresql:'],
} as const satisfies Record<Env['DB_PROVIDER'], readonly string[]>;

function protocolOf(url: string): string | undefined {
  try {
    return new URL(url).protocol;
  } catch {
    return undefined;
  }
}

/** Catches the classic mistake of switching DB_PROVIDER while leaving the old DATABASE_URL. */
function collectDatabaseIssues(candidate: Env): EnvIssue[] {
  const expected = DATABASE_URL_PROTOCOLS[candidate.DB_PROVIDER];
  const actual = protocolOf(candidate.DATABASE_URL);

  if (actual === undefined) {
    return [{ variable: 'DATABASE_URL', message: 'is not a valid connection URL' }];
  }

  if (!expected.some((protocol) => protocol === actual)) {
    return [
      {
        variable: 'DATABASE_URL',
        message:
          `uses "${actual}//" but DB_PROVIDER is "${candidate.DB_PROVIDER}", ` +
          `which expects ${expected.map((protocol) => `"${protocol}//"`).join(' or ')}`,
      },
    ];
  }

  return [];
}

function collectSecurityIssues(candidate: Env): EnvIssue[] {
  const issues: EnvIssue[] = [];

  // Reusing one secret for both means a leaked access key also mints refresh tokens, which is
  // the difference between a 15-minute problem and a 30-day one.
  if (candidate.JWT_ACCESS_SECRET === candidate.JWT_REFRESH_SECRET) {
    issues.push({
      variable: 'JWT_REFRESH_SECRET',
      message: 'must differ from JWT_ACCESS_SECRET',
    });
  }

  // Shared with a JWT secret, rotating that secret would quietly make every stored TOTP secret
  // undecryptable, and the lockout would only show up at the next sign-in.
  if (
    candidate.MFA_SECRET_KEY === candidate.JWT_ACCESS_SECRET ||
    candidate.MFA_SECRET_KEY === candidate.JWT_REFRESH_SECRET
  ) {
    issues.push({
      variable: 'MFA_SECRET_KEY',
      message: 'must differ from the JWT secrets',
    });
  }

  if (candidate.NODE_ENV === 'production') {
    if (candidate.CORS_ORIGINS.length === 0) {
      issues.push({
        variable: 'CORS_ORIGINS',
        message: 'is required in production — an empty whitelist would accept every origin',
      });
    }
    if (candidate.CORS_ORIGINS.includes('*')) {
      issues.push({
        variable: 'CORS_ORIGINS',
        message: 'must not contain "*" in production — list the allowed origins explicitly',
      });
    }
    if (candidate.DOCS_ENABLED && candidate.DOCS_PASSWORD === '') {
      issues.push({
        variable: 'DOCS_PASSWORD',
        message: 'is required in production — set it, or turn DOCS_ENABLED off',
      });
    }
  }

  return issues;
}

/**
 * A half-configured service is worse than an unconfigured one: the unconfigured one falls back
 * to a no-op provider that says so, the half-configured one fails on the first real upload.
 */
function collectKitIssues(candidate: Env): EnvIssue[] {
  const issues: EnvIssue[] = [];

  if (candidate.S3_ENDPOINT !== '') {
    if (candidate.S3_ACCESS_KEY === '' || candidate.S3_SECRET_KEY === '') {
      issues.push({
        variable: 'S3_ACCESS_KEY',
        message: 'and S3_SECRET_KEY are required as soon as S3_ENDPOINT is set',
      });
    }
    if (protocolOf(candidate.S3_ENDPOINT) === undefined) {
      issues.push({ variable: 'S3_ENDPOINT', message: 'must be a full URL, scheme included' });
    }
  }

  return issues;
}

export function parseEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);

  if (!result.success) {
    throw new EnvValidationError(
      result.error.issues.map((issue) => ({
        variable: issue.path.map(String).join('.') || '(root)',
        message: issue.message,
      })),
    );
  }

  const issues = [
    ...collectSecurityIssues(result.data),
    ...collectDatabaseIssues(result.data),
    ...collectKitIssues(result.data),
  ];
  if (issues.length > 0) {
    throw new EnvValidationError(issues);
  }

  return result.data;
}

export const env: Env = parseEnv();

export const isProduction = env.NODE_ENV === 'production';
