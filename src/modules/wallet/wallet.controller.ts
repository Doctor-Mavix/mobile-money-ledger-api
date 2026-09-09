import { inject } from 'tsyringe';
import { z } from 'zod';

import { Controller, Get, Post, Roles, Validate } from '@core/decorators';
import { ApiPayload } from '@core/http/api-response';
import type { TypedRequest } from '@core/http/typed-request';
import { currentActorId } from '@shared/notifications/current-actor';
import { currencySchema } from '@shared/money/money';
import { WALLET_SERVICE } from './wallet.tokens';
import type { WalletService } from './wallet.service';
import { toWalletView } from './wallet.view';
import type { WalletView } from './wallet.view';

const openSchema = z.strictObject({ currency: currencySchema });

type OpenBody = z.output<typeof openSchema>;

const idParamsSchema = z.object({ id: z.uuid() });

type IdParams = z.output<typeof idParamsSchema>;

@Controller('/wallets')
export class WalletController {
  constructor(@inject(WALLET_SERVICE) private readonly service: WalletService) {}

  @Post('/')
  @Validate({ body: openSchema })
  async open(req: TypedRequest<OpenBody>): Promise<ApiPayload<WalletView>> {
    const wallet = await this.service.open(currentActorId(), req.body.currency);

    return ApiPayload.of(toWalletView(wallet), { status: 201 });
  }

  @Get('/')
  async list(): Promise<WalletView[]> {
    return (await this.service.listForActor(currentActorId())).map(toWalletView);
  }

  @Get('/:id')
  @Validate({ params: idParamsSchema })
  async get(req: TypedRequest<unknown, unknown, IdParams>): Promise<WalletView> {
    return toWalletView(await this.service.requireOwned(currentActorId(), req.params.id));
  }

  /**
   * The answer to a fraud report, so it is deliberately not something the holder can do to
   * their own wallet: an attacker inside a session would otherwise freeze the account to buy
   * time, and a holder who froze theirs by mistake would need the back office anyway.
   *
   * The explicit 200 overrides the kit's default of 201 for a POST. Nothing is created here — a
   * status changes — and a client reading 201 as "a new resource now exists" would be misled.
   */
  @Post('/:id/freeze')
  @Roles('admin')
  @Validate({ params: idParamsSchema })
  async freeze(req: TypedRequest<unknown, unknown, IdParams>): Promise<ApiPayload<WalletView>> {
    const wallet = await this.service.setStatus(req.params.id, 'frozen');

    return ApiPayload.of(toWalletView(wallet), { status: 200 });
  }

  @Post('/:id/unfreeze')
  @Roles('admin')
  @Validate({ params: idParamsSchema })
  async unfreeze(req: TypedRequest<unknown, unknown, IdParams>): Promise<ApiPayload<WalletView>> {
    const wallet = await this.service.setStatus(req.params.id, 'active');

    return ApiPayload.of(toWalletView(wallet), { status: 200 });
  }
}
