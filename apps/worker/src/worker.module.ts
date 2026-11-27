import { createDb, createPool, type AppDatabase } from '@app/db';
import { S3BlobStore, type BlobStore } from '@app/storage';
import { BullModule } from '@nestjs/bullmq';
import { Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { Redis } from 'ioredis';
import { LlmCircuitBreaker } from './circuit-breaker.js';
import { buildWorkerLlmProviderResolver, loadWorkerConfig, type WorkerConfig } from './config.js';
import { ExtractionPipeline } from './extraction-pipeline.js';
import { EXTRACTION_QUEUE, ExtractionProcessor } from './extraction.processor.js';
import { ParsePoolService } from './parse-pool.provider.js';

export const WORKER_CONFIG = Symbol('WORKER_CONFIG');
export const WORKER_DB = Symbol('WORKER_DB');
export const WORKER_REDIS = Symbol('WORKER_REDIS');
export const WORKER_BLOB_STORE = Symbol('WORKER_BLOB_STORE');

interface WorkerDbHandle {
  readonly db: AppDatabase;
  close(): Promise<void>;
}

@Module({
  imports: [
    BullModule.forRootAsync({
      useFactory: () => {
        const config = loadWorkerConfig();
        // Spec §10.2: Worker ioredis uses maxRetriesPerRequest: null and passes the ioredis instance to BullModule.
        const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
        return {
          connection,
          defaultJobOptions: {
            attempts: 5,
            backoff: { type: 'exponential', delay: 5_000 },
            removeOnComplete: 100,
            removeOnFail: 500,
          },
        };
      },
    }),
    BullModule.registerQueue({
      name: EXTRACTION_QUEUE,
    }),
  ],
  providers: [
    {
      provide: WORKER_CONFIG,
      useFactory: (): WorkerConfig => loadWorkerConfig(),
    },
    {
      provide: WORKER_DB,
      inject: [WORKER_CONFIG],
      useFactory: (config: WorkerConfig): WorkerDbHandle => {
        const pool = createPool(config.DATABASE_URL);
        const db = createDb(pool);
        return {
          db,
          close: () => pool.end(),
        };
      },
    },
    {
      provide: WORKER_BLOB_STORE,
      inject: [WORKER_CONFIG],
      useFactory: (config: WorkerConfig): BlobStore =>
        new S3BlobStore({
          endpoint: config.S3_ENDPOINT,
          region: config.S3_REGION,
          bucket: config.S3_BUCKET,
          accessKeyId: config.S3_ACCESS_KEY_ID,
          secretAccessKey: config.S3_SECRET_ACCESS_KEY,
          forcePathStyle: true,
        }),
    },
    ParsePoolService,
    {
      provide: LlmCircuitBreaker,
      useFactory: () => new LlmCircuitBreaker(),
    },
    {
      provide: ExtractionPipeline,
      inject: [WORKER_DB, WORKER_BLOB_STORE, ParsePoolService, WORKER_CONFIG],
      useFactory: (
        dbHandle: WorkerDbHandle,
        blobStore: BlobStore,
        parsePool: ParsePoolService,
        config: WorkerConfig,
      ) =>
        new ExtractionPipeline(
          dbHandle.db,
          blobStore,
          parsePool,
          buildWorkerLlmProviderResolver(config),
          {
            workerId: config.WORKER_ID,
            model: config.LLM_MODEL,
            leaseSeconds: config.LEASE_SECONDS,
            heartbeatIntervalMs: config.HEARTBEAT_INTERVAL_MS,
            chunkCharLimit: config.CHUNK_CHAR_LIMIT,
          },
        ),
    },
    ExtractionProcessor,
  ],
  exports: [ExtractionPipeline, ExtractionProcessor, ParsePoolService],
})
export class WorkerModule implements OnApplicationShutdown {
  constructor(
    @Inject(WORKER_DB) private readonly dbHandle: WorkerDbHandle,
    @Inject(WORKER_BLOB_STORE) private readonly blobStore: BlobStore,
    @Inject(ExtractionProcessor) private readonly processor: ExtractionProcessor,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    this.blobStore.close?.();
    await this.dbHandle.close();
    const workerConn = (this.processor as unknown as { worker?: { opts?: { connection?: Redis } } })
      .worker?.opts?.connection;
    if (workerConn && typeof workerConn.disconnect === 'function') {
      workerConn.disconnect();
    }
  }
}
