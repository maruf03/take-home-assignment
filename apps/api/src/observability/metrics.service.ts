import { Injectable } from '@nestjs/common';
import { Counter, Histogram, Registry } from 'prom-client';

/**
 * Isolated Prometheus registry for the API process (spec §9).
 */
@Injectable()
export class ApiMetricsService {
  readonly registry = new Registry();

  private readonly httpRequestDuration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request latency in seconds',
    labelNames: ['method', 'route', 'status'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registry],
  });

  private readonly documentsUploaded = new Counter({
    name: 'documents_uploaded_total',
    help: 'Total documents uploaded by document type',
    labelNames: ['type'] as const,
    registers: [this.registry],
  });

  private readonly versionsDeduplicated = new Counter({
    name: 'versions_deduplicated_total',
    help: 'Total version uploads deduplicated by content hash',
    registers: [this.registry],
  });

  private readonly reviewsTotal = new Counter({
    name: 'reviews_total',
    help: 'Total reviews recorded by decision and origin',
    labelNames: ['decision', 'origin'] as const,
    registers: [this.registry],
  });

  private readonly rateLimited = new Counter({
    name: 'rate_limited_total',
    help: 'Total requests rejected with HTTP 429 RATE_LIMITED',
    registers: [this.registry],
  });

  observeHttpRequest(method: string, route: string, status: number, durationSec: number): void {
    this.httpRequestDuration.observe(
      { method: method.toUpperCase(), route, status: String(status) },
      Math.max(0, durationSec),
    );
  }

  incDocumentUploaded(type: string): void {
    this.documentsUploaded.inc({ type });
  }

  incVersionDeduplicated(): void {
    this.versionsDeduplicated.inc();
  }

  incReview(decision: string, origin: string): void {
    this.reviewsTotal.inc({ decision, origin });
  }

  incRateLimited(): void {
    this.rateLimited.inc();
  }

  async renderPrometheusText(): Promise<string> {
    return this.registry.metrics();
  }

  get contentType(): string {
    return this.registry.contentType;
  }
}
