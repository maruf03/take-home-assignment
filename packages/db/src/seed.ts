import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { DateOrder, FieldType } from '@app/contracts/status';
import { desc, eq } from 'drizzle-orm';
import { withTx, type AppDatabase } from './client.js';
import { documents, documentVersions } from './schema/documents.js';
import { documentTypes, extractionTemplates, templateFields } from './schema/templates.js';

export interface SeedBlobStore {
  ensureBucket(): Promise<void>;
  putObject(key: string, body: Buffer): Promise<void>;
}

export interface TemplateFieldHint {
  label: string;
  description?: string | null;
}

export interface TemplateTypeHint {
  displayName: string;
  instructions?: string | null;
  defaultCurrency?: string;
  dateOrder?: DateOrder;
  fields: Record<string, TemplateFieldHint>;
}

export type TemplateHintsFile = Record<string, TemplateTypeHint>;

export interface SeedOptions {
  fixturesDir: string;
  hintsPath: string;
  hintsOverride?: TemplateHintsFile;
}

export interface SeedSummary {
  templatesCreated: number;
  documentsCreated: number;
  blobsUploaded: number;
}

interface ExpectedFieldSpec {
  field: string;
  type: FieldType;
}

interface FixtureVersionSpec {
  version: number;
  file: string;
  note?: string;
}

interface FixtureDocumentSpec {
  id: string;
  type: string;
  title: string;
  versions: FixtureVersionSpec[];
}

interface PreparedTemplateField {
  fieldKey: string;
  fieldType: FieldType;
  position: number;
  label: string;
  description: string | null;
}

interface PreparedFixtureDocument {
  externalId: string;
  type: string;
  title: string;
  storageKey: string;
  fileSha256: string;
  fileSizeBytes: number;
  originalFilename: string;
  buffer: Buffer;
}

function defaultLabelForKey(fieldKey: string): string {
  return fieldKey
    .split('_')
    .map((part) => (part.length > 0 ? `${part[0]!.toUpperCase()}${part.slice(1)}` : ''))
    .join(' ');
}

export function computeTemplateContentSha256(input: {
  documentType: string;
  instructions: string | null;
  defaultCurrency: string;
  dateOrder: DateOrder;
  fields: readonly PreparedTemplateField[];
}): string {
  const canonical = JSON.stringify({
    documentType: input.documentType,
    instructions: input.instructions,
    defaultCurrency: input.defaultCurrency,
    dateOrder: input.dateOrder,
    fields: input.fields.map((f) => ({
      fieldKey: f.fieldKey,
      fieldType: f.fieldType,
      position: f.position,
      label: f.label,
      description: f.description,
    })),
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * Idempotent database + S3 seed (spec §4.12):
 * - Upserts `document_types` and inserts a new `extraction_templates` version whenever `content_sha256` changes.
 * - Uploads v1 fixture PDFs to content-addressed `pdfs/sha256/<sha>.pdf` keys outside the DB transaction.
 * - Inserts missing fixture documents (v1 only) keyed by `external_id`, NEVER resurrecting soft-deleted docs.
 */
export async function seedDatabase(
  db: AppDatabase,
  blobStore: SeedBlobStore,
  options: SeedOptions,
): Promise<SeedSummary> {
  const [expectedFieldsRaw, fixtureDocsRaw, hintsRaw] = await Promise.all([
    readFile(path.join(options.fixturesDir, 'expected-fields.json'), 'utf8'),
    readFile(path.join(options.fixturesDir, 'documents.json'), 'utf8'),
    readFile(options.hintsPath, 'utf8'),
  ]);

  const expectedFields = JSON.parse(expectedFieldsRaw) as Record<string, ExpectedFieldSpec[]>;
  const fixtureDocs = JSON.parse(fixtureDocsRaw) as FixtureDocumentSpec[];
  const baseHints = JSON.parse(hintsRaw) as TemplateHintsFile;
  const mergedHints: TemplateHintsFile = {
    ...baseHints,
    ...(options.hintsOverride ?? {}),
  };

  // Prepare v1 PDF buffers and upload to S3 BEFORE opening any Postgres transaction.
  const preparedDocs: PreparedFixtureDocument[] = [];
  for (const doc of fixtureDocs) {
    const v1 = doc.versions.find((v) => v.version === 1);
    if (!v1) {
      throw new Error(`Fixture document "${doc.id}" is missing version 1`);
    }
    const pdfPath = path.join(options.fixturesDir, v1.file);
    const buffer = await readFile(pdfPath);
    const fileSha256 = createHash('sha256').update(buffer).digest('hex');
    const storageKey = `pdfs/sha256/${fileSha256}.pdf`;
    preparedDocs.push({
      externalId: doc.id,
      type: doc.type,
      title: doc.title,
      storageKey,
      fileSha256,
      fileSizeBytes: buffer.byteLength,
      originalFilename: path.basename(v1.file),
      buffer,
    });
  }

  await blobStore.ensureBucket();
  for (const item of preparedDocs) {
    await blobStore.putObject(item.storageKey, item.buffer);
  }

  let templatesCreated = 0;
  let documentsCreated = 0;

  await withTx(db, async (tx) => {
    const latestTemplateIdByType = new Map<string, string>();

    for (const [docTypeKey, fieldsSpec] of Object.entries(expectedFields)) {
      const typeHint = mergedHints[docTypeKey];
      const displayName = typeHint?.displayName ?? defaultLabelForKey(docTypeKey);
      const instructions = typeHint?.instructions ?? null;
      const defaultCurrency = typeHint?.defaultCurrency ?? 'USD';
      const dateOrder: DateOrder = typeHint?.dateOrder ?? 'MDY';

      await tx.insert(documentTypes).values({ key: docTypeKey, displayName }).onConflictDoUpdate({
        target: documentTypes.key,
        set: { displayName },
      });

      const preparedFields: PreparedTemplateField[] = fieldsSpec.map((f, index) => {
        const fieldHint = typeHint?.fields[f.field];
        return {
          fieldKey: f.field,
          fieldType: f.type,
          position: index + 1,
          label: fieldHint?.label ?? defaultLabelForKey(f.field),
          description: fieldHint?.description ?? null,
        };
      });

      const contentSha256 = computeTemplateContentSha256({
        documentType: docTypeKey,
        instructions,
        defaultCurrency,
        dateOrder,
        fields: preparedFields,
      });

      const existingLatestRows = await tx
        .select()
        .from(extractionTemplates)
        .where(eq(extractionTemplates.documentType, docTypeKey))
        .orderBy(desc(extractionTemplates.version))
        .limit(1);
      const existingLatest = existingLatestRows[0];

      if (existingLatest && existingLatest.contentSha256 === contentSha256) {
        latestTemplateIdByType.set(docTypeKey, existingLatest.id);
        continue;
      }

      // Guard against reverting hints back to an older already-stored content_sha256.
      const existingByShaRows = await tx
        .select()
        .from(extractionTemplates)
        .where(eq(extractionTemplates.contentSha256, contentSha256))
        .limit(1);
      const existingBySha = existingByShaRows.find((r) => r.documentType === docTypeKey);
      if (existingBySha) {
        latestTemplateIdByType.set(docTypeKey, existingLatest?.id ?? existingBySha.id);
        continue;
      }

      const nextVersion = (existingLatest?.version ?? 0) + 1;
      const [insertedTemplate] = await tx
        .insert(extractionTemplates)
        .values({
          documentType: docTypeKey,
          version: nextVersion,
          contentSha256,
          instructions,
          defaultCurrency,
          dateOrder,
        })
        .returning();

      if (preparedFields.length > 0) {
        await tx.insert(templateFields).values(
          preparedFields.map((f) => ({
            templateId: insertedTemplate!.id,
            fieldKey: f.fieldKey,
            fieldType: f.fieldType,
            position: f.position,
            label: f.label,
            description: f.description,
          })),
        );
      }

      latestTemplateIdByType.set(docTypeKey, insertedTemplate!.id);
      templatesCreated += 1;
    }

    for (const item of preparedDocs) {
      // Deliberately query WITHOUT the `alive` predicate so soft-deleted fixture docs are never resurrected.
      const existingDoc = await tx
        .select({ id: documents.id })
        .from(documents)
        .where(eq(documents.externalId, item.externalId))
        .limit(1);

      if (existingDoc[0]) {
        continue;
      }

      const templateId = latestTemplateIdByType.get(item.type);
      if (!templateId) {
        throw new Error(`No template available for fixture document type "${item.type}"`);
      }

      const [insertedDoc] = await tx
        .insert(documents)
        .values({
          externalId: item.externalId,
          type: item.type,
          title: item.title,
          latestVersionNumber: 1,
          pendingCount: 0,
        })
        .returning();

      await tx.insert(documentVersions).values({
        documentId: insertedDoc!.id,
        versionNumber: 1,
        templateId,
        origin: 'upload',
        status: 'queued',
        storageKey: item.storageKey,
        fileSha256: item.fileSha256,
        fileSizeBytes: item.fileSizeBytes,
        originalFilename: item.originalFilename,
      });

      documentsCreated += 1;
    }
  });

  return {
    templatesCreated,
    documentsCreated,
    blobsUploaded: preparedDocs.length,
  };
}
