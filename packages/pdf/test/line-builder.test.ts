import { describe, expect, it } from 'vitest';
import { PdfParseError } from '../src/errors.js';
import { buildDocumentFromPages, cleanPdfText, PARSER_ID } from '../src/line-builder.js';
import type { RawPdfPage, RawPdfTextItem } from '../src/ranges.js';

function item(
  str: string,
  x: number,
  y: number,
  width: number,
  fontSize = 12,
  opts?: { rotated?: boolean },
): RawPdfTextItem {
  const transform: [number, number, number, number, number, number] = opts?.rotated
    ? [0, fontSize, -fontSize, 0, x, y]
    : [fontSize, 0, 0, fontSize, x, y];
  return {
    str,
    transform,
    width,
    height: fontSize,
  };
}

describe('cleanPdfText (§5.1 allowlist)', () => {
  it('expands ligatures, converts fullwidth ASCII, strips zero-width chars, normalizes spaces, and preserves ½ / ² (NFC, not NFKC)', () => {
    const input =
      '\uFB00\uFB01\uFB02\uFB03\uFB04\uFB05\uFB06 \uFF21\uFF22\uFF11\u00AD\u200B\u200C\u200D\u2060\uFEFF\u00A0\u2003\u3000 ½ ² e\u0301';
    expect(cleanPdfText(input)).toBe('fffiflffifflstst AB1    ½ ² é');
  });
});

describe('buildDocumentFromPages (§5.1 line builder & ranges)', () => {
  it('clusters rows by 0.5 * median font height, inserts single spaces on gaps > 0.25 * avgCharWidth, joins pages with \\f', () => {
    const pages: RawPdfPage[] = [
      {
        pageNumber: 1,
        view: [0, 0, 612, 792],
        items: [
          item('Invoice', 50, 750, 42),
          item('#1001', 100, 751, 35), // |Δy| = 1 <= 6 -> same row, gap = 8 > 0.25*6
          item('Total:', 50, 720, 30),
          item('$5,230.29', 90, 720, 55),
        ],
      },
      {
        pageNumber: 2,
        view: [0, 0, 612, 792],
        items: [item('Page two line of text', 50, 750, 120)],
      },
    ];

    const res = buildDocumentFromPages(pages);
    expect(res.parser).toBe(PARSER_ID);
    expect(res.pageCount).toBe(2);
    expect(res.text).toBe('Invoice #1001\nTotal: $5,230.29\fPage two line of text');
    expect(res.pageOffsets).toEqual([0, 'Invoice #1001\nTotal: $5,230.29\f'.length]);
    expect(res.warnings).toEqual([]);
  });

  it('marks off-page text as hidden (OFF_PAGE) with HIDDEN_TEXT_PRESENT warning and < 1.5pt text as lowVisibility', () => {
    const pages: RawPdfPage[] = [
      {
        pageNumber: 1,
        view: [0, 0, 612, 792],
        items: [
          item('Visible invoice header text', 50, 750, 150, 12),
          item('Hidden prompt injection', -400, 700, 120, 12),
          item('Tiny footnote text', 50, 650, 20, 1),
        ],
      },
    ];

    const res = buildDocumentFromPages(pages);
    expect(res.warnings).toContain('HIDDEN_TEXT_PRESENT');
    expect(res.textRanges.hidden).toHaveLength(1);
    const [hStart, hEnd, hReason] = res.textRanges.hidden[0]!;
    expect(hReason).toBe('OFF_PAGE');
    expect(res.text.slice(hStart, hEnd)).toBe('Hidden prompt injection');

    expect(res.textRanges.lowVisibility).toHaveLength(1);
    const [lvStart, lvEnd] = res.textRanges.lowVisibility[0]!;
    expect(res.text.slice(lvStart, lvEnd)).toBe('Tiny footnote text');
  });

  it('emits rotated text after page body with ROTATED_TEXT and flags repeated large x-gaps with MULTI_COLUMN', () => {
    const pages: RawPdfPage[] = [
      {
        pageNumber: 1,
        view: [0, 0, 612, 792],
        items: [
          item('Col A row 1', 40, 750, 60, 12),
          item('Col B row 1', 350, 750, 60, 12),
          item('Col A row 2', 40, 730, 60, 12),
          item('Col B row 2', 350, 730, 60, 12),
          item('Col A row 3', 40, 710, 60, 12),
          item('Col B row 3', 350, 710, 60, 12),
          item('SIDEWAYS STAMP', 560, 400, 80, 12, { rotated: true }),
        ],
      },
    ];

    const res = buildDocumentFromPages(pages);
    expect(res.warnings).toContain('ROTATED_TEXT');
    expect(res.warnings).toContain('MULTI_COLUMN');
    expect(res.text.endsWith('SIDEWAYS STAMP')).toBe(true);
  });

  it('enforces maxPages, maxItemsPerPage, maxTextChars, and PARSE_NO_TEXT limits', () => {
    const emptyPage: RawPdfPage = { pageNumber: 1, view: [0, 0, 612, 792], items: [] };
    expect(() => buildDocumentFromPages([emptyPage])).toThrow(PdfParseError);
    expect(() => buildDocumentFromPages([emptyPage])).toThrowError(
      expect.objectContaining({ code: 'PARSE_NO_TEXT' }),
    );

    const smallPage: RawPdfPage = {
      pageNumber: 1,
      view: [0, 0, 612, 792],
      items: [item('This is plenty of readable text for a page.', 50, 750, 200)],
    };
    expect(() => buildDocumentFromPages([smallPage, smallPage], { maxPages: 1 })).toThrowError(
      expect.objectContaining({ code: 'PARSE_LIMIT_EXCEEDED' }),
    );
    expect(() => buildDocumentFromPages([smallPage], { maxItemsPerPage: 0 })).toThrowError(
      expect.objectContaining({ code: 'PARSE_LIMIT_EXCEEDED' }),
    );
    expect(() => buildDocumentFromPages([smallPage], { maxTextChars: 10 })).toThrowError(
      expect.objectContaining({ code: 'PARSE_LIMIT_EXCEEDED' }),
    );
  });
});
