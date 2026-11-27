import type { TextRanges } from '@app/contracts/dto';
import { lineIndex, type TextLine } from './lines.js';

export const DEFAULT_CHUNK_CHAR_LIMIT = 400_000;
export const DEFAULT_CHUNK_OVERLAP_LINES = 5;

/**
 * Replaces every character inside `ranges.hidden` with `▢` of the exact same UTF-16 length,
 * preserving `\n` and `\f` boundaries so line numbering and offsets stay aligned (spec §5.2).
 */
export function maskHiddenText(text: string, ranges: TextRanges): string {
  if (ranges.hidden.length === 0) {
    return text;
  }
  const chars = text.split('');
  for (const [rawStart, rawEnd] of ranges.hidden) {
    const start = Math.max(0, Math.min(rawStart, chars.length));
    const end = Math.max(start, Math.min(rawEnd, chars.length));
    for (let i = start; i < end; i++) {
      const ch = chars[i]!;
      if (ch !== '\n' && ch !== '\f') {
        chars[i] = '▢';
      }
    }
  }
  return chars.join('');
}

function formatLinePrefix(lineNumber: number): string {
  return `L${String(lineNumber).padStart(3, '0')}| `;
}

function renderLinesGroupedByPage(lines: readonly TextLine[], nonce: string): string {
  const pageBlocks: string[] = [];
  let currentPage = -1;
  let currentLines: string[] = [];

  const flush = (): void => {
    if (currentPage === -1) {
      return;
    }
    pageBlocks.push(`<page ${currentPage}>\n${currentLines.join('\n')}\n</page>`);
    currentLines = [];
  };

  for (const line of lines) {
    if (line.pageNumber !== currentPage) {
      flush();
      currentPage = line.pageNumber;
    }
    currentLines.push(`${formatLinePrefix(line.lineNumber)}${line.text}`);
  }
  flush();

  return `<document-${nonce} data-untrusted="true">\n${pageBlocks.join('\n')}\n</document-${nonce}>`;
}

/**
 * Pure prompt view over stored text (spec §5.2):
 * - Hidden characters replaced by `▢` of identical length
 * - Lines prefixed `L001| `
 * - Pages wrapped as `<page n>…</page>`
 * - Whole document fenced in `<document-{nonce} data-untrusted="true">…</document-{nonce}>`
 */
export function renderPromptDocument(text: string, ranges: TextRanges, nonce: string): string {
  const masked = maskHiddenText(text, ranges);
  const lines = lineIndex(masked);
  return renderLinesGroupedByPage(lines, nonce);
}

export interface ChunkWindow {
  readonly chunkIndex: number;
  readonly startPage: number;
  readonly endPage: number;
  readonly startLine: number;
  readonly endLine: number;
  readonly rendered: string;
}

/**
 * Plans single-call or page-window chunks with `overlapLines` (default 5) overlap from the previous
 * window, preserving original `L###` line numbers (spec §5.4).
 */
export function planChunks(
  text: string,
  ranges: TextRanges,
  nonce: string,
  chunkCharLimit = DEFAULT_CHUNK_CHAR_LIMIT,
  overlapLines = DEFAULT_CHUNK_OVERLAP_LINES,
): ChunkWindow[] {
  const masked = maskHiddenText(text, ranges);
  const allLines = lineIndex(masked);
  const fullRendered = renderLinesGroupedByPage(allLines, nonce);

  if (fullRendered.length <= chunkCharLimit) {
    const first = allLines[0];
    const last = allLines[allLines.length - 1];
    return [
      {
        chunkIndex: 0,
        startPage: first?.pageNumber ?? 1,
        endPage: last?.pageNumber ?? 1,
        startLine: first?.lineNumber ?? 1,
        endLine: last?.lineNumber ?? 1,
        rendered: fullRendered,
      },
    ];
  }

  // Group lines by page.
  const pages: TextLine[][] = [];
  for (const line of allLines) {
    const lastPage = pages[pages.length - 1];
    if (!lastPage || lastPage[0]!.pageNumber !== line.pageNumber) {
      pages.push([line]);
    } else {
      lastPage.push(line);
    }
  }

  const windows: ChunkWindow[] = [];
  let pageCursor = 0;
  let prevWindowLines: TextLine[] = [];

  while (pageCursor < pages.length) {
    const overlap =
      windows.length > 0 && overlapLines > 0 ? prevWindowLines.slice(-overlapLines) : [];

    const windowLines: TextLine[] = [...overlap];
    const startPage = pages[pageCursor]![0]!.pageNumber;
    let endPage = startPage;
    let pagesAdded = 0;

    while (pageCursor < pages.length) {
      const candidatePage = pages[pageCursor]!;
      const candidateLines = [...windowLines, ...candidatePage];
      const renderedCandidate = renderLinesGroupedByPage(candidateLines, nonce);

      if (pagesAdded > 0 && renderedCandidate.length > chunkCharLimit) {
        break;
      }

      windowLines.push(...candidatePage);
      endPage = candidatePage[0]!.pageNumber;
      pagesAdded += 1;
      pageCursor += 1;

      if (renderedCandidate.length >= chunkCharLimit) {
        break;
      }
    }

    const rendered = renderLinesGroupedByPage(windowLines, nonce);
    windows.push({
      chunkIndex: windows.length,
      startPage,
      endPage,
      startLine: windowLines[0]!.lineNumber,
      endLine: windowLines[windowLines.length - 1]!.lineNumber,
      rendered,
    });
    prevWindowLines = windowLines;
  }

  return windows;
}
