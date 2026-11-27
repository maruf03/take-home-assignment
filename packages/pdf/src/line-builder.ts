import type { TextRanges } from '@app/contracts/dto';
import type { VersionWarning } from '@app/contracts/status';
import { PdfParseError } from './errors.js';
import {
  effectiveFontSize,
  isLowVisibilityItem,
  isOffPageItem,
  isRotatedItem,
  mergeHiddenRanges,
  mergeLowVisibilityRanges,
  type HiddenRange,
  type LowVisibilityRange,
  type RawPdfPage,
  type RawPdfTextItem,
} from './ranges.js';

export const PARSER_ID = 'pdfjs-6.5.438/lines-1';

export interface PdfParseLimits {
  maxPages: number;
  maxItemsPerPage: number;
  maxTextChars: number;
  timeoutMs: number;
  minNonWhitespaceChars: number;
  minCharsPerPage: number;
}

export const DEFAULT_PDF_PARSE_LIMITS: Readonly<PdfParseLimits> = Object.freeze({
  maxPages: 200,
  maxItemsPerPage: 50_000,
  maxTextChars: 2_000_000,
  timeoutMs: 30_000,
  minNonWhitespaceChars: 20,
  minCharsPerPage: 5,
});

export interface PdfParseResult {
  text: string;
  pageOffsets: number[];
  textRanges: TextRanges;
  warnings: VersionWarning[];
  parser: string;
  pageCount: number;
}

const LIGATURE_MAP: Readonly<Record<string, string>> = {
  '\uFB00': 'ff',
  '\uFB01': 'fi',
  '\uFB02': 'fl',
  '\uFB03': 'ffi',
  '\uFB04': 'ffl',
  '\uFB05': 'st',
  '\uFB06': 'st',
};

/**
 * Allowlist-only cleanup applied at parse time (spec §5.1):
 * - Ligatures U+FB00-FB06 expanded
 * - Fullwidth ASCII U+FF01-FF5E mapped to ASCII
 * - U+00AD, U+200B-200D, U+2060, U+FEFF removed
 * - U+00A0, U+2000-200A, U+202F, U+3000 mapped to ASCII space
 * - NFC normalized (never NFKC, preserving ½ and ²)
 */
export function cleanPdfText(raw: string): string {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    const code = ch.charCodeAt(0);
    if (code >= 0xfb00 && code <= 0xfb06) {
      out += LIGATURE_MAP[ch] ?? ch;
    } else if (code >= 0xff01 && code <= 0xff5e) {
      out += String.fromCharCode(code - 0xfee0);
    } else if (
      code === 0x00ad ||
      (code >= 0x200b && code <= 0x200d) ||
      code === 0x2060 ||
      code === 0xfeff
    ) {
      continue;
    } else if (
      code === 0x00a0 ||
      (code >= 0x2000 && code <= 0x200a) ||
      code === 0x202f ||
      code === 0x3000
    ) {
      out += ' ';
    } else {
      out += ch;
    }
  }
  return out.normalize('NFC');
}

interface PositionedItem {
  text: string;
  x: number;
  y: number;
  width: number;
  fontSize: number;
  offPage: boolean;
  lowVisibility: boolean;
}

interface BuiltLine {
  text: string;
  hidden: HiddenRange[];
  lowVisibility: LowVisibilityRange[];
  hasLargeColumnGap: boolean;
}

function median(values: readonly number[]): number {
  if (values.length === 0) {
    return 12;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid]!;
  }
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function assembleRow(items: readonly PositionedItem[], medianFontHeight: number): BuiltLine | null {
  const sorted = [...items].sort((a, b) => a.x - b.x);
  const columnGapThreshold = Math.max(24, 3 * medianFontHeight);

  let rawLine = '';
  const rawHidden: HiddenRange[] = [];
  const rawLowVis: LowVisibilityRange[] = [];
  let hasLargeColumnGap = false;

  let prevRightX: number | null = null;
  let prevNonSpaceRightX: number | null = null;
  let prevAvgCharWidth = 0.5 * medianFontHeight;

  for (const item of sorted) {
    if (item.text.length === 0) {
      continue;
    }

    const isSpaceOnly = item.text.trim().length === 0;

    if (!isSpaceOnly && prevNonSpaceRightX !== null) {
      const nonSpaceGap = item.x - prevNonSpaceRightX;
      if (nonSpaceGap > columnGapThreshold) {
        hasLargeColumnGap = true;
      }
    }

    if (prevRightX !== null) {
      const gap = item.x - prevRightX;
      if (gap > 0.25 * prevAvgCharWidth && !rawLine.endsWith(' ') && !item.text.startsWith(' ')) {
        rawLine += ' ';
      }
    }

    const start = rawLine.length;
    const toAppend = isSpaceOnly ? (rawLine.endsWith(' ') ? '' : ' ') : item.text;
    if (toAppend.length > 0) {
      rawLine += toAppend;
      const end = rawLine.length;
      if (!isSpaceOnly) {
        if (item.offPage) {
          rawHidden.push([start, end, 'OFF_PAGE']);
        }
        if (item.lowVisibility) {
          rawLowVis.push([start, end]);
        }
      }
    }

    prevRightX = item.x + Math.max(0, item.width);
    if (item.width > 0 && item.text.length > 0) {
      prevAvgCharWidth = item.width / item.text.length;
    }
    if (!isSpaceOnly) {
      prevNonSpaceRightX = prevRightX;
    }
  }

  // Trim leading and trailing spaces while preserving exact UTF-16 range offsets.
  let trimStart = 0;
  while (trimStart < rawLine.length && rawLine[trimStart] === ' ') {
    trimStart += 1;
  }
  let trimEnd = rawLine.length;
  while (trimEnd > trimStart && rawLine[trimEnd - 1] === ' ') {
    trimEnd -= 1;
  }

  if (trimEnd <= trimStart) {
    return null;
  }

  const trimmed = rawLine.slice(trimStart, trimEnd);
  const hidden: HiddenRange[] = [];
  for (const [s, e, reason] of rawHidden) {
    const ns = Math.max(0, s - trimStart);
    const ne = Math.min(trimmed.length, e - trimStart);
    if (ne > ns) {
      hidden.push([ns, ne, reason]);
    }
  }
  const lowVisibility: LowVisibilityRange[] = [];
  for (const [s, e] of rawLowVis) {
    const ns = Math.max(0, s - trimStart);
    const ne = Math.min(trimmed.length, e - trimStart);
    if (ne > ns) {
      lowVisibility.push([ns, ne]);
    }
  }

  return {
    text: trimmed,
    hidden,
    lowVisibility,
    hasLargeColumnGap,
  };
}

function buildRotatedLines(
  rotatedItems: readonly PositionedItem[],
  medianFontHeight: number,
): BuiltLine[] {
  if (rotatedItems.length === 0) {
    return [];
  }
  // Group rotated items by x-column (within 0.5 * medianFontHeight) and sort by y.
  const sorted = [...rotatedItems].sort((a, b) => a.x - b.x || b.y - a.y);
  const clusters: PositionedItem[][] = [];
  let current: PositionedItem[] = [];
  let anchorX = 0;
  const threshold = 0.5 * medianFontHeight;

  for (const item of sorted) {
    if (current.length === 0) {
      current.push(item);
      anchorX = item.x;
    } else if (Math.abs(item.x - anchorX) <= threshold) {
      current.push(item);
    } else {
      clusters.push(current);
      current = [item];
      anchorX = item.x;
    }
  }
  if (current.length > 0) {
    clusters.push(current);
  }

  const lines: BuiltLine[] = [];
  for (const cluster of clusters) {
    let rawLine = '';
    const hidden: HiddenRange[] = [];
    const lowVisibility: LowVisibilityRange[] = [];

    for (const item of cluster) {
      const cleaned = item.text.trim();
      if (cleaned.length === 0) {
        continue;
      }
      if (rawLine.length > 0) {
        rawLine += ' ';
      }
      const start = rawLine.length;
      rawLine += cleaned;
      const end = rawLine.length;
      if (item.offPage) {
        hidden.push([start, end, 'OFF_PAGE']);
      }
      if (item.lowVisibility) {
        lowVisibility.push([start, end]);
      }
    }

    if (rawLine.length > 0) {
      lines.push({
        text: rawLine,
        hidden,
        lowVisibility,
        hasLargeColumnGap: false,
      });
    }
  }

  return lines;
}

export function resolvePdfParseLimits(overrides?: Partial<PdfParseLimits>): PdfParseLimits {
  return {
    maxPages: overrides?.maxPages ?? DEFAULT_PDF_PARSE_LIMITS.maxPages,
    maxItemsPerPage: overrides?.maxItemsPerPage ?? DEFAULT_PDF_PARSE_LIMITS.maxItemsPerPage,
    maxTextChars: overrides?.maxTextChars ?? DEFAULT_PDF_PARSE_LIMITS.maxTextChars,
    timeoutMs: overrides?.timeoutMs ?? DEFAULT_PDF_PARSE_LIMITS.timeoutMs,
    minNonWhitespaceChars:
      overrides?.minNonWhitespaceChars ?? DEFAULT_PDF_PARSE_LIMITS.minNonWhitespaceChars,
    minCharsPerPage: overrides?.minCharsPerPage ?? DEFAULT_PDF_PARSE_LIMITS.minCharsPerPage,
  };
}

export function buildDocumentFromPages(
  pages: readonly RawPdfPage[],
  limitOverrides?: Partial<PdfParseLimits>,
): PdfParseResult {
  const limits = resolvePdfParseLimits(limitOverrides);

  if (pages.length > limits.maxPages) {
    throw new PdfParseError(
      'PARSE_LIMIT_EXCEEDED',
      `PDF has ${pages.length} pages, exceeding limit of ${limits.maxPages}`,
      { pageCount: pages.length, maxPages: limits.maxPages },
    );
  }

  const warningsSet = new Set<VersionWarning>();
  const hiddenRanges: HiddenRange[] = [];
  const lowVisRanges: LowVisibilityRange[] = [];
  const pageOffsets: number[] = [];
  let fullText = '';

  for (let pageIdx = 0; pageIdx < pages.length; pageIdx++) {
    const page = pages[pageIdx]!;
    if (page.items.length > limits.maxItemsPerPage) {
      throw new PdfParseError(
        'PARSE_LIMIT_EXCEEDED',
        `Page ${page.pageNumber} has ${page.items.length} text items, exceeding limit of ${limits.maxItemsPerPage}`,
        { pageNumber: page.pageNumber, itemCount: page.items.length },
      );
    }

    if (pageIdx > 0) {
      fullText += '\f';
    }
    pageOffsets.push(fullText.length);

    const normalItems: PositionedItem[] = [];
    const rotatedItems: PositionedItem[] = [];
    const fontHeights: number[] = [];

    for (const rawItem of page.items as readonly RawPdfTextItem[]) {
      const cleaned = cleanPdfText(rawItem.str);
      if (cleaned.length === 0) {
        continue;
      }

      const fontSize = effectiveFontSize(rawItem);
      if (fontSize > 0) {
        fontHeights.push(fontSize);
      }

      const positioned: PositionedItem = {
        text: cleaned,
        x: rawItem.transform[4],
        y: rawItem.transform[5],
        width: rawItem.width,
        fontSize: fontSize > 0 ? fontSize : 12,
        offPage: isOffPageItem(rawItem, page.view),
        lowVisibility: isLowVisibilityItem(rawItem),
      };

      if (isRotatedItem(rawItem)) {
        rotatedItems.push(positioned);
      } else {
        normalItems.push(positioned);
      }
    }

    const medianFontHeight = median(fontHeights);
    const yThreshold = 0.5 * medianFontHeight;

    // Sort top-to-bottom (descending PDF y), then left-to-right (ascending x).
    normalItems.sort((a, b) => b.y - a.y || a.x - b.x);

    const rows: PositionedItem[][] = [];
    let currentRow: PositionedItem[] = [];
    let rowAnchorY = 0;

    for (const item of normalItems) {
      if (currentRow.length === 0) {
        currentRow.push(item);
        rowAnchorY = item.y;
      } else if (Math.abs(item.y - rowAnchorY) <= yThreshold) {
        currentRow.push(item);
      } else {
        rows.push(currentRow);
        currentRow = [item];
        rowAnchorY = item.y;
      }
    }
    if (currentRow.length > 0) {
      rows.push(currentRow);
    }

    const pageLines: BuiltLine[] = [];
    let largeGapRowCount = 0;

    for (const row of rows) {
      const built = assembleRow(row, medianFontHeight);
      if (!built) {
        continue;
      }
      if (built.hasLargeColumnGap) {
        largeGapRowCount += 1;
      }
      pageLines.push(built);
    }

    if (largeGapRowCount >= 3) {
      warningsSet.add('MULTI_COLUMN');
    }

    if (rotatedItems.length > 0) {
      warningsSet.add('ROTATED_TEXT');
      pageLines.push(...buildRotatedLines(rotatedItems, medianFontHeight));
    }

    for (let lineIdx = 0; lineIdx < pageLines.length; lineIdx++) {
      if (lineIdx > 0) {
        fullText += '\n';
      }
      const lineStartOffset = fullText.length;
      const line = pageLines[lineIdx]!;
      fullText += line.text;

      if (fullText.length > limits.maxTextChars) {
        throw new PdfParseError(
          'PARSE_LIMIT_EXCEEDED',
          `Extracted text exceeds maximum length of ${limits.maxTextChars} characters`,
          { maxTextChars: limits.maxTextChars },
        );
      }

      for (const [s, e, reason] of line.hidden) {
        hiddenRanges.push([lineStartOffset + s, lineStartOffset + e, reason]);
      }
      for (const [s, e] of line.lowVisibility) {
        lowVisRanges.push([lineStartOffset + s, lineStartOffset + e]);
      }
    }
  }

  const nonWhitespaceCount = fullText.replace(/\s+/gu, '').length;
  if (
    nonWhitespaceCount < limits.minNonWhitespaceChars ||
    (pages.length > 0 && nonWhitespaceCount / pages.length < limits.minCharsPerPage)
  ) {
    throw new PdfParseError(
      'PARSE_NO_TEXT',
      'PDF does not contain enough extractable text (scanned PDFs require OCR)',
      { nonWhitespaceCount, pageCount: pages.length },
    );
  }

  const mergedHidden = mergeHiddenRanges(hiddenRanges);
  const mergedLowVis = mergeLowVisibilityRanges(lowVisRanges);

  if (mergedHidden.length > 0) {
    warningsSet.add('HIDDEN_TEXT_PRESENT');
  }

  const warnings = [...warningsSet].sort();

  return {
    text: fullText,
    pageOffsets,
    textRanges: {
      hidden: mergedHidden,
      lowVisibility: mergedLowVis,
    },
    warnings,
    parser: PARSER_ID,
    pageCount: pages.length,
  };
}
