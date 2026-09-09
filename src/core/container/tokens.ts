import type { InjectionToken } from 'tsyringe';

import type { DatabaseAdapter } from '@core/database/types';
import type { HealthCheckRegistry } from '@core/health/health.registry';
import type { Logger } from '@core/logger/logger';
import type { RedisConnection } from '@core/redis/redis.client';
import type { AuthGuard } from '@core/security/auth-guard';

export const TOKENS = {
  Logger: Symbol('Logger') as InjectionToken<Logger>,
  AuthGuard: Symbol('AuthGuard') as InjectionToken<AuthGuard>,
  HealthCheckRegistry: Symbol('HealthCheckRegistry') as InjectionToken<HealthCheckRegistry>,
  DatabaseAdapter: Symbol('DatabaseAdapter') as InjectionToken<DatabaseAdapter>,
  Redis: Symbol('Redis') as InjectionToken<RedisConnection>,
} as const;
