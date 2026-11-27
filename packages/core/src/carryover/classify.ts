import type { TextRanges } from '@app/contracts/dto';
import type { ChangeKind, ChangeReason, DateOrder, ReviewDecision } from '@app/contracts/status';
import { equalValues } from '@app/contracts/values';
import { analyzeLineAnchor, extractTypedTokens } from '../evidence/tokenizers.js';
import { findLinesTouchingSpan, lineIndex } from '../text/lines.js';
import { buildNormIndex, findAllNormalizedOccurrences, matchNormalize } from '../text/normalize.js';
import type { BaselineFieldSnapshot, ValidatedFieldResult } from '../types.js';

export interface CarryoverContext {
  readonly baselineParser: string;
  readonly nextParser: string;
  readonly baselineText: string;
  readonly nextText: string;
  readonly nextRanges: TextRanges;
  readonly dateOrder: DateOrder;
}

export interface ChangeClassification {
  readonly changeKind: ChangeKind;
  readonly changeReason: ChangeReason | null;
}

export interface BaselineReviewRef {
  readonly id: string;
  readonly decision: ReviewDecision;
}

function spansOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

function isLineHidden(start: number, end: number, ranges: TextRanges): boolean {
  return ranges.hidden.some(([hs, he]) => spansOverlap(start, end, hs, he));
}

/**
 * Carry-over Rule A′ — Step A: classify every field independently of review status (spec §5.6).
 *
 * `change_reason` priority order:
 * 1. TYPE_CHANGED
 * 2. GAP_INVOLVED
 * 3. VALUE_CHANGED
 * 4. PARSER_CHANGED
 * 5. EVIDENCE_HIDDEN
 * 6. WEAK_EVIDENCE_LINE
 * 7. CONFLICTING_EVIDENCE
 * 8. POSSIBLE_AMENDMENT
 * 9. EVIDENCE_CHANGED
 */
export function classifyChange(
  baseline: BaselineFieldSnapshot | null,
  next: ValidatedFieldResult,
  ctx: CarryoverContext,
): ChangeClassification {
  if (!baseline) {
    return { changeKind: 'new', changeReason: null };
  }

  // 1. TYPE_CHANGED
  if (baseline.fieldType !== next.fieldType) {
    return { changeKind: 'changed', changeReason: 'TYPE_CHANGED' };
  }

  // 2. GAP_INVOLVED
  if (baseline.kind !== 'value' || next.kind !== 'value') {
    return { changeKind: 'changed', changeReason: 'GAP_INVOLVED' };
  }

  // 3. VALUE_CHANGED
  if (!equalValues(next.fieldType, baseline.value, next.value)) {
    return { changeKind: 'changed', changeReason: 'VALUE_CHANGED' };
  }

  // 4. PARSER_CHANGED
  if (ctx.baselineParser !== ctx.nextParser) {
    return { changeKind: 'changed', changeReason: 'PARSER_CHANGED' };
  }

  const baselineCanonical = baseline.canonicalEvidence;
  if (!baselineCanonical) {
    return { changeKind: 'changed', changeReason: 'EVIDENCE_CHANGED' };
  }

  // 5. EVIDENCE_HIDDEN: baseline canonical line(s) are hidden in nextText (and not visibly present).
  // Uses normalized span matching so multi-line baseline canonicalEvidence is handled identically.
  const nextLines = lineIndex(ctx.nextText);
  const nextNormIdx = buildNormIndex(ctx.nextText);
  let hasHiddenBaselineLine = false;
  let hasVisibleBaselineLine = false;
  for (const occ of findAllNormalizedOccurrences(nextNormIdx, baselineCanonical)) {
    const touched = findLinesTouchingSpan(nextLines, occ.start, occ.end);
    if (touched.length === 0) {
      continue;
    }
    if (matchNormalize(touched.map((l) => l.text).join(' ')) !== baselineCanonical) {
      continue;
    }
    if (touched.some((l) => isLineHidden(l.start, l.end, ctx.nextRanges))) {
      hasHiddenBaselineLine = true;
    } else {
      hasVisibleBaselineLine = true;
    }
  }
  if (hasHiddenBaselineLine && !hasVisibleBaselineLine) {
    return { changeKind: 'changed', changeReason: 'EVIDENCE_HIDDEN' };
  }

  // 6. WEAK_EVIDENCE_LINE (scalars only; string fields are never weak per §5.5).
  const baseAnchor = analyzeLineAnchor(next.fieldType, baselineCanonical, ctx.dateOrder);
  if (
    next.fieldType !== 'string' &&
    (baseline.flags.includes('WEAK_EVIDENCE_LINE') || baseAnchor.isWeak)
  ) {
    return { changeKind: 'changed', changeReason: 'WEAK_EVIDENCE_LINE' };
  }

  // 7. CONFLICTING_EVIDENCE: new value has CONFLICTING_LINES.
  if (next.flags.includes('CONFLICTING_LINES')) {
    return { changeKind: 'changed', changeReason: 'CONFLICTING_EVIDENCE' };
  }

  // 8. POSSIBLE_AMENDMENT: label-anchor check against lines ADDED in nextText (line-set diff of M(lines)).
  // Compare against both stripped labelAnchor (handles mid-line tokens) and raw normLine.
  if (next.fieldType !== 'string' && baseAnchor.letterCount >= 2) {
    const baselineLineSet = new Set(lineIndex(ctx.baselineText).map((l) => matchNormalize(l.text)));
    const anchorLower = baseAnchor.labelAnchor.toLowerCase();

    for (const nextLine of nextLines) {
      if (isLineHidden(nextLine.start, nextLine.end, ctx.nextRanges)) {
        continue;
      }
      const normLine = matchNormalize(nextLine.text);
      if (baselineLineSet.has(normLine)) {
        continue;
      }
      const nextAnchor = analyzeLineAnchor(next.fieldType, normLine, ctx.dateOrder);
      if (
        !nextAnchor.labelAnchor.toLowerCase().includes(anchorLower) &&
        !normLine.toLowerCase().includes(anchorLower)
      ) {
        continue;
      }
      const tokens = extractTypedTokens(next.fieldType, normLine, ctx.dateOrder);
      if (tokens.some((tok) => !equalValues(next.fieldType, tok.value, baseline.value))) {
        return { changeKind: 'changed', changeReason: 'POSSIBLE_AMENDMENT' };
      }
    }
  }

  // 9. EVIDENCE_CHANGED: some visible occurrence of the new quote must have canonical == baseline.canonicalEvidence.
  const hasMatchingVisibleOccurrence =
    next.visibleOccurrences.length > 0
      ? next.visibleOccurrences.some((occ) => occ.canonicalEvidence === baselineCanonical)
      : next.canonicalEvidence === baselineCanonical;

  if (!hasMatchingVisibleOccurrence) {
    return { changeKind: 'changed', changeReason: 'EVIDENCE_CHANGED' };
  }

  return { changeKind: 'same', changeReason: null };
}

/**
 * Carry-over Rule A′ — Step B: carry baseline review iff `changeKind === 'same'` and baseline has
 * a current review whose decision is NOT `'revert'` (spec §5.6).
 */
export function decideCarry(
  classification: ChangeClassification,
  baseReview: BaselineReviewRef | null,
): string | null {
  if (classification.changeKind !== 'same') {
    return null;
  }
  if (!baseReview || baseReview.decision === 'revert') {
    return null;
  }
  return baseReview.id;
}
