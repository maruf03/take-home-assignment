import type { ValueViewDto } from '@app/contracts/dto';
import { useState } from 'react';

export interface ReviewActionsProps {
  readonly value: ValueViewDto;
  readonly readOnly: boolean;
  readonly editing: boolean;
  readonly busy: boolean;
  readonly onApprove: () => void;
  readonly onStartEdit: () => void;
}

/**
 * Per-row review action controls matching spec §14.2:
 * - Pending value / Changed: Approve · Correct
 * - Pending gap: Confirm not present · Enter value
 * - Approved / Corrected / Carried: Change decision (expands Approve / Correct)
 * - Read-only / historical: hidden
 */
export function ReviewActions({
  value,
  readOnly,
  editing,
  busy,
  onApprove,
  onStartEdit,
}: ReviewActionsProps) {
  const [changingDecision, setChangingDecision] = useState(false);

  if (readOnly || !value.reviewable || editing) {
    return null;
  }

  const isPending = value.reviewState === 'pending';
  const approveLabel = value.kind === 'gap' ? 'Confirm not present' : 'Approve';
  const correctLabel = value.kind === 'gap' ? 'Enter value' : 'Correct';

  if (!isPending && !changingDecision) {
    return (
      <button
        type="button"
        onClick={() => setChangingDecision(true)}
        className="inline-flex min-h-8 items-center rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1 text-xs font-medium text-[var(--color-ink)] hover:bg-[var(--color-surface-subtle)]"
      >
        Change decision
      </button>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <button
        type="button"
        disabled={busy}
        data-review-primary="true"
        onClick={() => {
          setChangingDecision(false);
          onApprove();
        }}
        className="inline-flex min-h-8 items-center rounded bg-[var(--color-done)] px-2.5 py-1 text-xs font-medium text-white hover:opacity-90 disabled:opacity-60"
      >
        {approveLabel}
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          setChangingDecision(false);
          onStartEdit();
        }}
        className="inline-flex min-h-8 items-center rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1 text-xs font-medium text-[var(--color-ink)] hover:bg-[var(--color-surface-subtle)] disabled:opacity-60"
      >
        {correctLabel}
      </button>
      {!isPending ? (
        <button
          type="button"
          onClick={() => setChangingDecision(false)}
          className="inline-flex min-h-8 items-center rounded px-2 py-1 text-xs text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
        >
          Cancel
        </button>
      ) : null}
    </div>
  );
}
