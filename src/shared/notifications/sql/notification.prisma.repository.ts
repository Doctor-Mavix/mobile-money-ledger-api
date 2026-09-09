import type { Prisma, Notification as NotificationRow } from '@prisma-client';

import type { CursorPage, CursorQuery } from '@core/database/pagination';
import { buildCursorPage } from '@core/database/pagination';
import type { SqlClient } from '@core/database/sql/prisma.adapter';
import type { NewNotification, NotificationRepository } from '../notification.repository';
import type { Notification, NotificationData } from '../notification.types';

function toData(value: Prisma.JsonValue): NotificationData {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).flatMap(([key, entry]) =>
      typeof entry === 'string' ? [[key, entry] as const] : [],
    ),
  );
}

function toNotification(row: NotificationRow): Notification {
  return {
    id: row.id,
    actorId: row.actorId,
    type: row.type,
    title: row.title,
    body: row.body,
    data: toData(row.data),
    readAt: row.readAt,
    createdAt: row.createdAt,
  };
}

function cursorWhere(query: CursorQuery): Prisma.NotificationWhereInput | undefined {
  if (query.cursor === null) {
    return undefined;
  }

  const createdAt = new Date(query.cursor.value);
  const ascending = query.direction === 'asc';

  return {
    OR: [
      { createdAt: ascending ? { gt: createdAt } : { lt: createdAt } },
      { createdAt, id: ascending ? { gt: query.cursor.id } : { lt: query.cursor.id } },
    ],
  };
}

export class PrismaNotificationRepository implements NotificationRepository {
  constructor(private readonly client: SqlClient) {}

  async create(data: NewNotification): Promise<Notification> {
    const row = await this.client.notification.create({ data });

    return toNotification(row);
  }

  async listForActor(
    actorId: string,
    query: CursorQuery,
    unreadOnly: boolean,
  ): Promise<CursorPage<Notification>> {
    const rows = await this.client.notification.findMany({
      where: { actorId, ...(unreadOnly ? { readAt: null } : {}), ...cursorWhere(query) },
      orderBy: [{ createdAt: query.direction }, { id: query.direction }],
      take: query.limit + 1,
    });

    return buildCursorPage(rows.map(toNotification), query.limit, (item) => ({
      value: item.createdAt.toISOString(),
      id: item.id,
    }));
  }

  async countUnread(actorId: string): Promise<number> {
    return this.client.notification.count({ where: { actorId, readAt: null } });
  }

  async markRead(actorId: string, id: string): Promise<boolean> {
    // updateMany rather than update: the actor scope makes it a no-op on someone else's row
    // instead of a 404 that confirms the row exists.
    const result = await this.client.notification.updateMany({
      where: { id, actorId, readAt: null },
      data: { readAt: new Date() },
    });

    return result.count > 0;
  }

  async markAllRead(actorId: string): Promise<number> {
    const result = await this.client.notification.updateMany({
      where: { actorId, readAt: null },
      data: { readAt: new Date() },
    });

    return result.count;
  }
}
