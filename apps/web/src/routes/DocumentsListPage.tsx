import type { DocumentSummaryDto } from '@app/contracts/dto';
import { Link, useSearchParams } from 'react-router-dom';
import {
  useDocumentsFacets,
  useDocumentsList,
  useDocumentTypes,
} from '../entities/document/queries.js';
import { DEFAULT_POLL_MS, isStatusInFlight } from '../shared/api/polling.js';
import type { DocumentsListView } from '../shared/api/query-keys.js';
import { formatFacetCount, formatTimestamp } from '../shared/lib/format.js';
import { Badge, ProgressBar, SkeletonRow, type BadgeTone } from '../shared/ui/Primitives.js';

function statusBadge(status: DocumentSummaryDto['status']): { label: string; tone: BadgeTone } {
  switch (status) {
    case 'queued':
      return { label: 'Queued', tone: 'accent' };
    case 'extracting':
      return { label: 'Extracting', tone: 'accent' };
    case 'extracted':
      return { label: 'Extracted', tone: 'done' };
    case 'failed':
      return { label: 'Failed', tone: 'gap' };
  }
}

function parseView(raw: string | null): DocumentsListView {
  if (raw === 'all' || raw === 'failed' || raw === 'needs-review') return raw;
  return 'needs-review';
}

export interface DocumentsListPageProps {
  readonly onOpenUpload: () => void;
  readonly pollMs?: number;
}

export function DocumentsListPage({
  onOpenUpload,
  pollMs = DEFAULT_POLL_MS,
}: DocumentsListPageProps) {
  const [searchParams, setSearchParams] = useSearchParams();
  const view = parseView(searchParams.get('view'));
  const typeFilter = searchParams.get('type') ?? '';

  const facetsQuery = useDocumentsFacets();
  const typesQuery = useDocumentTypes();
  const listQuery = useDocumentsList({ view, ...(typeFilter ? { type: typeFilter } : {}) }, pollMs);

  const docs = listQuery.data?.pages.flatMap((p) => p.data) ?? [];
  const needsReviewLabel = facetsQuery.data
    ? formatFacetCount(facetsQuery.data.needsReview.count, facetsQuery.data.needsReview.capped)
    : null;

  const setView = (nextView: DocumentsListView) => {
    const next = new URLSearchParams(searchParams);
    next.set('view', nextView);
    setSearchParams(next);
  };

  const setType = (nextType: string) => {
    const next = new URLSearchParams(searchParams);
    if (nextType) next.set('type', nextType);
    else next.delete('type');
    setSearchParams(next);
  };

  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--color-border)] pb-4">
        <div>
          <h1 className="text-xl font-semibold text-[var(--color-ink)]">Documents</h1>
          <p className="text-sm text-[var(--color-ink-muted)]">
            Review extracted values against source text and resolve changes or gaps.
          </p>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <div role="tablist" aria-label="Document queue views" className="flex gap-1">
          {(
            [
              { id: 'needs-review', label: 'Needs review', count: needsReviewLabel },
              { id: 'all', label: 'All', count: null },
              { id: 'failed', label: 'Failed', count: null },
            ] as const
          ).map((tab) => {
            const active = view === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setView(tab.id)}
                className={`inline-flex min-h-9 items-center gap-1.5 border-b-2 px-3 py-1.5 text-sm font-medium ${
                  active
                    ? 'border-[var(--color-accent)] text-[var(--color-accent)]'
                    : 'border-transparent text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]'
                }`}
              >
                <span>{tab.label}</span>
                {tab.count !== null ? (
                  <span className="tabular-nums rounded bg-[var(--color-attention-bg)] px-1.5 py-0.5 text-xs font-semibold text-[var(--color-attention)]">
                    {tab.count}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-2">
          <label
            htmlFor="filter-type"
            className="text-xs font-medium text-[var(--color-ink-muted)]"
          >
            Type
          </label>
          <select
            id="filter-type"
            value={typeFilter}
            onChange={(e) => setType(e.target.value)}
            className="min-h-8 rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1 text-sm text-[var(--color-ink)]"
          >
            <option value="">All types</option>
            {(typesQuery.data?.data ?? []).map((t) => (
              <option key={t.key} value={t.key}>
                {t.displayName}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="mt-3 overflow-hidden rounded border border-[var(--color-border)] bg-[var(--color-surface)]">
        {listQuery.isLoading ? (
          <div>
            <SkeletonRow />
            <SkeletonRow />
            <SkeletonRow />
          </div>
        ) : listQuery.isError ? (
          <div role="alert" className="p-6 text-sm text-[var(--color-gap)]">
            Could not load documents.{' '}
            <button
              type="button"
              onClick={() => void listQuery.refetch()}
              className="underline font-medium"
            >
              Try again
            </button>
          </div>
        ) : docs.length === 0 ? (
          <div className="p-10 text-center">
            <p className="text-base font-medium text-[var(--color-ink)]">
              {view === 'needs-review' ? 'All caught up ✓' : 'Upload your first PDF'}
            </p>
            <p className="mt-1 text-sm text-[var(--color-ink-muted)]">
              {view === 'needs-review'
                ? 'No documents currently have pending values.'
                : 'Upload a PDF to start structured extraction and review.'}
            </p>
            <button
              type="button"
              onClick={onOpenUpload}
              className="mt-4 inline-flex min-h-9 items-center rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-1.5 text-sm font-medium text-[var(--color-ink)] hover:bg-[var(--color-surface-subtle)]"
            >
              Upload PDF
            </button>
          </div>
        ) : (
          <ul className="divide-y divide-[var(--color-border)]">
            {docs.map((doc) => {
              const st = statusBadge(doc.status);
              const newerExtracting =
                doc.valuesVersion !== null &&
                doc.currentVersion.number > doc.valuesVersion &&
                isStatusInFlight(doc.currentVersion.status);
              return (
                <li
                  key={doc.id}
                  className="flex flex-wrap items-center justify-between gap-4 px-4 py-3.5 hover:bg-[var(--color-surface-subtle)]"
                >
                  <div className="min-w-0 flex-1">
                    <Link
                      to={`/documents/${doc.id}`}
                      className="text-sm font-semibold text-[var(--color-ink)] hover:text-[var(--color-accent)] hover:underline"
                    >
                      {doc.title}
                    </Link>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[var(--color-ink-muted)]">
                      <Badge>{doc.typeLabel}</Badge>
                      <span className="tabular-nums">
                        v{doc.valuesVersion ?? doc.currentVersion.number}
                      </span>
                      {newerExtracting ? (
                        <Badge tone="accent">v{doc.currentVersion.number} extracting</Badge>
                      ) : null}
                      <span>{formatTimestamp(doc.createdAt)}</span>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-3">
                    <Badge tone={st.tone}>{st.label}</Badge>
                    <ProgressBar progress={doc.progress} />
                    {doc.progress.pending > 0 ? (
                      <Badge tone="attention" className="tabular-nums">
                        {doc.progress.pending} to review
                      </Badge>
                    ) : doc.progress.total > 0 ? (
                      <Badge tone="done">Reviewed</Badge>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {listQuery.hasNextPage ? (
        <div className="mt-4 flex justify-center">
          <button
            type="button"
            disabled={listQuery.isFetchingNextPage}
            onClick={() => void listQuery.fetchNextPage()}
            className="inline-flex min-h-9 items-center rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-1.5 text-sm font-medium text-[var(--color-ink)] hover:bg-[var(--color-surface-subtle)] disabled:opacity-60"
          >
            {listQuery.isFetchingNextPage ? 'Loading…' : 'Load more'}
          </button>
        </div>
      ) : null}
    </div>
  );
}
