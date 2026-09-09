import type { RequestHandler } from 'express';
import helmet from 'helmet';

import { isProduction } from '@core/config/env';

const ONE_YEAR_SECONDS = 31_536_000;

export function helmetMiddleware(): RequestHandler {
  return helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'none'"],
      },
    },
    crossOriginResourcePolicy: { policy: 'same-site' },
    referrerPolicy: { policy: 'no-referrer' },
    hsts: isProduction
      ? { maxAge: ONE_YEAR_SECONDS, includeSubDomains: true, preload: true }
      : false,
  });
}
