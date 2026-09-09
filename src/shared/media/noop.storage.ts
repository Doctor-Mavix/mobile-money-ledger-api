import { ConfigurationError } from '@core/errors/app-error';
import type { ObjectStorage } from './storage.types';

/**
 * What S3_ENDPOINT="" resolves to. Unlike the mailer, storage has no sensible degraded mode:
 * silently dropping an upload would make the application lie about having stored a file, so
 * every method refuses loudly.
 */
export class UnconfiguredStorage implements ObjectStorage {
  put(): Promise<void> {
    throw new ConfigurationError('Object storage is not configured: set S3_ENDPOINT');
  }

  get(): Promise<Buffer> {
    throw new ConfigurationError('Object storage is not configured: set S3_ENDPOINT');
  }

  presignedUrl(): Promise<string> {
    throw new ConfigurationError('Object storage is not configured: set S3_ENDPOINT');
  }

  remove(): Promise<void> {
    throw new ConfigurationError('Object storage is not configured: set S3_ENDPOINT');
  }
}
