import type { Response } from 'express';
import { inject } from 'tsyringe';
import { z } from 'zod';

import { Controller, Get, Validate } from '@core/decorators';
import type { TypedRequest } from '@core/http/typed-request';
import { currentActorId } from '@shared/notifications/current-actor';
import { STATEMENT_FORMATS } from './statement.service';
import type { StatementService } from './statement.service';
import { STATEMENT_SERVICE } from './statement.tokens';

const idParamsSchema = z.object({ id: z.uuid() });

/** ISO dates rather than a page: a statement is a period, and periods are what people ask for. */
const rangeSchema = z.object({
  from: z.iso.datetime({ offset: true }).or(z.iso.date()),
  to: z.iso.datetime({ offset: true }).or(z.iso.date()),
  format: z.enum(STATEMENT_FORMATS).default('csv'),
});

type IdParams = z.output<typeof idParamsSchema>;
type RangeQuery = z.output<typeof rangeSchema>;

@Controller('/statements')
export class StatementController {
  constructor(@inject(STATEMENT_SERVICE) private readonly service: StatementService) {}

  /**
   * Writes to the response itself instead of returning a body: a year of entries is streamed
   * out row by row, so it never exists in memory as one object to serialize.
   *
   * `attachment` is not decoration. Without it a browser renders the CSV inline, and a field
   * a user chose the content of would be interpreted in the origin of the API.
   */
  @Get('/wallets/:id')
  @Validate({ params: idParamsSchema, query: rangeSchema })
  async download(req: TypedRequest<unknown, RangeQuery, IdParams>, res: Response): Promise<void> {
    const request = {
      actorId: currentActorId(),
      walletId: req.params.id,
      from: new Date(req.query.from),
      to: new Date(req.query.to),
      format: req.query.format,
    };

    const wallet = await this.service.prepare(request);
    const delivery = this.service.describe(request);

    res.setHeader('Content-Type', delivery.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${delivery.filename}"`);
    res.setHeader('Cache-Control', 'no-store');

    await this.service.write(wallet, request, res);
  }
}
