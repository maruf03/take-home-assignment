import type { EvidenceDto, TextRanges } from '@app/contracts/dto';
import { useEffect, useMemo, useRef, useState } from 'react';
import { fileDownloadUrl } from '../../shared/api/client.js';
import { buildDocumentLines, type TextSegment } from '../../shared/lib/text-segments.js';

const VIRTUALIZE_THRESHOLD = 2000;
const LINE_HEIGHT_PX = 22;
const OVERSCAN_LINES = 30;
const DEFAULT_VIEWPORT_PX = 660;

export interface TextPaneProps {
  readonly documentId: string;
  readonly versionNumber: number;
  readonly text: string | null;
  readonly loading: boolean;
  readonly error: Error | null;
  readonly textRanges: TextRanges | null;
  readonly activeEvidence: EvidenceDto | null;
  readonly activeFieldLabel: string | null;
  readonly hash?: string;
}

function parseHashLine(hash: string | undefined): number | null {
  if (!hash) return null;
  const match = /^#L(\d+)$/.exec(hash);
  if (!match) return null;
  const num = Number(match[1]);
  return Number.isInteger(num) && num >= 1 ? num : null;
}

function renderSegment(seg: TextSegment, idx: number, segments: readonly TextSegment[]) {
  const classes: string[] = [];
  const titles: string[] = [];

  if (seg.active) {
    classes.push('evidence-mark');
  }
  if (seg.hiddenReason !== null) {
    classes.push('text-hidden-pdf');
    titles.push(`Hidden in PDF (${seg.hiddenReason})`);
  }
  if (seg.otherOccurrence) {
    classes.push('evidence-other-occurrence');
    titles.push('Other matching occurrence');
  }
  if (seg.lowVisibility) {
    classes.push('text-low-visibility');
    titles.push('Low-visibility text in PDF');
  }

  const nextSeg = segments[idx + 1];
  const isEndOfHiddenRun = seg.hiddenReason !== null && nextSeg?.hiddenReason !== seg.hiddenReason;

  const hiddenBadge = isEndOfHiddenRun ? (
    <>
      {' '}
      <span className="ml-1 inline-block rounded bg-gray-200 px-1 text-[10px] font-sans font-medium text-gray-700">
        hidden in PDF
      </span>
    </>
  ) : null;

  const title = titles.length > 0 ? titles.join(' · ') : undefined;
  const className = classes.length > 0 ? classes.join(' ') : undefined;

  if (seg.active) {
    return (
      <mark key={idx} data-testid="active-evidence-mark" className={className} title={title}>
        {seg.text}
        {hiddenBadge}
      </mark>
    );
  }

  const testId =
    seg.hiddenReason !== null
      ? 'hidden-text-span'
      : seg.otherOccurrence
        ? 'other-occurrence-span'
        : seg.lowVisibility
          ? 'low-visibility-span'
          : undefined;

  return (
    <span key={idx} data-testid={testId} className={className} title={title}>
      {seg.text}
      {hiddenBadge}
    </span>
  );
}

/**
 * Right-hand source text viewer (spec §14.2):
 * - Renders `L###` line gutter with `#L{n}` deep links.
 * - Highlights active evidence `<mark>`, dotted other occurrences, hatched hidden ranges,
 *   and dashed low-visibility ranges directly from stored offsets.
 * - Virtualizes window rendering when line count exceeds 2,000.
 * - Provides a direct download link for the original PDF.
 */
export function TextPane({
  documentId,
  versionNumber,
  text,
  loading,
  error,
  textRanges,
  activeEvidence,
  activeFieldLabel,
  hash,
}: TextPaneProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(DEFAULT_VIEWPORT_PX);
  const lastScrolledKeyRef = useRef<string | null>(null);

  // Reset scroll state when switching document or version.
  useEffect(() => {
    setScrollTop(0);
    lastScrolledKeyRef.current = null;
    if (scrollRef.current) {
      scrollRef.current.scrollTop = 0;
    }
  }, [documentId, versionNumber]);

  const lines = useMemo(() => {
    if (text === null) return [];
    return buildDocumentLines(text, {
      activeRange: activeEvidence ? { start: activeEvidence.start, end: activeEvidence.end } : null,
      otherOccurrences: activeEvidence?.otherOccurrences ?? [],
      textRanges,
    });
  }, [text, activeEvidence, textRanges]);

  const isVirtualized = lines.length > VIRTUALIZE_THRESHOLD;

  const visibleSlice = useMemo(() => {
    if (!isVirtualized) {
      return { startIdx: 0, endIdx: lines.length, topPad: 0, bottomPad: 0 };
    }
    const visibleLines = Math.max(
      60,
      Math.ceil(viewportHeight / LINE_HEIGHT_PX) + OVERSCAN_LINES * 2,
    );
    const startIdx = Math.max(0, Math.floor(scrollTop / LINE_HEIGHT_PX) - OVERSCAN_LINES);
    const endIdx = Math.min(lines.length, startIdx + visibleLines);
    return {
      startIdx,
      endIdx,
      topPad: startIdx * LINE_HEIGHT_PX,
      bottomPad: Math.max(0, (lines.length - endIdx) * LINE_HEIGHT_PX),
    };
  }, [isVirtualized, lines.length, scrollTop, viewportHeight]);

  const hashLine = parseHashLine(hash);
  const targetLine = hashLine ?? activeEvidence?.line ?? null;
  const scrollKey =
    targetLine !== null
      ? `${documentId}:${versionNumber}:${hashLine !== null ? `hash:${hashLine}` : `ev:${activeEvidence?.start ?? 0}:${targetLine}`}`
      : null;

  useEffect(() => {
    if (
      targetLine === null ||
      scrollKey === null ||
      lines.length === 0 ||
      !scrollRef.current ||
      lastScrolledKeyRef.current === scrollKey
    ) {
      return;
    }
    const clampedLine = Math.min(Math.max(1, targetLine), lines.length);
    const target = scrollRef.current.querySelector<HTMLElement>(`#L${clampedLine}`);
    if (target) {
      if (typeof target.scrollIntoView === 'function') {
        target.scrollIntoView({ block: 'center' });
      }
      lastScrolledKeyRef.current = scrollKey;
    } else if (isVirtualized) {
      const nextScrollTop = Math.max(0, (clampedLine - 10) * LINE_HEIGHT_PX);
      scrollRef.current.scrollTop = nextScrollTop;
      setScrollTop(nextScrollTop);
    }
  }, [
    targetLine,
    scrollKey,
    lines.length,
    isVirtualized,
    visibleSlice.startIdx,
    visibleSlice.endIdx,
  ]);

  const pdfHref = fileDownloadUrl(documentId, versionNumber);

  return (
    <section
      aria-label="Document source text"
      className="flex h-full flex-col rounded border border-[var(--color-border)] bg-[var(--color-surface)]"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--color-border)] bg-[var(--color-surface-subtle)] px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-[var(--color-ink)]">Source text</span>
          {activeEvidence && activeFieldLabel ? (
            <span className="text-xs text-[var(--color-ink-muted)]">
              Evidence for {activeFieldLabel}, line {activeEvidence.line}
            </span>
          ) : null}
        </div>
        <a
          href={pdfHref}
          download
          className="inline-flex min-h-8 items-center rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1 text-xs font-medium text-[var(--color-accent)] hover:bg-blue-50"
        >
          Download original PDF
        </a>
      </div>

      <div
        ref={scrollRef}
        onScroll={
          isVirtualized
            ? (e) => {
                setScrollTop(e.currentTarget.scrollTop);
                if (e.currentTarget.clientHeight > 0) {
                  setViewportHeight(e.currentTarget.clientHeight);
                }
              }
            : undefined
        }
        className="max-h-[75vh] flex-1 overflow-auto p-2 font-mono text-xs leading-[22px]"
      >
        {loading ? (
          <p className="p-3 font-sans text-sm text-[var(--color-ink-muted)]">
            Loading parsed text…
          </p>
        ) : error ? (
          <p role="alert" className="p-3 font-sans text-sm text-[var(--color-gap)]">
            Parsed text is not available for this version yet.
          </p>
        ) : lines.length === 0 ? (
          <p className="p-3 font-sans text-sm text-[var(--color-ink-muted)]">
            No parsed text available yet.
          </p>
        ) : (
          <div
            style={
              isVirtualized
                ? { paddingTop: visibleSlice.topPad, paddingBottom: visibleSlice.bottomPad }
                : undefined
            }
          >
            {lines.slice(visibleSlice.startIdx, visibleSlice.endIdx).map((line) => (
              <div
                key={line.lineNumber}
                id={`L${line.lineNumber}`}
                className="flex gap-3 whitespace-pre-wrap break-words hover:bg-[var(--color-surface-subtle)]"
              >
                <a
                  href={`#L${line.lineNumber}`}
                  className="tabular-nums w-11 shrink-0 select-none text-right text-[var(--color-ink-muted)] hover:text-[var(--color-accent)]"
                >
                  L{line.lineNumber}
                </a>
                <span className="min-w-0 flex-1">
                  {line.segments.map((seg, idx) => renderSegment(seg, idx, line.segments))}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
