import type { ListLlmCallsQuery, ListRunsQuery, LlmCallDto, RunDto } from '@app/contracts/dto';
import type { Page } from '@app/contracts/page';
import type { LlmCallKind, RunStatus, RunTrigger } from '@app/contracts/status';
import {
  getAliveDocumentOrThrow,
  getRunById,
  getVersionWithTemplateVersionByNumber,
  listLlmCalls,
  listRuns,
  withReadOnlyTx,
  type ExtractionRunRow,
  type LlmCallRow,
} from '@app/db';
import { Inject, Injectable } from '@nestjs/common';
import { ProblemError } from '../common/problem.js';
import { API_DEPS, type ApiDeps } from '../deps.js';
import { iso } from '../views/presenters.js';

function toRunDto(row: ExtractionRunRow): RunDto {
  return {
    id: row.id,
    runNumber: row.runNumber,
    status: row.status as RunStatus,
    trigger: row.trigger as RunTrigger,
    correlationId: row.correlationId,
    workerId: row.workerId,
    chunked: row.chunked,
    llmCallCount: row.llmCallCount,
    reusedCallCount: row.reusedCallCount,
    costUsd: row.costUsd,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    startedAt: iso(row.startedAt),
    finishedAt: row.finishedAt ? iso(row.finishedAt) : null,
  };
}

function toLlmCallDto(row: LlmCallRow): LlmCallDto {
  return {
    id: row.id,
    runId: row.runId,
    seq: row.seq,
    kind: row.kind as LlmCallKind,
    chunkIndex: row.chunkIndex,
    reusedFromCallId: row.reusedFromCallId,
    provider: row.provider,
    model: row.model,
    servedModel: row.servedModel,
    promptVersion: row.promptVersion,
    providerRequestId: row.providerRequestId,
    stopReason: row.stopReason,
    schemaValid: row.schemaValid,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    costUsd: row.costUsd,
    latencyMs: row.latencyMs,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    request: row.request,
    rawResponse: row.rawResponse,
    startedAt: iso(row.startedAt),
    finishedAt: row.finishedAt ? iso(row.finishedAt) : null,
  };
}

@Injectable()
export class RunsService {
  constructor(@Inject(API_DEPS) private readonly deps: ApiDeps) {}

  listRuns(documentId: string, versionNumber: number, query: ListRunsQuery): Promise<Page<RunDto>> {
    return withReadOnlyTx(this.deps.db, async (tx) => {
      await getAliveDocumentOrThrow(tx, documentId);
      const { version } = await getVersionWithTemplateVersionByNumber(
        tx,
        documentId,
        versionNumber,
      );
      const page = await listRuns(tx, version.id, {
        ...(query.status !== undefined ? { status: query.status } : {}),
        limit: query.limit,
        ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
      });
      return { data: page.data.map(toRunDto), page: page.page };
    });
  }

  listCalls(
    documentId: string,
    versionNumber: number,
    runId: string,
    query: ListLlmCallsQuery,
  ): Promise<Page<LlmCallDto>> {
    // Spec §7.5 & §8: gated by DEBUG_ENDPOINTS (404 when false).
    if (!this.deps.config.DEBUG_ENDPOINTS) {
      throw new ProblemError('ROUTE_NOT_FOUND', 'Route not found');
    }
    return withReadOnlyTx(this.deps.db, async (tx) => {
      await getAliveDocumentOrThrow(tx, documentId);
      const { version } = await getVersionWithTemplateVersionByNumber(
        tx,
        documentId,
        versionNumber,
      );
      const run = await getRunById(tx, version.id, runId);
      if (!run) {
        throw new ProblemError(
          'RUN_NOT_FOUND',
          `Run ${runId} not found for version ${versionNumber}`,
        );
      }
      const page = await listLlmCalls(tx, run.id, {
        ...(query.kind !== undefined ? { kind: query.kind } : {}),
        limit: query.limit,
        ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
      });
      return { data: page.data.map(toLlmCallDto), page: page.page };
    });
  }
}
