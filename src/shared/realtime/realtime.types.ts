import type { Server as HttpServer } from 'node:http';

/**
 * The one contract shared by the server and every client. Adding an event here is what makes
 * it typed on both sides; emitting a string the map does not know is a compile error.
 */
export interface RealtimeEvents {
  'notification.created': {
    id: string;
    type: string;
    title: string;
    body: string;
    createdAt: string;
  };
  'media.processed': {
    id: string;
    ownerType: string;
    ownerId: string;
    variants: readonly string[];
  };
}

export type RealtimeEvent = keyof RealtimeEvents;

/** Rooms follow one convention so a service never has to guess a room name. */
export const rooms = {
  actor: (actorId: string): string => `actor:${actorId}`,
  role: (role: string): string => `role:${role}`,
  entity: (module: string, entityId: string): string => `module:${module}:${entityId}`,
} as const;

export interface SocketIdentity {
  actorId: string;
  roles: readonly string[];
}

/** Implemented by the auth module; the kit only knows how to ask. */
export interface SocketAuthenticator {
  authenticate(handshake: {
    token: string | undefined;
    actorId: string | undefined;
  }): Promise<SocketIdentity | null>;
}

export interface RealtimeGateway {
  attach(server: HttpServer): Promise<void>;
  emitTo<TEvent extends RealtimeEvent>(
    room: string,
    event: TEvent,
    payload: RealtimeEvents[TEvent],
  ): void;
  close(): Promise<void>;
}
