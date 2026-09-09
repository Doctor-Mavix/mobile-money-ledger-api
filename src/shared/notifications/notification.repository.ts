import type { InjectionToken } from 'tsyringe';

import type { CursorPage, CursorQuery } from '@core/database/pagination';
import type { Notification, NotificationData } from './notification.types';

export interface NewNotification {
  id: string;
  actorId: string;
  type: string;
  title: string;
  body: string;
  data: NotificationData;
}

export interface NotificationRepository {
  create(data: NewNotification): Promise<Notification>;
  listForActor(
    actorId: string,
    query: CursorQuery,
    unreadOnly: boolean,
  ): Promise<CursorPage<Notification>>;
  countUnread(actorId: string): Promise<number>;
  /** Scoped by actor, so an id guessed from another account marks nothing. */
  markRead(actorId: string, id: string): Promise<boolean>;
  markAllRead(actorId: string): Promise<number>;
}

export const NOTIFICATION_REPOSITORY = Symbol(
  'NotificationRepository',
) as InjectionToken<NotificationRepository>;
