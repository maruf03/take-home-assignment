import type { Page } from '@app/contracts/page';
import type { LlmCallKind } from '@app/contracts/status';
import { and, asc, eq, isNull, sql, type SQL } from 'drizzle-orm';
import type { DbTx } from '../client.js';
import { documentVersions, llmCalls } from '../schema/documents.js';
import { fingerprintFilters, isValidPositiveIntKey, keyset, toPage } from './keyset.js';

export type LlmCallRow = typeof llmCalls.$inferSelect;

export interface InsertLlmCallInput {
  versionId: string;
  seq: number;
  kind: LlmCallKind;
  chunkIndex?: number | null;
  requestSha256: string;
  reusedFromCallId?: string | null;
  provider: string;
  model: string;
  servedModel?: string | null;
  promptVersion: string;
  request: unknown;
  providerRequestId?: string | null;
  rawResponse?: unknown;
  stopReason?: string | null;
  schemaValid?: boolean | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  usage?: unknown;
  costUsd?: string;
  latencyMs?: number | null;
  finished?: boolean;
}

/**
 * C2 fenced INSERT: acquires a non-blocking KEY SHARE fence check on document_versions(active_run_id)
 * before inserting into llm_calls (global lock order: document_versions -> llm_calls).
 * Returns null if the worker has lost its lease.
 */
export async function insertLlmCall(
  tx: DbTx,
  input: InsertLlmCallInput,
  runId: string,
): Promise<LlmCallRow | null> {
  const fenced = await tx
    .select({ id: documentVersions.id })
    .from(documentVersions)
    .where(and(eq(documentVersions.id, input.versionId), eq(documentVersions.activeRunId, runId)))
    .for('key share');

  if (!fenced[0]) {
    return null;
  }

  const [row] = await tx
    .insert(llmCalls)
    .values({
      runId,
      versionId: input.versionId,
      seq: input.seq,
      kind: input.kind,
      chunkIndex: input.chunkIndex ?? null,
      requestSha256: input.requestSha256,
      reusedFromCallId: input.reusedFromCallId ?? null,
      provider: input.provider,
      model: input.model,
      servedModel: input.servedModel ?? null,
      promptVersion: input.promptVersion,
      request: input.request,
      providerRequestId: input.providerRequestId ?? null,
      rawResponse: input.rawResponse ?? null,
      stopReason: input.stopReason ?? null,
      schemaValid: input.schemaValid ?? null,
      inputTokens: input.inputTokens ?? null,
      outputTokens: input.outputTokens ?? null,
      usage: input.usage ?? null,
      costUsd: input.costUsd ?? '0',
      latencyMs: input.latencyMs ?? null,
      finishedAt: input.finished ? sql`now()` : null,
    })
    .returning();

  return row ?? null;
}

export interface CompleteLlmCallInput {
  rawResponse?: unknown;
  providerRequestId?: string | null;
  servedModel?: string | null;
  stopReason?: string | null;
  schemaValid?: boolean | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  usage?: unknown;
  costUsd?: string;
  latencyMs?: number | null;
  errorCode?: string | null;
  errorMessage?: string | null;
}

/**
 * C2 fenced UPDATE of ONLY the column-granted response/usage columns on llm_calls (spec §8).
 */
export async function completeLlmCall(
  tx: DbTx,
  callId: string,
  versionId: string,
  runId: string,
  completion: CompleteLlmCallInput,
): Promise<boolean> {
  const updated = await tx
    .update(llmCalls)
    .set({
      rawResponse: completion.rawResponse ?? null,
      providerRequestId: completion.providerRequestId ?? null,
      servedModel: completion.servedModel ?? null,
      stopReason: completion.stopReason ?? null,
      schemaValid: completion.schemaValid ?? null,
      inputTokens: completion.inputTokens ?? null,
      outputTokens: completion.outputTokens ?? null,
      usage: completion.usage ?? null,
      costUsd: completion.costUsd ?? '0',
      latencyMs: completion.latencyMs ?? null,
      errorCode: completion.errorCode ?? null,
      errorMessage: completion.errorMessage ?? null,
      finishedAt: sql`now()`,
    })
    .where(
      and(
        eq(llmCalls.id, callId),
        eq(llmCalls.runId, runId),
        sql`EXISTS (
          SELECT 1 FROM document_versions
          WHERE id = ${versionId} AND active_run_id = ${runId}
        )`,
      ),
    )
    .returning({ id: llmCalls.id });

  return updated.length === 1;
}

export async function findReusableLlmCall(
  tx: DbTx,
  versionId: string,
  requestSha256: string,
): Promise<LlmCallRow | null> {
  const rows = await tx
    .select()
    .from(llmCalls)
    .where(
      and(
        eq(llmCalls.versionId, versionId),
        eq(llmCalls.requestSha256, requestSha256),
        eq(llmCalls.schemaValid, true),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Counts every billed LLM attempt (reused_from_call_id IS NULL) for call-cap enforcement (spec §4.7).
 */
export async function countBilledLlmCalls(tx: DbTx, versionId: string): Promise<number> {
  const rows = await tx
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(llmCalls)
    .where(and(eq(llmCalls.versionId, versionId), isNull(llmCalls.reusedFromCallId)));
  return rows[0]?.count ?? 0;
}

export interface ListLlmCallsParams {
  kind?: LlmCallKind;
  limit?: number;
  cursor?: string;
}

export async function listLlmCalls(
  tx: DbTx,
  runId: string,
  params: ListLlmCallsParams = {},
): Promise<Page<LlmCallRow>> {
  const fingerprint = fingerprintFilters({ kind: params.kind });

  const ks = keyset({
    key: llmCalls.seq,
    cursor: params.cursor,
    limit: params.limit,
    direction: 'asc',
    fingerprint,
    validateKey: isValidPositiveIntKey,
    parseKey: (k) => Number(k),
  });

  const conditions: SQL[] = [eq(llmCalls.runId, runId)];
  if (params.kind !== undefined) {
    conditions.push(eq(llmCalls.kind, params.kind));
  }
  if (ks.whereClause) {
    conditions.push(ks.whereClause);
  }

  const rows = await tx
    .select()
    .from(llmCalls)
    .where(and(...conditions))
    .orderBy(asc(llmCalls.seq))
    .limit(ks.limitPlusOne);

  return toPage(rows, ks.limit, (row) => String(row.seq), fingerprint);
}
