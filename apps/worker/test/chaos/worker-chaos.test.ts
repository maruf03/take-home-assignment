import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import {
  countBilledLlmCalls,
  createDocumentWithInitialVersion,
  getVersionById,
  listLlmCalls,
  listRuns,
  listValuesForVersion,
  withTx,
} from '@app/db';
import {
  acquireRowLockBarrier,
  eventually,
  withTemplateDb,
  type TemplateDbHandle,
} from '@app/db/testing';
import { S3BlobStore } from '@app/storage';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EXTRACTION_QUEUE, type ExtractionJobData } from '../../src/extraction.processor.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const FIXTURES_DIR = path.join(REPO_ROOT, 'fixtures');
const WORKER_ENTRY = path.resolve(import.meta.dirname, '..', '..', 'dist', 'src', 'main.js');
const REDIS_CHAOS_URL = process.env['REDIS_CHAOS_URL'] ?? 'redis://:dev-redis@127.0.0.1:6380';
const S3_ENDPOINT = process.env['S3_ENDPOINT'] ?? 'http://127.0.0.1:8333';
const S3_ACCESS_KEY = process.env['S3_ACCESS_KEY'] ?? 'dev-s3-key';
const S3_SECRET_KEY = process.env['S3_SECRET_KEY'] ?? 'dev-s3-secret';
const S3_BUCKET = 'documents';

function sha256Hex(buf: Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex');
}

function buildAppDbUrl(databaseName: string): string {
  const base = process.env['DATABASE_URL'] ?? 'postgresql://app:dev-app@127.0.0.1:5432/lomi';
  const url = new URL(base);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function makeInvoiceExtractionOutput() {
  return {
    fields: {
      invoice_number: {
        found: true,
        value: 'INV-2025-0842',
        quote: 'Invoice Number: INV-2025-0842',
        line: 3,
        not_found_reason: '',
      },
      issue_date: {
        found: true,
        value: '2025-09-15',
        quote: 'Issue Date: September 15, 2025',
        line: 4,
        not_found_reason: '',
      },
      due_date: {
        found: true,
        value: '2025-10-15',
        quote: 'Due Date: October 15, 2025',
        line: 5,
        not_found_reason: '',
      },
      vendor_name: {
        found: true,
        value: 'MERIDIAN OFFICE SUPPLIES LLC',
        quote: 'MERIDIAN OFFICE SUPPLIES LLC',
        line: 1,
        not_found_reason: '',
      },
      total_amount: {
        found: true,
        amount: '5230.29',
        currency: 'USD',
        quote: 'Total Amount Due: $5,230.29',
        line: 20,
        not_found_reason: '',
      },
    },
    document_flags: {
      suspicious_instructions: false,
      spans: [],
    },
  };
}

function killProcessGroup(child: ChildProcess, signal: NodeJS.Signals = 'SIGKILL'): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // Already exited
  }
}

async function waitForChildExit(child: ChildProcess, timeoutMs = 5_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await new Promise<void>((resolve) => {
    const t = setTimeout(resolve, timeoutMs);
    child.once('exit', () => {
      clearTimeout(t);
      resolve();
    });
  });
}

describe('Worker chaos tests: detached SIGKILL + redis-chaos FLUSHALL (Task 8)', () => {
  let ctx: TemplateDbHandle;
  let redisChaos: Redis;
  let s3: S3BlobStore;
  let invoiceBytes: Buffer;
  const spawnedChildren: ChildProcess[] = [];

  beforeAll(async () => {
    ctx = await withTemplateDb({ applyGrants: true });
    redisChaos = new Redis(REDIS_CHAOS_URL, { maxRetriesPerRequest: null });
    s3 = new S3BlobStore({
      endpoint: S3_ENDPOINT,
      region: 'us-east-1',
      bucket: S3_BUCKET,
      accessKeyId: S3_ACCESS_KEY,
      secretAccessKey: S3_SECRET_KEY,
      forcePathStyle: true,
    });
    await s3.ensureBucket();
    invoiceBytes = await readFile(path.join(FIXTURES_DIR, 'documents', 'invoice-001.pdf'));
  });

  afterAll(async () => {
    for (const child of spawnedChildren) {
      killProcessGroup(child, 'SIGKILL');
    }
    s3?.close();
    redisChaos?.disconnect();
    await ctx?.close();
  });

  beforeEach(async () => {
    for (const child of spawnedChildren.splice(0)) {
      killProcessGroup(child, 'SIGKILL');
      await waitForChildExit(child);
    }
    await redisChaos.flushall();
    await ctx.reset();

    const hints = JSON.parse(
      await readFile(
        path.join(REPO_ROOT, 'packages', 'db', 'assets', 'template-hints.json'),
        'utf8',
      ),
    ) as Record<
      string,
      {
        displayName: string;
        instructions?: string | null;
        defaultCurrency?: string;
        dateOrder?: string;
        fields: Record<string, { label: string; description?: string | null }>;
      }
    >;
    const expected = JSON.parse(
      await readFile(path.join(FIXTURES_DIR, 'expected-fields.json'), 'utf8'),
    ) as Record<string, Array<{ field: string; type: string }>>;

    const invHint = hints['invoice']!;
    await ctx.migratorPool.query(
      `INSERT INTO document_types (key, display_name) VALUES ('invoice', $1)`,
      [invHint.displayName],
    );
    const tplRes = await ctx.migratorPool.query<{ id: string }>(
      `INSERT INTO extraction_templates (document_type, version, content_sha256, instructions, default_currency, date_order)
       VALUES ('invoice', 1, $1, $2, $3, $4) RETURNING id`,
      [
        'a'.repeat(64),
        invHint.instructions ?? null,
        invHint.defaultCurrency ?? 'USD',
        invHint.dateOrder ?? 'MDY',
      ],
    );
    const tplId = tplRes.rows[0]!.id;
    for (let i = 0; i < expected['invoice']!.length; i++) {
      const f = expected['invoice']![i]!;
      const fh = invHint.fields[f.field];
      await ctx.migratorPool.query(
        `INSERT INTO template_fields (template_id, field_key, field_type, position, label, description)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [tplId, f.field, f.type, i + 1, fh?.label ?? f.field, fh?.description ?? null],
      );
    }
  });

  function spawnWorker(options: { workerId: string; fakeIpcEndpoint: string }): ChildProcess {
    const child = spawn(process.execPath, [WORKER_ENTRY], {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        APP_ENV: 'test',
        DATABASE_URL: buildAppDbUrl(ctx.databaseName),
        REDIS_URL: REDIS_CHAOS_URL,
        S3_ENDPOINT,
        S3_REGION: 'us-east-1',
        S3_BUCKET,
        S3_ACCESS_KEY,
        S3_SECRET_KEY,
        LLM_PROVIDER: 'fake-ipc',
        LLM_MODEL: 'gemini-3.5-flash',
        FAKE_IPC_ENDPOINT: options.fakeIpcEndpoint,
        WORKER_ID: options.workerId,
        WORKER_HTTP_PORT: '0',
        LEASE_SECONDS: '2',
        HEARTBEAT_INTERVAL_MS: '300',
        SWEEP_INTERVAL_MS: '200',
      },
    });
    spawnedChildren.push(child);
    return child;
  }

  async function seedInvoiceDocument() {
    const hash = sha256Hex(invoiceBytes);
    const key = `pdfs/sha256/${hash}.pdf`;
    await s3.putObject(key, invoiceBytes, 'application/pdf');
    return withTx(ctx.appDb, (tx) =>
      createDocumentWithInitialVersion(tx, {
        type: 'invoice',
        title: 'Chaos Invoice',
        storageKey: key,
        fileSha256: hash,
        fileSizeBytes: invoiceBytes.byteLength,
        originalFilename: 'invoice-001.pdf',
      }),
    );
  }

  async function startFakeIpcServer(
    handler: (callIndex: number, res: ServerResponse) => Promise<void> | void,
  ) {
    let callCount = 0;
    const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      for await (const _chunk of req) {
        // drain request body
      }
      callCount += 1;
      await handler(callCount, res);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address() as AddressInfo;
    return {
      url: `http://127.0.0.1:${addr.port}`,
      getCallCount: () => callCount,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  function respondOk(res: ServerResponse): void {
    const output = makeInvoiceExtractionOutput();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        type: 'result',
        result: {
          kind: 'ok',
          output,
          rawText: JSON.stringify(output),
          raw: output,
          usage: { inputTokens: 300, outputTokens: 120 },
          stopReason: 'STOP',
          latencyMs: 10,
          model: 'gemini-3.5-flash',
          servedModel: 'fake-ipc',
          providerRequestId: `ipc-${Date.now()}`,
        },
      }),
    );
  }

  it('[R2] chaos.sigkill-mid-llm recovers from SIGKILL before C2 + redis-chaos FLUSHALL (2 billed calls, [abandoned, succeeded])', async () => {
    const { version } = await seedInvoiceDocument();

    let llmStartedResolve!: () => void;
    const llmStarted = new Promise<void>((r) => {
      llmStartedResolve = r;
    });

    const ipc = await startFakeIpcServer((callIndex, res) => {
      if (callIndex === 1) {
        // Hold first response open until worker process group is SIGKILL'd
        llmStartedResolve();
        return;
      }
      respondOk(res);
    });

    try {
      const worker1 = spawnWorker({ workerId: 'chaos-w', fakeIpcEndpoint: ipc.url });
      await llmStarted;

      // Confirm C2 request row exists with raw_response IS NULL (before C2 completion)
      const run1 = await eventually(async () => {
        const runs = (await listRuns(ctx.appDb, version.id)).data;
        expect(runs).toHaveLength(1);
        return runs[0]!;
      });
      const callsBeforeKill = (await listLlmCalls(ctx.appDb, run1.id)).data;
      expect(callsBeforeKill).toHaveLength(1);
      expect(callsBeforeKill[0]!.rawResponse).toBeNull();

      // SIGKILL whole process group + FLUSHALL on redis-chaos (6380)
      killProcessGroup(worker1, 'SIGKILL');
      await waitForChildExit(worker1);
      await redisChaos.flushall();

      // Spawn fresh worker -> lease expires (2s) -> sweep abandons run1 & re-enqueues -> run2 extracts
      const worker2 = spawnWorker({ workerId: 'chaos-w', fakeIpcEndpoint: ipc.url });
      await eventually(
        async () => {
          const v = await getVersionById(ctx.appDb, version.id);
          expect(v?.status).toBe('extracted');
        },
        { timeoutMs: 20_000 },
      );

      expect(await listValuesForVersion(ctx.appDb, version.id)).toHaveLength(5);
      expect(await countBilledLlmCalls(ctx.appDb, version.id)).toBe(2);
      const allRuns = (await listRuns(ctx.appDb, version.id)).data;
      // listRuns returns desc by runNumber -> [run2 succeeded, run1 abandoned]
      expect(allRuns.map((r) => r.status).reverse()).toEqual(['abandoned', 'succeeded']);

      killProcessGroup(worker2, 'SIGTERM');
      await waitForChildExit(worker2);
    } finally {
      await ipc.close();
    }
  });

  it('[R2] chaos.sigkill-mid-llm recovers from SIGKILL after C2 + redis-chaos FLUSHALL with 1 billed call (reuses stored C2)', async () => {
    const { document, version } = await seedInvoiceDocument();

    // Park the first LLM response, take the documents lock while the worker holds no locks,
    // then release the response: C2 persists raw_response and C3 finalize parks on the barrier.
    let pendingRes: ServerResponse | undefined;
    let llmStartedResolve!: () => void;
    const llmStarted = new Promise<void>((r) => {
      llmStartedResolve = r;
    });
    const ipc = await startFakeIpcServer((callIndex, res) => {
      if (callIndex === 1) {
        pendingRes = res;
        llmStartedResolve();
        return;
      }
      respondOk(res);
    });
    let docBarrier: Awaited<ReturnType<typeof acquireRowLockBarrier>> | undefined;

    try {
      const worker1 = spawnWorker({ workerId: 'chaos-c2-w', fakeIpcEndpoint: ipc.url });
      await llmStarted;
      docBarrier = await acquireRowLockBarrier(
        ctx.migratorPool,
        'documents',
        document.id,
        ctx.appPool,
      );
      respondOk(pendingRes!);

      // Wait until C2 has persisted raw_response AND worker1 is parked at C3 finalize
      await eventually(
        async () => {
          const runs = (await listRuns(ctx.appDb, version.id)).data;
          expect(runs).toHaveLength(1);
          const calls = (await listLlmCalls(ctx.appDb, runs[0]!.id)).data;
          expect(calls).toHaveLength(1);
          expect(calls[0]!.rawResponse).not.toBeNull();
          expect(calls[0]!.schemaValid).toBe(true);
        },
        { timeoutMs: 15_000 },
      );
      await docBarrier.waitForBlockedCount(1);

      // SIGKILL whole process group, release barrier, FLUSHALL redis-chaos (6380)
      killProcessGroup(worker1, 'SIGKILL');
      await waitForChildExit(worker1);
      await docBarrier.release();
      await redisChaos.flushall();

      // Spawn fresh worker -> sweep recovers -> reuses C2 -> 1 billed call total!
      const worker2 = spawnWorker({ workerId: 'chaos-c2-w', fakeIpcEndpoint: ipc.url });
      await eventually(
        async () => {
          const v = await getVersionById(ctx.appDb, version.id);
          expect(v?.status).toBe('extracted');
        },
        { timeoutMs: 20_000 },
      );

      expect(await listValuesForVersion(ctx.appDb, version.id)).toHaveLength(5);
      expect(await countBilledLlmCalls(ctx.appDb, version.id)).toBe(1);
      expect(ipc.getCallCount()).toBe(1);
      const allRuns = (await listRuns(ctx.appDb, version.id)).data;
      expect(allRuns.map((r) => r.status).reverse()).toEqual(['abandoned', 'succeeded']);

      killProcessGroup(worker2, 'SIGTERM');
      await waitForChildExit(worker2);
    } finally {
      await docBarrier?.release();
      await ipc.close();
    }
  });

  it('[R3] chaos.flushall-mid-queue loses zero work when Redis 6380 is flushed before worker starts', async () => {
    const { version } = await seedInvoiceDocument();

    // Enqueue job onto redis-chaos (6380), then wipe Redis completely with FLUSHALL
    const queue = new Queue<ExtractionJobData>(EXTRACTION_QUEUE, { connection: redisChaos });
    await queue.add('extract', { versionId: version.id, trigger: 'upload' }, { jobId: version.id });
    await queue.close();

    await redisChaos.flushall();
    expect(await redisChaos.dbsize()).toBe(0);

    const ipc = await startFakeIpcServer((_callIndex, res) => {
      respondOk(res);
    });

    try {
      const worker = spawnWorker({ workerId: 'chaos-flush-w1', fakeIpcEndpoint: ipc.url });
      await eventually(
        async () => {
          const v = await getVersionById(ctx.appDb, version.id);
          expect(v?.status).toBe('extracted');
        },
        { timeoutMs: 20_000 },
      );

      expect(await listValuesForVersion(ctx.appDb, version.id)).toHaveLength(5);
      killProcessGroup(worker, 'SIGTERM');
      await waitForChildExit(worker);
    } finally {
      await ipc.close();
    }
  });
});
