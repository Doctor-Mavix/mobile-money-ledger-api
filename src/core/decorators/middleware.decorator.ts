import type { RequestHandler } from 'express';

import { addControllerMiddlewares, addRouteMiddlewares } from '@core/decorators/metadata';
import type { TargetDecorator } from '@core/decorators/types';

export function Use(...handlers: RequestHandler[]): TargetDecorator {
  return (target, propertyKey) => {
    if (propertyKey === undefined) {
      addControllerMiddlewares(target, handlers);
      return;
    }

    addRouteMiddlewares(target.constructor, String(propertyKey), handlers);
  };
}
