export type ResponseMeta = Record<string, unknown>;

export interface ApiSuccessBody<T> {
  success: true;
  data: T;
  message?: string;
  meta?: ResponseMeta;
  requestId?: string;
}

export interface ApiErrorBody {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
  requestId?: string;
}

export type ApiBody<T> = ApiSuccessBody<T> | ApiErrorBody;

export interface ApiPayloadOptions {
  message?: string;
  meta?: ResponseMeta;
  status?: number;
}

/**
 * Returned by a controller when it needs to shape the envelope (message, meta, status)
 * instead of letting the registry wrap a bare value.
 */
export class ApiPayload<T> {
  constructor(
    readonly data: T,
    readonly options: ApiPayloadOptions = {},
  ) {}

  static of<T>(data: T, options: ApiPayloadOptions = {}): ApiPayload<T> {
    return new ApiPayload(data, options);
  }
}

export interface SuccessBodyOptions {
  message?: string;
  meta?: ResponseMeta;
  requestId?: string;
}

export function successBody<T>(data: T, options: SuccessBodyOptions = {}): ApiSuccessBody<T> {
  return {
    success: true,
    data,
    ...(options.message === undefined ? {} : { message: options.message }),
    ...(options.meta === undefined ? {} : { meta: options.meta }),
    ...(options.requestId === undefined ? {} : { requestId: options.requestId }),
  };
}

export interface ErrorBodyOptions {
  code: string;
  message: string;
  details?: unknown;
  requestId?: string;
}

export function errorBody(options: ErrorBodyOptions): ApiErrorBody {
  return {
    success: false,
    error: {
      code: options.code,
      message: options.message,
      ...(options.details === undefined ? {} : { details: options.details }),
    },
    ...(options.requestId === undefined ? {} : { requestId: options.requestId }),
  };
}
