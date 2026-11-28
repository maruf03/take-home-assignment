import { Controller, Get, Inject, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { ResLike } from '../common/http.js';
import { ApiMetricsService } from '../observability/metrics.service.js';

@ApiTags('health')
@SkipThrottle()
@Controller('metrics')
export class MetricsController {
  constructor(@Inject(ApiMetricsService) private readonly metrics: ApiMetricsService) {}

  @Get()
  @ApiOperation({ summary: 'Prometheus metrics exposition' })
  async metricsEndpoint(@Res() res: ResLike): Promise<void> {
    const body = await this.metrics.renderPrometheusText();
    res.setHeader('Content-Type', this.metrics.contentType);
    res.status(200).send(body);
  }
}
