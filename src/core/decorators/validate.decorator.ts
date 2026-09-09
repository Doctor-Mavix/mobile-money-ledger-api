import { setValidationSchemas } from '@core/decorators/metadata';
import type { RouteDecorator, ValidationSchemas } from '@core/decorators/types';

export function Validate(schemas: ValidationSchemas): RouteDecorator {
  return (target, propertyKey) => {
    setValidationSchemas(target.constructor, String(propertyKey), schemas);
  };
}
