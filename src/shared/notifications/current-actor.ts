import { requestContext } from '@core/http/request-context';

/**
 * The single seam between the kit and authentication. The identity comes from the access
 * token the guard verified, so nothing here is caller-controlled.
 */
export function currentActorId(): string {
  return requestContext.requirePrincipal().id;
}
