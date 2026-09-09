import { Redis } from 'ioredis';

import type { Logger } from '@core/logger/logger';

export interface RedisClientOptions {
  url: string;
  keyPrefix: string;
  connectTimeoutMs: number;
  logger: Logger;
}

/**
 * The shared state that makes the application stateless: rate-limit counters today, sessions,
 * refresh tokens and caches next. Every instance of the app must see the same Redis.
 */
export class RedisConnection {
  readonly client: Redis;

  constructor(private readonly options: RedisClientOptions) {
    this.client = new Redis(options.url, {
      keyPrefix: options.keyPrefix,
      connectTimeout: options.connectTimeoutMs,
      // Fail a command instead of queueing it forever when Redis is unreachable: callers
      // decide what to do, and the process never accumulates an unbounded backlog.
      maxRetriesPerRequest: 2,
      enableOfflineQueue: false,
      lazyConnect: true,
    });

    this.client.on('error', (error: unknown) => {
      options.logger.error({ err: error }, 'redis connection error');
    });
  }

  async connect(): Promise<void> {
    await this.client.connect();
  }

  async disconnect(): Promise<void> {
    await this.client.quit();
  }

  async ping(): Promise<void> {
    await this.client.ping();
  }

  get keyPrefix(): string {
    return this.options.keyPrefix;
  }
}
