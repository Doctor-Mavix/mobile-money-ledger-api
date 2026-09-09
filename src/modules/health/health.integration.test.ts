import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '@app';
import { createAppContainer } from '@core/container';
import { TOKENS } from '@core/container/tokens';
import type { HealthCheckRegistry } from '@core/health/health.registry';
import { healthModule } from './health.module';

function buildApp(configure?: (registry: HealthCheckRegistry) => void): request.Agent {
  const container = createAppContainer();
  configure?.(container.resolve(TOKENS.HealthCheckRegistry));

  return request(createApp({ container, modules: [healthModule] }));
}

describe('health module', () => {
  let agent: request.Agent;

  beforeEach(() => {
    agent = buildApp();
  });

  it('answers GET /health without authentication', async () => {
    const response = await agent.get('/health');

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data).toMatchObject({ status: 'ok', app: expect.any(String) });
  });

  it('echoes a valid inbound request id', async () => {
    const response = await agent.get('/health').set('x-request-id', 'trace-12345678');

    expect(response.headers['x-request-id']).toBe('trace-12345678');
    expect(response.body.requestId).toBe('trace-12345678');
  });

  it('replaces a malformed inbound request id', async () => {
    const response = await agent.get('/health').set('x-request-id', 'bad id !!');

    expect(response.headers['x-request-id']).not.toBe('bad id !!');
    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('reports ready when every check passes', async () => {
    const response = await buildApp((registry) => {
      registry.register({ name: 'database', check: () => undefined });
    }).get('/ready');

    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('ok');
    expect(response.body.data.checks).toEqual([
      expect.objectContaining({ name: 'database', status: 'ok' }),
    ]);
  });

  it('answers 503 when a check fails', async () => {
    const response = await buildApp((registry) => {
      registry.register({
        name: 'database',
        check: () => {
          throw new Error('connection refused');
        },
      });
    }).get('/ready');

    expect(response.status).toBe(503);
    expect(response.body.data.status).toBe('down');
    expect(response.body.data.checks[0].message).toBe('connection refused');
  });

  it('returns the error envelope on an unknown route', async () => {
    const response = await agent.get('/does-not-exist');

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ success: false, error: { code: 'NOT_FOUND' } });
    expect(response.body.requestId).toBe(response.headers['x-request-id']);
  });

  it('rejects a request coming from an origin outside the whitelist', async () => {
    const response = await agent.get('/health').set('origin', 'https://evil.example');

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
  });
});
