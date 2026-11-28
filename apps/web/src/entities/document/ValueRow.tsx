import type { ValueViewDto } from '@app/contracts/dto';
import { getUiCopy } from '@app/contracts/ui-copy';
import { formatTypedValue } from '@app/contracts/values';
import type { ReactNode } from 'react';
import { formatCopy, VISIBLE_REVIEWER_FLAGS } from '../../shared/lib/format.js';
import { Badge, type BadgeTone } from '../../shared/ui/Primitives.js';

function stateBadgeFor(value: ValueViewDto): { label: string; tone: BadgeTone } {
  if (value.reviewState === 'approved') return { label: 'Approved', tone: 'done' };
  if (value.reviewState === 'corrected') return { label: 'Corrected', tone: 'corrected' };
  if (value.reviewState === 'carried_over') {
    const fromV = value.review?.carriedFromVersion;
    const dec = value.review?.decision === 'correct' ? 'corrected' : 'approved';
    return {
      label: fromV ? `Carried from v${fromV}, ${dec}` : `Carried, ${dec}`,
      tone: 'done',
    };
  }
  if (value.attention === 'changed') return { label: 'Changed', tone: 'attention' };
  if (value.kind === 'gap') return { label: 'Gap', tone: 'gap' };
  return { label: 'Pending', tone: 'neutral' };
}

export interface ValueRowProps {
  readonly value: ValueViewDto;
  readonly selected: boolean;
  readonly onSelect: (value: ValueViewDto) => void;
  readonly actions?: ReactNode;
}

/**
 * Displays a single extracted value or gap with its effective value, state badge, verbatim
 * evidence quote from stored offsets, visible flags (never LINE_HINT_MISMATCH), and optional
 * review actions slot (populated in Task 11b).
 */
export function ValueRow({ value, selected, onSelect, actions }: ValueRowProps) {
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
    value.gap !== null ? formatCopy(`gap.${value.gap.code}`, { type: value.fieldType }) : null;

  return (
    <div
      role="group"
      aria-label={value.label}
      data-value-id={value.id}
      onClick={() => onSelect(value)}
      className={`cursor-pointer border-b border-[var(--color-border)] px-4 py-3.5 transition-colors ${
        selected
          ? 'bg-blue-50/70 ring-2 ring-inset ring-[var(--color-accent)]'
          : 'bg-[var(--color-surface)] hover:bg-[var(--color-surface-subtle)]'
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-[var(--color-ink-muted)]">{value.label}</span>
            <Badge tone={badge.tone}>{badge.label}</Badge>
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
            {value.attention === 'changed' && value.previous?.effectiveValue != null ? (
              <span className="tabular-nums text-xs text-[var(--color-ink-muted)] line-through">
                v{value.previous.versionNumber}:{' '}
                {formatTypedValue(value.fieldType, value.previous.effectiveValue)}
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

      {value.evidence ? (
        <div className="mt-2 rounded border border-[var(--color-border)] bg-[var(--color-surface-subtle)] px-2.5 py-1.5">
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
    </div>
  );
}
