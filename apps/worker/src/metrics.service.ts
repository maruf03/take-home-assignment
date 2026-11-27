import type { VersionStatusCounts } from '@app/db';
import { Injectable } from '@nestjs/common';
import { Counter, Gauge, Registry } from 'prom-client';

@Injectable()
export class WorkerMetricsService {
  readonly registry: Registry;
  private readonly versionsByStatus: Gauge<'status'>;
  private readonly sweepRequeuedTotal: Counter<'reason'>;
  private readonly extractionRunsTotal: Counter<'outcome' | 'error_code'>;
  private readonly fencedWritesTotal: Counter;
  private readonly rateLimitedTotal: Counter;

  constructor() {
    this.registry = new Registry();

    this.versionsByStatus = new Gauge({
      name: 'versions_by_status',
      help: 'Current number of document versions by status',
      labelNames: ['status'] as const,
      registers: [this.registry],
    });

    this.sweepRequeuedTotal = new Counter({
      name: 'sweep_requeued_total',
      help: 'Total document versions recovered or re-enqueued by the worker sweep',
      labelNames: ['reason'] as const,
      registers: [this.registry],
    });

    this.extractionRunsTotal = new Counter({
      name: 'extraction_runs_total',
      help: 'Total extraction runs by outcome and error code',
      labelNames: ['outcome', 'error_code'] as const,
      registers: [this.registry],
    });

    this.fencedWritesTotal = new Counter({
      name: 'fenced_writes_total',
      help: 'Total fenced write aborts caused by lease loss',
      registers: [this.registry],
    });

    this.rateLimitedTotal = new Counter({
      name: 'rate_limited_total',
      help: 'Total BullMQ worker.rateLimit pauses applied',
      registers: [this.registry],
    });
  }

  get contentType(): string {
    return this.registry.contentType;
  }

  setVersionsByStatus(counts: VersionStatusCounts): void {
    this.versionsByStatus.set({ status: 'queued' }, counts.queued);
    this.versionsByStatus.set({ status: 'extracting' }, counts.extracting);
    this.versionsByStatus.set({ status: 'extracted' }, counts.extracted);
    this.versionsByStatus.set({ status: 'failed' }, counts.failed);
  }

  incSweepRequeued(reason: 'boot' | 'expired' | 'queued', count = 1): void {
    if (count > 0) {
      this.sweepRequeuedTotal.inc({ reason }, count);
    }
  }

  incExtractionRun(outcome: string, errorCode = 'none'): void {
    this.extractionRunsTotal.inc({ outcome, error_code: errorCode });
  }

  incFencedWrite(): void {
    this.fencedWritesTotal.inc();
  }

  incRateLimited(): void {
    this.rateLimitedTotal.inc();
  }

  async renderMetrics(): Promise<string> {
    return this.registry.metrics();
  }
}
