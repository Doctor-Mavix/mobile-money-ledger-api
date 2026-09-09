import type { HealthCheckResult, HealthStatus } from '@core/health/health.registry';

export interface LivenessReport {
  status: 'ok';
  app: string;
  version: string;
  uptimeSeconds: number;
}

export interface ReadinessReport {
  status: HealthStatus;
  checks: HealthCheckResult[];
}
