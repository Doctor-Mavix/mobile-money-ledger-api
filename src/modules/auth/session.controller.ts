import { inject } from 'tsyringe';

import { Controller, Delete, Get, Validate } from '@core/decorators';
import { requestContext } from '@core/http/request-context';
import type { TypedRequest } from '@core/http/typed-request';
import { deviceOf } from './auth.controller';
import { AuthService } from './auth.service';
import { sessionIdParamsSchema } from './auth.schemas';

interface SessionView {
  id: string;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
  lastSeenAt: string;
  current: boolean;
}

@Controller('/auth/sessions')
export class SessionController {
  constructor(@inject(AuthService) private readonly service: AuthService) {}

  @Get('/')
  async list(): Promise<SessionView[]> {
    const principal = requestContext.requirePrincipal();
    const sessions = await this.service.listSessions(principal.id);

    return sessions.map((session) => ({
      id: session.id,
      ip: session.ip,
      userAgent: session.userAgent,
      createdAt: session.createdAt.toISOString(),
      lastSeenAt: session.lastSeenAt.toISOString(),
      // Flagged so a user can tell which line is the device in front of them.
      current: session.id === principal.sessionId,
    }));
  }

  @Delete('/:id')
  @Validate({ params: sessionIdParamsSchema })
  async revoke(req: TypedRequest<unknown, unknown, { id: string }>): Promise<void> {
    await this.service.revokeSession(
      requestContext.requirePrincipal().id,
      req.params.id,
      deviceOf(req),
    );
  }
}
