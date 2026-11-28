import type { Page } from '@app/contracts/page';
import type { VersionStatus } from '@app/contracts/status';
import { DOCUMENT_TYPE_KEY_REGEX_SOURCE } from '@app/contracts/values';
import { and, asc, desc, eq, gt, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { DbRepoError, type AppTransaction, type DbTx } from '../client.js';
import { documents, documentVersions } from '../schema/documents.js';
import { documentTypes, extractionTemplates, templateFields } from '../schema/templates.js';
import { fingerprintFilters, isValidUuid, keyset, toPage } from './keyset.js';

const DOCUMENT_TYPE_KEY_REGEX = new RegExp(DOCUMENT_TYPE_KEY_REGEX_SOURCE);

export type DocumentRow = typeof documents.$inferSelect;
export type DocumentVersionRow = typeof documentVersions.$inferSelect;
export type DocumentTypeRow = typeof documentTypes.$inferSelect;
export type ExtractionTemplateRow = typeof extractionTemplates.$inferSelect;
export type TemplateFieldRow = typeof templateFields.$inferSelect;

/**
 * Shared predicate enforcing soft-delete filtering on `documents` (AGENTS.md non-negotiable #4).
 */
export const alive = isNull(documents.deletedAt);

export async function getAliveDocument(tx: DbTx, documentId: string): Promise<DocumentRow | null> {
  const rows = await tx
    .select()
    .from(documents)
    .where(and(eq(documents.id, documentId), alive))
    .limit(1);
  return rows[0] ?? null;
}

export async function getAliveDocumentOrThrow(tx: DbTx, documentId: string): Promise<DocumentRow> {
  const rows = await tx.select().from(documents).where(eq(documents.id, documentId)).limit(1);
  const doc = rows[0];
  if (!doc) {
    throw new DbRepoError('DOCUMENT_NOT_FOUND', `Document ${documentId} not found`);
  }
  if (doc.deletedAt !== null) {
    throw new DbRepoError('DOCUMENT_DELETED', `Document ${documentId} has been deleted`);
  }
  return doc;
}

export async function getLatestTemplateForType(
  tx: DbTx,
  documentType: string,
): Promise<ExtractionTemplateRow | null> {
  const rows = await tx
    .select()
    .from(extractionTemplates)
    .where(eq(extractionTemplates.documentType, documentType))
    .orderBy(desc(extractionTemplates.version))
    .limit(1);
  return rows[0] ?? null;
}

export async function getTemplateWithFields(
  tx: DbTx,
  templateId: string,
): Promise<{ template: ExtractionTemplateRow; fields: TemplateFieldRow[] } | null> {
  const tplRows = await tx
    .select()
    .from(extractionTemplates)
    .where(eq(extractionTemplates.id, templateId))
    .limit(1);
  const template = tplRows[0];
  if (!template) {
    return null;
  }
  const fields = await tx
    .select()
    .from(templateFields)
    .where(eq(templateFields.templateId, templateId))
    .orderBy(asc(templateFields.position));
  return { template, fields };
}

export interface CreateDocumentInput {
  externalId?: string | null;
  type: string;
  title: string;
  storageKey: string;
  fileSha256: string;
  fileSizeBytes: number;
  originalFilename: string;
  requestId?: string | null;
}

export async function createDocumentWithInitialVersion(
  tx: AppTransaction,
  input: CreateDocumentInput,
): Promise<{ document: DocumentRow; version: DocumentVersionRow }> {
  const typeRows = await tx
    .select({ key: documentTypes.key })
    .from(documentTypes)
    .where(eq(documentTypes.key, input.type))
    .limit(1);
  if (!typeRows[0]) {
    throw new DbRepoError('UNKNOWN_DOCUMENT_TYPE', `Unknown document type: ${input.type}`);
  }

  const template = await getLatestTemplateForType(tx, input.type);
  if (!template) {
    throw new DbRepoError(
      'NO_TEMPLATE_FOR_TYPE',
      `No extraction template configured for document type: ${input.type}`,
    );
  }

  const [doc] = await tx
    .insert(documents)
    .values({
      externalId: input.externalId ?? null,
      type: input.type,
      title: input.title,
      latestVersionNumber: 1,
      pendingCount: 0,
    })
    .returning();

  const [version] = await tx
    .insert(documentVersions)
    .values({
      documentId: doc!.id,
      versionNumber: 1,
      templateId: template.id,
      origin: 'upload',
      status: 'queued',
      storageKey: input.storageKey,
      fileSha256: input.fileSha256,
      fileSizeBytes: input.fileSizeBytes,
      originalFilename: input.originalFilename,
      createdRequestId: input.requestId ?? null,
    })
    .returning();

  return { document: doc!, version: version! };
}

export interface ListAliveDocumentsParams {
  type?: string;
  needsReview?: boolean;
  status?: VersionStatus;
  externalId?: string;
  limit?: number;
  cursor?: string;
}

export async function listAliveDocuments(
  tx: DbTx,
  params: ListAliveDocumentsParams = {},
): Promise<Page<DocumentRow>> {
  const fingerprint = fingerprintFilters({
    type: params.type,
    needsReview: params.needsReview,
    status: params.status,
    externalId: params.externalId,
  });

  const ks = keyset({
    key: documents.id,
    cursor: params.cursor,
    limit: params.limit,
    direction: 'desc',
    fingerprint,
    validateKey: isValidUuid,
  });

  const conditions: SQL[] = [alive];
  if (params.type !== undefined) {
    conditions.push(eq(documents.type, params.type));
  }
  if (params.needsReview === true) {
    conditions.push(gt(documents.pendingCount, 0));
  } else if (params.needsReview === false) {
    conditions.push(eq(documents.pendingCount, 0));
  }
  if (params.externalId !== undefined) {
    conditions.push(eq(documents.externalId, params.externalId));
  }
  if (params.status !== undefined) {
    conditions.push(
      sql`EXISTS (
        SELECT 1 FROM document_versions dv
        WHERE dv.document_id = ${documents.id}
          AND dv.version_number = ${documents.latestVersionNumber}
          AND dv.status = ${params.status}
      )`,
    );
  }
  if (ks.whereClause) {
    conditions.push(ks.whereClause);
  }

  const rows = await tx
    .select()
    .from(documents)
    .where(and(...conditions))
    .orderBy(desc(documents.id))
    .limit(ks.limitPlusOne);

  return toPage(rows, ks.limit, (row) => row.id, fingerprint);
}

/**
 * Capped count of alive documents with pending_count > 0 for GET /documents/facets (LIMIT 100).
 */
export async function countNeedsReviewFacets(
  tx: DbTx,
): Promise<{ count: number; capped: boolean }> {
  const result = await tx.execute<{ cnt: number }>(sql`
    SELECT COUNT(*)::int AS cnt
    FROM (
      SELECT 1
      FROM documents
      WHERE deleted_at IS NULL AND pending_count > 0
      LIMIT 100
    ) sub
  `);
  const count = result.rows[0]?.cnt ?? 0;
  return { count, capped: count >= 100 };
}

export interface DocumentTypeWithTemplate {
  key: string;
  displayName: string;
  template: {
    id: string;
    version: number;
    defaultCurrency: string;
    dateOrder: string;
    instructions: string | null;
    fields: TemplateFieldRow[];
  };
}

export async function listDocumentTypesWithTemplates(
  tx: DbTx,
  params: { limit?: number; cursor?: string } = {},
): Promise<Page<DocumentTypeWithTemplate>> {
  const ks = keyset({
    key: documentTypes.key,
    cursor: params.cursor,
    limit: params.limit,
    direction: 'asc',
    fingerprint: '',
    validateKey: (k) => DOCUMENT_TYPE_KEY_REGEX.test(k),
  });

  const hasTemplateCondition = sql`EXISTS (
    SELECT 1 FROM extraction_templates et
    WHERE et.document_type = ${documentTypes.key}
  )`;
  const whereExpr = ks.whereClause
    ? and(hasTemplateCondition, ks.whereClause)
    : hasTemplateCondition;

  const types = await tx
    .select()
    .from(documentTypes)
    .where(whereExpr)
    .orderBy(asc(documentTypes.key))
    .limit(ks.limitPlusOne);

  const page = toPage(types, ks.limit, (row) => row.key, '');
  if (page.data.length === 0) {
    return { data: [], page: page.page };
  }

  // Batch latest templates and their fields across all page types (no N+1).
  const typeKeys = page.data.map((dt) => dt.key);
  const allTemplates = await tx
    .select()
    .from(extractionTemplates)
    .where(inArray(extractionTemplates.documentType, typeKeys))
    .orderBy(desc(extractionTemplates.version));
  const latestByType = new Map<string, ExtractionTemplateRow>();
  for (const tpl of allTemplates) {
    if (!latestByType.has(tpl.documentType)) {
      latestByType.set(tpl.documentType, tpl);
    }
  }

  const latestIds = [...latestByType.values()].map((t) => t.id);
  const allFields =
    latestIds.length === 0
      ? []
      : await tx
          .select()
          .from(templateFields)
          .where(inArray(templateFields.templateId, latestIds))
          .orderBy(asc(templateFields.position));
  const fieldsByTemplateId = new Map<string, TemplateFieldRow[]>();
  for (const field of allFields) {
    const list = fieldsByTemplateId.get(field.templateId) ?? [];
    list.push(field);
    fieldsByTemplateId.set(field.templateId, list);
  }

  const enriched: DocumentTypeWithTemplate[] = [];
  for (const dt of page.data) {
    const latest = latestByType.get(dt.key);
    if (!latest) continue;
    enriched.push({
      key: dt.key,
      displayName: dt.displayName,
      template: {
        id: latest.id,
        version: latest.version,
        defaultCurrency: latest.defaultCurrency,
        dateOrder: latest.dateOrder,
        instructions: latest.instructions,
        fields: fieldsByTemplateId.get(latest.id) ?? [],
      },
    });
  }

  return { data: enriched, page: page.page };
}
