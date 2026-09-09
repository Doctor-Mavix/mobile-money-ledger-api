import type { RequestHandler, Response } from 'express';
import { Router } from 'express';
import type { DependencyContainer, InjectionToken } from 'tsyringe';

import { TOKENS } from '@core/container/tokens';
import {
  getControllerMetadata,
  getControllerMiddlewares,
  getHttpCode,
  getRouteMiddlewares,
  getRoutes,
  getValidationSchemas,
  resolveAccess,
} from '@core/decorators/metadata';
import { joinPaths } from '@core/decorators/path';
import type { AccessMetadata, RouteDefinition } from '@core/decorators/types';
import { ConfigurationError } from '@core/errors/app-error';
import { ApiPayload, successBody } from '@core/http/api-response';
import { HttpStatus } from '@core/http/http-status';
import { requestContext } from '@core/http/request-context';
import { validationMiddleware } from '@core/http/validation.middleware';
import type { Constructor } from '@core/types';

type HandlerFunction = (...args: unknown[]) => unknown;
type RouteRegistrar = (path: string, ...handlers: RequestHandler[]) => unknown;

export interface MountedRoute {
  method: string;
  path: string;
  isPublic: boolean;
  controller: string;
  handler: string;
}

export interface BuildRouterOptions {
  container: DependencyContainer;
  controllers: readonly Constructor[];
  onRoute?: (route: MountedRoute) => void;
}

export function buildRouter(options: BuildRouterOptions): Router {
  const router = Router();

  for (const controller of options.controllers) {
    mountController(router, controller, options);
  }

  return router;
}

function mountController(
  router: Router,
  controllerClass: Constructor,
  options: BuildRouterOptions,
): void {
  const metadata = getControllerMetadata(controllerClass);
  if (metadata === undefined) {
    throw new ConfigurationError(`${controllerClass.name} is not decorated with @Controller()`);
  }

  const routes = getRoutes(controllerClass);
  if (routes.length === 0) {
    throw new ConfigurationError(`${controllerClass.name} does not declare any route`);
  }

  // tsyringe types tokens with `any[]` constructor parameters, which our stricter alias cannot match.
  const instance = options.container.resolve<object>(
    controllerClass as unknown as InjectionToken<object>,
  );
  const controllerRouter = Router({ mergeParams: true });
  const controllerMiddlewares = getControllerMiddlewares(controllerClass);

  for (const route of routes) {
    const access = resolveAccess(controllerClass, route.handlerName);
    const chain: RequestHandler[] = [
      ...controllerMiddlewares,
      ...guardChain(options.container, access, controllerClass, route),
      ...getRouteMiddlewares(controllerClass, route.handlerName),
      ...validationChain(controllerClass, route.handlerName),
      invocationHandler(instance, controllerClass, route),
    ];

    const registrar = controllerRouter[route.method] as unknown as RouteRegistrar;
    registrar.call(controllerRouter, route.path, ...chain);

    options.onRoute?.({
      method: route.method.toUpperCase(),
      path: joinPaths(metadata.basePath, route.path),
      isPublic: access.isPublic,
      controller: controllerClass.name,
      handler: route.handlerName,
    });
  }

  router.use(metadata.basePath, controllerRouter);
}

function guardChain(
  container: DependencyContainer,
  access: AccessMetadata,
  controllerClass: Constructor,
  route: RouteDefinition,
): RequestHandler[] {
  if (access.isPublic) {
    return [];
  }

  if (!container.isRegistered(TOKENS.AuthGuard, true)) {
    throw new ConfigurationError(
      `${controllerClass.name}.${route.handlerName} (${route.method.toUpperCase()} ${route.path}) ` +
        'requires authentication but no AuthGuard is registered. ' +
        'Register one in the container or mark the route with @Public().',
    );
  }

  return [container.resolve(TOKENS.AuthGuard).protect(access)];
}

function validationChain(controllerClass: Constructor, handlerName: string): RequestHandler[] {
  const schemas = getValidationSchemas(controllerClass, handlerName);

  return schemas === undefined ? [] : [validationMiddleware(schemas)];
}

function invocationHandler(
  instance: object,
  controllerClass: Constructor,
  route: RouteDefinition,
): RequestHandler {
  const handler = resolveHandler(instance, controllerClass, route.handlerName);
  const status =
    getHttpCode(controllerClass, route.handlerName) ??
    (route.method === 'post' ? HttpStatus.CREATED : HttpStatus.OK);

  return (req, res, next) => {
    void Promise.resolve(handler.call(instance, req, res))
      .then((result) => {
        sendResult(res, result, status);
      })
      .catch(next);
  };
}

function resolveHandler(
  instance: object,
  controllerClass: Constructor,
  handlerName: string,
): HandlerFunction {
  const candidate = (instance as Record<string, unknown>)[handlerName];

  if (typeof candidate !== 'function') {
    throw new ConfigurationError(
      `${controllerClass.name}.${handlerName} is decorated as a route but is not a method`,
    );
  }

  return candidate as HandlerFunction;
}

function sendResult(res: Response, result: unknown, defaultStatus: number): void {
  if (res.headersSent) {
    return;
  }

  const requestId = requestContext.requestId();

  if (result instanceof ApiPayload) {
    const payload = result as ApiPayload<unknown>;
    res.status(payload.options.status ?? defaultStatus).json(
      successBody(payload.data, {
        ...(payload.options.message === undefined ? {} : { message: payload.options.message }),
        ...(payload.options.meta === undefined ? {} : { meta: payload.options.meta }),
        ...(requestId === undefined ? {} : { requestId }),
      }),
    );
    return;
  }

  if (result === undefined) {
    res.status(HttpStatus.NO_CONTENT).end();
    return;
  }

  res.status(defaultStatus).json(
    successBody(result, {
      ...(requestId === undefined ? {} : { requestId }),
    }),
  );
}
