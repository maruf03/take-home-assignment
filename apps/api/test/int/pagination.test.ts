import { createHash } from 'node:crypto';
import {
  documentSummaryDtoSchema,
  documentTypeDtoSchema,
  valueViewDtoSchema,
} from '@app/contracts/dto';
import { pageSchema } from '@app/contracts/page';
import { problemDetailsSchema } from '@app/contracts/problems';
import {
  claimVersion,
  createDocumentWithInitialVersion,
  encodeCursor,
  finalizeRun,
  saveParsedText,
  withTx,
} from '@app/db';
import fc from 'fast-check';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createApiTestHarness,
  makeMinimalPdf,
  type ApiTestHarness,
} from '../helpers/api-harness.js';

describe('[I4] Forward pagination model and cursor validation', () => {
  let h: ApiTestHarness;

  beforeAll(async () => {
    h = await createApiTestHarness();
  });

  afterAll(async () => {
    await h.close();
  });

  beforeEach(async () => {
    await h.resetAndSeed();
  });

  async function seedInvoiceDoc(title: string): Promise<string> {
    const pdf = makeMinimalPdf(title);
    const sha = createHash('sha256').update(pdf).digest('hex');
    const { document } = await withTx(h.ctx.appDb, (tx) =>
      createDocumentWithInitialVersion(tx, {
        type: 'invoice',
        title,
        storageKey: `pdfs/sha256/${sha}.pdf`,
        fileSha256: sha,
        fileSizeBytes: pdf.length,
        originalFilename: `${title}.pdf`,
      }),
    );
    return document.id;
  }

  it('[I4] pagination.model (fc.commands): forward keyset paging has no duplicates or skips under concurrent inserts', async () => {
    interface Model {
      baselineIds: Set<string>;
      allIds: Set<string>;
      seenIds: string[];
      cursor: string | null;
      done: boolean;
      limit: number;
    }

    interface Real {
      seq: number;
    }

    class NextPageCmd implements fc.AsyncCommand<Model, Real> {
      check(m: Readonly<Model>): boolean {
        return !m.done;
      }

      async run(m: Model): Promise<void> {
        const qs = new URLSearchParams({ type: 'invoice', limit: String(m.limit) });
        if (m.cursor) qs.set('cursor', m.cursor);
        const res = await fetch(`${h.baseUrl}/documents?${qs.toString()}`);
        expect(res.status).toBe(200);
        const page = pageSchema(documentSummaryDtoSchema).parse(await res.json());

        // Every returned ID must be unique across the whole traversal and strictly descending.
        for (const doc of page.data) {
          expect(m.seenIds).not.toContain(doc.id);
          if (m.seenIds.length > 0) {
            expect(doc.id < m.seenIds.at(-1)!).toBe(true);
          }
          m.seenIds.push(doc.id);
        }

        const link = res.headers.get('link');
        if (page.page.hasMore) {
          expect(page.page.nextCursor).not.toBeNull();
          expect(link).toContain('rel="next"');
          expect(link).toContain(`cursor=${encodeURIComponent(page.page.nextCursor!)}`);
          m.cursor = page.page.nextCursor;
        } else {
          expect(page.page.nextCursor).toBeNull();
          if (link !== null) {
            expect(link).not.toContain('rel="next"');
          }
          m.done = true;
          // Every document that existed before traversal started MUST have appeared exactly once.
          for (const id of m.baselineIds) {
            expect(m.seenIds).toContain(id);
          }
        }
      }

      toString(): string {
        return 'NextPage';
      }
    }

    class InsertDocCmd implements fc.AsyncCommand<Model, Real> {
      check(): boolean {
        return true;
      }

      async run(m: Model, r: Real): Promise<void> {
        r.seq += 1;
        const id = await seedInvoiceDoc(`concurrent-doc-${r.seq}`);
        m.allIds.add(id);
      }

      toString(): string {
        return 'InsertDoc';
      }
    }

    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 3 }),
        fc.commands([fc.constant(new NextPageCmd()), fc.constant(new InsertDocCmd())], {
          maxCommands: 12,
        }),
        async (limit, cmds) => {
          await h.resetAndSeed();
          const baselineIds = new Set<string>();
          for (let i = 0; i < 4; i++) {
            baselineIds.add(await seedInvoiceDoc(`baseline-${i}`));
          }
          // Include the seeded invoice fixture in baseline
          const initialList = pageSchema(documentSummaryDtoSchema).parse(
            await (await fetch(`${h.baseUrl}/documents?type=invoice&limit=100`)).json(),
          );
          for (const d of initialList.data) baselineIds.add(d.id);

          const model: Model = {
            baselineIds,
            allIds: new Set(baselineIds),
            seenIds: [],
            cursor: null,
            done: false,
            limit,
          };
          const real: Real = { seq: 0 };

          await fc.asyncModelRun(() => ({ model, real }), cmds);

          // Drain remaining pages to verify completeness invariant at the end of every run.
          while (!model.done) {
            await new NextPageCmd().run(model);
          }
        },
      ),
      { numRuns: 10 },
    );
  });

  it('[I4] pagination.cursor-mismatch, invalid UUID cursor, invalid limit, and invalid filter all return 400 problem+json', async () => {
    await seedInvoiceDoc('cursor-a');
    await seedInvoiceDoc('cursor-b');

    const firstRes = await fetch(`${h.baseUrl}/documents?type=invoice&limit=1`);
    expect(firstRes.status).toBe(200);
    const firstPage = pageSchema(documentSummaryDtoSchema).parse(await firstRes.json());
    expect(firstPage.page.nextCursor).not.toBeNull();
    const cursor = firstPage.page.nextCursor!;

    // Cursor mismatch: different filter value
    const mismatchRes = await fetch(
      `${h.baseUrl}/documents?type=lease&limit=1&cursor=${encodeURIComponent(cursor)}`,
    );
    expect(mismatchRes.status).toBe(400);
    expect(mismatchRes.headers.get('content-type')).toContain('application/problem+json');
    expect(problemDetailsSchema.parse(await mismatchRes.json()).code).toBe('CURSOR_MISMATCH');

    // Invalid UUID inside structurally valid cursor payload -> 400 INVALID_CURSOR
    const badUuidCursor = encodeCursor({ v: 1, k: 'not-a-valid-uuid', d: 'next', f: '' });
    const badUuidRes = await fetch(
      `${h.baseUrl}/documents?cursor=${encodeURIComponent(badUuidCursor)}`,
    );
    expect(badUuidRes.status).toBe(400);
    expect(problemDetailsSchema.parse(await badUuidRes.json()).code).toBe('INVALID_CURSOR');

    // Non-base64url garbage cursor -> 400 INVALID_CURSOR
    const garbageRes = await fetch(`${h.baseUrl}/documents?cursor=!!!not-base64!!!`);
    expect(garbageRes.status).toBe(400);
    expect(problemDetailsSchema.parse(await garbageRes.json()).code).toBe('INVALID_CURSOR');

    // Out-of-range limit -> 400 INVALID_LIMIT
    const badLimitRes = await fetch(`${h.baseUrl}/documents?limit=101`);
    expect(badLimitRes.status).toBe(400);
    expect(problemDetailsSchema.parse(await badLimitRes.json()).code).toBe('INVALID_LIMIT');

    // Unknown filter param -> 400 INVALID_FILTER
    const unknownFilterRes = await fetch(`${h.baseUrl}/documents?bogus=1`);
    expect(unknownFilterRes.status).toBe(400);
    expect(problemDetailsSchema.parse(await unknownFilterRes.json()).code).toBe('INVALID_FILTER');
  });

  it('paginates GET /document-types and GET /documents/:id/versions/:n/values with filters', async () => {
    // GET /document-types forward pagination
    const dt1Res = await fetch(`${h.baseUrl}/document-types?limit=2`);
    expect(dt1Res.status).toBe(200);
    const dt1 = pageSchema(documentTypeDtoSchema).parse(await dt1Res.json());
    expect(dt1.data).toHaveLength(2);
    expect(dt1.page.hasMore).toBe(true);
    expect(dt1.page.nextCursor).not.toBeNull();

    const dt2Res = await fetch(
      `${h.baseUrl}/document-types?limit=2&cursor=${encodeURIComponent(dt1.page.nextCursor!)}`,
    );
    expect(dt2Res.status).toBe(200);
    const dt2 = pageSchema(documentTypeDtoSchema).parse(await dt2Res.json());
    expect(dt2.data).toHaveLength(1);
    expect(dt2.page.hasMore).toBe(false);
    expect([...dt1.data, ...dt2.data].map((t) => t.key)).toEqual([
      'invoice',
      'lease',
      'market_report',
    ]);

    // GET /documents/:id/versions/:n/values ordered by position ASC with cursor + attention filter
    const pdf = makeMinimalPdf('values-paging');
    const sha = createHash('sha256').update(pdf).digest('hex');
    const { document, version } = await withTx(h.ctx.appDb, (tx) =>
      createDocumentWithInitialVersion(tx, {
        type: 'invoice',
        title: 'Values Paging',
        storageKey: `pdfs/sha256/${sha}.pdf`,
        fileSha256: sha,
        fileSizeBytes: pdf.length,
        originalFilename: 'values.pdf',
      }),
    );
    const claim = await withTx(h.ctx.appDb, (tx) =>
      claimVersion(tx, version.id, 'w-val', { leaseSeconds: 30 }),
    );
    if (!claim) throw new Error('expected claim');
    const parsedText = 'Invoice Number: INV-1\nVendor: Acme\n';
    await withTx(h.ctx.appDb, (tx) =>
      saveParsedText(tx, version.id, claim.runId, {
        parsedText,
        parsedTextSha256: createHash('sha256').update(parsedText).digest('hex'),
        parser: 'pdfjs-test',
        pageOffsets: [0],
        textRanges: { hidden: [], lowVisibility: [] },
        warnings: [],
      }),
    );
    await withTx(h.ctx.appDb, (tx) =>
      finalizeRun(tx, version.id, claim.runId, {
        warnings: [],
        chunked: false,
        llmCallCount: 1,
        reusedCallCount: 0,
        costUsd: '0.001',
        values: [
          {
            fieldKey: 'invoice_number',
            fieldType: 'string',
            kind: 'value',
            value: 'INV-1',
            evidence: 'Invoice Number: INV-1',
            canonicalEvidence: 'invoice number: inv-1',
            evidenceStart: 0,
            evidenceEnd: 21,
            evidenceMatchCount: 1,
            citedLine: 1,
            matchMode: 'strict',
            changeKind: 'new',
          },
          {
            fieldKey: 'vendor_name',
            fieldType: 'string',
            kind: 'value',
            value: 'Acme',
            evidence: 'Vendor: Acme',
            canonicalEvidence: 'vendor: acme',
            evidenceStart: 22,
            evidenceEnd: 34,
            evidenceMatchCount: 1,
            citedLine: 2,
            matchMode: 'strict',
            changeKind: 'new',
          },
          {
            fieldKey: 'due_date',
            fieldType: 'date',
            kind: 'gap',
            value: null,
            gapCode: 'NOT_FOUND',
            gapReason: 'Missing due date',
            changeKind: 'new',
          },
        ],
      }),
    );

    const vPage1Res = await fetch(
      `${h.baseUrl}/documents/${document.id}/versions/1/values?limit=2`,
    );
    expect(vPage1Res.status).toBe(200);
    const vPage1 = pageSchema(valueViewDtoSchema).parse(await vPage1Res.json());
    expect(vPage1.data).toHaveLength(2);
    expect(vPage1.data[0]!.position).toBeLessThan(vPage1.data[1]!.position);
    expect(vPage1.page.hasMore).toBe(true);

    const vPage2Res = await fetch(
      `${h.baseUrl}/documents/${document.id}/versions/1/values?limit=2&cursor=${encodeURIComponent(vPage1.page.nextCursor!)}`,
    );
    expect(vPage2Res.status).toBe(200);
    const vPage2 = pageSchema(valueViewDtoSchema).parse(await vPage2Res.json());
    expect(vPage2.data).toHaveLength(1);
    expect(vPage2.page.hasMore).toBe(false);

    const gapOnlyRes = await fetch(
      `${h.baseUrl}/documents/${document.id}/versions/1/values?attention=gap`,
    );
    expect(gapOnlyRes.status).toBe(200);
    const gapOnly = pageSchema(valueViewDtoSchema).parse(await gapOnlyRes.json());
    expect(gapOnly.data.map((v) => v.fieldKey)).toEqual(['due_date']);

    // [I4] Bidirectional prevCursor + Link: rel="prev" symmetry on /documents/:id/versions/1/values
    expect(vPage1.page.prevCursor).toBeNull();
    expect(vPage2.page.prevCursor).not.toBeNull();
    expect(vPage2Res.headers.get('link')).toContain('rel="prev"');
    const backRes = await fetch(
      `${h.baseUrl}/documents/${document.id}/versions/1/values?limit=2&cursor=${encodeURIComponent(vPage2.page.prevCursor!)}`,
    );
    expect(backRes.status).toBe(200);
    const backPage = pageSchema(valueViewDtoSchema).parse(await backRes.json());
    expect(backPage.data.map((v) => v.id)).toEqual(vPage1.data.map((v) => v.id));
    expect(backPage.page.prevCursor).toBeNull();
    expect(backPage.page.hasMore).toBe(true);
    expect(backRes.headers.get('link')).toContain('rel="next"');
  });
});
