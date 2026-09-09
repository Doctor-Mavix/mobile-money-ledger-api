import { z } from 'zod';

import { env } from '@core/config/env';
import {
  getControllerMetadata,
  getHttpCode,
  getMediaTypes,
  getRoutes,
  getValidationSchemas,
  resolveAccess,
} from '@core/decorators/metadata';
import { joinPaths } from '@core/decorators/path';
import type { AccessMetadata, MediaTypes, ValidationSchemas } from '@core/decorators/types';
import { HttpStatus } from '@core/http/http-status';
import type { AppModule } from '@core/module';
import type { Constructor } from '@core/types';

type JsonSchema = Record<string, unknown>;

interface Parameter {
  name: string;
  in: 'path' | 'query';
  required: boolean;
  schema: JsonSchema;
}

interface Operation {
  tags: string[];
  summary: string;
  operationId: string;
  security?: { bearerAuth: string[] }[];
  parameters?: Parameter[];
  requestBody?: JsonSchema;
  responses: Record<string, JsonSchema>;
}

export interface OpenApiDocument {
  openapi: string;
  info: { title: string; version: string; description: string };
  servers: { url: string }[];
  components: { securitySchemes: JsonSchema; schemas: Record<string, JsonSchema> };
  security: { bearerAuth: string[] }[];
  paths: Record<string, Record<string, Operation>>;
}

/** `/accounts/:id` in Express is `/accounts/{id}` in OpenAPI. */
function toTemplate(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

/**
 * `io: 'input'` describes what a caller must send rather than what the schema produces, which
 * is what matters for a request: a coerced number is a string on the wire, and a field with a
 * default is optional. `unrepresentable: 'any'` keeps a transform from failing the whole build.
 */
function toJsonSchema(schema: z.ZodType): JsonSchema {
  return z.toJSONSchema(schema, {
    target: 'openapi-3.0',
    io: 'input',
    unrepresentable: 'any',
  });
}

function toParameters(schema: z.ZodType, location: 'path' | 'query'): Parameter[] {
  const json = toJsonSchema(schema);
  const properties = (json['properties'] ?? {}) as Record<string, JsonSchema>;
  const required = new Set((json['required'] ?? []) as string[]);

  return Object.entries(properties).map(([name, property]) => ({
    name,
    in: location,
    // A path parameter is required by definition, whatever the schema says.
    required: location === 'path' || required.has(name),
    schema: property,
  }));
}

function envelope(data: JsonSchema): JsonSchema {
  return {
    type: 'object',
    required: ['success', 'data'],
    properties: {
      success: { type: 'boolean', enum: [true] },
      data,
      message: { type: 'string' },
      meta: { type: 'object', additionalProperties: true },
      requestId: { type: 'string', format: 'uuid' },
    },
  };
}

function errorResponse(description: string): JsonSchema {
  return {
    description,
    content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
  };
}

/**
 * The status codes the framework itself can produce on any route, so that a client generated
 * from this document handles them without each controller having to redeclare them.
 */
function commonResponses(
  access: AccessMetadata,
  hasValidation: boolean,
): Record<string, JsonSchema> {
  return {
    ...(hasValidation ? { '422': errorResponse('The request failed schema validation') } : {}),
    ...(access.isPublic
      ? {}
      : {
          '401': errorResponse('No token, or a token that is expired or revoked'),
          ...(access.roles.length > 0 || access.permissions.length > 0
            ? { '403': errorResponse('Authenticated, but missing a required role or permission') }
            : {}),
        }),
    '429': errorResponse('Rate limit exceeded'),
    '500': errorResponse('Unexpected server error'),
  };
}

function successResponse(status: number, produces: string | undefined): Record<string, JsonSchema> {
  if (status === HttpStatus.NO_CONTENT) {
    return { '204': { description: 'No content' } };
  }

  // A declared media type means the handler writes the response itself, so there is no envelope
  // and no schema to give — only the fact that the bytes are not JSON.
  const content =
    produces === undefined
      ? { 'application/json': { schema: envelope({ description: 'Operation payload' }) } }
      : { [produces]: { schema: { type: 'string', format: 'binary' } } };

  return { [String(status)]: { description: 'Success', content } };
}

function requestBody(
  schemas: ValidationSchemas | undefined,
  media: MediaTypes | undefined,
): JsonSchema | undefined {
  if (media?.consumes !== undefined) {
    return { required: true, content: { [media.consumes]: { schema: {} } } };
  }

  return schemas?.body === undefined
    ? undefined
    : {
        required: true,
        content: { 'application/json': { schema: toJsonSchema(schemas.body) } },
      };
}

/** Turns `listForActor` into `List for actor`, which reads better than a bare method name. */
function toSummary(handlerName: string): string {
  const words = handlerName.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();

  return words.charAt(0).toUpperCase() + words.slice(1);
}

function buildOperations(
  appModule: AppModule,
  controller: Constructor,
  paths: Record<string, Record<string, Operation>>,
): void {
  const metadata = getControllerMetadata(controller);
  if (metadata === undefined) {
    return;
  }

  const mountPath = appModule.mountPath ?? env.API_PREFIX;

  for (const route of getRoutes(controller)) {
    const access = resolveAccess(controller, route.handlerName);
    const schemas = getValidationSchemas(controller, route.handlerName);
    const status =
      getHttpCode(controller, route.handlerName) ??
      (route.method === 'post' ? HttpStatus.CREATED : HttpStatus.OK);

    const media = getMediaTypes(controller, route.handlerName);
    const body = requestBody(schemas, media);

    const parameters = [
      ...(schemas?.params === undefined ? [] : toParameters(schemas.params, 'path')),
      ...(schemas?.query === undefined ? [] : toParameters(schemas.query, 'query')),
    ];

    const operation: Operation = {
      tags: [appModule.name],
      summary: toSummary(route.handlerName),
      operationId: `${controller.name}_${route.handlerName}`,
      // An empty array means "no authentication", which overrides the document-wide default.
      security: access.isPublic ? [] : [{ bearerAuth: [] }],
      ...(parameters.length > 0 ? { parameters } : {}),
      ...(body === undefined ? {} : { requestBody: body }),
      responses: {
        ...successResponse(status, media?.produces),
        ...commonResponses(access, schemas !== undefined),
      },
    };

    const path = toTemplate(joinPaths(mountPath, joinPaths(metadata.basePath, route.path)));
    paths[path] = { ...paths[path], [route.method]: operation };
  }
}

export function buildOpenApiDocument(modules: readonly AppModule[]): OpenApiDocument {
  const paths: Record<string, Record<string, Operation>> = {};

  for (const appModule of modules) {
    for (const controller of appModule.controllers) {
      buildOperations(appModule, controller, paths);
    }
  }

  return {
    openapi: '3.0.3',
    info: {
      title: env.APP_NAME,
      version: env.APP_VERSION,
      description:
        'Generated from the route registry and the Zod schemas that validate every request, ' +
        'so it cannot drift from the code that serves it.',
    },
    // Relative on purpose: the UI is served by the API itself, so whatever host reached the
    // page can reach the routes — including through nginx, where the app cannot know its own
    // public name.
    servers: [{ url: '/' }],
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      },
      schemas: {
        ApiError: {
          type: 'object',
          required: ['success', 'error'],
          properties: {
            success: { type: 'boolean', enum: [false] },
            error: {
              type: 'object',
              required: ['code', 'message'],
              properties: {
                code: { type: 'string' },
                message: { type: 'string' },
                details: {},
              },
            },
            requestId: { type: 'string', format: 'uuid' },
          },
        },
      },
    },
    security: [{ bearerAuth: [] }],
    paths,
  };
}
