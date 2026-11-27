import {
  claimVersion,
  createDocumentWithInitialVersion,
  createNewVersion,
  finalizeRun,
  getAliveDocument,
  getVersionById,
  insertReview,
  listValuesForVersion,
  saveParsedText,
  withTx,
} from '@app/db';
import { acquireRowLockBarrier, withTemplateDb, type TemplateDbHandle } from '@app/db/testing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const HEX64_A = 'a'.repeat(64);
const HEX64_B = 'b'.repeat(64);

function makeSeededValues(amount: string) {
  return [
    {
      fieldKey: 'vendor_name',
      fieldType: 'string' as const,
      kind: 'value' as const,
      value: 'MERIDIAN OFFICE SUPPLIES LLC',
      rawValue: 'MERIDIAN OFFICE SUPPLIES LLC',
      evidence: 'MERIDIAN OFFICE SUPPLIES LLC',
      canonicalEvidence: 'meridian office supplies llc',
      evidenceStart: 0,
      evidenceEnd: 28,
      evidenceMatchCount: 1,
      citedLine: 1,
      matchMode: 'strict' as const,
      changeKind: 'new' as const,
    },
    {
      fieldKey: 'invoice_number',
      fieldType: 'string' as const,
      kind: 'value' as const,
      value: 'INV-001',
      rawValue: 'INV-001',
      evidence: 'Invoice Number: INV-001',
      canonicalEvidence: 'invoice number: inv-001',
      evidenceStart: 29,
      evidenceEnd: 52,
      evidenceMatchCount: 1,
      citedLine: 2,
      matchMode: 'strict' as const,
      changeKind: 'new' as const,
    },
    {
      fieldKey: 'total_amount',
      fieldType: 'money' as const,
      kind: 'value' as const,
      value: { amount, currency: 'USD' as const },
      rawValue: `$${amount}`,
      evidence: `Total: $${amount}`,
      canonicalEvidence: `total: $${amount}`,
      evidenceStart: 53,
      evidenceEnd: 69,
      evidenceMatchCount: 1,
      citedLine: 3,
      matchMode: 'strict' as const,
      changeKind: 'new' as const,
    },
  ];
}

describe('DB concurrency invariants proven with pg_blocking_pids (Task 8)', () => {
  let ctx: TemplateDbHandle;

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
    const tplId = tplRes.rows[0]!.id;
    await ctx.migratorPool.query(
      `INSERT INTO template_fields (template_id, field_key, field_type, position, label)
       VALUES
         ($1, 'vendor_name', 'string', 1, 'Vendor'),
         ($1, 'invoice_number', 'string', 2, 'Invoice Number'),
         ($1, 'total_amount', 'money', 3, 'Total Amount')`,
      [tplId],
    );
  });

  it('[R4] conc.claims-one-winner serializes N concurrent claimVersion calls behind a row lock barrier to a single winner', async () => {
    const { version } = await withTx(ctx.appDb, (tx) =>
      createDocumentWithInitialVersion(tx, {
        type: 'invoice',
        title: 'Race Claim Doc',
        storageKey: `pdfs/sha256/${HEX64_A}.pdf`,
        fileSha256: HEX64_A,
        fileSizeBytes: 1024,
        originalFilename: 'race.pdf',
      }),
    );

    const barrier = await acquireRowLockBarrier(
      ctx.migratorPool,
      'document_versions',
      version.id,
      ctx.appPool,
    );
    const actors = Array.from({ length: 5 }, (_, idx) =>
      withTx(ctx.appDb, (tx) => claimVersion(tx, version.id, `worker-${idx + 1}`)),
    );

    try {
      const blockedPids = await barrier.waitForBlockedCount(5);
      expect(blockedPids.length).toBeGreaterThanOrEqual(5);
    } finally {
      await barrier.release();
    }

    const results = await Promise.all(actors);
    const winners = results.filter((r) => r !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0]!.runNumber).toBe(1);

    const runCount = await ctx.appDb.execute<{ cnt: number }>(
      sql`SELECT COUNT(*)::int AS cnt FROM extraction_runs WHERE version_id = ${version.id}`,
    );
    expect(runCount.rows[0]?.cnt).toBe(1);
  });

  it('[R9] conc.v2-during-v1 and conc.v1-finishes-after-v2 preserve reviewable_version_id at v2 when v1 finalizes second', async () => {
    const { document, version: v1 } = await withTx(ctx.appDb, (tx) =>
      createDocumentWithInitialVersion(tx, {
        type: 'invoice',
        title: 'Invoice v1+v2',
        storageKey: `pdfs/sha256/${HEX64_A}.pdf`,
        fileSha256: HEX64_A,
        fileSizeBytes: 1024,
        originalFilename: 'invoice-001.pdf',
      }),
    );

    // Worker A claims v1 (v1 is now extracting) and persists C1 parsed_text
    const run1 = await withTx(ctx.appDb, (tx) => claimVersion(tx, v1.id, 'worker-v1'));
    expect(run1).not.toBeNull();
    await saveParsedText(ctx.appDb, v1.id, run1!.runId, {
      parsedText: 'MERIDIAN OFFICE SUPPLIES LLC\nInvoice Number: INV-001\nTotal: $5230.29',
      parsedTextSha256: HEX64_A,
      parser: 'pdfjs-v1',
      pageOffsets: [0],
      textRanges: { hidden: [], lowVisibility: [] },
      warnings: [],
    });

    // v2 arrives while v1 is extracting and Worker B claims v2 and persists C1 parsed_text
    const { version: v2 } = await withTx(ctx.appDb, (tx) =>
      createNewVersion(tx, document.id, {
        storageKey: `pdfs/sha256/${HEX64_B}.pdf`,
        fileSha256: HEX64_B,
        fileSizeBytes: 2048,
        originalFilename: 'invoice-001.v2.pdf',
      }),
    );
    expect(v2.versionNumber).toBe(2);
    const run2 = await withTx(ctx.appDb, (tx) => claimVersion(tx, v2.id, 'worker-v2'));
    expect(run2).not.toBeNull();
    await saveParsedText(ctx.appDb, v2.id, run2!.runId, {
      parsedText: 'MERIDIAN OFFICE SUPPLIES LLC\nInvoice Number: INV-001\nTotal: $6000.00',
      parsedTextSha256: HEX64_B,
      parser: 'pdfjs-v1',
      pageOffsets: [0],
      textRanges: { hidden: [], lowVisibility: [] },
      warnings: [],
    });

    // Hold documents FOR UPDATE so v1's finalize parks proven with pg_blocking_pids,
    // while we verify v2 finalizing first moves the pointer and v1 finishing second does not regress it.
    const v2Finalized = await withTx(ctx.appDb, (tx) =>
      finalizeRun(tx, v2.id, run2!.runId, {
        warnings: [],
        chunked: false,
        llmCallCount: 1,
        reusedCallCount: 0,
        costUsd: '0.001000',
        values: makeSeededValues('6000'),
      }),
    );
    expect(v2Finalized).toMatchObject({ ok: true, pointerMoved: true, pendingCount: 3 });

    // Now lock documents FOR UPDATE, launch v1 finalize, prove it parks via pg_blocking_pids, then release
    const docBarrier = await acquireRowLockBarrier(
      ctx.migratorPool,
      'documents',
      document.id,
      ctx.appPool,
    );
    const v1FinalizePromise = withTx(ctx.appDb, (tx) =>
      finalizeRun(tx, v1.id, run1!.runId, {
        warnings: [],
        chunked: false,
        llmCallCount: 1,
        reusedCallCount: 0,
        costUsd: '0.001000',
        values: makeSeededValues('5230.29'),
      }),
    );
    try {
      const blocked = await docBarrier.waitForBlockedCount(1);
      expect(blocked.length).toBeGreaterThanOrEqual(1);
    } finally {
      await docBarrier.release();
    }

    const v1Finalized = await v1FinalizePromise;
    expect(v1Finalized).toMatchObject({ ok: true, pointerMoved: false, pendingCount: 3 });

    const docAfter = await getAliveDocument(ctx.appDb, document.id);
    expect(docAfter?.reviewableVersionId).toBe(v2.id);
    expect(docAfter?.pendingCount).toBe(3);

    const v1After = await getVersionById(ctx.appDb, v1.id);
    expect(v1After?.status).toBe('extracted');
    expect(await listValuesForVersion(ctx.appDb, v1.id)).toHaveLength(3);
    expect(await listValuesForVersion(ctx.appDb, v2.id)).toHaveLength(3);
  });

  it('[R12] conc.pending_count-invariant holds under concurrent approve, correct, and no-op reviews proven with pg_blocking_pids', async () => {
    const { document, version } = await withTx(ctx.appDb, (tx) =>
      createDocumentWithInitialVersion(tx, {
        type: 'invoice',
        title: 'Pending Count Race',
        storageKey: `pdfs/sha256/${HEX64_A}.pdf`,
        fileSha256: HEX64_A,
        fileSizeBytes: 1024,
        originalFilename: 'pending.pdf',
      }),
    );
    const run = await withTx(ctx.appDb, (tx) => claimVersion(tx, version.id, 'worker-1'));
    await saveParsedText(ctx.appDb, version.id, run!.runId, {
      parsedText: 'MERIDIAN OFFICE SUPPLIES LLC\nInvoice Number: INV-001\nTotal: $5230.29',
      parsedTextSha256: HEX64_A,
      parser: 'pdfjs-v1',
      pageOffsets: [0],
      textRanges: { hidden: [], lowVisibility: [] },
      warnings: [],
    });
    await withTx(ctx.appDb, (tx) =>
      finalizeRun(tx, version.id, run!.runId, {
        warnings: [],
        chunked: false,
        llmCallCount: 1,
        reusedCallCount: 0,
        costUsd: '0.001000',
        values: makeSeededValues('5230.29'),
      }),
    );

    const vals = await listValuesForVersion(ctx.appDb, version.id);
    const vendorVal = vals.find((v) => v.value.fieldKey === 'vendor_name')!.value;
    const invVal = vals.find((v) => v.value.fieldKey === 'invoice_number')!.value;
    const totalVal = vals.find((v) => v.value.fieldKey === 'total_amount')!.value;

    // Park 4 concurrent review actors behind a lock barrier on `documents` (proving lock wait),
    // including two competing reviews on the same field (one approve + one no-op/conflict)
    // and simultaneous approve + correct on distinct fields.
    const barrier = await acquireRowLockBarrier(
      ctx.migratorPool,
      'documents',
      document.id,
      ctx.appPool,
    );
    const reviewTasks = [
      withTx(ctx.appDb, (tx) =>
        insertReview(tx, vendorVal.id, { decision: 'approve', expectedCurrentReviewId: null }),
      ),
      withTx(ctx.appDb, (tx) =>
        insertReview(tx, invVal.id, { decision: 'approve', expectedCurrentReviewId: null }),
      ),
      withTx(ctx.appDb, (tx) =>
        insertReview(tx, totalVal.id, {
          decision: 'correct',
          correctedValue: { amount: '5500', currency: 'USD' },
          expectedCurrentReviewId: null,
        }),
      ),
      withTx(ctx.appDb, (tx) =>
        insertReview(tx, vendorVal.id, { decision: 'approve', expectedCurrentReviewId: null }),
      ).catch((err: unknown) => err),
    ];

    try {
      const blocked = await barrier.waitForBlockedCount(4);
      expect(blocked.length).toBeGreaterThanOrEqual(4);
    } finally {
      await barrier.release();
    }

    await Promise.all(reviewTasks);

    // Re-submit an identical no-op review on already-decided field and a correction change
    const afterWave1 = await listValuesForVersion(ctx.appDb, version.id);
    const invReviewId = afterWave1.find((v) => v.value.fieldKey === 'invoice_number')!
      .currentReview!.id;
    const noopRes = await withTx(ctx.appDb, (tx) =>
      insertReview(tx, invVal.id, {
        decision: 'approve',
        expectedCurrentReviewId: invReviewId,
      }),
    );
    expect(noopRes.noop).toBe(true);
    expect(noopRes.delta).toBe(0);

    // Verify documents.pending_count matches exact source-of-truth SQL count (0 pending!)
    const doc = await getAliveDocument(ctx.appDb, document.id);
    const recomputed = await ctx.appDb.execute<{ pending_count: number }>(sql`
      SELECT COUNT(*)::int AS pending_count
      FROM extracted_values v
      LEFT JOIN reviews r ON r.id = v.current_review_id
      WHERE v.version_id = ${version.id}
        AND (v.current_review_id IS NULL OR r.decision = 'revert')
    `);
    expect(doc?.pendingCount).toBe(0);
    expect(doc?.pendingCount).toBe(recomputed.rows[0]?.pending_count);
  });
});
