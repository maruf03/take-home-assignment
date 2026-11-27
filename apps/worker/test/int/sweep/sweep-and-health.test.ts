import 'reflect-metadata';
import { createHash } from 'node:crypto';
import {
  claimVersion,
  createDocumentWithInitialVersion,
  getVersionById,
  listRuns,
  withTx,
} from '@app/db';
import { expireLease, eventually, withTemplateDb, type TemplateDbHandle } from '@app/db/testing';
import { MemoryBlobStore, StorageError } from '@app/storage';
import { NestFactory } from '@nestjs/core';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EXTRACTION_QUEUE, type ExtractionJobData } from '../../../src/extraction.processor.js';
import { WorkerMetricsService } from '../../../src/metrics.service.js';
import { SweepService } from '../../../src/sweep.service.js';
import { WorkerModule } from '../../../src/worker.module.js';

function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

describe('SweepService, /health/live, /health/ready, and /metrics (Task 8)', () => {
  let ctx: TemplateDbHandle;
  let redisConn: Redis;
  let queue: Queue<ExtractionJobData>;
  let queueName: string;

  beforeAll(async () => {
    ctx = await withTemplateDb({ applyGrants: true });
    const redisUrl = process.env['REDIS_URL'] ?? 'redis://:dev-redis@127.0.0.1:6379';
    redisConn = new Redis(redisUrl, { maxRetriesPerRequest: null });
    queueName = `${EXTRACTION_QUEUE}-sweep-${Date.now()}`;
    queue = new Queue<ExtractionJobData>(queueName, { connection: redisConn });
  });

  afterAll(async () => {
    await queue?.obliterate({ force: true });
    await queue?.close();
    redisConn?.disconnect();
    await ctx?.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    await queue.drain(true);
    await ctx.migratorPool.query(
      `INSERT INTO document_types (key, display_name) VALUES ('invoice', 'Invoice')`,
    );
    const tplRes = await ctx.migratorPool.query<{ id: string }>(
      `INSERT INTO extraction_templates (document_type, version, content_sha256)
       VALUES ('invoice', 1, $1) RETURNING id`,
      ['a'.repeat(64)],
    );
    await ctx.migratorPool.query(
      `INSERT INTO template_fields (template_id, field_key, field_type, position, label)
       VALUES ($1, 'vendor_name', 'string', 1, 'Vendor')`,
      [tplRes.rows[0]!.id],
    );
  });

  async function createQueued(label: string) {
    const hash = sha256Hex(label);
    return withTx(ctx.appDb, (tx) =>
      createDocumentWithInitialVersion(tx, {
        type: 'invoice',
        title: label,
        storageKey: `pdfs/sha256/${hash}.pdf`,
        fileSha256: hash,
        fileSizeBytes: 512,
        originalFilename: `${label}.pdf`,
      }),
    );
  }

  it('[R2] worker.boot-releases-own-leases and sweep.expired-lease-requeues recover leases into BullMQ', async () => {
    const { version: ownVer } = await createQueued('own-lease');
    const { version: otherVer } = await createQueued('other-lease');
    const { version: expiredVer } = await createQueued('expired-lease');

    await withTx(ctx.appDb, (tx) => claimVersion(tx, ownVer.id, 'worker-boot-1'));
    await withTx(ctx.appDb, (tx) => claimVersion(tx, otherVer.id, 'worker-other'));
    await withTx(ctx.appDb, (tx) => claimVersion(tx, expiredVer.id, 'worker-other'));
    await expireLease(ctx.migratorPool, expiredVer.id);

    const metrics = new WorkerMetricsService();
    const sweep = new SweepService(ctx.appDb, queue, metrics, {
      workerId: 'worker-boot-1',
      intervalMs: 60_000,
    });

    const summary = await sweep.tick({ isBoot: true });
    expect(summary.bootReleased).toBe(1);
    expect(summary.expiredReleased).toBe(1);
    expect(summary.enqueued).toBe(2);

    // Own lease was released -> queued & enqueued; run marked abandoned
    expect((await getVersionById(ctx.appDb, ownVer.id))?.status).toBe('queued');
    expect((await listRuns(ctx.appDb, ownVer.id)).data[0]?.status).toBe('abandoned');
    expect(await queue.getJob(ownVer.id)).toBeDefined();

    // Expired lease was released -> queued & enqueued; run marked abandoned
    expect((await getVersionById(ctx.appDb, expiredVer.id))?.status).toBe('queued');
    expect((await listRuns(ctx.appDb, expiredVer.id)).data[0]?.status).toBe('abandoned');
    expect(await queue.getJob(expiredVer.id)).toBeDefined();

    // Healthy lease belonging to another worker was NOT touched
    expect((await getVersionById(ctx.appDb, otherVer.id))?.status).toBe('extracting');
  });

  it('[R3] sweep.leftover-finished-job-removed sweeps enqueued_at NULL immediately, removes leftover finished job, and [R5] worker.max-attempts fails poisoned versions', async () => {
    const { version: nullEnqVer } = await createQueued('null-enqueued');
    const { version: futureBackoffVer } = await createQueued('future-backoff');
    const { version: poisonVer } = await createQueued('poison-ver');

    // Leave a finished completed BullMQ job with jobId = nullEnqVer.id so sweep must remove() it first
    const oldJob = await queue.add(
      'extract',
      { versionId: nullEnqVer.id, trigger: 'upload' },
      { jobId: nullEnqVer.id, removeOnComplete: false },
    );
    const finishConn = new Redis(process.env['REDIS_URL'] ?? 'redis://:dev-redis@127.0.0.1:6379', {
      maxRetriesPerRequest: null,
    });
    const tempWorker = new Worker<ExtractionJobData>(
      queueName,
      async () => {
        // complete immediately so a leftover finished job remains in Redis under jobId=nullEnqVer.id
      },
      { connection: finishConn, concurrency: 1 },
    );
    try {
      await eventually(async () => {
        expect(await oldJob.getState()).toBe('completed');
      });
    } finally {
      await tempWorker.close();
      finishConn.disconnect();
    }

    // Future backoff timestamp must wait (NOT swept yet)
    await ctx.migratorPool.query(
      `UPDATE document_versions SET enqueued_at = now() + interval '60 seconds' WHERE id = $1`,
      [futureBackoffVer.id],
    );

    // Poison version with attempts = 5 -> MAX_ATTEMPTS
    await ctx.migratorPool.query(`UPDATE document_versions SET attempts = 5 WHERE id = $1`, [
      poisonVer.id,
    ]);

    const metrics = new WorkerMetricsService();
    const sweep = new SweepService(ctx.appDb, queue, metrics, {
      workerId: 'worker-sweep-2',
      intervalMs: 60_000,
      maxAttempts: 5,
    });

    const summary = await sweep.tick({ isBoot: false });
    expect(summary.poisonFailed).toBe(1);
    expect(summary.removedFinishedJobs).toBe(1);
    expect(summary.enqueued).toBe(1);

    // Leftover finished job was removed and replaced by a live waiting/prioritized job
    const freshJob = await queue.getJob(nullEnqVer.id);
    expect(freshJob).toBeDefined();
    expect(['waiting', 'prioritized']).toContain(await freshJob!.getState());

    // Future backoff version was NOT enqueued
    expect(await queue.getJob(futureBackoffVer.id)).toBeUndefined();

    // Poisoned version failed with MAX_ATTEMPTS
    const poisoned = await getVersionById(ctx.appDb, poisonVer.id);
    expect(poisoned?.status).toBe('failed');
    expect(poisoned?.lastErrorCode).toBe('MAX_ATTEMPTS');

    // Metrics expose versions_by_status and sweep_requeued_total
    const promText = await metrics.renderMetrics();
    expect(promText).toContain('versions_by_status');
    expect(promText).toContain('sweep_requeued_total');
  });

  it('serves /health/live (sweep freshness), /health/ready (DB/Redis/S3), and /metrics over HTTP', async () => {
    const keys = [
      'APP_ENV',
      'DATABASE_URL',
      'REDIS_URL',
      'S3_ENDPOINT',
      'S3_ACCESS_KEY',
      'S3_SECRET_KEY',
      'LLM_PROVIDER',
      'LLM_MODEL',
      'SWEEP_INTERVAL_MS',
      'WORKER_HTTP_PORT',
    ] as const;
    const saved = new Map<string, string | undefined>(keys.map((k) => [k, process.env[k]]));

    const dbUrl = new URL(
      process.env['DATABASE_URL'] ?? 'postgresql://app:dev-app@127.0.0.1:5432/lomi',
    );
    dbUrl.pathname = `/${ctx.databaseName}`;

    process.env['APP_ENV'] = 'test';
    process.env['DATABASE_URL'] = dbUrl.toString();
    process.env['REDIS_URL'] = process.env['REDIS_URL'] ?? 'redis://:dev-redis@127.0.0.1:6379';
    process.env['S3_ENDPOINT'] = process.env['S3_ENDPOINT'] ?? 'http://127.0.0.1:8333';
    process.env['S3_ACCESS_KEY'] = process.env['S3_ACCESS_KEY'] ?? 'dev-s3-key';
    process.env['S3_SECRET_KEY'] = process.env['S3_SECRET_KEY'] ?? 'dev-s3-secret';
    process.env['LLM_PROVIDER'] = 'fake';
    process.env['LLM_MODEL'] = 'gemini-3.5-flash';
    process.env['SWEEP_INTERVAL_MS'] = '500';
    process.env['WORKER_HTTP_PORT'] = '0';

    // Ensure SeaweedFS bucket exists for /health/ready S3 HeadBucket check
    const { S3BlobStore } = await import('@app/storage');
    const s3Init = new S3BlobStore({
      endpoint: process.env['S3_ENDPOINT'],
      region: 'us-east-1',
      bucket: 'documents',
      accessKeyId: process.env['S3_ACCESS_KEY'],
      secretAccessKey: process.env['S3_SECRET_KEY'],
      forcePathStyle: true,
    });
    await s3Init.ensureBucket();
    s3Init.close();

    const app = await NestFactory.create(WorkerModule, { logger: false, abortOnError: false });
    try {
      await app.listen(0, '127.0.0.1');
      const addr = app.getHttpServer().address() as { port: number };
      const baseUrl = `http://127.0.0.1:${addr.port}`;

      const sweep = app.get(SweepService);
      await eventually(async () => {
        const liveRes = await fetch(`${baseUrl}/health/live`);
        expect(liveRes.status).toBe(200);
        expect(await liveRes.json()).toMatchObject({ status: 'ok' });
      });

      const readyRes = await fetch(`${baseUrl}/health/ready`);
      expect(readyRes.status).toBe(200);
      expect(await readyRes.json()).toMatchObject({
        status: 'ok',
        checks: { db: 'ok', redis: 'ok', s3: 'ok' },
      });

      const metricsRes = await fetch(`${baseUrl}/metrics`);
      expect(metricsRes.status).toBe(200);
      const metricsBody = await metricsRes.text();
      expect(metricsBody).toContain('versions_by_status');

      // Force sweep stale timestamp -> /health/live returns 503
      sweep.setLastSweepAtForTest(Date.now() - 120_000);
      const staleRes = await fetch(`${baseUrl}/health/live`);
      expect(staleRes.status).toBe(503);
      expect(await staleRes.json()).toMatchObject({ status: 'stale' });
    } finally {
      await app.close();
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }

    // Verify MemoryBlobStore ping error path too
    const mem = new MemoryBlobStore();
    mem.failWith = new StorageError('STORAGE_UNAVAILABLE', 'down', { transient: true });
    await expect(mem.ping()).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
  });
});
