import { inject, injectable } from 'tsyringe';

import type { SocketAuthenticator, SocketIdentity } from '@shared/realtime/realtime.types';
import { JwtService } from './jwt.service';
import { SessionService } from './session.service';

/**
 * A socket is authenticated by the same access token as an HTTP request, and by nothing else.
 * The `actorId` a client may put in the handshake is ignored: it is what made the development
 * fallback spoofable, and rooms are joined from the token's claims instead.
 */
@injectable()
export class JwtSocketAuthenticator implements SocketAuthenticator {
  constructor(
    @inject(JwtService) private readonly jwt: JwtService,
    @inject(SessionService) private readonly sessions: SessionService,
  ) {}

  async authenticate(handshake: { token: string | undefined }): Promise<SocketIdentity | null> {
    if (handshake.token === undefined) {
      return null;
    }

    try {
      const claims = await this.jwt.verify(handshake.token);

      // A socket outlives the request that opened it, so the session is checked here too:
      // otherwise signing out would close nothing until the token expired on its own.
      if (!(await this.sessions.exists(claims.sid))) {
        return null;
      }

      return { actorId: claims.sub, roles: claims.roles };
    } catch {
      // The handshake gets one answer: refused. Which part failed is not a client's business.
      return null;
    }
  }
}
