import type { RunTrigger } from '@app/contracts/status';
import type { AppDatabase } from '@app/db';
import type { BlobStore } from '@app/storage';
import type { ApiConfig } from './config.js';

export const API_DEPS = Symbol('API_DEPS');

export interface EnqueueOptions {
  readonly trigger: RunTrigger;
  readonly correlationId?: string | null;
}

/** Best-effort enqueue after commit; the worker sweep is the safety net (spec §6 Upload). */
export interface ExtractionEnqueuer {
  enqueue(versionId: string, options: EnqueueOptions): Promise<void>;
}

export interface ApiDeps {
  readonly config: ApiConfig;
  readonly db: AppDatabase;
  readonly blobStore: BlobStore;
  readonly enqueuer: ExtractionEnqueuer;
  readonly redisPing?: () => Promise<void>;
}
