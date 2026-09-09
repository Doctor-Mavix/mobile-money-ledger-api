import { ErrorCode } from '@core/errors/error-codes';
import { HttpStatus } from '@core/http/http-status';

export interface AppErrorOptions {
  code?: ErrorCode;
  details?: unknown;
  cause?: unknown;
  expose?: boolean;
}

function toErrorOptions(cause: unknown): ErrorOptions | undefined {
  return cause === undefined ? undefined : { cause };
}

export class AppError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details: unknown;
  readonly expose: boolean;

  constructor(message: string, status: number, options: AppErrorOptions = {}) {
    super(message, toErrorOptions(options.cause));
    this.name = new.target.name;
    this.status = status;
    this.code = options.code ?? ErrorCode.INTERNAL_ERROR;
    this.details = options.details;
    this.expose = options.expose ?? status < HttpStatus.INTERNAL_SERVER_ERROR;
    Error.captureStackTrace(this, new.target);
  }

  static is(value: unknown): value is AppError {
    return value instanceof AppError;
  }
}

type DerivedOptions = Omit<AppErrorOptions, 'code'>;

export class BadRequestError extends AppError {
  constructor(message = 'Bad request', options: DerivedOptions = {}) {
    super(message, HttpStatus.BAD_REQUEST, { ...options, code: ErrorCode.BAD_REQUEST });
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required', options: DerivedOptions = {}) {
    super(message, HttpStatus.UNAUTHORIZED, { ...options, code: ErrorCode.UNAUTHORIZED });
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Access denied', options: DerivedOptions = {}) {
    super(message, HttpStatus.FORBIDDEN, { ...options, code: ErrorCode.FORBIDDEN });
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Resource not found', options: DerivedOptions = {}) {
    super(message, HttpStatus.NOT_FOUND, { ...options, code: ErrorCode.NOT_FOUND });
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Resource conflict', options: DerivedOptions = {}) {
    super(message, HttpStatus.CONFLICT, { ...options, code: ErrorCode.CONFLICT });
  }
}

export class PayloadTooLargeError extends AppError {
  constructor(message = 'Payload too large', options: DerivedOptions = {}) {
    super(message, HttpStatus.PAYLOAD_TOO_LARGE, { ...options, code: ErrorCode.PAYLOAD_TOO_LARGE });
  }
}

export class TooManyRequestsError extends AppError {
  constructor(message = 'Too many requests', options: DerivedOptions = {}) {
    super(message, HttpStatus.TOO_MANY_REQUESTS, { ...options, code: ErrorCode.TOO_MANY_REQUESTS });
  }
}

export class InternalError extends AppError {
  constructor(message = 'Internal server error', options: DerivedOptions = {}) {
    super(message, HttpStatus.INTERNAL_SERVER_ERROR, {
      ...options,
      code: ErrorCode.INTERNAL_ERROR,
      expose: false,
    });
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(message = 'Service unavailable', options: DerivedOptions = {}) {
    super(message, HttpStatus.SERVICE_UNAVAILABLE, {
      ...options,
      code: ErrorCode.SERVICE_UNAVAILABLE,
      expose: false,
    });
  }
}

export type ValidationSource = 'body' | 'query' | 'params' | 'headers';

export interface ValidationIssue {
  /** Absent when the schema was applied outside the request pipeline. */
  source?: ValidationSource;
  path: string;
  message: string;
}

export class ValidationError extends AppError {
  constructor(issues: readonly ValidationIssue[], message = 'Request validation failed') {
    super(message, HttpStatus.UNPROCESSABLE_ENTITY, {
      code: ErrorCode.VALIDATION_FAILED,
      details: issues,
      expose: true,
    });
  }
}

/** Thrown at boot time when the application is wired incorrectly. Never reaches an HTTP response. */
export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}
