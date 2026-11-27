import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTx } from '../../src/client.js';
import { createDocumentWithInitialVersion } from '../../src/repos/documents.js';
import { seedDatabase, type SeedBlobStore, type TemplateHintsFile } from '../../src/seed.js';
import { withTemplateDb, type TemplateDbHandle } from '../../src/testing/template-db.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const FIXTURES_DIR = path.join(REPO_ROOT, 'fixtures');
const HINTS_PATH = path.join(REPO_ROOT, 'packages', 'db', 'assets', 'template-hints.json');

class MemoryBlobStore implements SeedBlobStore {
  readonly objects = new Map<string, Buffer>();
  bucketEnsured = false;

  async ensureBucket(): Promise<void> {
    this.bucketEnsured = true;
  }

  async putObject(key: string, body: Buffer): Promise<void> {
    this.objects.set(key, body);
  }
}

describe('[R11] & [I7] idempotent database seed and template versioning', () => {
  let ctx: TemplateDbHandle;

  beforeAll(async () => {
    ctx = await withTemplateDb({ applyGrants: true });
  });

  afterAll(async () => {
    await ctx?.close();
  });

  beforeEach(async () => {
    await ctx.reset();
  });

  it('[R11] seed.idempotent seeds 3 fixture documents (v1 only) idempotently and never resurrects deleted docs', async () => {
    const blobs = new MemoryBlobStore();

    const first = await seedDatabase(ctx.migratorDb, blobs, {
      fixturesDir: FIXTURES_DIR,
      hintsPath: HINTS_PATH,
    });
    expect(blobs.bucketEnsured).toBe(true);
    expect(blobs.objects.size).toBe(3);
    expect(first.documentsCreated).toBe(3);
    expect(first.templatesCreated).toBe(3);

    // Second run is a clean no-op
    const second = await seedDatabase(ctx.migratorDb, blobs, {
      fixturesDir: FIXTURES_DIR,
      hintsPath: HINTS_PATH,
    });
    expect(second.documentsCreated).toBe(0);
    expect(second.templatesCreated).toBe(0);

    const docs = await ctx.migratorPool.query<{
      external_id: string;
      latest_version_number: number;
    }>(`SELECT external_id, latest_version_number FROM documents ORDER BY external_id`);
    expect(docs.rows).toEqual([
      { external_id: 'doc-invoice-001', latest_version_number: 1 },
      { external_id: 'doc-lease-001', latest_version_number: 1 },
      { external_id: 'doc-report-001', latest_version_number: 1 },
    ]);

    // Soft-delete doc-invoice-001 and re-run seed: must NOT resurrect it
    await ctx.migratorPool.query(
      `UPDATE documents SET deleted_at = now(), deleted_reason = 'test' WHERE external_id = 'doc-invoice-001'`,
    );
    const third = await seedDatabase(ctx.migratorDb, blobs, {
      fixturesDir: FIXTURES_DIR,
      hintsPath: HINTS_PATH,
    });
    expect(third.documentsCreated).toBe(0);

    const deletedCheck = await ctx.migratorPool.query<{ deleted_at: Date | null }>(
      `SELECT deleted_at FROM documents WHERE external_id = 'doc-invoice-001'`,
    );
    expect(deletedCheck.rows[0]?.deleted_at).not.toBeNull();
  });

  it('[I7] seed.edited-template-v2-pin creates template v2 on edit and pins new uploads to v2 while keeping v1 pinned', async () => {
    const blobs = new MemoryBlobStore();

    await seedDatabase(ctx.migratorDb, blobs, {
      fixturesDir: FIXTURES_DIR,
      hintsPath: HINTS_PATH,
    });

    const v1Ver = await ctx.migratorPool.query<{ template_id: string }>(
      `SELECT dv.template_id
       FROM document_versions dv
       JOIN documents d ON d.id = dv.document_id
       WHERE d.external_id = 'doc-invoice-001' AND dv.version_number = 1`,
    );
    const v1TemplateId = v1Ver.rows[0]!.template_id;

    // Re-seed with an edited invoice hint override -> must create invoice template v2
    const editedHints: TemplateHintsFile = {
      invoice: {
        displayName: 'Invoice',
        instructions: 'Updated invoice extraction instructions v2.',
        defaultCurrency: 'USD',
        dateOrder: 'MDY',
        fields: {
          invoice_number: { label: 'Invoice number', description: 'Unique invoice identifier.' },
          issue_date: { label: 'Issue date', description: 'Invoice issue date.' },
          due_date: { label: 'Due date', description: 'Payment due date.' },
          vendor_name: { label: 'Vendor name', description: 'Supplier company name.' },
          total_amount: { label: 'Total amount', description: 'Final total amount due.' },
        },
      },
    };

    const res2 = await seedDatabase(ctx.migratorDb, blobs, {
      fixturesDir: FIXTURES_DIR,
      hintsPath: HINTS_PATH,
      hintsOverride: editedHints,
    });
    expect(res2.templatesCreated).toBe(1);

    const tpls = await ctx.migratorPool.query<{ id: string; version: number }>(
      `SELECT id, version FROM extraction_templates WHERE document_type = 'invoice' ORDER BY version`,
    );
    expect(tpls.rows.map((r) => r.version)).toEqual([1, 2]);
    const v2TemplateId = tpls.rows[1]!.id;

    // New document pins v2, while existing doc-invoice-001 v1 remains pinned to v1
    const created = await withTx(ctx.appDb, (tx) =>
      createDocumentWithInitialVersion(tx, {
        type: 'invoice',
        title: 'New Invoice',
        storageKey: `pdfs/sha256/${'f'.repeat(64)}.pdf`,
        fileSha256: 'f'.repeat(64),
        fileSizeBytes: 200,
        originalFilename: 'new.pdf',
      }),
    );
    expect(created.version.templateId).toBe(v2TemplateId);

    const v1Check = await ctx.migratorPool.query<{ template_id: string }>(
      `SELECT dv.template_id
       FROM document_versions dv
       JOIN documents d ON d.id = dv.document_id
       WHERE d.external_id = 'doc-invoice-001' AND dv.version_number = 1`,
    );
    expect(v1Check.rows[0]!.template_id).toBe(v1TemplateId);
  });
});
