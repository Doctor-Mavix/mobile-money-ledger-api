import { randomUUID } from 'node:crypto';

import { SignJWT, jwtVerify } from 'jose';

import { env } from '@core/config/env';
import { UnauthorizedError } from '@core/errors/app-error';
import type { AccessTokenClaims, ActorType } from './auth.types';

export interface AccessTokenInput {
  actorId: string;
  actorType: ActorType;
  roles: readonly string[];
  permissions: readonly string[];
  sessionId: string;
}

/**
 * Access tokens only. Refresh tokens are deliberately not JWTs: a stateless refresh token
 * cannot be revoked, and revocation is the entire point of holding sessions server-side.
 */
export class JwtService {
  private readonly secret = new TextEncoder().encode(env.JWT_ACCESS_SECRET);

  async sign(input: AccessTokenInput): Promise<string> {
    return new SignJWT({
      actorType: input.actorType,
      roles: [...input.roles],
      permissions: [...input.permissions],
      sid: input.sessionId,
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(input.actorId)
      .setIssuer(env.JWT_ISSUER)
      .setAudience(env.JWT_AUDIENCE)
      .setJti(randomUUID())
      .setIssuedAt()
      .setExpirationTime(`${String(env.ACCESS_TOKEN_TTL_SECONDS)}s`)
      .sign(this.secret);
  }

  async verify(token: string): Promise<AccessTokenClaims> {
    try {
      const { payload } = await jwtVerify(token, this.secret, {
        issuer: env.JWT_ISSUER,
        audience: env.JWT_AUDIENCE,
        algorithms: ['HS256'],
      });

      return {
        sub: requireString(payload.sub),
        actorType: requireString(payload['actorType']),
        roles: toStringArray(payload['roles']),
        permissions: toStringArray(payload['permissions']),
        sid: requireString(payload['sid']),
        jti: requireString(payload.jti),
      };
    } catch (error) {
      // Expired, tampered with, wrong audience: the caller gets one answer for all of them.
      // Which one it was is useful to an attacker and to nobody else.
      throw new UnauthorizedError('Your session is no longer valid', { cause: error });
    }
  }
}

function requireString(value: unknown): string {
  if (typeof value !== 'string' || value === '') {
    throw new TypeError('malformed token payload');
  }

  return value;
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}
