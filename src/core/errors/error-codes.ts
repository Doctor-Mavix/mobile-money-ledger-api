export const ErrorCode = {
  BAD_REQUEST: 'BAD_REQUEST',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  UNSUPPORTED_MEDIA_TYPE: 'UNSUPPORTED_MEDIA_TYPE',
  TOO_MANY_REQUESTS: 'TOO_MANY_REQUESTS',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',

  /**
   * Added by this project. A refused transfer is not a bug and not a client error to be shown
   * as "conflict": a mobile app has to tell the two apart to offer "top up" rather than "try
   * again", and it cannot do that by matching on an English sentence.
   *
   * That this had to be edited in `core/` is a template gap — the vocabulary of error codes is
   * a closed union with no room for a domain to add its own.
   */
  INSUFFICIENT_FUNDS: 'INSUFFICIENT_FUNDS',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];
