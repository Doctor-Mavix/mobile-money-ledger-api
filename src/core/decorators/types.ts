import type { RequestHandler } from 'express';
import type { ZodType } from 'zod';

export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete' | 'options' | 'head';

export interface RouteDefinition {
  method: HttpMethod;
  path: string;
  handlerName: string;
}

export interface ControllerMetadata {
  basePath: string;
}

export interface ValidationSchemas {
  body?: ZodType;
  query?: ZodType;
  params?: ZodType;
}

/**
 * What a route accepts and sends when it is not the default `application/json` — a file upload,
 * a CSV export. Nothing at runtime reads this: it exists so the generated OpenAPI document does
 * not promise JSON where the handler streams something else.
 */
export interface MediaTypes {
  consumes?: string;
  produces?: string;
}

export interface AccessMetadata {
  isPublic: boolean;
  roles: readonly string[];
  permissions: readonly string[];
}

export type RouteDecorator = (target: object, propertyKey: string | symbol) => void;

export type TargetDecorator = (target: object, propertyKey?: string | symbol) => void;

export type MiddlewareList = readonly RequestHandler[];
