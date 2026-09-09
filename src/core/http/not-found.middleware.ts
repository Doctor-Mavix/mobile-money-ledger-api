import type { RequestHandler } from 'express';

import { NotFoundError } from '@core/errors/app-error';

export function notFoundMiddleware(): RequestHandler {
  return (req, _res, next) => {
    next(new NotFoundError(`Route ${req.method} ${req.path} does not exist`));
  };
}
