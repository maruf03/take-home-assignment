import { createHash } from 'node:crypto';
import {
  documentDetailDtoSchema,
  documentSummaryDtoSchema,
  documentsFacetsDtoSchema,
  createVersionResponseDtoSchema,
  progressSchema,
  reviewDtoSchema,
  reviewResponseDtoSchema,
  valueViewDtoSchema,
  versionDetailDtoSchema,
  versionSummaryDtoSchema,
} from '@app/contracts/dto';
import { pageSchema } from '@app/contracts/page';
import { problemDetailsSchema } from '@app/contracts/problems';
import {
  claimVersion,
  createDocumentWithInitialVersion,
  failRun,
  finalizeRun,
  getBaselineExtractedVersion,
  getLatestTemplateForType,
  getTemplateWithFields,
  listValuesForVersion,
  saveParsedText,
  seedDatabase,
  withTx,
} from '@app/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createApiTestHarness,
  FIXTURES_DIR,
  HINTS_PATH,
  makeMinimalPdf,
  postMultipart,
  readFixturePdf,
  type ApiTestHarness,
} from '../helpers/api-harness.js';

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

describe('API Core Task 9 integration: upload, documents, versions, values, review, progress', () => {
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

  async function extractInvoiceVersion(
    versionId: string,
    opts: {
      vendor: string;
      total: string;
      parsedText: string;
      carryFromPrevious?: boolean;
    },
  ): Promise<void> {
    const claim = await withTx(h.ctx.appDb, (tx) =>
      claimVersion(tx, versionId, 'test-w1', { leaseSeconds: 30, trigger: 'upload' }),
    );
    expect(claim).not.toBeNull();
    if (!claim) throw new Error('expected claim');

    await withTx(h.ctx.appDb, (tx) =>
      saveParsedText(tx, versionId, claim.runId, {
        parsedText: opts.parsedText,
        parsedTextSha256: sha256(opts.parsedText),
        parser: 'pdfjs-test',
        pageOffsets: [0],
        textRanges: { hidden: [], lowVisibility: [] },
        warnings: [],
      }),
    );

    const vendorQuote = `Vendor: ${opts.vendor}`;
    const vendorStart = opts.parsedText.indexOf(vendorQuote);
    const totalQuote = `Total: $${opts.total}`;
    const totalStart = opts.parsedText.indexOf(totalQuote);

    await withTx(h.ctx.appDb, (tx) =>
      finalizeRun(tx, versionId, claim.runId, {
        warnings: [],
        chunked: false,
        llmCallCount: 1,
        reusedCallCount: 0,
        costUsd: '0.001',
        buildValues: async ({ tx: ftx, document, version }) => {
          const baselineVer = await getBaselineExtractedVersion(
            ftx,
            document.id,
            version.versionNumber,
          );
          const baselineList = baselineVer ? await listValuesForVersion(ftx, baselineVer.id) : [];
          const baselineValues = new Map(baselineList.map((row) => [row.value.fieldKey, row]));
          const prevVendor = baselineValues.get('vendor_name');
          const prevTotal = baselineValues.get('total_amount');
          const vendorSame =
            prevVendor?.value.kind === 'value' && prevVendor.value.value === opts.vendor;
          const totalSame =
            prevTotal?.value.kind === 'value' &&
            typeof prevTotal.value.value === 'object' &&
            prevTotal.value.value !== null &&
            (prevTotal.value.value as { amount?: string }).amount === opts.total;

          return [
            {
              fieldKey: 'vendor_name',
              fieldType: 'string',
              kind: 'value',
              value: opts.vendor,
              rawValue: opts.vendor,
              evidence: vendorQuote,
              canonicalEvidence: vendorQuote.toLowerCase(),
              evidenceStart: vendorStart,
              evidenceEnd: vendorStart + vendorQuote.length,
              evidenceMatchCount: 1,
              citedLine: 1,
              matchMode: 'strict',
              baselineValueId: prevVendor?.value.id ?? null,
              changeKind: prevVendor ? (vendorSame ? 'same' : 'changed') : 'new',
              changeReason: prevVendor && !vendorSame ? 'VALUE_CHANGED' : null,
              carriedReview:
                opts.carryFromPrevious &&
                vendorSame &&
                prevVendor?.currentReview &&
                prevVendor.currentReview.decision !== 'revert'
                  ? {
                      decision: prevVendor.currentReview.decision as 'approve' | 'correct',
                      correctedValue: (prevVendor.currentReview.correctedValue as string) ?? null,
                      note: prevVendor.currentReview.note,
                      carriedFromReviewId: prevVendor.currentReview.id,
                    }
                  : null,
            },
            {
              fieldKey: 'total_amount',
              fieldType: 'money',
              kind: 'value',
              value: { amount: opts.total, currency: 'USD' },
              rawValue: `$${opts.total}`,
              evidence: totalQuote,
              canonicalEvidence: totalQuote.toLowerCase(),
              evidenceStart: totalStart,
              evidenceEnd: totalStart + totalQuote.length,
              evidenceMatchCount: 1,
              citedLine: 2,
              matchMode: 'strict',
              baselineValueId: prevTotal?.value.id ?? null,
              changeKind: prevTotal ? (totalSame ? 'same' : 'changed') : 'new',
              changeReason: prevTotal && !totalSame ? 'VALUE_CHANGED' : null,
            },
            {
              fieldKey: 'invoice_number',
              fieldType: 'string',
              kind: 'gap',
              value: null,
              gapCode: 'NOT_FOUND',
              gapReason: 'Invoice number omitted from excerpt',
              attemptedQuote: null,
              baselineValueId: baselineValues.get('invoice_number')?.value.id ?? null,
              changeKind: baselineValues.has('invoice_number') ? 'same' : 'new',
              changeReason: null,
            },
          ];
        },
      }),
    );
  }

  it('[R1] api.upload.returns-before-llm returns 201 in <300ms with queued status and Location header', async () => {
    const pdf = await readFixturePdf('invoice-001.pdf');
    // LLM is completely latched (no worker running); upload must never wait for parse or LLM.
    const started = performance.now();
    const res = await postMultipart(`${h.baseUrl}/documents`, {
      file: { buffer: pdf, filename: 'invoice-001.pdf' },
      fields: { type: 'invoice', title: 'Fast Upload Invoice' },
      headers: { 'x-request-id': 'req-r1-fast' },
    });
    const elapsedMs = performance.now() - started;

    expect(res.status).toBe(201);
    expect(elapsedMs).toBeLessThan(300);
    expect(res.headers.get('x-request-id')).toBe('req-r1-fast');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');

    const body = documentDetailDtoSchema.parse(await res.json());
    expect(res.headers.get('location')).toBe(`/documents/${body.id}`);
    expect(body.status).toBe('queued');
    expect(body.currentVersion.status).toBe('queued');
    expect(body.valuesVersion).toBeNull();
    expect(body.valuesTextMeta).toBeNull();
    expect(body.title).toBe('Fast Upload Invoice');
    expect(h.enqueuer.calls).toHaveLength(1);
    expect(h.enqueuer.calls[0]!.options.trigger).toBe('upload');
    expect(h.enqueuer.calls[0]!.options.correlationId).toBe('req-r1-fast');
  });

  it('truncates a 255-character filename to a 200-character title while preserving the 255-character originalFilename', async () => {
    const pdf = makeMinimalPdf('long-filename');
    const filename255 = `${'x'.repeat(251)}.pdf`;
    expect(filename255).toHaveLength(255);

    const res = await postMultipart(`${h.baseUrl}/documents`, {
      file: { buffer: pdf, filename: filename255 },
      fields: { type: 'invoice' },
    });
    expect(res.status).toBe(201);
    const doc = documentDetailDtoSchema.parse(await res.json());
    expect(doc.title).toHaveLength(200);
    expect(doc.title).toBe('x'.repeat(200));

    const v1Res = await fetch(`${h.baseUrl}/documents/${doc.id}/versions/1`);
    expect(v1Res.status).toBe(200);
    const v1 = versionDetailDtoSchema.parse(await v1Res.json());
    expect(v1.file.originalFilename).toBe(filename255);
    expect(v1.file.originalFilename).toHaveLength(255);
  });

  it('[R8] api.detail.previous, [R10] api.version-history-after-v2 & api.v1-values-readonly, and [R12] api.progress.disjoint-sum', async () => {
    const pdf1 = await readFixturePdf('invoice-001.pdf');
    const pdf2 = await readFixturePdf('invoice-001.v2.pdf');

    // 1. Upload v1 and extract it
    const createRes = await postMultipart(`${h.baseUrl}/documents`, {
      file: { buffer: pdf1, filename: 'invoice-001.pdf' },
      fields: { type: 'invoice', title: 'Meridian Invoice' },
    });
    expect(createRes.status).toBe(201);
    const created = documentDetailDtoSchema.parse(await createRes.json());
    const v1Id = h.enqueuer.calls[0]!.versionId;

    await extractInvoiceVersion(v1Id, {
      vendor: 'Meridian Office Supplies',
      total: '5230.29',
      parsedText: 'Vendor: Meridian Office Supplies\nTotal: $5230.29\n',
    });

    // GET /documents/:id includes valuesTextMeta and sorted values (gap -> pending)
    const detail1Res = await fetch(`${h.baseUrl}/documents/${created.id}`);
    expect(detail1Res.status).toBe(200);
    expect(detail1Res.headers.get('cache-control')).toBe('no-cache');
    expect(detail1Res.headers.get('etag')).toBeTruthy();
    const detail1 = documentDetailDtoSchema.parse(await detail1Res.json());
    expect(detail1.valuesVersion).toBe(1);
    expect(detail1.valuesTextMeta).toEqual({
      textRanges: { hidden: [], lowVisibility: [] },
      pageOffsets: [0],
    });
    expect(detail1.progress).toEqual({
      versionNumber: 1,
      pending: 3,
      approved: 0,
      corrected: 0,
      carriedOver: 0,
      total: 3,
      gaps: 1,
    });
    expect(detail1.values[0]!.attention).toBe('gap');

    // Approve vendor_name and correct total_amount on v1
    const v1Vendor = detail1.values.find((v) => v.fieldKey === 'vendor_name')!;
    const v1Total = detail1.values.find((v) => v.fieldKey === 'total_amount')!;

    const approveRes = await fetch(`${h.baseUrl}/values/${v1Vendor.id}/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'approve', note: 'Verified on letterhead' }),
    });
    expect(approveRes.status).toBe(201);
    const approveBody = reviewResponseDtoSchema.parse(await approveRes.json());
    expect(approveBody.value.reviewState).toBe('approved');
    expect(approveBody.progress.approved).toBe(1);
    expect(approveBody.progress.pending).toBe(2);

    // Identical repeat is 200 noop: true
    const noopRes = await fetch(`${h.baseUrl}/values/${v1Vendor.id}/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'approve', note: 'Verified on letterhead' }),
    });
    expect(noopRes.status).toBe(200);
    const noopBody = reviewResponseDtoSchema.parse(await noopRes.json());
    expect(noopBody.noop).toBe(true);

    // Correct total_amount with uncanonicalized amount ("$5,250.00") -> canonicalized to { amount: "5250", currency: "USD" }
    const correctRes = await fetch(`${h.baseUrl}/values/${v1Total.id}/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        decision: 'correct',
        correctedValue: { amount: '5,250.00', currency: 'USD' },
        note: 'Discount applied',
      }),
    });
    expect(correctRes.status).toBe(201);
    const correctBody = reviewResponseDtoSchema.parse(await correctRes.json());
    expect(correctBody.value.effectiveValue).toEqual({ amount: '5250', currency: 'USD' });
    expect(correctBody.progress).toEqual({
      versionNumber: 1,
      pending: 1,
      approved: 1,
      corrected: 1,
      carriedOver: 0,
      total: 3,
      gaps: 1,
    });

    // Stale expectedCurrentReviewId -> 409 REVIEW_CONFLICT with details.currentValue
    const conflictRes = await fetch(`${h.baseUrl}/values/${v1Total.id}/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'approve', expectedCurrentReviewId: null }),
    });
    expect(conflictRes.status).toBe(409);
    const conflictProb = problemDetailsSchema.parse(await conflictRes.json());
    expect(conflictProb.code).toBe('REVIEW_CONFLICT');
    const currentFromConflict = valueViewDtoSchema.parse(conflictProb.details?.['currentValue']);
    expect(currentFromConflict.review?.id).toBe(correctBody.value.review?.id);

    // Revert is not in Core -> 400 VALIDATION_FAILED
    const revertRes = await fetch(`${h.baseUrl}/values/${v1Total.id}/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'revert' }),
    });
    expect(revertRes.status).toBe(400);
    expect(problemDetailsSchema.parse(await revertRes.json()).code).toBe('VALIDATION_FAILED');

    // Invalid correction -> 422 INVALID_CORRECTION
    const badCorrRes = await fetch(`${h.baseUrl}/values/${v1Total.id}/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        decision: 'correct',
        correctedValue: { amount: 'not-a-number', currency: 'USD' },
      }),
    });
    expect(badCorrRes.status).toBe(422);
    const badCorrProb = problemDetailsSchema.parse(await badCorrRes.json());
    expect(badCorrProb.code).toBe('INVALID_CORRECTION');
    expect(badCorrProb.errors?.length).toBeGreaterThan(0);

    // 2. Upload v2 and extract with vendor carried over and total changed
    const v2UploadRes = await postMultipart(`${h.baseUrl}/documents/${created.id}/versions`, {
      file: { buffer: pdf2, filename: 'invoice-001.v2.pdf' },
    });
    expect(v2UploadRes.status).toBe(201);
    expect(v2UploadRes.headers.get('location')).toBe(`/documents/${created.id}/versions/2`);
    const v2UploadBody = createVersionResponseDtoSchema.parse(await v2UploadRes.json());
    expect(v2UploadBody.version.number).toBe(2);
    const v2Id = h.enqueuer.calls[1]!.versionId;

    await extractInvoiceVersion(v2Id, {
      vendor: 'Meridian Office Supplies',
      total: '5999.99',
      parsedText: 'Vendor: Meridian Office Supplies\nTotal: $5999.99\n',
      carryFromPrevious: true,
    });

    // [R8] api.detail.previous: changed total_amount carries previous value + previous human correction,
    // and carried vendor_name carries review.carriedFromVersion === 1!
    const detail2Res = await fetch(`${h.baseUrl}/documents/${created.id}`);
    expect(detail2Res.status).toBe(200);
    const detail2 = documentDetailDtoSchema.parse(await detail2Res.json());
    expect(detail2.valuesVersion).toBe(2);
    expect(detail2.versionsCount).toBe(2);
    expect(detail2.recentVersions.map((v) => v.number)).toEqual([2, 1]);

    // Attention sorting: changed (total_amount) -> gap (invoice_number) -> done (vendor_name)
    expect(detail2.values.map((v) => v.attention)).toEqual(['changed', 'gap', 'done']);

    const v2Total = detail2.values.find((v) => v.fieldKey === 'total_amount')!;
    expect(v2Total.changeKind).toBe('changed');
    expect(v2Total.changeReason).toBe('VALUE_CHANGED');
    expect(v2Total.previous).not.toBeNull();
    expect(v2Total.previous!.versionNumber).toBe(1);
    expect(v2Total.previous!.valueId).toBe(v1Total.id);
    expect(v2Total.previous!.value).toEqual({ amount: '5230.29', currency: 'USD' });
    expect(v2Total.previous!.effectiveValue).toEqual({ amount: '5250', currency: 'USD' });
    expect(v2Total.previous!.evidence).toEqual({ quote: 'Total: $5230.29', line: 2 });
    expect(v2Total.previous!.review?.decision).toBe('correct');

    const v2Vendor = detail2.values.find((v) => v.fieldKey === 'vendor_name')!;
    expect(v2Vendor.reviewState).toBe('carried_over');
    expect(v2Vendor.review?.origin).toBe('carried');
    expect(v2Vendor.review?.carriedFromVersion).toBe(1);

    // GET /values/:id/reviews also includes carriedFromVersion === 1
    const v2VendorReviewsRes = await fetch(`${h.baseUrl}/values/${v2Vendor.id}/reviews`);
    expect(v2VendorReviewsRes.status).toBe(200);
    const v2VendorReviews = pageSchema(reviewDtoSchema).parse(await v2VendorReviewsRes.json());
    expect(v2VendorReviews.data).toHaveLength(1);
    expect(v2VendorReviews.data[0]!.carriedFromVersion).toBe(1);

    // [R12] api.progress.disjoint-sum: pending + approved + corrected + carriedOver === total
    const progRes = await fetch(`${h.baseUrl}/documents/${created.id}/progress`);
    expect(progRes.status).toBe(200);
    const prog = progressSchema.parse(await progRes.json());
    expect(prog).toEqual({
      versionNumber: 2,
      pending: 2,
      approved: 0,
      corrected: 0,
      carriedOver: 1,
      total: 3,
      gaps: 1,
    });
    expect(prog.pending + prog.approved + prog.corrected + prog.carriedOver).toBe(prog.total);

    // [R10] api.version-history-after-v2 & api.v1-values-readonly
    const versionsListRes = await fetch(`${h.baseUrl}/documents/${created.id}/versions`);
    expect(versionsListRes.status).toBe(200);
    const versionsPage = pageSchema(versionSummaryDtoSchema).parse(await versionsListRes.json());
    expect(versionsPage.data.map((v) => v.number)).toEqual([2, 1]);
    expect(versionsPage.data[0]!.reviewable).toBe(true);
    expect(versionsPage.data[1]!.reviewable).toBe(false);

    const v1DetailRes = await fetch(`${h.baseUrl}/documents/${created.id}/versions/1`);
    expect(v1DetailRes.status).toBe(200);
    const v1Detail = versionDetailDtoSchema.parse(await v1DetailRes.json());
    expect(v1Detail.reviewable).toBe(false);
    expect(v1Detail.values.every((v) => v.reviewable === false)).toBe(true);

    // v1 text + ETag + 304
    const v1TextRes = await fetch(`${h.baseUrl}/documents/${created.id}/versions/1/text`);
    expect(v1TextRes.status).toBe(200);
    expect(v1TextRes.headers.get('content-type')).toContain('text/plain');
    expect(v1TextRes.headers.get('cache-control')).toBe('no-cache');
    const textEtag = v1TextRes.headers.get('etag')!;
    expect(textEtag).toMatch(/^"[0-9a-f]{64}"$/);
    expect(await v1TextRes.text()).toContain('5230.29');

    const v1Text304 = await fetch(`${h.baseUrl}/documents/${created.id}/versions/1/text`, {
      headers: { 'if-none-match': textEtag },
    });
    expect(v1Text304.status).toBe(304);

    // v1 file + security headers + ETag + 304
    const v1FileRes = await fetch(`${h.baseUrl}/documents/${created.id}/versions/1/file`);
    expect(v1FileRes.status).toBe(200);
    expect(v1FileRes.headers.get('content-type')).toBe('application/pdf');
    expect(v1FileRes.headers.get('content-disposition')).toContain('attachment');
    expect(v1FileRes.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'");
    expect(v1FileRes.headers.get('cross-origin-resource-policy')).toBe('same-origin');
    expect(v1FileRes.headers.get('x-content-type-options')).toBe('nosniff');
    const fileEtag = v1FileRes.headers.get('etag')!;
    expect(Buffer.from(await v1FileRes.arrayBuffer()).equals(pdf1)).toBe(true);

    const v1File304 = await fetch(`${h.baseUrl}/documents/${created.id}/versions/1/file`, {
      headers: { 'if-none-match': fileEtag },
    });
    expect(v1File304.status).toBe(304);

    // Reviewing v1 after v2 is reviewable returns 409 VERSION_NOT_REVIEWABLE
    const staleReviewRes = await fetch(`${h.baseUrl}/values/${v1Vendor.id}/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'approve' }),
    });
    expect(staleReviewRes.status).toBe(409);
    expect(problemDetailsSchema.parse(await staleReviewRes.json()).code).toBe(
      'VERSION_NOT_REVIEWABLE',
    );
  });

  it('dedupe returns 200 when latest upload matches on current template, and 201 when latest is failed or on an older template', async () => {
    const pdf = makeMinimalPdf('dedupe-doc');
    const createRes = await postMultipart(`${h.baseUrl}/documents`, {
      file: { buffer: pdf, filename: 'dedupe.pdf' },
      fields: { type: 'invoice', title: 'Dedupe Test' },
    });
    expect(createRes.status).toBe(201);
    const doc = documentDetailDtoSchema.parse(await createRes.json());
    const v1Id = h.enqueuer.calls[0]!.versionId;

    // 1. Same bytes while v1 is queued -> 200 deduplicated: true, no new enqueue
    const dupRes = await postMultipart(`${h.baseUrl}/documents/${doc.id}/versions`, {
      file: { buffer: pdf, filename: 'dedupe.pdf' },
    });
    expect(dupRes.status).toBe(200);
    const dupBody = createVersionResponseDtoSchema.parse(await dupRes.json());
    expect(dupBody.deduplicated).toBe(true);
    expect(dupBody.version.number).toBe(1);
    expect(h.enqueuer.calls).toHaveLength(1);

    // 2. Fail v1 -> uploading same bytes creates v2 (201, NOT deduped)
    const claim = await withTx(h.ctx.appDb, (tx) =>
      claimVersion(tx, v1Id, 'w-fail', { leaseSeconds: 30 }),
    );
    if (!claim) throw new Error('expected claim');
    await withTx(h.ctx.appDb, (tx) =>
      failRun(tx, v1Id, claim.runId, 'LLM_AUTH', 'Invalid API key'),
    );

    const afterFailRes = await postMultipart(`${h.baseUrl}/documents/${doc.id}/versions`, {
      file: { buffer: pdf, filename: 'dedupe.pdf' },
    });
    expect(afterFailRes.status).toBe(201);
    const afterFailBody = createVersionResponseDtoSchema.parse(await afterFailRes.json());
    expect(afterFailBody.deduplicated).toBeUndefined();
    expect(afterFailBody.version.number).toBe(2);
    expect(h.enqueuer.calls).toHaveLength(2);

    // 3. Publish a newer invoice template (version 2) -> uploading same bytes creates v3 (201, NOT deduped)
    const oldTpl = await getLatestTemplateForType(h.ctx.appDb, 'invoice');
    expect(oldTpl?.version).toBe(1);
    await seedDatabase(h.ctx.migratorDb, h.blobStore, {
      fixturesDir: FIXTURES_DIR,
      hintsPath: HINTS_PATH,
      hintsOverride: {
        invoice: {
          displayName: 'Invoice',
          instructions: 'Updated template instructions v2',
          defaultCurrency: 'USD',
          dateOrder: 'MDY',
          fields: {
            invoice_number: { label: 'Invoice Number' },
            issue_date: { label: 'Issue Date' },
            due_date: { label: 'Due Date' },
            vendor_name: { label: 'Vendor Name' },
            total_amount: { label: 'Total Amount' },
          },
        },
      },
    });
    const newTpl = await getLatestTemplateForType(h.ctx.appDb, 'invoice');
    expect(newTpl?.version).toBe(2);
    expect(await getTemplateWithFields(h.ctx.appDb, newTpl!.id)).not.toBeNull();

    const afterNewTplRes = await postMultipart(`${h.baseUrl}/documents/${doc.id}/versions`, {
      file: { buffer: pdf, filename: 'dedupe.pdf' },
    });
    expect(afterNewTplRes.status).toBe(201);
    const afterNewTplBody = createVersionResponseDtoSchema.parse(await afterNewTplRes.json());
    expect(afterNewTplBody.deduplicated).toBeUndefined();
    expect(afterNewTplBody.version.number).toBe(3);
    expect(afterNewTplBody.version.templateVersion).toBe(2);
  });

  it('[R5] api.retry-202/409 and reextract with/without reparse', async () => {
    const pdf = makeMinimalPdf('retry-reextract');
    const createRes = await postMultipart(`${h.baseUrl}/documents`, {
      file: { buffer: pdf, filename: 'retry.pdf' },
      fields: { type: 'invoice', title: 'Retry & Reextract' },
    });
    const doc = documentDetailDtoSchema.parse(await createRes.json());
    const v1Id = h.enqueuer.calls[0]!.versionId;

    // Retrying a queued version -> 409 NOT_RETRYABLE
    const retryQueuedRes = await fetch(`${h.baseUrl}/documents/${doc.id}/versions/1/retry`, {
      method: 'POST',
    });
    expect(retryQueuedRes.status).toBe(409);
    expect(problemDetailsSchema.parse(await retryQueuedRes.json()).code).toBe('NOT_RETRYABLE');

    // Reextracting a queued version -> 409 VERSION_NOT_TERMINAL
    const reextractQueuedRes = await fetch(
      `${h.baseUrl}/documents/${doc.id}/versions/1/reextract`,
      { method: 'POST' },
    );
    expect(reextractQueuedRes.status).toBe(409);
    expect(problemDetailsSchema.parse(await reextractQueuedRes.json()).code).toBe(
      'VERSION_NOT_TERMINAL',
    );

    // Unparsed version text -> 409 TEXT_NOT_AVAILABLE
    const textMissingRes = await fetch(`${h.baseUrl}/documents/${doc.id}/versions/1/text`);
    expect(textMissingRes.status).toBe(409);
    expect(problemDetailsSchema.parse(await textMissingRes.json()).code).toBe('TEXT_NOT_AVAILABLE');

    // Fail v1 -> retry returns 202 and enqueues with trigger 'retry'
    const claim = await withTx(h.ctx.appDb, (tx) =>
      claimVersion(tx, v1Id, 'w-retry', { leaseSeconds: 30 }),
    );
    if (!claim) throw new Error('expected claim');
    await withTx(h.ctx.appDb, (tx) =>
      failRun(tx, v1Id, claim.runId, 'LLM_TRUNCATED', 'Output cut off'),
    );

    const failedDetail = documentDetailDtoSchema.parse(
      await (await fetch(`${h.baseUrl}/documents/${doc.id}`)).json(),
    );
    expect(failedDetail.currentVersion.error).toEqual({
      code: 'LLM_TRUNCATED',
      message: 'Output cut off',
      retryable: true,
    });

    const retryOkRes = await fetch(`${h.baseUrl}/documents/${doc.id}/versions/1/retry`, {
      method: 'POST',
    });
    expect(retryOkRes.status).toBe(202);
    const retried = versionSummaryDtoSchema.parse(await retryOkRes.json());
    expect(retried.status).toBe('queued');
    expect(retried.attempts).toBe(0);
    expect(retried.error).toBeNull();
    expect(h.enqueuer.calls.at(-1)!.options.trigger).toBe('retry');

    // Extract v1, then reextract with reparse=false (keeps text) and reparse=true (clears text)
    await extractInvoiceVersion(v1Id, {
      vendor: 'Meridian',
      total: '100',
      parsedText: 'Vendor: Meridian\nTotal: $100\n',
    });

    const reextractCopyRes = await fetch(`${h.baseUrl}/documents/${doc.id}/versions/1/reextract`, {
      method: 'POST',
    });
    expect(reextractCopyRes.status).toBe(201);
    expect(reextractCopyRes.headers.get('location')).toBe(`/documents/${doc.id}/versions/2`);
    const v2Summary = versionSummaryDtoSchema.parse(await reextractCopyRes.json());
    expect(v2Summary.origin).toBe('reextract');
    expect(v2Summary.sourceVersionNumber).toBe(1);
    // Copied parsed text is immediately readable on v2
    const v2TextRes = await fetch(`${h.baseUrl}/documents/${doc.id}/versions/2/text`);
    expect(v2TextRes.status).toBe(200);
    expect(await v2TextRes.text()).toContain('Vendor: Meridian');

    const reextractReparseRes = await fetch(
      `${h.baseUrl}/documents/${doc.id}/versions/1/reextract?reparse=true`,
      { method: 'POST' },
    );
    expect(reextractReparseRes.status).toBe(201);
    expect(reextractReparseRes.headers.get('location')).toBe(`/documents/${doc.id}/versions/3`);
    // Reparse clears parsed text -> 409 TEXT_NOT_AVAILABLE
    const v3TextRes = await fetch(`${h.baseUrl}/documents/${doc.id}/versions/3/text`);
    expect(v3TextRes.status).toBe(409);
    expect(problemDetailsSchema.parse(await v3TextRes.json()).code).toBe('TEXT_NOT_AVAILABLE');
  });

  it('GET /documents/facets is not shadowed by :id and caps needsReview count at 100', async () => {
    // Empty/seeded state has 0 docs with pending_count > 0
    const initialRes = await fetch(`${h.baseUrl}/documents/facets`);
    expect(initialRes.status).toBe(200);
    expect(documentsFacetsDtoSchema.parse(await initialRes.json())).toEqual({
      needsReview: { count: 0, capped: false },
    });

    // Seed 105 documents with pending_count = 1 directly in DB
    const pdf = makeMinimalPdf('facet');
    const fileSha = createHash('sha256').update(pdf).digest('hex');
    await withTx(h.ctx.migratorDb, async (tx) => {
      for (let i = 0; i < 105; i++) {
        const { document } = await createDocumentWithInitialVersion(tx, {
          type: 'invoice',
          title: `Facet Doc ${i}`,
          storageKey: `pdfs/sha256/${fileSha}.pdf`,
          fileSha256: fileSha,
          fileSizeBytes: pdf.length,
          originalFilename: `facet-${i}.pdf`,
        });
        await tx.execute(`UPDATE documents SET pending_count = 1 WHERE id = '${document.id}'`);
      }
    });

    const cappedRes = await fetch(`${h.baseUrl}/documents/facets`);
    expect(cappedRes.status).toBe(200);
    expect(documentsFacetsDtoSchema.parse(await cappedRes.json())).toEqual({
      needsReview: { count: 100, capped: true },
    });

    // Filter ?needsReview=true and ?externalId=doc-invoice-001 on GET /documents
    const byExtRes = await fetch(`${h.baseUrl}/documents?externalId=doc-invoice-001`);
    expect(byExtRes.status).toBe(200);
    const byExt = pageSchema(documentSummaryDtoSchema).parse(await byExtRes.json());
    expect(byExt.data).toHaveLength(1);
    expect(byExt.data[0]!.externalId).toBe('doc-invoice-001');
  });

  it('handles multi-byte UTF-8 and emoji filenames, preserves X-Request-Id/nosniff on JSON body errors, and never echoes >100-char invalid values', async () => {
    // 1. Multi-byte UTF-8 (>255 bytes) and emoji filenames upload cleanly within DB/DTO limits
    const utf8Res = await postMultipart(`${h.baseUrl}/documents`, {
      file: { buffer: makeMinimalPdf('utf8-name'), filename: `${'é'.repeat(200)}.pdf` },
      fields: { type: 'invoice' },
    });
    expect(utf8Res.status).toBe(201);
    const utf8Doc = documentDetailDtoSchema.parse(await utf8Res.json());
    expect(utf8Doc.title.length).toBeLessThanOrEqual(200);

    const emojiRes = await postMultipart(`${h.baseUrl}/documents`, {
      file: { buffer: makeMinimalPdf('emoji-name'), filename: `${'👨‍👩‍👧‍👦'.repeat(100)}.pdf` },
      fields: { type: 'invoice' },
    });
    expect(emojiRes.status).toBe(201);
    const emojiDoc = documentDetailDtoSchema.parse(await emojiRes.json());
    expect(emojiDoc.title.length).toBeLessThanOrEqual(200);

    // 2. Malformed JSON (400) and >64KB JSON (413) preserve X-Request-Id and nosniff
    const badJsonRes = await fetch(
      `${h.baseUrl}/values/01950000-0000-7000-8000-000000000001/review`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-request-id': 'req-bad-json' },
        body: '{invalid json',
      },
    );
    expect(badJsonRes.status).toBe(400);
    expect(badJsonRes.headers.get('x-request-id')).toBe('req-bad-json');
    expect(badJsonRes.headers.get('x-content-type-options')).toBe('nosniff');
    expect(problemDetailsSchema.parse(await badJsonRes.json()).requestId).toBe('req-bad-json');

    const hugeJsonRes = await fetch(
      `${h.baseUrl}/values/01950000-0000-7000-8000-000000000001/review`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-request-id': 'req-huge-json' },
        body: JSON.stringify({ decision: 'approve', note: 'x'.repeat(70_000) }),
      },
    );
    expect(hugeJsonRes.status).toBe(413);
    expect(hugeJsonRes.headers.get('x-request-id')).toBe('req-huge-json');
    expect(hugeJsonRes.headers.get('x-content-type-options')).toBe('nosniff');
    const hugeProb = problemDetailsSchema.parse(await hugeJsonRes.json());
    expect(hugeProb.code).toBe('FILE_TOO_LARGE');
    expect(hugeProb.requestId).toBe('req-huge-json');

    // 3. >100-char invalid correctedValue on money field never echoes >100 chars in errors[]
    const v1Id = h.enqueuer.calls[0]!.versionId;
    await extractInvoiceVersion(v1Id, {
      vendor: 'Acme',
      total: '100',
      parsedText: 'Vendor: Acme\nTotal: $100\n',
    });
    const detail = documentDetailDtoSchema.parse(
      await (await fetch(`${h.baseUrl}/documents/${utf8Doc.id}`)).json(),
    );
    const totalVal = detail.values.find((v) => v.fieldKey === 'total_amount')!;
    const longInvalid = 'BADVALUE_'.repeat(30);
    expect(longInvalid.length).toBeGreaterThan(100);

    const longCorrRes = await fetch(`${h.baseUrl}/values/${totalVal.id}/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'correct', correctedValue: longInvalid }),
    });
    expect(longCorrRes.status).toBe(422);
    const longCorrProb = problemDetailsSchema.parse(await longCorrRes.json());
    expect(longCorrProb.code).toBe('INVALID_CORRECTION');
    expect(longCorrProb.errors).toBeDefined();
    for (const err of longCorrProb.errors!) {
      expect(err.message.length).toBeLessThanOrEqual(100);
      expect(err.message).not.toContain(longInvalid);
    }
    expect(longCorrProb.detail).not.toContain(longInvalid);
  });
});
