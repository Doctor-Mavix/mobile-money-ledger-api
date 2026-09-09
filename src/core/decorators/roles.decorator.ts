import type { AccessPatch } from '@core/decorators/metadata';
import { patchControllerAccess, patchRouteAccess } from '@core/decorators/metadata';
import type { TargetDecorator } from '@core/decorators/types';

function accessDecorator(patch: AccessPatch): TargetDecorator {
  return (target, propertyKey) => {
    if (propertyKey === undefined) {
      patchControllerAccess(target, patch);
      return;
    }

    patchRouteAccess(target.constructor, String(propertyKey), patch);
  };
}

export function Public(): TargetDecorator {
  return accessDecorator({ isPublic: true });
}

export function Roles(...roles: string[]): TargetDecorator {
  return accessDecorator({ isPublic: false, roles });
}

export function Permissions(...permissions: string[]): TargetDecorator {
  return accessDecorator({ isPublic: false, permissions });
}
