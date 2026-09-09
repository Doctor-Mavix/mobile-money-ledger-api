import cors from 'cors';
import type { RequestHandler } from 'express';

import { env, isProduction } from '@core/config/env';
import { ForbiddenError } from '@core/errors/app-error';

const LOCALHOST_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

function isAllowed(origin: string): boolean {
  if (env.CORS_ORIGINS.includes(origin)) {
    return true;
  }

  return !isProduction && LOCALHOST_ORIGIN.test(origin);
}

export function corsMiddleware(): RequestHandler {
  return cors({
    origin: (origin, callback) => {
      // Same-origin and server-to-server calls carry no Origin header.
      if (origin === undefined || isAllowed(origin)) {
        callback(null, true);
        return;
      }

      callback(new ForbiddenError(`Origin ${origin} is not allowed by CORS policy`));
    },
    credentials: true,
    maxAge: 600,
  });
}
