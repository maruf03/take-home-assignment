import { getUiCopy } from '@app/contracts/ui-copy';
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { ApiError, ContractMismatchError } from '../api/client.js';

export interface ErrorBoundaryProps {
  readonly children: ReactNode;
  readonly title?: string;
  readonly onReset?: () => void;
}

interface ErrorBoundaryState {
  readonly error: Error | null;
}

/**
 * Route and pane error boundary mapping ContractMismatchError and ApiError to clear recovery UI.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(_error: Error, _info: ErrorInfo): void {
    // Intentionally silent beyond user-facing boundary UI; never log document content.
  }

  private handleReset = (): void => {
    this.setState({ error: null });
    this.props.onReset?.();
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) {
      return this.props.children;
    }

    let heading = this.props.title ?? 'Something went wrong';
    let detail = 'An unexpected error occurred while rendering this view.';
    let meta: string | null = null;

    if (error instanceof ContractMismatchError) {
      heading = 'Unexpected response from server';
      detail =
        'The server returned data that does not match the expected contract. Reload or try again.';
      meta = error.path;
    } else if (error instanceof ApiError) {
      heading = error.status === 404 ? 'Not found' : 'Request failed';
      detail = getUiCopy(`problem.${error.code}`);
      meta = `${error.code} · request ${error.requestId}`;
    }

    return (
      <div
        role="alert"
        className="rounded border border-[var(--color-gap)] bg-[var(--color-gap-bg)] p-4 text-[var(--color-gap)]"
      >
        <h2 className="text-base font-semibold">{heading}</h2>
        <p className="mt-1 text-sm text-[var(--color-ink)]">{detail}</p>
        {meta ? (
          <p className="mt-1 font-mono text-xs text-[var(--color-ink-muted)]">{meta}</p>
        ) : null}
        <button
          type="button"
          onClick={this.handleReset}
          className="mt-3 inline-flex min-h-8 items-center rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-sm font-medium text-[var(--color-ink)] hover:bg-[var(--color-surface-subtle)]"
        >
          Try again
        </button>
      </div>
    );
  }
}
