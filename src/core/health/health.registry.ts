import { injectable } from 'tsyringe';

import { ConfigurationError } from '@core/errors/app-error';

export type HealthStatus = 'ok' | 'down';

export interface HealthCheck {
  name: string;
  check(): Promise<void> | void;
}

export interface HealthCheckResult {
  name: string;
  status: HealthStatus;
  durationMs: number;
  message?: string;
}

@injectable()
export class HealthCheckRegistry {
  private readonly checks = new Map<string, HealthCheck>();

  register(check: HealthCheck): void {
    if (this.checks.has(check.name)) {
      throw new ConfigurationError(`Health check "${check.name}" is already registered`);
    }

    this.checks.set(check.name, check);
  }

  async run(): Promise<HealthCheckResult[]> {
    return Promise.all([...this.checks.values()].map((check) => this.execute(check)));
  }

  private async execute(check: HealthCheck): Promise<HealthCheckResult> {
    const startedAt = performance.now();

    try {
      await check.check();
      return {
        name: check.name,
        status: 'ok',
        durationMs: Math.round(performance.now() - startedAt),
      };
    } catch (error) {
      return {
        name: check.name,
        status: 'down',
        durationMs: Math.round(performance.now() - startedAt),
        message: error instanceof Error ? error.message : 'unknown error',
      };
    }
  }
}
