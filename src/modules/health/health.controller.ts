import { inject } from 'tsyringe';

import { Controller, Get, Public } from '@core/decorators';
import { ApiPayload } from '@core/http/api-response';
import { HttpStatus } from '@core/http/http-status';
import { HealthService } from './health.service';
import type { LivenessReport, ReadinessReport } from './health.types';

@Controller('/')
export class HealthController {
  constructor(@inject(HealthService) private readonly service: HealthService) {}

  @Get('/health')
  @Public()
  liveness(): LivenessReport {
    return this.service.liveness();
  }

  @Get('/ready')
  @Public()
  async readiness(): Promise<ApiPayload<ReadinessReport>> {
    const report = await this.service.readiness();

    return ApiPayload.of(report, {
      status: report.status === 'ok' ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE,
    });
  }
}
