import compression from 'compression';
import type { Express, RequestHandler } from 'express';
import express from 'express';
import hpp from 'hpp';
import type { DependencyContainer } from 'tsyringe';

import { env } from '@core/config/env';
import { buildRouter } from '@core/decorators/registry';
import { joinPaths } from '@core/decorators/path';
import { contextMiddleware } from '@core/http/context.middleware';
import { errorMiddleware } from '@core/http/error.middleware';
import { notFoundMiddleware } from '@core/http/not-found.middleware';
import { httpLogger } from '@core/logger/http-logger';
import { logger } from '@core/logger/logger';
import type { AppModule } from '@core/module';
import { docsRouter } from '@core/openapi/docs.router';
import { corsMiddleware } from '@core/security/cors';
import { helmetMiddleware } from '@core/security/helmet';

export interface CreateAppOptions {
  container: DependencyContainer;
  modules: readonly AppModule[];
  /** Built by the bootstrap because it needs Redis; omitted when RATE_LIMIT_ENABLED is false. */
  rateLimiter?: RequestHandler;
}

function parseTrustProxy(value: string): boolean | number | string {
  if (value === 'true' || value === 'false') {
    return value === 'true';
  }

  const asNumber = Number(value);

  return Number.isInteger(asNumber) && asNumber >= 0 ? asNumber : value;
}

export function createApp(options: CreateAppOptions): Express {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', parseTrustProxy(env.TRUST_PROXY));

  app.use(contextMiddleware());
  app.use(helmetMiddleware());
  app.use(corsMiddleware());
  // Logging precedes the limiter so a rejected flood still leaves a trace, and the limiter
  // precedes body parsing so a rejected request never pays for it.
  app.use(httpLogger());
  if (options.rateLimiter !== undefined) {
    app.use(options.rateLimiter);
  }
  app.use(compression());
  app.use(express.json({ limit: env.BODY_LIMIT }));
  app.use(express.urlencoded({ extended: false, limit: env.BODY_LIMIT }));
  app.use(hpp());

  // Before the modules: the document is built from the same list, so mounting it here keeps
  // the reference reachable even if a module later claims a broad prefix.
  if (env.DOCS_ENABLED) {
    app.use(env.DOCS_PATH, docsRouter(options.modules));
  }

  for (const appModule of options.modules) {
    const mountPath = appModule.mountPath ?? env.API_PREFIX;
    const router = buildRouter({
      container: options.container,
      controllers: appModule.controllers,
      onRoute: (route) => {
        logger.debug(
          { module: appModule.name, ...route, path: joinPaths(mountPath, route.path) },
          'route mounted',
        );
      },
    });

    app.use(mountPath, router);
  }

  app.use(notFoundMiddleware());
  app.use(errorMiddleware(logger));

  return app;
}
