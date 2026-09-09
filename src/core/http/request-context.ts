import { AsyncLocalStorage } from 'node:async_hooks';

import { UnauthorizedError } from '@core/errors/app-error';
import type { Principal } from '@core/security/principal';

export interface RequestContext {
  requestId: string;
  startedAt: number;
  principal?: Principal;
}

const storage = new AsyncLocalStorage<RequestContext>();

export const requestContext = {
  run<T>(context: RequestContext, callback: () => T): T {
    return storage.run(context, callback);
  },

  get(): RequestContext | undefined {
    return storage.getStore();
  },

  requestId(): string | undefined {
    return storage.getStore()?.requestId;
  },

  /**
   * Written once by the auth guard, after the token and its session have been verified. Going
   * through the context rather than through `req` is what lets a service deep in a call stack
   * know who is calling without every layer between passing the request down.
   */
  setPrincipal(principal: Principal): void {
    const store = storage.getStore();

    if (store !== undefined) {
      store.principal = principal;
    }
  },

  principal(): Principal | undefined {
    return storage.getStore()?.principal;
  },

  /** For code that is only ever reachable behind the guard, and would be a bug without one. */
  requirePrincipal(): Principal {
    const principal = storage.getStore()?.principal;

    if (principal === undefined) {
      throw new UnauthorizedError('This endpoint requires authentication');
    }

    return principal;
  },
};
