import {
  countVersionsByStatus,
  sweepBootRelease,
  sweepCandidates,
  sweepExpired,
  sweepPoison,
  tryAdvisorySweepLock,
  withTx,
  type AppDatabase,
  type SweepCandidate,
  type VersionStatusCounts,
} from '@app/db';
import { Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import type { Queue } from 'bullmq';
import type { ExtractionJobData } from './extraction.processor.js';
import type { WorkerMetricsService } from './metrics.service.js';

export interface SweepServiceOptions {
  readonly workerId: string;
  readonly intervalMs?: number;
  readonly cooldownSeconds?: number;
  readonly maxAttempts?: number;
  readonly batchLimit?: number;
  readonly staleThresholdMs?: number;
}

export interface SweepTickSummary {
  readonly skipped: boolean;
  readonly leader: boolean;
  readonly bootReleased: number;
  readonly expiredReleased: number;
  readonly poisonFailed: number;
  readonly removedFinishedJobs: number;
  readonly enqueued: number;
}

const LIVE_JOB_STATES = new Set([
  'waiting',
  'delayed',
  'active',
  'prioritized',
  'waiting-children',
]);

/**
 * Periodic recovery sweep (spec §6):
 * 1. Boot only: release this worker's own leases -> queued, runs abandoned.
 * 2. Expired leases -> queued, runs abandoned.
 * 3. queued with attempts >= maxAttempts -> failed MAX_ATTEMPTS.
 * 4. queued with enqueued_at NULL or older than cooldown -> remove leftover finished BullMQ jobs
 *    and addBulk at priority 5.
 * 6. Refresh versions_by_status gauge.
 *
 * Protected by an in-process `running` guard and a Postgres advisory leader lock.
 */
export class SweepService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(SweepService.name);
  private readonly workerId: string;
  private readonly intervalMs: number;
  private readonly cooldownSeconds: number;
  private readonly maxAttempts: number;
  private readonly batchLimit: number;
  private readonly staleThresholdMs: number;

  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;
  private lastSweepAt: number | null = null;

  constructor(
    private readonly db: AppDatabase,
    private readonly queue: Queue<ExtractionJobData>,
    private readonly metrics: WorkerMetricsService,
    options: SweepServiceOptions,
  ) {
    this.workerId = options.workerId;
    this.intervalMs = Math.max(100, Math.trunc(options.intervalMs ?? 10_000));
    this.cooldownSeconds = Math.max(1, Math.trunc(options.cooldownSeconds ?? 10));
    this.maxAttempts = Math.max(1, Math.trunc(options.maxAttempts ?? 5));
    this.batchLimit = Math.max(1, Math.trunc(options.batchLimit ?? 500));
    this.staleThresholdMs = Math.max(
      this.intervalMs * 3,
      Math.trunc(options.staleThresholdMs ?? 30_000),
    );
  }

  onApplicationBootstrap(): void {
    void this.tick({ isBoot: true }).catch((err: unknown) => {
      this.logger.error(`Boot sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    this.timer = setInterval(() => {
      void this.tick({ isBoot: false }).catch((err: unknown) => {
        this.logger.error(
          `Periodic sweep failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }, this.intervalMs);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getLastSweepAt(): number | null {
    return this.lastSweepAt;
  }

  getSweepFreshness(nowMs = Date.now()): {
    healthy: boolean;
    lastSweepAt: string | null;
    sweepAgeMs: number | null;
  } {
    if (this.lastSweepAt === null) {
      return { healthy: false, lastSweepAt: null, sweepAgeMs: null };
    }
    const ageMs = Math.max(0, nowMs - this.lastSweepAt);
    return {
      healthy: ageMs <= this.staleThresholdMs,
      lastSweepAt: new Date(this.lastSweepAt).toISOString(),
      sweepAgeMs: ageMs,
    };
  }

  setLastSweepAtForTest(timestampMs: number | null): void {
    this.lastSweepAt = timestampMs;
  }

  async tick(options: { isBoot?: boolean } = {}): Promise<SweepTickSummary> {
    if (this.stopped || this.running) {
      return {
        skipped: true,
        leader: false,
        bootReleased: 0,
        expiredReleased: 0,
        poisonFailed: 0,
        removedFinishedJobs: 0,
        enqueued: 0,
      };
    }

    this.running = true;
    try {
      let bootReleased = 0;
      if (options.isBoot) {
        const released = await withTx(this.db, (tx) => sweepBootRelease(tx, this.workerId));
        bootReleased = released.length;
        this.metrics.incSweepRequeued('boot', bootReleased);
      }

      // Steps 2, 3, 4a, and 6 run under a transaction-scoped Postgres advisory leader lock
      // so multiple worker replicas do not duplicate sweep work.
      const dbPhase = await withTx(this.db, async (tx) => {
        const isLeader = await tryAdvisorySweepLock(tx);
        if (!isLeader) {
          return {
            leader: false as const,
            expiredIds: [] as string[],
            poisonIds: [] as string[],
            candidates: [] as SweepCandidate[],
            counts: null as VersionStatusCounts | null,
          };
        }

        const expiredIds = await sweepExpired(tx);
        const poisonIds = await sweepPoison(tx, this.maxAttempts);
        const candidates = await sweepCandidates(tx, this.batchLimit, this.cooldownSeconds);
        const counts = await countVersionsByStatus(tx);
        return {
          leader: true as const,
          expiredIds,
          poisonIds,
          candidates,
          counts,
        };
      });

      if (!dbPhase.leader) {
        this.lastSweepAt = Date.now();
        return {
          skipped: false,
          leader: false,
          bootReleased,
          expiredReleased: 0,
          poisonFailed: 0,
          removedFinishedJobs: 0,
          enqueued: 0,
        };
      }

      this.metrics.incSweepRequeued('expired', dbPhase.expiredIds.length);
      if (dbPhase.counts) {
        this.metrics.setVersionsByStatus(dbPhase.counts);
      }

      // Step 4b (outside any DB tx, spec §3 & §6): inspect BullMQ jobs, remove finished leftovers, addBulk at priority 5.
      let removedFinishedJobs = 0;
      const toEnqueue: Array<{
        name: string;
        data: ExtractionJobData;
        opts: { jobId: string; priority: number };
      }> = [];

      for (const candidate of dbPhase.candidates) {
        if (this.stopped) {
          break;
        }
        const existing = await this.queue.getJob(candidate.versionId);
        if (existing) {
          const state = await existing.getState();
          if (LIVE_JOB_STATES.has(state)) {
            continue;
          }
          // Completed or failed leftover job with same jobId -> remove() so addBulk can enqueue fresh
          await existing.remove();
          removedFinishedJobs += 1;
        }

        toEnqueue.push({
          name: 'extract',
          data: {
            versionId: candidate.versionId,
            trigger: 'sweep',
            correlationId: candidate.createdRequestId,
          },
          opts: {
            jobId: candidate.versionId,
            priority: 5,
          },
        });
      }

      if (toEnqueue.length > 0 && !this.stopped) {
        await this.queue.addBulk(toEnqueue);
        this.metrics.incSweepRequeued('queued', toEnqueue.length);
      }

      this.lastSweepAt = Date.now();
      return {
        skipped: false,
        leader: true,
        bootReleased,
        expiredReleased: dbPhase.expiredIds.length,
        poisonFailed: dbPhase.poisonIds.length,
        removedFinishedJobs,
        enqueued: toEnqueue.length,
      };
    } finally {
      this.running = false;
    }
  }
}
