import type { ValueViewDto } from '@app/contracts/dto';
import { getUiCopy } from '@app/contracts/ui-copy';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  useDocumentDetail,
  useVersionDetail,
  useVersionText,
} from '../entities/document/queries.js';
import { TextPane } from '../entities/document/TextPane.js';
import { ValueRow } from '../entities/document/ValueRow.js';
import { fileDownloadUrl } from '../shared/api/client.js';
import { DEFAULT_POLL_MS, isStatusInFlight } from '../shared/api/polling.js';
import { ErrorBoundary } from '../shared/ui/ErrorBoundary.js';
import { Badge, Banner, ProgressBar, SkeletonRow } from '../shared/ui/Primitives.js';

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
  const navigate = useNavigate();
  const documentId = params.id ?? '';
  const requestedVersion = params.n !== undefined ? Number(params.n) : null;
  const isHistorical = requestedVersion !== null && Number.isInteger(requestedVersion);

  const detailQuery = useDocumentDetail(documentId, pollMs);
  const versionQuery = useVersionDetail(documentId, isHistorical ? requestedVersion : null);

  const doc = detailQuery.data;
  const historicalVer = versionQuery.data;

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
    ? historicalVer !== undefined && historicalVer.status !== 'queued'
    : doc !== undefined && doc.valuesVersion !== null;

  const textQuery = useVersionText(documentId, activeVersionNumber, hasText);

  const prevVersionNumber = useMemo(() => {
    const withPrev = values.find((v) => v.previous !== null);
    return withPrev?.previous?.versionNumber ?? null;
  }, [values]);

  const groups = useMemo(() => groupValues(values, prevVersionNumber), [values, prevVersionNumber]);

  const [selectedValueId, setSelectedValueId] = useState<string | null>(null);
  const [doneExpanded, setDoneExpanded] = useState(false);

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
  const hasSecurityWarning =
    activeWarnings.includes('SUSPICIOUS_INSTRUCTIONS') ||
    activeWarnings.includes('HIDDEN_TEXT_PRESENT');

  const progress = isHistorical && historicalVer ? historicalVer.progress : doc.progress;

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
                    if (num === doc.valuesVersion || num === doc.currentVersion.number) {
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
                </select>
              </label>
            ) : null}

            <ProgressBar progress={progress} />

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

      {/* Priority banner: at most one (spec §14.2) */}
      <div className="mt-4 space-y-3">
        {newerFailed ? (
          <Banner tone="gap" live="polite">
            <span>
              Version v{doc.currentVersion.number} failed:{' '}
              {doc.currentVersion.error
                ? getUiCopy(`versionError.${doc.currentVersion.error.code}`)
                : 'Extraction failed.'}
            </span>
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
              {activeWarnings.includes('SUSPICIOUS_INSTRUCTIONS')
                ? 'Document contains suspicious instruction text. Verify every value against the highlighted source lines.'
                : 'Hidden or off-page text was detected in this PDF and excluded from automatic evidence.'}
            </span>
          </Banner>
        ) : null}
      </div>

      {/* Main content: in-flight stepper, failed panel, or two-pane detail */}
      {!isHistorical && doc.valuesVersion === null && isStatusInFlight(doc.status) ? (
        <section
          aria-label="Extraction progress"
          className="mt-6 rounded border border-[var(--color-border)] bg-[var(--color-surface-subtle)] p-6"
        >
          <h2 className="text-base font-semibold text-[var(--color-ink)]">
            Extracting fields from v{doc.currentVersion.number}
          </h2>
          <ol className="mt-3 flex flex-wrap gap-4 text-sm">
            <li className="font-semibold text-[var(--color-accent)]">1. Queued</li>
            <li
              className={
                doc.status === 'extracting'
                  ? 'font-semibold text-[var(--color-accent)]'
                  : 'text-[var(--color-ink-muted)]'
              }
            >
              2. Extracting
            </li>
            <li className="text-[var(--color-ink-muted)]">3. Ready to review</li>
          </ol>
        </section>
      ) : !isHistorical && doc.valuesVersion === null && doc.status === 'failed' ? (
        <section
          role="alert"
          className="mt-6 rounded border border-red-300 bg-[var(--color-gap-bg)] p-6 text-[var(--color-gap)]"
        >
          <h2 className="text-base font-semibold">Extraction failed</h2>
          <p className="mt-1 text-sm text-[var(--color-ink)]">
            {doc.currentVersion.error
              ? getUiCopy(`versionError.${doc.currentVersion.error.code}`)
              : 'Extraction could not be completed.'}
          </p>
          {doc.currentVersion.error ? (
            <p className="mt-2 font-mono text-xs text-[var(--color-ink-muted)]">
              Code: {doc.currentVersion.error.code}
            </p>
          ) : null}
        </section>
      ) : (
        <div className="mt-4 grid grid-cols-1 gap-5 xl:grid-cols-12">
          {/* Left pane (~55% -> 7/12 cols at >=1280px): Values grouped Changed -> Gaps -> Pending -> Done */}
          <div className="space-y-4 xl:col-span-7">
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
                      {group.items.map((item) => (
                        <ValueRow
                          key={item.id}
                          value={item}
                          selected={selectedValue?.id === item.id}
                          onSelect={(val) => setSelectedValueId(val.id)}
                        />
                      ))}
                    </div>
                  )}
                </section>
              );
            })}
          </div>

          {/* Right pane (~45% -> 5/12 cols): Text pane wrapped in its own ErrorBoundary */}
          <div className="xl:col-span-5">
            <ErrorBoundary title="Source text pane unavailable">
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
                />
              ) : null}
            </ErrorBoundary>
          </div>
        </div>
      )}
    </div>
  );
}
