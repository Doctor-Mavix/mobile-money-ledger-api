import { BadRequestError, NotFoundError, PayloadTooLargeError } from '@core/errors/app-error';
import type { Logger } from '@core/logger/logger';
import type { QueueService } from '@shared/queue/queue.service';
import type { RealtimeGateway } from '@shared/realtime/realtime.types';
import { rooms } from '@shared/realtime/realtime.types';
import type { IdService } from '@shared/utils-services/id.service';
import { renderVariants, sniffImageMime } from './image.processor';
import { processImageJob } from './media.jobs';
import type { MediaRepository } from './media.repository';
import type { Media, MediaUrls } from './media.types';
import type { ObjectStorage } from './storage.types';

export interface UploadedFile {
  originalname: string;
  buffer: Buffer;
  size: number;
}

export interface MediaServiceDeps {
  repository: MediaRepository;
  storage: ObjectStorage;
  queue: QueueService;
  realtime: RealtimeGateway;
  ids: IdService;
  logger: Logger;
  maxUploadBytes: number;
  urlExpirySeconds: number;
}

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
};

/**
 * Upload is two phases on purpose: the request stores the original and returns, the worker
 * makes the variants. Resizing four sizes of a phone photo takes seconds — long enough that
 * doing it inline would hold a connection open and make the upload look broken on a slow link.
 */
export class MediaService {
  constructor(private readonly deps: MediaServiceDeps) {}

  async upload(ownerType: string, ownerId: string, file: UploadedFile): Promise<Media> {
    if (file.size > this.deps.maxUploadBytes) {
      throw new PayloadTooLargeError(
        `This file exceeds the ${String(this.deps.maxUploadBytes)} byte limit`,
      );
    }

    const mimeType = sniffImageMime(file.buffer);

    if (mimeType === null) {
      throw new BadRequestError('This file is not a supported image');
    }

    const id = this.deps.ids.uuid();
    const storageKey = `${ownerType}/${ownerId}/${id}/original.${EXTENSIONS[mimeType] ?? 'bin'}`;

    await this.deps.storage.put(storageKey, file.buffer, mimeType);

    const media = await this.deps.repository.create({
      id,
      ownerType,
      ownerId,
      filename: file.originalname,
      mimeType,
      size: file.size,
      storageKey,
    });

    await this.deps.queue.enqueue(processImageJob, { mediaId: id });

    return media;
  }

  /** Runs in the worker: reads the original back, writes the variants, marks the row ready. */
  async processImage(mediaId: string): Promise<void> {
    const media = await this.deps.repository.findById(mediaId);

    if (media === null) {
      // Deleted between the enqueue and the run. Nothing to do, and nothing to fail about.
      return;
    }

    try {
      const original = await this.deps.storage.get(media.storageKey);
      const rendered = await renderVariants(original);
      const variants: Record<string, string> = {};

      for (const { variant, body, contentType } of rendered) {
        const key = `${media.ownerType}/${media.ownerId}/${media.id}/${variant}.webp`;
        await this.deps.storage.put(key, body, contentType);
        variants[variant] = key;
      }

      await this.deps.repository.setVariants(media.id, 'ready', variants);

      this.deps.realtime.emitTo(rooms.entity(media.ownerType, media.ownerId), 'media.processed', {
        id: media.id,
        ownerType: media.ownerType,
        ownerId: media.ownerId,
        variants: Object.keys(variants),
      });
    } catch (error) {
      // The row is marked failed before rethrowing, so a retry that also fails leaves the
      // media visibly broken rather than stuck on "pending" forever.
      await this.deps.repository.setVariants(media.id, 'failed', {});
      throw error;
    }
  }

  async listForOwner(ownerType: string, ownerId: string): Promise<Media[]> {
    return this.deps.repository.listForOwner(ownerType, ownerId);
  }

  async urls(mediaId: string): Promise<MediaUrls> {
    const media = await this.deps.repository.findById(mediaId);

    if (media === null) {
      throw new NotFoundError('This media does not exist');
    }

    return this.presign(media);
  }

  /** Same as `urls`, for a row the caller already holds — a list must not re-read every one. */
  async presign(media: Media): Promise<MediaUrls> {
    const variants = await Promise.all(
      Object.entries(media.variants).map(
        async ([name, key]) =>
          [name, await this.deps.storage.presignedUrl(key, this.deps.urlExpirySeconds)] as const,
      ),
    );

    return {
      original: await this.deps.storage.presignedUrl(media.storageKey, this.deps.urlExpirySeconds),
      variants: Object.fromEntries(variants),
    };
  }

  async remove(mediaId: string): Promise<boolean> {
    const media = await this.deps.repository.findById(mediaId);

    if (media === null) {
      return false;
    }

    for (const key of [media.storageKey, ...Object.values(media.variants)]) {
      try {
        await this.deps.storage.remove(key);
      } catch (error) {
        // An orphan object costs storage; a failed delete that aborts the whole operation
        // costs a row that points at nothing. The row is what matters.
        this.deps.logger.warn({ err: error, key }, 'could not remove stored object');
      }
    }

    return this.deps.repository.remove(mediaId);
  }
}
