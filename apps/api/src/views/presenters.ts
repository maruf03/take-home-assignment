import type {
  DocumentDetailDto,
  DocumentSummaryDto,
  EvidenceDto,
  Progress,
  ReviewDto,
  ValueViewDto,
  VersionSummaryDto,
} from '@app/contracts/dto';
import { VERSION_ERROR_CODES, retryableHint, type VersionErrorCode } from '@app/contracts/problems';
import type {
  AttentionBucket,
  ChangeKind,
  ChangeReason,
  ExtractedValueKind,
  FieldType,
  GapCode,
  MatchMode,
  ReviewDecision,
  ReviewOrigin,
  ReviewState,
  ValueFlag,
  VersionOrigin,
  VersionStatus,
  VersionWarning,
} from '@app/contracts/status';
import type { TypedValue } from '@app/contracts/values';
import { foldCurlyQuotes, lineIndex, lineNumberAtOffset } from '@app/core';
import type {
  BaselineReadRow,
  DocumentContext,
  DocumentRow,
  ReviewRow,
  ValueReadRow,
  VersionWithTemplateVersion,
} from '@app/db';

const MAX_OTHER_OCCURRENCES = 20;
const ATTENTION_ORDER: Readonly<Record<AttentionBucket, number>> = {
  changed: 0,
  gap: 1,
  pending: 2,
  done: 3,
};

export function iso(date: Date): string {
  return date.toISOString();
}

const VERSION_ERROR_CODE_SET: ReadonlySet<string> = new Set(VERSION_ERROR_CODES);

export function toVersionSummary(
  row: VersionWithTemplateVersion,
  document: Pick<DocumentRow, 'reviewableVersionId' | 'deletedAt'>,
): VersionSummaryDto {
  const { version } = row;
  const code = version.lastErrorCode;
  const error =
    version.status === 'failed' && code !== null && VERSION_ERROR_CODE_SET.has(code)
      ? {
          code: code as VersionErrorCode,
          message: version.lastErrorMessage ?? '',
          retryable: retryableHint(code as VersionErrorCode),
        }
      : null;
  return {
    number: version.versionNumber,
    status: version.status as VersionStatus,
    origin: version.origin as VersionOrigin,
    sourceVersionNumber: row.sourceVersionNumber,
    templateVersion: row.templateVersion,
    parser: version.parser,
    warnings: version.warnings as VersionWarning[],
    error,
    attempts: version.attempts,
    createdAt: iso(version.createdAt),
    extractedAt: version.extractedAt ? iso(version.extractedAt) : null,
    reviewable: document.deletedAt === null && document.reviewableVersionId === version.id,
  };
}

function toReviewDto(review: ReviewRow, carriedFromVersion: number | null): ReviewDto {
  return {
    id: review.id,
    decision: review.decision as ReviewDecision,
    correctedValue: (review.correctedValue as TypedValue | null) ?? null,
    note: review.note,
    origin: review.origin as ReviewOrigin,
    carriedFromVersion,
    createdAt: iso(review.createdAt),
  };
}

export function toReviewListItem(review: ReviewRow, carried: Map<string, number>): ReviewDto {
  return toReviewDto(
    review,
    review.carriedFromReviewId !== null ? (carried.get(review.carriedFromReviewId) ?? null) : null,
  );
}

function reviewStateOf(review: ReviewRow | null): ReviewState {
  if (review === null || review.decision === 'revert') return 'pending';
  if (review.origin === 'carried') return 'carried_over';
  return review.decision === 'correct' ? 'corrected' : 'approved';
}

function effectiveValueOf(value: TypedValue | null, review: ReviewRow | null): TypedValue | null {
  if (review?.decision === 'correct') {
    return (review.correctedValue as TypedValue | null) ?? null;
  }
  return value;
}

function findOtherOccurrences(
  text: string,
  quote: string,
  start: number,
  end: number,
  hidden: ReadonlyArray<readonly [number, number, string]>,
  matchMode: MatchMode,
): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  if (quote.length === 0) return out;
  const haystack = matchMode === 'quote_folded' ? foldCurlyQuotes(text) : text;
  const needle = matchMode === 'quote_folded' ? foldCurlyQuotes(quote) : quote;
  let from = 0;
  while (out.length < MAX_OTHER_OCCURRENCES) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) break;
    const occEnd = idx + needle.length;
    from = idx + 1;
    if (idx === start && occEnd === end) continue;
    if (hidden.some(([hs, he]) => idx < he && occEnd > hs)) continue;
    out.push({ start: idx, end: occEnd });
  }
  return out;
}

interface TextContext {
  readonly parsedText: string | null;
  readonly hidden: ReadonlyArray<readonly [number, number, string]>;
}

function toEvidence(row: ValueReadRow, text: TextContext): EvidenceDto | null {
  const v = row.value;
  if (
    v.kind !== 'value' ||
    v.evidence === null ||
    v.evidenceStart === null ||
    v.evidenceEnd === null ||
    v.matchMode === null
  ) {
    return null;
  }
  const parsed = text.parsedText;
  const line = parsed ? lineNumberAtOffset(lineIndex(parsed), v.evidenceStart) : 1;
  const matchMode = v.matchMode as MatchMode;
  return {
    quote: v.evidence,
    line,
    start: v.evidenceStart,
    end: v.evidenceEnd,
    matchCount: v.evidenceMatchCount ?? 1,
    matchMode,
    citedLine: v.citedLine,
    otherOccurrences: parsed
      ? findOtherOccurrences(
          parsed,
          v.evidence,
          v.evidenceStart,
          v.evidenceEnd,
          text.hidden,
          matchMode,
        )
      : [],
  };
}

function toPrevious(baseline: BaselineReadRow): NonNullable<ValueViewDto['previous']> {
  const v = baseline.value;
  const parsed = baseline.parsedText;
  return {
    versionNumber: baseline.versionNumber,
    valueId: v.id,
    kind: v.kind as ExtractedValueKind,
    value: (v.value as TypedValue | null) ?? null,
    effectiveValue: effectiveValueOf((v.value as TypedValue | null) ?? null, baseline.review),
    evidence:
      v.kind === 'value' && v.evidence !== null && v.evidenceStart !== null
        ? {
            quote: v.evidence,
            line: parsed ? lineNumberAtOffset(lineIndex(parsed), v.evidenceStart) : 1,
          }
        : null,
    gap:
      v.kind === 'gap' && v.gapCode !== null
        ? { code: v.gapCode as GapCode, reason: v.gapReason ?? '' }
        : null,
    review: baseline.review
      ? toReviewDto(baseline.review, baseline.reviewCarriedFromVersion)
      : null,
  };
}

export function toValueView(
  row: ValueReadRow,
  text: TextContext,
  reviewable: boolean,
): ValueViewDto {
  const v = row.value;
  const value = (v.value as TypedValue | null) ?? null;
  const reviewState = reviewStateOf(row.review);
  const attention: AttentionBucket =
    reviewState !== 'pending'
      ? 'done'
      : v.changeKind === 'changed'
        ? 'changed'
        : v.kind === 'gap'
          ? 'gap'
          : 'pending';
  return {
    id: v.id,
    fieldKey: v.fieldKey,
    label: row.label,
    fieldType: v.fieldType as FieldType,
    position: row.position,
    kind: v.kind as ExtractedValueKind,
    value,
    effectiveValue: effectiveValueOf(value, row.review),
    evidence: toEvidence(row, text),
    gap:
      v.kind === 'gap' && v.gapCode !== null
        ? {
            code: v.gapCode as GapCode,
            reason: v.gapReason ?? '',
            attemptedQuote: v.attemptedQuote,
          }
        : null,
    flags: v.flags as ValueFlag[],
    changeKind: v.changeKind as ChangeKind,
    changeReason: (v.changeReason as ChangeReason | null) ?? null,
    reviewState,
    attention,
    review: row.review ? toReviewDto(row.review, row.reviewCarriedFromVersion) : null,
    previous: row.baseline ? toPrevious(row.baseline) : null,
    reviewable,
  };
}

export function textContextOf(
  version: { parsedText: string | null; textRanges: unknown } | null,
): TextContext {
  const ranges = version?.textRanges as { hidden?: Array<[number, number, string]> } | null;
  return { parsedText: version?.parsedText ?? null, hidden: ranges?.hidden ?? [] };
}

export function sortValueViews(views: ValueViewDto[]): ValueViewDto[] {
  return [...views].sort(
    (a, b) =>
      ATTENTION_ORDER[a.attention] - ATTENTION_ORDER[b.attention] || a.position - b.position,
  );
}

export function toDocumentSummary(ctx: DocumentContext, progress: Progress): DocumentSummaryDto {
  const { document } = ctx;
  return {
    id: document.id,
    externalId: document.externalId,
    type: document.type,
    typeLabel: ctx.typeLabel,
    title: document.title,
    status: ctx.latest.version.status as VersionStatus,
    currentVersion: toVersionSummary(ctx.latest, document),
    valuesVersion: ctx.reviewable ? ctx.reviewable.version.versionNumber : null,
    progress,
    needsReview: document.pendingCount > 0,
    deletedAt: document.deletedAt ? iso(document.deletedAt) : null,
    createdAt: iso(document.createdAt),
  };
}

export interface DocumentDetailParts {
  readonly values: ValueViewDto[];
  readonly recentVersions: VersionSummaryDto[];
}

export function toDocumentDetail(
  ctx: DocumentContext,
  parts: DocumentDetailParts,
): DocumentDetailDto {
  const reviewableVersion = ctx.reviewable?.version ?? null;
  const ranges = reviewableVersion?.textRanges as {
    hidden: Array<[number, number, string]>;
    lowVisibility: Array<[number, number]>;
  } | null;
  return {
    ...toDocumentSummary(ctx, ctx.progress),
    values: parts.values,
    valuesTextMeta:
      reviewableVersion && ranges && reviewableVersion.pageOffsets
        ? { textRanges: ranges, pageOffsets: reviewableVersion.pageOffsets }
        : null,
    recentVersions: parts.recentVersions,
    versionsCount: ctx.document.latestVersionNumber,
    links: { versions: `/documents/${ctx.document.id}/versions` },
  };
}
