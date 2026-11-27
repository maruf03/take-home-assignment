import { LlmError } from './errors.js';
import { estimateCostUsd } from './pricing.js';
import type {
  ExtractionRequest,
  ExtractionResult,
  LlmCapabilities,
  LlmProvider,
  LlmUsage,
} from './provider.js';

export type FakeScriptEntry =
  | {
      readonly kind: 'ok';
      readonly output: unknown;
      readonly usage?: Partial<LlmUsage>;
      readonly stopReason?: string;
      readonly servedModel?: string | null;
      readonly providerRequestId?: string | null;
      readonly delayMs?: number;
    }
  | {
      readonly kind: 'truncated' | 'refused' | 'no_output' | 'schema_invalid';
      readonly rawText?: string;
      readonly usage?: Partial<LlmUsage>;
      readonly stopReason?: string;
      readonly parseError?: string;
      readonly delayMs?: number;
    }
  | LlmError
  | ((req: ExtractionRequest, callIndex: number) => Promise<ExtractionResult> | ExtractionResult);

export interface FakeLlmProviderOptions {
  readonly script?: readonly FakeScriptEntry[];
  readonly defaultOutput?: unknown;
}

function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new LlmError('ABORTED', 'Fake LLM request aborted', { transient: false }));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new LlmError('ABORTED', 'Fake LLM request aborted', { transient: false }));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Deterministic scenario-driven fake LLM provider for unit/integration tests (APP_ENV=test only).
 */
export class FakeLlmProvider implements LlmProvider {
  readonly name = 'fake';
  readonly capabilities: LlmCapabilities = Object.freeze({
    constrainedSchema: true,
    promptCaching: false,
    maxInputTokens: 1_000_000,
    maxOutputTokens: 65_536,
  });

  readonly calls: ExtractionRequest[] = [];
  private readonly script: FakeScriptEntry[];
  private readonly defaultOutput: unknown;
  private callCursor = 0;

  constructor(options: FakeLlmProviderOptions = {}) {
    this.script = [...(options.script ?? [])];
    this.defaultOutput = options.defaultOutput ?? {
      fields: {},
      document_flags: { suspicious_instructions: false, spans: [] },
    };
  }

  enqueue(...entries: FakeScriptEntry[]): void {
    this.script.push(...entries);
  }

  estimateCostUsd(usage: LlmUsage, model: string, servedModel?: string | null): number {
    return estimateCostUsd(usage, model, servedModel);
  }

  async extract(req: ExtractionRequest): Promise<ExtractionResult> {
    const startMs = Date.now();
    const callIndex = this.callCursor++;
    this.calls.push(req);

    if (req.signal?.aborted) {
      throw new LlmError('ABORTED', 'Fake LLM request aborted', { transient: false });
    }

    const entry = this.script[callIndex];
    if (!entry) {
      const rawText = JSON.stringify(this.defaultOutput);
      return {
        kind: 'ok',
        output: this.defaultOutput,
        rawText,
        raw: this.defaultOutput,
        usage: { inputTokens: 100, outputTokens: 50 },
        stopReason: 'STOP',
        latencyMs: Date.now() - startMs,
        model: req.model,
        servedModel: 'fake',
        providerRequestId: `fake-${callIndex + 1}`,
      };
    }

    if (entry instanceof LlmError) {
      throw entry;
    }

    if (typeof entry === 'function') {
      return await entry(req, callIndex);
    }

    if (entry.delayMs && entry.delayMs > 0) {
      await sleepWithAbort(entry.delayMs, req.signal);
    }

    const usage: LlmUsage = {
      inputTokens: entry.usage?.inputTokens ?? 100,
      outputTokens: entry.usage?.outputTokens ?? 50,
      ...(entry.usage?.cacheCreationInputTokens !== undefined
        ? { cacheCreationInputTokens: entry.usage.cacheCreationInputTokens }
        : {}),
      ...(entry.usage?.cacheReadInputTokens !== undefined
        ? { cacheReadInputTokens: entry.usage.cacheReadInputTokens }
        : {}),
    };

    const latencyMs = Date.now() - startMs;

    if (entry.kind === 'ok') {
      const rawText = JSON.stringify(entry.output);
      return {
        kind: 'ok',
        output: entry.output,
        rawText,
        raw: entry.output,
        usage,
        stopReason: entry.stopReason ?? 'STOP',
        latencyMs,
        model: req.model,
        servedModel: entry.servedModel ?? 'fake',
        providerRequestId: entry.providerRequestId ?? `fake-${callIndex + 1}`,
      };
    }

    const rawText = entry.rawText ?? '';
    return {
      kind: entry.kind,
      rawText,
      raw: rawText,
      usage,
      stopReason: entry.stopReason ?? entry.kind.toUpperCase(),
      latencyMs,
      model: req.model,
      servedModel: 'fake',
      providerRequestId: `fake-${callIndex + 1}`,
      ...(entry.parseError ? { parseError: entry.parseError } : {}),
    };
  }
}
