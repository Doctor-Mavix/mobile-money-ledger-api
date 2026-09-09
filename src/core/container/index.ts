import type { DependencyContainer } from 'tsyringe';
import { Lifecycle, container } from 'tsyringe';

import { TOKENS } from '@core/container/tokens';
import { HealthCheckRegistry } from '@core/health/health.registry';
import { logger } from '@core/logger/logger';

export function createAppContainer(): DependencyContainer {
  const appContainer = container.createChildContainer();

  appContainer.registerInstance(TOKENS.Logger, logger);
  appContainer.register(
    TOKENS.HealthCheckRegistry,
    { useClass: HealthCheckRegistry },
    { lifecycle: Lifecycle.Singleton },
  );

  return appContainer;
}

export { TOKENS };
