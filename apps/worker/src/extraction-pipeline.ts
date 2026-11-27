import { createHash, randomBytes } from 'node:crypto';
import type { TextRanges } from '@app/contracts/dto';
import type { VersionErrorCode } from '@app/contracts/problems';
import type {
  DateOrder,
  ExtractedValueKind,
  FieldType,
  LlmCallKind,
  ReviewDecision,
  RunTrigger,
  ValueFlag,
  VersionWarning,
} from '@app/contracts/status';
import type { TypedValue } from '@app/contracts/values';
import {
  buildPromptFromRenderedDocument,
  buildToolSchema,
  classifyChange,
  decideCarry,
  DEFAULT_CHUNK_CHAR_LIMIT,
  mergeChunkResults,
  parseToolOutput,
  planChunks,
  scanInstructions,
  validateExtraction,
  type BaselineFieldSnapshot,
  type ExtractionTemplateSpec,
  type ParsedToolOutput,
  type ValidatedFieldResult,
} from '@app/core';
import {
  claimVersion,
  completeLlmCall,
  countBilledLlmCalls,
  failRun,
  finalizeRun,
  findReusableLlmCall,
  getBaselineExtractedVersion,
  getTemplateWithFields,
  getVersionById,
  insertLlmCall,
  listRuns,
  listValuesForVersion,
  releaseRun,
  saveParsedText,
  withTx,
  type AppDatabase,
  type FinalizeValueInput,
  type LlmCallRow,
} from '@app/db';
import {
  computeDocumentFingerprint,
  LlmError,
  parseAnthropicRawResponse,
  parseGeminiRawResponse,
  type ExtractionRepairError,
  type ExtractionResult,
  type LlmProvider,
} from '@app/llm';
import { PdfParseError, type PdfParser } from '@app/pdf';
import { StorageError, type BlobStore } from '@app/storage';
import { HeartbeatLoop } from './heartbeat.js';

export type PipelineStageEvent =
  'claimed' | 'parsed' | 'llm-started' | 'llm-response-persisted' | 'finalized';

export interface PipelineRunContext {
  readonly trigger?: RunTrigger;
  readonly correlationId?: string | null;
  readonly shutdownSignal?: AbortSignal;
}

export interface ExtractionPipelineOptions {
  readonly workerId: string;
  readonly model: string;
  readonly leaseSeconds?: number;
  readonly heartbeatIntervalMs?: number;
  readonly chunkCharLimit?: number;
  readonly inRunRetryMaxMs?: number;
  readonly maxInRunRetries?: number;
  readonly defaultTransientBackoffMs?: number;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly random?: () => number;
  readonly nonceGenerator?: () => string;
  readonly onStageEvent?: (
    stage: PipelineStageEvent,
    meta: { versionId: string; runId: string; chunkIndex?: number | null },
  ) => Promise<void> | void;
}

export type PipelineOutcome =
  | {
      readonly status: 'noop_already_claimed';
    }
  | {
      readonly status: 'aborted_fence';
      readonly runId: string;
    }
  | {
      readonly status: 'succeeded';
      readonly runId: string;
      readonly runNumber: number;
      readonly pointerMoved: boolean;
      readonly pendingCount: number;
      readonly insertedCount: number;
    }
  | {
      readonly status: 'failed_permanent';
      readonly runId: string;
      readonly errorCode: VersionErrorCode;
      readonly message: string;
    }
  | {
      readonly status: 'released_transient';
      readonly runId: string;
      readonly errorCode: string;
      readonly message: string;
      readonly backoffMs: number;
      readonly rateLimitMs?: number;
    };

class FenceLostError extends Error {
  constructor(message = 'Fencing token lost') {
    super(message);
    this.name = 'FenceLostError';
  }
}

class PermanentFailureError extends Error {
  readonly code: VersionErrorCode;

  constructor(code: VersionErrorCode, message: string, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = 'PermanentFailureError';
    this.code = code;
  }
}

class TransientReleaseError extends Error {
  readonly code: string;
  readonly backoffMs: number;
  readonly rateLimitMs?: number;

  constructor(
    code: string,
    message: string,
    options: { backoffMs: number; rateLimitMs?: number; cause?: unknown },
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'TransientReleaseError';
    this.code = code;
    this.backoffMs = options.backoffMs;
    this.rateLimitMs = options.rateLimitMs;
  }
}

const DEFAULT_LEASE_SECONDS = 30;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;
const DEFAULT_IN_RUN_RETRY_MAX_MS = 20_000;
const DEFAULT_MAX_IN_RUN_RETRIES = 2;
const DEFAULT_TRANSIENT_BACKOFF_MS = 10_000;

function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new FenceLostError('Sleep aborted by fence or shutdown signal'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new FenceLostError('Sleep aborted by fence or shutdown signal'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function mergeWarnings(...lists: ReadonlyArray<readonly VersionWarning[]>): VersionWarning[] {
  const seen = new Set<VersionWarning>();
  for (const list of lists) {
    for (const item of list) {
      seen.add(item);
    }
  }
  return [...seen];
}

function mapLlmErrorToPermanentCode(err: LlmError): VersionErrorCode {
  switch (err.code) {
    case 'NOT_CONFIGURED':
      return 'LLM_NOT_CONFIGURED';
    case 'AUTH':
      return 'LLM_AUTH';
    case 'RATE_CAPPED':
      return 'LLM_RATE_CAPPED';
    case 'BAD_REQUEST':
    case 'MODEL_NOT_FOUND':
    default:
      return 'LLM_BAD_REQUEST';
  }
}

function extractOutputFromStoredCall(reusable: LlmCallRow, requestedModel: string): unknown {
  const raw = reusable.rawResponse;
  if (raw === null || raw === undefined) {
    return null;
  }

  // Raw body for Gemini or Gemini cassette contains `candidates`
  if (typeof raw === 'object' && 'candidates' in raw) {
    const parsed = parseGeminiRawResponse(JSON.stringify(raw), requestedModel, 0);
    return parsed.kind === 'ok' ? parsed.output : null;
  }

  // Raw body for Anthropic or Anthropic cassette contains `content` array of blocks
  if (
    typeof raw === 'object' &&
    'content' in raw &&
    Array.isArray((raw as { content?: unknown }).content)
  ) {
    const parsed = parseAnthropicRawResponse(
      JSON.stringify(raw),
      reusable.providerRequestId,
      requestedModel,
      'record_extraction',
      0,
    );
    return parsed.kind === 'ok' ? parsed.output : null;
  }

  // Direct tool output object (FakeLlmProvider / FakeIpcLlmProvider)
  if (typeof raw === 'object' && 'fields' in raw) {
    return raw;
  }

  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed === 'object' && parsed !== null) {
        if ('candidates' in parsed) {
          const g = parseGeminiRawResponse(raw, requestedModel, 0);
          return g.kind === 'ok' ? g.output : null;
        }
        if ('content' in parsed) {
          const a = parseAnthropicRawResponse(
            raw,
            reusable.providerRequestId,
            requestedModel,
            'record_extraction',
            0,
          );
          return a.kind === 'ok' ? a.output : null;
        }
        return 'fields' in parsed ? parsed : null;
      }
    } catch {
      return null;
    }
  }

  return null;
}

function computeRequestHash(input: {
  versionId: string;
  parsedTextSha256: string;
  templateId: string;
  promptVersion: string;
  providerName: string;
  model: string;
  chunkIndex: number | null;
  userPrompt: string;
  schema: Record<string, unknown>;
}): string {
  // Strip random `<document-{nonce}>` fences so a crashed run's stored C2 call is reused
  // deterministically by the next run (spec §5.3 step 2, [I3]).
  const userFingerprint = computeDocumentFingerprint(input.userPrompt);
  const schemaHash = sha256Hex(JSON.stringify(input.schema));
  return sha256Hex(
    [
      input.versionId,
      input.parsedTextSha256,
      input.templateId,
      input.promptVersion,
      input.providerName,
      input.model,
      input.chunkIndex === null ? 'single' : String(input.chunkIndex),
      userFingerprint,
      schemaHash,
    ].join(':'),
  );
}

/**
 * Plain constructor-injected extraction pipeline implementing spec §3, §5, and §6:
 * Claim -> Heartbeat -> C1 (parse, write-once) -> Plan/Chunk -> C2 (reuse/call/repair/cap) ->
 * Validate & Merge -> C3 (carry-over A′ & fenced finalize).
 */
export class ExtractionPipeline {
  private readonly resolveProvider: () => LlmProvider;
  private readonly workerId: string;
  private readonly model: string;
  private readonly leaseSeconds: number;
  private readonly heartbeatIntervalMs: number;
  private readonly chunkCharLimit: number;
  private readonly inRunRetryMaxMs: number;
  private readonly maxInRunRetries: number;
  private readonly defaultTransientBackoffMs: number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly random: () => number;
  private readonly nonceGenerator: () => string;
  private readonly onStageEvent?: ExtractionPipelineOptions['onStageEvent'];

  constructor(
    private readonly db: AppDatabase,
    private readonly blobStore: BlobStore,
    private readonly pdfParser: Pick<PdfParser, 'parse'>,
    llmProviderOrFactory: LlmProvider | (() => LlmProvider),
    options: ExtractionPipelineOptions,
  ) {
    this.resolveProvider =
      typeof llmProviderOrFactory === 'function'
        ? llmProviderOrFactory
        : () => llmProviderOrFactory;
    this.workerId = options.workerId;
    this.model = options.model;
    this.leaseSeconds = Math.max(1, Math.trunc(options.leaseSeconds ?? DEFAULT_LEASE_SECONDS));
    this.heartbeatIntervalMs = Math.max(
      100,
      Math.trunc(options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS),
    );
    this.chunkCharLimit = Math.max(
      100,
      Math.trunc(options.chunkCharLimit ?? DEFAULT_CHUNK_CHAR_LIMIT),
    );
    this.inRunRetryMaxMs = Math.max(
      0,
      Math.trunc(options.inRunRetryMaxMs ?? DEFAULT_IN_RUN_RETRY_MAX_MS),
    );
    this.maxInRunRetries = Math.max(
      0,
      Math.trunc(options.maxInRunRetries ?? DEFAULT_MAX_IN_RUN_RETRIES),
    );
    this.defaultTransientBackoffMs = Math.max(
      0,
      Math.trunc(options.defaultTransientBackoffMs ?? DEFAULT_TRANSIENT_BACKOFF_MS),
    );
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
    this.nonceGenerator = options.nonceGenerator ?? (() => randomBytes(8).toString('hex'));
    this.onStageEvent = options.onStageEvent;
  }

  async run(versionId: string, ctx: PipelineRunContext = {}): Promise<PipelineOutcome> {
    // Step 1: Claim version (fenced, global lock order)
    const claimed = await withTx(this.db, (tx) =>
      claimVersion(tx, versionId, this.workerId, {
        trigger: ctx.trigger ?? 'upload',
        correlationId: ctx.correlationId ?? null,
        leaseSeconds: this.leaseSeconds,
      }),
    );

    if (!claimed) {
      return { status: 'noop_already_claimed' };
    }

    const { runId, runNumber } = claimed;
    const heartbeatLoop = new HeartbeatLoop({
      db: this.db,
      versionId,
      runId,
      leaseSeconds: this.leaseSeconds,
      intervalMs: this.heartbeatIntervalMs,
    });
    heartbeatLoop.start();

    const runSignal = ctx.shutdownSignal
      ? AbortSignal.any([heartbeatLoop.signal, ctx.shutdownSignal])
      : heartbeatLoop.signal;

    const assertNotAborted = (): void => {
      if (runSignal.aborted) {
        throw new FenceLostError('Run aborted by fence loss or shutdown signal');
      }
    };

    try {
      await this.onStageEvent?.('claimed', { versionId, runId });
      assertNotAborted();

      // Load version + pinned template
      const version = await getVersionById(this.db, versionId);
      if (!version) {
        throw new FenceLostError('Version disappeared after claim');
      }
      const tplBundle = await getTemplateWithFields(this.db, version.templateId);
      if (!tplBundle) {
        throw new PermanentFailureError(
          'LLM_BAD_REQUEST',
          `Pinned extraction template ${version.templateId} not found`,
        );
      }

      const templateSpec: ExtractionTemplateSpec = {
        documentType: tplBundle.template.documentType,
        instructions: tplBundle.template.instructions,
        defaultCurrency: tplBundle.template.defaultCurrency,
        dateOrder: tplBundle.template.dateOrder as DateOrder,
        fields: tplBundle.fields.map((f) => ({
          fieldKey: f.fieldKey,
          fieldType: f.fieldType as FieldType,
          position: f.position,
          label: f.label,
          description: f.description,
        })),
      };

      // Spec §5.3 step 5 & [I3]: A manual retry of LLM_SCHEMA_INVALID bypasses C2 reuse.
      let bypassReuse = false;
      if (runNumber > 1) {
        const recentRuns = await listRuns(this.db, versionId, { limit: 3 });
        const previousRun = recentRuns.data.find((r) => r.runNumber < runNumber);
        if (
          previousRun &&
          previousRun.status === 'failed' &&
          previousRun.errorCode === 'LLM_SCHEMA_INVALID'
        ) {
          bypassReuse = true;
        }
      }

      // Step 2: C1 — Parse PDF (write-once checkpoint)
      let parsedText = version.parsedText;
      let parsedTextSha256 = version.parsedTextSha256;
      let parserName = version.parser;
      let textRanges: TextRanges = (version.textRanges as TextRanges | null) ?? {
        hidden: [],
        lowVisibility: [],
      };
      let warnings: VersionWarning[] = [...(version.warnings as VersionWarning[])];

      if (parsedText === null || parsedTextSha256 === null || parserName === null) {
        const pdfBytes = await this.fetchPdfBytes(version.storageKey, runSignal);
        assertNotAborted();

        const actualSha256 = sha256Hex(pdfBytes);
        if (actualSha256 !== version.fileSha256) {
          throw new PermanentFailureError(
            'INTEGRITY_MISMATCH',
            `Stored PDF sha256 mismatch for version ${versionId}`,
          );
        }

        const parsed = await this.parsePdfBytes(pdfBytes, runSignal);
        assertNotAborted();

        const scan = scanInstructions(parsed.text);
        const c1Warnings = mergeWarnings(
          parsed.warnings,
          scan.suspicious ? ['SUSPICIOUS_INSTRUCTIONS'] : [],
        );
        const computedTextSha = sha256Hex(parsed.text);

        const persisted = await saveParsedText(this.db, versionId, runId, {
          parsedText: parsed.text,
          parsedTextSha256: computedTextSha,
          parser: parsed.parser,
          pageOffsets: parsed.pageOffsets,
          textRanges: parsed.textRanges,
          warnings: c1Warnings,
        });

        if (!persisted) {
          // Either we lost our fence OR a previous crashed run already wrote parsed_text.
          const refreshed = await getVersionById(this.db, versionId);
          if (!refreshed || refreshed.activeRunId !== runId) {
            throw new FenceLostError('Lost fence while saving C1 parsed_text');
          }
          if (refreshed.parsedText === null || refreshed.parsedTextSha256 === null) {
            throw new FenceLostError('Unexpected null parsed_text after C1 write');
          }
          parsedText = refreshed.parsedText;
          parsedTextSha256 = refreshed.parsedTextSha256;
          parserName = refreshed.parser ?? parsed.parser;
          textRanges = (refreshed.textRanges as TextRanges | null) ?? parsed.textRanges;
          warnings = mergeWarnings(refreshed.warnings as VersionWarning[]);
        } else {
          parsedText = parsed.text;
          parsedTextSha256 = computedTextSha;
          parserName = parsed.parser;
          textRanges = parsed.textRanges;
          warnings = c1Warnings;
        }
      }

      await this.onStageEvent?.('parsed', { versionId, runId });
      assertNotAborted();

      // Resolve LLM provider after C1 so unconfigured providers still surface clean LLM_NOT_CONFIGURED.
      let provider: LlmProvider;
      try {
        provider = this.resolveProvider();
      } catch (err) {
        if (err instanceof LlmError) {
          throw new PermanentFailureError(mapLlmErrorToPermanentCode(err), err.message, err);
        }
        throw err;
      }

      // Step 3: Build schema & plan single call or chunks (§5.3, §5.4)
      const schema = buildToolSchema(templateSpec);
      const nonce = this.nonceGenerator();
      const chunks = planChunks(parsedText, textRanges, nonce, this.chunkCharLimit);
      const isChunked = chunks.length > 1;
      if (isChunked) {
        warnings = mergeWarnings(warnings, ['CHUNKED']);
      }

      // Call cap: max(6, plannedChunks + 3) billed calls per version across all runs (spec §5.3, [I3])
      const callCap = Math.max(6, chunks.length + 3);

      // Step 4: C2 — Run LLM calls per chunk with reuse, repair, max_tokens double, and call cap
      let callSeq = 0;
      let llmCallCount = 0;
      let reusedCallCount = 0;
      let totalCostUsd = 0;
      let modelFlaggedSuspicious = false;
      const chunkValidatedResults: ValidatedFieldResult[][] = [];

      const nextSeq = (): number => {
        callSeq += 1;
        return callSeq;
      };

      const executeSingleBilledAttempt = async (params: {
        kind: LlmCallKind;
        chunkIndex: number | null;
        requestSha256: string;
        promptVersion: string;
        system: string;
        user: string;
        maxOutputTokens: number;
        repair?: { previousRaw: unknown; errors: readonly ExtractionRepairError[] };
      }): Promise<{
        result: ExtractionResult;
        parsed: ReturnType<typeof parseToolOutput> | null;
      }> => {
        assertNotAborted();

        const billedSoFar = await countBilledLlmCalls(this.db, versionId);
        if (billedSoFar >= callCap) {
          throw new PermanentFailureError(
            'LLM_CALL_CAP',
            `Version ${versionId} reached billed LLM call cap (${callCap})`,
          );
        }

        const seq = nextSeq();
        // Spec §4.7: llm_calls.request stores system + user + tool schema (never headers or keys).
        const requestMeta = {
          kind: params.kind,
          chunkIndex: params.chunkIndex,
          promptVersion: params.promptVersion,
          toolName: 'record_extraction',
          system: params.system,
          user: params.user,
          schema,
          maxOutputTokens: params.maxOutputTokens,
          repair: params.repair ?? null,
        };

        const insertedCall = await withTx(this.db, (tx) =>
          insertLlmCall(
            tx,
            {
              versionId,
              seq,
              kind: params.kind,
              // Spec §4.7 CHECK: (kind = 'chunk') = (chunk_index IS NOT NULL).
              chunkIndex: params.kind === 'chunk' ? params.chunkIndex : null,
              requestSha256: params.requestSha256,
              provider: provider.name,
              model: this.model,
              promptVersion: params.promptVersion,
              request: requestMeta,
            },
            runId,
          ),
        );

        if (!insertedCall) {
          throw new FenceLostError('Lost fence inserting C2 llm_calls row');
        }

        await this.onStageEvent?.('llm-started', {
          versionId,
          runId,
          chunkIndex: params.chunkIndex,
        });

        let result: ExtractionResult;
        try {
          result = await provider.extract({
            system: params.system,
            user: params.user,
            schema,
            toolName: 'record_extraction',
            model: this.model,
            maxOutputTokens: params.maxOutputTokens,
            cacheKey: params.requestSha256,
            promptVersion: params.promptVersion,
            signal: runSignal,
            repair: params.repair,
          });
        } catch (err) {
          if (err instanceof LlmError && (err.code === 'ABORTED' || runSignal.aborted)) {
            throw new FenceLostError('LLM call aborted by fence loss or shutdown');
          }
          if (runSignal.aborted) {
            throw new FenceLostError('LLM call aborted by fence loss or shutdown');
          }
          const errCode = err instanceof LlmError ? err.code : 'NETWORK';
          const errMsg = err instanceof Error ? err.message : String(err);
          const errRaw = err instanceof LlmError ? err.raw : undefined;
          const completedErr = await withTx(this.db, (tx) =>
            completeLlmCall(tx, insertedCall.id, versionId, runId, {
              rawResponse: errRaw ?? null,
              schemaValid: false,
              errorCode: errCode,
              errorMessage: errMsg,
            }),
          );
          if (!completedErr) {
            throw new FenceLostError('Lost fence completing failed C2 llm_calls row');
          }
          throw err;
        }

        assertNotAborted();

        const costUsd = provider.estimateCostUsd(result.usage, this.model, result.servedModel);
        const parsed = result.kind === 'ok' ? parseToolOutput(result.output, templateSpec) : null;
        const schemaValid = result.kind === 'ok' && parsed !== null && parsed.ok;

        // C2: persist raw response, usage, and cost BEFORE validation/fail (spec §5.3 step 3)
        const completed = await withTx(this.db, (tx) =>
          completeLlmCall(tx, insertedCall.id, versionId, runId, {
            rawResponse: result.raw,
            providerRequestId: result.providerRequestId,
            servedModel: result.servedModel,
            stopReason: result.stopReason,
            schemaValid,
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
            usage: result.usage,
            costUsd: costUsd.toFixed(6),
            latencyMs: result.latencyMs,
            errorCode: schemaValid ? null : result.kind === 'ok' ? 'schema_invalid' : result.kind,
            errorMessage: schemaValid
              ? null
              : result.kind === 'schema_invalid'
                ? (result.parseError ?? 'Invalid JSON')
                : parsed && !parsed.ok
                  ? parsed.errors.map((e) => `${e.path}: ${e.message}`).join('; ')
                  : `Stop reason: ${result.stopReason}`,
          }),
        );

        if (!completed) {
          throw new FenceLostError('Lost fence completing C2 llm_calls row');
        }

        llmCallCount += 1;
        totalCostUsd += costUsd;

        return { result, parsed };
      };

      const executeWithInRunRetry = async (params: {
        kind: LlmCallKind;
        chunkIndex: number | null;
        requestSha256: string;
        promptVersion: string;
        system: string;
        user: string;
        maxOutputTokens: number;
        repair?: { previousRaw: unknown; errors: readonly ExtractionRepairError[] };
      }): Promise<{
        result: ExtractionResult;
        parsed: ReturnType<typeof parseToolOutput> | null;
      }> => {
        let inRunAttempts = 0;
        for (;;) {
          try {
            const out = await executeSingleBilledAttempt(params);
            await this.onStageEvent?.('llm-response-persisted', {
              versionId,
              runId,
              chunkIndex: params.chunkIndex,
            });
            return out;
          } catch (err) {
            if (
              err instanceof FenceLostError ||
              err instanceof PermanentFailureError ||
              err instanceof TransientReleaseError
            ) {
              throw err;
            }
            if (err instanceof LlmError) {
              if (!err.transient) {
                throw new PermanentFailureError(mapLlmErrorToPermanentCode(err), err.message, err);
              }
              // Spec §5.3 & §6: retry in-run when retry-after <= 20s (full jitter 0..retryAfterMs), otherwise release to BullMQ.
              if (
                err.retryAfterMs !== undefined &&
                err.retryAfterMs <= this.inRunRetryMaxMs &&
                inRunAttempts < this.maxInRunRetries
              ) {
                inRunAttempts += 1;
                const jitteredMs = Math.max(0, Math.ceil(err.retryAfterMs * this.random()));
                await this.sleep(jitteredMs, runSignal);
                continue;
              }

              const backoffMs = err.retryAfterMs ?? this.defaultTransientBackoffMs;
              throw new TransientReleaseError(err.code, err.message, {
                backoffMs,
                rateLimitMs: err.code === 'RATE_LIMITED' ? err.retryAfterMs : undefined,
                cause: err,
              });
            }

            // Propagate unexpected non-LlmError failures (e.g., DB crash or chaos hook) cleanly.
            throw err;
          }
        }
      };

      for (const chunk of chunks) {
        assertNotAborted();
        const chunkIndex = isChunked ? chunk.chunkIndex : null;
        const callKind: LlmCallKind = isChunked ? 'chunk' : 'extract';
        const prompt = buildPromptFromRenderedDocument(templateSpec, chunk.rendered);
        const requestSha256 = computeRequestHash({
          versionId,
          parsedTextSha256,
          templateId: version.templateId,
          promptVersion: prompt.promptVersion,
          providerName: provider.name,
          model: this.model,
          chunkIndex,
          userPrompt: prompt.user,
          schema,
        });

        let parsedOutput: ParsedToolOutput | null = null;

        // C2 reuse check (spec §5.3 step 2, [I3])
        if (!bypassReuse) {
          const reusable = await findReusableLlmCall(this.db, versionId, requestSha256);
          if (reusable) {
            const extractedRaw = extractOutputFromStoredCall(reusable, this.model);
            const reparsed = parseToolOutput(extractedRaw, templateSpec);
            if (reparsed.ok) {
              const reusedRow = await withTx(this.db, (tx) =>
                insertLlmCall(
                  tx,
                  {
                    versionId,
                    seq: nextSeq(),
                    kind: callKind,
                    chunkIndex,
                    requestSha256,
                    reusedFromCallId: reusable.id,
                    provider: reusable.provider,
                    model: reusable.model,
                    servedModel: reusable.servedModel,
                    promptVersion: reusable.promptVersion,
                    request: { reused: true, chunkIndex },
                    providerRequestId: reusable.providerRequestId,
                    rawResponse: reusable.rawResponse,
                    stopReason: reusable.stopReason,
                    schemaValid: true,
                    inputTokens: 0,
                    outputTokens: 0,
                    usage: { inputTokens: 0, outputTokens: 0 },
                    costUsd: '0',
                    latencyMs: 0,
                    finished: true,
                  },
                  runId,
                ),
              );
              if (!reusedRow) {
                throw new FenceLostError('Lost fence inserting reused llm_calls row');
              }
              reusedCallCount += 1;
              parsedOutput = reparsed.data;
            }
          }
        }

        if (!parsedOutput) {
          let maxTokens = Math.min(prompt.maxOutputTokens, provider.capabilities.maxOutputTokens);
          let attempt = await executeWithInRunRetry({
            kind: callKind,
            chunkIndex,
            requestSha256,
            promptVersion: prompt.promptVersion,
            system: prompt.system,
            user: prompt.user,
            maxOutputTokens: maxTokens,
          });

          // Stop reason: max_tokens -> retry once with doubled budget, then LLM_TRUNCATED
          if (attempt.result.kind === 'truncated') {
            maxTokens = Math.min(maxTokens * 2, provider.capabilities.maxOutputTokens);
            attempt = await executeWithInRunRetry({
              kind: callKind,
              chunkIndex,
              requestSha256,
              promptVersion: prompt.promptVersion,
              system: prompt.system,
              user: prompt.user,
              maxOutputTokens: maxTokens,
            });
            if (attempt.result.kind === 'truncated') {
              throw new PermanentFailureError(
                'LLM_TRUNCATED',
                `LLM response truncated even at maxOutputTokens=${maxTokens}`,
              );
            }
          }

          if (attempt.result.kind === 'refused' || attempt.result.kind === 'no_output') {
            throw new PermanentFailureError(
              'LLM_REFUSED',
              `LLM returned ${attempt.result.kind} (stopReason=${attempt.result.stopReason})`,
            );
          }

          if (attempt.result.kind === 'ok' && attempt.parsed?.ok) {
            parsedOutput = attempt.parsed.data;
          } else {
            // Single repair turn with fixed error codes & paths only (spec §5.3 step 4)
            const repairErrors: ExtractionRepairError[] =
              attempt.result.kind === 'schema_invalid'
                ? [
                    {
                      path: '<root>',
                      code: 'INVALID_JSON',
                      message: attempt.result.parseError ?? 'Output was not valid JSON',
                    },
                  ]
                : attempt.parsed && !attempt.parsed.ok
                  ? attempt.parsed.errors.map((e) => ({
                      path: e.path,
                      code: e.code,
                      message: e.message,
                    }))
                  : [
                      {
                        path: '<root>',
                        code: 'SCHEMA_INVALID',
                        message: 'Output did not match tool schema',
                      },
                    ];

            const repairAttempt = await executeWithInRunRetry({
              kind: 'repair',
              chunkIndex,
              requestSha256,
              promptVersion: prompt.promptVersion,
              system: prompt.system,
              user: prompt.user,
              maxOutputTokens: maxTokens,
              repair: {
                previousRaw: attempt.result.raw,
                errors: repairErrors,
              },
            });

            if (repairAttempt.result.kind === 'truncated') {
              throw new PermanentFailureError('LLM_TRUNCATED', 'LLM repair response was truncated');
            }
            if (
              repairAttempt.result.kind === 'refused' ||
              repairAttempt.result.kind === 'no_output'
            ) {
              throw new PermanentFailureError(
                'LLM_REFUSED',
                `LLM repair returned ${repairAttempt.result.kind}`,
              );
            }
            if (repairAttempt.result.kind !== 'ok' || !repairAttempt.parsed?.ok) {
              throw new PermanentFailureError(
                'LLM_SCHEMA_INVALID',
                'LLM output failed schema validation after repair turn',
              );
            }
            parsedOutput = repairAttempt.parsed.data;
          }
        }

        if (parsedOutput.documentFlags.suspiciousInstructions) {
          modelFlaggedSuspicious = true;
        }

        const validated = validateExtraction(templateSpec, parsedText, textRanges, parsedOutput, {
          chunkIndex,
        });
        chunkValidatedResults.push(validated);
      }

      if (modelFlaggedSuspicious) {
        warnings = mergeWarnings(warnings, ['SUSPICIOUS_INSTRUCTIONS']);
      }

      // Step 5: Merge chunks (§5.4)
      const mergedResults =
        chunkValidatedResults.length === 1
          ? chunkValidatedResults[0]!
          : mergeChunkResults(templateSpec, chunkValidatedResults);

      assertNotAborted();

      // Step 6: C3 — Carry-over A′ & Fenced Finalize (§3, §5.6)
      // Baseline version & review reads run inside `buildValues` strictly AFTER `finalizeRun`
      // acquires `documents FOR UPDATE` and fenced `document_versions FOR UPDATE`.
      const finalParsedText = parsedText;
      const finalParserName = parserName;
      const finalTextRanges = textRanges;
      const finalWarnings = warnings;

      const finalized = await withTx(this.db, (tx) =>
        finalizeRun(tx, versionId, runId, {
          warnings: finalWarnings,
          chunked: isChunked,
          llmCallCount,
          reusedCallCount,
          costUsd: totalCostUsd.toFixed(6),
          buildValues: async ({ tx: lockedTx, document, version: lockedVersion }) => {
            const baselineVersion = await getBaselineExtractedVersion(
              lockedTx,
              document.id,
              lockedVersion.versionNumber,
            );

            const baselineRows = baselineVersion
              ? await listValuesForVersion(lockedTx, baselineVersion.id)
              : [];
            const baselineByKey = new Map(baselineRows.map((row) => [row.value.fieldKey, row]));

            const carryoverCtx = baselineVersion
              ? {
                  baselineParser: baselineVersion.parser ?? '',
                  nextParser: finalParserName,
                  baselineText: baselineVersion.parsedText ?? '',
                  nextText: finalParsedText,
                  nextRanges: finalTextRanges,
                  dateOrder: templateSpec.dateOrder,
                }
              : null;

            return mergedResults.map((next): FinalizeValueInput => {
              const baseEntry = baselineByKey.get(next.fieldKey);
              const baselineSnapshot: BaselineFieldSnapshot | null = baseEntry
                ? {
                    id: baseEntry.value.id,
                    fieldKey: baseEntry.value.fieldKey,
                    fieldType: baseEntry.value.fieldType as FieldType,
                    kind: baseEntry.value.kind as ExtractedValueKind,
                    value: baseEntry.value.value as TypedValue | null,
                    canonicalEvidence: baseEntry.value.canonicalEvidence,
                    flags: baseEntry.value.flags as ValueFlag[],
                  }
                : null;

              const classification =
                carryoverCtx && baselineSnapshot
                  ? classifyChange(baselineSnapshot, next, carryoverCtx)
                  : { changeKind: 'new' as const, changeReason: null };

              const baseDecision = baseEntry?.currentReview?.decision as ReviewDecision | undefined;
              const carriedReviewId =
                baseEntry?.currentReview && baseDecision
                  ? decideCarry(classification, {
                      id: baseEntry.currentReview.id,
                      decision: baseDecision,
                    })
                  : null;

              const carriedReview =
                carriedReviewId &&
                baseEntry?.currentReview &&
                (baseDecision === 'approve' || baseDecision === 'correct')
                  ? {
                      decision: baseDecision,
                      correctedValue: baseEntry.currentReview.correctedValue as TypedValue | null,
                      note: baseEntry.currentReview.note,
                      carriedFromReviewId: carriedReviewId,
                    }
                  : null;

              return {
                fieldKey: next.fieldKey,
                fieldType: next.fieldType,
                kind: next.kind,
                value: next.kind === 'value' ? next.value : null,
                rawValue: next.rawValue,
                evidence: next.kind === 'value' ? next.evidence : null,
                attemptedQuote: next.kind === 'gap' ? next.attemptedQuote : null,
                canonicalEvidence: next.kind === 'value' ? next.canonicalEvidence : null,
                evidenceStart: next.evidenceStart,
                evidenceEnd: next.evidenceEnd,
                evidenceMatchCount: next.evidenceMatchCount,
                citedLine: next.citedLine,
                matchMode: next.matchMode,
                chunkIndex: next.chunkIndex,
                gapCode: next.kind === 'gap' ? next.gapCode : null,
                gapReason: next.kind === 'gap' ? next.gapReason : null,
                flags: [...next.flags],
                baselineValueId: baseEntry?.value.id ?? null,
                changeKind: classification.changeKind,
                changeReason: classification.changeReason,
                carriedReview,
              };
            });
          },
        }),
      );

      if (!finalized.ok) {
        return { status: 'aborted_fence', runId };
      }

      await this.onStageEvent?.('finalized', { versionId, runId });

      return {
        status: 'succeeded',
        runId,
        runNumber,
        pointerMoved: finalized.pointerMoved,
        pendingCount: finalized.pendingCount,
        insertedCount: finalized.insertedCount,
      };
    } catch (err) {
      if (err instanceof FenceLostError || runSignal.aborted) {
        // Fenced abort: stop silently, write nothing (spec §5.3)
        return { status: 'aborted_fence', runId };
      }

      if (err instanceof PermanentFailureError) {
        const didFail = await withTx(this.db, (tx) =>
          failRun(tx, versionId, runId, err.code, err.message),
        );
        if (!didFail) {
          return { status: 'aborted_fence', runId };
        }
        return {
          status: 'failed_permanent',
          runId,
          errorCode: err.code,
          message: err.message,
        };
      }

      if (err instanceof TransientReleaseError) {
        const didRelease = await withTx(this.db, (tx) =>
          releaseRun(tx, versionId, runId, err.code, err.backoffMs, err.message),
        );
        if (!didRelease) {
          return { status: 'aborted_fence', runId };
        }
        return {
          status: 'released_transient',
          runId,
          errorCode: err.code,
          message: err.message,
          backoffMs: err.backoffMs,
          rateLimitMs: err.rateLimitMs,
        };
      }

      // Unexpected crash (e.g., simulated chaos failure or bug): propagate without mutating lease
      // so the caller/crash test sees it and lease expiry / sweep recovers cleanly.
      throw err;
    } finally {
      heartbeatLoop.stop();
    }
  }

  private async fetchPdfBytes(storageKey: string, signal: AbortSignal): Promise<Buffer> {
    try {
      return await this.blobStore.getObject(storageKey, signal);
    } catch (err) {
      if (signal.aborted) {
        throw new FenceLostError('Storage read aborted by fence or shutdown');
      }
      if (err instanceof StorageError) {
        if (err.transient) {
          throw new TransientReleaseError('STORAGE_UNAVAILABLE', err.message, {
            backoffMs: this.defaultTransientBackoffMs,
            cause: err,
          });
        }
        throw new PermanentFailureError('STORAGE_UNAVAILABLE', err.message, err);
      }
      throw new TransientReleaseError(
        'STORAGE_UNAVAILABLE',
        err instanceof Error ? err.message : String(err),
        { backoffMs: this.defaultTransientBackoffMs, cause: err },
      );
    }
  }

  private async parsePdfBytes(pdfBytes: Buffer, signal: AbortSignal) {
    try {
      return await this.pdfParser.parse(pdfBytes, undefined, signal);
    } catch (err) {
      if (signal.aborted) {
        throw new FenceLostError('PDF parse aborted by fence or shutdown');
      }
      if (err instanceof PdfParseError) {
        throw new PermanentFailureError(err.code, err.message, err);
      }
      throw new PermanentFailureError(
        'PARSE_CRASHED',
        err instanceof Error ? err.message : String(err),
        err,
      );
    }
  }
}
