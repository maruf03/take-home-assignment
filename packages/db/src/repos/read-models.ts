import type { Progress } from '@app/contracts/dto';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { DbRepoError, type DbTx } from '../client.js';
import { documentVersions } from '../schema/documents.js';
import { documentTypes, extractionTemplates, templateFields } from '../schema/templates.js';
import { extractedValues, reviews } from '../schema/values.js';
import {
  getAliveDocumentOrThrow,
  type DocumentRow,
  type DocumentVersionRow,
  type ExtractionTemplateRow,
} from './documents.js';
import { computeVersionsProgress, type ReviewRow } from './reviews.js';
import type { ExtractedValueRow } from './values.js';

export async function getDocumentTypeByKey(
  tx: DbTx,
  key: string,
): Promise<{ key: string; displayName: string } | null> {
  const rows = await tx
    .select({ key: documentTypes.key, displayName: documentTypes.displayName })
    .from(documentTypes)
    .where(eq(documentTypes.key, key))
    .limit(1);
  return rows[0] ?? null;
}

export async function getTypeLabels(
  tx: DbTx,
  keys: readonly string[],
): Promise<Map<string, string>> {
  const unique = [...new Set(keys)];
  if (unique.length === 0) {
    return new Map();
  }
  const rows = await tx
    .select({ key: documentTypes.key, displayName: documentTypes.displayName })
    .from(documentTypes)
    .where(inArray(documentTypes.key, unique));
  return new Map(rows.map((r) => [r.key, r.displayName]));
}

export interface VersionWithTemplateVersion {
  readonly version: DocumentVersionRow;
  readonly templateVersion: number;
  readonly sourceVersionNumber: number | null;
}

interface VersionJoinRow {
  readonly version: DocumentVersionRow;
  readonly templateVersion: number;
}

async function withSourceNumbers(
  tx: DbTx,
  rows: readonly VersionJoinRow[],
): Promise<VersionWithTemplateVersion[]> {
  const sourceIds = [
    ...new Set(
      rows.map((r) => r.version.sourceVersionId).filter((id): id is string => id !== null),
    ),
  ];
  const numbers = new Map<string, number>();
  if (sourceIds.length > 0) {
    const sources = await tx
      .select({ id: documentVersions.id, versionNumber: documentVersions.versionNumber })
      .from(documentVersions)
      .where(inArray(documentVersions.id, sourceIds));
    for (const s of sources) numbers.set(s.id, s.versionNumber);
  }
  return rows.map((r) => ({
    ...r,
    sourceVersionNumber:
      r.version.sourceVersionId !== null ? (numbers.get(r.version.sourceVersionId) ?? null) : null,
  }));
}

export async function getVersionsWithTemplateVersion(
  tx: DbTx,
  versionIds: readonly string[],
): Promise<Map<string, VersionWithTemplateVersion>> {
  const unique = [...new Set(versionIds)];
  if (unique.length === 0) {
    return new Map();
  }
  const rows = await tx
    .select({ version: documentVersions, templateVersion: extractionTemplates.version })
    .from(documentVersions)
    .innerJoin(extractionTemplates, eq(extractionTemplates.id, documentVersions.templateId))
    .where(inArray(documentVersions.id, unique));
  const enriched = await withSourceNumbers(tx, rows);
  return new Map(enriched.map((r) => [r.version.id, r]));
}

export async function getVersionWithTemplateVersionByNumber(
  tx: DbTx,
  documentId: string,
  versionNumber: number,
): Promise<VersionWithTemplateVersion> {
  const rows = await tx
    .select({ version: documentVersions, templateVersion: extractionTemplates.version })
    .from(documentVersions)
    .innerJoin(extractionTemplates, eq(extractionTemplates.id, documentVersions.templateId))
    .where(
      and(
        eq(documentVersions.documentId, documentId),
        eq(documentVersions.versionNumber, versionNumber),
      ),
    )
    .limit(1);
  if (!rows[0]) {
    throw new DbRepoError(
      'VERSION_NOT_FOUND',
      `Version ${versionNumber} not found for document ${documentId}`,
    );
  }
  return (await withSourceNumbers(tx, rows))[0]!;
}

export interface DocumentContext {
  readonly document: DocumentRow;
  readonly typeLabel: string;
  readonly latest: VersionWithTemplateVersion;
  readonly reviewable: VersionWithTemplateVersion | null;
  readonly progress: Progress;
}

const EMPTY_PROGRESS: Progress = {
  versionNumber: null,
  pending: 0,
  approved: 0,
  corrected: 0,
  carriedOver: 0,
  total: 0,
  gaps: 0,
};

/**
 * Loads the per-document read context (latest upload, reviewable version, type label, progress)
 * for a page of documents in a fixed number of batched queries plus one progress query per row.
 */
export async function loadDocumentContexts(
  tx: DbTx,
  docs: readonly DocumentRow[],
): Promise<DocumentContext[]> {
  if (docs.length === 0) {
    return [];
  }
  const labels = await getTypeLabels(
    tx,
    docs.map((d) => d.type),
  );

  const latestRows = await tx
    .select({ version: documentVersions, templateVersion: extractionTemplates.version })
    .from(documentVersions)
    .innerJoin(extractionTemplates, eq(extractionTemplates.id, documentVersions.templateId))
    .where(
      and(
        inArray(
          documentVersions.documentId,
          docs.map((d) => d.id),
        ),
        // Only each document's latest upload and reviewable version are needed.
        sql`(${documentVersions.versionNumber} = (SELECT d.latest_version_number FROM documents d WHERE d.id = ${documentVersions.documentId})
          OR ${documentVersions.id} = (SELECT d.reviewable_version_id FROM documents d WHERE d.id = ${documentVersions.documentId}))`,
      ),
    );
  const byDocAndNumber = new Map<string, VersionWithTemplateVersion>();
  const byId = new Map<string, VersionWithTemplateVersion>();
  for (const row of await withSourceNumbers(tx, latestRows)) {
    byDocAndNumber.set(`${row.version.documentId}:${row.version.versionNumber}`, row);
    byId.set(row.version.id, row);
  }

  const reviewablesToCount: Array<{ id: string; versionNumber: number }> = [];
  for (const document of docs) {
    if (document.reviewableVersionId !== null) {
      const rev = byId.get(document.reviewableVersionId);
      if (rev) {
        reviewablesToCount.push({ id: rev.version.id, versionNumber: rev.version.versionNumber });
      }
    }
  }
  const progressByVersionId = await computeVersionsProgress(tx, reviewablesToCount);

  const contexts: DocumentContext[] = [];
  for (const document of docs) {
    const latest = byDocAndNumber.get(`${document.id}:${document.latestVersionNumber}`);
    if (!latest) {
      throw new DbRepoError('INTERNAL', `Document ${document.id} has no latest version row`);
    }
    const reviewable =
      document.reviewableVersionId !== null
        ? (byId.get(document.reviewableVersionId) ?? null)
        : null;
    const progress = reviewable
      ? (progressByVersionId.get(reviewable.version.id) ?? EMPTY_PROGRESS)
      : EMPTY_PROGRESS;
    contexts.push({
      document,
      typeLabel: labels.get(document.type) ?? document.type,
      latest,
      reviewable,
      progress,
    });
  }
  return contexts;
}

export async function loadDocumentContext(tx: DbTx, documentId: string): Promise<DocumentContext> {
  const document = await getAliveDocumentOrThrow(tx, documentId);
  const contexts = await loadDocumentContexts(tx, [document]);
  return contexts[0]!;
}

export interface BaselineReadRow {
  readonly value: ExtractedValueRow;
  readonly versionNumber: number;
  readonly parsedText: string | null;
  readonly review: ReviewRow | null;
  readonly reviewCarriedFromVersion: number | null;
}

export interface ValueReadRow {
  readonly value: ExtractedValueRow;
  readonly review: ReviewRow | null;
  readonly reviewCarriedFromVersion: number | null;
  readonly label: string;
  readonly position: number;
  readonly baseline: BaselineReadRow | null;
}

export async function getCarriedFromVersionNumbers(
  tx: DbTx,
  reviewRows: readonly ReviewRow[],
): Promise<Map<string, number>> {
  const sourceIds = [
    ...new Set(
      reviewRows.map((r) => r.carriedFromReviewId).filter((id): id is string => id !== null),
    ),
  ];
  if (sourceIds.length === 0) {
    return new Map();
  }
  const rows = await tx
    .select({ reviewId: reviews.id, versionNumber: documentVersions.versionNumber })
    .from(reviews)
    .innerJoin(extractedValues, eq(extractedValues.id, reviews.valueId))
    .innerJoin(documentVersions, eq(documentVersions.id, extractedValues.versionId))
    .where(inArray(reviews.id, sourceIds));
  return new Map(rows.map((r) => [r.reviewId, r.versionNumber]));
}

/**
 * Reads values of one version joined with their current review, template label/position, the
 * baseline ("previous") value and review, and the carried-from version numbers.
 */
export async function loadValueReadRows(
  tx: DbTx,
  version: DocumentVersionRow,
  valueIds?: readonly string[],
): Promise<ValueReadRow[]> {
  const conditions = [eq(extractedValues.versionId, version.id)];
  if (valueIds !== undefined) {
    if (valueIds.length === 0) {
      return [];
    }
    conditions.push(inArray(extractedValues.id, [...valueIds]));
  }
  const rows = await tx
    .select({ value: extractedValues, review: reviews })
    .from(extractedValues)
    .leftJoin(reviews, eq(reviews.id, extractedValues.currentReviewId))
    .where(and(...conditions))
    .orderBy(asc(extractedValues.fieldKey));

  const fields = await tx
    .select()
    .from(templateFields)
    .where(eq(templateFields.templateId, version.templateId));
  const fieldMeta = new Map(fields.map((f) => [f.fieldKey, f]));

  const baselineIds = [
    ...new Set(rows.map((r) => r.value.baselineValueId).filter((id): id is string => id !== null)),
  ];
  const baselineRows =
    baselineIds.length === 0
      ? []
      : await tx
          .select({
            value: extractedValues,
            versionNumber: documentVersions.versionNumber,
            parsedText: documentVersions.parsedText,
            review: reviews,
          })
          .from(extractedValues)
          .innerJoin(documentVersions, eq(documentVersions.id, extractedValues.versionId))
          .leftJoin(reviews, eq(reviews.id, extractedValues.currentReviewId))
          .where(inArray(extractedValues.id, baselineIds));
  const baselineById = new Map(baselineRows.map((b) => [b.value.id, b]));

  const allReviews: ReviewRow[] = [];
  for (const r of rows) if (r.review) allReviews.push(r.review);
  for (const b of baselineRows) if (b.review) allReviews.push(b.review);
  const carried = await getCarriedFromVersionNumbers(tx, allReviews);

  return rows.map(({ value, review }) => {
    const meta = fieldMeta.get(value.fieldKey);
    const baselineRow = value.baselineValueId ? baselineById.get(value.baselineValueId) : undefined;
    return {
      value,
      review,
      reviewCarriedFromVersion:
        review?.carriedFromReviewId != null
          ? (carried.get(review.carriedFromReviewId) ?? null)
          : null,
      label: meta?.label ?? value.fieldKey,
      position: meta?.position ?? 1,
      baseline: baselineRow
        ? {
            value: baselineRow.value,
            versionNumber: baselineRow.versionNumber,
            parsedText: baselineRow.parsedText,
            review: baselineRow.review,
            reviewCarriedFromVersion:
              baselineRow.review?.carriedFromReviewId != null
                ? (carried.get(baselineRow.review.carriedFromReviewId) ?? null)
                : null,
          }
        : null,
    };
  });
}

export interface ValueContext {
  readonly value: ExtractedValueRow;
  readonly version: DocumentVersionRow;
  readonly document: DocumentRow;
  readonly template: ExtractionTemplateRow;
}

/** Resolves value -> version -> alive document + pinned template (404/410 via DbRepoError). */
export async function getValueContext(tx: DbTx, valueId: string): Promise<ValueContext> {
  const rows = await tx
    .select({ value: extractedValues, version: documentVersions, template: extractionTemplates })
    .from(extractedValues)
    .innerJoin(documentVersions, eq(documentVersions.id, extractedValues.versionId))
    .innerJoin(extractionTemplates, eq(extractionTemplates.id, documentVersions.templateId))
    .where(eq(extractedValues.id, valueId))
    .limit(1);
  const row = rows[0];
  if (!row) {
    throw new DbRepoError('VALUE_NOT_FOUND', `Extracted value ${valueId} not found`);
  }
  const document = await getAliveDocumentOrThrow(tx, row.version.documentId);
  return { ...row, document };
}
