import type { TextRanges } from '@app/contracts/dto';
import type { Page } from '@app/contracts/page';
import type { VersionOrigin, VersionStatus, VersionWarning } from '@app/contracts/status';
import { and, desc, eq, isNull, lt, sql, type SQL } from 'drizzle-orm';
import { DbRepoError, type AppTransaction, type DbTx } from '../client.js';
import { documents, documentVersions } from '../schema/documents.js';
import {
  getLatestTemplateForType,
  type DocumentRow,
  type DocumentVersionRow,
} from './documents.js';
import { fingerprintFilters, isValidPositiveIntKey, keyset, toPage } from './keyset.js';
import { touch } from './touch.js';

export interface CreateNewVersionInput {
  storageKey: string;
  fileSha256: string;
  fileSizeBytes: number;
  originalFilename: string;
  requestId?: string | null;
}

export interface CreateNewVersionResult {
  document: DocumentRow;
  version: DocumentVersionRow;
  deduplicated: boolean;
}

/**
 * Follows spec §3 New version literally:
 * lock documents FOR UPDATE -> content dedupe (non-failed, current template, upload) -> increment -> insert.
 */
export async function createNewVersion(
  tx: AppTransaction,
  documentId: string,
  input: CreateNewVersionInput,
): Promise<CreateNewVersionResult> {
  const lockedDocs = await tx
    .select()
    .from(documents)
    .where(eq(documents.id, documentId))
    .for('update');
  const doc = lockedDocs[0];
  if (!doc) {
    throw new DbRepoError('DOCUMENT_NOT_FOUND', `Document ${documentId} not found`);
  }
  if (doc.deletedAt !== null) {
    throw new DbRepoError('DOCUMENT_DELETED', `Document ${documentId} has been deleted`);
  }

  const currentTemplate = await getLatestTemplateForType(tx, doc.type);
  if (!currentTemplate) {
    throw new DbRepoError(
      'NO_TEMPLATE_FOR_TYPE',
      `No extraction template configured for document type: ${doc.type}`,
    );
  }

  if (doc.latestVersionNumber > 0) {
    const latestRows = await tx
      .select()
      .from(documentVersions)
      .where(
        and(
          eq(documentVersions.documentId, documentId),
          eq(documentVersions.versionNumber, doc.latestVersionNumber),
        ),
      )
      .limit(1);
    const latest = latestRows[0];
    if (
      latest &&
      latest.origin === 'upload' &&
      latest.fileSha256 === input.fileSha256 &&
      latest.status !== 'failed' &&
      latest.templateId === currentTemplate.id
    ) {
      return { document: doc, version: latest, deduplicated: true };
    }
  }

  const [updatedDoc] = await tx
    .update(documents)
    .set({
      latestVersionNumber: sql`${documents.latestVersionNumber} + 1`,
      ...touch(),
    })
    .where(eq(documents.id, documentId))
    .returning();

  const [version] = await tx
    .insert(documentVersions)
    .values({
      documentId,
      versionNumber: updatedDoc!.latestVersionNumber,
      templateId: currentTemplate.id,
      origin: 'upload',
      status: 'queued',
      storageKey: input.storageKey,
      fileSha256: input.fileSha256,
      fileSizeBytes: input.fileSizeBytes,
      originalFilename: input.originalFilename,
      createdRequestId: input.requestId ?? null,
    })
    .returning();

  return { document: updatedDoc!, version: version!, deduplicated: false };
}

export async function createReextractVersion(
  tx: AppTransaction,
  documentId: string,
  sourceVersionNumber: number,
  options: { reparse: boolean; requestId?: string | null },
): Promise<{ document: DocumentRow; version: DocumentVersionRow }> {
  const lockedDocs = await tx
    .select()
    .from(documents)
    .where(eq(documents.id, documentId))
    .for('update');
  const doc = lockedDocs[0];
  if (!doc) {
    throw new DbRepoError('DOCUMENT_NOT_FOUND', `Document ${documentId} not found`);
  }
  if (doc.deletedAt !== null) {
    throw new DbRepoError('DOCUMENT_DELETED', `Document ${documentId} has been deleted`);
  }

  const sourceRows = await tx
    .select()
    .from(documentVersions)
    .where(
      and(
        eq(documentVersions.documentId, documentId),
        eq(documentVersions.versionNumber, sourceVersionNumber),
      ),
    )
    .limit(1);
  const source = sourceRows[0];
  if (!source) {
    throw new DbRepoError(
      'VERSION_NOT_FOUND',
      `Version ${sourceVersionNumber} not found for document ${documentId}`,
    );
  }
  if (source.status !== 'extracted' && source.status !== 'failed') {
    throw new DbRepoError(
      'VERSION_NOT_TERMINAL',
      `Version ${sourceVersionNumber} is ${source.status} and cannot be re-extracted yet`,
    );
  }

  const currentTemplate = await getLatestTemplateForType(tx, doc.type);
  if (!currentTemplate) {
    throw new DbRepoError(
      'NO_TEMPLATE_FOR_TYPE',
      `No extraction template configured for document type: ${doc.type}`,
    );
  }

  const [updatedDoc] = await tx
    .update(documents)
    .set({
      latestVersionNumber: sql`${documents.latestVersionNumber} + 1`,
      ...touch(),
    })
    .where(eq(documents.id, documentId))
    .returning();

  const copyParsed = !options.reparse && source.parsedText !== null;
  const [version] = await tx
    .insert(documentVersions)
    .values({
      documentId,
      versionNumber: updatedDoc!.latestVersionNumber,
      templateId: currentTemplate.id,
      origin: 'reextract',
      sourceVersionId: source.id,
      status: 'queued',
      storageKey: source.storageKey,
      fileSha256: source.fileSha256,
      fileSizeBytes: source.fileSizeBytes,
      originalFilename: source.originalFilename,
      parsedText: copyParsed ? source.parsedText : null,
      parsedTextSha256: copyParsed ? source.parsedTextSha256 : null,
      parser: copyParsed ? source.parser : null,
      pageOffsets: copyParsed ? source.pageOffsets : null,
      textRanges: copyParsed ? source.textRanges : null,
      warnings: copyParsed ? source.warnings : [],
      createdRequestId: options.requestId ?? null,
    })
    .returning();

  return { document: updatedDoc!, version: version! };
}

export interface SaveParsedTextInput {
  parsedText: string;
  parsedTextSha256: string;
  parser: string;
  pageOffsets: number[];
  textRanges: TextRanges;
  warnings: VersionWarning[];
}

/**
 * C1 fenced write-once checkpoint: applies ONLY when active_run_id = runId AND parsed_text IS NULL.
 */
export async function saveParsedText(
  tx: DbTx,
  versionId: string,
  runId: string,
  parsed: SaveParsedTextInput,
): Promise<boolean> {
  const updated = await tx
    .update(documentVersions)
    .set({
      parsedText: parsed.parsedText,
      parsedTextSha256: parsed.parsedTextSha256,
      parser: parsed.parser,
      pageOffsets: parsed.pageOffsets,
      textRanges: parsed.textRanges,
      warnings: parsed.warnings,
      ...touch(),
    })
    .where(
      and(
        eq(documentVersions.id, versionId),
        eq(documentVersions.activeRunId, runId),
        isNull(documentVersions.parsedText),
      ),
    )
    .returning({ id: documentVersions.id });

  return updated.length === 1;
}

/**
 * Follows spec §3 Retry: locks documents FOR KEY SHARE (preserving documents -> document_versions
 * lock order and serializing against soft-delete), then locks document_versions FOR UPDATE and
 * resets retry budget `attempts=0` while leaving monotonic `run_seq` untouched.
 */
export async function retryVersion(
  tx: AppTransaction,
  documentId: string,
  versionNumber: number,
): Promise<DocumentVersionRow> {
  const lockedDocs = await tx
    .select({ id: documents.id, deletedAt: documents.deletedAt })
    .from(documents)
    .where(eq(documents.id, documentId))
    .for('key share');
  const doc = lockedDocs[0];
  if (!doc) {
    throw new DbRepoError('DOCUMENT_NOT_FOUND', `Document ${documentId} not found`);
  }
  if (doc.deletedAt !== null) {
    throw new DbRepoError('DOCUMENT_DELETED', `Document ${documentId} has been deleted`);
  }

  const locked = await tx
    .select()
    .from(documentVersions)
    .where(
      and(
        eq(documentVersions.documentId, documentId),
        eq(documentVersions.versionNumber, versionNumber),
      ),
    )
    .for('update');
  const ver = locked[0];
  if (!ver) {
    throw new DbRepoError(
      'VERSION_NOT_FOUND',
      `Version ${versionNumber} not found for document ${documentId}`,
    );
  }
  if (ver.status !== 'failed') {
    throw new DbRepoError(
      'NOT_RETRYABLE',
      `Version ${versionNumber} has status ${ver.status}; only failed versions can be retried`,
    );
  }

  const [updated] = await tx
    .update(documentVersions)
    .set({
      status: 'queued',
      attempts: 0,
      lastErrorCode: null,
      lastErrorMessage: null,
      enqueuedAt: null,
      ...touch(),
    })
    .where(and(eq(documentVersions.id, ver.id), eq(documentVersions.status, 'failed')))
    .returning();

  return updated!;
}

export async function getVersionById(
  tx: DbTx,
  versionId: string,
): Promise<DocumentVersionRow | null> {
  const rows = await tx
    .select()
    .from(documentVersions)
    .where(eq(documentVersions.id, versionId))
    .limit(1);
  return rows[0] ?? null;
}

export async function getVersionByNumber(
  tx: DbTx,
  documentId: string,
  versionNumber: number,
): Promise<DocumentVersionRow | null> {
  const rows = await tx
    .select()
    .from(documentVersions)
    .where(
      and(
        eq(documentVersions.documentId, documentId),
        eq(documentVersions.versionNumber, versionNumber),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function getBaselineExtractedVersion(
  tx: DbTx,
  documentId: string,
  beforeVersionNumber: number,
): Promise<DocumentVersionRow | null> {
  const rows = await tx
    .select()
    .from(documentVersions)
    .where(
      and(
        eq(documentVersions.documentId, documentId),
        lt(documentVersions.versionNumber, beforeVersionNumber),
        eq(documentVersions.status, 'extracted'),
      ),
    )
    .orderBy(desc(documentVersions.versionNumber))
    .limit(1);
  return rows[0] ?? null;
}

export interface ListVersionsParams {
  status?: VersionStatus;
  origin?: VersionOrigin;
  limit?: number;
  cursor?: string;
}

export async function listVersions(
  tx: DbTx,
  documentId: string,
  params: ListVersionsParams = {},
): Promise<Page<DocumentVersionRow>> {
  const fingerprint = fingerprintFilters({
    status: params.status,
    origin: params.origin,
  });

  const ks = keyset({
    key: documentVersions.versionNumber,
    cursor: params.cursor,
    limit: params.limit,
    direction: 'desc',
    fingerprint,
    validateKey: isValidPositiveIntKey,
    parseKey: (k) => Number(k),
  });

  const conditions: SQL[] = [eq(documentVersions.documentId, documentId)];
  if (params.status !== undefined) {
    conditions.push(eq(documentVersions.status, params.status));
  }
  if (params.origin !== undefined) {
    conditions.push(eq(documentVersions.origin, params.origin));
  }
  if (ks.whereClause) {
    conditions.push(ks.whereClause);
  }

  const rows = await tx
    .select()
    .from(documentVersions)
    .where(and(...conditions))
    .orderBy(desc(documentVersions.versionNumber))
    .limit(ks.limitPlusOne);

  return toPage(rows, ks.limit, (row) => String(row.versionNumber), fingerprint);
}
