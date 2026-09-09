import { createServer } from 'node:http';
import type { Server } from 'node:http';

import { SHUTDOWN_SIGNALS } from '@core/config/constants';
import { env } from '@core/config/env';
import { createAppContainer } from '@core/container';
import { TOKENS } from '@core/container/tokens';
import { createDatabaseAdapter } from '@core/database';
import { collectSoftDeleteModels, registerModules, selectModules } from '@core/module';
import { logger } from '@core/logger/logger';
import { RedisConnection } from '@core/redis/redis.client';
import { rateLimitMiddleware } from '@core/security/rate-limit.middleware';
import { SHARED_TOKENS, registerSharedServices } from '@shared/index';
import { createApp } from './app';
import { APP_MODULES } from './modules';

/** Paths the limiter must never reject: an orchestrator polls them constantly. */
const PROBE_PATHS = new Set(['/health', '/ready']);

async function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(env.PORT, env.HOST, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
}

async function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolve();
        return;
      }
      reject(error);
    });
  });
}

function registerShutdown(server: Server, releaseResources: () => Promise<void>): void {
  let shuttingDown = false;

  const shutdown = (signal: string): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');

    const forceExit = setTimeout(() => {
      logger.fatal({ signal }, 'graceful shutdown timed out, forcing exit');
      process.exit(1);
    }, env.SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();

    // Stop accepting requests first, then release the connections in-flight work needed.
    void close(server)
      .then(releaseResources)
      .then(() => {
        logger.info('shutdown complete');
        process.exit(0);
      })
      .catch((error: unknown) => {
        logger.fatal({ err: error }, 'shutdown failed');
        process.exit(1);
      });
  };

  for (const signal of SHUTDOWN_SIGNALS) {
    process.on(signal, () => {
      shutdown(signal);
    });
  }

  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'unhandled rejection');
    shutdown('unhandledRejection');
  });

  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'uncaught exception');
    shutdown('uncaughtException');
  });
}

export async function bootstrap(): Promise<Server> {
  const container = createAppContainer();
  const modules = selectModules(APP_MODULES, env.MODULES_ENABLED);

  const database = createDatabaseAdapter({ softDeleteModels: collectSoftDeleteModels(modules) });
  const redis = new RedisConnection({
    url: env.REDIS_URL,
    keyPrefix: env.REDIS_KEY_PREFIX,
    connectTimeoutMs: env.DB_CONNECT_TIMEOUT_MS,
    logger,
  });

  // Both are connected before the first route is mounted: a process that cannot reach its
  // stores must fail at boot, not answer 500s to real users.
  await database.connect();
  await redis.connect();

  container.registerInstance(TOKENS.DatabaseAdapter, database);
  container.registerInstance(TOKENS.Redis, redis);

  const health = container.resolve(TOKENS.HealthCheckRegistry);
  health.register({ name: `database:${database.provider}`, check: () => database.ping() });
  health.register({ name: 'redis', check: () => redis.ping() });

  registerSharedServices(container);
  registerModules(modules, { container, provider: database.provider, adapter: database });

  const app = createApp({
    container,
    modules,
    ...(env.RATE_LIMIT_ENABLED
      ? {
          rateLimiter: rateLimitMiddleware({
            redis,
            logger,
            windowMs: env.RATE_LIMIT_WINDOW_MS,
            max: env.RATE_LIMIT_MAX,
            skip: (req) => PROBE_PATHS.has(req.path),
          }),
        }
      : {}),
  });

  const server = createServer(app);

  server.requestTimeout = env.REQUEST_TIMEOUT_MS;
  server.headersTimeout = env.HEADERS_TIMEOUT_MS;
  server.keepAliveTimeout = env.KEEP_ALIVE_TIMEOUT_MS;

  const queue = container.resolve(SHARED_TOKENS.Queue);
  const realtime = container.resolve(SHARED_TOKENS.Realtime);

  // Workers start once every module has registered its handlers, or a job picked up early
  // would fail for a handler this process does know about.
  queue.startWorkers();
  await realtime.attach(server);

  await listen(server);
  registerShutdown(server, async () => {
    await realtime.close();
    await queue.close();
    await database.disconnect();
    await redis.disconnect();
  });

  logger.info(
    {
      host: env.HOST,
      port: env.PORT,
      provider: database.provider,
      modules: modules.map((appModule) => appModule.name),
    },
    `${env.APP_NAME} is listening`,
  );

  return server;
}
