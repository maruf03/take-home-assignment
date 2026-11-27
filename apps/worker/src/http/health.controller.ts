import { pingDb, type AppDatabase } from '@app/db';
import type { BlobStore } from '@app/storage';
import { Controller, Get, HttpStatus, Inject, Res } from '@nestjs/common';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { Redis } from 'ioredis';
import { SweepService } from '../sweep.service.js';
import { WORKER_BLOB_STORE, WORKER_DB, WORKER_REDIS } from '../tokens.js';

interface WorkerDbProvider {
  readonly db: AppDatabase;
}

interface HttpResponseLike {
  status(code: number): { json(body: unknown): void };
}

const READY_CHECK_TIMEOUT_MS = 2000;
const EVENT_LOOP_LAG_LIMIT_MS = 2000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

@Controller('health')
export class HealthController {
  constructor(
    @Inject(SweepService) private readonly sweepService: SweepService,
    @Inject(WORKER_DB) private readonly dbProvider: WorkerDbProvider,
    @Inject(WORKER_REDIS) private readonly redis: Redis,
    @Inject(WORKER_BLOB_STORE) private readonly blobStore: BlobStore,
  ) {
    this.loopDelay.enable();
  }

  private readonly loopDelay = monitorEventLoopDelay({ resolution: 20 });

  @Get('live')
  live(@Res() res: HttpResponseLike): void {
    const freshness = this.sweepService.getSweepFreshness();
    const lagMs = this.loopDelay.max / 1e6;
    this.loopDelay.reset();
    const lagOk = !(lagMs >= EVENT_LOOP_LAG_LIMIT_MS);
    const healthy = freshness.healthy && lagOk;
    res.status(healthy ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE).json({
      status: healthy ? 'ok' : freshness.healthy ? 'lagging' : 'stale',
      eventLoopLagMs: Math.round(lagMs),
      lastSweepAt: freshness.lastSweepAt,
      sweepAgeMs: freshness.sweepAgeMs,
    });
  }

  @Get('ready')
  async ready(@Res() res: HttpResponseLike): Promise<void> {
    const checks: Record<'db' | 'redis' | 's3', 'ok' | 'error'> = {
      db: 'error',
      redis: 'error',
      s3: 'error',
    };

    await Promise.all([
      withTimeout(pingDb(this.dbProvider.db), READY_CHECK_TIMEOUT_MS)
        .then(() => {
          checks.db = 'ok';
        })
        .catch(() => {
          checks.db = 'error';
        }),
      withTimeout(this.redis.ping(), READY_CHECK_TIMEOUT_MS)
        .then((pong) => {
          checks.redis = pong === 'PONG' ? 'ok' : 'error';
        })
        .catch(() => {
          checks.redis = 'error';
        }),
      withTimeout(this.blobStore.ping(), READY_CHECK_TIMEOUT_MS)
        .then(() => {
          checks.s3 = 'ok';
        })
        .catch(() => {
          checks.s3 = 'error';
        }),
    ]);

    const healthy = checks.db === 'ok' && checks.redis === 'ok' && checks.s3 === 'ok';
    res.status(healthy ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE).json({
      status: healthy ? 'ok' : 'degraded',
      checks,
    });
  }
}
