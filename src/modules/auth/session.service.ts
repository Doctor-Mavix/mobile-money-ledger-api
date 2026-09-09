import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

import { env } from '@core/config/env';
import type { RedisConnection } from '@core/redis/redis.client';
import { UnauthorizedError } from '@core/errors/app-error';
import type { ActorType, DeviceInfo, Session } from './auth.types';

const SESSION_KEY = 'auth:session:';
const ACTOR_SESSIONS_KEY = 'auth:sessions:';
const SECRET_BYTES = 32;

interface StoredSession {
  id: string;
  actorId: string;
  actorType: ActorType;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
  lastSeenAt: string;
  refreshHash: string;
}

export interface IssuedSession {
  session: Session;
  refreshToken: string;
}

export interface RefreshOutcome {
  session: Session;
  refreshToken: string;
}

/**
 * Thrown when a refresh token that is not the current one is presented for a live session.
 * The secret is 256 bits of randomness, so it cannot have been guessed: someone is replaying a
 * token that was already rotated, which means a copy of it leaked.
 */
export class RefreshReuseError extends Error {
  constructor(readonly actorId: string) {
    super('refresh token reuse detected');
    this.name = 'RefreshReuseError';
  }
}

/**
 * Sessions live in Redis, not in a signed token, because that is what makes "log out this
 * device" take effect immediately across every instance. The access token stays stateless and
 * short-lived; the session is the thing that can be revoked.
 */
export class SessionService {
  constructor(private readonly redis: RedisConnection) {}

  async issue(actorId: string, actorType: ActorType, device: DeviceInfo): Promise<IssuedSession> {
    const now = new Date();
    const secret = randomBytes(SECRET_BYTES).toString('base64url');
    const stored: StoredSession = {
      id: randomUUID(),
      actorId,
      actorType,
      ip: device.ip,
      userAgent: device.userAgent,
      createdAt: now.toISOString(),
      lastSeenAt: now.toISOString(),
      refreshHash: digest(secret),
    };

    await this.persist(stored);
    await this.redis.client.sadd(ACTOR_SESSIONS_KEY + actorId, stored.id);

    return { session: toSession(stored), refreshToken: encode(stored.id, secret) };
  }

  /**
   * Rotates on every use: the presented token is invalidated whether or not the caller ever
   * uses the new one. A refresh token is therefore single-use by construction, which is what
   * makes reuse detectable at all.
   */
  async rotate(refreshToken: string, device: DeviceInfo): Promise<RefreshOutcome> {
    const parsed = decode(refreshToken);

    if (parsed === null) {
      throw new UnauthorizedError('Your session is no longer valid');
    }

    const stored = await this.read(parsed.sessionId);

    if (stored === null) {
      throw new UnauthorizedError('Your session is no longer valid');
    }

    if (!matches(stored.refreshHash, parsed.secret)) {
      throw new RefreshReuseError(stored.actorId);
    }

    const secret = randomBytes(SECRET_BYTES).toString('base64url');
    const rotated: StoredSession = {
      ...stored,
      lastSeenAt: new Date().toISOString(),
      ip: device.ip ?? stored.ip,
      userAgent: device.userAgent ?? stored.userAgent,
      refreshHash: digest(secret),
    };

    await this.persist(rotated);

    return { session: toSession(rotated), refreshToken: encode(rotated.id, secret) };
  }

  async exists(sessionId: string): Promise<boolean> {
    return (await this.read(sessionId)) !== null;
  }

  async listForActor(actorId: string): Promise<Session[]> {
    const ids = await this.redis.client.smembers(ACTOR_SESSIONS_KEY + actorId);
    const sessions = await Promise.all(ids.map(async (id) => this.read(id)));

    return sessions
      .filter((session): session is StoredSession => session !== null)
      .map(toSession)
      .sort((left, right) => right.lastSeenAt.getTime() - left.lastSeenAt.getTime());
  }

  async revoke(actorId: string, sessionId: string): Promise<boolean> {
    const stored = await this.read(sessionId);

    // Scoped to the actor so a stolen session id cannot be used to log someone else out.
    if (stored?.actorId !== actorId) {
      return false;
    }

    await this.redis.client.del(SESSION_KEY + sessionId);
    await this.redis.client.srem(ACTOR_SESSIONS_KEY + actorId, sessionId);

    return true;
  }

  /** Used by logout-all, by a password change, and by reuse detection. */
  async revokeAll(actorId: string, exceptSessionId?: string): Promise<number> {
    const ids = await this.redis.client.smembers(ACTOR_SESSIONS_KEY + actorId);
    const doomed = ids.filter((id) => id !== exceptSessionId);

    if (doomed.length === 0) {
      return 0;
    }

    await this.redis.client.del(...doomed.map((id) => SESSION_KEY + id));
    await this.redis.client.srem(ACTOR_SESSIONS_KEY + actorId, ...doomed);

    return doomed.length;
  }

  private async read(sessionId: string): Promise<StoredSession | null> {
    const raw = await this.redis.client.get(SESSION_KEY + sessionId);

    return raw === null ? null : (JSON.parse(raw) as StoredSession);
  }

  private async persist(session: StoredSession): Promise<void> {
    // The TTL is reset on every rotation, which is what makes the 30 days sliding rather than
    // absolute: an active device is never logged out, an abandoned one expires on its own.
    await this.redis.client.set(
      SESSION_KEY + session.id,
      JSON.stringify(session),
      'EX',
      env.REFRESH_TOKEN_TTL_SECONDS,
    );
  }
}

function toSession(stored: StoredSession): Session {
  return {
    id: stored.id,
    actorId: stored.actorId,
    actorType: stored.actorType,
    ip: stored.ip,
    userAgent: stored.userAgent,
    createdAt: new Date(stored.createdAt),
    lastSeenAt: new Date(stored.lastSeenAt),
  };
}

/**
 * SHA-256 rather than argon2: the secret is 256 bits of CSPRNG output, so there is no
 * dictionary to run against it. argon2 would add its full cost to every refresh and defend
 * against an attack that cannot happen. Passwords are the opposite case, and use argon2.
 */
function digest(secret: string): string {
  return createHash('sha256').update(secret).digest('base64url');
}

function matches(expected: string, candidate: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(digest(candidate));

  return left.length === right.length && timingSafeEqual(left, right);
}

/** The session id travels with the secret so a refresh is one Redis read, not a scan. */
function encode(sessionId: string, secret: string): string {
  return `${sessionId}.${secret}`;
}

function decode(token: string): { sessionId: string; secret: string } | null {
  const separator = token.indexOf('.');

  if (separator <= 0 || separator === token.length - 1) {
    return null;
  }

  return { sessionId: token.slice(0, separator), secret: token.slice(separator + 1) };
}
