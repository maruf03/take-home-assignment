import type { Page } from '@app/contracts/page';
import type { VersionErrorCode } from '@app/contracts/problems';
import type { RunStatus, RunTrigger } from '@app/contracts/status';
import { and, asc, desc, eq, gte, inArray, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import type { AppTransaction, DbTx } from '../client.js';
import { documentVersions, extractionRuns } from '../schema/documents.js';
import { fingerprintFilters, isValidPositiveIntKey, keyset, toPage } from './keyset.js';
import { touch } from './touch.js';

export type ExtractionRunRow = typeof extractionRuns.$inferSelect;

export interface ClaimVersionOptions {
  trigger?: RunTrigger;
  correlationId?: string | null;
  leaseSeconds?: number;
}

export interface ClaimResult {
  runId: string;
  runNumber: number;
}

const DEFAULT_LEASE_SECONDS = 30;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_SWEEP_LIMIT = 500;
const DEFAULT_SWEEP_COOLDOWN_SECONDS = 10;

/**
 * Follows spec §3 Claim literally:
 * 1. Lock document_versions FOR UPDATE (status = 'queued')
 * 2. Increment monotonic run_seq RETURNING run_seq
 * 3. INSERT extraction_runs (run_number = run_seq, status = 'running')
 * 4. UPDATE document_versions (status = 'extracting', active_run_id, lease_until, worker_id, attempts + 1)
 */
export async function claimVersion(
  tx: AppTransaction,
  versionId: string,
  workerId: string,
  options: ClaimVersionOptions = {},
): Promise<ClaimResult | null> {
  const leaseSeconds = Math.max(1, Math.trunc(options.leaseSeconds ?? DEFAULT_LEASE_SECONDS));
  const trigger = options.trigger ?? 'upload';

  const locked = await tx
    .select({ id: documentVersions.id })
    .from(documentVersions)
    .where(and(eq(documentVersions.id, versionId), eq(documentVersions.status, 'queued')))
    .for('update');

  if (!locked[0]) {
    return null;
  }

  const [seqRow] = await tx
    .update(documentVersions)
    .set({
      runSeq: sql`${documentVersions.runSeq} + 1`,
      ...touch(),
    })
    .where(eq(documentVersions.id, versionId))
    .returning({ runSeq: documentVersions.runSeq });

  const runNumber = seqRow!.runSeq;

  const [run] = await tx
    .insert(extractionRuns)
    .values({
      versionId,
      runNumber,
      status: 'running',
      trigger,
      correlationId: options.correlationId ?? null,
      workerId,
    })
    .returning({ id: extractionRuns.id });

  const runId = run!.id;

  await tx
    .update(documentVersions)
    .set({
      status: 'extracting',
      activeRunId: runId,
      leaseUntil: sql`now() + (${leaseSeconds} * interval '1 second')`,
      workerId,
      attempts: sql`${documentVersions.attempts} + 1`,
      ...touch(),
    })
    .where(eq(documentVersions.id, versionId));

  return { runId, runNumber };
}

/**
 * Extends lease using Postgres now(); returns false if fencing token no longer matches (spec §3).
 */
export async function heartbeat(
  tx: DbTx,
  versionId: string,
  runId: string,
  leaseSeconds = DEFAULT_LEASE_SECONDS,
): Promise<boolean> {
  const safeLeaseSeconds = Math.max(1, Math.trunc(leaseSeconds));
  const updated = await tx
    .update(documentVersions)
    .set({
      leaseUntil: sql`now() + (${safeLeaseSeconds} * interval '1 second')`,
      ...touch(),
    })
    .where(and(eq(documentVersions.id, versionId), eq(documentVersions.activeRunId, runId)))
    .returning({ id: documentVersions.id });

  return updated.length === 1;
}

/**
 * Fenced permanent failure (spec §3 Fail).
 */
export async function failRun(
  tx: AppTransaction,
  versionId: string,
  runId: string,
  code: VersionErrorCode,
  message: string,
): Promise<boolean> {
  const updated = await tx
    .update(documentVersions)
    .set({
      status: 'failed',
      activeRunId: null,
      leaseUntil: null,
      workerId: null,
      lastErrorCode: code,
      lastErrorMessage: message,
      ...touch(),
    })
    .where(and(eq(documentVersions.id, versionId), eq(documentVersions.activeRunId, runId)))
    .returning({ id: documentVersions.id });

  if (updated.length !== 1) {
    return false;
  }

  await tx
    .update(extractionRuns)
    .set({
      status: 'failed',
      errorCode: code,
      errorMessage: message,
      finishedAt: sql`now()`,
    })
    .where(and(eq(extractionRuns.id, runId), eq(extractionRuns.status, 'running')));

  return true;
}

/**
 * Fenced transient release (spec §3 Release): sets status='queued' with future enqueued_at backoff
 * so a BullMQ delayed retry (or sweep after backoff) can claim without hitting 'extracting'.
 */
export async function releaseRun(
  tx: AppTransaction,
  versionId: string,
  runId: string,
  code: string,
  backoffMs: number,
  message?: string,
): Promise<boolean> {
  const safeBackoffMs = Math.max(0, Math.trunc(backoffMs));

  const updated = await tx
    .update(documentVersions)
    .set({
      status: 'queued',
      activeRunId: null,
      leaseUntil: null,
      workerId: null,
      enqueuedAt: sql`now() + (${safeBackoffMs} * interval '1 millisecond')`,
      ...touch(),
    })
    .where(and(eq(documentVersions.id, versionId), eq(documentVersions.activeRunId, runId)))
    .returning({ id: documentVersions.id });

  if (updated.length !== 1) {
    return false;
  }

  await tx
    .update(extractionRuns)
    .set({
      status: 'failed',
      errorCode: code,
      errorMessage: message ?? code,
      finishedAt: sql`now()`,
    })
    .where(and(eq(extractionRuns.id, runId), eq(extractionRuns.status, 'running')));

  return true;
}

/**
 * Sweep step 1 (boot only): release leases held by this workerId and mark runs abandoned.
 * Never touches `documents` (spec §3, §6).
 */
export async function sweepBootRelease(tx: AppTransaction, workerId: string): Promise<string[]> {
  const locked = await tx
    .select({
      id: documentVersions.id,
      activeRunId: documentVersions.activeRunId,
    })
    .from(documentVersions)
    .where(and(eq(documentVersions.status, 'extracting'), eq(documentVersions.workerId, workerId)))
    .for('update', { skipLocked: true });

  if (locked.length === 0) {
    return [];
  }

  const versionIds = locked.map((r) => r.id);
  const runIds = locked.map((r) => r.activeRunId).filter((id): id is string => id !== null);

  await tx
    .update(documentVersions)
    .set({
      status: 'queued',
      activeRunId: null,
      leaseUntil: null,
      workerId: null,
      enqueuedAt: null,
      ...touch(),
    })
    .where(inArray(documentVersions.id, versionIds));

  if (runIds.length > 0) {
    await tx
      .update(extractionRuns)
      .set({
        status: 'abandoned',
        finishedAt: sql`now()`,
      })
      .where(and(inArray(extractionRuns.id, runIds), eq(extractionRuns.status, 'running')));
  }

  return versionIds;
}

/**
 * Sweep step 2: release expired leases (lease_until < now()) and mark runs abandoned (spec §6).
 */
export async function sweepExpired(tx: AppTransaction): Promise<string[]> {
  const locked = await tx
    .select({
      id: documentVersions.id,
      activeRunId: documentVersions.activeRunId,
    })
    .from(documentVersions)
    .where(
      and(eq(documentVersions.status, 'extracting'), lt(documentVersions.leaseUntil, sql`now()`)),
    )
    .for('update', { skipLocked: true });

  if (locked.length === 0) {
    return [];
  }

  const versionIds = locked.map((r) => r.id);
  const runIds = locked.map((r) => r.activeRunId).filter((id): id is string => id !== null);

  await tx
    .update(documentVersions)
    .set({
      status: 'queued',
      activeRunId: null,
      leaseUntil: null,
      workerId: null,
      enqueuedAt: null,
      ...touch(),
    })
    .where(inArray(documentVersions.id, versionIds));

  if (runIds.length > 0) {
    await tx
      .update(extractionRuns)
      .set({
        status: 'abandoned',
        finishedAt: sql`now()`,
      })
      .where(and(inArray(extractionRuns.id, runIds), eq(extractionRuns.status, 'running')));
  }

  return versionIds;
}

/**
 * Sweep step 3: fail queued versions that exhausted attempts >= maxAttempts (spec §6).
 */
export async function sweepPoison(tx: DbTx, maxAttempts = DEFAULT_MAX_ATTEMPTS): Promise<string[]> {
  const updated = await tx
    .update(documentVersions)
    .set({
      status: 'failed',
      lastErrorCode: 'MAX_ATTEMPTS',
      lastErrorMessage: `Exceeded maximum extraction attempts (${maxAttempts})`,
      ...touch(),
    })
    .where(and(eq(documentVersions.status, 'queued'), gte(documentVersions.attempts, maxAttempts)))
    .returning({ id: documentVersions.id });

  return updated.map((r) => r.id);
}

export interface SweepCandidate {
  versionId: string;
  documentId: string;
  createdRequestId: string | null;
}

/**
 * Sweep step 4: pick up to `limit` queued versions whose enqueued_at IS NULL or older than cooldown
 * (skipping future backoff timestamps), stamp enqueued_at = now(), and return them for BullMQ enqueue.
 */
export async function sweepCandidates(
  tx: AppTransaction,
  limit = DEFAULT_SWEEP_LIMIT,
  cooldownSeconds = DEFAULT_SWEEP_COOLDOWN_SECONDS,
): Promise<SweepCandidate[]> {
  const locked = await tx
    .select({
      versionId: documentVersions.id,
      documentId: documentVersions.documentId,
      createdRequestId: documentVersions.createdRequestId,
    })
    .from(documentVersions)
    .where(
      and(
        eq(documentVersions.status, 'queued'),
        or(
          isNull(documentVersions.enqueuedAt),
          lt(documentVersions.enqueuedAt, sql`now() - (${cooldownSeconds} * interval '1 second')`),
        ),
      ),
    )
    .orderBy(sql`${documentVersions.enqueuedAt} ASC NULLS FIRST`, asc(documentVersions.id))
    .limit(limit)
    .for('update', { skipLocked: true });

  if (locked.length === 0) {
    return [];
  }

  await tx
    .update(documentVersions)
    .set({
      enqueuedAt: sql`now()`,
      ...touch(),
    })
    .where(
      inArray(
        documentVersions.id,
        locked.map((r) => r.versionId),
      ),
    );

  return locked;
}

export interface ListRunsParams {
  status?: RunStatus;
  limit?: number;
  cursor?: string;
}

export async function listRuns(
  tx: DbTx,
  versionId: string,
  params: ListRunsParams = {},
): Promise<Page<ExtractionRunRow>> {
  const fingerprint = fingerprintFilters({ status: params.status });

  const ks = keyset({
    key: extractionRuns.runNumber,
    cursor: params.cursor,
    limit: params.limit,
    direction: 'desc',
    fingerprint,
    validateKey: isValidPositiveIntKey,
    parseKey: (k) => Number(k),
  });

  const conditions: SQL[] = [eq(extractionRuns.versionId, versionId)];
  if (params.status !== undefined) {
    conditions.push(eq(extractionRuns.status, params.status));
  }
  if (ks.whereClause) {
    conditions.push(ks.whereClause);
  }

  const rows = await tx
    .select()
    .from(extractionRuns)
    .where(and(...conditions))
    .orderBy(desc(extractionRuns.runNumber))
    .limit(ks.limitPlusOne);

  return toPage(rows, ks.limit, (row) => String(row.runNumber), fingerprint);
}

export async function getRunById(
  tx: DbTx,
  versionId: string,
  runId: string,
): Promise<ExtractionRunRow | null> {
  const rows = await tx
    .select()
    .from(extractionRuns)
    .where(and(eq(extractionRuns.versionId, versionId), eq(extractionRuns.id, runId)))
    .limit(1);
  return rows[0] ?? null;
}

const SWEEP_ADVISORY_LOCK_KEY = 7_120_001;

/**
 * Acquires a non-blocking transaction-scoped Postgres advisory lock for multi-replica
 * sweep leader election (spec §6). Returns `true` if this transaction holds leadership.
 */
export async function tryAdvisorySweepLock(tx: AppTransaction): Promise<boolean> {
  const res = await tx.execute<{ locked: boolean }>(
    sql`SELECT pg_try_advisory_xact_lock(${SWEEP_ADVISORY_LOCK_KEY}) AS locked`,
  );
  return res.rows[0]?.locked === true;
}

export interface VersionStatusCounts {
  queued: number;
  extracting: number;
  extracted: number;
  failed: number;
}

/**
 * Counts document_versions grouped by status for the worker's `versions_by_status` gauge (spec §6, §9).
 */
export async function countVersionsByStatus(tx: DbTx): Promise<VersionStatusCounts> {
  const res = await tx.execute<{ status: string; cnt: number }>(sql`
    SELECT status, COUNT(*)::int AS cnt
    FROM document_versions
    GROUP BY status
  `);
  const counts: VersionStatusCounts = { queued: 0, extracting: 0, extracted: 0, failed: 0 };
  for (const row of res.rows) {
    if (
      row.status === 'queued' ||
      row.status === 'extracting' ||
      row.status === 'extracted' ||
      row.status === 'failed'
    ) {
      counts[row.status] = row.cnt;
    }
  }
  return counts;
}
