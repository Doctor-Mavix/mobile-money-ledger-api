import type { Request, RequestHandler } from 'express';
import { inject, injectable } from 'tsyringe';

import type { AccessMetadata } from '@core/decorators/types';
import { ForbiddenError, UnauthorizedError } from '@core/errors/app-error';
import { requestContext } from '@core/http/request-context';
import type { AuthGuard } from '@core/security/auth-guard';
import type { Principal } from '@core/security/principal';
import { JwtService } from './jwt.service';
import { SessionService } from './session.service';

const BEARER = /^Bearer (.+)$/;

@injectable()
export class JwtGuard implements AuthGuard {
  constructor(
    @inject(JwtService) private readonly jwt: JwtService,
    @inject(SessionService) private readonly sessions: SessionService,
  ) {}

  protect(access: AccessMetadata): RequestHandler {
    return (req, _res, next) => {
      this.authorise(req, access).then(
        (principal) => {
          requestContext.setPrincipal(principal);
          next();
        },
        (error: unknown) => {
          next(error);
        },
      );
    };
  }

  private async authorise(req: Request, access: AccessMetadata): Promise<Principal> {
    const token = bearerToken(req);

    if (token === null) {
      throw new UnauthorizedError('This endpoint requires authentication');
    }

    const claims = await this.jwt.verify(token);

    // The signature only proves the token was minted by us; it says nothing about whether the
    // session still exists. Checking Redis is what makes "sign out this device" immediate
    // instead of "immediate in fifteen minutes".
    if (!(await this.sessions.exists(claims.sid))) {
      throw new UnauthorizedError('Your session is no longer valid');
    }

    const principal: Principal = {
      id: claims.sub,
      actorType: claims.actorType,
      roles: claims.roles,
      permissions: claims.permissions,
      sessionId: claims.sid,
    };

    assertAllowed(principal, access);

    return principal;
  }
}

function bearerToken(req: Request): string | null {
  const header = req.header('authorization');

  if (header === undefined) {
    return null;
  }

  return BEARER.exec(header)?.[1]?.trim() ?? null;
}

/**
 * Roles are alternatives, permissions are cumulative: `@Roles('admin', 'agent')` means either
 * one will do, while `@Permissions('account:read', 'account:write')` means both are needed.
 * Anything else would make a route's requirements unreadable from its decorators.
 */
function assertAllowed(principal: Principal, access: AccessMetadata): void {
  if (access.roles.length > 0 && !access.roles.some((role) => principal.roles.includes(role))) {
    throw new ForbiddenError('You are not allowed to perform this action');
  }

  const missing = access.permissions.filter(
    (permission) => !principal.permissions.includes(permission),
  );

  if (missing.length > 0) {
    throw new ForbiddenError('You are not allowed to perform this action');
  }
}
