import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  claimVersion,
  countBilledLlmCalls,
  createDocumentWithInitialVersion,
  createNewVersion,
  getVersionById,
  insertReview,
  listLlmCalls,
  listRuns,
  listValuesForVersion,
  retryVersion,
  sweepExpired,
  withTx,
} from '@app/db';
import { expireLease, withTemplateDb, type TemplateDbHandle } from '@app/db/testing';
import { CassetteProvider, FakeLlmProvider, LlmError } from '@app/llm';
import { PARSER_ID, PdfParserPool, type PdfParseResult, type PdfParser } from '@app/pdf';
import { MemoryBlobStore } from '@app/storage';
import { NestFactory } from '@nestjs/core';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LlmCircuitBreaker } from '../../../src/circuit-breaker.js';
import { ExtractionPipeline } from '../../../src/extraction-pipeline.js';
import {
  EXTRACTION_QUEUE,
  ExtractionProcessor,
  type ExtractionJobData,
} from '../../../src/extraction.processor.js';
import { WorkerModule } from '../../../src/worker.module.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..', '..');
const FIXTURES_DIR = path.join(REPO_ROOT, 'fixtures');
const CASSETTES_DIR = path.join(REPO_ROOT, 'fixtures-golden', 'cassettes');

function sha256Hex(buf: Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex');
}

function makeStubParser(result: PdfParseResult): PdfParser {
  return {
    async parse(): Promise<PdfParseResult> {
      return result;
    },
    async close(): Promise<void> {},
  };
}

function makeInvoiceOutput(overrides?: {
  vendor?: { value: string; quote: string; line: number };
  total?: { amount: string; currency: string; quote: string; line: number };
  suspicious?: boolean;
}) {
  return {
    fields: {
      invoice_number: {
        found: true,
        value: 'INV-2025-001',
        quote: 'Invoice Number: INV-2025-001',
        line: 2,
        not_found_reason: '',
      },
      issue_date: {
        found: true,
        value: '2025-09-01',
        quote: 'Issue Date: September 1, 2025',
        line: 3,
        not_found_reason: '',
      },
      due_date: {
        found: true,
        value: '2025-10-01',
        quote: 'Due Date: October 1, 2025',
        line: 4,
        not_found_reason: '',
      },
      vendor_name: {
        found: true,
        value: overrides?.vendor?.value ?? 'MERIDIAN OFFICE SUPPLIES LLC',
        quote: overrides?.vendor?.quote ?? 'MERIDIAN OFFICE SUPPLIES LLC',
        line: overrides?.vendor?.line ?? 1,
        not_found_reason: '',
      },
      total_amount: {
        found: true,
        amount: overrides?.total?.amount ?? '5230.29',
        currency: overrides?.total?.currency ?? 'USD',
        quote: overrides?.total?.quote ?? 'Total Amount Due: $5,230.29',
        line: overrides?.total?.line ?? 5,
        not_found_reason: '',
      },
    },
    document_flags: {
      suspicious_instructions: overrides?.suspicious ?? false,
      spans: overrides?.suspicious ? ['Ignore previous instructions'] : [],
    },
  };
}

const SIMPLE_INVOICE_TEXT = [
  'MERIDIAN OFFICE SUPPLIES LLC',
  'Invoice Number: INV-2025-001',
  'Issue Date: September 1, 2025',
  'Due Date: October 1, 2025',
  'Total Amount Due: $5,230.29',
].join('\n');

describe('ExtractionPipeline & ExtractionProcessor integration (Task 7)', () => {
  let ctx: TemplateDbHandle;
  let pdfPool: PdfParserPool;

  beforeAll(async () => {
    ctx = await withTemplateDb({ applyGrants: true });
    pdfPool = new PdfParserPool({ maxThreads: 2 });
  });

  afterAll(async () => {
    await pdfPool?.close();
    await ctx?.close();
  });

  async function seedInvoiceTemplate(): Promise<void> {
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
  }

  async function createQueuedInvoice(
    blobStore: MemoryBlobStore,
    bytes: Buffer,
    filename = 'invoice-001.pdf',
  ) {
    const hash = sha256Hex(bytes);
    const storageKey = `pdfs/sha256/${hash}.pdf`;
    await blobStore.putObject(storageKey, bytes, 'application/pdf');
    return await withTx(ctx.appDb, (tx) =>
      createDocumentWithInitialVersion(tx, {
        type: 'invoice',
        title: filename,
        storageKey,
        fileSha256: hash,
        fileSizeBytes: bytes.byteLength,
        originalFilename: filename,
      }),
    );
  }

  beforeEach(async () => {
    await ctx.reset();
    await seedInvoiceTemplate();
  });

  it('[R4] worker.redelivery-after-commit and worker.zombie-finalize-rejected prevent duplicate values and fenced clobbers', async () => {
    const blobStore = new MemoryBlobStore();
    const bytes = Buffer.from('%PDF-1.7\nfake\n%%EOF');
    const { version } = await createQueuedInvoice(blobStore, bytes);

    const stubParser = makeStubParser({
      text: SIMPLE_INVOICE_TEXT,
      pageOffsets: [0],
      pageCount: 1,
      textRanges: { hidden: [], lowVisibility: [] },
      warnings: [],
      parser: PARSER_ID,
    });

    const fakeLlm = new FakeLlmProvider({
      script: [{ kind: 'ok', output: makeInvoiceOutput() }],
    });

    const pipeline = new ExtractionPipeline(ctx.appDb, blobStore, stubParser, fakeLlm, {
      workerId: 'worker-1',
      model: 'gemini-3.5-flash',
    });

    const first = await pipeline.run(version.id);
    expect(first.status).toBe('succeeded');
    expect(fakeLlm.calls).toHaveLength(1);

    const valuesAfterFirst = await listValuesForVersion(ctx.appDb, version.id);
    expect(valuesAfterFirst).toHaveLength(5);

    // Redelivery after commit -> idempotent no-op ack, zero new runs or LLM calls
    const redelivery = await pipeline.run(version.id);
    expect(redelivery.status).toBe('noop_already_claimed');
    expect(fakeLlm.calls).toHaveLength(1);
    expect((await listRuns(ctx.appDb, version.id)).data).toHaveLength(1);
    expect(await listValuesForVersion(ctx.appDb, version.id)).toHaveLength(5);

    // Zombie finalize rejected when lease is lost mid-LLM to a second worker
    const { version: vZombie } = await createQueuedInvoice(
      blobStore,
      Buffer.from('%PDF-1.7\nzombie\n%%EOF'),
      'zombie.pdf',
    );
    let releaseZombieLlm!: () => void;
    let zombieLlmEntered!: () => void;
    const zombieEnteredPromise = new Promise<void>((r) => {
      zombieLlmEntered = r;
    });
    const zombieLlmGate = new Promise<void>((r) => {
      releaseZombieLlm = r;
    });

    const zombieLlm = new FakeLlmProvider({
      script: [
        async (req) => {
          zombieLlmEntered();
          await zombieLlmGate;
          return {
            kind: 'ok',
            output: makeInvoiceOutput({
              vendor: { value: 'ZOMBIE VENDOR', quote: 'ZOMBIE VENDOR', line: 1 },
            }),
            rawText: '{}',
            raw: makeInvoiceOutput(),
            usage: { inputTokens: 10, outputTokens: 5 },
            stopReason: 'STOP',
            latencyMs: 5,
            model: req.model,
            servedModel: 'fake',
            providerRequestId: 'zombie-1',
          };
        },
      ],
    });
    const winnerLlm = new FakeLlmProvider({
      script: [{ kind: 'ok', output: makeInvoiceOutput() }],
    });

    const zombiePipeline = new ExtractionPipeline(ctx.appDb, blobStore, stubParser, zombieLlm, {
      workerId: 'worker-zombie',
      model: 'gemini-3.5-flash',
      heartbeatIntervalMs: 60_000, // don't abort before finalize so we explicitly test C3 zombie finalize rejection
    });
    const winnerPipeline = new ExtractionPipeline(ctx.appDb, blobStore, stubParser, winnerLlm, {
      workerId: 'worker-winner',
      model: 'gemini-3.5-flash',
    });

    const zombiePromise = zombiePipeline.run(vZombie.id);
    await zombieEnteredPromise;

    // Expire zombie's lease and sweep so winner can claim and finish
    await expireLease(ctx.migratorPool, vZombie.id);
    await withTx(ctx.appDb, (tx) => sweepExpired(tx));
    const winnerOutcome = await winnerPipeline.run(vZombie.id);
    expect(winnerOutcome.status).toBe('succeeded');

    // Now unblock zombie -> its C2/C3 fenced writes must be rejected cleanly
    releaseZombieLlm();
    const zombieOutcome = await zombiePromise;
    expect(zombieOutcome.status).toBe('aborted_fence');

    const finalValues = await listValuesForVersion(ctx.appDb, vZombie.id);
    expect(finalValues).toHaveLength(5);
    expect(finalValues.find((v) => v.value.fieldKey === 'vendor_name')?.value.value).toBe(
      'MERIDIAN OFFICE SUPPLIES LLC',
    );
  });

  it('[I3] worker.crash-after-llm-reuses-call, worker.manual-retry-fresh, and worker.call-cap-6 enforce billing invariants', async () => {
    const blobStore = new MemoryBlobStore();
    const stubParser = makeStubParser({
      text: SIMPLE_INVOICE_TEXT,
      pageOffsets: [0],
      pageCount: 1,
      textRanges: { hidden: [], lowVisibility: [] },
      warnings: [],
      parser: PARSER_ID,
    });

    // 1. Crash after C2 -> run 2 reuses stored call (1 billed call total!)
    const { version: vReuse } = await createQueuedInvoice(
      blobStore,
      Buffer.from('%PDF-1.7\nreuse\n%%EOF'),
      'reuse.pdf',
    );
    const reuseLlm = new FakeLlmProvider({
      script: [{ kind: 'ok', output: makeInvoiceOutput() }],
    });
    const crashingPipeline = new ExtractionPipeline(ctx.appDb, blobStore, stubParser, reuseLlm, {
      workerId: 'worker-crash',
      model: 'gemini-3.5-flash',
      onStageEvent: async (stage) => {
        if (stage === 'llm-response-persisted') {
          throw new Error('SIMULATED_CRASH_AFTER_C2');
        }
      },
    });
    await expect(crashingPipeline.run(vReuse.id)).rejects.toThrow('SIMULATED_CRASH_AFTER_C2');
    expect(reuseLlm.calls).toHaveLength(1);
    expect(await countBilledLlmCalls(ctx.appDb, vReuse.id)).toBe(1);

    // Expire lease & sweep -> run 2 must reuse stored call with 0 new network calls
    await expireLease(ctx.migratorPool, vReuse.id);
    await withTx(ctx.appDb, (tx) => sweepExpired(tx));

    const recoverPipeline = new ExtractionPipeline(ctx.appDb, blobStore, stubParser, reuseLlm, {
      workerId: 'worker-recover',
      model: 'gemini-3.5-flash',
    });
    const recovered = await recoverPipeline.run(vReuse.id);
    expect(recovered.status).toBe('succeeded');
    expect(reuseLlm.calls).toHaveLength(1); // STILL only 1 billed network call!
    expect(await countBilledLlmCalls(ctx.appDb, vReuse.id)).toBe(1);
    const runs = (await listRuns(ctx.appDb, vReuse.id)).data;
    expect(runs[0]?.reusedCallCount).toBe(1);
    expect(runs[0]?.llmCallCount).toBe(0);

    // 2. Manual retry of LLM_SCHEMA_INVALID bypasses reuse and makes a fresh call
    const { document: docRetry, version: vRetry } = await createQueuedInvoice(
      blobStore,
      Buffer.from('%PDF-1.7\nretry-invalid\n%%EOF'),
      'retry-invalid.pdf',
    );
    const retryLlm = new FakeLlmProvider({
      script: [
        { kind: 'schema_invalid', rawText: '{bad', parseError: 'bad json' },
        { kind: 'schema_invalid', rawText: '{still bad', parseError: 'still bad json' },
        { kind: 'ok', output: makeInvoiceOutput() },
      ],
    });
    const retryPipeline = new ExtractionPipeline(ctx.appDb, blobStore, stubParser, retryLlm, {
      workerId: 'worker-retry',
      model: 'gemini-3.5-flash',
    });
    const run1 = await retryPipeline.run(vRetry.id);
    expect(run1).toMatchObject({ status: 'failed_permanent', errorCode: 'LLM_SCHEMA_INVALID' });
    expect(retryLlm.calls).toHaveLength(2); // initial + 1 repair

    await withTx(ctx.appDb, (tx) => retryVersion(tx, docRetry.id, vRetry.versionNumber));
    const run2 = await retryPipeline.run(vRetry.id, { trigger: 'retry' });
    expect(run2.status).toBe('succeeded');
    expect(retryLlm.calls).toHaveLength(3); // fresh billed call on retry

    // 3. Call cap = max(6, chunks + 3) billed calls per version -> fails with LLM_CALL_CAP
    const { document: docCap, version: vCap } = await createQueuedInvoice(
      blobStore,
      Buffer.from('%PDF-1.7\ncall-cap\n%%EOF'),
      'call-cap.pdf',
    );
    const capLlm = new FakeLlmProvider({
      script: Array.from({ length: 10 }, () => ({
        kind: 'schema_invalid' as const,
        rawText: '{bad',
        parseError: 'bad json',
      })),
    });
    const capPipeline = new ExtractionPipeline(ctx.appDb, blobStore, stubParser, capLlm, {
      workerId: 'worker-cap',
      model: 'gemini-3.5-flash',
    });
    // 3 runs × 2 billed calls (initial + repair) = 6 billed calls
    for (let i = 0; i < 3; i++) {
      const r = await capPipeline.run(vCap.id, { trigger: i === 0 ? 'upload' : 'retry' });
      expect(r).toMatchObject({ status: 'failed_permanent', errorCode: 'LLM_SCHEMA_INVALID' });
      await withTx(ctx.appDb, (tx) => retryVersion(tx, docCap.id, vCap.versionNumber));
    }
    expect(await countBilledLlmCalls(ctx.appDb, vCap.id)).toBe(6);

    // 4th run hits cap of 6 immediately without making a 7th billed call
    const capped = await capPipeline.run(vCap.id, { trigger: 'retry' });
    expect(capped).toMatchObject({ status: 'failed_permanent', errorCode: 'LLM_CALL_CAP' });
    expect(capLlm.calls).toHaveLength(6);
    expect(await countBilledLlmCalls(ctx.appDb, vCap.id)).toBe(6);
  });

  it('[R5] permanent errors (LLM_AUTH, PARSE_MALFORMED, LLM_NOT_CONFIGURED) and transient release + BullMQ retry inside lease window', async () => {
    const blobStore = new MemoryBlobStore();
    const stubParser = makeStubParser({
      text: SIMPLE_INVOICE_TEXT,
      pageOffsets: [0],
      pageCount: 1,
      textRanges: { hidden: [], lowVisibility: [] },
      warnings: [],
      parser: PARSER_ID,
    });

    // 1. worker.llm-401-permanent
    const { version: vAuth } = await createQueuedInvoice(
      blobStore,
      Buffer.from('%PDF-1.7\nauth\n%%EOF'),
      'auth.pdf',
    );
    const authPipeline = new ExtractionPipeline(
      ctx.appDb,
      blobStore,
      stubParser,
      new FakeLlmProvider({
        script: [new LlmError('AUTH', '401 invalid api key', { transient: false, status: 401 })],
      }),
      { workerId: 'worker-1', model: 'gemini-3.5-flash' },
    );
    expect(await authPipeline.run(vAuth.id)).toMatchObject({
      status: 'failed_permanent',
      errorCode: 'LLM_AUTH',
    });
    expect((await getVersionById(ctx.appDb, vAuth.id))?.lastErrorCode).toBe('LLM_AUTH');

    // 2. worker.parse-malformed (real PdfParserPool on malformed bytes)
    const { version: vBadPdf } = await createQueuedInvoice(
      blobStore,
      Buffer.from('%PDF-1.7\nnot-a-real-pdf-body\n%%EOF'),
      'malformed.pdf',
    );
    const parsePipeline = new ExtractionPipeline(
      ctx.appDb,
      blobStore,
      pdfPool,
      new FakeLlmProvider(),
      { workerId: 'worker-1', model: 'gemini-3.5-flash' },
    );
    expect(await parsePipeline.run(vBadPdf.id)).toMatchObject({
      status: 'failed_permanent',
      errorCode: 'PARSE_MALFORMED',
    });

    // 3. worker.LLM_NOT_CONFIGURED (lazy provider throwing NOT_CONFIGURED)
    const { version: vUnconf } = await createQueuedInvoice(
      blobStore,
      Buffer.from('%PDF-1.7\nunconf\n%%EOF'),
      'unconf.pdf',
    );
    const unconfPipeline = new ExtractionPipeline(
      ctx.appDb,
      blobStore,
      stubParser,
      () => {
        throw new LlmError('NOT_CONFIGURED', 'GEMINI_API_KEY is not configured', {
          transient: false,
        });
      },
      { workerId: 'worker-1', model: 'gemini-3.5-flash' },
    );
    expect(await unconfPipeline.run(vUnconf.id)).toMatchObject({
      status: 'failed_permanent',
      errorCode: 'LLM_NOT_CONFIGURED',
    });

    // 4. In-run retry when retry-after <= 20s keeps the same run_number = 1
    const { version: vInRun } = await createQueuedInvoice(
      blobStore,
      Buffer.from('%PDF-1.7\ninrun\n%%EOF'),
      'inrun.pdf',
    );
    const inRunLlm = new FakeLlmProvider({
      script: [
        new LlmError('RATE_LIMITED', '429 short retry', { transient: true, retryAfterMs: 25 }),
        { kind: 'ok', output: makeInvoiceOutput() },
      ],
    });
    const inRunPipeline = new ExtractionPipeline(ctx.appDb, blobStore, stubParser, inRunLlm, {
      workerId: 'worker-1',
      model: 'gemini-3.5-flash',
      sleep: async () => {},
    });
    expect((await inRunPipeline.run(vInRun.id)).status).toBe('succeeded');
    expect((await listRuns(ctx.appDb, vInRun.id)).data).toHaveLength(1);
    expect(inRunLlm.calls).toHaveLength(2);

    // 5. Review Focus 3: transient error (> 20s or no retry-after) does fenced release and BullMQ retry claims inside 30s lease window!
    const { version: vTransient } = await createQueuedInvoice(
      blobStore,
      Buffer.from('%PDF-1.7\ntransient\n%%EOF'),
      'transient.pdf',
    );
    const transientLlm = new FakeLlmProvider({
      script: [
        new LlmError('OVERLOADED', '503 busy', { transient: true, status: 503 }),
        { kind: 'ok', output: makeInvoiceOutput() },
      ],
    });
    const transientPipeline = new ExtractionPipeline(
      ctx.appDb,
      blobStore,
      stubParser,
      transientLlm,
      {
        workerId: 'worker-bull',
        model: 'gemini-3.5-flash',
        leaseSeconds: 30,
        defaultTransientBackoffMs: 100,
      },
    );
    const breaker = new LlmCircuitBreaker();
    const processor = new ExtractionProcessor(transientPipeline, breaker);

    const redisUrl = process.env['REDIS_URL'] ?? 'redis://:dev-redis@127.0.0.1:6379';
    const queueName = `${EXTRACTION_QUEUE}-int-${Date.now()}`;
    const queueConn = new Redis(redisUrl, { maxRetriesPerRequest: null });
    const workerConn = new Redis(redisUrl, { maxRetriesPerRequest: null });
    const queue = new Queue<ExtractionJobData>(queueName, { connection: queueConn });
    let completedResolve!: () => void;
    const completedPromise = new Promise<void>((r) => {
      completedResolve = r;
    });

    const worker = new Worker<ExtractionJobData>(
      queueName,
      async (job) => {
        processor.attachWorker(worker);
        await processor.process(job);
      },
      { connection: workerConn, concurrency: 1 },
    );
    worker.on('completed', () => completedResolve());

    try {
      await queue.add(
        'extract',
        { versionId: vTransient.id, trigger: 'upload' },
        {
          jobId: vTransient.id,
          attempts: 3,
          backoff: { type: 'fixed', delay: 150 },
        },
      );
      await completedPromise;

      const finalVer = await getVersionById(ctx.appDb, vTransient.id);
      expect(finalVer?.status).toBe('extracted');
      expect(finalVer?.runSeq).toBe(2); // Attempt 1 released, Attempt 2 claimed inside 30s lease & succeeded!
      const vRuns = (await listRuns(ctx.appDb, vTransient.id)).data;
      expect(vRuns).toHaveLength(2);
      expect(vRuns[0]?.status).toBe('succeeded');
      expect(vRuns[1]?.status).toBe('failed');
      expect(vRuns[1]?.errorCode).toBe('OVERLOADED');
    } finally {
      await worker.close();
      await queue.obliterate({ force: true });
      await queue.close();
      queueConn.disconnect();
      workerConn.disconnect();
    }
  });

  it('merges chunked extractions (CONFLICTING_EVIDENCE on disagreement, earliest offset on agreement) and runs [R7] invoice v1->v2 carry-over with real Gemini cassettes', async () => {
    const blobStore = new MemoryBlobStore();

    // 1. Chunking: conflicting values -> CONFLICTING_EVIDENCE; agreeing values -> earliest offset wins
    const page1 = [
      'MERIDIAN OFFICE SUPPLIES LLC',
      'Invoice Number: INV-2025-001',
      'Issue Date: September 1, 2025',
      'Due Date: October 1, 2025',
      'Total Amount Due: $5,230.29',
    ].join('\n');
    const page2 = [
      'MERIDIAN OFFICE SUPPLIES LLC',
      'Invoice Number: INV-2025-001',
      'Issue Date: September 1, 2025',
      'Due Date: October 1, 2025',
      'Total Amount Due: $9,999.00',
    ].join('\n');
    const twoPageText = `${page1}\f${page2}`;
    const chunkParser = makeStubParser({
      text: twoPageText,
      pageOffsets: [0, page1.length + 1],
      pageCount: 2,
      textRanges: { hidden: [], lowVisibility: [] },
      warnings: [],
      parser: PARSER_ID,
    });
    const { version: vChunk } = await createQueuedInvoice(
      blobStore,
      Buffer.from('%PDF-1.7\nchunked\n%%EOF'),
      'chunked.pdf',
    );
    const chunkLlm = new FakeLlmProvider({
      script: [
        {
          kind: 'ok',
          output: makeInvoiceOutput({
            total: {
              amount: '5230.29',
              currency: 'USD',
              quote: 'Total Amount Due: $5,230.29',
              line: 5,
            },
          }),
        },
        {
          kind: 'ok',
          output: makeInvoiceOutput({
            vendor: {
              value: 'MERIDIAN OFFICE SUPPLIES LLC',
              quote: 'MERIDIAN OFFICE SUPPLIES LLC',
              line: 6,
            },
            total: {
              amount: '9999.00',
              currency: 'USD',
              quote: 'Total Amount Due: $9,999.00',
              line: 10,
            },
          }),
        },
      ],
    });
    const chunkPipeline = new ExtractionPipeline(ctx.appDb, blobStore, chunkParser, chunkLlm, {
      workerId: 'worker-chunk',
      model: 'gemini-3.5-flash',
      chunkCharLimit: 250, // forces page 1 and page 2 into 2 separate chunks
    });

    const chunkRes = await chunkPipeline.run(vChunk.id);
    expect(chunkRes.status).toBe('succeeded');
    expect(chunkLlm.calls).toHaveLength(2);

    const chunkVer = await getVersionById(ctx.appDb, vChunk.id);
    expect(chunkVer?.warnings).toContain('CHUNKED');
    const chunkRuns = (await listRuns(ctx.appDb, vChunk.id)).data;
    expect(chunkRuns[0]?.chunked).toBe(true);
    const chunkCalls = (await listLlmCalls(ctx.appDb, chunkRuns[0]!.id)).data;
    expect(chunkCalls.map((c) => c.kind)).toEqual(['chunk', 'chunk']);

    const chunkValues = await listValuesForVersion(ctx.appDb, vChunk.id);
    const totalRow = chunkValues.find((v) => v.value.fieldKey === 'total_amount')!.value;
    expect(totalRow.kind).toBe('gap');
    expect(totalRow.gapCode).toBe('CONFLICTING_EVIDENCE');

    const vendorRow = chunkValues.find((v) => v.value.fieldKey === 'vendor_name')!.value;
    expect(vendorRow.kind).toBe('value');
    expect(vendorRow.evidenceStart).toBe(0); // earliest offset from chunk 0 won!
    expect(vendorRow.chunkIndex).toBe(0);

    // 2. [R7] pipeline.v1-review-v2: real PDFs + real recorded Gemini cassettes + carry-over
    const v1Bytes = await readFile(path.join(FIXTURES_DIR, 'documents', 'invoice-001.pdf'));
    const v2Bytes = await readFile(path.join(FIXTURES_DIR, 'documents', 'invoice-001.v2.pdf'));
    const { document: invDoc, version: invV1 } = await createQueuedInvoice(
      blobStore,
      v1Bytes,
      'invoice-001.pdf',
    );
    const cassette = new CassetteProvider({
      cassettesDir: CASSETTES_DIR,
      recordedProvider: 'gemini',
    });
    const realPipeline = new ExtractionPipeline(ctx.appDb, blobStore, pdfPool, cassette, {
      workerId: 'worker-cassette',
      model: 'gemini-3.5-flash',
    });

    expect((await realPipeline.run(invV1.id)).status).toBe('succeeded');
    const v1Values = await listValuesForVersion(ctx.appDb, invV1.id);
    expect(v1Values).toHaveLength(5);

    // Human approves all 5 values on v1
    for (const row of v1Values) {
      await withTx(ctx.appDb, (tx) =>
        insertReview(tx, row.value.id, { decision: 'approve', expectedCurrentReviewId: null }),
      );
    }

    // Upload v2 and extract with real cassette
    const v2Hash = sha256Hex(v2Bytes);
    const v2Key = `pdfs/sha256/${v2Hash}.pdf`;
    await blobStore.putObject(v2Key, v2Bytes, 'application/pdf');
    const { version: invV2 } = await withTx(ctx.appDb, (tx) =>
      createNewVersion(tx, invDoc.id, {
        storageKey: v2Key,
        fileSha256: v2Hash,
        fileSizeBytes: v2Bytes.byteLength,
        originalFilename: 'invoice-001.v2.pdf',
      }),
    );

    const v2Outcome = await realPipeline.run(invV2.id);
    expect(v2Outcome).toMatchObject({ status: 'succeeded', pointerMoved: true, pendingCount: 2 });

    const v2Values = await listValuesForVersion(ctx.appDb, invV2.id);
    const byKey = new Map(v2Values.map((r) => [r.value.fieldKey, r]));
    for (const unchanged of ['vendor_name', 'invoice_number', 'issue_date'] as const) {
      expect(byKey.get(unchanged)?.value.changeKind).toBe('same');
      expect(byKey.get(unchanged)?.currentReview?.origin).toBe('carried');
      expect(byKey.get(unchanged)?.currentReview?.decision).toBe('approve');
    }
    for (const changed of ['due_date', 'total_amount'] as const) {
      expect(byKey.get(changed)?.value.changeKind).toBe('changed');
      expect(byKey.get(changed)?.value.changeReason).toBe('VALUE_CHANGED');
      expect(byKey.get(changed)?.currentReview).toBeNull();
    }

    // Also verify claimVersion directly returns null on extracted version
    expect(await withTx(ctx.appDb, (tx) => claimVersion(tx, invV2.id, 'w-extra'))).toBeNull();
  });

  it('handles repair recovery, max_tokens doubling -> LLM_TRUNCATED, refusal -> LLM_REFUSED, and worker.rateLimit on 429', async () => {
    const blobStore = new MemoryBlobStore();
    const stubParser = makeStubParser({
      text: SIMPLE_INVOICE_TEXT,
      pageOffsets: [0],
      pageCount: 1,
      textRanges: { hidden: [], lowVisibility: [] },
      warnings: [],
      parser: PARSER_ID,
    });

    // 1. Single repair turn succeeds
    const { version: vRepair } = await createQueuedInvoice(
      blobStore,
      Buffer.from('%PDF-1.7\nrepair-ok\n%%EOF'),
      'repair-ok.pdf',
    );
    const repairLlm = new FakeLlmProvider({
      script: [
        { kind: 'schema_invalid', rawText: '{bad', parseError: 'bad json' },
        { kind: 'ok', output: makeInvoiceOutput() },
      ],
    });
    const repairPipeline = new ExtractionPipeline(ctx.appDb, blobStore, stubParser, repairLlm, {
      workerId: 'w-rep',
      model: 'gemini-3.5-flash',
    });
    expect((await repairPipeline.run(vRepair.id)).status).toBe('succeeded');
    expect(repairLlm.calls).toHaveLength(2);
    expect(repairLlm.calls[1]?.repair?.errors.length).toBeGreaterThan(0);

    // 2. max_tokens doubles budget once and succeeds; double truncation fails with LLM_TRUNCATED
    const { version: vTruncOk } = await createQueuedInvoice(
      blobStore,
      Buffer.from('%PDF-1.7\ntrunc-ok\n%%EOF'),
      'trunc-ok.pdf',
    );
    const truncOkLlm = new FakeLlmProvider({
      script: [
        { kind: 'truncated', stopReason: 'MAX_TOKENS' },
        { kind: 'ok', output: makeInvoiceOutput() },
      ],
    });
    const truncOkPipeline = new ExtractionPipeline(ctx.appDb, blobStore, stubParser, truncOkLlm, {
      workerId: 'w-trunc',
      model: 'gemini-3.5-flash',
    });
    expect((await truncOkPipeline.run(vTruncOk.id)).status).toBe('succeeded');
    expect(truncOkLlm.calls[1]!.maxOutputTokens).toBe(truncOkLlm.calls[0]!.maxOutputTokens * 2);

    const { version: vTruncFail } = await createQueuedInvoice(
      blobStore,
      Buffer.from('%PDF-1.7\ntrunc-fail\n%%EOF'),
      'trunc-fail.pdf',
    );
    const truncFailPipeline = new ExtractionPipeline(
      ctx.appDb,
      blobStore,
      stubParser,
      new FakeLlmProvider({
        script: [
          { kind: 'truncated', stopReason: 'MAX_TOKENS' },
          { kind: 'truncated', stopReason: 'MAX_TOKENS' },
        ],
      }),
      { workerId: 'w-trunc', model: 'gemini-3.5-flash' },
    );
    expect(await truncFailPipeline.run(vTruncFail.id)).toMatchObject({
      status: 'failed_permanent',
      errorCode: 'LLM_TRUNCATED',
    });

    // 3. refusal -> permanent LLM_REFUSED
    const { version: vRefused } = await createQueuedInvoice(
      blobStore,
      Buffer.from('%PDF-1.7\nrefused\n%%EOF'),
      'refused.pdf',
    );
    const refusedPipeline = new ExtractionPipeline(
      ctx.appDb,
      blobStore,
      stubParser,
      new FakeLlmProvider({ script: [{ kind: 'refused', stopReason: 'SAFETY' }] }),
      { workerId: 'w-ref', model: 'gemini-3.5-flash' },
    );
    expect(await refusedPipeline.run(vRefused.id)).toMatchObject({
      status: 'failed_permanent',
      errorCode: 'LLM_REFUSED',
    });

    // 4. 429 with retryAfterMs > 20s releases and triggers worker.rateLimit(retryAfterMs)
    const { version: vRateLimit } = await createQueuedInvoice(
      blobStore,
      Buffer.from('%PDF-1.7\nratelimit\n%%EOF'),
      'ratelimit.pdf',
    );
    const rateLimitPipeline = new ExtractionPipeline(
      ctx.appDb,
      blobStore,
      stubParser,
      new FakeLlmProvider({
        script: [
          new LlmError('RATE_LIMITED', '429 long wait', {
            transient: true,
            retryAfterMs: 39_000,
            status: 429,
          }),
        ],
      }),
      { workerId: 'w-rl', model: 'gemini-3.5-flash' },
    );
    const rateLimitCalls: number[] = [];
    const fakeWorker = {
      rateLimit: async (ms: number) => {
        rateLimitCalls.push(ms);
        return 0;
      },
    } as unknown as Worker;
    const rlProcessor = new ExtractionProcessor(rateLimitPipeline, new LlmCircuitBreaker());
    rlProcessor.attachWorker(fakeWorker);
    await expect(
      rlProcessor.process({
        data: { versionId: vRateLimit.id, trigger: 'upload' },
      } as never),
    ).rejects.toThrow(/429 long wait/);
    expect(rateLimitCalls).toEqual([39_000]);
  });

  it('boots WorkerModule NestJS application context with BullMQ integer limiter and closes cleanly', async () => {
    const prevEnv = { ...process.env };
    process.env['APP_ENV'] = 'test';
    process.env['DATABASE_URL'] =
      process.env['DATABASE_URL'] ?? 'postgresql://app:dev-app@127.0.0.1:5432/lomi';
    process.env['REDIS_URL'] = process.env['REDIS_URL'] ?? 'redis://:dev-redis@127.0.0.1:6379';
    process.env['S3_ENDPOINT'] = process.env['S3_ENDPOINT'] ?? 'http://127.0.0.1:8333';
    process.env['S3_ACCESS_KEY_ID'] = process.env['S3_ACCESS_KEY_ID'] ?? 'dev-s3-key';
    process.env['S3_SECRET_ACCESS_KEY'] = process.env['S3_SECRET_ACCESS_KEY'] ?? 'dev-s3-secret';
    process.env['LLM_PROVIDER'] = 'fake';
    process.env['LLM_MODEL'] = 'gemini-3.5-flash';

    const app = await NestFactory.createApplicationContext(WorkerModule, {
      logger: false,
      abortOnError: false,
    });
    try {
      await app.init();
      const pipeline = app.get(ExtractionPipeline);
      const processor = app.get(ExtractionProcessor);
      expect(pipeline).toBeInstanceOf(ExtractionPipeline);
      expect(processor).toBeInstanceOf(ExtractionProcessor);
      expect(Number.isInteger(processor.worker.opts.limiter?.max)).toBe(true);
      expect(Number.isInteger(processor.worker.opts.limiter?.duration)).toBe(true);
      expect(processor.worker.opts.concurrency).toBe(2);
    } finally {
      await app.close();
      process.env = prevEnv;
    }
  });
});
