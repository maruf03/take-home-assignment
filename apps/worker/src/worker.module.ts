import { createDb, createPool, type AppDatabase } from '@app/db';
import { S3BlobStore, type BlobStore } from '@app/storage';
import { BullModule } from '@nestjs/bullmq';
import { Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { Redis } from 'ioredis';
import { LlmCircuitBreaker } from './circuit-breaker.js';
import {
  buildWorkerLlmProviderResolver,
  loadWorkerConfig,
  resolveWorkerLimiter,
  type WorkerConfig,
} from './config.js';
import { ExtractionPipeline } from './extraction-pipeline.js';
import {
  EXTRACTION_QUEUE,
  extractionBackoffStrategy,
  ExtractionProcessor,
} from './extraction.processor.js';
import { ParsePoolService } from './parse-pool.provider.js';

export const WORKER_CONFIG = Symbol('WORKER_CONFIG');
export const WORKER_DB = Symbol('WORKER_DB');
export const WORKER_REDIS = Symbol('WORKER_REDIS');
export const WORKER_BLOB_STORE = Symbol('WORKER_BLOB_STORE');

const BULLMQ_WORKER_METADATA = 'bullmq:worker_metadata';

interface WorkerDbHandle {
  readonly db: AppDatabase;
  close(): Promise<void>;
}

/**
 * Shared infrastructure module parsed once and imported by both `BullModule.forRootAsync`
 * and `WorkerModule`, ensuring single config load and guaranteed Redis/DB/S3 cleanup even
 * if startup aborts before `BullExplorer` initializes the BullMQ worker.
 */
@Module({
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
      provide: WORKER_REDIS,
      inject: [WORKER_CONFIG],
      // Spec §10.2: Worker ioredis uses maxRetriesPerRequest: null and passes the instance to BullModule.
      useFactory: (config: WorkerConfig): Redis =>
        new Redis(config.REDIS_URL, { maxRetriesPerRequest: null }),
    },
    {
      provide: WORKER_BLOB_STORE,
      inject: [WORKER_CONFIG],
      useFactory: (config: WorkerConfig): BlobStore =>
        new S3BlobStore({
          endpoint: config.S3_ENDPOINT,
          region: config.S3_REGION,
          bucket: config.S3_BUCKET,
          accessKeyId: config.S3_ACCESS_KEY,
          secretAccessKey: config.S3_SECRET_KEY,
          forcePathStyle: true,
        }),
    },
  ],
  exports: [WORKER_CONFIG, WORKER_DB, WORKER_REDIS, WORKER_BLOB_STORE],
})
class WorkerInfraModule implements OnApplicationShutdown {
  constructor(
    @Inject(WORKER_DB) private readonly dbHandle: WorkerDbHandle,
    @Inject(WORKER_REDIS) private readonly redis: Redis,
    @Inject(WORKER_BLOB_STORE) private readonly blobStore: BlobStore,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    this.blobStore.close?.();
    await this.dbHandle.close();
    this.redis.disconnect();
  }
}

@Module({
  imports: [
    WorkerInfraModule,
    BullModule.forRootAsync({
      imports: [WorkerInfraModule],
      inject: [WORKER_CONFIG, WORKER_REDIS],
      useFactory: (config: WorkerConfig, connection: Redis) => {
        // Apply runtime WorkerConfig (concurrency, integer limiter, custom backoff strategy)
        // during provider instantiation, strictly before BullExplorer creates the BullMQ Worker.
        Reflect.defineMetadata(
          BULLMQ_WORKER_METADATA,
          {
            concurrency: config.WORKER_CONCURRENCY,
            limiter: resolveWorkerLimiter(config),
            settings: {
              backoffStrategy: extractionBackoffStrategy,
            },
          },
          ExtractionProcessor,
        );
        return {
          connection,
          defaultJobOptions: {
            attempts: 5,
            backoff: { type: 'custom' },
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
export class WorkerModule {}
