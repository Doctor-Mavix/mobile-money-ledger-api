import { env } from '@core/config/env';
import type { CursorPage, CursorQuery } from '@core/database/pagination';
import type { Logger } from '@core/logger/logger';
import type { RealtimeGateway } from '@shared/realtime/realtime.types';
import { rooms } from '@shared/realtime/realtime.types';
import type { IdService } from '@shared/utils-services/id.service';
import type { QueueService } from '@shared/queue/queue.service';
import { sendEmailJob } from './notification.jobs';
import type { NotificationRepository } from './notification.repository';
import type { Notification, NotificationRequest } from './notification.types';

export interface NotificationServiceDeps {
  repository: NotificationRepository;
  realtime: RealtimeGateway;
  queue: QueueService;
  ids: IdService;
  logger: Logger;
  appName: string;
}

/**
 * The one entry point every module uses to reach a person. What is fast and local — storing
 * the in-app row, pushing it over the socket — happens inline so the caller can read it back
 * immediately; what is slow and external — the email — is queued, so a provider being down
 * never turns into a failed request.
 */
export class NotificationService {
  constructor(private readonly deps: NotificationServiceDeps) {}

  async notify(request: NotificationRequest): Promise<void> {
    const { actorId, email } = request.recipient;

    if (request.channels.includes('in_app') && actorId !== undefined) {
      const notification = await this.deps.repository.create({
        id: this.deps.ids.uuid(),
        actorId,
        type: request.type,
        title: request.title,
        body: request.body,
        data: request.data ?? {},
      });

      this.deps.realtime.emitTo(rooms.actor(actorId), 'notification.created', {
        id: notification.id,
        type: notification.type,
        title: notification.title,
        body: notification.body,
        createdAt: notification.createdAt.toISOString(),
      });
    }

    if (request.channels.includes('email') && email !== undefined) {
      await this.deps.queue.enqueue(sendEmailJob, {
        to: email,
        subject: request.title,
        template: 'notification',
        locale: request.locale ?? env.DEFAULT_LOCALE,
        context: {
          title: request.title,
          body: request.body,
          appName: this.deps.appName,
          ...(request.action === undefined
            ? {}
            : { actionUrl: request.action.url, actionLabel: request.action.label }),
        },
      });
    }
  }

  async list(
    actorId: string,
    query: CursorQuery,
    unreadOnly: boolean,
  ): Promise<CursorPage<Notification>> {
    return this.deps.repository.listForActor(actorId, query, unreadOnly);
  }

  async countUnread(actorId: string): Promise<number> {
    return this.deps.repository.countUnread(actorId);
  }

  async markRead(actorId: string, id: string): Promise<boolean> {
    return this.deps.repository.markRead(actorId, id);
  }

  async markAllRead(actorId: string): Promise<number> {
    return this.deps.repository.markAllRead(actorId);
  }
}
