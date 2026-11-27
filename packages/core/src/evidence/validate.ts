import type { TextRanges } from '@app/contracts/dto';
import type { FieldType, GapCode, MatchMode, ValueFlag } from '@app/contracts/status';
import {
  equalValues,
  formatTypedValue,
  parseTypedValue,
  type TypedValue,
} from '@app/contracts/values';
import { findLinesTouchingSpan, lineIndex, lineNumberAtOffset } from '../text/lines.js';
import {
  buildNormIndex,
  findAllNormalizedOccurrences,
  foldCurlyQuotes,
  matchNormalize,
} from '../text/normalize.js';
import type {
  ExtractionTemplateSpec,
  ParsedToolOutput,
  TemplateFieldSpec,
  ValidatedFieldResult,
  ValidatedGapResult,
  ValidatedValueResult,
  VisibleEvidenceOccurrence,
} from '../types.js';
import {
  analyzeLineAnchor,
  countDistinctTokenValues,
  extractTypedTokens,
  supportedByString,
  type ExtractedToken,
} from './tokenizers.js';

export interface ValidateExtractionOptions {
  chunkIndex?: number | null;
}

function spansOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

function overlapsHidden(start: number, end: number, ranges: TextRanges): boolean {
  return ranges.hidden.some(([hs, he]) => spansOverlap(start, end, hs, he));
}

function overlapsLowVisibility(start: number, end: number, ranges: TextRanges): boolean {
  return ranges.lowVisibility.some(([ls, le]) => spansOverlap(start, end, ls, le));
}

function stripLinePrefixes(quote: string): string {
  return quote
    .split(/\r?\n/u)
    .map((line) => line.replace(/^L\d+\|\s?/u, ''))
    .join('\n');
}

function formatRawValue(raw: unknown): string | null {
  if (raw === null || raw === undefined) {
    return null;
  }
  if (typeof raw === 'string') {
    return raw;
  }
  if (typeof raw === 'object' && 'amount' in raw && 'currency' in raw) {
    const rec = raw as { amount: unknown; currency: unknown };
    return `${String(rec.amount)} ${String(rec.currency)}`.trim();
  }
  return String(raw);
}

function makeGap(
  field: TemplateFieldSpec,
  gapCode: GapCode,
  gapReason: string,
  extra: {
    rawValue?: string | null;
    attemptedQuote?: string | null;
    citedLine?: number | null;
    chunkIndex?: number | null;
  } = {},
): ValidatedGapResult {
  return {
    fieldKey: field.fieldKey,
    fieldType: field.fieldType,
    kind: 'gap',
    value: null,
    rawValue: extra.rawValue ?? null,
    evidence: null,
    attemptedQuote: extra.attemptedQuote ?? null,
    canonicalEvidence: null,
    evidenceStart: null,
    evidenceEnd: null,
    evidenceMatchCount: null,
    citedLine: extra.citedLine ?? null,
    matchMode: null,
    chunkIndex: extra.chunkIndex ?? null,
    gapCode,
    gapReason,
    flags: [],
    visibleOccurrences: [],
  };
}

interface SupportedOccurrence {
  readonly start: number;
  readonly end: number;
  readonly line: number;
  readonly canonicalEvidence: string;
  readonly tokens: readonly ExtractedToken[];
  readonly matchingTokens: readonly ExtractedToken[];
}

function checkSupport(
  fieldType: FieldType,
  canonicalValue: TypedValue,
  spanText: string,
  dateOrder: ExtractionTemplateSpec['dateOrder'],
): { supported: boolean; tokens: ExtractedToken[]; matchingTokens: ExtractedToken[] } {
  if (fieldType === 'string') {
    const supported =
      typeof canonicalValue === 'string' && supportedByString(canonicalValue, spanText);
    return { supported, tokens: [], matchingTokens: [] };
  }

  const tokens = extractTypedTokens(fieldType, spanText, dateOrder);
  const matchingTokens = tokens.filter((tok) => equalValues(fieldType, tok.value, canonicalValue));
  return {
    supported: matchingTokens.length > 0,
    tokens,
    matchingTokens,
  };
}

/**
 * Validates every template field against stored text and ranges (spec §5.5 steps 1–10).
 */
export function validateExtraction(
  template: ExtractionTemplateSpec,
  text: string,
  ranges: TextRanges,
  parsedOutput: ParsedToolOutput,
  options: ValidateExtractionOptions = {},
): ValidatedFieldResult[] {
  const chunkIndex = options.chunkIndex ?? null;
  const normIndex = buildNormIndex(text);
  const lines = lineIndex(text);
  const visibleLines = lines.filter((l) => !overlapsHidden(l.start, l.end, ranges));

  const results: ValidatedFieldResult[] = [];

  for (const field of template.fields) {
    const candidate = parsedOutput.fields[field.fieldKey];

    // Step 1: Field missing from envelope -> MODEL_OMITTED.
    if (!candidate) {
      results.push(
        makeGap(field, 'MODEL_OMITTED', `Model omitted field "${field.fieldKey}" from output`, {
          chunkIndex,
        }),
      );
      continue;
    }

    const rawValueStr = candidate.rawValue ?? formatRawValue(candidate.value);
    const citedLine = candidate.line !== null && candidate.line >= 1 ? candidate.line : null;

    // Step 2: found=false or value null -> NOT_FOUND.
    if (!candidate.found || candidate.value === null) {
      results.push(
        makeGap(
          field,
          'NOT_FOUND',
          candidate.notFoundReason?.trim() || `Field "${field.label}" was not found in document`,
          { rawValue: rawValueStr, citedLine, chunkIndex },
        ),
      );
      continue;
    }

    // Step 3: quote null or empty -> EVIDENCE_NOT_IN_TEXT.
    if (candidate.quote === null || candidate.quote.trim().length === 0) {
      results.push(
        makeGap(field, 'EVIDENCE_NOT_IN_TEXT', 'Model returned no verbatim evidence quote', {
          rawValue: rawValueStr,
          attemptedQuote: candidate.quote,
          citedLine,
          chunkIndex,
        }),
      );
      continue;
    }

    const attemptedQuote = candidate.quote;

    // Step 4: parseTypedValue fails -> UNPARSEABLE_VALUE.
    const parsedVal = parseTypedValue(field.fieldType, candidate.value, {
      defaultCurrency: template.defaultCurrency,
      dateOrder: template.dateOrder,
    });
    if (!parsedVal.ok) {
      results.push(
        makeGap(field, 'UNPARSEABLE_VALUE', parsedVal.error, {
          rawValue: rawValueStr,
          attemptedQuote,
          citedLine,
          chunkIndex,
        }),
      );
      continue;
    }
    const canonicalValue = parsedVal.value;

    // Step 5: strip leading L###| prefixes; find all occurrences of M(quote) in M(text);
    // retry once with curly quotes folded in the quote only.
    const strippedQuote = stripLinePrefixes(attemptedQuote);
    const strictNormQuote = matchNormalize(strippedQuote);
    let matchMode: MatchMode = 'strict';
    let rawOccurrences = findAllNormalizedOccurrences(normIndex, strictNormQuote);

    if (rawOccurrences.length === 0) {
      const foldedNormQuote = matchNormalize(foldCurlyQuotes(strippedQuote));
      if (foldedNormQuote !== strictNormQuote) {
        rawOccurrences = findAllNormalizedOccurrences(normIndex, foldedNormQuote);
        if (rawOccurrences.length > 0) {
          matchMode = 'quote_folded';
        }
      }
    }

    if (rawOccurrences.length === 0) {
      results.push(
        makeGap(
          field,
          'EVIDENCE_NOT_IN_TEXT',
          'Evidence quote does not appear verbatim in parsed text',
          {
            rawValue: rawValueStr,
            attemptedQuote,
            citedLine,
            chunkIndex,
          },
        ),
      );
      continue;
    }

    // Step 6: filter hidden occurrences; if all intersect hidden text -> EVIDENCE_HIDDEN.
    const visibleRawOccurrences = rawOccurrences.filter(
      (occ) => !overlapsHidden(occ.start, occ.end, ranges),
    );
    if (visibleRawOccurrences.length === 0) {
      results.push(
        makeGap(
          field,
          'EVIDENCE_HIDDEN',
          'Evidence quote only appears inside hidden/off-page text',
          {
            rawValue: rawValueStr,
            attemptedQuote,
            citedLine,
            chunkIndex,
          },
        ),
      );
      continue;
    }

    // Step 7: value support check inside each visible occurrence.
    // For scalar types, also verify alignment against tokens extracted from the full enclosing
    // touched line(s) so substring quotes cannot truncate decimals (`$1,234` in `$1,234.56`),
    // strip signs (`$1,234.56` in `($1,234.56)`), or bypass model-code/list-ordinal/disagreement guards.
    const supportedOccurrences: SupportedOccurrence[] = [];
    for (const occ of visibleRawOccurrences) {
      const spanText = text.slice(occ.start, occ.end);
      const support = checkSupport(field.fieldType, canonicalValue, spanText, template.dateOrder);
      if (!support.supported) {
        continue;
      }
      const touched = findLinesTouchingSpan(lines, occ.start, occ.end);
      if (field.fieldType !== 'string' && touched.length > 0) {
        const enclosingStart = touched[0]!.start;
        const enclosingEnd = touched[touched.length - 1]!.end;
        const enclosingText = text.slice(enclosingStart, enclosingEnd);
        const relStart = occ.start - enclosingStart;
        const relEnd = occ.end - enclosingStart;
        const enclosingTokens = extractTypedTokens(
          field.fieldType,
          enclosingText,
          template.dateOrder,
        );
        const alignedEnclosing = enclosingTokens.some(
          (et) =>
            spansOverlap(et.start, et.end, relStart, relEnd) &&
            equalValues(field.fieldType, et.value, canonicalValue),
        );
        if (!alignedEnclosing) {
          continue;
        }
      }

      const canonicalEvidence = matchNormalize(touched.map((l) => l.text).join(' '));
      const line = lineNumberAtOffset(lines, occ.start);
      supportedOccurrences.push({
        start: occ.start,
        end: occ.end,
        line,
        canonicalEvidence,
        tokens: support.tokens,
        matchingTokens: support.matchingTokens,
      });
    }

    if (supportedOccurrences.length === 0) {
      results.push(
        makeGap(
          field,
          'VALUE_NOT_SUPPORTED',
          'Extracted value is not supported by any typed token inside the evidence quote',
          {
            rawValue: rawValueStr,
            attemptedQuote,
            citedLine,
            chunkIndex,
          },
        ),
      );
      continue;
    }

    // Step 8: select nearest to citedLine, then earliest start.
    const sortedSupported = [...supportedOccurrences].sort((a, b) => {
      if (citedLine !== null) {
        const distA = Math.abs(a.line - citedLine);
        const distB = Math.abs(b.line - citedLine);
        if (distA !== distB) {
          return distA - distB;
        }
      }
      return a.start - b.start;
    });
    const chosen = sortedSupported[0]!;

    const flagsSet = new Set<ValueFlag>();

    if (matchMode === 'quote_folded') {
      flagsSet.add('QUOTE_FOLDED');
    }

    if (field.fieldType !== 'string') {
      if (countDistinctTokenValues(field.fieldType, chosen.tokens) > 1) {
        flagsSet.add('TOKEN_AMBIGUOUS');
      }
      if (
        field.fieldType === 'date' &&
        chosen.matchingTokens.some((tok) => tok.ambiguousDate === true)
      ) {
        flagsSet.add('AMBIGUOUS_DATE');
      }
    }

    if (citedLine !== null && chosen.line !== citedLine) {
      flagsSet.add('LINE_HINT_MISMATCH');
    }

    const distinctLines = new Set(supportedOccurrences.map((o) => o.line));
    if (distinctLines.size > 1) {
      flagsSet.add('AMBIGUOUS_OCCURRENCE');
    }

    // Step 9: WEAK_EVIDENCE_LINE, CONFLICTING_LINES (scalars only), LOW_VISIBILITY.
    if (field.fieldType !== 'string') {
      const anchor = analyzeLineAnchor(
        field.fieldType,
        chosen.canonicalEvidence,
        template.dateOrder,
      );
      if (anchor.isWeak) {
        flagsSet.add('WEAK_EVIDENCE_LINE');
      }
      if (anchor.letterCount >= 2) {
        const prefixLower = anchor.labelAnchor.toLowerCase();
        const chosenLineNums = new Set(
          findLinesTouchingSpan(lines, chosen.start, chosen.end).map((l) => l.lineNumber),
        );
        for (const other of visibleLines) {
          if (chosenLineNums.has(other.lineNumber)) {
            continue;
          }
          const otherNorm = matchNormalize(other.text);
          const otherAnchor = analyzeLineAnchor(field.fieldType, otherNorm, template.dateOrder);
          if (
            !otherAnchor.labelAnchor.toLowerCase().startsWith(prefixLower) &&
            !otherNorm.toLowerCase().startsWith(prefixLower)
          ) {
            continue;
          }
          const otherTokens = extractTypedTokens(field.fieldType, otherNorm, template.dateOrder);
          if (otherTokens.some((tok) => !equalValues(field.fieldType, tok.value, canonicalValue))) {
            flagsSet.add('CONFLICTING_LINES');
            break;
          }
        }
      }
    }

    if (overlapsLowVisibility(chosen.start, chosen.end, ranges)) {
      flagsSet.add('LOW_VISIBILITY');
    }

    const visibleOccurrences: VisibleEvidenceOccurrence[] = supportedOccurrences.map((o) => ({
      start: o.start,
      end: o.end,
      line: o.line,
      canonicalEvidence: o.canonicalEvidence,
    }));

    const valueResult: ValidatedValueResult = {
      fieldKey: field.fieldKey,
      fieldType: field.fieldType,
      kind: 'value',
      value: canonicalValue,
      rawValue: rawValueStr ?? formatTypedValue(field.fieldType, canonicalValue),
      evidence: text.slice(chosen.start, chosen.end),
      canonicalEvidence: chosen.canonicalEvidence,
      evidenceStart: chosen.start,
      evidenceEnd: chosen.end,
      evidenceMatchCount: supportedOccurrences.length,
      citedLine,
      matchMode,
      chunkIndex,
      gapCode: null,
      gapReason: null,
      attemptedQuote: null,
      flags: [...flagsSet].sort(),
      visibleOccurrences,
    };

    results.push(valueResult);
  }

  return results;
}

const GAP_MERGE_PRIORITY: Readonly<Record<GapCode, number>> = {
  EVIDENCE_HIDDEN: 1,
  VALUE_NOT_SUPPORTED: 2,
  EVIDENCE_NOT_IN_TEXT: 3,
  UNPARSEABLE_VALUE: 4,
  CONFLICTING_EVIDENCE: 5,
  NOT_FOUND: 6,
  MODEL_OMITTED: 7,
};

/**
 * Merges per-chunk validated extraction results for each field (spec §5.4):
 * - 1 distinct canonical value across chunks -> earliest occurrence by `evidenceStart` wins
 * - >1 distinct canonical values -> gap `CONFLICTING_EVIDENCE` listing each value and line
 * - 0 validated values -> highest-priority gap (`EVIDENCE_HIDDEN > VALUE_NOT_SUPPORTED > EVIDENCE_NOT_IN_TEXT > NOT_FOUND`)
 */
export function mergeChunkResults(
  template: ExtractionTemplateSpec,
  chunkResults: readonly (readonly ValidatedFieldResult[])[],
): ValidatedFieldResult[] {
  const merged: ValidatedFieldResult[] = [];

  for (const field of template.fields) {
    const fieldResults: ValidatedFieldResult[] = [];
    for (const chunk of chunkResults) {
      const found = chunk.find((r) => r.fieldKey === field.fieldKey);
      if (found) {
        fieldResults.push(found);
      }
    }

    const values = fieldResults.filter((r): r is ValidatedValueResult => r.kind === 'value');
    if (values.length > 0) {
      // Group distinct canonical values.
      const distinctGroups: ValidatedValueResult[][] = [];
      for (const val of values) {
        const group = distinctGroups.find((g) =>
          equalValues(field.fieldType, g[0]!.value, val.value),
        );
        if (group) {
          group.push(val);
        } else {
          distinctGroups.push([val]);
        }
      }

      if (distinctGroups.length === 1) {
        const sorted = [...distinctGroups[0]!].sort(
          (a, b) => a.evidenceStart - b.evidenceStart || (a.chunkIndex ?? 0) - (b.chunkIndex ?? 0),
        );
        merged.push(sorted[0]!);
      } else {
        const summary = distinctGroups
          .map((g) => {
            const earliest = [...g].sort(
              (a, b) =>
                a.evidenceStart - b.evidenceStart || (a.chunkIndex ?? 0) - (b.chunkIndex ?? 0),
            )[0]!;
            const formatted = formatTypedValue(field.fieldType, earliest.value);
            const lineNum = earliest.visibleOccurrences[0]?.line ?? earliest.citedLine ?? '?';
            return `${formatted} (line ${lineNum})`;
          })
          .join(' vs ');
        merged.push(
          makeGap(
            field,
            'CONFLICTING_EVIDENCE',
            `Conflicting values extracted across chunks: ${summary}`,
          ),
        );
      }
      continue;
    }

    const gaps = fieldResults.filter((r): r is ValidatedGapResult => r.kind === 'gap');
    if (gaps.length === 0) {
      merged.push(makeGap(field, 'MODEL_OMITTED', `Model omitted field "${field.fieldKey}"`));
      continue;
    }

    gaps.sort((a, b) => {
      const prioDiff = GAP_MERGE_PRIORITY[a.gapCode] - GAP_MERGE_PRIORITY[b.gapCode];
      if (prioDiff !== 0) {
        return prioDiff;
      }
      const aHasQuote = a.attemptedQuote ? 0 : 1;
      const bHasQuote = b.attemptedQuote ? 0 : 1;
      return aHasQuote - bHasQuote;
    });
    merged.push(gaps[0]!);
  }

  return merged;
}
