import type { Progress } from '@app/contracts/dto';
import type { Page } from '@app/contracts/page';
import type { FieldType, ReviewDecision, ReviewOrigin } from '@app/contracts/status';
import { equalValues, type TypedValue } from '@app/contracts/values';
import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
import { DbRepoError, type AppTransaction, type DbTx } from '../client.js';
import { documents, documentVersions } from '../schema/documents.js';
import { extractedValues, reviews } from '../schema/values.js';
import { fingerprintFilters, isValidUuid, keyset, toPage } from './keyset.js';
import { touch } from './touch.js';
import type { ExtractedValueRow } from './values.js';

export type ReviewRow = typeof reviews.$inferSelect;

export interface InsertReviewInput {
  decision: ReviewDecision;
  correctedValue?: TypedValue | null;
  note?: string | null;
  expectedCurrentReviewId?: string | null;
}

export interface InsertReviewResult {
  review: ReviewRow;
  value: ExtractedValueRow;
  progress: Progress;
  delta: -1 | 0 | 1;
  noop: boolean;
}

export async function computeVersionProgress(
  tx: DbTx,
  versionId: string,
  versionNumber: number | null,
): Promise<Progress> {
  const res = await tx.execute<{
    total: number;
    gaps: number;
    pending: number;
    approved: number;
    corrected: number;
    carried_over: number;
  }>(sql`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE v.kind = 'gap')::int AS gaps,
      COUNT(*) FILTER (WHERE v.current_review_id IS NULL OR r.decision = 'revert')::int AS pending,
      COUNT(*) FILTER (WHERE v.current_review_id IS NOT NULL AND r.origin = 'human' AND r.decision = 'approve')::int AS approved,
      COUNT(*) FILTER (WHERE v.current_review_id IS NOT NULL AND r.origin = 'human' AND r.decision = 'correct')::int AS corrected,
      COUNT(*) FILTER (WHERE v.current_review_id IS NOT NULL AND r.origin = 'carried' AND r.decision <> 'revert')::int AS carried_over
    FROM extracted_values v
    LEFT JOIN reviews r ON r.id = v.current_review_id
    WHERE v.version_id = ${versionId}
  `);

  const row = res.rows[0];
  return {
    versionNumber,
    total: row?.total ?? 0,
    gaps: row?.gaps ?? 0,
    pending: row?.pending ?? 0,
    approved: row?.approved ?? 0,
    corrected: row?.corrected ?? 0,
    carriedOver: row?.carried_over ?? 0,
  };
}

/**
 * Follows spec §3 Review lock order strictly:
 * 1. Read immutable (version_id, document_id, version_number) without locking
 * 2. Lock documents FOR NO KEY UPDATE (404 if missing, 410 if deleted)
 * 3. Lock extracted_values FOR UPDATE, read current review (immutable row)
 * 4. Check reviewable_version_id (409 VERSION_NOT_REVIEWABLE) and expectedCurrentReviewId (409 REVIEW_CONFLICT)
 * 5. Detect identical review -> no-op (delta 0, no new row)
 * 6. Insert append-only review, update extracted_values.current_review_id
 * 7. Update documents.pending_count += delta ONLY if delta !== 0.
 */
export async function insertReview(
  tx: AppTransaction,
  valueId: string,
  input: InsertReviewInput,
  requestId?: string | null,
): Promise<InsertReviewResult> {
  // 1. Read immutable value -> version -> document mapping.
  const metaRows = await tx
    .select({
      versionId: extractedValues.versionId,
      documentId: documentVersions.documentId,
      versionNumber: documentVersions.versionNumber,
    })
    .from(extractedValues)
    .innerJoin(documentVersions, eq(documentVersions.id, extractedValues.versionId))
    .where(eq(extractedValues.id, valueId))
    .limit(1);

  const meta = metaRows[0];
  if (!meta) {
    throw new DbRepoError('VALUE_NOT_FOUND', `Extracted value ${valueId} not found`);
  }

  // 2. Lock documents FOR NO KEY UPDATE.
  const lockedDocs = await tx
    .select()
    .from(documents)
    .where(eq(documents.id, meta.documentId))
    .for('no key update');
  const doc = lockedDocs[0];
  if (!doc) {
    throw new DbRepoError('DOCUMENT_NOT_FOUND', `Document ${meta.documentId} not found`);
  }
  if (doc.deletedAt !== null) {
    throw new DbRepoError('DOCUMENT_DELETED', `Document ${meta.documentId} has been deleted`);
  }

  // 3. Lock extracted_values FOR UPDATE (never locking out of order).
  const lockedValues = await tx
    .select()
    .from(extractedValues)
    .where(eq(extractedValues.id, valueId))
    .for('update');
  const val = lockedValues[0];
  if (!val) {
    throw new DbRepoError('VALUE_NOT_FOUND', `Extracted value ${valueId} not found`);
  }

  // 4. Verify reviewability against current reviewable pointer.
  if (val.versionId !== doc.reviewableVersionId) {
    throw new DbRepoError(
      'VERSION_NOT_REVIEWABLE',
      `Version ${meta.versionNumber} is not the current reviewable version for document ${meta.documentId}`,
    );
  }

  // 5. Optimistic concurrency check if caller passed expectedCurrentReviewId.
  if (
    input.expectedCurrentReviewId !== undefined &&
    (val.currentReviewId ?? null) !== input.expectedCurrentReviewId
  ) {
    throw new DbRepoError('REVIEW_CONFLICT', 'Extracted value has a newer review', {
      currentReviewId: val.currentReviewId ?? null,
    });
  }

  // Load current review row (reviews are append-only/immutable).
  let currentReview: ReviewRow | null = null;
  if (val.currentReviewId !== null) {
    const revRows = await tx
      .select()
      .from(reviews)
      .where(eq(reviews.id, val.currentReviewId))
      .limit(1);
    currentReview = revRows[0] ?? null;
  }

  const wasPending = currentReview === null || currentReview.decision === 'revert';
  const willBePending = input.decision === 'revert';

  if (willBePending && wasPending) {
    throw new DbRepoError('NOTHING_TO_REVERT', 'Value has no active review decision to revert');
  }

  if (
    input.decision === 'correct' &&
    (input.correctedValue === undefined || input.correctedValue === null)
  ) {
    throw new DbRepoError(
      'INVALID_CORRECTION',
      'correctedValue is required when decision is correct',
    );
  }

  const normalizedNote = input.note ?? null;
  const correctedValue = input.decision === 'correct' ? (input.correctedValue ?? null) : null;

  // 6. Identical human review is a no-op (spec §5.5).
  // For strings, use exact equality so capitalization/spacing fixes are never discarded.
  if (
    currentReview !== null &&
    currentReview.origin === 'human' &&
    currentReview.decision === input.decision &&
    (currentReview.note ?? null) === normalizedNote
  ) {
    const existingCorrected = (currentReview.correctedValue as TypedValue | null) ?? null;
    const fieldType = val.fieldType as FieldType;
    const valueMatches =
      input.decision !== 'correct' ||
      (fieldType === 'string'
        ? existingCorrected === correctedValue
        : equalValues(fieldType, existingCorrected, correctedValue));
    if (valueMatches) {
      const progress = await computeVersionProgress(tx, val.versionId, meta.versionNumber);
      return {
        review: currentReview,
        value: val,
        progress,
        delta: 0,
        noop: true,
      };
    }
  }

  // 7. Compute delta and persist append-only review + pointer update.
  const delta = ((willBePending ? 1 : 0) - (wasPending ? 1 : 0)) as -1 | 0 | 1;

  const [insertedReview] = await tx
    .insert(reviews)
    .values({
      valueId: val.id,
      fieldType: val.fieldType,
      decision: input.decision,
      correctedValue,
      note: normalizedNote,
      origin: 'human',
      carriedFromReviewId: null,
      requestId: requestId ?? null,
    })
    .returning();

  const [updatedValue] = await tx
    .update(extractedValues)
    .set({ currentReviewId: insertedReview!.id })
    .where(eq(extractedValues.id, val.id))
    .returning();

  // 8. Maintain documents.pending_count incrementally ONLY when delta !== 0.
  if (delta !== 0) {
    await tx
      .update(documents)
      .set({
        pendingCount: sql`${documents.pendingCount} + ${delta}`,
        ...touch(),
      })
      .where(eq(documents.id, doc.id));
  }

  const progress = await computeVersionProgress(tx, val.versionId, meta.versionNumber);

  return {
    review: insertedReview!,
    value: updatedValue!,
    progress,
    delta,
    noop: false,
  };
}

export interface ListReviewsParams {
  origin?: ReviewOrigin;
  limit?: number;
  cursor?: string;
}

export async function listReviewsForValue(
  tx: DbTx,
  valueId: string,
  params: ListReviewsParams = {},
): Promise<Page<ReviewRow>> {
  const fingerprint = fingerprintFilters({ origin: params.origin });

  const ks = keyset({
    key: reviews.id,
    cursor: params.cursor,
    limit: params.limit,
    direction: 'desc',
    fingerprint,
    validateKey: isValidUuid,
  });

  const conditions: SQL[] = [eq(reviews.valueId, valueId)];
  if (params.origin !== undefined) {
    conditions.push(eq(reviews.origin, params.origin));
  }
  if (ks.whereClause) {
    conditions.push(ks.whereClause);
  }

  const rows = await tx
    .select()
    .from(reviews)
    .where(and(...conditions))
    .orderBy(desc(reviews.id))
    .limit(ks.limitPlusOne);

  return toPage(rows, ks.limit, (row) => row.id, fingerprint);
}
