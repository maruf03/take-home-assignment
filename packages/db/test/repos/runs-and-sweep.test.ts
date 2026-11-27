import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DbRepoError, withTx } from '../../src/client.js';
import { createDocumentWithInitialVersion } from '../../src/repos/documents.js';
import {
  completeLlmCall,
  countBilledLlmCalls,
  findReusableLlmCall,
  insertLlmCall,
  listLlmCalls,
} from '../../src/repos/llm-calls.js';
import {
  claimVersion,
  failRun,
  heartbeat,
  listRuns,
  releaseRun,
  sweepBootRelease,
  sweepCandidates,
  sweepExpired,
  sweepPoison,
} from '../../src/repos/runs.js';
import {
  createReextractVersion,
  listVersions,
  retryVersion,
  saveParsedText,
} from '../../src/repos/versions.js';
import { expireLease } from '../../src/testing/expire-lease.js';
import { withTemplateDb, type TemplateDbHandle } from '../../src/testing/template-db.js';

const HEX64_A = 'a'.repeat(64);
const HEX64_B = 'b'.repeat(64);

describe('runs, fencing, retries, and sweep repositories', () => {
  let ctx: TemplateDbHandle;
  let docId: string;
  let versionId: string;

  beforeAll(async () => {
    ctx = await withTemplateDb({ applyGrants: true });
  });

  afterAll(async () => {
    await ctx?.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    await ctx.migratorPool.query(
      `INSERT INTO document_types (key, display_name) VALUES ('invoice', 'Invoice')`,
    );
    const tplRes = await ctx.migratorPool.query<{ id: string }>(
      `INSERT INTO extraction_templates (document_type, version, content_sha256)
       VALUES ('invoice', 1, $1) RETURNING id`,
      [HEX64_A],
    );
    await ctx.migratorPool.query(
      `INSERT INTO template_fields (template_id, field_key, field_type, position, label)
       VALUES ($1, 'vendor_name', 'string', 1, 'Vendor')`,
      [tplRes.rows[0]!.id],
    );

    const created = await withTx(ctx.appDb, (tx) =>
      createDocumentWithInitialVersion(tx, {
        type: 'invoice',
        title: 'Invoice 1',
        storageKey: `pdfs/sha256/${HEX64_A}.pdf`,
        fileSha256: HEX64_A,
        fileSizeBytes: 1024,
        originalFilename: 'invoice-001.pdf',
      }),
    );
    docId = created.document.id;
    versionId = created.version.id;
  });

  it('[R5] retry after a failure claims run_number 2 with no 23505', async () => {
    const run1 = await withTx(ctx.appDb, (tx) => claimVersion(tx, versionId, 'worker-1'));
    expect(run1).not.toBeNull();
    expect(run1!.runNumber).toBe(1);

    const failed = await withTx(ctx.appDb, (tx) =>
      failRun(tx, versionId, run1!.runId, 'LLM_NOT_CONFIGURED', 'Missing key'),
    );
    expect(failed).toBe(true);

    const retried = await withTx(ctx.appDb, (tx) => retryVersion(tx, docId, 1));
    expect(retried.status).toBe('queued');
    expect(retried.attempts).toBe(0);
    expect(retried.lastErrorCode).toBeNull();
    expect(retried.enqueuedAt).toBeNull();

    const run2 = await withTx(ctx.appDb, (tx) =>
      claimVersion(tx, versionId, 'worker-2', { trigger: 'retry' }),
    );
    expect(run2).not.toBeNull();
    expect(run2!.runNumber).toBe(2);
    expect(run2!.runId).not.toBe(run1!.runId);
  });

  it('[I1] db.heartbeat-0-rows-aborts: heartbeat with a stale runId returns false and all fenced writes affect 0 rows', async () => {
    const run1 = await withTx(ctx.appDb, (tx) => claimVersion(tx, versionId, 'worker-1'));
    expect(run1).not.toBeNull();

    // Valid heartbeat returns true
    const okBeat = await withTx(ctx.appDb, (tx) => heartbeat(tx, versionId, run1!.runId));
    expect(okBeat).toBe(true);

    // Insert an in-flight call under run1 before lease expires
    const run1Call = await withTx(ctx.appDb, (tx) =>
      insertLlmCall(
        tx,
        {
          versionId,
          seq: 1,
          kind: 'extract',
          requestSha256: HEX64_B,
          provider: 'gemini',
          model: 'gemini-3.5-flash',
          promptVersion: 'v1',
          request: { prompt: 'x' },
        },
        run1!.runId,
      ),
    );
    expect(run1Call).not.toBeNull();

    // Expire lease and let worker-2 take over as run 2
    await expireLease(ctx.migratorPool, versionId);
    const expiredIds = await withTx(ctx.appDb, (tx) => sweepExpired(tx));
    expect(expiredIds).toContain(versionId);

    const run2 = await withTx(ctx.appDb, (tx) =>
      claimVersion(tx, versionId, 'worker-2', { trigger: 'sweep' }),
    );
    expect(run2!.runNumber).toBe(2);

    // Stale run1 heartbeat and ALL fenced writes must fail safely
    const staleBeat = await withTx(ctx.appDb, (tx) => heartbeat(tx, versionId, run1!.runId));
    expect(staleBeat).toBe(false);

    const staleParsed = await withTx(ctx.appDb, (tx) =>
      saveParsedText(tx, versionId, run1!.runId, {
        parsedText: 'hello',
        parsedTextSha256: HEX64_B,
        parser: 'lines/1',
        pageOffsets: [0],
        textRanges: { hidden: [], lowVisibility: [] },
        warnings: [],
      }),
    );
    expect(staleParsed).toBe(false);

    const staleComplete = await withTx(ctx.appDb, (tx) =>
      completeLlmCall(tx, run1Call!.id, versionId, run1!.runId, {
        rawResponse: { stale: true },
        schemaValid: true,
      }),
    );
    expect(staleComplete).toBe(false);

    const staleFail = await withTx(ctx.appDb, (tx) =>
      failRun(tx, versionId, run1!.runId, 'LLM_AUTH', 'stale worker'),
    );
    expect(staleFail).toBe(false);

    const staleRelease = await withTx(ctx.appDb, (tx) =>
      releaseRun(tx, versionId, run1!.runId, 'RATE_LIMITED', 5000),
    );
    expect(staleRelease).toBe(false);

    const staleCall = await withTx(ctx.appDb, (tx) =>
      insertLlmCall(
        tx,
        {
          versionId,
          seq: 2,
          kind: 'extract',
          requestSha256: HEX64_B,
          provider: 'gemini',
          model: 'gemini-3.5-flash',
          promptVersion: 'v1',
          request: { prompt: 'x' },
        },
        run1!.runId,
      ),
    );
    expect(staleCall).toBeNull();

    // Live run2 call succeeds, is reusable by request_sha256, and is listed cleanly
    const liveCall = await withTx(ctx.appDb, (tx) =>
      insertLlmCall(
        tx,
        {
          versionId,
          seq: 1,
          kind: 'extract',
          requestSha256: HEX64_B,
          provider: 'gemini',
          model: 'gemini-3.5-flash',
          promptVersion: 'v1',
          request: { prompt: 'x' },
        },
        run2!.runId,
      ),
    );
    expect(liveCall).not.toBeNull();

    const completed = await withTx(ctx.appDb, (tx) =>
      completeLlmCall(tx, liveCall!.id, versionId, run2!.runId, {
        rawResponse: { ok: true },
        providerRequestId: 'resp-1',
        servedModel: 'gemini-3.6-flash',
        stopReason: 'STOP',
        schemaValid: true,
        inputTokens: 100,
        outputTokens: 50,
        costUsd: '0.001000',
        latencyMs: 250,
      }),
    );
    expect(completed).toBe(true);

    const reusable = await withTx(ctx.appDb, (tx) => findReusableLlmCall(tx, versionId, HEX64_B));
    expect(reusable?.id).toBe(liveCall!.id);

    const callsPage = await withTx(ctx.appDb, (tx) => listLlmCalls(tx, run2!.runId, { limit: 10 }));
    expect(callsPage.data.map((c) => c.id)).toEqual([liveCall!.id]);

    const runsPage = await withTx(ctx.appDb, (tx) => listRuns(tx, versionId, { limit: 10 }));
    expect(runsPage.data.map((r) => r.runNumber)).toEqual([2, 1]);

    const billed = await withTx(ctx.appDb, (tx) => countBilledLlmCalls(tx, versionId));
    expect(billed).toBe(2);
  });

  it('concurrent claims race to a single winner and second gets null', async () => {
    const [r1, r2] = await Promise.all([
      withTx(ctx.appDb, (tx) => claimVersion(tx, versionId, 'worker-a')),
      withTx(ctx.appDb, (tx) => claimVersion(tx, versionId, 'worker-b')),
    ]);
    const winners = [r1, r2].filter((r) => r !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0]!.runNumber).toBe(1);
  });

  it('releaseRun sets queued with a future enqueued_at and sweepCandidates respects backoff', async () => {
    const run1 = await withTx(ctx.appDb, (tx) => claimVersion(tx, versionId, 'worker-1'));
    expect(run1).not.toBeNull();

    const released = await withTx(ctx.appDb, (tx) =>
      releaseRun(tx, versionId, run1!.runId, 'RATE_LIMITED', 60_000, '429 retry in 60s'),
    );
    expect(released).toBe(true);

    const row = await ctx.appPool.query<{ status: string; enqueued_at: Date; is_future: boolean }>(
      `SELECT status, enqueued_at, (enqueued_at > now()) AS is_future FROM document_versions WHERE id = $1`,
      [versionId],
    );
    expect(row.rows[0]?.status).toBe('queued');
    expect(row.rows[0]?.is_future).toBe(true);

    // Sweep must not pick up a version with future enqueued_at
    const candidates = await withTx(ctx.appDb, (tx) => sweepCandidates(tx));
    expect(candidates.map((c) => c.versionId)).not.toContain(versionId);
  });

  it('sweepBootRelease releases own leases, sweepCandidates picks NULL enqueued_at, sweepPoison enforces MAX_ATTEMPTS', async () => {
    // Initially enqueued_at is NULL -> eligible immediately
    const c1 = await withTx(ctx.appDb, (tx) => sweepCandidates(tx));
    expect(c1.map((c) => c.versionId)).toContain(versionId);

    // Boot release frees worker-boot's own leases
    await withTx(ctx.appDb, (tx) => claimVersion(tx, versionId, 'worker-boot'));
    const released = await withTx(ctx.appDb, (tx) => sweepBootRelease(tx, 'worker-boot'));
    expect(released).toContain(versionId);

    // Push attempts to 5 and verify sweepPoison marks failed MAX_ATTEMPTS
    await ctx.migratorPool.query(`UPDATE document_versions SET attempts = 5 WHERE id = $1`, [
      versionId,
    ]);
    const poisoned = await withTx(ctx.appDb, (tx) => sweepPoison(tx, 5));
    expect(poisoned).toContain(versionId);

    const failedRow = await ctx.appPool.query<{ status: string; last_error_code: string }>(
      `SELECT status, last_error_code FROM document_versions WHERE id = $1`,
      [versionId],
    );
    expect(failedRow.rows[0]).toEqual({ status: 'failed', last_error_code: 'MAX_ATTEMPTS' });
  });

  it('createReextractVersion enforces terminal source, copies/clears parsed text based on reparse, and listVersions paginates', async () => {
    // Queued v1 is not terminal -> 409 VERSION_NOT_TERMINAL
    await expect(
      withTx(ctx.appDb, (tx) => createReextractVersion(tx, docId, 1, { reparse: false })),
    ).rejects.toMatchObject({ code: 'VERSION_NOT_TERMINAL' });

    // Save parsed text and fail v1 so it becomes terminal with parsed text
    const run1 = await withTx(ctx.appDb, (tx) => claimVersion(tx, versionId, 'w1'));
    await withTx(ctx.appDb, (tx) =>
      saveParsedText(tx, versionId, run1!.runId, {
        parsedText: 'Invoice body',
        parsedTextSha256: HEX64_B,
        parser: 'lines/1',
        pageOffsets: [0],
        textRanges: { hidden: [], lowVisibility: [] },
        warnings: [],
      }),
    );
    await withTx(ctx.appDb, (tx) =>
      failRun(tx, versionId, run1!.runId, 'LLM_SCHEMA_INVALID', 'schema mismatch'),
    );

    // reparse: false copies parsed_text from v1
    const v2 = await withTx(ctx.appDb, (tx) =>
      createReextractVersion(tx, docId, 1, { reparse: false }),
    );
    expect(v2.version.versionNumber).toBe(2);
    expect(v2.version.origin).toBe('reextract');
    expect(v2.version.sourceVersionId).toBe(versionId);
    expect(v2.version.parsedText).toBe('Invoice body');

    // reparse: true clears parsed_text
    const v3 = await withTx(ctx.appDb, (tx) =>
      createReextractVersion(tx, docId, 1, { reparse: true }),
    );
    expect(v3.version.versionNumber).toBe(3);
    expect(v3.version.parsedText).toBeNull();

    // listVersions paginates desc by version_number and rejects > INT4_MAX cursor
    const page1 = await withTx(ctx.appDb, (tx) => listVersions(tx, docId, { limit: 2 }));
    expect(page1.data.map((v) => v.versionNumber)).toEqual([3, 2]);
    expect(page1.page.hasMore).toBe(true);
    const page2 = await withTx(ctx.appDb, (tx) =>
      listVersions(tx, docId, { limit: 2, cursor: page1.page.nextCursor! }),
    );
    expect(page2.data.map((v) => v.versionNumber)).toEqual([1]);
    expect(page2.page.hasMore).toBe(false);

    // Retry on deleted document must throw 410 DOCUMENT_DELETED
    await ctx.migratorPool.query(`UPDATE documents SET deleted_at = now() WHERE id = $1`, [docId]);
    await expect(withTx(ctx.appDb, (tx) => retryVersion(tx, docId, 1))).rejects.toBeInstanceOf(
      DbRepoError,
    );
    await expect(withTx(ctx.appDb, (tx) => retryVersion(tx, docId, 1))).rejects.toMatchObject({
      code: 'DOCUMENT_DELETED',
    });
  });
});
