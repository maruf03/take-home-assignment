import type { RunTrigger } from '@app/contracts/status';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger, Optional } from '@nestjs/common';
import { Worker, type Job } from 'bullmq';
import { LlmCircuitBreaker } from './circuit-breaker.js';
import { ExtractionPipeline } from './extraction-pipeline.js';
import { WorkerMetricsService } from './metrics.service.js';

export const EXTRACTION_QUEUE = 'extraction';

export interface ExtractionJobData {
  readonly versionId: string;
  readonly trigger?: RunTrigger;
  readonly requestId?: string | null;
  readonly correlationId?: string | null;
}

export class TransientJobRetryError extends Error {
  readonly code: string;
  readonly backoffMs: number;

  constructor(code: string, message: string, backoffMs: number) {
    super(message);
    this.name = 'TransientJobRetryError';
    this.code = code;
    this.backoffMs = backoffMs;
  }
}

export function extractionBackoffStrategy(
  attemptsMade: number,
  _type?: string,
  err?: Error,
): number {
  if (err instanceof TransientJobRetryError && Number.isFinite(err.backoffMs)) {
    return Math.max(0, Math.trunc(err.backoffMs));
  }
  return 5_000 * 2 ** Math.max(0, attemptsMade - 1);
}

export function isBullMqMissingLockError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /missing lock/i.test(msg);
}

/**
 * Thin BullMQ processor delegating to `ExtractionPipeline` (spec §6 & §10).
 * Coordinates `worker.rateLimit`, circuit breaker pauses, and transient retries.
 */
@Processor(EXTRACTION_QUEUE)
export class ExtractionProcessor extends WorkerHost {
  private readonly logger = new Logger(ExtractionProcessor.name);
  private attachedWorker: Worker | null = null;

  constructor(
    @Inject(ExtractionPipeline) private readonly pipeline: ExtractionPipeline,
    @Inject(LlmCircuitBreaker) private readonly circuitBreaker: LlmCircuitBreaker,
    @Optional() @Inject(WorkerMetricsService) private readonly metrics?: WorkerMetricsService,
  ) {
    super();
  }

  /**
   * Allows standalone BullMQ Worker harnesses (integration tests) to wire the underlying Worker
   * instance so `rateLimit()` calls exercise the real BullMQ worker API.
   */
  attachWorker(worker: Worker): void {
    this.attachedWorker = worker;
  }

  private getActiveWorker(): Worker | undefined {
    if (this.attachedWorker) {
      return this.attachedWorker;
    }
    try {
      return this.worker;
    } catch {
      return undefined;
    }
  }

  private async applyRateLimit(durationMs: number): Promise<void> {
    const safeMs = Math.max(1, Math.trunc(durationMs));
    this.metrics?.incRateLimited();
    const activeWorker = this.getActiveWorker();
    if (activeWorker) {
      await activeWorker.rateLimit(safeMs);
    }
  }

  async process(job: Job<ExtractionJobData>): Promise<void> {
    const remainingOpenMs = this.circuitBreaker.getRemainingOpenMs();
    if (remainingOpenMs > 0) {
      await this.applyRateLimit(remainingOpenMs);
      // Throw BullMQ's RateLimitError so the job moves back to wait without burning attemptsMade.
      throw Worker.RateLimitError();
    }

    const outcome = await this.pipeline.run(job.data.versionId, {
      trigger: job.data.trigger ?? 'upload',
      correlationId: job.data.requestId ?? job.data.correlationId ?? null,
    });

    switch (outcome.status) {
      case 'succeeded':
        this.circuitBreaker.recordSuccess();
        this.metrics?.incExtractionRun('succeeded');
        return;

      case 'noop_already_claimed':
        return;

      case 'aborted_fence':
        this.metrics?.incFencedWrite();
        this.metrics?.incExtractionRun('aborted_fence');
        return;

      case 'failed_permanent':
        this.metrics?.incExtractionRun('failed_permanent', outcome.errorCode);
        return;

      case 'released_transient': {
        this.metrics?.incExtractionRun('released_transient', outcome.errorCode);
        const breaker = this.circuitBreaker.recordTransientFailure();
        const pauseMs = Math.max(
          outcome.rateLimitMs ?? 0,
          breaker.opened ? breaker.openDurationMs : 0,
        );
        if (pauseMs > 0) {
          await this.applyRateLimit(pauseMs);
        }
        throw new TransientJobRetryError(outcome.errorCode, outcome.message, outcome.backoffMs);
      }
    }
  }

  @OnWorkerEvent('error')
  onWorkerError(err: Error): void {
    if (isBullMqMissingLockError(err)) {
      // Spec §6 step 8: Missing lock on completion after a successful finalize is info-only.
      this.logger.log(`Ignoring BullMQ missing lock after completion: ${err.message}`);
      return;
    }
    this.logger.error(`BullMQ worker error: ${err.message}`);
  }
}
