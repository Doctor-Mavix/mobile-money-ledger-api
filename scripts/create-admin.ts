import 'reflect-metadata';

import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';

import { env } from '@core/config/env';
import { createAppContainer } from '@core/container';
import { TOKENS } from '@core/container/tokens';
import { createDatabaseAdapter } from '@core/database';
import { logger } from '@core/logger/logger';
import { registerModules } from '@core/module';
import { RedisConnection } from '@core/redis/redis.client';
import { AUTH_REPOSITORY } from '@modules/auth/auth.repository';
import { authModule } from '@modules/auth/auth.module';
import { PasswordService } from '@modules/auth/password.service';
import { registerSharedServices } from '@shared/index';
import { notificationModule } from '@shared/notifications/notification.module';

/**
 * Creates the first account that can reach a guarded route, or promotes one that exists.
 *
 * Nothing else can do it: registration always produces a role-less actor, and roles are only
 * ever read from the token. Written against the repository interface rather than against
 * Prisma, so it does not have to be rewritten when a repository is.
 *
 *   pnpm admin:create --email agent@fintech.local --password '…' [--role admin] [--type agent]
 */
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      email: { type: 'string' },
      password: { type: 'string' },
      name: { type: 'string', default: 'Administrator' },
      type: { type: 'string', default: 'agent' },
      role: { type: 'string', multiple: true, default: ['admin'] },
    },
  });

  const { email, password, name, type, role: roles } = values;

  if (email === undefined || password === undefined) {
    throw new Error('Usage: pnpm admin:create --email <address> --password <password>');
  }

  const database = createDatabaseAdapter({ softDeleteModels: [] });
  const redis = new RedisConnection({
    url: env.REDIS_URL,
    keyPrefix: env.REDIS_KEY_PREFIX,
    connectTimeoutMs: env.DB_CONNECT_TIMEOUT_MS,
    logger,
  });

  await database.connect();
  await redis.connect();

  try {
    const container = createAppContainer();
    container.registerInstance(TOKENS.DatabaseAdapter, database);
    container.registerInstance(TOKENS.Redis, redis);

    registerSharedServices(container);
    // Auth refuses to register without notifications, and this script speaks to the same
    // repository the running server does rather than to a second, divergent code path.
    registerModules([notificationModule, authModule], {
      container,
      provider: database.provider,
      adapter: database,
    });

    const repository = container.resolve(AUTH_REPOSITORY);
    const passwords = container.resolve(PasswordService);
    const existing = await repository.findByEmail(type, email);

    // Already verified and active on creation: this account is provisioned by an operator who
    // has shell access to the server, not by someone who has to prove they own the address.
    const actor = existing
      ? await repository.updateActor(existing.actor.id, { roles, status: 'active' })
      : await repository.createActor({
          id: randomUUID(),
          actorType: type,
          email,
          displayName: name,
          passwordHash: await passwords.hash(password),
          phone: null,
          roles,
          permissions: [],
          status: 'active',
        });

    if (!existing && actor) {
      await repository.updateActor(actor.actor.id, { emailVerifiedAt: new Date() });
    }

    process.stdout.write(
      `${existing ? 'Promoted' : 'Created'} ${type} ${email} with roles [${roles.join(', ')}]\n`,
    );
  } finally {
    await database.disconnect();
    await redis.disconnect();
  }
}

await main();
