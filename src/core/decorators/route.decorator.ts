import { addRoute, patchMediaTypes, setHttpCode } from '@core/decorators/metadata';
import { normalizePath } from '@core/decorators/path';
import type { HttpMethod, RouteDecorator } from '@core/decorators/types';

function createRouteDecorator(method: HttpMethod): (path?: string) => RouteDecorator {
  return (path = '/') =>
    (target, propertyKey) => {
      addRoute(target.constructor, {
        method,
        path: normalizePath(path),
        handlerName: String(propertyKey),
      });
    };
}

export const Get = createRouteDecorator('get');
export const Post = createRouteDecorator('post');
export const Put = createRouteDecorator('put');
export const Patch = createRouteDecorator('patch');
export const Delete = createRouteDecorator('delete');
export const Options = createRouteDecorator('options');
export const Head = createRouteDecorator('head');

export function HttpCode(status: number): RouteDecorator {
  return (target, propertyKey) => {
    setHttpCode(target.constructor, String(propertyKey), status);
  };
}

/** Documentation only, for a handler whose body `@Validate` cannot describe — an upload. */
export function Consumes(contentType: string): RouteDecorator {
  return (target, propertyKey) => {
    patchMediaTypes(target.constructor, String(propertyKey), { consumes: contentType });
  };
}

/** Documentation only, for a handler that writes to the response instead of returning a value. */
export function Produces(contentType: string): RouteDecorator {
  return (target, propertyKey) => {
    patchMediaTypes(target.constructor, String(propertyKey), { produces: contentType });
  };
}
