import type { Request } from 'express';
import { inject } from 'tsyringe';

import { Controller, Get, HttpCode, Post, Public, Validate } from '@core/decorators';
import { HttpStatus } from '@core/http/http-status';
import { requestContext } from '@core/http/request-context';
import type { TypedRequest } from '@core/http/typed-request';
import { SHARED_TOKENS } from '@shared/tokens';
import type { I18nService } from '@shared/utils-services/i18n.service';
import { AuthService } from './auth.service';
import {
  changePasswordSchema,
  loginSchema,
  refreshSchema,
  registerSchema,
  requestPasswordResetSchema,
  resetPasswordSchema,
  verifyEmailSchema,
  verifyMfaSchema,
} from './auth.schemas';
import type {
  ChangePasswordBody,
  LoginBody,
  RefreshBody,
  RegisterBody,
  RequestPasswordResetBody,
  ResetPasswordBody,
  VerifyEmailBody,
  VerifyMfaBody,
} from './auth.schemas';
import type { Actor, DeviceInfo, LoginResult } from './auth.types';

/** Everything a response may show about an actor; the secrets live in a separate type. */
interface ActorView {
  id: string;
  actorType: string;
  email: string;
  status: string;
  displayName: string;
  phone: string | null;
  emailVerified: boolean;
  roles: readonly string[];
  permissions: readonly string[];
  mfaEnabled: boolean;
  createdAt: string;
}

type LoginView =
  | { status: 'mfa_required'; challengeToken: string; expiresIn: number }
  | {
      status: 'authenticated';
      actor: ActorView;
      accessToken: string;
      refreshToken: string;
      expiresIn: number;
    };

@Controller('/auth')
export class AuthController {
  constructor(
    @inject(AuthService) private readonly service: AuthService,
    @inject(SHARED_TOKENS.I18n) private readonly i18n: I18nService,
  ) {}

  @Post('/register')
  @Public()
  @Validate({ body: registerSchema })
  async register(req: TypedRequest<RegisterBody>): Promise<ActorView> {
    const actor = await this.service.register(
      req.body,
      deviceOf(req),
      this.i18n.resolve(req.get('accept-language')),
    );

    return toActorView(actor);
  }

  @Post('/verify-email')
  @Public()
  @HttpCode(HttpStatus.NO_CONTENT)
  @Validate({ body: verifyEmailSchema })
  async verifyEmail(req: TypedRequest<VerifyEmailBody>): Promise<void> {
    await this.service.verifyEmail(
      req.body.actorType,
      req.body.email,
      req.body.code,
      deviceOf(req),
    );
  }

  @Post('/login')
  @Public()
  @HttpCode(HttpStatus.OK)
  @Validate({ body: loginSchema })
  async login(req: TypedRequest<LoginBody>): Promise<LoginView> {
    return toLoginView(await this.service.login(req.body, deviceOf(req)));
  }

  @Post('/mfa/verify')
  @Public()
  @HttpCode(HttpStatus.OK)
  @Validate({ body: verifyMfaSchema })
  async verifyMfa(req: TypedRequest<VerifyMfaBody>): Promise<LoginView> {
    return toLoginView(
      await this.service.verifyMfa(req.body.challengeToken, req.body.code, deviceOf(req)),
    );
  }

  /**
   * Public because the access token is expected to be expired by the time this is called —
   * the refresh token in the body is the credential.
   */
  @Post('/refresh')
  @Public()
  @HttpCode(HttpStatus.OK)
  @Validate({ body: refreshSchema })
  async refresh(req: TypedRequest<RefreshBody>): Promise<{
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
  }> {
    return this.service.refresh(req.body.refreshToken, deviceOf(req));
  }

  @Post('/logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(req: Request): Promise<void> {
    const principal = requestContext.requirePrincipal();

    await this.service.logout(principal.id, principal.sessionId, deviceOf(req));
  }

  @Post('/logout-all')
  @HttpCode(HttpStatus.OK)
  async logoutAll(req: Request): Promise<{ revokedSessions: number }> {
    const principal = requestContext.requirePrincipal();

    return { revokedSessions: await this.service.logoutAll(principal.id, deviceOf(req)) };
  }

  @Get('/me')
  async me(): Promise<ActorView> {
    return toActorView(await this.service.currentActor(requestContext.requirePrincipal().id));
  }

  @Post('/change-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Validate({ body: changePasswordSchema })
  async changePassword(req: TypedRequest<ChangePasswordBody>): Promise<void> {
    const principal = requestContext.requirePrincipal();

    await this.service.changePassword(
      principal.id,
      req.body.currentPassword,
      req.body.newPassword,
      principal.sessionId,
      deviceOf(req),
    );
  }

  @Post('/password-reset')
  @Public()
  @HttpCode(HttpStatus.ACCEPTED)
  @Validate({ body: requestPasswordResetSchema })
  async requestPasswordReset(
    req: TypedRequest<RequestPasswordResetBody>,
  ): Promise<{ message: string }> {
    await this.service.requestPasswordReset(
      req.body.actorType,
      req.body.email,
      deviceOf(req),
      this.i18n.resolve(req.get('accept-language')),
    );

    // Same answer whether or not the address is known — see the service.
    return { message: 'If that address exists, a reset code has been sent.' };
  }

  @Post('/password-reset/confirm')
  @Public()
  @HttpCode(HttpStatus.NO_CONTENT)
  @Validate({ body: resetPasswordSchema })
  async resetPassword(req: TypedRequest<ResetPasswordBody>): Promise<void> {
    await this.service.resetPassword(
      req.body.actorType,
      req.body.email,
      req.body.code,
      req.body.newPassword,
      deviceOf(req),
    );
  }
}

/**
 * `req.ip` honours `trust proxy`, so behind nginx it is the client address rather than the
 * proxy's — which matters, since the throttle locks per IP.
 */
export function deviceOf(req: Pick<Request, 'ip' | 'get'>): DeviceInfo {
  return {
    ip: req.ip ?? null,
    userAgent: req.get('user-agent')?.slice(0, 255) ?? null,
  };
}

function toActorView(actor: Actor): ActorView {
  return {
    id: actor.id,
    actorType: actor.actorType,
    email: actor.email,
    status: actor.status,
    displayName: actor.displayName,
    phone: actor.phone,
    emailVerified: actor.emailVerifiedAt !== null,
    roles: actor.roles,
    permissions: actor.permissions,
    mfaEnabled: actor.mfaEnabledAt !== null,
    createdAt: actor.createdAt.toISOString(),
  };
}

function toLoginView(result: LoginResult): LoginView {
  if (result.status === 'mfa_required') {
    return result;
  }

  return {
    status: 'authenticated',
    actor: toActorView(result.actor),
    accessToken: result.tokens.accessToken,
    refreshToken: result.tokens.refreshToken,
    expiresIn: result.tokens.expiresIn,
  };
}
