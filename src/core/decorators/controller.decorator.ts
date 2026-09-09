import { injectable } from 'tsyringe';

import { setControllerMetadata } from '@core/decorators/metadata';
import { normalizePath } from '@core/decorators/path';
import type { Constructor } from '@core/types';

export function Controller(basePath = '/'): (target: Constructor) => void {
  return (target) => {
    // A controller is always resolved through the container, so registering it is part of the decorator.
    injectable()(target);
    setControllerMetadata(target, { basePath: normalizePath(basePath) });
  };
}
