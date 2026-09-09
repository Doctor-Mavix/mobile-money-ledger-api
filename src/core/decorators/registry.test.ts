import type { Express, RequestHandler } from 'express';
import express from 'express';
import request from 'supertest';
import type { DependencyContainer } from 'tsyringe';
import { container } from 'tsyringe';
import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { TOKENS } from '@core/container/tokens';
import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Post,
  Public,
  Roles,
  Use,
  Validate,
} from '@core/decorators';
import type { MountedRoute } from '@core/decorators/registry';
import { buildRouter } from '@core/decorators/registry';
import { ConfigurationError } from '@core/errors/app-error';
import { errorMiddleware } from '@core/http/error.middleware';
import { ApiPayload } from '@core/http/api-response';
import type { TypedRequest } from '@core/http/typed-request';
import { logger } from '@core/logger/logger';
import type { Constructor } from '@core/types';

const trace: string[] = [];

const record =
  (label: string): RequestHandler =>
  (_req, _res, next) => {
    trace.push(label);
    next();
  };

const bodySchema = z.object({ title: z.string().min(3) });
const querySchema = z.object({ page: z.coerce.number().int().positive().default(1) });

@Controller('/items')
@Use(record('controller'))
class ItemController {
  @Get('/')
  @Public()
  list(): { items: string[] } {
    return { items: ['a'] };
  }

  @Get('/payload')
  @Public()
  payload(): ApiPayload<{ id: number }> {
    return ApiPayload.of({ id: 7 }, { status: 202, message: 'accepted', meta: { total: 1 } });
  }

  @Post('/')
  @Public()
  @Validate({ body: bodySchema })
  create(req: TypedRequest<z.infer<typeof bodySchema>>): { title: string } {
    return { title: req.body.title };
  }

  @Get('/search')
  @Public()
  @Validate({ query: querySchema })
  search(req: TypedRequest<unknown, z.infer<typeof querySchema>>): { page: number } {
    return { page: req.query.page };
  }

  @Delete('/:id')
  @Public()
  remove(): void {
    return undefined;
  }

  @Post('/ping')
  @Public()
  @HttpCode(200)
  @Use(record('route'))
  ping(): { pong: true } {
    return { pong: true };
  }
}

@Controller('/admin')
class AdminController {
  @Get('/')
  @Roles('admin')
  secret(): { ok: true } {
    return { ok: true };
  }
}

function mount(child: DependencyContainer, controllers: readonly Constructor[]): Express {
  const app = express();
  app.use(express.json());
  app.use(buildRouter({ container: child, controllers }));
  app.use(errorMiddleware(logger));

  return app;
}

describe('buildRouter', () => {
  let child: DependencyContainer;

  beforeEach(() => {
    trace.length = 0;
    child = container.createChildContainer();
  });

  it('wraps a returned value in the success envelope', async () => {
    const response = await request(mount(child, [ItemController])).get('/items');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true, data: { items: ['a'] } });
  });

  it('honours the status, message and meta of an ApiPayload', async () => {
    const response = await request(mount(child, [ItemController])).get('/items/payload');

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({
      success: true,
      data: { id: 7 },
      message: 'accepted',
      meta: { total: 1 },
    });
  });

  it('defaults POST to 201', async () => {
    const response = await request(mount(child, [ItemController]))
      .post('/items')
      .send({ title: 'hello' });

    expect(response.status).toBe(201);
    expect(response.body.data).toEqual({ title: 'hello' });
  });

  it('lets @HttpCode override the default status', async () => {
    const response = await request(mount(child, [ItemController])).post('/items/ping');

    expect(response.status).toBe(200);
  });

  it('answers 204 when the handler returns nothing', async () => {
    const response = await request(mount(child, [ItemController])).delete('/items/42');

    expect(response.status).toBe(204);
    expect(response.text).toBe('');
  });

  it('rejects an invalid body with a 422 listing the issues', async () => {
    const response = await request(mount(child, [ItemController]))
      .post('/items')
      .send({ title: 'no' });

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('VALIDATION_FAILED');
    expect(response.body.error.details).toEqual([
      expect.objectContaining({ source: 'body', path: 'title' }),
    ]);
  });

  it('exposes coerced query values to the handler', async () => {
    const response = await request(mount(child, [ItemController])).get('/items/search?page=3');

    expect(response.body.data).toEqual({ page: 3 });
  });

  it('runs controller middlewares before route middlewares', async () => {
    await request(mount(child, [ItemController])).post('/items/ping');

    expect(trace).toEqual(['controller', 'route']);
  });

  it('reports every mounted route through onRoute', () => {
    const routes: MountedRoute[] = [];
    buildRouter({
      container: child,
      controllers: [ItemController],
      onRoute: (r) => routes.push(r),
    });

    expect(routes).toContainEqual({
      method: 'GET',
      path: '/items',
      isPublic: true,
      controller: 'ItemController',
      handler: 'list',
    });
    expect(routes).toHaveLength(6);
  });

  it('refuses to boot a protected route when no AuthGuard is registered', () => {
    expect(() => buildRouter({ container: child, controllers: [AdminController] })).toThrow(
      ConfigurationError,
    );
  });

  it('applies the registered AuthGuard to protected routes', async () => {
    child.registerInstance(TOKENS.AuthGuard, {
      protect: (access) => (_req, _res, next) => {
        trace.push(`guard:${access.roles.join(',')}`);
        next();
      },
    });

    const response = await request(mount(child, [AdminController])).get('/admin');

    expect(response.status).toBe(200);
    expect(trace).toEqual(['guard:admin']);
  });

  it('rejects a class that is not decorated with @Controller', () => {
    class Plain {}

    expect(() => buildRouter({ container: child, controllers: [Plain] })).toThrow(
      /not decorated with @Controller/,
    );
  });

  it('rejects a controller without any route', () => {
    @Controller('/empty')
    class Empty {}

    expect(() => buildRouter({ container: child, controllers: [Empty] })).toThrow(
      /does not declare any route/,
    );
  });
});
