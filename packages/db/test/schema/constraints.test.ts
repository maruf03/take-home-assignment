import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTemplateDb, type TemplateDbHandle } from '../../src/testing/template-db.js';

const HEX64 = 'b'.repeat(64);
const UUIDV7_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('schema CHECK and UNIQUE constraints (§4)', () => {
  let ctx: TemplateDbHandle;
  let versionId: string;
  let runId: string;

  beforeAll(async () => {
    ctx = await withTemplateDb({ applyGrants: true });
  });

  afterAll(async () => {
    await ctx?.close();
  });

  beforeEach(async () => {
    await ctx.reset();
    await ctx.migratorPool.query(
      `INSERT INTO document_types (key, display_name) VALUES ('invoice', 'Invoice')`,
    );
    const tplRes = await ctx.migratorPool.query<{ id: string }>(
      `INSERT INTO extraction_templates (document_type, version, content_sha256)
       VALUES ('invoice', 1, $1) RETURNING id`,
      [HEX64],
    );
    const docRes = await ctx.migratorPool.query<{ id: string }>(
      `INSERT INTO documents (type, title) VALUES ('invoice', 'Invoice 1') RETURNING id`,
    );
    const verRes = await ctx.migratorPool.query<{ id: string }>(
      `INSERT INTO document_versions (document_id, version_number, template_id, storage_key, file_sha256, file_size_bytes, original_filename)
       VALUES ($1, 1, $2, 'k1', $3, 128, 'inv.pdf') RETURNING id`,
      [docRes.rows[0]!.id, tplRes.rows[0]!.id, HEX64],
    );
    versionId = verRes.rows[0]!.id;

    const runRes = await ctx.migratorPool.query<{ id: string }>(
      `INSERT INTO extraction_runs (version_id, run_number, status, trigger, worker_id)
       VALUES ($1, 1, 'running', 'upload', 'worker-1') RETURNING id`,
      [versionId],
    );
    runId = runRes.rows[0]!.id;
  });

  it('generates PG 18 uuidv7() primary keys by default', () => {
    expect(versionId).toMatch(UUIDV7_REGEX);
    expect(runId).toMatch(UUIDV7_REGEX);
  });

  it('[R6] rejects non-canonical decimals, JSON-number amounts, gaps carrying values, and attempted_quote on value rows', async () => {
    // 1. Non-canonical decimal in money amount ("5230.10")
    await expect(
      ctx.migratorPool.query(
        `INSERT INTO extracted_values (version_id, run_id, field_key, field_type, kind, value, evidence, canonical_evidence, change_kind)
         VALUES ($1, $2, 'total_amount', 'money', 'value', '{"amount":"5230.10","currency":"USD"}'::jsonb, 'Total $5,230.10', 'Total $5,230.10', 'new')`,
        [versionId, runId],
      ),
    ).rejects.toMatchObject({ code: '23514' });

    // 2. Non-canonical decimal in number ("4.20")
    await expect(
      ctx.migratorPool.query(
        `INSERT INTO extracted_values (version_id, run_id, field_key, field_type, kind, value, evidence, canonical_evidence, change_kind)
         VALUES ($1, $2, 'rate', 'percent', 'value', '"4.20"'::jsonb, 'Rate 4.20%', 'Rate 4.20%', 'new')`,
        [versionId, runId],
      ),
    ).rejects.toMatchObject({ code: '23514' });

    // 3. JSON-number money amount ({"amount": 5230.29, "currency": "USD"})
    await expect(
      ctx.migratorPool.query(
        `INSERT INTO extracted_values (version_id, run_id, field_key, field_type, kind, value, evidence, canonical_evidence, change_kind)
         VALUES ($1, $2, 'total_amount', 'money', 'value', '{"amount":5230.29,"currency":"USD"}'::jsonb, 'Total $5,230.29', 'Total $5,230.29', 'new')`,
        [versionId, runId],
      ),
    ).rejects.toMatchObject({ code: '23514' });

    // 4. Bare JSON number on number field (24 instead of "24")
    await expect(
      ctx.migratorPool.query(
        `INSERT INTO extracted_values (version_id, run_id, field_key, field_type, kind, value, evidence, canonical_evidence, change_kind)
         VALUES ($1, $2, 'term_months', 'number', 'value', '24'::jsonb, 'Term: 24 months', 'Term: 24 months', 'new')`,
        [versionId, runId],
      ),
    ).rejects.toMatchObject({ code: '23514' });

    // 5. Extra key on money object
    await expect(
      ctx.migratorPool.query(
        `INSERT INTO extracted_values (version_id, run_id, field_key, field_type, kind, value, evidence, canonical_evidence, change_kind)
         VALUES ($1, $2, 'total_amount', 'money', 'value', '{"amount":"5230.29","currency":"USD","extra":true}'::jsonb, 'Total $5,230.29', 'Total $5,230.29', 'new')`,
        [versionId, runId],
      ),
    ).rejects.toMatchObject({ code: '23514' });

    // 6. Gap carrying a value
    await expect(
      ctx.migratorPool.query(
        `INSERT INTO extracted_values (version_id, run_id, field_key, field_type, kind, value, gap_code, gap_reason, change_kind)
         VALUES ($1, $2, 'income', 'money', 'gap', '{"amount":"100","currency":"USD"}'::jsonb, 'NOT_FOUND', 'Not stated', 'new')`,
        [versionId, runId],
      ),
    ).rejects.toMatchObject({ code: '23514' });

    // 7. attempted_quote on a value row
    await expect(
      ctx.migratorPool.query(
        `INSERT INTO extracted_values (version_id, run_id, field_key, field_type, kind, value, evidence, canonical_evidence, attempted_quote, change_kind)
         VALUES ($1, $2, 'vendor_name', 'string', 'value', '"Meridian"'::jsonb, 'Meridian', 'Meridian', 'bad quote', 'new')`,
        [versionId, runId],
      ),
    ).rejects.toMatchObject({ code: '23514' });

    // 8. Valid canonical money row and valid gap row with attempted_quote both succeed
    await expect(
      ctx.migratorPool.query(
        `INSERT INTO extracted_values (version_id, run_id, field_key, field_type, kind, value, evidence, canonical_evidence, change_kind)
         VALUES ($1, $2, 'total_amount', 'money', 'value', '{"amount":"5230.1","currency":"USD"}'::jsonb, 'Total $5,230.10', 'Total $5,230.10', 'new')`,
        [versionId, runId],
      ),
    ).resolves.toBeDefined();

    await expect(
      ctx.migratorPool.query(
        `INSERT INTO extracted_values (version_id, run_id, field_key, field_type, kind, attempted_quote, gap_code, gap_reason, change_kind)
         VALUES ($1, $2, 'median_income', 'money', 'gap', 'Median income $80k', 'EVIDENCE_NOT_IN_TEXT', 'Quote not in text', 'new')`,
        [versionId, runId],
      ),
    ).resolves.toBeDefined();
  });

  it('[R4] db.unique-version-field rejects duplicate (version_id, field_key)', async () => {
    await ctx.migratorPool.query(
      `INSERT INTO extracted_values (version_id, run_id, field_key, field_type, kind, value, evidence, canonical_evidence, change_kind)
       VALUES ($1, $2, 'invoice_number', 'string', 'value', '"INV-1"'::jsonb, 'INV-1', 'INV-1', 'new')`,
      [versionId, runId],
    );

    await expect(
      ctx.migratorPool.query(
        `INSERT INTO extracted_values (version_id, run_id, field_key, field_type, kind, value, evidence, canonical_evidence, change_kind)
         VALUES ($1, $2, 'invoice_number', 'string', 'value', '"INV-2"'::jsonb, 'INV-2', 'INV-2', 'new')`,
        [versionId, runId],
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('enforces single running extraction_run per version and reviews value shape / no carried revert', async () => {
    // Second running run for the same version fails partial unique index
    await expect(
      ctx.migratorPool.query(
        `INSERT INTO extraction_runs (version_id, run_number, status, trigger, worker_id)
         VALUES ($1, 2, 'running', 'sweep', 'worker-2')`,
        [versionId],
      ),
    ).rejects.toMatchObject({ code: '23505' });

    const valRes = await ctx.migratorPool.query<{ id: string }>(
      `INSERT INTO extracted_values (version_id, run_id, field_key, field_type, kind, value, evidence, canonical_evidence, change_kind)
       VALUES ($1, $2, 'total_amount', 'money', 'value', '{"amount":"5230.1","currency":"USD"}'::jsonb, 'Total $5,230.10', 'Total $5,230.10', 'new') RETURNING id`,
      [versionId, runId],
    );
    const valId = valRes.rows[0]!.id;

    // Non-canonical corrected_value in reviews is rejected
    await expect(
      ctx.migratorPool.query(
        `INSERT INTO reviews (value_id, field_type, decision, corrected_value, origin)
         VALUES ($1, 'money', 'correct', '{"amount":"5230.10","currency":"USD"}'::jsonb, 'human')`,
        [valId],
      ),
    ).rejects.toMatchObject({ code: '23514' });

    // Carried revert is rejected
    const baseRev = await ctx.migratorPool.query<{ id: string }>(
      `INSERT INTO reviews (value_id, field_type, decision, origin)
       VALUES ($1, 'money', 'approve', 'human') RETURNING id`,
      [valId],
    );
    await expect(
      ctx.migratorPool.query(
        `INSERT INTO reviews (value_id, field_type, decision, origin, carried_from_review_id)
         VALUES ($1, 'money', 'revert', 'carried', $2)`,
        [valId, baseRev.rows[0]!.id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
