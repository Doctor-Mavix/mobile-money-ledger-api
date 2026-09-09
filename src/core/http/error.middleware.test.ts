import type { RequestHandler } from 'express';
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { ConflictError } from '@core/errors/app-error';
import { contextMiddleware } from '@core/http/context.middleware';
import { errorMiddleware } from '@core/http/error.middleware';
import { logger } from '@core/logger/logger';

function appThrowing(handler: RequestHandler): express.Express {
  const app = express();
  app.use(contextMiddleware());
  app.use(express.json({ limit: '10b' }));
  app.post('/', handler);
  app.use(errorMiddleware(logger));

  return app;
}

const noop: RequestHandler = (_req, _res, next) => {
  next();
};

describe('errorMiddleware', () => {
  it('serialises an AppError with its status, code and requestId', async () => {
    const response = await request(
      appThrowing((_req, _res, next) => {
        next(new ConflictError('Email already used'));
      }),
    ).post('/');

    expect(response.status).toBe(409);
    expect(response.body.error).toEqual({ code: 'CONFLICT', message: 'Email already used' });
    expect(response.body.requestId).toBe(response.headers['x-request-id']);
  });

  it('maps an oversized body to 413', async () => {
    const response = await request(appThrowing(noop))
      .post('/')
      .set('content-type', 'application/json')
      .send({ padding: 'x'.repeat(200) });

    expect(response.status).toBe(413);
    expect(response.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('maps malformed JSON to 400', async () => {
    const response = await request(appThrowing(noop))
      .post('/')
      .set('content-type', 'application/json')
      .send('{"a"');

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('BAD_REQUEST');
  });

  it('turns an unknown throw into an opaque 500', async () => {
    const response = await request(
      appThrowing(() => {
        throw new Error('database socket closed at 10.0.0.4:5432');
      }),
    ).post('/');

    expect(response.status).toBe(500);
    expect(response.body.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(response.body)).not.toContain('10.0.0.4');
  });
});
