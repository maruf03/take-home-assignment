import { GoogleGenAI, type Content } from '@google/genai';
import { LlmError, parseRetryDelayMs } from './errors.js';
import { estimateCostUsd } from './pricing.js';
import {
  formatRepairFeedback,
  type ExtractionRequest,
  type ExtractionResult,
  type LlmCapabilities,
  type LlmProvider,
  type LlmUsage,
} from './provider.js';

export interface GeminiProviderOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;

const GEMINI_REFUSAL_REASONS: ReadonlySet<string> = new Set([
  'SAFETY',
  'RECITATION',
  'PROHIBITED_CONTENT',
  'BLOCKLIST',
  'SPII',
  'IMAGE_SAFETY',
]);

interface GeminiRawBody {
  candidates?: Array<{
    content?: {
      role?: string;
      parts?: Array<{ text?: string }>;
    };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    cachedContentTokenCount?: number;
    totalTokenCount?: number;
  };
  modelVersion?: string;
  responseId?: string;
  error?: {
    code?: number;
    status?: string;
    message?: string;
    details?: Array<Record<string, unknown>>;
  };
}

function safeJsonParse(rawText: string): unknown {
  try {
    return JSON.parse(rawText);
  } catch {
    return rawText;
  }
}

function extractPreviousModelText(previousRaw: unknown): string {
  if (typeof previousRaw === 'string') {
    return previousRaw;
  }
  if (typeof previousRaw === 'object' && previousRaw !== null) {
    const body = previousRaw as GeminiRawBody;
    const parts = body.candidates?.[0]?.content?.parts;
    if (Array.isArray(parts)) {
      const joined = parts.map((p) => p.text ?? '').join('');
      if (joined.length > 0) {
        return joined;
      }
    }
    return JSON.stringify(previousRaw);
  }
  return '';
}

/**
 * Pure parser converting verbatim Gemini HTTP response JSON into `ExtractionResult`.
 * Shared between live `GeminiProvider` and `CassetteProvider` so replay tests exercise
 * the exact production adapter mapping (Core Task 6).
 */
export function parseGeminiRawResponse(
  rawText: string,
  requestedModel: string,
  latencyMs: number,
): ExtractionResult {
  const raw = safeJsonParse(rawText);
  const body = (typeof raw === 'object' && raw !== null ? raw : {}) as GeminiRawBody;

  const usage: LlmUsage = {
    inputTokens: body.usageMetadata?.promptTokenCount ?? 0,
    outputTokens: body.usageMetadata?.candidatesTokenCount ?? 0,
    ...(body.usageMetadata?.cachedContentTokenCount !== undefined
      ? { cacheReadInputTokens: body.usageMetadata.cachedContentTokenCount }
      : {}),
    ...(body.usageMetadata?.totalTokenCount !== undefined
      ? { totalTokens: body.usageMetadata.totalTokenCount }
      : {}),
  };

  const servedModel = typeof body.modelVersion === 'string' ? body.modelVersion : null;
  const providerRequestId = typeof body.responseId === 'string' ? body.responseId : null;
  const candidate = body.candidates?.[0];
  const stopReason = candidate?.finishReason ?? 'UNKNOWN';

  const base = {
    rawText,
    raw,
    usage,
    stopReason,
    latencyMs,
    model: requestedModel,
    servedModel,
    providerRequestId,
  };

  if (!candidate) {
    return { ...base, kind: 'no_output' };
  }
  if (stopReason === 'MAX_TOKENS') {
    return { ...base, kind: 'truncated' };
  }
  if (GEMINI_REFUSAL_REASONS.has(stopReason)) {
    return { ...base, kind: 'refused' };
  }

  const text = (candidate.content?.parts ?? []).map((p) => p.text ?? '').join('');
  if (text.trim().length === 0) {
    return { ...base, kind: 'no_output' };
  }

  try {
    const output = JSON.parse(text);
    return { ...base, kind: 'ok', output };
  } catch (err) {
    return {
      ...base,
      kind: 'schema_invalid',
      parseError: err instanceof Error ? err.message : 'Invalid JSON in Gemini candidate text',
    };
  }
}

/**
 * Maps Gemini HTTP error responses into typed `LlmError` (spec §15.4 & §15.5).
 */
export function mapGeminiHttpError(status: number, rawText: string, headers?: Headers): LlmError {
  const raw = safeJsonParse(rawText);
  const body = (typeof raw === 'object' && raw !== null ? raw : {}) as GeminiRawBody;
  const message = body.error?.message ?? `Gemini API error (HTTP ${status})`;
  const details = Array.isArray(body.error?.details) ? body.error.details : [];

  if (status === 429) {
    let isDailyQuota = /daily|per.?day/i.test(message);
    let isMinuteQuota = /per.?minute/i.test(message);
    let retryAfterMs: number | undefined;

    for (const detail of details) {
      const typeStr = String(detail['@type'] ?? '');
      if (typeStr.includes('QuotaFailure') && Array.isArray(detail['violations'])) {
        for (const v of detail['violations'] as Array<Record<string, unknown>>) {
          const quotaId = String(v['quotaId'] ?? '');
          if (/PerDay/i.test(quotaId)) {
            isDailyQuota = true;
          }
          if (/PerMinute/i.test(quotaId)) {
            isMinuteQuota = true;
          }
        }
      }
      if (typeStr.includes('RetryInfo') && typeof detail['retryDelay'] === 'string') {
        retryAfterMs = parseRetryDelayMs(detail['retryDelay']);
      }
    }

    if (retryAfterMs === undefined && headers) {
      retryAfterMs = parseRetryDelayMs(headers.get('retry-after'));
    }

    if (retryAfterMs === undefined && isMinuteQuota) {
      const msgDelay = /retry\s+in\s+(\d+(?:\.\d+)?s)/i.exec(message);
      if (msgDelay?.[1]) {
        retryAfterMs = parseRetryDelayMs(msgDelay[1]);
      }
    }

    if (isDailyQuota || retryAfterMs === undefined) {
      return new LlmError('RATE_CAPPED', message, { transient: false, status, raw });
    }

    return new LlmError('RATE_LIMITED', message, {
      transient: true,
      retryAfterMs,
      status,
      raw,
    });
  }

  if (status === 503) {
    return new LlmError('OVERLOADED', message, { transient: true, status, raw });
  }
  if (status === 504) {
    return new LlmError('TIMEOUT', message, { transient: true, status, raw });
  }
  if (status >= 500) {
    return new LlmError('SERVER', message, { transient: true, status, raw });
  }
  if (status === 401 || status === 403) {
    return new LlmError('AUTH', message, { transient: false, status, raw });
  }
  if (status === 404) {
    return new LlmError('MODEL_NOT_FOUND', message, { transient: false, status, raw });
  }
  return new LlmError('BAD_REQUEST', message, { transient: false, status, raw });
}

export class GeminiProvider implements LlmProvider {
  readonly name = 'gemini';
  readonly capabilities: LlmCapabilities = Object.freeze({
    constrainedSchema: true,
    promptCaching: false,
    maxInputTokens: 1_000_000,
    maxOutputTokens: 65_536,
  });

  private readonly ai: GoogleGenAI;
  private readonly baseUrl?: string;
  private readonly timeoutMs: number;

  constructor(options: GeminiProviderOptions) {
    if (!options.apiKey || options.apiKey.trim().length === 0) {
      throw new LlmError('NOT_CONFIGURED', 'GEMINI_API_KEY is not configured', {
        transient: false,
      });
    }
    this.baseUrl = options.baseUrl;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.ai = new GoogleGenAI({
      apiKey: options.apiKey,
      httpOptions: {
        ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
        timeout: this.timeoutMs,
        retryOptions: { attempts: 1 },
      },
    });
  }

  estimateCostUsd(usage: LlmUsage, model: string, servedModel?: string | null): number {
    return estimateCostUsd(usage, model, servedModel);
  }

  async extract(req: ExtractionRequest): Promise<ExtractionResult> {
    const startMs = Date.now();
    let capturedRawText: string | null = null;
    let capturedStatus: number | null = null;
    let capturedHeaders: Headers | undefined;

    const capturingFetch: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      capturedStatus = response.status;
      capturedHeaders = response.headers;
      capturedRawText = await response.clone().text();
      return response;
    };

    const contents: Content[] = [{ role: 'user', parts: [{ text: req.user }] }];
    if (req.repair) {
      contents.push(
        { role: 'model', parts: [{ text: extractPreviousModelText(req.repair.previousRaw) }] },
        { role: 'user', parts: [{ text: formatRepairFeedback(req.repair.errors) }] },
      );
    }

    try {
      const response = await this.ai.models.generateContent({
        model: req.model,
        contents,
        config: {
          systemInstruction: req.system,
          temperature: 0,
          maxOutputTokens: req.maxOutputTokens,
          responseMimeType: 'application/json',
          responseJsonSchema: req.schema,
          thinkingConfig: { thinkingBudget: 0 },
          ...(req.signal ? { abortSignal: req.signal } : {}),
          httpOptions: {
            ...(this.baseUrl ? { baseUrl: this.baseUrl } : {}),
            timeout: this.timeoutMs,
            retryOptions: { attempts: 1 },
            fetch: capturingFetch,
          },
        },
      });

      const latencyMs = Date.now() - startMs;
      const rawText = capturedRawText ?? JSON.stringify(response);
      return parseGeminiRawResponse(rawText, req.model, latencyMs);
    } catch (err) {
      if (err instanceof LlmError) {
        throw err;
      }
      if (req.signal?.aborted) {
        throw new LlmError('ABORTED', 'Gemini request aborted by caller signal', {
          transient: false,
          cause: err,
        });
      }
      if (capturedStatus !== null && capturedStatus >= 400) {
        throw mapGeminiHttpError(capturedStatus, capturedRawText ?? '', capturedHeaders);
      }
      const errName = err instanceof Error ? err.name : '';
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errName === 'TimeoutError' || /timeout|timed out/i.test(errMsg)) {
        throw new LlmError('TIMEOUT', errMsg, { transient: true, cause: err });
      }
      if (errName === 'AbortError') {
        throw new LlmError('ABORTED', errMsg, { transient: false, cause: err });
      }
      throw new LlmError('NETWORK', errMsg, { transient: true, cause: err });
    }
  }
}
