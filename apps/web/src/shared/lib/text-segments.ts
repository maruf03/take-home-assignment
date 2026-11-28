import type { TextRanges } from '@app/contracts/dto';

export interface OffsetRange {
  readonly start: number;
  readonly end: number;
}

export interface TextSegment {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly active: boolean;
  readonly otherOccurrence: boolean;
  readonly hiddenReason: string | null;
  readonly lowVisibility: boolean;
}

export interface DocumentLine {
  readonly lineNumber: number;
  readonly pageNumber: number;
  readonly start: number;
  readonly end: number;
  readonly rawText: string;
  readonly segments: readonly TextSegment[];
}

export interface BuildDocumentLinesOptions {
  readonly activeRange?: OffsetRange | null;
  readonly otherOccurrences?: readonly OffsetRange[];
  readonly textRanges?: TextRanges | null;
}

/**
 * Pure utility that splits parsed text into 1-based lines (`\n` line breaks, `\f` page breaks)
 * and partitions each line into non-overlapping inline segments for active evidence `<mark>`,
 * other occurrences, hidden PDF ranges, and low-visibility ranges (spec §14.2 & §14.6).
 */
export function buildDocumentLines(
  text: string,
  options: BuildDocumentLinesOptions = {},
): DocumentLine[] {
  const active = options.activeRange ?? null;
  const others = options.otherOccurrences ?? [];
  const hidden = options.textRanges?.hidden ?? [];
  const lowVis = options.textRanges?.lowVisibility ?? [];

  const rawLines: Array<{
    lineNumber: number;
    pageNumber: number;
    start: number;
    end: number;
    rawText: string;
  }> = [];

  let lineNumber = 1;
  let pageNumber = 1;
  let start = 0;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '\n' || ch === '\f') {
      rawLines.push({
        lineNumber,
        pageNumber,
        start,
        end: i,
        rawText: text.slice(start, i),
      });
      lineNumber += 1;
      if (ch === '\f') {
        pageNumber += 1;
      }
      start = i + 1;
    }
  }
  rawLines.push({
    lineNumber,
    pageNumber,
    start,
    end: text.length,
    rawText: text.slice(start),
  });

  return rawLines.map((line) => {
    if (line.start === line.end) {
      return {
        ...line,
        segments: [
          {
            start: line.start,
            end: line.end,
            text: '',
            active: false,
            otherOccurrence: false,
            hiddenReason: null,
            lowVisibility: false,
          },
        ],
      };
    }

    const cuts = new Set<number>([line.start, line.end]);
    const addCut = (s: number, e: number) => {
      if (e <= line.start || s >= line.end) return;
      cuts.add(Math.max(line.start, s));
      cuts.add(Math.min(line.end, e));
    };

    if (active) addCut(active.start, active.end);
    for (const occ of others) addCut(occ.start, occ.end);
    for (const [hs, he] of hidden) addCut(hs, he);
    for (const [ls, le] of lowVis) addCut(ls, le);

    const sortedCuts = [...cuts].sort((a, b) => a - b);
    const segments: TextSegment[] = [];

    for (let i = 0; i < sortedCuts.length - 1; i++) {
      const segStart = sortedCuts[i]!;
      const segEnd = sortedCuts[i + 1]!;
      if (segEnd <= segStart) continue;

      const isActive = active !== null && segStart < active.end && segEnd > active.start;
      const isOther = !isActive && others.some((occ) => segStart < occ.end && segEnd > occ.start);
      const hiddenEntry = hidden.find(([hs, he]) => segStart < he && segEnd > hs);
      const isLowVis = lowVis.some(([ls, le]) => segStart < le && segEnd > ls);

      segments.push({
        start: segStart,
        end: segEnd,
        text: text.slice(segStart, segEnd),
        active: isActive,
        otherOccurrence: isOther,
        hiddenReason: hiddenEntry ? hiddenEntry[2] : null,
        lowVisibility: isLowVis,
      });
    }

    return { ...line, segments };
  });
}
