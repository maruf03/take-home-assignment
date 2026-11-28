import type { ValueViewDto } from '@app/contracts/dto';
import { getUiCopy } from '@app/contracts/ui-copy';
import { formatTypedValue } from '@app/contracts/values';
import type { ReactNode } from 'react';
import { formatCopy, VISIBLE_REVIEWER_FLAGS } from '../../shared/lib/format.js';
import { diffTokens } from '../../shared/lib/token-diff.js';
import { Badge, type BadgeTone } from '../../shared/ui/Primitives.js';

function stateBadgeFor(value: ValueViewDto): { icon: string; label: string; tone: BadgeTone } {
  if (value.reviewState === 'approved') return { icon: '✓', label: 'Approved', tone: 'done' };
  if (value.reviewState === 'corrected')
    return { icon: '✎', label: 'Corrected', tone: 'corrected' };
  if (value.reviewState === 'carried_over') {
    const fromV = value.review?.carriedFromVersion;
    const dec = value.review?.decision === 'correct' ? 'corrected' : 'approved';
    return {
      icon: '↪',
      label: fromV ? `Carried from v${fromV}, ${dec}` : `Carried, ${dec}`,
      tone: 'done',
    };
  }
  if (value.attention === 'changed') return { icon: '△', label: 'Changed', tone: 'attention' };
  if (value.kind === 'gap') return { icon: '✕', label: 'Gap', tone: 'gap' };
  return { icon: '○', label: 'Pending', tone: 'neutral' };
}

export interface ValueRowProps {
  readonly value: ValueViewDto;
  readonly selected: boolean;
  readonly onSelect: (value: ValueViewDto) => void;
  readonly actions?: ReactNode;
  readonly editor?: ReactNode;
  readonly conflict?: ReactNode;
}

/**
 * Displays a single extracted value or gap with its effective value, state badge, verbatim
 * evidence quote from stored offsets, changed-value comparison with token diff, visible flags
 * (never LINE_HINT_MISMATCH), review actions, inline correction editor, and conflict card slots.
 */
export function ValueRow({ value, selected, onSelect, actions, editor, conflict }: ValueRowProps) {
  const badge = stateBadgeFor(value);
  const effectiveText =
    value.effectiveValue !== null ? formatTypedValue(value.fieldType, value.effectiveValue) : '—';
  const extractedText =
    value.value !== null ? formatTypedValue(value.fieldType, value.value) : null;
  const visibleFlags = value.flags.filter((f) => VISIBLE_REVIEWER_FLAGS.has(f));

  const changeCopy =
    value.changeReason !== null
      ? formatCopy(`change.${value.changeReason}`, {
          n: value.previous?.versionNumber ?? 1,
          label: value.label,
        })
      : null;

  const gapCopy =
    value.gap !== null
      ? value.gap.code === 'CONFLICTING_EVIDENCE'
        ? 'Different parts of the document give different values.'
        : formatCopy(`gap.${value.gap.code}`, { type: value.fieldType })
      : null;

  const evidenceDescId = value.evidence ? `evidence-desc-${value.id}` : undefined;
  const previous = value.previous;
  const showChangedComparison = previous !== null;
  const tokenDiff =
    showChangedComparison && previous.evidence && value.evidence
      ? diffTokens(previous.evidence.quote, value.evidence.quote)
      : null;

  return (
    <div
      role="group"
      aria-label={value.label}
      data-value-id={value.id}
      onClick={(e) => {
        const target = e.target as HTMLElement | null;
        if (target?.closest('button, a, input, select, textarea, form')) return;
        onSelect(value);
      }}
      className={`cursor-pointer border-b border-[var(--color-border)] px-4 py-3.5 transition-colors ${
        selected
          ? 'bg-blue-50/70 ring-2 ring-inset ring-[var(--color-accent)]'
          : 'bg-[var(--color-surface)] hover:bg-[var(--color-surface-subtle)]'
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              aria-pressed={selected}
              aria-describedby={evidenceDescId}
              onClick={() => onSelect(value)}
              className="text-left text-sm font-medium text-[var(--color-ink-muted)] hover:text-[var(--color-accent)]"
            >
              {value.label}
            </button>
            <Badge tone={badge.tone}>
              <span aria-hidden="true">{badge.icon}</span>
              <span>{badge.label}</span>
            </Badge>
          </div>
          <div className="mt-1 flex flex-wrap items-baseline gap-2">
            <span className="tabular-nums text-base font-semibold text-[var(--color-ink)]">
              {effectiveText}
            </span>
            {value.reviewState === 'corrected' && extractedText !== null ? (
              <span className="tabular-nums text-xs text-[var(--color-ink-muted)] line-through">
                {extractedText}
              </span>
            ) : null}
            {previous?.effectiveValue != null ? (
              <span className="tabular-nums text-xs text-[var(--color-ink-muted)] line-through">
                v{previous.versionNumber}:{' '}
                {formatTypedValue(value.fieldType, previous.effectiveValue)}
              </span>
            ) : null}
          </div>
        </div>
        {actions ? (
          <div className="flex shrink-0 items-center gap-2" onClick={(e) => e.stopPropagation()}>
            {actions}
          </div>
        ) : null}
      </div>

      {changeCopy ? (
        <p className="mt-1.5 text-xs font-medium text-[var(--color-attention)]">{changeCopy}</p>
      ) : null}

      {/* Two-column Changed comparison with token-level diff (spec §14.2, [R8]) */}
      {showChangedComparison ? (
        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
          <div className="rounded border border-[var(--color-border)] bg-[var(--color-surface-subtle)]/70 px-2.5 py-2 text-xs text-[var(--color-ink-muted)]">
            <div className="flex flex-wrap items-center justify-between gap-1 font-medium">
              <span>Previous (v{previous.versionNumber})</span>
              <span className="tabular-nums">
                {previous.effectiveValue !== null
                  ? formatTypedValue(value.fieldType, previous.effectiveValue)
                  : '—'}
              </span>
            </div>
            {previous.evidence ? (
              <>
                <p className="mt-1 font-mono text-xs text-[var(--color-ink-muted)]">
                  {tokenDiff
                    ? tokenDiff
                        .filter((t) => t.kind !== 'added')
                        .map((tok, i) =>
                          tok.kind === 'removed' ? (
                            <del
                              key={i}
                              className="rounded bg-red-100 px-0.5 text-[var(--color-gap)] line-through"
                            >
                              {tok.text}
                            </del>
                          ) : (
                            <span key={i}>{tok.text}</span>
                          ),
                        )
                    : previous.evidence.quote}
                </p>
                <p className="mt-0.5 text-[11px]">Line {previous.evidence.line}</p>
              </>
            ) : previous.gap ? (
              <p className="mt-1 text-xs">{previous.gap.reason}</p>
            ) : null}
            {previous.review ? (
              <p className="mt-1 text-[11px]">
                Previous review:{' '}
                <span className="font-medium">
                  {previous.review.decision === 'correct' ? 'Corrected' : 'Approved'}
                </span>
                {previous.review.note ? ` — "${previous.review.note}"` : ''}
              </p>
            ) : null}
          </div>

          <div
            id={evidenceDescId}
            className="rounded border border-[var(--color-border)] bg-[var(--color-surface-subtle)] px-2.5 py-2 text-xs"
          >
            <div className="flex flex-wrap items-center justify-between gap-1 font-medium text-[var(--color-ink)]">
              <span>Current</span>
              <span className="tabular-nums">{effectiveText}</span>
            </div>
            {value.evidence ? (
              <>
                <p className="mt-1 font-mono text-xs text-[var(--color-ink)]">
                  {tokenDiff
                    ? tokenDiff
                        .filter((t) => t.kind !== 'removed')
                        .map((tok, i) =>
                          tok.kind === 'added' ? (
                            <ins
                              key={i}
                              className="rounded bg-green-100 px-0.5 font-medium text-[var(--color-done)] underline decoration-2"
                            >
                              {tok.text}
                            </ins>
                          ) : (
                            <span key={i}>{tok.text}</span>
                          ),
                        )
                    : value.evidence.quote}
                </p>
                <p className="mt-0.5 text-[11px] text-[var(--color-ink-muted)]">
                  Line {value.evidence.line}
                  {value.evidence.matchMode === 'quote_folded' ? ' (quote folded)' : ''}
                  {value.evidence.matchCount > 1
                    ? ` · ${value.evidence.matchCount} occurrences`
                    : ''}
                </p>
              </>
            ) : null}
          </div>
        </div>
      ) : value.evidence ? (
        <div
          id={evidenceDescId}
          className="mt-2 rounded border border-[var(--color-border)] bg-[var(--color-surface-subtle)] px-2.5 py-1.5"
        >
          <p className="font-mono text-xs text-[var(--color-ink)]">{value.evidence.quote}</p>
          <p className="mt-0.5 text-xs text-[var(--color-ink-muted)]">
            Line {value.evidence.line}
            {value.evidence.matchMode === 'quote_folded' ? ' (quote folded)' : ''}
            {value.evidence.matchCount > 1 ? ` · ${value.evidence.matchCount} occurrences` : ''}
          </p>
        </div>
      ) : null}

      {value.gap ? (
        <div className="mt-2 rounded border border-red-200 bg-[var(--color-gap-bg)]/60 px-2.5 py-1.5 text-xs text-[var(--color-gap)]">
          <p>{gapCopy}</p>
          {value.gap.reason ? (
            <p className="mt-0.5 text-[var(--color-ink)]">{value.gap.reason}</p>
          ) : null}
          {value.gap.attemptedQuote ? (
            <p className="mt-1 font-mono text-[var(--color-ink-muted)]">
              Model&apos;s quote (not found): {value.gap.attemptedQuote}
            </p>
          ) : null}
        </div>
      ) : null}

      {value.review?.note ? (
        <p className="mt-1.5 text-xs text-[var(--color-ink-muted)]">Note: {value.review.note}</p>
      ) : null}

      {visibleFlags.length > 0 ? (
        <ul className="mt-2 flex flex-wrap gap-1.5" aria-label="Evidence flags">
          {visibleFlags.map((flag) => (
            <li key={flag}>
              <Badge tone="attention">{getUiCopy(`flag.${flag}`)}</Badge>
            </li>
          ))}
        </ul>
      ) : null}

      {conflict}
      {editor}
    </div>
  );
}
