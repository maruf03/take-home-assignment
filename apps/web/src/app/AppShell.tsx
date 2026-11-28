import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

export interface AppShellProps {
  readonly onOpenUpload: () => void;
  readonly children: ReactNode;
}

export function AppShell({ onOpenUpload, children }: AppShellProps) {
  return (
    <div className="min-h-screen bg-[var(--color-surface)] text-[var(--color-ink)]">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-[var(--color-accent)] focus:px-3 focus:py-1.5 focus:text-sm focus:text-white"
      >
        Skip to content
      </a>
      <header className="sticky top-0 z-30 h-12 border-b border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="mx-auto flex h-full max-w-7xl items-center justify-between px-4">
          <div className="flex items-center gap-6">
            <Link
              to="/documents?view=needs-review"
              className="text-sm font-semibold tracking-tight text-[var(--color-ink)]"
            >
              Document Review
            </Link>
            <nav aria-label="Primary">
              <Link
                to="/documents?view=needs-review"
                className="text-sm text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
              >
                Queue
              </Link>
            </nav>
          </div>
          <button
            type="button"
            onClick={onOpenUpload}
            className="inline-flex min-h-8 items-center rounded border border-[var(--color-border)] bg-[var(--color-surface-subtle)] px-3 py-1 text-xs font-medium text-[var(--color-ink)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
          >
            Upload PDF
          </button>
        </div>
      </header>
      <main id="main-content">{children}</main>
    </div>
  );
}
