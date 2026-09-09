import { inject } from 'tsyringe';
import { z } from 'zod';

import { cursorQuerySchema } from '@core/database/pagination';
import { Controller, Get, Post, Roles, Validate } from '@core/decorators';
import { ApiPayload } from '@core/http/api-response';
import type { TypedRequest } from '@core/http/typed-request';
import { currentActorId } from '@shared/notifications/current-actor';
import { cashMovementSchema, requireIdempotencyKey, transferSchema } from './transfer.schemas';
import { TRANSFER_SERVICE } from './transfer.tokens';
import type { TransferService } from './transfer.service';
import { toTransferResultView, toTransferView } from './transfer.view';
import type { TransferResultView, TransferView } from './transfer.view';

type TransferBody = z.output<typeof transferSchema>;
type CashBody = z.output<typeof cashMovementSchema>;
type ListQuery = z.output<typeof cursorQuerySchema>;

const idParamsSchema = z.object({ id: z.uuid() });

type IdParams = z.output<typeof idParamsSchema>;

/**
 * Every route that moves money asks for a two-factor code in the body and an `Idempotency-Key`
 * in the header. Neither is optional and neither has a default: a transfer endpoint that works
 * without them is a transfer endpoint that will be called without them.
 */
@Controller('/transfers')
export class TransferController {
  constructor(@inject(TRANSFER_SERVICE) private readonly service: TransferService) {}

  @Post('/')
  @Validate({ body: transferSchema })
  async create(req: TypedRequest<TransferBody>): Promise<ApiPayload<TransferResultView>> {
    const result = await this.service.transfer({
      actorId: currentActorId(),
      idempotencyKey: requireIdempotencyKey(req),
      sourceWalletId: req.body.sourceWalletId,
      targetWalletId: req.body.targetWalletId,
      amount: req.body.amount,
      mfaCode: req.body.mfaCode,
      reference: req.body.reference,
    });

    // 200 on a replay, 201 on the movement that actually happened: a client retrying after a
    // timeout can tell whether it created something or found what it had already created.
    return ApiPayload.of(toTransferResultView(result), { status: result.replayed ? 200 : 201 });
  }

  /**
   * The kiosk half of a mobile-money network: an operator takes cash and credits a wallet.
   * Restricted to the `agent` role and still gated on the operator's own two-factor code, because
   * this is the one route that creates money as far as a holder is concerned.
   */
  @Post('/cash-in')
  @Roles('agent')
  @Validate({ body: cashMovementSchema })
  async cashIn(req: TypedRequest<CashBody>): Promise<ApiPayload<TransferResultView>> {
    const result = await this.service.cashIn({
      operatorId: currentActorId(),
      idempotencyKey: requireIdempotencyKey(req),
      walletId: req.body.walletId,
      amount: req.body.amount,
      mfaCode: req.body.mfaCode,
      reference: req.body.reference,
    });

    return ApiPayload.of(toTransferResultView(result), { status: result.replayed ? 200 : 201 });
  }

  @Post('/cash-out')
  @Roles('agent')
  @Validate({ body: cashMovementSchema })
  async cashOut(req: TypedRequest<CashBody>): Promise<ApiPayload<TransferResultView>> {
    const result = await this.service.cashOut({
      operatorId: currentActorId(),
      idempotencyKey: requireIdempotencyKey(req),
      walletId: req.body.walletId,
      amount: req.body.amount,
      mfaCode: req.body.mfaCode,
      reference: req.body.reference,
    });

    return ApiPayload.of(toTransferResultView(result), { status: result.replayed ? 200 : 201 });
  }

  @Get('/')
  @Validate({ query: cursorQuerySchema })
  async list(req: TypedRequest<unknown, ListQuery>): Promise<ApiPayload<TransferView[]>> {
    const page = await this.service.listForActor(currentActorId(), req.query);

    return ApiPayload.of(page.items.map(toTransferView), {
      meta: { nextCursor: page.nextCursor, hasMore: page.hasMore, limit: req.query.limit },
    });
  }

  @Get('/:id')
  @Validate({ params: idParamsSchema })
  async get(req: TypedRequest<unknown, unknown, IdParams>): Promise<TransferView> {
    return toTransferView(await this.service.requireVisible(currentActorId(), req.params.id));
  }
}
