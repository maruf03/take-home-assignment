import type {
  ChangeKind,
  ChangeReason,
  ExtractedValueKind,
  FieldType,
  GapCode,
  MatchMode,
  ValueFlag,
  VersionWarning,
} from '@app/contracts/status';
import type { TypedValue } from '@app/contracts/values';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { AppTransaction, DbTx } from '../client.js';
import { documents, documentVersions, extractionRuns } from '../schema/documents.js';
import { extractedValues, reviews } from '../schema/values.js';
import type { DocumentRow, DocumentVersionRow } from './documents.js';
import { touch } from './touch.js';

export type ExtractedValueRow = typeof extractedValues.$inferSelect;

export interface CarriedReviewInput {
  decision: 'approve' | 'correct';
  correctedValue?: TypedValue | null;
  note?: string | null;
  carriedFromReviewId: string;
}

export interface FinalizeValueInput {
  fieldKey: string;
  fieldType: FieldType;
  kind: ExtractedValueKind;
  value?: TypedValue | null;
  rawValue?: string | null;
  evidence?: string | null;
  attemptedQuote?: string | null;
  canonicalEvidence?: string | null;
  evidenceStart?: number | null;
  evidenceEnd?: number | null;
  evidenceMatchCount?: number | null;
  citedLine?: number | null;
  matchMode?: MatchMode | null;
  chunkIndex?: number | null;
  gapCode?: GapCode | null;
  gapReason?: string | null;
  flags?: ValueFlag[];
  baselineValueId?: string | null;
  changeKind: ChangeKind;
  changeReason?: ChangeReason | null;
  carriedReview?: CarriedReviewInput | null;
}

export interface FinalizeBuildValuesContext {
  tx: AppTransaction;
  document: DocumentRow;
  version: DocumentVersionRow;
}

export interface FinalizeRunInput {
  warnings: VersionWarning[];
  chunked: boolean;
  llmCallCount: number;
  reusedCallCount: number;
  costUsd: string;
  values?: FinalizeValueInput[];
  /**
   * Optional callback invoked strictly AFTER `documents FOR UPDATE` and fenced
   * `document_versions FOR UPDATE` are held, so carry-over baseline/review reads
   * cannot race with concurrent finalizes or human reviews under READ COMMITTED.
   */
  buildValues?: (ctx: FinalizeBuildValuesContext) => Promise<FinalizeValueInput[]>;
}

export type FinalizeRunResult =
  | {
      ok: true;
      pointerMoved: boolean;
      pendingCount: number;
      insertedCount: number;
    }
  | {
      ok: false;
      reason: 'fenced' | 'document_deleted';
    };

/**
 * Follows spec §3 Finalize lock order strictly:
 * 1. Read immutable document_id (no lock)
 * 2. Lock documents FOR UPDATE (abort if deleted_at IS NOT NULL)
 * 3. Lock document_versions FOR UPDATE and verify active_run_id = runId AND status = 'extracting'
 * 4. Update document_versions (status = 'extracted', clear lease, extracted_at = now())
 * 5. Update extraction_runs (status = 'succeeded', counts, cost_usd, finished_at = now())
 * 6. INSERT extracted_values ... ON CONFLICT (version_id, field_key) DO NOTHING RETURNING *
 * 7. Insert carried reviews and update extracted_values.current_review_id
 * 8. Move documents.reviewable_version_id iff newer, recomputing pending_count absolutely.
 */
export async function finalizeRun(
  tx: AppTransaction,
  versionId: string,
  runId: string,
  input: FinalizeRunInput,
): Promise<FinalizeRunResult> {
  // 1. Resolve immutable document_id without acquiring a lock out of order.
  const verMeta = await tx
    .select({ documentId: documentVersions.documentId })
    .from(documentVersions)
    .where(eq(documentVersions.id, versionId))
    .limit(1);
  const docId = verMeta[0]?.documentId;
  if (!docId) {
    return { ok: false, reason: 'fenced' };
  }

  // 2. Lock documents FOR UPDATE first.
  const lockedDocs = await tx.select().from(documents).where(eq(documents.id, docId)).for('update');
  const doc = lockedDocs[0];
  if (!doc || doc.deletedAt !== null) {
    return { ok: false, reason: 'document_deleted' };
  }

  // 3. Lock document_versions FOR UPDATE and check fencing token.
  const lockedVersions = await tx
    .select()
    .from(documentVersions)
    .where(eq(documentVersions.id, versionId))
    .for('update');
  const ver = lockedVersions[0];
  if (!ver || ver.activeRunId !== runId || ver.status !== 'extracting') {
    return { ok: false, reason: 'fenced' };
  }

  // Resolve values (including baseline/carry-over reads) ONLY AFTER holding both
  // documents FOR UPDATE and document_versions FOR UPDATE.
  const values = input.buildValues
    ? await input.buildValues({ tx, document: doc, version: ver })
    : (input.values ?? []);

  // 4. Mark version extracted and clear lease (fenced).
  await tx
    .update(documentVersions)
    .set({
      status: 'extracted',
      activeRunId: null,
      leaseUntil: null,
      workerId: null,
      warnings: input.warnings,
      extractedAt: sql`now()`,
      ...touch(),
    })
    .where(and(eq(documentVersions.id, versionId), eq(documentVersions.activeRunId, runId)));

  // 5. Complete extraction run (strict lock order: document_versions -> extraction_runs -> extracted_values -> reviews).
  await tx
    .update(extractionRuns)
    .set({
      status: 'succeeded',
      chunked: input.chunked,
      llmCallCount: input.llmCallCount,
      reusedCallCount: input.reusedCallCount,
      costUsd: input.costUsd,
      finishedAt: sql`now()`,
    })
    .where(and(eq(extractionRuns.id, runId), eq(extractionRuns.status, 'running')));

  // 6. Bulk insert extracted values idempotently.
  const insertedRows: ExtractedValueRow[] =
    values.length > 0
      ? await tx
          .insert(extractedValues)
          .values(
            values.map((v) => ({
              versionId,
              runId,
              fieldKey: v.fieldKey,
              fieldType: v.fieldType,
              kind: v.kind,
              value: v.kind === 'value' ? (v.value ?? null) : null,
              rawValue: v.rawValue ?? null,
              evidence: v.kind === 'value' ? (v.evidence ?? null) : null,
              attemptedQuote: v.kind === 'gap' ? (v.attemptedQuote ?? null) : null,
              canonicalEvidence: v.kind === 'value' ? (v.canonicalEvidence ?? null) : null,
              evidenceStart: v.evidenceStart ?? null,
              evidenceEnd: v.evidenceEnd ?? null,
              evidenceMatchCount: v.evidenceMatchCount ?? null,
              citedLine: v.citedLine ?? null,
              matchMode: v.matchMode ?? null,
              chunkIndex: v.chunkIndex ?? null,
              gapCode: v.kind === 'gap' ? (v.gapCode ?? null) : null,
              gapReason: v.kind === 'gap' ? (v.gapReason ?? null) : null,
              flags: v.flags ?? [],
              baselineValueId: v.baselineValueId ?? null,
              changeKind: v.changeKind,
              changeReason: v.changeReason ?? null,
            })),
          )
          .onConflictDoNothing({
            target: [extractedValues.versionId, extractedValues.fieldKey],
          })
          .returning()
      : [];

  // 7. Insert carried reviews for newly inserted values and link current_review_id.
  const inputByFieldKey = new Map<string, FinalizeValueInput>();
  for (const item of values) {
    inputByFieldKey.set(item.fieldKey, item);
  }

  for (const row of insertedRows) {
    const carried = inputByFieldKey.get(row.fieldKey)?.carriedReview;
    if (!carried) {
      continue;
    }
    const [insertedReview] = await tx
      .insert(reviews)
      .values({
        valueId: row.id,
        fieldType: row.fieldType,
        decision: carried.decision,
        correctedValue: carried.decision === 'correct' ? (carried.correctedValue ?? null) : null,
        note: carried.note ?? null,
        origin: 'carried',
        carriedFromReviewId: carried.carriedFromReviewId,
        requestId: null,
      })
      .returning({ id: reviews.id });

    await tx
      .update(extractedValues)
      .set({ currentReviewId: insertedReview!.id })
      .where(eq(extractedValues.id, row.id));
  }

  // 8. Move reviewable_version_id iff this version is newer than the current reviewable version.
  let shouldMovePointer = doc.reviewableVersionId === null;
  if (!shouldMovePointer && doc.reviewableVersionId !== null) {
    const currentReviewable = await tx
      .select({ versionNumber: documentVersions.versionNumber })
      .from(documentVersions)
      .where(eq(documentVersions.id, doc.reviewableVersionId))
      .limit(1);
    const currentNumber = currentReviewable[0]?.versionNumber ?? 0;
    shouldMovePointer = ver.versionNumber > currentNumber;
  }

  let pendingCount = doc.pendingCount;
  if (shouldMovePointer) {
    // Recompute pending_count absolutely from source rows only when moving the reviewable pointer.
    const countRes = await tx.execute<{ pending_count: number }>(sql`
      SELECT COUNT(*)::int AS pending_count
      FROM extracted_values v
      LEFT JOIN reviews r ON r.id = v.current_review_id
      WHERE v.version_id = ${versionId}
        AND (v.current_review_id IS NULL OR r.decision = 'revert')
    `);
    pendingCount = countRes.rows[0]?.pending_count ?? 0;

    await tx
      .update(documents)
      .set({
        reviewableVersionId: versionId,
        pendingCount,
        ...touch(),
      })
      .where(eq(documents.id, docId));
  }

  return {
    ok: true,
    pointerMoved: shouldMovePointer,
    pendingCount,
    insertedCount: insertedRows.length,
  };
}

export async function listValuesForVersion(
  tx: DbTx,
  versionId: string,
): Promise<Array<{ value: ExtractedValueRow; currentReview: typeof reviews.$inferSelect | null }>> {
  const rows = await tx
    .select({
      value: extractedValues,
      currentReview: reviews,
    })
    .from(extractedValues)
    .leftJoin(reviews, eq(reviews.id, extractedValues.currentReviewId))
    .where(eq(extractedValues.versionId, versionId))
    .orderBy(asc(extractedValues.fieldKey));

  return rows;
}

export async function getValueById(tx: DbTx, valueId: string): Promise<ExtractedValueRow | null> {
  const rows = await tx
    .select()
    .from(extractedValues)
    .where(eq(extractedValues.id, valueId))
    .limit(1);
  return rows[0] ?? null;
}
