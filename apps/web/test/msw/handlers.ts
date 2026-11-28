import {
  createVersionResponseDtoSchema,
  documentDetailDtoSchema,
  documentsFacetsDtoSchema,
  documentSummaryDtoSchema,
  documentTypeDtoSchema,
  reviewResponseDtoSchema,
  versionDetailDtoSchema,
  versionSummaryDtoSchema,
  type DocumentDetailDto,
  type DocumentsFacetsDto,
  type DocumentSummaryDto,
  type DocumentTypeDto,
  type ValueViewDto,
  type VersionDetailDto,
} from '@app/contracts/dto';
import type { ProblemDetails } from '@app/contracts/problems';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

export const DOC_ID_1 = '01950000-0000-7000-8000-000000000001';
export const DOC_ID_2 = '01950000-0000-7000-8000-000000000002';
export const VAL_CHANGED_ID = '01950000-0000-7000-8000-000000000101';
export const VAL_GAP_ID = '01950000-0000-7000-8000-000000000102';
export const VAL_PENDING_ID = '01950000-0000-7000-8000-000000000103';
export const VAL_DONE_ID = '01950000-0000-7000-8000-000000000104';

export const SAMPLE_PARSED_TEXT = [
  'Vendor: Meridian Office Supplies',
  'Total Amount Due: $5,999.99',
  'Note: Repeat $5,999.99 on summary line',
  'Fine print disclaimer line',
  'HIDDEN_OFFPAGE_INJECTION $0.00',
].join('\n');

const totalStart = SAMPLE_PARSED_TEXT.indexOf('Total Amount Due: $5,999.99');
const totalEnd = totalStart + 'Total Amount Due: $5,999.99'.length;
const otherStart = SAMPLE_PARSED_TEXT.indexOf('$5,999.99', totalEnd);
const otherEnd = otherStart + '$5,999.99'.length;
const lowVisStart = SAMPLE_PARSED_TEXT.indexOf('Fine print disclaimer line');
const lowVisEnd = lowVisStart + 'Fine print disclaimer line'.length;
const hiddenStart = SAMPLE_PARSED_TEXT.indexOf('HIDDEN_OFFPAGE_INJECTION $0.00');
const hiddenEnd = hiddenStart + 'HIDDEN_OFFPAGE_INJECTION $0.00'.length;
const vendorStart = SAMPLE_PARSED_TEXT.indexOf('Vendor: Meridian Office Supplies');
const vendorEnd = vendorStart + 'Vendor: Meridian Office Supplies'.length;

export const SAMPLE_DOCUMENT_TYPES: DocumentTypeDto[] = [
  documentTypeDtoSchema.parse({
    key: 'invoice',
    displayName: 'Invoice',
    template: {
      version: 1,
      defaultCurrency: 'USD',
      dateOrder: 'MDY',
      fields: [
        {
          fieldKey: 'vendor_name',
          fieldType: 'string',
          position: 1,
          label: 'Vendor Name',
          description: null,
        },
        {
          fieldKey: 'total_amount',
          fieldType: 'money',
          position: 2,
          label: 'Total Amount',
          description: null,
        },
        {
          fieldKey: 'invoice_number',
          fieldType: 'string',
          position: 3,
          label: 'Invoice Number',
          description: null,
        },
        {
          fieldKey: 'issue_date',
          fieldType: 'date',
          position: 4,
          label: 'Issue Date',
          description: null,
        },
      ],
    },
  }),
  documentTypeDtoSchema.parse({
    key: 'lease',
    displayName: 'Commercial Lease',
    template: {
      version: 1,
      defaultCurrency: 'USD',
      dateOrder: 'MDY',
      fields: [
        {
          fieldKey: 'monthly_rent',
          fieldType: 'money',
          position: 1,
          label: 'Monthly Rent',
          description: null,
        },
      ],
    },
  }),
];

export function makeSampleDocumentSummary(
  overrides: Partial<DocumentSummaryDto> = {},
): DocumentSummaryDto {
  return documentSummaryDtoSchema.parse({
    id: DOC_ID_1,
    externalId: 'doc-invoice-001',
    type: 'invoice',
    typeLabel: 'Invoice',
    title: 'Invoice — Meridian Office Supplies',
    status: 'extracted',
    currentVersion: {
      number: 2,
      status: 'extracted',
      origin: 'upload',
      sourceVersionNumber: null,
      templateVersion: 1,
      parser: 'pdfjs-5',
      warnings: ['HIDDEN_TEXT_PRESENT'],
      error: null,
      attempts: 1,
      createdAt: '2026-11-27T10:00:00.000Z',
      extractedAt: '2026-11-27T10:00:05.000Z',
      reviewable: true,
    },
    valuesVersion: 2,
    progress: {
      versionNumber: 2,
      pending: 3,
      approved: 0,
      corrected: 0,
      carriedOver: 1,
      total: 4,
      gaps: 1,
    },
    needsReview: true,
    deletedAt: null,
    createdAt: '2026-11-27T09:00:00.000Z',
    ...overrides,
  });
}

export function makeSampleDocumentDetail(
  overrides: Partial<DocumentDetailDto> = {},
): DocumentDetailDto {
  const summary = makeSampleDocumentSummary();
  return documentDetailDtoSchema.parse({
    ...summary,
    // Intentionally supply out-of-order values to prove the UI groups Changed -> Gaps -> Pending -> Done
    values: [
      {
        id: VAL_DONE_ID,
        fieldKey: 'vendor_name',
        label: 'Vendor Name',
        fieldType: 'string',
        position: 1,
        kind: 'value',
        value: 'Meridian Office Supplies',
        effectiveValue: 'Meridian Office Supplies',
        evidence: {
          quote: 'Vendor: Meridian Office Supplies',
          line: 1,
          start: vendorStart,
          end: vendorEnd,
          matchCount: 1,
          matchMode: 'strict',
          citedLine: 1,
          otherOccurrences: [],
        },
        gap: null,
        flags: [],
        changeKind: 'same',
        changeReason: null,
        reviewState: 'carried_over',
        attention: 'done',
        review: {
          id: '01950000-0000-7000-8000-000000000201',
          decision: 'approve',
          correctedValue: null,
          note: null,
          origin: 'carried',
          carriedFromVersion: 1,
          createdAt: '2026-11-27T10:00:05.000Z',
        },
        // Realistic backend behavior: unchanged carried_over rows still carry previous from v1.
        previous: {
          versionNumber: 1,
          valueId: '01950000-0000-7000-8000-000000000091',
          kind: 'value',
          value: 'Meridian Office Supplies',
          effectiveValue: 'Meridian Office Supplies',
          evidence: { quote: 'Vendor: Meridian Office Supplies', line: 1 },
          gap: null,
          review: {
            id: '01950000-0000-7000-8000-000000000291',
            decision: 'approve',
            correctedValue: null,
            note: null,
            origin: 'human',
            carriedFromVersion: null,
            createdAt: '2026-11-27T09:05:00.000Z',
          },
        },
        reviewable: true,
      },
      {
        id: VAL_PENDING_ID,
        fieldKey: 'issue_date',
        label: 'Issue Date',
        fieldType: 'date',
        position: 4,
        kind: 'value',
        value: '2025-09-01',
        effectiveValue: '2025-09-01',
        evidence: {
          quote: 'Fine print disclaimer line',
          line: 4,
          start: lowVisStart,
          end: lowVisEnd,
          matchCount: 1,
          matchMode: 'strict',
          citedLine: 4,
          otherOccurrences: [],
        },
        gap: null,
        flags: ['LOW_VISIBILITY', 'LINE_HINT_MISMATCH'],
        changeKind: 'new',
        changeReason: null,
        reviewState: 'pending',
        attention: 'pending',
        review: null,
        previous: null,
        reviewable: true,
      },
      {
        id: VAL_GAP_ID,
        fieldKey: 'invoice_number',
        label: 'Invoice Number',
        fieldType: 'string',
        position: 3,
        kind: 'gap',
        value: null,
        effectiveValue: null,
        evidence: null,
        gap: {
          code: 'NOT_FOUND',
          reason: 'No invoice number printed on page 1',
          attemptedQuote: null,
        },
        flags: [],
        changeKind: 'new',
        changeReason: null,
        reviewState: 'pending',
        attention: 'gap',
        review: null,
        previous: null,
        reviewable: true,
      },
      {
        id: VAL_CHANGED_ID,
        fieldKey: 'total_amount',
        label: 'Total Amount',
        fieldType: 'money',
        position: 2,
        kind: 'value',
        value: { amount: '5999.99', currency: 'USD' },
        effectiveValue: { amount: '5999.99', currency: 'USD' },
        evidence: {
          quote: 'Total Amount Due: $5,999.99',
          line: 2,
          start: totalStart,
          end: totalEnd,
          matchCount: 2,
          matchMode: 'strict',
          citedLine: 2,
          otherOccurrences: [{ start: otherStart, end: otherEnd }],
        },
        gap: null,
        flags: ['AMBIGUOUS_OCCURRENCE'],
        changeKind: 'changed',
        changeReason: 'VALUE_CHANGED',
        reviewState: 'pending',
        attention: 'changed',
        review: null,
        previous: {
          versionNumber: 1,
          valueId: '01950000-0000-7000-8000-000000000099',
          kind: 'value',
          value: { amount: '5230.29', currency: 'USD' },
          effectiveValue: { amount: '5230.29', currency: 'USD' },
          evidence: { quote: 'Total Amount Due: $5,230.29', line: 2 },
          gap: null,
          review: {
            id: '01950000-0000-7000-8000-000000000299',
            decision: 'approve',
            correctedValue: null,
            note: 'Checked v1',
            origin: 'human',
            carriedFromVersion: null,
            createdAt: '2026-11-27T09:10:00.000Z',
          },
        },
        reviewable: true,
      },
    ],
    valuesTextMeta: {
      textRanges: {
        hidden: [[hiddenStart, hiddenEnd, 'OFF_PAGE']],
        lowVisibility: [[lowVisStart, lowVisEnd]],
      },
      pageOffsets: [0],
    },
    recentVersions: [
      summary.currentVersion,
      {
        number: 1,
        status: 'extracted',
        origin: 'upload',
        sourceVersionNumber: null,
        templateVersion: 1,
        parser: 'pdfjs-5',
        warnings: [],
        error: null,
        attempts: 1,
        createdAt: '2026-11-27T09:00:00.000Z',
        extractedAt: '2026-11-27T09:00:05.000Z',
        reviewable: false,
      },
    ],
    versionsCount: 2,
    links: { versions: `/documents/${DOC_ID_1}/versions` },
    ...overrides,
  });
}

export function makeSampleVersionDetail(versionNumber = 1): VersionDetailDto {
  const detail = makeSampleDocumentDetail();
  return versionDetailDtoSchema.parse({
    ...detail.recentVersions.find((v) => v.number === versionNumber)!,
    values: detail.values.map((v) => ({ ...v, reviewable: false })),
    progress: { ...detail.progress, versionNumber },
    file: {
      originalFilename: 'invoice-001.pdf',
      fileSizeBytes: 12345,
      fileSha256: 'a'.repeat(64),
    },
    textRanges: detail.valuesTextMeta!.textRanges,
    pageOffsets: detail.valuesTextMeta!.pageOffsets,
  });
}

export function makeProblem(
  status: number,
  code: ProblemDetails['code'],
  detail: string,
  extra: Partial<ProblemDetails> = {},
): ProblemDetails {
  return {
    type: 'about:blank',
    title: code,
    status,
    code,
    detail,
    requestId: 'req-msw-1',
    ...extra,
  };
}

export const defaultHandlers = [
  http.get('/api/document-types', () =>
    HttpResponse.json({
      data: SAMPLE_DOCUMENT_TYPES,
      page: { limit: 20, hasMore: false, nextCursor: null },
    }),
  ),
  http.get('/api/documents/facets', () =>
    HttpResponse.json(
      documentsFacetsDtoSchema.parse({
        needsReview: { count: 100, capped: true },
      } satisfies DocumentsFacetsDto),
    ),
  ),
  http.get('/api/documents', () =>
    HttpResponse.json({
      data: [makeSampleDocumentSummary()],
      page: { limit: 20, hasMore: false, nextCursor: null },
    }),
  ),
  http.get('/api/documents/:id', () => HttpResponse.json(makeSampleDocumentDetail())),
  http.get('/api/documents/:id/versions/:n', ({ params }) =>
    HttpResponse.json(makeSampleVersionDetail(Number(params['n']))),
  ),
  http.get('/api/documents/:id/versions/:n/text', () =>
    HttpResponse.text(SAMPLE_PARSED_TEXT, {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    }),
  ),
  http.post('/api/values/:id/review', async ({ params, request }) => {
    const body = (await request.json()) as {
      decision: 'approve' | 'correct';
      correctedValue?: ValueViewDto['effectiveValue'];
      note?: string;
    };
    const detail = makeSampleDocumentDetail();
    const existing = detail.values.find((v) => v.id === params['id']) ?? detail.values[0]!;
    const updated: ValueViewDto = {
      ...existing,
      reviewState: body.decision === 'correct' ? 'corrected' : 'approved',
      attention: 'done',
      effectiveValue:
        body.decision === 'correct' && body.correctedValue !== undefined
          ? body.correctedValue
          : existing.value,
      review: {
        id: '01950000-0000-7000-8000-000000000901',
        decision: body.decision,
        correctedValue:
          body.decision === 'correct' && body.correctedValue !== undefined
            ? body.correctedValue
            : null,
        note: body.note ?? null,
        origin: 'human',
        carriedFromVersion: null,
        createdAt: '2026-11-27T11:00:00.000Z',
      },
    };
    return HttpResponse.json(
      reviewResponseDtoSchema.parse({
        value: updated,
        progress: {
          ...detail.progress,
          pending: Math.max(0, detail.progress.pending - 1),
          approved: detail.progress.approved + (body.decision === 'approve' ? 1 : 0),
          corrected: detail.progress.corrected + (body.decision === 'correct' ? 1 : 0),
        },
      }),
      { status: 201 },
    );
  }),
  http.post('/api/documents/:id/versions', () => {
    const summary = makeSampleDocumentSummary();
    const newVersion = versionSummaryDtoSchema.parse({
      ...summary.currentVersion,
      number: summary.currentVersion.number + 1,
      status: 'queued',
      extractedAt: null,
      reviewable: false,
    });
    return HttpResponse.json(
      createVersionResponseDtoSchema.parse({
        document: {
          ...summary,
          status: 'queued',
          currentVersion: newVersion,
        },
        version: newVersion,
      }),
      { status: 201 },
    );
  }),
  http.post('/api/documents/:id/versions/:n/retry', ({ params }) => {
    const summary = makeSampleDocumentSummary();
    return HttpResponse.json(
      versionSummaryDtoSchema.parse({
        ...summary.currentVersion,
        number: Number(params['n']),
        status: 'queued',
        error: null,
        attempts: 0,
        extractedAt: null,
        reviewable: false,
      }),
      { status: 202 },
    );
  }),
  http.post('/api/documents/:id/versions/:n/reextract', ({ params }) => {
    const summary = makeSampleDocumentSummary();
    return HttpResponse.json(
      versionSummaryDtoSchema.parse({
        ...summary.currentVersion,
        number: Number(params['n']) + 1,
        origin: 'reextract',
        sourceVersionNumber: Number(params['n']),
        status: 'queued',
        error: null,
        attempts: 0,
        extractedAt: null,
        reviewable: false,
      }),
      { status: 201 },
    );
  }),
];

export const server = setupServer(...defaultHandlers);
