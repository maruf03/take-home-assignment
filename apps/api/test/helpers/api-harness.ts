import 'reflect-metadata';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
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

export interface ApiTestHarness {
  readonly ctx: TemplateDbHandle;
  readonly app: NestExpressApplication;
  readonly baseUrl: string;
  readonly blobStore: MemoryBlobStore;
  readonly enqueuer: RecordingEnqueuer;
  resetAndSeed(): Promise<void>;
  close(): Promise<void>;
}

export async function createApiTestHarness(): Promise<ApiTestHarness> {
  const ctx = await withTemplateDb({ applyGrants: true });
  const blobStore = new MemoryBlobStore();
  const enqueuer = new RecordingEnqueuer();
  const config = loadApiConfig({ APP_ENV: 'test', API_PORT: '0' });

  const app = await createApiApp({
    config,
    db: ctx.appDb,
    blobStore,
    enqueuer,
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
      await ctx.close();
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
