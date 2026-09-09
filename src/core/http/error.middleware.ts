import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';

import { isProduction } from '@core/config/env';
import type { ValidationIssue } from '@core/errors/app-error';
import {
  AppError,
  BadRequestError,
  InternalError,
  PayloadTooLargeError,
  ValidationError,
} from '@core/errors/app-error';
import { errorBody } from '@core/http/api-response';
import { HttpStatus } from '@core/http/http-status';
import { requestContext } from '@core/http/request-context';
import type { Logger } from '@core/logger/logger';

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function fromZodError(error: ZodError): ValidationError {
  const issues: ValidationIssue[] = error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }));

  return new ValidationError(issues);
}

function normalizeError(error: unknown): AppError {
  if (AppError.is(error)) {
    return error;
  }

  if (error instanceof ZodError) {
    return fromZodError(error);
  }

  // Body parsing failures raised by express.json()/urlencoded() carry a `type` discriminator.
  const bodyParserType = asRecord(error)?.['type'];
  if (bodyParserType === 'entity.too.large') {
    return new PayloadTooLargeError('Request payload exceeds the configured limit', {
      cause: error,
    });
  }
  if (bodyParserType === 'entity.parse.failed' || bodyParserType === 'encoding.unsupported') {
    return new BadRequestError('Malformed request body', { cause: error });
  }

  return new InternalError('Internal server error', { cause: error });
}

export function errorMiddleware(logger: Logger): ErrorRequestHandler {
  return (error: unknown, req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }

    const appError = normalizeError(error);
    const requestId = requestContext.requestId();
    const logContext = {
      err: error,
      status: appError.status,
      code: appError.code,
      method: req.method,
      path: req.originalUrl,
    };

    if (appError.status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      logger.error(logContext, appError.message);
    } else {
      logger.warn(logContext, appError.message);
    }

    const disclose = appError.expose || !isProduction;

    res.status(appError.status).json(
      errorBody({
        code: appError.code,
        message: disclose ? appError.message : 'Internal server error',
        ...(disclose && appError.details !== undefined ? { details: appError.details } : {}),
        ...(requestId === undefined ? {} : { requestId }),
      }),
    );
  };
}
