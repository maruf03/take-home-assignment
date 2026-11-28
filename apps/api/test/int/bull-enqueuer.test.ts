import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';
import { BullExtractionEnqueuer, createExtractionQueue } from '../../src/queue/bull-enqueuer.js';

const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://:dev-redis@127.0.0.1:6379';

describe('BullExtractionEnqueuer integration', () => {
  it('fails fast within ~500ms without throwing when Redis is unreachable', async () => {
    // Port 1 is guaranteed closed/unreachable on localhost
    const deadRedis = new Redis('redis://127.0.0.1:1', {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectTimeout: 500,
      retryStrategy: () => null,
    });
    deadRedis.on('error', () => {
      // Expected in offline test
    });
    const queue = createExtractionQueue(deadRedis, {
      maxAttempts: 5,
      queueName: `extraction-dead-${Date.now()}`,
    });
    const enqueuer = new BullExtractionEnqueuer(queue);

    try {
      const started = performance.now();
      await expect(
        enqueuer.enqueue('01950000-0000-7000-8000-000000000001', {
          trigger: 'upload',
          correlationId: 'req-dead',
        }),
      ).resolves.toBeUndefined();
      const elapsedMs = performance.now() - started;
      expect(elapsedMs).toBeLessThan(1200);
    } finally {
      await queue.close().catch(() => {});
      deadRedis.disconnect();
    }
  });

  it('removes a leftover finished job with the same versionId and enqueues fresh at priority 1', async () => {
    const queueName = `extraction-api-enq-${Date.now()}`;
    const queueRedis = new Redis(REDIS_URL, { maxRetriesPerRequest: 1, enableOfflineQueue: false });
    const workerRedis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
    const queue = createExtractionQueue(queueRedis, { maxAttempts: 5, queueName });
    const enqueuer = new BullExtractionEnqueuer(queue);
    const versionId = '01950000-0000-7000-8000-000000000077';

    try {
      // Seed and complete a job with removeOnComplete: false so a finished job remains under jobId = versionId
      await queue.add(
        'extract',
        { versionId, trigger: 'upload' },
        { jobId: versionId, removeOnComplete: false },
      );
      const completed = new Promise<void>((resolve, reject) => {
        const w = new Worker(queueName, async () => ({ ok: true }), { connection: workerRedis });
        w.on('completed', () => {
          void w.close().then(() => resolve());
        });
        w.on('failed', (_job, err) => {
          void w.close().then(() => reject(err));
        });
      });
      await completed;

      const before = await queue.getJob(versionId);
      expect(await before?.getState()).toBe('completed');

      // Re-enqueuing for retry must remove the finished job and add a fresh prioritized job
      await enqueuer.enqueue(versionId, { trigger: 'retry', correlationId: 'req-retry' });
      const after = await queue.getJob(versionId);
      expect(after).toBeDefined();
      const state = await after!.getState();
      expect(['waiting', 'prioritized']).toContain(state);
      expect(after!.data).toMatchObject({
        versionId,
        trigger: 'retry',
        requestId: 'req-retry',
        correlationId: 'req-retry',
      });
      expect(after!.opts.priority).toBe(1);
    } finally {
      await queue.obliterate({ force: true }).catch(() => {});
      await queue.close();
      queueRedis.disconnect();
      workerRedis.disconnect();
    }
  });
});
