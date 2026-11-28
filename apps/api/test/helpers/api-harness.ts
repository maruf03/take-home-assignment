import 'reflect-metadata';
import { readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { seedDatabase } from '@app/db';
import { withTemplateDb, type TemplateDbHandle } from '@app/db/testing';
import { MemoryBlobStore } from '@app/storage';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createApiApp } from '../../src/app.js';
import { loadApiConfig } from '../../src/config.js';
import type { EnqueueOptions, ExtractionEnqueuer } from '../../src/deps.js';

export const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..');
export const FIXTURES_DIR = path.join(REPO_ROOT, 'fixtures');
export const HINTS_PATH = path.join(REPO_ROOT, 'packages', 'db', 'assets', 'template-hints.json');

export interface EnqueuedCall {
  readonly versionId: string;
  readonly options: EnqueueOptions;
}

export class RecordingEnqueuer implements ExtractionEnqueuer {
  readonly calls: EnqueuedCall[] = [];
  delayMs = 0;

  async enqueue(versionId: string, options: EnqueueOptions): Promise<void> {
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }
    this.calls.push({ versionId, options });
  }

  clear(): void {
    this.calls.length = 0;
  }
}

export interface ApiTestHarnessOptions {
  readonly existingCtx?: TemplateDbHandle;
  readonly debugEndpoints?: boolean;
  readonly throttleUploadLimit?: number;
  readonly throttleReviewLimit?: number;
  readonly throttleReadLimit?: number;
}

export interface ApiTestHarness {
  readonly ctx: TemplateDbHandle;
  readonly app: NestExpressApplication;
  readonly baseUrl: string;
  readonly blobStore: MemoryBlobStore;
  readonly enqueuer: RecordingEnqueuer;
  setRedisHealthy(healthy: boolean): void;
  resetAndSeed(): Promise<void>;
  close(): Promise<void>;
}

export async function createApiTestHarness(
  options: ApiTestHarnessOptions = {},
): Promise<ApiTestHarness> {
  const ownsCtx = !options.existingCtx;
  const ctx = options.existingCtx ?? (await withTemplateDb({ applyGrants: true }));
  const blobStore = new MemoryBlobStore();
  const enqueuer = new RecordingEnqueuer();
  let redisHealthy = true;

  const config = loadApiConfig({
    APP_ENV: 'test',
    API_PORT: '0',
    DEBUG_ENDPOINTS: String(options.debugEndpoints ?? false),
    THROTTLE_UPLOAD_LIMIT: String(options.throttleUploadLimit ?? 1000),
    THROTTLE_REVIEW_LIMIT: String(options.throttleReviewLimit ?? 1000),
    THROTTLE_READ_LIMIT: String(options.throttleReadLimit ?? 5000),
  });

  const app = await createApiApp({
    config,
    db: ctx.appDb,
    blobStore,
    enqueuer,
    redisPing: async () => {
      if (!redisHealthy) {
        throw new Error('redis down');
      }
    },
  });
  await app.listen(0, '127.0.0.1');
  const addr = app.getHttpServer().address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  return {
    ctx,
    app,
    baseUrl,
    blobStore,
    enqueuer,
    setRedisHealthy(healthy: boolean): void {
      redisHealthy = healthy;
    },
    async resetAndSeed(): Promise<void> {
      await ctx.reset();
      enqueuer.clear();
      await seedDatabase(ctx.migratorDb, blobStore, {
        fixturesDir: FIXTURES_DIR,
        hintsPath: HINTS_PATH,
      });
    },
    async close(): Promise<void> {
      await app.close();
      if (ownsCtx) {
        await ctx.close();
      }
    },
  };
}

export async function readFixturePdf(filename: string): Promise<Buffer> {
  return readFile(path.join(FIXTURES_DIR, 'documents', filename));
}

export function makeMinimalPdf(tag: string): Buffer {
  return Buffer.from(`%PDF-1.7\n% ${tag}\n1 0 obj\n<<>>\nendobj\n%%EOF\n`, 'latin1');
}

export async function postMultipart(
  url: string,
  parts: {
    file?: { buffer: Buffer; filename: string; contentType?: string };
    fields?: Record<string, string>;
    headers?: Record<string, string>;
  },
): Promise<Response> {
  const form = new FormData();
  if (parts.fields) {
    for (const [k, v] of Object.entries(parts.fields)) {
      form.append(k, v);
    }
  }
  if (parts.file) {
    const bytes = new Uint8Array(parts.file.buffer);
    const blob = new Blob([bytes], { type: parts.file.contentType ?? 'application/pdf' });
    form.append('file', blob, parts.file.filename);
  }
  return fetch(url, {
    method: 'POST',
    body: form,
    headers: parts.headers,
  });
}
