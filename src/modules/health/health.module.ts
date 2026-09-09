import type { AppModule } from '@core/module';
import { HealthController } from './health.controller';

export const healthModule: AppModule = {
  name: 'health',
  controllers: [HealthController],
  mountPath: '/',
};
