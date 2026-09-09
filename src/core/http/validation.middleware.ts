import type { RequestHandler } from 'express';

import type { ValidationSchemas } from '@core/decorators/types';
import type { ValidationIssue, ValidationSource } from '@core/errors/app-error';
import { ValidationError } from '@core/errors/app-error';

const SOURCES = ['params', 'query', 'body'] as const satisfies readonly ValidationSource[];

export function validationMiddleware(schemas: ValidationSchemas): RequestHandler {
  return (req, _res, next) => {
    const issues: ValidationIssue[] = [];
    const validated = new Map<string, unknown>();

    for (const source of SOURCES) {
      const schema = schemas[source];
      if (schema === undefined) {
        continue;
      }

      const result = schema.safeParse(req[source]);
      if (result.success) {
        validated.set(source, result.data);
        continue;
      }

      issues.push(
        ...result.error.issues.map((issue) => ({
          source,
          path: issue.path.map(String).join('.'),
          message: issue.message,
        })),
      );
    }

    if (issues.length > 0) {
      next(new ValidationError(issues));
      return;
    }

    for (const [source, value] of validated) {
      // Express 5 exposes `query` through a getter only: a plain assignment would throw.
      Object.defineProperty(req, source, {
        value,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }

    next();
  };
}
