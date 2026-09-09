import { inject, injectable } from 'tsyringe';

import { env } from '@core/config/env';
import { TOKENS } from '@core/container/tokens';
import type { HealthCheckRegistry } from '@core/health/health.registry';
import type { LivenessReport, ReadinessReport } from './health.types';

@injectable()
export class HealthService {
  constructor(@inject(TOKENS.HealthCheckRegistry) private readonly registry: HealthCheckRegistry) {}

  liveness(): LivenessReport {
    return {
      status: 'ok',
      app: env.APP_NAME,
      version: env.APP_VERSION,
      uptimeSeconds: Math.round(process.uptime()),
    };
  }

  async readiness(): Promise<ReadinessReport> {
    const checks = await this.registry.run();

    return {
      status: checks.every((check) => check.status === 'ok') ? 'ok' : 'down',
      checks,
    };
  }
}
