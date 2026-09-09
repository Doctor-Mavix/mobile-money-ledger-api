import { pino } from 'pino';
import type { Logger as PinoLogger } from 'pino';

import { env } from '@core/config/env';
import { requestContext } from '@core/http/request-context';

const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'password',
  'currentPassword',
  'newPassword',
  'token',
  'accessToken',
  'refreshToken',
  'secret',
  'apiKey',
  'authorization',
  '*.password',
  '*.currentPassword',
  '*.newPassword',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.secret',
  '*.apiKey',
  '*.authorization',
];

const prettyTransport = {
  target: 'pino-pretty',
  options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname' },
};

export const logger: PinoLogger = pino({
  level: env.LOG_LEVEL,
  base: { app: env.APP_NAME, env: env.NODE_ENV },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: { paths: REDACTED_PATHS, censor: '[REDACTED]' },
  mixin() {
    const requestId = requestContext.requestId();
    return requestId === undefined ? {} : { requestId };
  },
  ...(env.LOG_PRETTY ? { transport: prettyTransport } : {}),
});

export type Logger = PinoLogger;
