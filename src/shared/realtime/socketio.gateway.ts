import type { Server as HttpServer } from 'node:http';

import { createAdapter } from '@socket.io/redis-adapter';
import type { Socket } from 'socket.io';
import { Server } from 'socket.io';

import type { Logger } from '@core/logger/logger';
import type { RedisConnection } from '@core/redis/redis.client';
import type {
  RealtimeEvent,
  RealtimeEvents,
  RealtimeGateway,
  SocketAuthenticator,
  SocketIdentity,
} from './realtime.types';
import { rooms } from './realtime.types';

export interface SocketIoGatewayOptions {
  redis: RedisConnection;
  logger: Logger;
  path: string;
  corsOrigins: readonly string[];
  isProduction: boolean;
  /**
   * Resolved on demand rather than injected: the gateway is built with the kit, and the auth
   * module that provides the authenticator registers later. Reading it at `attach` time — and
   * at every handshake — is what lets the two be wired in either order.
   */
  authenticator?: () => SocketAuthenticator | undefined;
}

/**
 * Socket.IO behind the Redis adapter. Without the adapter a client connected to instance A
 * never receives what instance B emits, so the feature appears to work until the day a second
 * server is started.
 */
export class SocketIoGateway implements RealtimeGateway {
  private server: Server | null = null;

  constructor(private readonly options: SocketIoGatewayOptions) {}

  attach(httpServer: HttpServer): Promise<void> {
    if (this.options.isProduction && this.options.authenticator?.() === undefined) {
      // Fail at boot rather than at the first handshake: without an authenticator the gateway
      // would have to trust a client-declared identity, and anyone could join anyone's rooms.
      throw new Error('REALTIME_ENABLED requires a SocketAuthenticator in production');
    }

    const server = new Server(httpServer, {
      path: this.options.path,
      cors: { origin: [...this.options.corsOrigins], credentials: true },
      // Sockets outlive requests, so an idle one must be reaped rather than held forever.
      pingInterval: 25_000,
      pingTimeout: 20_000,
    });

    // `duplicate()` copies the request-path options, and those are the wrong ones here: the
    // adapter subscribes the moment it is built, so a lazy connection has no socket yet and a
    // disabled offline queue turns that into a fatal error instead of a buffered command.
    const pubSubOptions = { lazyConnect: false, enableOfflineQueue: true } as const;
    const publisher = this.options.redis.client.duplicate(pubSubOptions);
    const subscriber = this.options.redis.client.duplicate(pubSubOptions);

    server.adapter(createAdapter(publisher, subscriber));

    server.use((socket, next) => {
      // The rooms must be joined before `next()`, not alongside it: the handshake completes as
      // soon as the middleware yields, and an event emitted in that window would reach a socket
      // that has not joined anything yet.
      this.admit(socket).then(
        () => {
          next();
        },
        (error: unknown) => {
          next(error instanceof Error ? error : new Error('unauthorized'));
        },
      );
    });

    this.server = server;
    this.options.logger.info({ path: this.options.path }, 'realtime gateway attached');

    return Promise.resolve();
  }

  private async admit(socket: Socket): Promise<void> {
    const identity = await this.identify(socket.handshake.auth);

    if (identity === null) {
      throw new Error('unauthorized');
    }

    await socket.join([
      rooms.actor(identity.actorId),
      ...identity.roles.map((role) => rooms.role(role)),
    ]);
  }

  emitTo<TEvent extends RealtimeEvent>(
    room: string,
    event: TEvent,
    payload: RealtimeEvents[TEvent],
  ): void {
    // Emitting before attach is not an error: a job can run before the HTTP server is up, and
    // a realtime event nobody is listening for is simply lost — that is what makes it realtime.
    this.server?.to(room).emit(event, payload);
  }

  async close(): Promise<void> {
    await this.server?.close();
    this.server = null;
  }

  private async identify(auth: Record<string, unknown>): Promise<SocketIdentity | null> {
    const token = typeof auth['token'] === 'string' ? auth['token'] : undefined;
    const actorId = typeof auth['actorId'] === 'string' ? auth['actorId'] : undefined;
    const authenticator = this.options.authenticator?.();

    if (authenticator !== undefined) {
      return authenticator.authenticate({ token, actorId });
    }

    if (actorId === undefined) {
      return null;
    }

    this.options.logger.warn(
      { actorId },
      'realtime handshake trusted without authentication (development only)',
    );

    return { actorId, roles: ['admin'] };
  }
}
