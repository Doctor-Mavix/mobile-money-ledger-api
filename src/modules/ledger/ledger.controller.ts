import { inject } from 'tsyringe';
import { z } from 'zod';

import { cursorQuerySchema } from '@core/database/pagination';
import { Controller, Get, Roles, Validate } from '@core/decorators';
import { ApiPayload } from '@core/http/api-response';
import type { TypedRequest } from '@core/http/typed-request';
import { currentActorId } from '@shared/notifications/current-actor';
import { LEDGER_REPOSITORY } from './ledger.repository';
import type { LedgerRepository } from './ledger.repository';
import { toLedgerEntryView, toLedgerIntegrityView } from './ledger.view';
import type { LedgerEntryView, LedgerIntegrityView } from './ledger.view';
import { WALLET_SERVICE } from '@modules/wallet/wallet.tokens';
import type { WalletService } from '@modules/wallet/wallet.service';

const idParamsSchema = z.object({ id: z.uuid() });

type IdParams = z.output<typeof idParamsSchema>;
type ListQuery = z.output<typeof cursorQuerySchema>;

/**
 * Read-only by construction: there is no route here that writes, because the only code allowed
 * to append to the ledger is the posting transaction, and the database refuses an UPDATE or a
 * DELETE on the table outright.
 */
@Controller('/ledger')
export class LedgerController {
  constructor(
    @inject(LEDGER_REPOSITORY) private readonly ledger: LedgerRepository,
    @inject(WALLET_SERVICE) private readonly wallets: WalletService,
  ) {}

  @Get('/wallets/:id')
  @Validate({ params: idParamsSchema, query: cursorQuerySchema })
  async forWallet(
    req: TypedRequest<unknown, ListQuery, IdParams>,
  ): Promise<ApiPayload<LedgerEntryView[]>> {
    const wallet = await this.wallets.requireOwned(currentActorId(), req.params.id);
    const page = await this.ledger.listForWallet(wallet.id, req.query);

    return ApiPayload.of(page.items.map(toLedgerEntryView), {
      meta: { nextCursor: page.nextCursor, hasMore: page.hasMore, limit: req.query.limit },
    });
  }

  /**
   * Re-reads every entry and checks it against the balances it is supposed to explain. Kept
   * behind the back-office role because it is a full table scan, not because the answer is
   * secret — it is the one endpoint that can say "the books do not add up" without a deploy.
   */
  @Get('/integrity')
  @Roles('admin')
  async integrity(): Promise<LedgerIntegrityView> {
    return toLedgerIntegrityView(await this.ledger.verify());
  }
}
