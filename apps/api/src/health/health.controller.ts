import { monitorEventLoopDelay } from 'node:perf_hooks';
import { pingDb } from '@app/db';
import { Controller, Get, HttpStatus, Inject, type OnModuleDestroy, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { ResLike } from '../common/http.js';
import { API_DEPS, type ApiDeps } from '../deps.js';

const READY_CHECK_TIMEOUT_MS = 2000;
const EVENT_LOOP_LAG_LIMIT_MS = 2000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('health check timeout')), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

@ApiTags('health')
@SkipThrottle()
@Controller('health')
export class HealthController implements OnModuleDestroy {
  private readonly loopDelay = monitorEventLoopDelay({ resolution: 20 });

  constructor(@Inject(API_DEPS) private readonly deps: ApiDeps) {
    this.loopDelay.enable();
  }

  onModuleDestroy(): void {
    this.loopDelay.disable();
  }

  @Get('live')
  @ApiOperation({ summary: 'Liveness probe (event-loop lag)' })
  live(@Res() res: ResLike): void {
    const lagMs = this.loopDelay.max / 1e6;
    this.loopDelay.reset();
    const healthy = !(lagMs >= EVENT_LOOP_LAG_LIMIT_MS);
    res.status(healthy ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE).json({
      status: healthy ? 'ok' : 'lagging',
      eventLoopLagMs: Math.round(lagMs),
    });
  }

  @Get('ready')
  @ApiOperation({
    summary: 'Readiness probe (503 only if DB is down; Redis/S3 down -> 200 degraded)',
  })
  async ready(@Res() res: ResLike): Promise<void> {
    const checks: Record<'db' | 'redis' | 's3', 'ok' | 'error'> = {
      db: 'error',
      redis: 'error',
      s3: 'error',
    };

    const redisCheck = this.deps.redisPing ? this.deps.redisPing() : Promise.resolve();

    await Promise.all([
      withTimeout(pingDb(this.deps.db), READY_CHECK_TIMEOUT_MS)
        .then(() => {
          checks.db = 'ok';
        })
        .catch(() => {
          checks.db = 'error';
        }),
      withTimeout(redisCheck, READY_CHECK_TIMEOUT_MS)
        .then(() => {
          checks.redis = 'ok';
        })
        .catch(() => {
          checks.redis = 'error';
        }),
      withTimeout(this.deps.blobStore.ping(), READY_CHECK_TIMEOUT_MS)
        .then(() => {
          checks.s3 = 'ok';
        })
        .catch(() => {
          checks.s3 = 'error';
        }),
    ]);

    // Spec §7.5: ready returns 503 only if the DB is down; Redis or S3 down -> 200 degraded.
    if (checks.db !== 'ok') {
      res.status(HttpStatus.SERVICE_UNAVAILABLE).json({
        status: 'unhealthy',
        checks,
      });
      return;
    }

    const allOk = checks.redis === 'ok' && checks.s3 === 'ok';
    res.status(HttpStatus.OK).json({
      status: allOk ? 'ok' : 'degraded',
      checks,
    });
  }
}
