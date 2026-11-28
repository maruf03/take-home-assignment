import {
  MAX_REVIEW_NOTE_LENGTH,
  type CorrectionInputValue,
  type ValueViewDto,
} from '@app/contracts/dto';
import { getUiCopy } from '@app/contracts/ui-copy';
import {
  formatTypedValue,
  parseTypedValue,
  type TemplateValueContext,
  type TypedValue,
} from '@app/contracts/values';
import { useState, type FormEvent } from 'react';
import { ApiError } from '../../shared/api/client.js';

export interface CorrectionDraft {
  readonly rawValue: string;
  readonly currency: string;
  readonly note: string;
}

export function initialDraftFor(
  value: ValueViewDto,
  templateCtx?: TemplateValueContext,
): CorrectionDraft {
  const defaultCurrency = templateCtx?.defaultCurrency ?? 'USD';
  const source = value.effectiveValue;
  if (value.fieldType === 'money') {
    if (source && typeof source === 'object') {
      return {
        rawValue: source.amount,
        currency: source.currency,
        note: value.review?.note ?? '',
      };
    }
    return { rawValue: '', currency: defaultCurrency, note: value.review?.note ?? '' };
  }
  return {
    rawValue: typeof source === 'string' ? source : '',
    currency: defaultCurrency,
    note: value.review?.note ?? '',
  };
}

function formatDateInWords(isoDate: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) return null;
  const dt = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (Number.isNaN(dt.getTime())) return null;
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(dt);
}

export interface CorrectionFormProps {
  readonly value: ValueViewDto;
  readonly templateCtx?: TemplateValueContext;
  readonly draft: CorrectionDraft;
  readonly onDraftChange: (next: CorrectionDraft) => void;
  readonly onCancel: () => void;
  readonly onSubmit: (payload: {
    correctedValue: CorrectionInputValue;
    canonicalValue: TypedValue;
    note?: string;
  }) => Promise<void>;
  readonly submitting: boolean;
  readonly serverError: Error | null;
}

function serverErrorText(error: Error): string {
  if (error instanceof ApiError) {
    if (error.status === 429 && error.retryAfterSeconds !== undefined) {
      return `Wait ${error.retryAfterSeconds}s and try again.`;
    }
    if (error.code === 'INVALID_CORRECTION' && error.errors?.[0]?.message) {
      return error.errors[0].message;
    }
    return getUiCopy(`problem.${error.code}`);
  }
  return error.message;
}

export function CorrectionForm({
  value,
  templateCtx,
  draft,
  onDraftChange,
  onCancel,
  onSubmit,
  submitting,
  serverError,
}: CorrectionFormProps) {
  const [submittedOnce, setSubmittedOnce] = useState(false);

  const inputToParse: CorrectionInputValue =
    value.fieldType === 'money'
      ? {
          amount: draft.rawValue,
          ...(draft.currency.trim() ? { currency: draft.currency.trim().toUpperCase() } : {}),
        }
      : draft.rawValue;

  const parseResult =
    draft.rawValue.trim().length > 0
      ? parseTypedValue(value.fieldType, inputToParse, templateCtx)
      : null;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmittedOnce(true);
    const check = parseTypedValue(value.fieldType, inputToParse, templateCtx);
    if (!check.ok) {
      return;
    }
    const trimmedNote = draft.note.trim();
    await onSubmit({
      correctedValue: check.value,
      canonicalValue: check.value,
      ...(trimmedNote.length > 0 ? { note: trimmedNote } : {}),
    });
  };

  const inputId = `correct-input-${value.id}`;
  const currencyId = `correct-currency-${value.id}`;
  const datePickerId = `correct-datepicker-${value.id}`;
  const noteId = `correct-note-${value.id}`;

  const validationError =
    submittedOnce && draft.rawValue.trim().length === 0
      ? 'Enter a value to save.'
      : parseResult && !parseResult.ok
        ? parseResult.error
        : null;

  const dateWords =
    value.fieldType === 'date' && parseResult?.ok && typeof parseResult.value === 'string'
      ? formatDateInWords(parseResult.value)
      : null;

  return (
    <form
      onSubmit={(e) => void handleSubmit(e)}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          onCancel();
        }
      }}
      className="mt-3 space-y-3 rounded border border-[var(--color-accent)]/40 bg-[var(--color-surface-subtle)] p-3"
    >
      {value.fieldType === 'money' ? (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <div className="sm:col-span-2">
            <label htmlFor={inputId} className="block text-xs font-medium text-[var(--color-ink)]">
              Amount
            </label>
            <input
              id={inputId}
              type="text"
              inputMode="decimal"
              value={draft.rawValue}
              onChange={(e) => onDraftChange({ ...draft, rawValue: e.target.value })}
              placeholder="5,230.29"
              className="mt-1 block w-full rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-sm text-[var(--color-ink)]"
            />
          </div>
          <div>
            <label
              htmlFor={currencyId}
              className="block text-xs font-medium text-[var(--color-ink)]"
            >
              Currency
            </label>
            <input
              id={currencyId}
              type="text"
              maxLength={3}
              value={draft.currency}
              onChange={(e) => onDraftChange({ ...draft, currency: e.target.value.toUpperCase() })}
              placeholder={templateCtx?.defaultCurrency ?? 'USD'}
              className="mt-1 block w-full rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 font-mono text-sm uppercase text-[var(--color-ink)]"
            />
          </div>
        </div>
      ) : value.fieldType === 'date' ? (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <div>
            <label htmlFor={inputId} className="block text-xs font-medium text-[var(--color-ink)]">
              Date value (YYYY-MM-DD)
            </label>
            <input
              id={inputId}
              type="text"
              value={draft.rawValue}
              onChange={(e) => onDraftChange({ ...draft, rawValue: e.target.value })}
              placeholder="2025-11-13"
              className="mt-1 block w-full rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 font-mono text-sm text-[var(--color-ink)]"
            />
          </div>
          <div>
            <label
              htmlFor={datePickerId}
              className="block text-xs font-medium text-[var(--color-ink)]"
            >
              Calendar
            </label>
            <input
              id={datePickerId}
              type="date"
              value={
                parseResult?.ok && typeof parseResult.value === 'string' ? parseResult.value : ''
              }
              onChange={(e) => onDraftChange({ ...draft, rawValue: e.target.value })}
              className="mt-1 block w-full rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-sm text-[var(--color-ink)]"
            />
          </div>
        </div>
      ) : value.fieldType === 'percent' ? (
        <div>
          <label htmlFor={inputId} className="block text-xs font-medium text-[var(--color-ink)]">
            Value
          </label>
          <div className="mt-1 flex items-center gap-1.5">
            <input
              id={inputId}
              type="text"
              inputMode="decimal"
              value={draft.rawValue}
              onChange={(e) => onDraftChange({ ...draft, rawValue: e.target.value })}
              placeholder="4.2"
              className="block w-full rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-sm text-[var(--color-ink)]"
            />
            <span className="text-sm font-medium text-[var(--color-ink-muted)]">%</span>
          </div>
          <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
            Enter percentage points (4.2, not 0.042).
          </p>
        </div>
      ) : value.fieldType === 'number' ? (
        <div>
          <label htmlFor={inputId} className="block text-xs font-medium text-[var(--color-ink)]">
            Value
          </label>
          <input
            id={inputId}
            type="text"
            inputMode="decimal"
            value={draft.rawValue}
            onChange={(e) => onDraftChange({ ...draft, rawValue: e.target.value })}
            placeholder="0"
            className="mt-1 block w-full rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-sm text-[var(--color-ink)]"
          />
        </div>
      ) : (
        <div>
          <label htmlFor={inputId} className="block text-xs font-medium text-[var(--color-ink)]">
            Value
          </label>
          <input
            id={inputId}
            type="text"
            value={draft.rawValue}
            onChange={(e) => onDraftChange({ ...draft, rawValue: e.target.value })}
            placeholder={`Enter ${value.label}`}
            className="mt-1 block w-full rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-sm text-[var(--color-ink)]"
          />
        </div>
      )}

      {/* Canonical live preview */}
      {parseResult?.ok ? (
        <p data-testid="canonical-preview" className="text-xs text-[var(--color-done)]">
          Will save as:{' '}
          <span className="tabular-nums font-semibold">
            {formatTypedValue(value.fieldType, parseResult.value)}
          </span>
          {dateWords ? (
            <span className="ml-1.5 text-[var(--color-ink-muted)]">({dateWords})</span>
          ) : null}
        </p>
      ) : null}

      <div>
        <label htmlFor={noteId} className="block text-xs font-medium text-[var(--color-ink)]">
          Note (optional)
        </label>
        <input
          id={noteId}
          type="text"
          maxLength={MAX_REVIEW_NOTE_LENGTH}
          value={draft.note}
          onChange={(e) => onDraftChange({ ...draft, note: e.target.value })}
          placeholder="Explain why this value was corrected"
          className="mt-1 block w-full rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-sm text-[var(--color-ink)]"
        />
      </div>

      {validationError || serverError ? (
        <div
          role="alert"
          className="rounded border border-red-300 bg-[var(--color-gap-bg)] px-2.5 py-1.5 text-xs text-[var(--color-gap)]"
        >
          {validationError ?? (serverError ? serverErrorText(serverError) : null)}
        </div>
      ) : null}

      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="inline-flex min-h-8 items-center rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1 text-xs font-medium text-[var(--color-ink)] hover:bg-[var(--color-surface-subtle)]"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={submitting}
          className="inline-flex min-h-8 items-center rounded bg-[var(--color-accent)] px-3 py-1 text-xs font-medium text-white hover:bg-[var(--color-accent-hover)] disabled:opacity-60"
        >
          {submitting ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  );
}
