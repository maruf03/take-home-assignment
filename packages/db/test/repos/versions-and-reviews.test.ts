import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DbRepoError, withTx } from '../../src/client.js';
import { createDocumentWithInitialVersion, listAliveDocuments } from '../../src/repos/documents.js';
import { decodeCursor, encodeCursor, toPage } from '../../src/repos/keyset.js';
import { insertReview, listReviewsForValue } from '../../src/repos/reviews.js';
import { claimVersion, failRun } from '../../src/repos/runs.js';
import { finalizeRun } from '../../src/repos/values.js';
import { createNewVersion, saveParsedText } from '../../src/repos/versions.js';
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
  });
});
