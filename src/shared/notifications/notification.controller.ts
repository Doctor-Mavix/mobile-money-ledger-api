import { inject } from 'tsyringe';
import { z } from 'zod';

import { cursorQuerySchema } from '@core/database/pagination';
import { Controller, Get, Post, Validate } from '@core/decorators';
import { ApiPayload } from '@core/http/api-response';
import type { TypedRequest } from '@core/http/typed-request';
import { NotFoundError } from '@core/errors/app-error';
import { currentActorId } from './current-actor';
import { NOTIFICATION_SERVICE } from './notification.tokens';
import type { NotificationService } from './notification.service';
import type { Notification } from './notification.types';

const listSchema = cursorQuerySchema.extend({
  unread: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
});

type ListQuery = z.output<typeof listSchema>;

const idParamsSchema = z.object({ id: z.uuid() });

/** Every route is scoped to the authenticated actor: an inbox is never read by someone else. */
@Controller('/notifications')
export class NotificationController {
  constructor(@inject(NOTIFICATION_SERVICE) private readonly service: NotificationService) {}

  @Get('/')
  @Validate({ query: listSchema })
  async list(req: TypedRequest<unknown, ListQuery>): Promise<ApiPayload<Notification[]>> {
    const page = await this.service.list(currentActorId(), req.query, req.query.unread);

    return ApiPayload.of(page.items, {
      meta: { nextCursor: page.nextCursor, hasMore: page.hasMore, limit: req.query.limit },
    });
  }

  @Get('/unread-count')
  async unreadCount(): Promise<{ count: number }> {
    return { count: await this.service.countUnread(currentActorId()) };
  }

  @Post('/:id/read')
  @Validate({ params: idParamsSchema })
  async markRead(
    req: TypedRequest<unknown, unknown, { id: string }>,
  ): Promise<ApiPayload<{ id: string }>> {
    const marked = await this.service.markRead(currentActorId(), req.params.id);

    if (!marked) {
      throw new NotFoundError('This notification does not exist or is already read');
    }

    return ApiPayload.of({ id: req.params.id }, { status: 200 });
  }

  @Post('/read-all')
  async markAllRead(): Promise<ApiPayload<{ marked: number }>> {
    const marked = await this.service.markAllRead(currentActorId());

    return ApiPayload.of({ marked }, { status: 200 });
  }
}
