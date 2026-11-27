import { Controller, Get, Inject, Res } from '@nestjs/common';
import { WorkerMetricsService } from '../metrics.service.js';

interface HttpTextResponseLike {
  setHeader(name: string, value: string): void;
  status(code: number): { send(body: string): void };
}

@Controller('metrics')
export class MetricsController {
  constructor(@Inject(WorkerMetricsService) private readonly metrics: WorkerMetricsService) {}

  @Get()
  async getMetrics(@Res() res: HttpTextResponseLike): Promise<void> {
    const body = await this.metrics.renderMetrics();
    res.setHeader('Content-Type', this.metrics.contentType);
    res.status(200).send(body);
  }
}
