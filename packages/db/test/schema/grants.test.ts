import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTemplateDb, type TemplateDbHandle } from '../../src/testing/template-db.js';

const EXPECTED_SNAPSHOT = JSON.parse(
  readFileSync(path.join(import.meta.dirname, 'grants.snapshot.json'), 'utf8'),
) as {
  tableGrants: { table: string; privileges: string[] }[];
  columnUpdateGrants: Record<string, string[]>;
};

const HEX64 = 'a'.repeat(64);

describe('[I10] database privilege grants', () => {
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

  it('[I10] db.grants.snapshot matches role_table_grants and column_privileges for app role (including provider_request_id)', async () => {
    const tableRows = await ctx.migratorPool.query<{
      table_name: string;
      privilege_type: string;
    }>(
      `SELECT table_name, privilege_type
       FROM information_schema.role_table_grants
       WHERE grantee = 'app' AND table_schema = 'public'
       ORDER BY table_name, privilege_type`,
    );

    const byTable = new Map<string, string[]>();
    for (const row of tableRows.rows) {
      const list = byTable.get(row.table_name) ?? [];
      list.push(row.privilege_type);
      byTable.set(row.table_name, list);
    }

    const actualTableGrants = [...byTable.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([table, privileges]) => ({ table, privileges: privileges.sort() }));

    expect(actualTableGrants).toEqual(EXPECTED_SNAPSHOT.tableGrants);

    const colRows = await ctx.migratorPool.query<{
      table_name: string;
      column_name: string;
    }>(
      `SELECT table_name, column_name
       FROM information_schema.column_privileges
       WHERE grantee = 'app'
         AND table_schema = 'public'
         AND privilege_type = 'UPDATE'
         AND table_name IN ('llm_calls', 'extracted_values', 'reviews', 'document_types', 'extraction_templates', 'template_fields')
       ORDER BY table_name, column_name`,
    );

    const actualColumnUpdates: Record<string, string[]> = {};
    for (const row of colRows.rows) {
      actualColumnUpdates[row.table_name] ??= [];
      actualColumnUpdates[row.table_name]!.push(row.column_name);
    }

    expect(actualColumnUpdates).toEqual(EXPECTED_SNAPSHOT.columnUpdateGrants);
    expect(actualColumnUpdates['llm_calls']).toContain('provider_request_id');
    expect(actualColumnUpdates['llm_calls']).toContain('served_model');

    // app must have zero privileges on the drizzle migrations schema.
    const drizzleAccess = await ctx.migratorPool.query<{ has_usage: boolean }>(
      `SELECT has_schema_privilege('app', 'drizzle', 'USAGE') AS has_usage`,
    );
    expect(drizzleAccess.rows[0]?.has_usage).toBe(false);
  });

  it('[I10] db.grants.app-cannot-update-reviews and db.grants.app-cannot-delete-documents', async () => {
    // Seed a valid document -> version -> run -> value -> review as migrator/app.
    await ctx.migratorPool.query(
      `INSERT INTO document_types (key, display_name) VALUES ('invoice', 'Invoice')`,
    );
    const tplRes = await ctx.migratorPool.query<{ id: string }>(
      `INSERT INTO extraction_templates (document_type, version, content_sha256)
       VALUES ('invoice', 1, $1) RETURNING id`,
      [HEX64],
    );
    const templateId = tplRes.rows[0]!.id;

    // Insert document via app role (allowed).
    const docRes = await ctx.appPool.query<{ id: string }>(
      `INSERT INTO documents (type, title) VALUES ('invoice', 'Test Invoice') RETURNING id`,
    );
    const docId = docRes.rows[0]!.id;

    const verRes = await ctx.appPool.query<{ id: string }>(
      `INSERT INTO document_versions (document_id, version_number, template_id, storage_key, file_sha256, file_size_bytes, original_filename)
       VALUES ($1, 1, $2, 'k', $3, 100, 'invoice.pdf') RETURNING id`,
      [docId, templateId, HEX64],
    );
    const verId = verRes.rows[0]!.id;

    const runRes = await ctx.appPool.query<{ id: string }>(
      `INSERT INTO extraction_runs (version_id, run_number, status, trigger, worker_id)
       VALUES ($1, 1, 'running', 'upload', 'worker-1') RETURNING id`,
      [verId],
    );
    const runId = runRes.rows[0]!.id;

    const valRes = await ctx.appPool.query<{ id: string }>(
      `INSERT INTO extracted_values (version_id, run_id, field_key, field_type, kind, value, evidence, canonical_evidence, change_kind)
       VALUES ($1, $2, 'vendor_name', 'string', 'value', '"Meridian LLC"'::jsonb, 'Meridian LLC', 'Meridian LLC', 'new') RETURNING id`,
      [verId, runId],
    );
    const valId = valRes.rows[0]!.id;

    const revRes = await ctx.appPool.query<{ id: string }>(
      `INSERT INTO reviews (value_id, field_type, decision, origin)
       VALUES ($1, 'string', 'approve', 'human') RETURNING id`,
      [valId],
    );
    const revId = revRes.rows[0]!.id;

    // Allowed column UPDATE on extracted_values(current_review_id).
    await expect(
      ctx.appPool.query(`UPDATE extracted_values SET current_review_id = $1 WHERE id = $2`, [
        revId,
        valId,
      ]),
    ).resolves.toBeDefined();

    // Forbidden column UPDATE on extracted_values(value).
    await expect(
      ctx.appPool.query(`UPDATE extracted_values SET value = '"Tampered"'::jsonb WHERE id = $1`, [
        valId,
      ]),
    ).rejects.toMatchObject({ code: '42501' });

    // Forbidden UPDATE on append-only reviews table.
    await expect(
      ctx.appPool.query(`UPDATE reviews SET note = 'tampered' WHERE id = $1`, [revId]),
    ).rejects.toMatchObject({ code: '42501' });

    // Forbidden DELETE on documents table.
    await expect(
      ctx.appPool.query(`DELETE FROM documents WHERE id = $1`, [docId]),
    ).rejects.toMatchObject({ code: '42501' });
  });
});
