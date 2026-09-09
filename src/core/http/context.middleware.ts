import { randomUUID } from 'node:crypto';

import type { RequestHandler } from 'express';

import { REQUEST_ID_HEADER } from '@core/config/constants';
import { requestContext } from '@core/http/request-context';

/** Inbound ids are echoed into logs and responses, so only accept an opaque, bounded token. */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{8,128}$/;

export function contextMiddleware(): RequestHandler {
  return (req, res, next) => {
    const incoming = req.header(REQUEST_ID_HEADER);
    const requestId =
      incoming !== undefined && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();

    res.setHeader(REQUEST_ID_HEADER, requestId);
    requestContext.run({ requestId, startedAt: Date.now() }, () => {
      next();
    });
  };
}
