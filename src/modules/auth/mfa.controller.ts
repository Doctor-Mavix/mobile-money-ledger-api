import { inject } from 'tsyringe';

import { Controller, HttpCode, Post, Validate } from '@core/decorators';
import { HttpStatus } from '@core/http/http-status';
import { requestContext } from '@core/http/request-context';
import type { TypedRequest } from '@core/http/typed-request';
import { deviceOf } from './auth.controller';
import { AuthService } from './auth.service';
import { confirmMfaSchema, disableMfaSchema } from './auth.schemas';
import type { ConfirmMfaBody, DisableMfaBody } from './auth.schemas';

interface MfaSetupView {
  secret: string;
  otpauthUrl: string;
  qrCodeDataUrl: string;
}

@Controller('/auth/mfa')
export class MfaController {
  constructor(@inject(AuthService) private readonly service: AuthService) {}

  @Post('/setup')
  @HttpCode(HttpStatus.OK)
  async setup(): Promise<MfaSetupView> {
    return this.service.beginMfaSetup(requestContext.requirePrincipal().id);
  }

  @Post('/confirm')
  @HttpCode(HttpStatus.OK)
  @Validate({ body: confirmMfaSchema })
  async confirm(req: TypedRequest<ConfirmMfaBody>): Promise<{ backupCodes: readonly string[] }> {
    return this.service.confirmMfaSetup(
      requestContext.requirePrincipal().id,
      req.body.code,
      deviceOf(req),
    );
  }

  @Post('/disable')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Validate({ body: disableMfaSchema })
  async disable(req: TypedRequest<DisableMfaBody>): Promise<void> {
    await this.service.disableMfa(
      requestContext.requirePrincipal().id,
      req.body.password,
      req.body.code,
      deviceOf(req),
    );
  }
}
