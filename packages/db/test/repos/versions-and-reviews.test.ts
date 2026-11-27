import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DbRepoError, withReadOnlyTx, withTx } from '../../src/client.js';
import {
  countNeedsReviewFacets,
  createDocumentWithInitialVersion,
  listAliveDocuments,
  listDocumentTypesWithTemplates,
} from '../../src/repos/documents.js';
import { decodeCursor, encodeCursor, toPage } from '../../src/repos/keyset.js';
import { insertReview, listReviewsForValue } from '../../src/repos/reviews.js';
import { claimVersion, failRun } from '../../src/repos/runs.js';
import { finalizeRun, listValuesForVersion } from '../../src/repos/values.js';
import { createNewVersion, listVersions, saveParsedText } from '../../src/repos/versions.js';
import { withTemplateDb, type TemplateDbHandle } from '../../src/testing/template-db.js';

const HEX64_1 = '1'.repeat(64);
const HEX64_2 = '2'.repeat(64);
const HEX64_T1 = 'a'.repeat(64);
const HEX64_T2 = 'b'.repeat(64);

describe('versions dedupe, finalize, reviews delta/conflict, and keyset pagination', () => {
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
      [HEX64_T1],
    );
    await ctx.migratorPool.query(
      `INSERT INTO template_fields (template_id, field_key, field_type, position, label)
       VALUES
         ($1, 'vendor_name', 'string', 1, 'Vendor'),
         ($1, 'total_amount', 'money', 2, 'Total amount')`,
      [tplRes.rows[0]!.id],
    );
  });

  it('dedupes identical non-failed upload on current template without incrementing, and creates new version after failure or template bump', async () => {
    const created = await withTx(ctx.appDb, (tx) =>
      createDocumentWithInitialVersion(tx, {
        type: 'invoice',
        title: 'Invoice 1',
        storageKey: `pdfs/sha256/${HEX64_1}.pdf`,
        fileSha256: HEX64_1,
        fileSizeBytes: 512,
        originalFilename: 'v1.pdf',
      }),
    );

    // Same hash, queued, current template -> dedupe (no version_number increment)
    const dup = await withTx(ctx.appDb, (tx) =>
      createNewVersion(tx, created.document.id, {
        storageKey: `pdfs/sha256/${HEX64_1}.pdf`,
        fileSha256: HEX64_1,
        fileSizeBytes: 512,
        originalFilename: 'v1-copy.pdf',
      }),
    );
    expect(dup.deduplicated).toBe(true);
    expect(dup.version.id).toBe(created.version.id);
    expect(dup.document.latestVersionNumber).toBe(1);

    // Fail v1 -> same hash now creates v2
    const run1 = await withTx(ctx.appDb, (tx) => claimVersion(tx, created.version.id, 'w1'));
    await withTx(ctx.appDb, (tx) =>
      failRun(tx, created.version.id, run1!.runId, 'PARSE_MALFORMED', 'bad pdf'),
    );

    const v2 = await withTx(ctx.appDb, (tx) =>
      createNewVersion(tx, created.document.id, {
        storageKey: `pdfs/sha256/${HEX64_1}.pdf`,
        fileSha256: HEX64_1,
        fileSizeBytes: 512,
        originalFilename: 'v1-again.pdf',
      }),
    );
    expect(v2.deduplicated).toBe(false);
    expect(v2.version.versionNumber).toBe(2);

    // Bump template to v2 -> same hash on queued v2 now creates v3 pinned to template v2
    await ctx.migratorPool.query(
      `INSERT INTO extraction_templates (document_type, version, content_sha256)
       VALUES ('invoice', 2, $1)`,
      [HEX64_T2],
    );
    const v3 = await withTx(ctx.appDb, (tx) =>
      createNewVersion(tx, created.document.id, {
        storageKey: `pdfs/sha256/${HEX64_1}.pdf`,
        fileSha256: HEX64_1,
        fileSizeBytes: 512,
        originalFilename: 'v1-new-tpl.pdf',
      }),
    );
    expect(v3.deduplicated).toBe(false);
    expect(v3.version.versionNumber).toBe(3);
  });

  it('review delta is -1 on pending->decided, 0 on re-decide, identical review is no-op, stale expectedCurrentReviewId throws 409', async () => {
    const created = await withTx(ctx.appDb, (tx) =>
      createDocumentWithInitialVersion(tx, {
        type: 'invoice',
        title: 'Invoice 1',
        storageKey: `pdfs/sha256/${HEX64_1}.pdf`,
        fileSha256: HEX64_1,
        fileSizeBytes: 512,
        originalFilename: 'v1.pdf',
      }),
    );
    const run = await withTx(ctx.appDb, (tx) => claimVersion(tx, created.version.id, 'w1'));
    await withTx(ctx.appDb, (tx) =>
      saveParsedText(tx, created.version.id, run!.runId, {
        parsedText: 'Meridian LLC\nTotal: $5,230.29',
        parsedTextSha256: HEX64_2,
        parser: 'lines/1',
        pageOffsets: [0],
        textRanges: { hidden: [], lowVisibility: [] },
        warnings: [],
      }),
    );

    const fin = await withTx(ctx.appDb, (tx) =>
      finalizeRun(tx, created.version.id, run!.runId, {
        warnings: [],
        chunked: false,
        llmCallCount: 1,
        reusedCallCount: 0,
        costUsd: '0.001000',
        values: [
          {
            fieldKey: 'vendor_name',
            fieldType: 'string',
            kind: 'value',
            value: 'Meridian LLC',
            rawValue: 'Meridian LLC',
            evidence: 'Meridian LLC',
            canonicalEvidence: 'Meridian LLC',
            evidenceStart: 0,
            evidenceEnd: 12,
            evidenceMatchCount: 1,
            citedLine: 1,
            matchMode: 'strict',
            flags: [],
            changeKind: 'new',
          },
          {
            fieldKey: 'total_amount',
            fieldType: 'money',
            kind: 'value',
            value: { amount: '5230.29', currency: 'USD' },
            rawValue: '$5,230.29',
            evidence: 'Total: $5,230.29',
            canonicalEvidence: 'Total: $5,230.29',
            evidenceStart: 13,
            evidenceEnd: 29,
            evidenceMatchCount: 1,
            citedLine: 2,
            matchMode: 'strict',
            flags: [],
            changeKind: 'new',
          },
        ],
      }),
    );

    expect(fin).toMatchObject({ ok: true, pointerMoved: true, pendingCount: 2, insertedCount: 2 });

    const vals = await ctx.appPool.query<{ id: string; field_key: string }>(
      `SELECT id, field_key FROM extracted_values WHERE version_id = $1 ORDER BY field_key`,
      [created.version.id],
    );
    const totalValId = vals.rows.find((r) => r.field_key === 'total_amount')!.id;

    // 1. Pending -> approve: delta = -1, pending = 1
    const r1 = await withTx(ctx.appDb, (tx) =>
      insertReview(tx, totalValId, { decision: 'approve', note: 'Verified' }, 'req-1'),
    );
    expect(r1.delta).toBe(-1);
    expect(r1.noop).toBe(false);
    expect(r1.progress.pending).toBe(1);
    expect(r1.progress.approved).toBe(1);

    // 2. Identical review -> no-op, delta = 0, no new review row
    const r2 = await withTx(ctx.appDb, (tx) =>
      insertReview(tx, totalValId, { decision: 'approve', note: 'Verified' }, 'req-2'),
    );
    expect(r2.noop).toBe(true);
    expect(r2.delta).toBe(0);
    expect(r2.review.id).toBe(r1.review.id);

    // 3. Stale expectedCurrentReviewId -> 409 REVIEW_CONFLICT
    await expect(
      withTx(ctx.appDb, (tx) =>
        insertReview(
          tx,
          totalValId,
          {
            decision: 'correct',
            correctedValue: { amount: '5200', currency: 'USD' },
            expectedCurrentReviewId: null,
          },
          'req-3',
        ),
      ),
    ).rejects.toMatchObject({ code: 'REVIEW_CONFLICT' });

    // 4. Re-decide (approved -> corrected with matching expectedCurrentReviewId) -> delta = 0
    const r3 = await withTx(ctx.appDb, (tx) =>
      insertReview(
        tx,
        totalValId,
        {
          decision: 'correct',
          correctedValue: { amount: '5200', currency: 'USD' },
          expectedCurrentReviewId: r1.review.id,
        },
        'req-4',
      ),
    );
    expect(r3.delta).toBe(0);
    expect(r3.noop).toBe(false);
    expect(r3.progress.pending).toBe(1);
    expect(r3.progress.corrected).toBe(1);
    expect(r3.progress.approved).toBe(0);

    // Verify documents.pending_count matches recomputed progress.pending
    const docRow = await ctx.appPool.query<{ pending_count: number }>(
      `SELECT pending_count FROM documents WHERE id = $1`,
      [created.document.id],
    );
    expect(docRow.rows[0]?.pending_count).toBe(1);

    // Review history is append-only (2 rows, ordered newest first)
    const history = await withTx(ctx.appDb, (tx) =>
      listReviewsForValue(tx, totalValId, { limit: 10 }),
    );
    expect(history.data.map((r) => r.id)).toEqual([r3.review.id, r1.review.id]);
  });

  it('forward keyset pagination visits every alive document once and rejects cursor mismatch / invalid cursor', async () => {
    const ids: string[] = [];
    for (let i = 1; i <= 5; i++) {
      const c = await withTx(ctx.appDb, (tx) =>
        createDocumentWithInitialVersion(tx, {
          type: 'invoice',
          title: `Doc ${i}`,
          storageKey: `pdfs/sha256/${HEX64_1}.pdf`,
          fileSha256: HEX64_1,
          fileSizeBytes: 100,
          originalFilename: `d${i}.pdf`,
        }),
      );
      ids.push(c.document.id);
    }

    const p1 = await withTx(ctx.appDb, (tx) => listAliveDocuments(tx, { limit: 2 }));
    expect(p1.data).toHaveLength(2);
    expect(p1.page.hasMore).toBe(true);
    expect(p1.page.nextCursor).toBeTruthy();

    const p2 = await withTx(ctx.appDb, (tx) =>
      listAliveDocuments(tx, { limit: 2, cursor: p1.page.nextCursor! }),
    );
    const p3 = await withTx(ctx.appDb, (tx) =>
      listAliveDocuments(tx, { limit: 2, cursor: p2.page.nextCursor! }),
    );
    expect(p3.data).toHaveLength(1);
    expect(p3.page.hasMore).toBe(false);
    expect(p3.page.nextCursor).toBeNull();

    const collected = [...p1.data, ...p2.data, ...p3.data].map((d) => d.id);
    expect(new Set(collected).size).toBe(5);
    expect(collected).toEqual([...ids].reverse());

    // Cursor mismatch when filter changes
    await expect(
      withTx(ctx.appDb, (tx) =>
        listAliveDocuments(tx, { limit: 2, type: 'invoice', cursor: p1.page.nextCursor! }),
      ),
    ).rejects.toMatchObject({ code: 'CURSOR_MISMATCH' });

    // Invalid cursor / non-UUID key
    expect(() => decodeCursor('not-valid-base64!!!', '')).toThrow(DbRepoError);
    const badUuidCursor = encodeCursor({ v: 1, k: 'not-a-uuid', d: 'next', f: '' });
    await expect(
      withTx(ctx.appDb, (tx) => listAliveDocuments(tx, { limit: 2, cursor: badUuidCursor })),
    ).rejects.toMatchObject({ code: 'INVALID_CURSOR' });

    // Direct toPage sanity check
    const page = toPage([{ id: 'a' }, { id: 'b' }, { id: 'c' }], 2, (r) => r.id, 'fp');
    expect(page.data).toHaveLength(2);
    expect(page.page.hasMore).toBe(true);

    // Long externalId filter (128 chars) produces a valid cursor under 128-char schema limit
    const longExternalId = 'e'.repeat(128);
    await withTx(ctx.appDb, (tx) =>
      createDocumentWithInitialVersion(tx, {
        externalId: longExternalId,
        type: 'invoice',
        title: 'Long ext',
        storageKey: `pdfs/sha256/${HEX64_1}.pdf`,
        fileSha256: HEX64_1,
        fileSizeBytes: 100,
        originalFilename: 'long.pdf',
      }),
    );
    const longPage = await withReadOnlyTx(ctx.appDb, (tx) =>
      listAliveDocuments(tx, {
        limit: 1,
        externalId: longExternalId,
        type: 'invoice',
        needsReview: false,
        status: 'queued',
      }),
    );
    expect(longPage.data).toHaveLength(1);

    // > INT4_MAX integer cursor rejected with 400 INVALID_CURSOR (not Postgres 500)
    const overflowCursor = encodeCursor({ v: 1, k: '2147483648', d: 'next', f: '' });
    await expect(
      withReadOnlyTx(ctx.appDb, (tx) => listVersions(tx, ids[0]!, { cursor: overflowCursor })),
    ).rejects.toMatchObject({ code: 'INVALID_CURSOR' });

    // Facets and document types listing
    const facets = await withReadOnlyTx(ctx.appDb, (tx) => countNeedsReviewFacets(tx));
    expect(facets).toEqual({ count: 0, capped: false });

    const typesPage = await withReadOnlyTx(ctx.appDb, (tx) => listDocumentTypesWithTemplates(tx));
    expect(typesPage.data).toHaveLength(1);
    expect(typesPage.data[0]?.key).toBe('invoice');
    expect(typesPage.data[0]?.template.fields).toHaveLength(2);
  });

  it('[R4] db.finalize-twice-noop, carried reviews, gaps, out-of-order pointer, fencing, and full review lifecycle', async () => {
    const created = await withTx(ctx.appDb, (tx) =>
      createDocumentWithInitialVersion(tx, {
        type: 'invoice',
        title: 'Invoice V1/V2',
        storageKey: `pdfs/sha256/${HEX64_1}.pdf`,
        fileSha256: HEX64_1,
        fileSizeBytes: 512,
        originalFilename: 'v1.pdf',
      }),
    );
    const v2Created = await withTx(ctx.appDb, (tx) =>
      createNewVersion(tx, created.document.id, {
        storageKey: `pdfs/sha256/${HEX64_2}.pdf`,
        fileSha256: HEX64_2,
        fileSizeBytes: 512,
        originalFilename: 'v2.pdf',
      }),
    );

    // Claim both v1 and v2, parse both
    const run1 = await withTx(ctx.appDb, (tx) => claimVersion(tx, created.version.id, 'w1'));
    const run2 = await withTx(ctx.appDb, (tx) => claimVersion(tx, v2Created.version.id, 'w2'));
    for (const [verId, rId] of [
      [created.version.id, run1!.runId],
      [v2Created.version.id, run2!.runId],
    ] as const) {
      await withTx(ctx.appDb, (tx) =>
        saveParsedText(tx, verId, rId, {
          parsedText: 'acme corp\nTotal: $100.00',
          parsedTextSha256: HEX64_2,
          parser: 'lines/1',
          pageOffsets: [0],
          textRanges: { hidden: [], lowVisibility: [] },
          warnings: [],
        }),
      );
    }

    // Stale runId finalize fails safely
    const fencedFin = await withTx(ctx.appDb, (tx) =>
      finalizeRun(tx, v2Created.version.id, run1!.runId, {
        warnings: [],
        chunked: false,
        llmCallCount: 1,
        reusedCallCount: 0,
        costUsd: '0.001000',
        values: [],
      }),
    );
    expect(fencedFin).toEqual({ ok: false, reason: 'fenced' });

    // Finalize v2 FIRST (with 1 value + 1 gap with attemptedQuote) -> pointer moves to v2, pendingCount = 2
    const fin2 = await withTx(ctx.appDb, (tx) =>
      finalizeRun(tx, v2Created.version.id, run2!.runId, {
        warnings: [],
        chunked: false,
        llmCallCount: 1,
        reusedCallCount: 0,
        costUsd: '0.001000',
        values: [
          {
            fieldKey: 'vendor_name',
            fieldType: 'string',
            kind: 'value',
            value: 'acme corp',
            rawValue: 'acme corp',
            evidence: 'acme corp',
            canonicalEvidence: 'acme corp',
            evidenceStart: 0,
            evidenceEnd: 9,
            evidenceMatchCount: 1,
            citedLine: 1,
            matchMode: 'strict',
            flags: [],
            changeKind: 'new',
          },
          {
            fieldKey: 'total_amount',
            fieldType: 'money',
            kind: 'gap',
            attemptedQuote: '$999',
            gapCode: 'EVIDENCE_NOT_IN_TEXT',
            gapReason: 'Quote not found in text',
            flags: [],
            changeKind: 'new',
          },
        ],
      }),
    );
    expect(fin2).toEqual({ ok: true, pointerMoved: true, pendingCount: 2, insertedCount: 2 });

    // Finalizing v2 a second time returns fenced (already extracted)
    const fin2Again = await withTx(ctx.appDb, (tx) =>
      finalizeRun(tx, v2Created.version.id, run2!.runId, {
        warnings: [],
        chunked: false,
        llmCallCount: 1,
        reusedCallCount: 0,
        costUsd: '0.001000',
        values: [],
      }),
    );
    expect(fin2Again).toEqual({ ok: false, reason: 'fenced' });

    // Approve vendor_name on v2, then test string capitalization correction (MUST NOT be no-op!)
    const v2Vals = await withReadOnlyTx(ctx.appDb, (tx) =>
      listValuesForVersion(tx, v2Created.version.id),
    );
    const vendorVal = v2Vals.find((r) => r.value.fieldKey === 'vendor_name')!.value;

    const c1 = await withTx(ctx.appDb, (tx) =>
      insertReview(tx, vendorVal.id, { decision: 'correct', correctedValue: 'acme corp' }, 'r-1'),
    );
    expect(c1.delta).toBe(-1);
    expect(c1.noop).toBe(false);

    const c2 = await withTx(ctx.appDb, (tx) =>
      insertReview(tx, vendorVal.id, { decision: 'correct', correctedValue: 'Acme Corp' }, 'r-2'),
    );
    expect(c2.noop).toBe(false);
    expect(c2.delta).toBe(0);
    expect(c2.review.correctedValue).toBe('Acme Corp');

    // Missing correctedValue on 'correct' -> 422 INVALID_CORRECTION
    await expect(
      withTx(ctx.appDb, (tx) => insertReview(tx, vendorVal.id, { decision: 'correct' }, 'r-bad')),
    ).rejects.toMatchObject({ code: 'INVALID_CORRECTION' });

    // Revert -> delta = +1, pending back to 2; reverting again -> 409 NOTHING_TO_REVERT
    const rev = await withTx(ctx.appDb, (tx) =>
      insertReview(tx, vendorVal.id, { decision: 'revert' }, 'r-3'),
    );
    expect(rev.delta).toBe(1);
    expect(rev.progress.pending).toBe(2);

    await expect(
      withTx(ctx.appDb, (tx) => insertReview(tx, vendorVal.id, { decision: 'revert' }, 'r-4')),
    ).rejects.toMatchObject({ code: 'NOTHING_TO_REVERT' });

    // Re-approve so v2 has pendingCount = 1 before out-of-order v1 finishes
    const v2Approved = await withTx(ctx.appDb, (tx) =>
      insertReview(tx, vendorVal.id, { decision: 'approve' }, 'r-5'),
    );

    // Out-of-order v1 finishes AFTER v2 -> pointerMoved MUST be false and pendingCount stays 1
    const fin1 = await withTx(ctx.appDb, (tx) =>
      finalizeRun(tx, created.version.id, run1!.runId, {
        warnings: [],
        chunked: false,
        llmCallCount: 1,
        reusedCallCount: 0,
        costUsd: '0.001000',
        values: [
          {
            fieldKey: 'vendor_name',
            fieldType: 'string',
            kind: 'value',
            value: 'acme corp',
            rawValue: 'acme corp',
            evidence: 'acme corp',
            canonicalEvidence: 'acme corp',
            evidenceStart: 0,
            evidenceEnd: 9,
            evidenceMatchCount: 1,
            citedLine: 1,
            matchMode: 'strict',
            flags: [],
            changeKind: 'new',
          },
        ],
      }),
    );
    expect(fin1).toEqual({ ok: true, pointerMoved: false, pendingCount: 1, insertedCount: 1 });

    // Attempting to review non-reviewable v1 throws 409 VERSION_NOT_REVIEWABLE
    const v1Vals = await withReadOnlyTx(ctx.appDb, (tx) =>
      listValuesForVersion(tx, created.version.id),
    );
    await expect(
      withTx(ctx.appDb, (tx) =>
        insertReview(tx, v1Vals[0]!.value.id, { decision: 'approve' }, 'r-old'),
      ),
    ).rejects.toMatchObject({ code: 'VERSION_NOT_REVIEWABLE' });

    // Create v3 carrying v2's approved review -> carried_over count = 1, pending = 0; human approve over carried is NOT no-op and delta = 0
    const v3Created = await withTx(ctx.appDb, (tx) =>
      createNewVersion(tx, created.document.id, {
        storageKey: `pdfs/sha256/${HEX64_1}.pdf`,
        fileSha256: HEX64_1,
        fileSizeBytes: 512,
        originalFilename: 'v3.pdf',
      }),
    );
    const run3 = await withTx(ctx.appDb, (tx) => claimVersion(tx, v3Created.version.id, 'w3'));
    await withTx(ctx.appDb, (tx) =>
      saveParsedText(tx, v3Created.version.id, run3!.runId, {
        parsedText: 'acme corp',
        parsedTextSha256: HEX64_2,
        parser: 'lines/1',
        pageOffsets: [0],
        textRanges: { hidden: [], lowVisibility: [] },
        warnings: [],
      }),
    );
    const fin3 = await withTx(ctx.appDb, (tx) =>
      finalizeRun(tx, v3Created.version.id, run3!.runId, {
        warnings: [],
        chunked: false,
        llmCallCount: 1,
        reusedCallCount: 0,
        costUsd: '0.001000',
        values: [
          {
            fieldKey: 'vendor_name',
            fieldType: 'string',
            kind: 'value',
            value: 'acme corp',
            rawValue: 'acme corp',
            evidence: 'acme corp',
            canonicalEvidence: 'acme corp',
            evidenceStart: 0,
            evidenceEnd: 9,
            evidenceMatchCount: 1,
            citedLine: 1,
            matchMode: 'strict',
            flags: [],
            baselineValueId: vendorVal.id,
            changeKind: 'same',
            carriedReview: {
              decision: 'approve',
              carriedFromReviewId: v2Approved.review.id,
            },
          },
        ],
      }),
    );
    expect(fin3).toEqual({ ok: true, pointerMoved: true, pendingCount: 0, insertedCount: 1 });

    const v3Vals = await withReadOnlyTx(ctx.appDb, (tx) =>
      listValuesForVersion(tx, v3Created.version.id),
    );
    expect(v3Vals[0]?.currentReview?.origin).toBe('carried');

    const humanOverCarried = await withTx(ctx.appDb, (tx) =>
      insertReview(tx, v3Vals[0]!.value.id, { decision: 'approve' }, 'r-human'),
    );
    expect(humanOverCarried.noop).toBe(false);
    expect(humanOverCarried.delta).toBe(0);
    expect(humanOverCarried.progress.approved).toBe(1);
    expect(humanOverCarried.progress.carriedOver).toBe(0);

    // Soft-delete document -> finalizeRun returns document_deleted and insertReview throws 410 DOCUMENT_DELETED (precedence over 409)
    const v4Created = await withTx(ctx.appDb, (tx) =>
      createNewVersion(tx, created.document.id, {
        storageKey: `pdfs/sha256/${HEX64_2}.pdf`,
        fileSha256: HEX64_2,
        fileSizeBytes: 512,
        originalFilename: 'v4.pdf',
      }),
    );
    const run4 = await withTx(ctx.appDb, (tx) => claimVersion(tx, v4Created.version.id, 'w4'));
    await ctx.migratorPool.query(`UPDATE documents SET deleted_at = now() WHERE id = $1`, [
      created.document.id,
    ]);

    const delFin = await withTx(ctx.appDb, (tx) =>
      finalizeRun(tx, v4Created.version.id, run4!.runId, {
        warnings: [],
        chunked: false,
        llmCallCount: 0,
        reusedCallCount: 0,
        costUsd: '0',
        values: [],
      }),
    );
    expect(delFin).toEqual({ ok: false, reason: 'document_deleted' });

    await expect(
      withTx(ctx.appDb, (tx) =>
        insertReview(tx, v1Vals[0]!.value.id, { decision: 'approve' }, 'r-del'),
      ),
    ).rejects.toMatchObject({ code: 'DOCUMENT_DELETED' });
  });
});
