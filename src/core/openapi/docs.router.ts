import { createHash, timingSafeEqual } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';

import express from 'express';
import type { RequestHandler, Router } from 'express';
import helmet from 'helmet';

import { env } from '@core/config/env';
import type { AppModule } from '@core/module';
import { buildOpenApiDocument } from '@core/openapi/document';

/**
 * Resolved rather than imported: `swagger-ui-dist`'s entry point pulls the whole browser bundle
 * into the Node process just to expose a directory name.
 */
const require = createRequire(import.meta.url);
const ASSETS = dirname(require.resolve('swagger-ui-dist/package.json'));

/** Compares digests, so the answer takes the same time whatever the first wrong character is. */
function matches(candidate: string, expected: string): boolean {
  return timingSafeEqual(
    createHash('sha256').update(candidate).digest(),
    createHash('sha256').update(expected).digest(),
  );
}

function basicAuth(): RequestHandler {
  return (request, response, next) => {
    const header = request.get('authorization') ?? '';
    const [scheme, encoded] = header.split(' ');
    const [user, ...rest] = Buffer.from(encoded ?? '', 'base64')
      .toString('utf8')
      .split(':');

    if (
      scheme?.toLowerCase() === 'basic' &&
      matches(user ?? '', env.DOCS_USER) &&
      matches(rest.join(':'), env.DOCS_PASSWORD)
    ) {
      next();

      return;
    }

    response
      .status(401)
      .set('www-authenticate', `Basic realm="${env.APP_NAME} docs", charset="UTF-8"`)
      .end();
  };
}

/**
 * The application policy is `default-src 'none'`, which would leave the page blank. Swagger UI
 * needs its own scripts and styles, and injects inline styles as it renders.
 */
function docsCsp(): RequestHandler {
  return helmet.contentSecurityPolicy({
    directives: {
      defaultSrc: ["'none'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      fontSrc: ["'self'", 'data:'],
      // Same origin only: "Try it out" calls the API that serves this page, nothing else.
      connectSrc: ["'self'"],
      frameAncestors: ["'none'"],
      baseUri: ["'none'"],
      formAction: ["'none'"],
    },
  });
}

function page(): string {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex, nofollow" />
    <title>${env.APP_NAME} — API reference</title>
    <link rel="stylesheet" href="${env.DOCS_PATH}/swagger-ui.css" />
    <link rel="icon" href="${env.DOCS_PATH}/favicon-32x32.png" sizes="32x32" />
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="${env.DOCS_PATH}/swagger-ui-bundle.js"></script>
    <script src="${env.DOCS_PATH}/swagger-ui-standalone-preset.js"></script>
    <script src="${env.DOCS_PATH}/swagger-initializer.js"></script>
  </body>
</html>
`;
}

/** Replaces the one shipped by the package, which points at the public Petstore example. */
function initializer(): string {
  return `window.ui = SwaggerUIBundle({
  url: ${JSON.stringify(`${env.DOCS_PATH}/openapi.json`)},
  dom_id: '#swagger-ui',
  presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
  layout: 'StandaloneLayout',
  deepLinking: true,
  persistAuthorization: true,
});
`;
}

export function docsRouter(modules: readonly AppModule[]): Router {
  const router = express.Router();
  const document = buildOpenApiDocument(modules);

  if (env.DOCS_PASSWORD !== '') {
    router.use(basicAuth());
  }
  router.use(docsCsp());

  router.get('/openapi.json', (_request, response) => {
    response.json(document);
  });

  router.get('/', (_request, response) => {
    response.type('html').send(page());
  });

  router.get('/swagger-initializer.js', (_request, response) => {
    response.type('js').send(initializer());
  });

  router.use(express.static(ASSETS, { index: false }));

  return router;
}
