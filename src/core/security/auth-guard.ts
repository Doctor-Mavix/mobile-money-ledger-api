import type { RequestHandler } from 'express';

import type { AccessMetadata } from '@core/decorators/types';

/**
 * Contract the registry expects for every route that is not marked `@Public()`.
 * The implementation ships with the auth module; the core only knows the contract.
 */
export interface AuthGuard {
  protect(access: AccessMetadata): RequestHandler;
}
