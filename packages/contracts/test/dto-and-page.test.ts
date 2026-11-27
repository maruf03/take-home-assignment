import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createReviewRequestSchema,
  documentDetailDtoSchema,
  documentsFacetsDtoSchema,
} from '../src/dto/index.js';
import { listQuery, pageMetaSchema, pageSchema } from '../src/page.js';

const UUID_1 = '01937000-0000-7000-8000-000000000001';
const UUID_2 = '01937000-0000-7000-8000-000000000002';
const NOW = '2026-11-27T12:00:00.000Z';

describe('Core forward-only Page and listQuery', () => {
  it('omits prevCursor in Core PageMeta and rejects unexpected prevCursor keys', () => {
    const parsed = pageSchema(z.object({ id: z.string() })).parse({
      data: [{ id: UUID_1 }],
      page: { limit: 20, hasMore: true, nextCursor: 'abc' },
    });
    expect(parsed.page).toEqual({ limit: 20, hasMore: true, nextCursor: 'abc' });

    expect(
      pageMetaSchema.safeParse({
        limit: 20,
        hasMore: false,
        nextCursor: null,
        prevCursor: null,
      }).success,
    ).toBe(false);

    expect(
      pageMetaSchema.safeParse({
        limit: 20,
        hasMore: true,
        nextCursor: '',
      }).success,
    ).toBe(false);
  });

  it('defaults limit to 20, enforces strict integer 1..100, and caps cursor length', () => {
    const q = listQuery();
    expect(q.parse({})).toEqual({ limit: 20 });
    expect(q.parse({ limit: '50', cursor: 'eyJ2IjoxfQ' })).toEqual({
      limit: 50,
      cursor: 'eyJ2IjoxfQ',
    });
    expect(q.safeParse({ limit: 0 }).success).toBe(false);
    expect(q.safeParse({ limit: 101 }).success).toBe(false);
    expect(q.safeParse({ limit: '1e2' }).success).toBe(false);
    expect(q.safeParse({ limit: '0x14' }).success).toBe(false);
    expect(q.safeParse({ limit: '20.0' }).success).toBe(false);
    expect(q.safeParse({ limit: '' }).success).toBe(false);
    expect(q.safeParse({ limit: true }).success).toBe(false);
    expect(q.safeParse({ cursor: 'x'.repeat(513) }).success).toBe(false);
  });
});

describe('Core DTO schemas (§7.4)', () => {
  it('validates DocumentDetail including valuesTextMeta', () => {
    const detail = documentDetailDtoSchema.parse({
      id: UUID_1,
      externalId: 'doc-invoice-001',
      type: 'invoice',
      typeLabel: 'Invoice',
      title: 'Invoice — Meridian Office Supplies',
      status: 'extracted',
      currentVersion: {
        number: 1,
        status: 'extracted',
        origin: 'upload',
        sourceVersionNumber: null,
        templateVersion: 1,
        parser: 'lines/1 pdfjs@6.5.438 unpdf@2.2.3',
        warnings: [],
        error: null,
        attempts: 1,
        createdAt: NOW,
        extractedAt: NOW,
        reviewable: true,
      },
      valuesVersion: 1,
      progress: {
        versionNumber: 1,
        pending: 1,
        approved: 0,
        corrected: 0,
        carriedOver: 0,
        total: 1,
        gaps: 0,
      },
      needsReview: true,
      deletedAt: null,
      createdAt: NOW,
      values: [
        {
          id: UUID_2,
          fieldKey: 'total_amount',
          label: 'Total amount',
          fieldType: 'money',
          position: 1,
          kind: 'value',
          value: { amount: '5230.29', currency: 'USD' },
          effectiveValue: { amount: '5230.29', currency: 'USD' },
          evidence: {
            quote: 'Total Due: $5,230.29',
            line: 12,
            start: 100,
            end: 120,
            matchCount: 1,
            matchMode: 'strict',
            citedLine: 12,
            otherOccurrences: [],
          },
          gap: null,
          flags: [],
          changeKind: 'new',
          changeReason: null,
          reviewState: 'pending',
          attention: 'pending',
          review: null,
          previous: null,
          reviewable: true,
        },
      ],
      valuesTextMeta: {
        textRanges: {
          hidden: [[10, 20, 'off_page']],
          lowVisibility: [[30, 40]],
        },
        pageOffsets: [0],
      },
      recentVersions: [],
      versionsCount: 1,
      links: { versions: `/documents/${UUID_1}/versions` },
    });

    expect(detail.valuesTextMeta?.pageOffsets).toEqual([0]);
    expect(detail.values[0]?.effectiveValue).toEqual({ amount: '5230.29', currency: 'USD' });
  });

  it('validates Core review requests (approve/correct) and rejects JSON-number corrections', () => {
    expect(
      createReviewRequestSchema.safeParse({
        decision: 'approve',
        note: 'Looks good',
      }).success,
    ).toBe(true);

    expect(
      createReviewRequestSchema.safeParse({
        decision: 'correct',
        correctedValue: { amount: '5230.10', currency: 'USD' },
      }).success,
    ).toBe(true);

    expect(
      createReviewRequestSchema.safeParse({
        decision: 'correct',
        correctedValue: { amount: '$5,230.10', currency: '' },
      }).success,
    ).toBe(true);

    expect(
      createReviewRequestSchema.safeParse({
        decision: 'correct',
        correctedValue: '   ',
      }).success,
    ).toBe(false);

    expect(
      createReviewRequestSchema.safeParse({
        decision: 'correct',
        correctedValue: { amount: 5230.1, currency: 'USD' },
      }).success,
    ).toBe(false);

    expect(
      createReviewRequestSchema.safeParse({
        decision: 'correct',
        correctedValue: 42,
      }).success,
    ).toBe(false);
  });

  it('validates /documents/facets response', () => {
    expect(
      documentsFacetsDtoSchema.parse({
        needsReview: { count: 100, capped: true },
      }),
    ).toEqual({ needsReview: { count: 100, capped: true } });
  });
});
