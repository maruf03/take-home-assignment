export interface TextLine {
  readonly lineNumber: number;
  readonly pageNumber: number;
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

const MAX_LINE_INDEX_CACHE = 64;
const lineIndexCache = new Map<string, readonly TextLine[]>();

/**
 * Derives 1-based lines and 1-based page numbers from stored text (`\n` line breaks, `\f` page breaks).
 * Memoized with a bounded cache (spec §5.2).
 */
export function lineIndex(text: string): readonly TextLine[] {
  const cached = lineIndexCache.get(text);
  if (cached) {
    return cached;
  }

  const lines: TextLine[] = [];
  let lineNumber = 1;
  let pageNumber = 1;
  let start = 0;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '\n' || ch === '\f') {
      lines.push({
        lineNumber,
        pageNumber,
        start,
        end: i,
        text: text.slice(start, i),
      });
      lineNumber += 1;
      if (ch === '\f') {
        pageNumber += 1;
      }
      start = i + 1;
    }
  }

  lines.push({
    lineNumber,
    pageNumber,
    start,
    end: text.length,
    text: text.slice(start),
  });

  if (lineIndexCache.size >= MAX_LINE_INDEX_CACHE) {
    const oldestKey = lineIndexCache.keys().next().value;
    if (oldestKey !== undefined) {
      lineIndexCache.delete(oldestKey);
    }
  }
  lineIndexCache.set(text, lines);
  return lines;
}

/**
 * Returns the 1-based line number containing `offset` (UTF-16 code units).
 */
export function lineNumberAtOffset(lines: readonly TextLine[], offset: number): number {
  if (lines.length === 0) {
    return 1;
  }
  let lo = 0;
  let hi = lines.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const line = lines[mid]!;
    if (offset < line.start) {
      hi = mid - 1;
    } else if (offset > line.end) {
      lo = mid + 1;
    } else {
      return line.lineNumber;
    }
  }
  return lines[Math.min(lo, lines.length - 1)]!.lineNumber;
}

/**
 * Returns all lines touched by the half-open UTF-16 span `[start, end)`.
 */
export function findLinesTouchingSpan(
  lines: readonly TextLine[],
  start: number,
  end: number,
): TextLine[] {
  if (lines.length === 0) {
    return [];
  }
  const effectiveEnd = Math.max(start, end);
  const touched: TextLine[] = [];

  for (const line of lines) {
    if (line.end < start) {
      continue;
    }
    if (line.start > effectiveEnd) {
      break;
    }
    // Include line if span overlaps it (or sits directly at empty-line start == end).
    if (
      (start < line.end && effectiveEnd > line.start) ||
      (start === effectiveEnd && start >= line.start && start <= line.end)
    ) {
      touched.push(line);
    }
  }

  return touched;
}
