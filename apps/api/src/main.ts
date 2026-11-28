import 'reflect-metadata';
import { createDb, createPool } from '@app/db';
import { S3BlobStore } from '@app/storage';
import { Redis } from 'ioredis';
import { createApiApp } from './app.js';
import { loadApiConfig } from './config.js';
import { BullExtractionEnqueuer, createExtractionQueue } from './queue/bull-enqueuer.js';

async function bootstrap(): Promise<void> {
  const config = loadApiConfig();
  const pool = createPool(config.DATABASE_URL);
  const db = createDb(pool);
  const blobStore = new S3BlobStore({
    ...(config.S3_ENDPOINT !== undefined ? { endpoint: config.S3_ENDPOINT } : {}),
    region: config.S3_REGION,
    bucket: config.S3_BUCKET,
    ...(config.S3_ACCESS_KEY !== undefined ? { accessKeyId: config.S3_ACCESS_KEY } : {}),
    ...(config.S3_SECRET_KEY !== undefined ? { secretAccessKey: config.S3_SECRET_KEY } : {}),
    forcePathStyle: true,
  });
  // Fail fast per request instead of queueing commands while Redis is down (best-effort enqueue).
  const redis = new Redis(config.REDIS_URL, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: 500,
  });
  const queue = createExtractionQueue(redis, { maxAttempts: config.MAX_ATTEMPTS });

  const app = await createApiApp({
    config,
    db,
    blobStore,
    enqueuer: new BullExtractionEnqueuer(queue),
    redisPing: async () => {
      const pong = await redis.ping();
      if (pong !== 'PONG') {
        throw new Error(`Unexpected Redis PING reply: ${pong}`);
      }
    },
  });
  app.enableShutdownHooks();
  await app.listen(config.API_PORT, '0.0.0.0');

  let closing = false;
  const shutdown = (): void => {
    if (closing) return;
    closing = true;
    void (async () => {
      await app.close();
      await queue.close();
      redis.disconnect();
      blobStore.close?.();
      await pool.end();
      process.exit(0);
    })().catch((err: unknown) => {
      console.error('API shutdown failed:', err);
      process.exit(1);
    });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

void bootstrap().catch((err: unknown) => {
  console.error('API bootstrap failed:', err);
  process.exit(1);
});
