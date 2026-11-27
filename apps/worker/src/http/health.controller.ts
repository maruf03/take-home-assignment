import { pingDb, type AppDatabase } from '@app/db';
import type { BlobStore } from '@app/storage';
import { Controller, Get, HttpStatus, Inject, Res } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { SweepService } from '../sweep.service.js';
import { WORKER_BLOB_STORE, WORKER_DB, WORKER_REDIS } from '../tokens.js';

interface WorkerDbProvider {
  readonly db: AppDatabase;
}

interface HttpResponseLike {
  status(code: number): { json(body: unknown): void };
}

@Controller('health')
export class HealthController {
  constructor(
    @Inject(SweepService) private readonly sweepService: SweepService,
    @Inject(WORKER_DB) private readonly dbProvider: WorkerDbProvider,
    @Inject(WORKER_REDIS) private readonly redis: Redis,
    @Inject(WORKER_BLOB_STORE) private readonly blobStore: BlobStore,
  ) {}

  @Get('live')
  live(@Res() res: HttpResponseLike): void {
    const freshness = this.sweepService.getSweepFreshness();
    const statusCode = freshness.healthy ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE;
    res.status(statusCode).json({
      status: freshness.healthy ? 'ok' : 'stale',
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
      pingDb(this.dbProvider.db)
        .then(() => {
          checks.db = 'ok';
        })
        .catch(() => {
          checks.db = 'error';
        }),
      this.redis
        .ping()
        .then((pong) => {
          checks.redis = pong === 'PONG' ? 'ok' : 'error';
        })
        .catch(() => {
          checks.redis = 'error';
        }),
      this.blobStore
        .ping()
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
