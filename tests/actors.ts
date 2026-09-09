import { randomUUID } from 'node:crypto';

import { Secret, TOTP } from 'otpauth';
import type { DependencyContainer } from 'tsyringe';

import { env } from '@core/config/env';
import { PrismaAdapter } from '@core/database/sql/prisma.adapter';
import type { DatabaseAdapter } from '@core/database/types';
import { AUTH_REPOSITORY } from '@modules/auth/auth.repository';
import type { ActorStatus, ActorType } from '@modules/auth/auth.types';
import { JwtService } from '@modules/auth/jwt.service';
import { PasswordService } from '@modules/auth/password.service';
import { seal } from '@modules/auth/secret-box';
import { SessionService } from '@modules/auth/session.service';

/** Long enough for the default policy, and the same everywhere so a failure is easy to read. */
export const TEST_PASSWORD = 'correct-horse-battery-staple';

export interface SeedActorOptions {
  actorType?: ActorType;
  email?: string;
  password?: string;
  displayName?: string;
  roles?: readonly string[];
  permissions?: readonly string[];
  status?: ActorStatus;
}

export interface SeededActor {
  id: string;
  actorType: ActorType;
  email: string;
  password: string;
  accessToken: string;
  refreshToken: string;
  sessionId: string;
}

export function bearer(token: string): string {
  return `Bearer ${token}`;
}

export function testEmail(prefix: string): string {
  return `${prefix}-${randomUUID()}@orangcode.test`;
}

/**
 * Creates an actor and signs it in without going through `/auth/login`: a suite that only needs
 * a bearer token to reach a guarded endpoint should not have its setup fail because of the flow
 * it is not testing.
 */
export async function seedActor(
  container: DependencyContainer,
  options: SeedActorOptions = {},
): Promise<SeededActor> {
  const repository = container.resolve(AUTH_REPOSITORY);
  const passwords = container.resolve(PasswordService);
  const sessions = container.resolve(SessionService);
  const jwt = container.resolve(JwtService);

  const password = options.password ?? TEST_PASSWORD;
  const created = await repository.createActor({
    id: randomUUID(),
    actorType: options.actorType ?? 'user',
    email: options.email ?? testEmail('actor'),
    displayName: options.displayName ?? 'Test actor',
    passwordHash: await passwords.hash(password),
    phone: null,
    roles: options.roles ?? [],
    permissions: options.permissions ?? [],
    status: options.status ?? 'active',
  });

  const { actor } = created;
  const issued = await sessions.issue(actor.id, actor.actorType, { ip: null, userAgent: null });

  return {
    id: actor.id,
    actorType: actor.actorType,
    email: actor.email,
    password,
    sessionId: issued.session.id,
    refreshToken: issued.refreshToken,
    accessToken: await jwt.sign({
      actorId: actor.id,
      actorType: actor.actorType,
      roles: actor.roles,
      permissions: actor.permissions,
      sessionId: issued.session.id,
    }),
  };
}

/**
 * Switches two-factor authentication on for an actor and hands back a generator for valid
 * codes. It writes the sealed secret straight to the row rather than walking
 * `/auth/mfa/setup` then `/auth/mfa/confirm`: a suite testing transfers should not fail
 * because of the enrolment flow it is not testing.
 *
 * The TOTP is built with the same parameters `MfaService` uses, so a code this returns is a
 * code the real verifier accepts — if those parameters ever diverge, these suites go red,
 * which is the point.
 */
export async function enableMfa(
  container: DependencyContainer,
  actor: Pick<SeededActor, 'id' | 'email'>,
): Promise<() => string> {
  const secret = new Secret({ size: 20 });

  await container.resolve(AUTH_REPOSITORY).updateActor(actor.id, {
    mfaSecret: seal(secret.base32),
    mfaEnabledAt: new Date(),
    mfaBackupCodes: [],
  });

  const totp = new TOTP({
    issuer: env.APP_NAME,
    label: actor.email,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret,
  });

  return () => totp.generate();
}

/** Actors are never soft-deleted, so a suite has to remove its own rows on the way out. */
export async function purgeActors(
  adapter: DatabaseAdapter,
  actorIds: readonly string[],
): Promise<void> {
  if (actorIds.length === 0) {
    return;
  }

  const ids = [...actorIds];

  if (adapter instanceof PrismaAdapter) {
    await adapter.client.authAudit.deleteMany({ where: { actorId: { in: ids } } });
    await adapter.client.notification.deleteMany({ where: { actorId: { in: ids } } });
    await adapter.client.actor.deleteMany({ where: { id: { in: ids } } });
  }
}
