import { getUiCopy } from '@app/contracts/ui-copy';
import { ApiError } from '../../shared/api/client.js';
import { useRetryVersion } from './mutations.js';

export interface RetryButtonProps {
  readonly documentId: string;
  readonly versionNumber: number;
  readonly onRetried?: () => void;
}

export function RetryButton({ documentId, versionNumber, onRetried }: RetryButtonProps) {
  const retryMutation = useRetryVersion(documentId);

  const errorText = retryMutation.error
    ? retryMutation.error instanceof ApiError
      ? retryMutation.error.status === 429 && retryMutation.error.retryAfterSeconds !== undefined
        ? `Wait ${retryMutation.error.retryAfterSeconds}s`
        : getUiCopy(`problem.${retryMutation.error.code}`)
      : retryMutation.error.message
    : null;

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        disabled={retryMutation.isPending}
        aria-label={`Retry extraction for v${versionNumber}`}
        onClick={() => {
          retryMutation.mutate(versionNumber, {
            onSuccess: () => onRetried?.(),
          });
        }}
        className="inline-flex min-h-8 items-center rounded border border-red-300 bg-[var(--color-surface)] px-2.5 py-1 text-xs font-medium text-[var(--color-gap)] hover:bg-red-50 disabled:opacity-60"
      >
        {retryMutation.isPending ? 'Retrying…' : 'Retry'}
      </button>
      {errorText ? (
        <span role="alert" className="text-xs text-[var(--color-gap)]">
          {errorText}
        </span>
      ) : null}
    </span>
  );
}
