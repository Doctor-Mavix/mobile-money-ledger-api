import type { Prisma, Media as MediaRow } from '@prisma-client';

import type { SqlClient } from '@core/database/sql/prisma.adapter';
import type { MediaRepository, NewMedia } from '../media.repository';
import type { Media, MediaStatus, MediaVariants } from '../media.types';

function toVariants(value: Prisma.JsonValue): MediaVariants {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).flatMap(([key, entry]) =>
      typeof entry === 'string' ? [[key, entry] as const] : [],
    ),
  );
}

function toMedia(row: MediaRow): Media {
  return {
    id: row.id,
    ownerType: row.ownerType,
    ownerId: row.ownerId,
    filename: row.filename,
    mimeType: row.mimeType,
    size: row.size,
    storageKey: row.storageKey,
    status: row.status,
    variants: toVariants(row.variants),
    createdAt: row.createdAt,
  };
}

export class PrismaMediaRepository implements MediaRepository {
  constructor(private readonly client: SqlClient) {}

  async create(data: NewMedia): Promise<Media> {
    return toMedia(await this.client.media.create({ data }));
  }

  async findById(id: string): Promise<Media | null> {
    const row = await this.client.media.findUnique({ where: { id } });

    return row === null ? null : toMedia(row);
  }

  async listForOwner(ownerType: string, ownerId: string): Promise<Media[]> {
    const rows = await this.client.media.findMany({
      where: { ownerType, ownerId },
      orderBy: { createdAt: 'asc' },
    });

    return rows.map(toMedia);
  }

  async setVariants(
    id: string,
    status: MediaStatus,
    variants: MediaVariants,
  ): Promise<Media | null> {
    const result = await this.client.media.updateManyAndReturn({
      where: { id },
      data: { status, variants },
    });

    return result[0] === undefined ? null : toMedia(result[0]);
  }

  async remove(id: string): Promise<boolean> {
    const result = await this.client.media.deleteMany({ where: { id } });

    return result.count > 0;
  }
}
