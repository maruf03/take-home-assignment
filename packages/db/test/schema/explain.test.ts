import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTemplateDb, type TemplateDbHandle } from '../../src/testing/template-db.js';

interface PlanNode {
  'Node Type': string;
  'Index Name'?: string;
  Plans?: PlanNode[];
}

function collectNodes(node: PlanNode, out: PlanNode[] = []): PlanNode[] {
  out.push(node);
  for (const child of node.Plans ?? []) {
    collectNodes(child, out);
  }
  return out;
}

const HEX64 = 'c'.repeat(64);

describe('[I4] pagination.explain-uses-index', () => {
  let ctx: TemplateDbHandle;
  let sampleDocId: string;
  let sampleVersionId: string;
  let sampleRunId: string;
  let sampleValueId: string;
  let cursorDocId: string;
  let cursorReviewId: string;

  beforeAll(async () => {
    ctx = await withTemplateDb({ applyGrants: true });

    await ctx.migratorPool.query(
      `INSERT INTO document_types (key, display_name)
       VALUES ('invoice', 'Invoice'), ('lease', 'Lease')`,
    );
    const tplRes = await ctx.migratorPool.query<{ id: string }>(
      `INSERT INTO extraction_templates (document_type, version, content_sha256)
       VALUES ('invoice', 1, $1) RETURNING id`,
      [HEX64],
    );
    const templateId = tplRes.rows[0]!.id;

    // Seed 5,000 documents (1% invoice = 50 rows, 50% pending = 2,500 rows)
    // so every partial index beats broader indexes via Index Scan Backward with zero Sort.
    const docsRes = await ctx.migratorPool.query<{ id: string }>(
      `INSERT INTO documents (type, title, pending_count)
       SELECT
         CASE WHEN g % 100 = 0 THEN 'invoice' ELSE 'lease' END,
         'Doc ' || g,
         CASE WHEN g % 2 = 0 THEN 2 ELSE 0 END
       FROM generate_series(1, 5000) AS g
       RETURNING id`,
    );
    sampleDocId = docsRes.rows[0]!.id;
    cursorDocId = docsRes.rows[4950]!.id;

    // Seed 250 versions on sampleDocId.
    const versRes = await ctx.migratorPool.query<{ id: string }>(
      `INSERT INTO document_versions (document_id, version_number, template_id, storage_key, file_sha256, file_size_bytes, original_filename)
       SELECT $1, g, $2, 'k-' || g, $3, 100, 'doc.pdf'
       FROM generate_series(1, 250) AS g
       RETURNING id`,
      [sampleDocId, templateId, HEX64],
    );
    sampleVersionId = versRes.rows[0]!.id;

    // Seed 250 succeeded runs on sampleVersionId.
    const runsRes = await ctx.migratorPool.query<{ id: string }>(
      `INSERT INTO extraction_runs (version_id, run_number, status, trigger, worker_id, finished_at)
       SELECT $1, g, 'succeeded', 'retry', 'w1', now()
       FROM generate_series(1, 250) AS g
       RETURNING id`,
      [sampleVersionId],
    );
    sampleRunId = runsRes.rows[0]!.id;

    // Seed 250 llm_calls on sampleRunId.
    await ctx.migratorPool.query(
      `INSERT INTO llm_calls (run_id, version_id, seq, kind, request_sha256, provider, model, prompt_version, request)
       SELECT $1, $2, g, 'extract', $3, 'gemini', 'gemini-3.5-flash', 'v1', '{}'::jsonb
       FROM generate_series(1, 250) AS g`,
      [sampleRunId, sampleVersionId, HEX64],
    );

    // Seed 25 extracted_values and 30 reviews each (750 reviews total, 4% per value_id)
    // so GET /values/:id/reviews selects reviews_value_id_id_uq naturally.
    const valsRes = await ctx.migratorPool.query<{ id: string }>(
      `INSERT INTO extracted_values (version_id, run_id, field_key, field_type, kind, value, evidence, canonical_evidence, change_kind)
       SELECT $1, $2, 'field_' || g, 'string', 'value', '"Meridian"'::jsonb, 'Meridian', 'Meridian', 'new'
       FROM generate_series(1, 25) AS g
       RETURNING id`,
      [sampleVersionId, sampleRunId],
    );
    sampleValueId = valsRes.rows[0]!.id;

    for (const row of valsRes.rows) {
      const revRes = await ctx.migratorPool.query<{ id: string }>(
        `INSERT INTO reviews (value_id, field_type, decision, origin)
         SELECT $1, 'string', 'approve', 'human'
         FROM generate_series(1, 30) AS g
         RETURNING id`,
        [row.id],
      );
      if (row.id === sampleValueId) {
        cursorReviewId = revRes.rows[25]!.id;
      }
    }

    await ctx.migratorPool.query('ANALYZE');
  });

  afterAll(async () => {
    await ctx?.close();
  });

  async function explainPlan(query: string, params: unknown[]): Promise<PlanNode[]> {
    const res = await ctx.appPool.query<{ 'QUERY PLAN': [{ Plan: PlanNode }] }>(
      `EXPLAIN (FORMAT JSON) ${query}`,
      params,
    );
    return collectNodes(res.rows[0]!['QUERY PLAN'][0].Plan);
  }

  it('[I4] every keyset query uses its expected index with no Sort node', async () => {
    const cases: { name: string; sql: string; params: unknown[]; indexName: string }[] = [
      {
        name: 'GET /documents (alive)',
        sql: `SELECT id, title, type FROM documents WHERE deleted_at IS NULL AND id < $1 ORDER BY id DESC LIMIT 21`,
        params: [cursorDocId],
        indexName: 'documents_alive_id_idx',
      },
      {
        name: 'GET /documents?type=invoice',
        sql: `SELECT id, title, type FROM documents WHERE deleted_at IS NULL AND type = 'invoice' AND id < $1 ORDER BY id DESC LIMIT 21`,
        params: [cursorDocId],
        indexName: 'documents_alive_type_id_idx',
      },
      {
        name: 'GET /documents?needsReview=true',
        sql: `SELECT id, title, type FROM documents WHERE deleted_at IS NULL AND pending_count > 0 AND id < $1 ORDER BY id DESC LIMIT 21`,
        params: [cursorDocId],
        indexName: 'documents_alive_pending_id_idx',
      },
      {
        name: 'GET /documents?type=invoice&needsReview=true',
        sql: `SELECT id, title, type FROM documents WHERE deleted_at IS NULL AND type = 'invoice' AND pending_count > 0 AND id < $1 ORDER BY id DESC LIMIT 21`,
        params: [cursorDocId],
        indexName: 'documents_alive_type_pending_id_idx',
      },
      {
        name: 'GET /documents/:id/versions',
        sql: `SELECT id, version_number FROM document_versions WHERE document_id = $1 AND version_number < 200 ORDER BY version_number DESC LIMIT 21`,
        params: [sampleDocId],
        indexName: 'document_versions_doc_id_number_uq',
      },
      {
        name: 'GET /values/:id/reviews',
        sql: `SELECT id FROM reviews WHERE value_id = $1 AND id < $2 ORDER BY id DESC LIMIT 21`,
        params: [sampleValueId, cursorReviewId],
        indexName: 'reviews_value_id_id_uq',
      },
      {
        name: 'GET /documents/:id/versions/:n/runs',
        sql: `SELECT id, run_number FROM extraction_runs WHERE version_id = $1 AND run_number < 200 ORDER BY run_number DESC LIMIT 21`,
        params: [sampleVersionId],
        indexName: 'extraction_runs_version_run_number_uq',
      },
      {
        name: 'GET /runs/:runId/calls',
        sql: `SELECT id, seq FROM llm_calls WHERE run_id = $1 AND seq > 10 ORDER BY seq ASC LIMIT 21`,
        params: [sampleRunId],
        indexName: 'llm_calls_run_seq_uq',
      },
    ];

    for (const c of cases) {
      const nodes = await explainPlan(c.sql, c.params);
      const nodeTypes = nodes.map((n) => n['Node Type']);
      const indexNames = nodes.map((n) => n['Index Name']).filter(Boolean);
      expect(nodeTypes, `${c.name} must not have a Sort node`).not.toContain('Sort');
      expect(indexNames, `${c.name} must use index ${c.indexName}`).toContain(c.indexName);
    }
  });
});
