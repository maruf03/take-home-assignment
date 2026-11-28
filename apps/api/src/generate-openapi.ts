import 'reflect-metadata';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AppDatabase } from '@app/db';
import { MemoryBlobStore } from '@app/storage';
import { createApiApp } from './app.js';
import { loadApiConfig } from './config.js';
import { buildOpenApiDocument } from './swagger.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const OUTPUT_PATH = path.join(REPO_ROOT, 'docs', 'reference', 'openapi.json');

async function main(): Promise<void> {
  const config = loadApiConfig({ APP_ENV: 'test', LOG_LEVEL: 'silent' });
  const app = await createApiApp({
    config,
    db: {} as AppDatabase,
    blobStore: new MemoryBlobStore(),
    enqueuer: {
      async enqueue() {},
    },
  });
  try {
    const document = await buildOpenApiDocument(app);
    await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
    await writeFile(OUTPUT_PATH, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
    console.log(`Wrote OpenAPI spec to ${OUTPUT_PATH}`);
  } finally {
    await app.close();
  }
}

void main().catch((err: unknown) => {
  console.error('Failed to generate OpenAPI spec:', err);
  process.exit(1);
});
