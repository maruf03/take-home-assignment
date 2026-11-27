export type LlmProviderName = 'gemini' | 'anthropic' | 'fake' | 'fake-ipc' | 'cassette';

export const TEST_ONLY_PROVIDERS: ReadonlySet<LlmProviderName> = new Set([
  'fake',
  'fake-ipc',
  'cassette',
]);

export interface LlmCapabilities {
  readonly constrainedSchema: boolean;
  readonly promptCaching: boolean;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
}

export interface LlmUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheCreationInputTokens?: number;
  readonly cacheReadInputTokens?: number;
  readonly totalTokens?: number;
}

export interface ExtractionRepairError {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

export interface ExtractionRepairInput {
  readonly previousRaw: unknown;
  readonly errors: readonly ExtractionRepairError[];
}

export interface ExtractionRequest {
  readonly system: string;
  readonly user: string;
  readonly schema: Record<string, unknown>;
  readonly toolName: string;
  readonly model: string;
  readonly maxOutputTokens: number;
  readonly cacheKey: string;
  readonly promptVersion?: string;
  readonly signal?: AbortSignal;
  readonly repair?: ExtractionRepairInput;
}

export interface ExtractionResultBase {
  readonly rawText: string;
  readonly raw: unknown;
  readonly usage: LlmUsage;
  readonly stopReason: string;
  readonly latencyMs: number;
  readonly model: string;
  readonly servedModel: string | null;
  readonly providerRequestId: string | null;
}

export type ExtractionResult =
  | (ExtractionResultBase & {
      readonly kind: 'ok';
      readonly output: unknown;
    })
  | (ExtractionResultBase & {
      readonly kind: 'truncated' | 'refused' | 'no_output' | 'schema_invalid';
      readonly parseError?: string;
    });

export interface LlmProvider {
  readonly name: string;
  readonly capabilities: LlmCapabilities;
  extract(req: ExtractionRequest): Promise<ExtractionResult>;
  estimateCostUsd(usage: LlmUsage, model: string, servedModel?: string | null): number;
}

export interface LimiterConfig {
  readonly max: number;
  readonly duration: number;
}

/**
 * Formats fixed error codes and paths only for the single LLM repair turn (spec §5.3 step 4).
 */
export function formatRepairFeedback(errors: readonly ExtractionRepairError[]): string {
  const lines = errors.map((e) => `- ${e.path}: [${e.code}] ${e.message}`);
  return [
    'Your previous response failed schema validation. Return a corrected response matching the schema strictly.',
    'Validation errors (fixed codes and paths):',
    ...lines,
  ].join('\n');
}

/**
 * Resolves BullMQ queue limiter settings. Always returns positive integers because BullMQ's
 * counter is integer-only (a fractional `max` stalls every job, spec §5.3 & §15.5).
 */
export function resolveLimiterConfig(
  provider: LlmProviderName,
  overrides?: { max?: number; duration?: number },
): LimiterConfig {
  const isTestProvider = TEST_ONLY_PROVIDERS.has(provider);
  const defaultMax = isTestProvider ? 100 : 1;
  const defaultDuration = isTestProvider ? 1_000 : 12_000;

  const rawMax = overrides?.max ?? defaultMax;
  const rawDuration = overrides?.duration ?? defaultDuration;

  return {
    max: Math.max(1, Math.trunc(Number.isFinite(rawMax) ? rawMax : defaultMax)),
    duration: Math.max(1, Math.trunc(Number.isFinite(rawDuration) ? rawDuration : defaultDuration)),
  };
}
