import type { Progress } from '@app/contracts/dto';
import { useEffect, useRef, type ReactNode } from 'react';

export type BadgeTone = 'neutral' | 'attention' | 'gap' | 'done' | 'corrected' | 'accent';

const TONE_CLASSES: Record<BadgeTone, string> = {
  neutral: 'border-[var(--color-border)] bg-[var(--color-surface-subtle)] text-[var(--color-ink)]',
  attention: 'border-amber-400 bg-[var(--color-attention-bg)] text-[var(--color-attention)]',
  gap: 'border-red-300 bg-[var(--color-gap-bg)] text-[var(--color-gap)]',
  done: 'border-green-300 bg-[var(--color-done-bg)] text-[var(--color-done)]',
  corrected: 'border-purple-300 bg-[var(--color-corrected-bg)] text-[var(--color-corrected)]',
  accent: 'border-blue-300 bg-blue-50 text-[var(--color-accent)]',
};

export function Badge({
  tone = 'neutral',
  children,
  className = '',
}: {
  readonly tone?: BadgeTone;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-xs font-medium ${TONE_CLASSES[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

export function ProgressBar({ progress }: { readonly progress: Progress }) {
  const total = progress.total;
  if (total === 0) {
    return (
      <div
        role="img"
        className="h-2 w-28 overflow-hidden rounded-full bg-[var(--color-surface-subtle)] border border-[var(--color-border)]"
        aria-label="No extracted fields yet"
      />
    );
  }
  const pct = (n: number) => `${((n / total) * 100).toFixed(2)}%`;
  const reviewed = progress.approved + progress.corrected + progress.carriedOver;
  return (
    <div
      className="flex h-2 w-28 overflow-hidden rounded-full border border-[var(--color-border)] bg-[var(--color-surface-subtle)]"
      role="img"
      aria-label={`${reviewed} of ${total} values reviewed`}
    >
      {progress.approved > 0 ? (
        <span style={{ width: pct(progress.approved) }} className="bg-green-600" />
      ) : null}
      {progress.carriedOver > 0 ? (
        <span style={{ width: pct(progress.carriedOver) }} className="bg-emerald-400" />
      ) : null}
      {progress.corrected > 0 ? (
        <span style={{ width: pct(progress.corrected) }} className="bg-purple-600" />
      ) : null}
      {progress.pending > 0 ? (
        <span style={{ width: pct(progress.pending) }} className="bg-amber-300" />
      ) : null}
    </div>
  );
}

export function Banner({
  tone = 'attention',
  live,
  children,
}: {
  readonly tone?: 'attention' | 'gap' | 'neutral' | 'accent';
  readonly live?: 'polite' | 'assertive';
  readonly children: ReactNode;
}) {
  const role = live === 'assertive' ? 'alert' : live === 'polite' ? 'status' : undefined;
  return (
    <div
      role={role}
      aria-live={live}
      className={`flex flex-wrap items-center justify-between gap-2 rounded border px-4 py-2.5 text-sm ${TONE_CLASSES[tone]}`}
    >
      {children}
    </div>
  );
}

export function SkeletonRow() {
  return (
    <div
      aria-hidden="true"
      className="flex items-center justify-between gap-4 border-b border-[var(--color-border)] px-4 py-3.5"
    >
      <div className="space-y-2">
        <div className="h-4 w-56 rounded bg-gray-200" />
        <div className="h-3 w-32 rounded bg-gray-100" />
      </div>
      <div className="flex items-center gap-3">
        <div className="h-2 w-28 rounded-full bg-gray-200" />
        <div className="h-6 w-20 rounded bg-gray-100" />
      </div>
    </div>
  );
}

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function ModalDialog({
  open,
  title,
  onClose,
  children,
}: {
  readonly open: boolean;
  readonly title: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const titleId = `dialog-title-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;

  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      if (e.key === 'Tab' && panelRef.current) {
        const focusables = Array.from(
          panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
        );
        if (focusables.length === 0) {
          e.preventDefault();
          panelRef.current.focus();
          return;
        }
        const first = focusables[0]!;
        const last = focusables[focusables.length - 1]!;
        const active = document.activeElement;
        if (e.shiftKey) {
          if (
            active === first ||
            active === panelRef.current ||
            !panelRef.current.contains(active)
          ) {
            e.preventDefault();
            last.focus();
          }
        } else if (active === last || !panelRef.current.contains(active)) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      prev?.focus?.();
    };
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="w-full max-w-lg rounded border border-[var(--color-border)] bg-[var(--color-surface)] p-5 shadow-lg"
      >
        <div className="flex items-center justify-between border-b border-[var(--color-border)] pb-3">
          <h2 id={titleId} className="text-base font-semibold text-[var(--color-ink)]">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close dialog"
            className="inline-flex min-h-8 min-w-8 items-center justify-center rounded border border-transparent text-[var(--color-ink-muted)] hover:border-[var(--color-border)] hover:text-[var(--color-ink)]"
          >
            ✕
          </button>
        </div>
        <div className="mt-4">{children}</div>
      </div>
    </div>
  );
}
