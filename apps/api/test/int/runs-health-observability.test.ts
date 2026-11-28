import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { llmCallDtoSchema, runDtoSchema } from '@app/contracts/dto';
import { pageSchema } from '@app/contracts/page';
import { problemDetailsSchema } from '@app/contracts/problems';
import {
  claimVersion,
  completeLlmCall,
  finalizeRun,
  insertLlmCall,
  saveParsedText,
  withTx,
} from '@app/db';
import { StorageError } from '@app/storage';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createApiTestHarness,
  makeMinimalPdf,
  postMultipart,
  REPO_ROOT,
  type ApiTestHarness,
} from '../helpers/api-harness.js';

describe('API Task 10: runs, DEBUG_ENDPOINTS gating, health, metrics, Swagger, nginx', () => {
  let h: ApiTestHarness;

  beforeAll(async () => {
    h = await createApiTestHarness({ debugEndpoints: false });
  });

  afterAll(async () => {
    await h.close();
  });

  beforeEach(async () => {
    await h.resetAndSeed();
  });

  async function seedDocumentWithRunAndCall() {
    const res = await postMultipart(`${h.baseUrl}/documents`, {
      file: { buffer: makeMinimalPdf('runs-doc'), filename: 'runs.pdf' },
      fields: { type: 'invoice', title: 'Runs Test' },
      headers: { 'x-request-id': 'req-trace-123' },
    });
    expect(res.status).toBe(201);
    const doc = (await res.json()) as { id: string };
    const versionId = h.enqueuer.calls.at(-1)!.versionId;

    const claim = await withTx(h.ctx.appDb, (tx) =>
      claimVersion(tx, versionId, 'worker-obs-1', {
        trigger: 'upload',
        correlationId: 'req-trace-123',
        leaseSeconds: 30,
      }),
    );
    if (!claim) throw new Error('expected claim');

    const text = 'Vendor: Meridian\n';
    await withTx(h.ctx.appDb, (tx) =>
      saveParsedText(tx, versionId, claim.runId, {
        parsedText: text,
        parsedTextSha256: createHash('sha256').update(text).digest('hex'),
        parser: 'pdfjs-test',
        pageOffsets: [0],
        textRanges: { hidden: [], lowVisibility: [] },
        warnings: [],
      }),
    );

    const call = await withTx(h.ctx.appDb, (tx) =>
      insertLlmCall(
        tx,
        {
          versionId,
          seq: 1,
          kind: 'extract',
          requestSha256: createHash('sha256').update('req-1').digest('hex'),
          provider: 'gemini',
          model: 'gemini-3.5-flash',
          promptVersion: 'v1',
          request: { messages: ['redacted-in-logs'] },
        },
        claim.runId,
      ),
    );
    if (!call) throw new Error('expected llm call');
    await withTx(h.ctx.appDb, (tx) =>
      completeLlmCall(tx, call.id, versionId, claim.runId, {
        rawResponse: { fields: {} },
        providerRequestId: 'prov-1',
        servedModel: 'gemini-3.5-flash',
        stopReason: 'STOP',
        schemaValid: true,
        inputTokens: 100,
        outputTokens: 50,
        costUsd: '0.0002',
        latencyMs: 42,
      }),
    );
    await withTx(h.ctx.appDb, (tx) =>
      finalizeRun(tx, versionId, claim.runId, {
        warnings: [],
        chunked: false,
        llmCallCount: 1,
        reusedCallCount: 0,
        costUsd: '0.0002',
        values: [
          {
            fieldKey: 'vendor_name',
            fieldType: 'string',
            kind: 'value',
            value: 'Meridian',
            evidence: 'Vendor: Meridian',
            canonicalEvidence: 'vendor: meridian',
            evidenceStart: 0,
            evidenceEnd: 16,
            evidenceMatchCount: 1,
            citedLine: 1,
            matchMode: 'strict',
            changeKind: 'new',
          },
        ],
      }),
    );

    return { docId: doc.id, runId: claim.runId };
  }

  it('lists runs with correlationId and gates .../calls behind DEBUG_ENDPOINTS=true', async () => {
    const { docId, runId } = await seedDocumentWithRunAndCall();

    const runsRes = await fetch(`${h.baseUrl}/documents/${docId}/versions/1/runs`);
    expect(runsRes.status).toBe(200);
    const runsPage = pageSchema(runDtoSchema).parse(await runsRes.json());
    expect(runsPage.data).toHaveLength(1);
    expect(runsPage.data[0]!.id).toBe(runId);
    expect(runsPage.data[0]!.correlationId).toBe('req-trace-123');
    expect(runsPage.data[0]!.llmCallCount).toBe(1);

    // Default DEBUG_ENDPOINTS=false -> 404 ROUTE_NOT_FOUND
    const callsDisabledRes = await fetch(
      `${h.baseUrl}/documents/${docId}/versions/1/runs/${runId}/calls`,
    );
    expect(callsDisabledRes.status).toBe(404);
    expect(problemDetailsSchema.parse(await callsDisabledRes.json()).code).toBe('ROUTE_NOT_FOUND');

    // Boot a separate harness with DEBUG_ENDPOINTS=true on the same template DB
    const debugHarness = await createApiTestHarness({
      existingCtx: h.ctx,
      debugEndpoints: true,
    });
    try {
      const callsRes = await fetch(
        `${debugHarness.baseUrl}/documents/${docId}/versions/1/runs/${runId}/calls`,
      );
      expect(callsRes.status).toBe(200);
      const callsPage = pageSchema(llmCallDtoSchema).parse(await callsRes.json());
      expect(callsPage.data).toHaveLength(1);
      expect(callsPage.data[0]!.provider).toBe('gemini');
      expect(callsPage.data[0]!.rawResponse).toEqual({ fields: {} });

      // Unknown runId -> 404 RUN_NOT_FOUND
      const missingRunRes = await fetch(
        `${debugHarness.baseUrl}/documents/${docId}/versions/1/runs/01950000-0000-7000-8000-000000000099/calls`,
      );
      expect(missingRunRes.status).toBe(404);
      expect(problemDetailsSchema.parse(await missingRunRes.json()).code).toBe('RUN_NOT_FOUND');
    } finally {
      await debugHarness.close();
    }
  });

  it('serves /health/live, /health/ready (200 ok, 200 degraded on S3/Redis down, 503 on DB down), /metrics, and /docs-json', async () => {
    const liveRes = await fetch(`${h.baseUrl}/health/live`);
    expect(liveRes.status).toBe(200);
    expect(await liveRes.json()).toMatchObject({ status: 'ok' });

    // Healthy ready -> 200 ok
    const readyOkRes = await fetch(`${h.baseUrl}/health/ready`);
    expect(readyOkRes.status).toBe(200);
    expect(await readyOkRes.json()).toEqual({
      status: 'ok',
      checks: { db: 'ok', redis: 'ok', s3: 'ok' },
    });

    // S3 down -> 200 degraded (spec §7.5: 503 only if DB is down)
    h.blobStore.failWith = new StorageError('STORAGE_UNAVAILABLE', 'down', { transient: true });
    try {
      const degradedRes = await fetch(`${h.baseUrl}/health/ready`);
      expect(degradedRes.status).toBe(200);
      expect(await degradedRes.json()).toEqual({
        status: 'degraded',
        checks: { db: 'ok', redis: 'ok', s3: 'error' },
      });
    } finally {
      h.blobStore.failWith = null;
    }

    // Redis down -> 200 degraded
    h.setRedisHealthy(false);
    try {
      const degradedRedisRes = await fetch(`${h.baseUrl}/health/ready`);
      expect(degradedRedisRes.status).toBe(200);
      expect(await degradedRedisRes.json()).toEqual({
        status: 'degraded',
        checks: { db: 'ok', redis: 'error', s3: 'ok' },
      });
    } finally {
      h.setRedisHealthy(true);
    }

    // Metrics expose core counters & HTTP histogram
    await postMultipart(`${h.baseUrl}/documents`, {
      file: { buffer: makeMinimalPdf('metrics-doc'), filename: 'metrics.pdf' },
      fields: { type: 'invoice' },
    });
    const metricsRes = await fetch(`${h.baseUrl}/metrics`);
    expect(metricsRes.status).toBe(200);
    const metricsText = await metricsRes.text();
    expect(metricsText).toContain('http_request_duration_seconds');
    expect(metricsText).toMatch(/documents_uploaded_total\{type="invoice"\}\s+[1-9]/);

    // Swagger JSON & UI are served at /docs-json and /docs
    const docsJsonRes = await fetch(`${h.baseUrl}/docs-json`);
    expect(docsJsonRes.status).toBe(200);
    const spec = (await docsJsonRes.json()) as {
      openapi: string;
      paths: Record<string, unknown>;
    };
    expect(spec.openapi).toMatch(/^3\./);
    expect(spec.paths['/documents']).toBeDefined();
    expect(spec.paths['/documents/facets']).toBeDefined();
    expect(spec.paths['/documents/{id}/versions/{n}/runs']).toBeDefined();
    expect(spec.paths['/health/ready']).toBeDefined();

    // DB down -> 503 unhealthy (spec §7.5)
    const brokenDbApp = await createApiTestHarness({
      existingCtx: {
        ...h.ctx,
        appDb: {
          execute: () => Promise.reject(new Error('db down')),
        } as unknown as typeof h.ctx.appDb,
      },
    });
    try {
      const dbDownRes = await fetch(`${brokenDbApp.baseUrl}/health/ready`);
      expect(dbDownRes.status).toBe(503);
      expect(await dbDownRes.json()).toEqual({
        status: 'unhealthy',
        checks: { db: 'error', redis: 'ok', s3: 'ok' },
      });
    } finally {
      await brokenDbApp.close();
    }
  });

  it('ships hardened infra/nginx/nginx.conf with SPA CSP, tmpfs temp paths, 11m limit, proxy_buffering off on /file, and rate limits', async () => {
    const nginxConf = await readFile(path.join(REPO_ROOT, 'infra', 'nginx', 'nginx.conf'), 'utf8');
    expect(nginxConf).toContain("default-src 'self'");
    expect(nginxConf).toContain("frame-ancestors 'none'");
    expect(nginxConf).toContain('Referrer-Policy');
    expect(nginxConf).toContain('nosniff');
    expect(nginxConf).toContain('client_max_body_size 11m');
    expect(nginxConf).toContain('client_body_temp_path /tmp/');
    expect(nginxConf).toContain('proxy_temp_path /tmp/');
    expect(nginxConf).toContain('proxy_buffering off');
    expect(nginxConf).toContain('limit_req');
    expect(nginxConf).toContain('limit_conn');
  });
});
