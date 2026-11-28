import {
  createVersionResponseDtoSchema,
  documentDetailDtoSchema,
  documentsFacetsDtoSchema,
  documentSummaryDtoSchema,
  documentTypeDtoSchema,
  progressSchema,
  reviewDtoSchema,
  reviewResponseDtoSchema,
  valueViewDtoSchema,
  versionDetailDtoSchema,
  versionSummaryDtoSchema,
} from '@app/contracts/dto';
import { pageSchema } from '@app/contracts/page';
import { problemDetailsSchema } from '@app/contracts/problems';
import { claimVersion, finalizeRun, saveParsedText, withTx } from '@app/db';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createApiTestHarness,
  makeMinimalPdf,
  postMultipart,
  type ApiTestHarness,
} from '../helpers/api-harness.js';

describe('API response contract validation against @app/contracts', () => {
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

  it('validates every Core Task 9 endpoint response and RFC 9457 error payload against contracts', async () => {
    // 1. GET /document-types
    const dtRes = await fetch(`${h.baseUrl}/document-types`);
    expect(dtRes.status).toBe(200);
    pageSchema(documentTypeDtoSchema).parse(await dtRes.json());

    // 2. POST /documents -> DocumentDetailDto
    const pdf1 = makeMinimalPdf('contract-v1');
    const createRes = await postMultipart(`${h.baseUrl}/documents`, {
      file: { buffer: pdf1, filename: 'contract.pdf' },
      fields: { type: 'invoice', title: 'Contract Check' },
    });
    expect(createRes.status).toBe(201);
    const created = documentDetailDtoSchema.parse(await createRes.json());
    const v1Id = h.enqueuer.calls[0]!.versionId;

    // 3. GET /documents -> Page<DocumentSummaryDto>
    const listRes = await fetch(`${h.baseUrl}/documents`);
    expect(listRes.status).toBe(200);
    pageSchema(documentSummaryDtoSchema).parse(await listRes.json());

    // 4. GET /documents/facets -> DocumentsFacetsDto
    const facetsRes = await fetch(`${h.baseUrl}/documents/facets`);
    expect(facetsRes.status).toBe(200);
    documentsFacetsDtoSchema.parse(await facetsRes.json());

    // Extract v1 so values/progress/reviews can be validated too
    const claim = await withTx(h.ctx.appDb, (tx) =>
      claimVersion(tx, v1Id, 'w-contract', { leaseSeconds: 30 }),
    );
    if (!claim) throw new Error('expected claim');
    const text = 'Vendor: Acme Corp\n';
    await withTx(h.ctx.appDb, (tx) =>
      saveParsedText(tx, v1Id, claim.runId, {
        parsedText: text,
        parsedTextSha256: createHash('sha256').update(text).digest('hex'),
        parser: 'pdfjs-test',
        pageOffsets: [0],
        textRanges: { hidden: [], lowVisibility: [] },
        warnings: [],
      }),
    );
    await withTx(h.ctx.appDb, (tx) =>
      finalizeRun(tx, v1Id, claim.runId, {
        warnings: [],
        chunked: false,
        llmCallCount: 1,
        reusedCallCount: 0,
        costUsd: '0.001',
        values: [
          {
            fieldKey: 'vendor_name',
            fieldType: 'string',
            kind: 'value',
            value: 'Acme Corp',
            evidence: 'Vendor: Acme Corp',
            canonicalEvidence: 'vendor: acme corp',
            evidenceStart: 0,
            evidenceEnd: 17,
            evidenceMatchCount: 1,
            citedLine: 1,
            matchMode: 'strict',
            changeKind: 'new',
          },
        ],
      }),
    );

    // 5. GET /documents/:id -> DocumentDetailDto
    const detail = documentDetailDtoSchema.parse(
      await (await fetch(`${h.baseUrl}/documents/${created.id}`)).json(),
    );

    // 6. GET /documents/:id/progress -> Progress
    progressSchema.parse(
      await (await fetch(`${h.baseUrl}/documents/${created.id}/progress`)).json(),
    );

    // 7. GET /documents/:id/versions -> Page<VersionSummaryDto>
    pageSchema(versionSummaryDtoSchema).parse(
      await (await fetch(`${h.baseUrl}/documents/${created.id}/versions`)).json(),
    );

    // 8. GET /documents/:id/versions/:n -> VersionDetailDto
    versionDetailDtoSchema.parse(
      await (await fetch(`${h.baseUrl}/documents/${created.id}/versions/1`)).json(),
    );

    // 9. GET /documents/:id/versions/:n/values -> Page<ValueViewDto>
    pageSchema(valueViewDtoSchema).parse(
      await (await fetch(`${h.baseUrl}/documents/${created.id}/versions/1/values`)).json(),
    );

    // 10. POST /values/:id/review -> ReviewResponseDto & GET /values/:id/reviews -> Page<ReviewDto>
    const valueId = detail.values[0]!.id;
    const revRes = await fetch(`${h.baseUrl}/values/${valueId}/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'approve' }),
    });
    expect(revRes.status).toBe(201);
    reviewResponseDtoSchema.parse(await revRes.json());

    pageSchema(reviewDtoSchema).parse(
      await (await fetch(`${h.baseUrl}/values/${valueId}/reviews`)).json(),
    );

    // 11. POST /documents/:id/versions -> CreateVersionResponseDto
    const pdf2 = makeMinimalPdf('contract-v2');
    const verRes = await postMultipart(`${h.baseUrl}/documents/${created.id}/versions`, {
      file: { buffer: pdf2, filename: 'contract-v2.pdf' },
    });
    expect(verRes.status).toBe(201);
    createVersionResponseDtoSchema.parse(await verRes.json());

    // 12. POST /documents/:id/versions/1/reextract -> VersionSummaryDto
    const reextractRes = await fetch(`${h.baseUrl}/documents/${created.id}/versions/1/reextract`, {
      method: 'POST',
    });
    expect(reextractRes.status).toBe(201);
    versionSummaryDtoSchema.parse(await reextractRes.json());

    // 13. RFC 9457 error contracts: 400 INVALID_ID, 404 DOCUMENT_NOT_FOUND, 404 ROUTE_NOT_FOUND, 422 UNKNOWN_DOCUMENT_TYPE
    const badIdRes = await fetch(`${h.baseUrl}/documents/not-a-uuid`);
    expect(badIdRes.status).toBe(400);
    expect(badIdRes.headers.get('content-type')).toContain('application/problem+json');
    expect(problemDetailsSchema.parse(await badIdRes.json()).code).toBe('INVALID_ID');

    const missingDocRes = await fetch(
      `${h.baseUrl}/documents/01950000-0000-7000-8000-000000000099`,
    );
    expect(missingDocRes.status).toBe(404);
    expect(problemDetailsSchema.parse(await missingDocRes.json()).code).toBe('DOCUMENT_NOT_FOUND');

    const missingRouteRes = await fetch(`${h.baseUrl}/does-not-exist`);
    expect(missingRouteRes.status).toBe(404);
    expect(problemDetailsSchema.parse(await missingRouteRes.json()).code).toBe('ROUTE_NOT_FOUND');

    const badTypeRes = await postMultipart(`${h.baseUrl}/documents`, {
      file: { buffer: pdf1, filename: 'x.pdf' },
      fields: { type: 'no_such_type' },
    });
    expect(badTypeRes.status).toBe(422);
    expect(problemDetailsSchema.parse(await badTypeRes.json()).code).toBe('UNKNOWN_DOCUMENT_TYPE');
  });
});
