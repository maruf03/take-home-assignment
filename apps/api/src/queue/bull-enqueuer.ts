import { Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { EnqueueOptions, ExtractionEnqueuer } from '../deps.js';

/** Must match the worker's queue name (apps/worker/src/extraction.processor.ts). */
export const EXTRACTION_QUEUE_NAME = 'extraction';
const ENQUEUE_TIMEOUT_MS = 2000;
const UPLOAD_PRIORITY = 1;
const LIVE_JOB_STATES = new Set([
  'waiting',
  'delayed',
  'active',
  'prioritized',
  'waiting-children',
]);

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('enqueue timeout')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function createExtractionQueue(
  connection: Redis,
  options: { maxAttempts: number; queueName?: string },
): Queue {
  return new Queue(options.queueName ?? EXTRACTION_QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: options.maxAttempts,
      backoff: { type: 'custom' },
      removeOnComplete: 100,
      removeOnFail: 500,
    },
  });
}

export class BullExtractionEnqueuer implements ExtractionEnqueuer {
  private readonly logger = new Logger(BullExtractionEnqueuer.name);

  constructor(private readonly queue: Queue) {}

  async enqueue(versionId: string, options: EnqueueOptions): Promise<void> {
    try {
      await withTimeout(this.addJob(versionId, options), ENQUEUE_TIMEOUT_MS);
    } catch (err) {
      // Never fail the request: the version is durably `queued` and the sweep enqueues it.
      this.logger.warn(
        `Best-effort enqueue failed for version ${versionId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async addJob(versionId: string, options: EnqueueOptions): Promise<void> {
    const existing = await this.queue.getJob(versionId);
    if (existing) {
      const state = await existing.getState();
      if (LIVE_JOB_STATES.has(state)) {
        return;
      }
      // A finished job with the same id would make add() a silent no-op (retry of a failed version).
      await existing.remove();
    }
    await this.queue.add(
      'extract',
      { versionId, trigger: options.trigger, correlationId: options.correlationId ?? null },
      { jobId: versionId, priority: UPLOAD_PRIORITY },
    );
  }
}
