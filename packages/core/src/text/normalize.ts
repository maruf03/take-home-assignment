const WHITESPACE_RUN_REGEX = /\p{White_Space}+/gu;
const SINGLE_WHITESPACE_REGEX = /^\p{White_Space}$/u;

/**
 * Match view M(s) (spec §5.2): maps every run of Unicode White_Space characters to a single ASCII `' '`
 * and trims leading/trailing whitespace. Strictly idempotent: M(M(s)) === M(s).
 */
export function matchNormalize(s: string): string {
  return s.replace(WHITESPACE_RUN_REGEX, ' ').trim();
}

/**
 * Folds curly/smart quotes into straight ASCII quotes (used ONLY on the quote when retrying
 * `match_mode='quote_folded'`, spec §5.5 step 5).
 */
export function foldCurlyQuotes(s: string): string {
  return s
    .replace(/[\u2018\u2019\u201A\u201B]/gu, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/gu, '"');
}

export interface NormIndex {
  readonly norm: string;
  readonly toOrig: Uint32Array;
  readonly origLen: number;
}

/**
 * Builds the normalized match view `norm = M(text)` together with `toOrig: Uint32Array` where
 * `toOrig[i]` is the UTF-16 index of the first original character that produced `norm[i]` (spec §5.2).
 */
export function buildNormIndex(text: string): NormIndex {
  const chars: string[] = [];
  const offsets: number[] = [];

  let i = 0;
  const len = text.length;

  // Skip leading Unicode White_Space (including surrogate pairs cleanly via codePointAt).
  while (i < len) {
    const cp = text.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    if (!SINGLE_WHITESPACE_REGEX.test(ch)) {
      break;
    }
    i += ch.length;
  }

  let pendingSpaceOrigIdx = -1;

  while (i < len) {
    const cp = text.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    if (SINGLE_WHITESPACE_REGEX.test(ch)) {
      if (pendingSpaceOrigIdx === -1) {
        pendingSpaceOrigIdx = i;
      }
      i += ch.length;
      continue;
    }

    if (pendingSpaceOrigIdx !== -1) {
      chars.push(' ');
      offsets.push(pendingSpaceOrigIdx);
      pendingSpaceOrigIdx = -1;
    }

    // Preserve UTF-16 code-unit alignment even for astral code points (surrogate pairs).
    for (let u = 0; u < ch.length; u++) {
      chars.push(ch[u]!);
      offsets.push(i + u);
    }
    i += ch.length;
  }

  return {
    norm: chars.join(''),
    toOrig: Uint32Array.from(offsets),
    origLen: len,
  };
}

/**
 * Maps a half-open normalized span `[normStart, normEnd)` back to `[start, end)` in original UTF-16 offsets.
 */
export function normSpanToOrigSpan(
  index: NormIndex,
  normStart: number,
  normEnd: number,
): { start: number; end: number } {
  if (index.norm.length === 0 || normEnd <= 0 || normStart >= normEnd) {
    return { start: 0, end: 0 };
  }
  const safeStart = Math.max(0, Math.min(normStart, index.norm.length - 1));
  const safeLast = Math.max(safeStart, Math.min(normEnd - 1, index.norm.length - 1));
  const origStart = index.toOrig[safeStart]!;
  const origEnd = index.toOrig[safeLast]! + 1;
  return { start: origStart, end: Math.min(index.origLen, origEnd) };
}

/**
 * Finds all occurrences of `needle` (non-empty) in `index.norm`, mapped back to original UTF-16 offsets.
 */
export function findAllNormalizedOccurrences(
  index: NormIndex,
  normalizedNeedle: string,
): Array<{ start: number; end: number }> {
  if (normalizedNeedle.length === 0 || index.norm.length === 0) {
    return [];
  }
  const results: Array<{ start: number; end: number }> = [];
  let searchFrom = 0;
  while (searchFrom <= index.norm.length - normalizedNeedle.length) {
    const foundAt = index.norm.indexOf(normalizedNeedle, searchFrom);
    if (foundAt === -1) {
      break;
    }
    results.push(normSpanToOrigSpan(index, foundAt, foundAt + normalizedNeedle.length));
    searchFrom = foundAt + 1;
  }
  return results;
}
