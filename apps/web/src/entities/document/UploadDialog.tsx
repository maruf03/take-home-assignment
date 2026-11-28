import { getUiCopy } from '@app/contracts/ui-copy';
import { useState, type FormEvent } from 'react';
import { ApiError } from '../../shared/api/client.js';
import { ModalDialog } from '../../shared/ui/Primitives.js';
import { useDocumentTypes, useUploadDocument } from './queries.js';

export interface UploadDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onUploaded: (documentId: string) => void;
}

function errorMessageFor(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 429 && error.retryAfterSeconds !== undefined) {
      return `Too many uploads. Wait ${error.retryAfterSeconds}s and try again.`;
    }
    return getUiCopy(`problem.${error.code}`);
  }
  if (error instanceof Error) {
    return error.message;
  }
  return 'Upload failed. Please try again.';
}

export function UploadDialog({ open, onClose, onUploaded }: UploadDialogProps) {
  const typesQuery = useDocumentTypes();
  const uploadMutation = useUploadDocument();
  const [selectedType, setSelectedType] = useState<string>('');
  const [title, setTitle] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  const types = typesQuery.data?.data ?? [];
  const effectiveType = selectedType || types[0]?.key || 'invoice';

  const handleClose = () => {
    setFile(null);
    setTitle('');
    setSelectedType('');
    setLocalError(null);
    uploadMutation.reset();
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
      const created = await uploadMutation.mutateAsync({
        file,
        type: effectiveType,
        title,
      });
      setFile(null);
      setTitle('');
      onUploaded(created.id);
    } catch {
      // Displayed via uploadMutation.error below.
    }
  };

  const displayedError =
    localError ?? (uploadMutation.error ? errorMessageFor(uploadMutation.error) : null);

  return (
    <ModalDialog open={open} title="Upload PDF" onClose={handleClose}>
      <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
        <div>
          <label
            htmlFor="upload-doc-type"
            className="block text-sm font-medium text-[var(--color-ink)]"
          >
            Document type
          </label>
          <select
            id="upload-doc-type"
            value={effectiveType}
            onChange={(e) => setSelectedType(e.target.value)}
            className="mt-1 block w-full rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-ink)]"
          >
            {types.length > 0 ? (
              types.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.displayName}
                </option>
              ))
            ) : (
              <option value="invoice">Invoice</option>
            )}
          </select>
        </div>

        <div>
          <label
            htmlFor="upload-pdf-file"
            className="block text-sm font-medium text-[var(--color-ink)]"
          >
            PDF file
          </label>
          <input
            id="upload-pdf-file"
            type="file"
            accept=".pdf,application/pdf"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="mt-1 block w-full rounded border border-[var(--color-border)] bg-[var(--color-surface-subtle)] px-3 py-2 text-sm text-[var(--color-ink)]"
          />
          <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
            Single PDF up to 10 MB. Extraction runs in the background after upload.
          </p>
        </div>

        <div>
          <label
            htmlFor="upload-doc-title"
            className="block text-sm font-medium text-[var(--color-ink)]"
          >
            Title (optional)
          </label>
          <input
            id="upload-doc-title"
            type="text"
            maxLength={200}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Defaults to filename"
            className="mt-1 block w-full rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-ink)]"
          />
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
            disabled={uploadMutation.isPending}
            className="inline-flex min-h-9 items-center rounded bg-[var(--color-accent)] px-4 py-1.5 text-sm font-medium text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-60"
          >
            {uploadMutation.isPending ? 'Uploading…' : 'Upload'}
          </button>
        </div>
      </form>
    </ModalDialog>
  );
}
