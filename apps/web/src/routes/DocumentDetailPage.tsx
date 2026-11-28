import type { DocumentDetailDto, ValueViewDto } from '@app/contracts/dto';
import { getUiCopy } from '@app/contracts/ui-copy';
import type { TemplateValueContext } from '@app/contracts/values';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  useDocumentDetail,
  useDocumentTypes,
  useVersionDetail,
  useVersionText,
} from '../entities/document/queries.js';
import { TextPane } from '../entities/document/TextPane.js';
import { ValueRow } from '../entities/document/ValueRow.js';
import { useReextractVersion } from '../features/retry/mutations.js';
import { RetryButton } from '../features/retry/RetryButton.js';
import { ConflictCard } from '../features/review-value/ConflictCard.js';
import {
  CorrectionForm,
  initialDraftFor,
  type CorrectionDraft,
} from '../features/review-value/CorrectionForm.js';
import { useReviewValue } from '../features/review-value/mutations.js';
import { ReviewActions } from '../features/review-value/ReviewActions.js';
import { UploadVersionDialog } from '../features/upload-version/UploadVersionDialog.js';
import { ApiError, fileDownloadUrl } from '../shared/api/client.js';
import { DEFAULT_POLL_MS, isStatusInFlight } from '../shared/api/polling.js';
import { ErrorBoundary } from '../shared/ui/ErrorBoundary.js';
import {
  Badge,
  Banner,
  ProgressBar,
  SkeletonRow,
  type BadgeTone,
} from '../shared/ui/Primitives.js';

function statusBadgeFor(status: DocumentDetailDto['status']): { label: string; tone: BadgeTone } {
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

interface ValueGroup {
  readonly id: 'changed' | 'gap' | 'pending' | 'done';
  readonly heading: string;
  readonly items: readonly ValueViewDto[];
}

function groupValues(
  values: readonly ValueViewDto[],
  previousVersion: number | null,
): ValueGroup[] {
  const byBucket: Record<ValueGroup['id'], ValueViewDto[]> = {
    changed: [],
    gap: [],
    pending: [],
    done: [],
  };
  for (const v of values) {
    byBucket[v.attention].push(v);
  }
  for (const key of Object.keys(byBucket) as Array<ValueGroup['id']>) {
    byBucket[key].sort((a, b) => a.position - b.position);
  }
  return [
    {
      id: 'changed',
      heading: previousVersion ? `Changed since v${previousVersion}` : 'Changed',
      items: byBucket.changed,
    },
    { id: 'gap', heading: 'Gaps', items: byBucket.gap },
    { id: 'pending', heading: 'Needs review', items: byBucket.pending },
    { id: 'done', heading: 'Done', items: byBucket.done },
  ];
}

export interface DocumentDetailPageProps {
  readonly pollMs?: number;
}

export function DocumentDetailPage({ pollMs = DEFAULT_POLL_MS }: DocumentDetailPageProps) {
  const params = useParams<{ id: string; n?: string }>();
  const documentId = params.id ?? '';
  return (
    <DocumentDetailContent
      key={documentId}
      documentId={documentId}
      rawVersion={params.n}
      pollMs={pollMs}
    />
  );
}

function DocumentDetailContent({
  documentId,
  rawVersion,
  pollMs,
}: {
  readonly documentId: string;
  readonly rawVersion: string | undefined;
  readonly pollMs: number;
}) {
  const navigate = useNavigate();
  const location = useLocation();

  const invalidVersionParam =
    rawVersion !== undefined && (!/^\d+$/.test(rawVersion) || Number(rawVersion) < 1);
  const requestedVersion =
    rawVersion !== undefined && !invalidVersionParam ? Number(rawVersion) : null;
  const isHistorical = requestedVersion !== null;

  const detailQuery = useDocumentDetail(documentId, pollMs);
  const versionQuery = useVersionDetail(documentId, isHistorical ? requestedVersion : null, pollMs);
  const typesQuery = useDocumentTypes();

  const doc = detailQuery.data;
  const historicalVer = versionQuery.data;

  const templateCtx = useMemo<TemplateValueContext | undefined>(() => {
    if (!doc) return undefined;
    const match = typesQuery.data?.data.find((t) => t.key === doc.type);
    if (!match?.template) return undefined;
    return {
      defaultCurrency: match.template.defaultCurrency,
      dateOrder: match.template.dateOrder,
    };
  }, [doc, typesQuery.data]);

  const activeVersionNumber = isHistorical
    ? requestedVersion
    : (doc?.valuesVersion ?? doc?.currentVersion.number ?? null);

  const values: readonly ValueViewDto[] = useMemo(() => {
    if (isHistorical) return historicalVer?.values ?? [];
    return doc?.values ?? [];
  }, [isHistorical, historicalVer, doc]);

  const textRanges = isHistorical
    ? (historicalVer?.textRanges ?? null)
    : (doc?.valuesTextMeta?.textRanges ?? null);

  const hasText = isHistorical
    ? historicalVer !== undefined &&
      (historicalVer.status === 'extracted' || historicalVer.pageOffsets !== null)
    : doc !== undefined && doc.valuesVersion !== null;

  const textQuery = useVersionText(documentId, activeVersionNumber, hasText);

  const prevVersionNumber = useMemo(() => {
    const withPrev = values.find((v) => v.previous !== null);
    return withPrev?.previous?.versionNumber ?? null;
  }, [values]);

  const groups = useMemo(() => groupValues(values, prevVersionNumber), [values, prevVersionNumber]);

  const [selectedValueId, setSelectedValueId] = useState<string | null>(null);
  const [doneExpanded, setDoneExpanded] = useState(false);
  const [uploadVersionOpen, setUploadVersionOpen] = useState(false);
  const [editingFieldKey, setEditingFieldKey] = useState<string | null>(null);
  const [draftsByField, setDraftsByField] = useState<Record<string, CorrectionDraft>>({});
  const [conflictsByValueId, setConflictsByValueId] = useState<Record<string, ValueViewDto | null>>(
    {},
  );
  const [rowErrorByValueId, setRowErrorByValueId] = useState<Record<string, Error>>({});
  const [versionMovedBanner, setVersionMovedBanner] = useState(false);

  const reviewMutation = useReviewValue(documentId, {
    onReviewConflict: (valueId, currentValue) => {
      setConflictsByValueId((prev) => ({ ...prev, [valueId]: currentValue }));
      // Auto-expand Done so ConflictCard remains visible when the refetched value moves to Done.
      setDoneExpanded(true);
    },
    onVersionNotReviewable: () => {
      setVersionMovedBanner(true);
    },
  });
  const reextractMutation = useReextractVersion(documentId);

  // If an open draft's field moved into Done (e.g., after VERSION_NOT_REVIEWABLE reload), keep it visible.
  useEffect(() => {
    if (!editingFieldKey) return;
    const match = values.find((v) => v.fieldKey === editingFieldKey);
    if (!match) {
      setEditingFieldKey(null);
      return;
    }
    if (match.attention === 'done') {
      setDoneExpanded(true);
    }
    if (selectedValueId !== match.id) {
      setSelectedValueId(match.id);
    }
  }, [editingFieldKey, values, selectedValueId]);

  // Announce completion politely when extraction transitions from in-flight to extracted (spec §14.4).
  const wasInFlightRef = useRef(false);
  const [liveNotice, setLiveNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!doc) return;
    const inFlight = isStatusInFlight(doc.status);
    if (wasInFlightRef.current && !inFlight && doc.status === 'extracted') {
      setLiveNotice(`Extraction complete: ${doc.progress.pending} values need review`);
    }
    wasInFlightRef.current = inFlight;
  }, [doc]);

  // Select the first value with evidence in attention order by default.
  const orderedValues = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  const selectedValue = useMemo(() => {
    if (selectedValueId) {
      const match = orderedValues.find((v) => v.id === selectedValueId);
      if (match) return match;
    }
    return orderedValues.find((v) => v.evidence !== null) ?? orderedValues[0] ?? null;
  }, [orderedValues, selectedValueId]);

  const focusNextPendingAfter = () => {
    if (typeof requestAnimationFrame !== 'function') return;
    requestAnimationFrame(() => {
      const nextBtn = document.querySelector<HTMLElement>('[data-review-primary="true"]');
      if (nextBtn) {
        const nextRow = nextBtn.closest<HTMLElement>('[data-value-id]');
        const nextId = nextRow?.dataset['valueId'];
        if (nextId) setSelectedValueId(nextId);
        nextBtn.focus();
        return;
      }
      const doneToggle = document.querySelector<HTMLElement>('[data-done-toggle="true"]');
      doneToggle?.focus();
    });
  };

  const handleApprove = (val: ValueViewDto) => {
    setRowErrorByValueId((prev) => {
      const next = { ...prev };
      delete next[val.id];
      return next;
    });
    setConflictsByValueId((prev) => {
      const next = { ...prev };
      delete next[val.id];
      return next;
    });

    reviewMutation.mutate(
      {
        valueId: val.id,
        fieldKey: val.fieldKey,
        body: {
          decision: 'approve',
          expectedCurrentReviewId: val.review?.id ?? null,
        },
      },
      {
        onSuccess: () => {
          setLiveNotice(`Approved ${val.label}`);
          focusNextPendingAfter();
        },
        onError: (err) => {
          if (
            err instanceof ApiError &&
            err.status === 409 &&
            (err.code === 'REVIEW_CONFLICT' || err.code === 'VERSION_NOT_REVIEWABLE')
          ) {
            return;
          }
          setRowErrorByValueId((prev) => ({ ...prev, [val.id]: err }));
        },
      },
    );
  };

  const handleStartEdit = (val: ValueViewDto) => {
    setSelectedValueId(val.id);
    setEditingFieldKey(val.fieldKey);
    setDraftsByField((prev) =>
      prev[val.fieldKey] ? prev : { ...prev, [val.fieldKey]: initialDraftFor(val, templateCtx) },
    );
    setRowErrorByValueId((prev) => {
      const next = { ...prev };
      delete next[val.id];
      return next;
    });
  };

  const handleCancelEdit = (fieldKey: string) => {
    setEditingFieldKey(null);
    setDraftsByField((prev) => {
      const next = { ...prev };
      delete next[fieldKey];
      return next;
    });
  };

  if (invalidVersionParam) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-6">
        <div
          role="alert"
          className="rounded border border-red-300 bg-[var(--color-gap-bg)] p-4 text-sm text-[var(--color-gap)]"
        >
          Invalid version number &ldquo;{rawVersion}&rdquo;.{' '}
          <Link to={`/documents/${documentId}`} className="font-medium underline">
            Go to current version
          </Link>
        </div>
      </div>
    );
  }

  if (detailQuery.isLoading || (isHistorical && versionQuery.isLoading)) {
    return (
      <div className="mx-auto max-w-7xl px-4 py-6">
        <SkeletonRow />
        <SkeletonRow />
        <SkeletonRow />
      </div>
    );
  }

  if (!doc) {
    return null;
  }

  const activeStatus = isHistorical && historicalVer ? historicalVer.status : doc.status;
  const activeStatusBadge = statusBadgeFor(activeStatus);

  const newerFailed =
    !isHistorical &&
    doc.currentVersion.status === 'failed' &&
    doc.valuesVersion !== null &&
    doc.currentVersion.number > doc.valuesVersion;
  const newerExtracting =
    !isHistorical &&
    isStatusInFlight(doc.currentVersion.status) &&
    doc.valuesVersion !== null &&
    doc.currentVersion.number > doc.valuesVersion;
  const activeWarnings = isHistorical
    ? (historicalVer?.warnings ?? [])
    : doc.currentVersion.warnings;
  const hasSuspicious = activeWarnings.includes('SUSPICIOUS_INSTRUCTIONS');
  const hasHidden = activeWarnings.includes('HIDDEN_TEXT_PRESENT');
  const hasSecurityWarning = hasSuspicious || hasHidden;

  const progress = isHistorical && historicalVer ? historicalVer.progress : doc.progress;

  const hasActiveVersionInRecent =
    activeVersionNumber !== null &&
    doc.recentVersions.some((v) => v.number === activeVersionNumber);

  const showInFlightPanel =
    (!isHistorical && doc.valuesVersion === null && isStatusInFlight(doc.status)) ||
    (isHistorical && historicalVer !== undefined && isStatusInFlight(historicalVer.status));

  const showFailedPanel =
    (!isHistorical && doc.valuesVersion === null && doc.status === 'failed') ||
    (isHistorical && historicalVer !== undefined && historicalVer.status === 'failed');

  const failedError = isHistorical ? (historicalVer?.error ?? null) : doc.currentVersion.error;

  return (
    <div className="mx-auto max-w-7xl px-4 py-5">
      {/* Sticky document header (spec §14.2) */}
      <header className="sticky top-12 z-20 -mx-4 border-b border-[var(--color-border)] bg-[var(--color-surface)]/95 px-4 py-3 backdrop-blur">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Link
                to="/documents?view=needs-review"
                className="text-xs font-medium text-[var(--color-accent)] hover:underline"
              >
                Documents
              </Link>
              <span aria-hidden="true" className="text-xs text-[var(--color-ink-muted)]">
                /
              </span>
              <Badge>{doc.typeLabel}</Badge>
              <Badge tone={activeStatusBadge.tone}>{activeStatusBadge.label}</Badge>
            </div>
            <h1 className="mt-1 truncate text-lg font-semibold text-[var(--color-ink)]">
              {doc.title}
            </h1>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {doc.recentVersions.length > 0 ? (
              <label className="flex items-center gap-1.5 text-xs text-[var(--color-ink-muted)]">
                <span>Version</span>
                <select
                  aria-label="Version picker"
                  value={activeVersionNumber ?? doc.currentVersion.number}
                  onChange={(e) => {
                    const num = Number(e.target.value);
                    const isDefaultRouteVersion =
                      num === doc.valuesVersion ||
                      (doc.valuesVersion === null && num === doc.currentVersion.number);
                    if (isDefaultRouteVersion) {
                      void navigate(`/documents/${doc.id}`);
                    } else {
                      void navigate(`/documents/${doc.id}/versions/${num}`);
                    }
                  }}
                  className="min-h-8 rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-xs font-medium text-[var(--color-ink)]"
                >
                  {doc.recentVersions.map((v) => (
                    <option key={v.number} value={v.number}>
                      v{v.number} ({v.status})
                    </option>
                  ))}
                  {!hasActiveVersionInRecent && activeVersionNumber !== null ? (
                    <option key={activeVersionNumber} value={activeVersionNumber}>
                      v{activeVersionNumber}
                      {historicalVer ? ` (${historicalVer.status})` : ''}
                    </option>
                  ) : null}
                </select>
              </label>
            ) : null}

            <ProgressBar progress={progress} />

            <button
              type="button"
              onClick={() => setUploadVersionOpen(true)}
              className="inline-flex min-h-8 items-center rounded border border-[var(--color-border)] bg-[var(--color-surface-subtle)] px-3 py-1 text-xs font-medium text-[var(--color-ink)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
            >
              Upload new version
            </button>

            {!isHistorical &&
            (doc.currentVersion.status === 'extracted' ||
              doc.currentVersion.status === 'failed') ? (
              <button
                type="button"
                disabled={reextractMutation.isPending}
                onClick={() =>
                  reextractMutation.mutate({ versionNumber: doc.currentVersion.number })
                }
                className="inline-flex min-h-8 items-center rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1 text-xs font-medium text-[var(--color-ink)] hover:bg-[var(--color-surface-subtle)] disabled:opacity-60"
              >
                {reextractMutation.isPending ? 'Re-extracting…' : 'Re-extract'}
              </button>
            ) : null}

            {activeVersionNumber !== null ? (
              <a
                href={fileDownloadUrl(doc.id, activeVersionNumber)}
                download
                className="inline-flex min-h-8 items-center rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1 text-xs font-medium text-[var(--color-ink)] hover:bg-[var(--color-surface-subtle)]"
              >
                Download PDF
              </a>
            ) : null}
          </div>
        </div>

        {/* Count jump chips */}
        {values.length > 0 ? (
          <nav aria-label="Value groups" className="mt-2.5 flex flex-wrap gap-2">
            {groups.map((g) => (
              <a
                key={g.id}
                href={`#group-${g.id}`}
                className="tabular-nums inline-flex min-h-7 items-center gap-1.5 rounded border border-[var(--color-border)] bg-[var(--color-surface-subtle)] px-2.5 py-0.5 text-xs font-medium text-[var(--color-ink)] hover:border-[var(--color-accent)]"
              >
                <span>{g.heading}</span>
                <span className="font-semibold">{g.items.length}</span>
              </a>
            ))}
          </nav>
        ) : null}
      </header>

      {/* Polite status live region (spec §14.5) */}
      <div role="status" aria-live="polite" className="sr-only">
        {liveNotice ?? ''}
      </div>

      {/* Re-extract error alert if header Re-extract action failed */}
      {reextractMutation.error ? (
        <div className="mt-3">
          <Banner tone="gap" live="assertive">
            <span>
              {reextractMutation.error instanceof ApiError
                ? reextractMutation.error.status === 429 &&
                  reextractMutation.error.retryAfterSeconds !== undefined
                  ? `Wait ${reextractMutation.error.retryAfterSeconds}s before re-extracting.`
                  : getUiCopy(`problem.${reextractMutation.error.code}`)
                : reextractMutation.error.message}
            </span>
            <button
              type="button"
              onClick={() => reextractMutation.reset()}
              className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-0.5 text-xs font-medium text-[var(--color-ink)]"
            >
              Dismiss
            </button>
          </Banner>
        </div>
      ) : null}

      {/* Priority banner: at most one (spec §14.2) */}
      <div className="mt-4 space-y-3">
        {versionMovedBanner ? (
          <Banner tone="attention" live="polite">
            <span>{getUiCopy('problem.VERSION_NOT_REVIEWABLE')}</span>
            <button
              type="button"
              onClick={() => setVersionMovedBanner(false)}
              className="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-0.5 text-xs font-medium text-[var(--color-ink)]"
            >
              Dismiss
            </button>
          </Banner>
        ) : newerFailed ? (
          <Banner tone="gap" live="polite">
            <span>
              Version v{doc.currentVersion.number} failed:{' '}
              {doc.currentVersion.error
                ? getUiCopy(`versionError.${doc.currentVersion.error.code}`)
                : 'Extraction failed.'}
            </span>
            {doc.currentVersion.error?.retryable !== false ? (
              <RetryButton documentId={doc.id} versionNumber={doc.currentVersion.number} />
            ) : null}
          </Banner>
        ) : newerExtracting ? (
          <Banner tone="accent" live="polite">
            <span>
              Version v{doc.currentVersion.number} is extracting in the background. You are viewing
              v{doc.valuesVersion}.
            </span>
          </Banner>
        ) : isHistorical ? (
          <Banner tone="neutral">
            <span>Viewing v{requestedVersion} (read-only)</span>
            <Link
              to={`/documents/${doc.id}`}
              className="font-medium text-[var(--color-accent)] underline"
            >
              Go to current
            </Link>
          </Banner>
        ) : hasSecurityWarning ? (
          <Banner tone="attention">
            <span>
              {hasSuspicious && hasHidden
                ? 'Document contains suspicious instruction text and hidden/off-page text. Verify every value against the highlighted source lines.'
                : hasSuspicious
                  ? 'Document contains suspicious instruction text. Verify every value against the highlighted source lines.'
                  : 'Hidden or off-page text was detected in this PDF and excluded from automatic evidence.'}
            </span>
          </Banner>
        ) : null}
      </div>

      {/* Main content: in-flight stepper, failed panel, or two-pane detail */}
      {showInFlightPanel ? (
        <section
          aria-label="Extraction progress"
          className="mt-6 rounded border border-[var(--color-border)] bg-[var(--color-surface-subtle)] p-6"
        >
          <h2 className="text-base font-semibold text-[var(--color-ink)]">
            Extracting fields from v{activeVersionNumber ?? doc.currentVersion.number}
          </h2>
          <ol className="mt-3 flex flex-wrap gap-4 text-sm">
            <li className="font-semibold text-[var(--color-accent)]">1. Queued</li>
            <li
              className={
                activeStatus === 'extracting'
                  ? 'font-semibold text-[var(--color-accent)]'
                  : 'text-[var(--color-ink-muted)]'
              }
            >
              2. Extracting
            </li>
            <li className="text-[var(--color-ink-muted)]">3. Ready to review</li>
          </ol>
        </section>
      ) : showFailedPanel ? (
        <section
          role="alert"
          className="mt-6 rounded border border-red-300 bg-[var(--color-gap-bg)] p-6 text-[var(--color-gap)]"
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold">Extraction failed</h2>
              <p className="mt-1 text-sm text-[var(--color-ink)]">
                {failedError
                  ? getUiCopy(`versionError.${failedError.code}`)
                  : 'Extraction could not be completed.'}
              </p>
            </div>
            {failedError?.retryable !== false && activeVersionNumber !== null ? (
              <RetryButton documentId={doc.id} versionNumber={activeVersionNumber} />
            ) : null}
          </div>
          {failedError ? (
            <details className="mt-3 text-xs text-[var(--color-ink-muted)]">
              <summary className="cursor-pointer font-medium">Details</summary>
              <p className="mt-1 font-mono">
                Code: {failedError.code} · {failedError.message}
              </p>
            </details>
          ) : null}
        </section>
      ) : (
        <div className="mt-4 grid grid-cols-1 gap-5 min-[1200px]:grid-cols-12">
          {/* Left pane (~55% -> 7/12 cols at >=1200px): Values grouped Changed -> Gaps -> Pending -> Done */}
          <div className="space-y-4 min-[1200px]:col-span-7">
            {groups.map((group) => {
              const isDone = group.id === 'done';
              const collapsed = isDone && !doneExpanded;
              return (
                <section
                  key={group.id}
                  id={`group-${group.id}`}
                  aria-labelledby={`heading-${group.id}`}
                  className="overflow-hidden rounded border border-[var(--color-border)] bg-[var(--color-surface)]"
                >
                  <div className="flex items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-surface-subtle)] px-4 py-2.5">
                    <h2
                      id={`heading-${group.id}`}
                      className="text-sm font-semibold text-[var(--color-ink)]"
                    >
                      {group.heading}{' '}
                      <span className="tabular-nums font-normal text-[var(--color-ink-muted)]">
                        ({group.items.length})
                      </span>
                    </h2>
                    {isDone ? (
                      <button
                        type="button"
                        data-done-toggle="true"
                        aria-expanded={doneExpanded}
                        onClick={() => setDoneExpanded((prev) => !prev)}
                        className="inline-flex min-h-7 items-center rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-0.5 text-xs font-medium text-[var(--color-ink)] hover:bg-[var(--color-surface-subtle)]"
                      >
                        {doneExpanded ? 'Hide done' : `Show done (${group.items.length})`}
                      </button>
                    ) : null}
                  </div>

                  {collapsed ? null : group.items.length === 0 ? (
                    <p className="px-4 py-3 text-xs text-[var(--color-ink-muted)]">None</p>
                  ) : (
                    <div>
                      {group.items.map((item) => {
                        const isEditing = !isHistorical && editingFieldKey === item.fieldKey;
                        const activeDraft =
                          draftsByField[item.fieldKey] ?? initialDraftFor(item, templateCtx);
                        const hasConflict = Object.prototype.hasOwnProperty.call(
                          conflictsByValueId,
                          item.id,
                        );
                        const rowError = rowErrorByValueId[item.id] ?? null;

                        return (
                          <ValueRow
                            key={item.id}
                            value={item}
                            selected={selectedValue?.id === item.id}
                            onSelect={(val) => setSelectedValueId(val.id)}
                            actions={
                              <ReviewActions
                                value={item}
                                readOnly={isHistorical}
                                editing={isEditing}
                                busy={reviewMutation.pendingValueIds.has(item.id)}
                                onApprove={() => handleApprove(item)}
                                onStartEdit={() => handleStartEdit(item)}
                              />
                            }
                            conflict={
                              <>
                                {hasConflict ? (
                                  <ConflictCard
                                    currentValue={conflictsByValueId[item.id] ?? null}
                                    onDismiss={() =>
                                      setConflictsByValueId((prev) => {
                                        const next = { ...prev };
                                        delete next[item.id];
                                        return next;
                                      })
                                    }
                                  />
                                ) : null}
                                {!isEditing && rowError ? (
                                  <div
                                    role="alert"
                                    className="mt-2 rounded border border-red-300 bg-[var(--color-gap-bg)] px-2.5 py-1.5 text-xs text-[var(--color-gap)]"
                                  >
                                    {rowError instanceof ApiError
                                      ? rowError.status === 429 &&
                                        rowError.retryAfterSeconds !== undefined
                                        ? `Wait ${rowError.retryAfterSeconds}s and try again.`
                                        : getUiCopy(`problem.${rowError.code}`)
                                      : rowError.message}
                                  </div>
                                ) : null}
                              </>
                            }
                            editor={
                              isEditing ? (
                                <CorrectionForm
                                  value={item}
                                  templateCtx={templateCtx}
                                  draft={activeDraft}
                                  onDraftChange={(next) => {
                                    setDraftsByField((prev) => ({
                                      ...prev,
                                      [item.fieldKey]: next,
                                    }));
                                    if (rowErrorByValueId[item.id]) {
                                      setRowErrorByValueId((prev) => {
                                        const updated = { ...prev };
                                        delete updated[item.id];
                                        return updated;
                                      });
                                    }
                                  }}
                                  onCancel={() => handleCancelEdit(item.fieldKey)}
                                  submitting={reviewMutation.pendingValueIds.has(item.id)}
                                  serverError={rowError}
                                  onSubmit={async ({ correctedValue, canonicalValue, note }) => {
                                    setRowErrorByValueId((prev) => {
                                      const next = { ...prev };
                                      delete next[item.id];
                                      return next;
                                    });
                                    try {
                                      await reviewMutation.mutateAsync({
                                        valueId: item.id,
                                        fieldKey: item.fieldKey,
                                        optimisticCorrectedValue: canonicalValue,
                                        body: {
                                          decision: 'correct',
                                          correctedValue,
                                          ...(note !== undefined ? { note } : {}),
                                          expectedCurrentReviewId: item.review?.id ?? null,
                                        },
                                      });
                                      handleCancelEdit(item.fieldKey);
                                      setLiveNotice(`Corrected ${item.label}`);
                                      focusNextPendingAfter();
                                    } catch (err) {
                                      if (
                                        err instanceof ApiError &&
                                        err.status === 409 &&
                                        (err.code === 'REVIEW_CONFLICT' ||
                                          err.code === 'VERSION_NOT_REVIEWABLE')
                                      ) {
                                        // Preserve the reviewer's draft on both REVIEW_CONFLICT and VERSION_NOT_REVIEWABLE.
                                        return;
                                      }
                                      if (err instanceof Error) {
                                        setRowErrorByValueId((prev) => ({
                                          ...prev,
                                          [item.id]: err,
                                        }));
                                      }
                                    }
                                  }}
                                />
                              ) : null
                            }
                          />
                        );
                      })}
                    </div>
                  )}
                </section>
              );
            })}
          </div>

          {/* Right pane (~45% -> 5/12 cols): Text pane wrapped in its own ErrorBoundary */}
          <div className="min-[1200px]:col-span-5">
            <ErrorBoundary
              title="Source text pane unavailable"
              resetKey={`${doc.id}:${activeVersionNumber}`}
              onReset={() => void textQuery.refetch()}
            >
              {activeVersionNumber !== null ? (
                <TextPane
                  documentId={doc.id}
                  versionNumber={activeVersionNumber}
                  text={textQuery.data ?? null}
                  loading={textQuery.isLoading}
                  error={textQuery.error}
                  textRanges={textRanges}
                  activeEvidence={selectedValue?.evidence ?? null}
                  activeFieldLabel={selectedValue?.label ?? null}
                  hash={location.hash}
                />
              ) : null}
            </ErrorBoundary>
          </div>
        </div>
      )}

      <UploadVersionDialog
        documentId={doc.id}
        open={uploadVersionOpen}
        onClose={() => setUploadVersionOpen(false)}
        onUploaded={(deduplicated, versionNumber) => {
          setLiveNotice(
            deduplicated
              ? `File matches existing v${versionNumber}; no new extraction needed.`
              : `Uploaded v${versionNumber}; extraction started.`,
          );
        }}
      />
    </div>
  );
}
