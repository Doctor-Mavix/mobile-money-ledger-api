import 'reflect-metadata';

import type { RequestHandler } from 'express';

import type {
  AccessMetadata,
  ControllerMetadata,
  MediaTypes,
  MiddlewareList,
  RouteDefinition,
  ValidationSchemas,
} from '@core/decorators/types';

export interface AccessPatch {
  isPublic?: boolean;
  roles?: readonly string[];
  permissions?: readonly string[];
}

type HandlerMap<T> = Record<string, T>;

/** Phantom type: it ties each reflection key to the shape stored under it. */
type MetadataKey<T> = symbol & { readonly value?: T };

const KEY = {
  controller: Symbol.for('orangcode:controller') as MetadataKey<ControllerMetadata>,
  routes: Symbol.for('orangcode:routes') as MetadataKey<RouteDefinition[]>,
  controllerMiddlewares: Symbol.for('orangcode:controller-middlewares') as MetadataKey<
    RequestHandler[]
  >,
  routeMiddlewares: Symbol.for('orangcode:route-middlewares') as MetadataKey<
    HandlerMap<RequestHandler[]>
  >,
  validation: Symbol.for('orangcode:validation') as MetadataKey<HandlerMap<ValidationSchemas>>,
  controllerAccess: Symbol.for('orangcode:controller-access') as MetadataKey<AccessPatch>,
  routeAccess: Symbol.for('orangcode:route-access') as MetadataKey<HandlerMap<AccessPatch>>,
  httpCode: Symbol.for('orangcode:http-code') as MetadataKey<HandlerMap<number>>,
  mediaTypes: Symbol.for('orangcode:media-types') as MetadataKey<HandlerMap<MediaTypes>>,
} as const;

function readOwn<T>(key: MetadataKey<T>, target: object): T | undefined {
  return Reflect.getOwnMetadata(key, target) as T | undefined;
}

function write<T>(key: MetadataKey<T>, target: object, value: T): void {
  Reflect.defineMetadata(key, value, target);
}

function readHandlerMap<T>(key: MetadataKey<HandlerMap<T>>, target: object): HandlerMap<T> {
  return readOwn(key, target) ?? {};
}

export function setControllerMetadata(target: object, metadata: ControllerMetadata): void {
  write(KEY.controller, target, metadata);
}

export function getControllerMetadata(target: object): ControllerMetadata | undefined {
  return readOwn(KEY.controller, target);
}

export function addRoute(target: object, route: RouteDefinition): void {
  write(KEY.routes, target, [...getRoutes(target), route]);
}

export function getRoutes(target: object): readonly RouteDefinition[] {
  return readOwn(KEY.routes, target) ?? [];
}

/** Decorators stacked on the same target are applied bottom-up, so prepend to keep source order. */
export function addControllerMiddlewares(target: object, handlers: MiddlewareList): void {
  write(KEY.controllerMiddlewares, target, [...handlers, ...getControllerMiddlewares(target)]);
}

export function getControllerMiddlewares(target: object): readonly RequestHandler[] {
  return readOwn(KEY.controllerMiddlewares, target) ?? [];
}

export function addRouteMiddlewares(
  target: object,
  handlerName: string,
  handlers: MiddlewareList,
): void {
  const map = readHandlerMap(KEY.routeMiddlewares, target);
  write(KEY.routeMiddlewares, target, {
    ...map,
    [handlerName]: [...handlers, ...(map[handlerName] ?? [])],
  });
}

export function getRouteMiddlewares(
  target: object,
  handlerName: string,
): readonly RequestHandler[] {
  return readHandlerMap(KEY.routeMiddlewares, target)[handlerName] ?? [];
}

export function setValidationSchemas(
  target: object,
  handlerName: string,
  schemas: ValidationSchemas,
): void {
  write(KEY.validation, target, {
    ...readHandlerMap(KEY.validation, target),
    [handlerName]: schemas,
  });
}

export function getValidationSchemas(
  target: object,
  handlerName: string,
): ValidationSchemas | undefined {
  return readHandlerMap(KEY.validation, target)[handlerName];
}

export function setHttpCode(target: object, handlerName: string, status: number): void {
  write(KEY.httpCode, target, {
    ...readHandlerMap(KEY.httpCode, target),
    [handlerName]: status,
  });
}

export function getHttpCode(target: object, handlerName: string): number | undefined {
  return readHandlerMap(KEY.httpCode, target)[handlerName];
}

export function patchMediaTypes(target: object, handlerName: string, patch: MediaTypes): void {
  const map = readHandlerMap(KEY.mediaTypes, target);
  write(KEY.mediaTypes, target, {
    ...map,
    [handlerName]: { ...map[handlerName], ...patch },
  });
}

export function getMediaTypes(target: object, handlerName: string): MediaTypes | undefined {
  return readHandlerMap(KEY.mediaTypes, target)[handlerName];
}

function mergePatch(base: AccessPatch, patch: AccessPatch): AccessPatch {
  const isPublic = patch.isPublic ?? base.isPublic;

  return {
    ...(isPublic === undefined ? {} : { isPublic }),
    roles: [...(base.roles ?? []), ...(patch.roles ?? [])],
    permissions: [...(base.permissions ?? []), ...(patch.permissions ?? [])],
  };
}

export function patchControllerAccess(target: object, patch: AccessPatch): void {
  write(
    KEY.controllerAccess,
    target,
    mergePatch(readOwn(KEY.controllerAccess, target) ?? {}, patch),
  );
}

export function patchRouteAccess(target: object, handlerName: string, patch: AccessPatch): void {
  const map = readHandlerMap(KEY.routeAccess, target);
  write(KEY.routeAccess, target, {
    ...map,
    [handlerName]: mergePatch(map[handlerName] ?? {}, patch),
  });
}

/** Route-level metadata overrides the controller default; roles and permissions accumulate. */
export function resolveAccess(target: object, handlerName: string): AccessMetadata {
  const controllerPatch = readOwn(KEY.controllerAccess, target) ?? {};
  const routePatch = readHandlerMap(KEY.routeAccess, target)[handlerName] ?? {};
  const merged = mergePatch(controllerPatch, routePatch);

  return {
    isPublic: merged.isPublic ?? false,
    roles: merged.roles ?? [],
    permissions: merged.permissions ?? [],
  };
}
