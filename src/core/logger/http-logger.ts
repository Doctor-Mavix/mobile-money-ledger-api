import type { RequestHandler } from 'express';
import { pinoHttp } from 'pino-http';

import { REQUEST_ID_HEADER } from '@core/config/constants';
import { requestContext } from '@core/http/request-context';
import { HttpStatus } from '@core/http/http-status';
import { logger } from '@core/logger/logger';

const SILENT_PATHS = new Set(['/health', '/ready']);

export function httpLogger(): RequestHandler {
  return pinoHttp({
    logger,
    // The context middleware runs first, so the id is already resolved and shared with the logs.
    genReqId: (_req, res) => {
      const requestId = requestContext.requestId() ?? '';
      res.setHeader(REQUEST_ID_HEADER, requestId);
      return requestId;
    },
    autoLogging: {
      ignore: (req) => SILENT_PATHS.has(req.url.split('?')[0] ?? ''),
    },
    customLogLevel: (_req, res, error) => {
      if (error !== undefined || res.statusCode >= HttpStatus.INTERNAL_SERVER_ERROR) {
        return 'error';
      }
      return res.statusCode >= HttpStatus.BAD_REQUEST ? 'warn' : 'info';
    },
  });
}
