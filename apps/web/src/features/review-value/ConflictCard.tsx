import type { ValueViewDto } from '@app/contracts/dto';
import { getUiCopy } from '@app/contracts/ui-copy';
import { formatTypedValue } from '@app/contracts/values';

export interface ConflictCardProps {
  readonly currentValue: ValueViewDto | null;
  readonly onDismiss: () => void;
}

function formatReviewState(state: ValueViewDto['reviewState']): string {
  switch (state) {
    case 'pending':
      return 'Pending';
    case 'approved':
      return 'Approved';
    case 'corrected':
      return 'Corrected';
    case 'carried_over':
      return 'Carried over';
  }
}

export function ConflictCard({ currentValue, onDismiss }: ConflictCardProps) {
  const latestFormatted =
    currentValue && currentValue.effectiveValue !== null
      ? formatTypedValue(currentValue.fieldType, currentValue.effectiveValue)
      : null;

  return (
    <div
      role="alert"
      className="mt-2.5 rounded border border-amber-400 bg-[var(--color-attention-bg)] p-3 text-xs text-[var(--color-ink)]"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-semibold text-[var(--color-attention)]">
            {getUiCopy('problem.REVIEW_CONFLICT')}
          </p>
          {currentValue ? (
            <p className="mt-1 text-[var(--color-ink)]">
              Latest saved state:{' '}
              <span className="font-semibold">{formatReviewState(currentValue.reviewState)}</span>
              {latestFormatted ? (
                <>
                  {' '}
                  · <span className="tabular-nums font-semibold">{latestFormatted}</span>
                </>
              ) : null}
              {currentValue.review?.note ? ` — "${currentValue.review.note}"` : ''}
            </p>
          ) : null}
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="inline-flex min-h-7 items-center rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1 text-xs font-medium text-[var(--color-ink)] hover:bg-[var(--color-surface-subtle)]"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
