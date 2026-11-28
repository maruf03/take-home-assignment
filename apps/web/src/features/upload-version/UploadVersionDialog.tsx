import { getUiCopy } from '@app/contracts/ui-copy';
import { useState, type FormEvent } from 'react';
import { ApiError } from '../../shared/api/client.js';
import { ModalDialog } from '../../shared/ui/Primitives.js';
import { useUploadVersion } from './mutations.js';

export interface UploadVersionDialogProps {
  readonly documentId: string;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onUploaded?: (deduplicated: boolean, versionNumber: number) => void;
}

function errorText(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 429 && error.retryAfterSeconds !== undefined) {
      return `Too many uploads. Wait ${error.retryAfterSeconds}s and try again.`;
    }
    return getUiCopy(`problem.${error.code}`);
  }
  if (error instanceof Error) {
    return error.message;
  }
  return 'Could not upload new version. Please try again.';
}

export function UploadVersionDialog({
  documentId,
  open,
  onClose,
  onUploaded,
}: UploadVersionDialogProps) {
  const mutation = useUploadVersion(documentId);
  const [file, setFile] = useState<File | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  const handleClose = () => {
    setFile(null);
    setLocalError(null);
    mutation.reset();
    onClose();
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setLocalError(null);
    if (!file) {
      setLocalError('Choose a PDF file to upload.');
      return;
    }
    try {
      const res = await mutation.mutateAsync(file);
      setFile(null);
      onUploaded?.(Boolean(res.deduplicated), res.version.number);
      onClose();
    } catch {
      // Displayed via mutation.error below.
    }
  };

  const displayedError = localError ?? (mutation.error ? errorText(mutation.error) : null);

  return (
    <ModalDialog open={open} title="Upload new version" onClose={handleClose}>
      <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
        <div>
          <label
            htmlFor="upload-version-pdf-file"
            className="block text-sm font-medium text-[var(--color-ink)]"
          >
            PDF file
          </label>
          <input
            id="upload-version-pdf-file"
            type="file"
            accept=".pdf,application/pdf"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="mt-1 block w-full rounded border border-[var(--color-border)] bg-[var(--color-surface-subtle)] px-3 py-2 text-sm text-[var(--color-ink)]"
          />
          <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
            Reviews whose verbatim evidence did not change will carry forward automatically.
          </p>
        </div>

        {displayedError ? (
          <div
            role="alert"
            className="rounded border border-red-300 bg-[var(--color-gap-bg)] px-3 py-2 text-sm text-[var(--color-gap)]"
          >
            {displayedError}
          </div>
        ) : null}

        <div className="flex items-center justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={handleClose}
            className="inline-flex min-h-9 items-center rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-3.5 py-1.5 text-sm font-medium text-[var(--color-ink)] hover:bg-[var(--color-surface-subtle)]"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={mutation.isPending}
            className="inline-flex min-h-9 items-center rounded bg-[var(--color-accent)] px-4 py-1.5 text-sm font-medium text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-60"
          >
            {mutation.isPending ? 'Uploading…' : 'Upload version'}
          </button>
        </div>
      </form>
    </ModalDialog>
  );
}
