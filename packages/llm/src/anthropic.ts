import Anthropic from '@anthropic-ai/sdk';
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

export interface AnthropicProviderOptions {
  readonly apiKey: string;
  readonly baseURL?: string;
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;

const STRICT_TOOL_MODEL_PREFIXES = [
  'claude-sonnet-5-5',
  'claude-haiku-5-5',
  'claude-opus-5-5',
  'claude-sonnet-4-5',
  'claude-haiku-4-5',
  'claude-opus-4-5',
];

function supportsStrictTools(model: string): boolean {
  return STRICT_TOOL_MODEL_PREFIXES.some(
    (prefix) => model === prefix || model.startsWith(`${prefix}-`),
  );
}

interface AnthropicRawMessage {
  id?: string;
  model?: string;
  stop_reason?: string | null;
  content?: Array<{
    type?: string;
    id?: string;
    name?: string;
    input?: unknown;
    text?: string;
  }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

function safeJsonParse(rawText: string): unknown {
  try {
    return JSON.parse(rawText);
  } catch {
    return rawText;
  }
}

function extractPreviousToolUse(
  previousRaw: unknown,
  toolName: string,
): { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> } {
  if (typeof previousRaw === 'object' && previousRaw !== null) {
    const msg = previousRaw as AnthropicRawMessage;
    const block = msg.content?.find((b) => b.type === 'tool_use');
    if (block && typeof block.id === 'string') {
      const inputObj =
        typeof block.input === 'object' && block.input !== null && !Array.isArray(block.input)
          ? (block.input as Record<string, unknown>)
          : {};
      return {
        type: 'tool_use',
        id: block.id,
        name: typeof block.name === 'string' ? block.name : toolName,
        input: inputObj,
      };
    }
  }
  return {
    type: 'tool_use',
    id: 'toolu_repair_fallback',
    name: toolName,
    input: {},
  };
}

/**
 * Pure parser converting verbatim Anthropic HTTP response JSON into `ExtractionResult`.
 * Shared between live `AnthropicProvider` and `CassetteProvider`.
 */
export function parseAnthropicRawResponse(
  rawText: string,
  providerRequestId: string | null,
  requestedModel: string,
  toolName: string,
  latencyMs: number,
): ExtractionResult {
  const raw = safeJsonParse(rawText);
  const body = (typeof raw === 'object' && raw !== null ? raw : {}) as AnthropicRawMessage;

  const usage: LlmUsage = {
    inputTokens: body.usage?.input_tokens ?? 0,
    outputTokens: body.usage?.output_tokens ?? 0,
    ...(body.usage?.cache_creation_input_tokens !== undefined
      ? { cacheCreationInputTokens: body.usage.cache_creation_input_tokens }
      : {}),
    ...(body.usage?.cache_read_input_tokens !== undefined
      ? { cacheReadInputTokens: body.usage.cache_read_input_tokens }
      : {}),
  };

  const stopReason = body.stop_reason ?? 'unknown';
  const servedModel = typeof body.model === 'string' ? body.model : null;

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

  if (stopReason === 'max_tokens') {
    return { ...base, kind: 'truncated' };
  }
  if (stopReason === 'refusal') {
    return { ...base, kind: 'refused' };
  }

  const toolUse = body.content?.find((b) => b.type === 'tool_use' && b.name === toolName);
  if (!toolUse) {
    return { ...base, kind: 'no_output' };
  }

  return {
    ...base,
    kind: 'ok',
    output: toolUse.input,
  };
}

function readHeader(headers: Headers | undefined, name: string): string | null {
  if (!headers) {
    return null;
  }
  return headers.get(name);
}

function mapAnthropicError(err: unknown): LlmError {
  if (err instanceof LlmError) {
    return err;
  }
  if (err instanceof Anthropic.APIUserAbortError) {
    return new LlmError('ABORTED', err.message, { transient: false, cause: err });
  }
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return new LlmError('TIMEOUT', err.message, { transient: true, cause: err });
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new LlmError('NETWORK', err.message, { transient: true, cause: err });
  }

  if (err instanceof Anthropic.APIError) {
    const status = err.status;
    const headers = err.headers;
    const shouldRetry = readHeader(headers, 'x-should-retry');

    if (status === 429) {
      const retryAfterMsHeader = readHeader(headers, 'retry-after-ms');
      const retryAfterHeader = readHeader(headers, 'retry-after');
      const retryAfterMs = retryAfterMsHeader
        ? parseRetryDelayMs(`${retryAfterMsHeader}ms`)
        : parseRetryDelayMs(retryAfterHeader);

      if (retryAfterMs === undefined) {
        return new LlmError('RATE_CAPPED', err.message, {
          transient: false,
          status,
          raw: err.error,
          cause: err,
        });
      }
      return new LlmError('RATE_LIMITED', err.message, {
        transient: true,
        retryAfterMs,
        status,
        raw: err.error,
        cause: err,
      });
    }

    if (status === 529) {
      return new LlmError('OVERLOADED', err.message, {
        transient: shouldRetry !== 'false',
        status,
        raw: err.error,
        cause: err,
      });
    }

    if (status !== undefined && status >= 500) {
      return new LlmError('SERVER', err.message, {
        transient: shouldRetry !== 'false',
        status,
        raw: err.error,
        cause: err,
      });
    }

    if (status === 401 || status === 403) {
      return new LlmError('AUTH', err.message, {
        transient: false,
        status,
        raw: err.error,
        cause: err,
      });
    }

    if (status === 404) {
      return new LlmError('MODEL_NOT_FOUND', err.message, {
        transient: false,
        status,
        raw: err.error,
        cause: err,
      });
    }

    return new LlmError('BAD_REQUEST', err.message, {
      transient: false,
      status,
      raw: err.error,
      cause: err,
    });
  }

  const msg = err instanceof Error ? err.message : String(err);
  return new LlmError('NETWORK', msg, { transient: true, cause: err });
}

export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic';
  readonly capabilities: LlmCapabilities = Object.freeze({
    constrainedSchema: true,
    promptCaching: true,
    maxInputTokens: 200_000,
    maxOutputTokens: 64_000,
  });

  private readonly client: Anthropic;
  private readonly timeoutMs: number;

  constructor(options: AnthropicProviderOptions) {
    if (!options.apiKey || options.apiKey.trim().length === 0) {
      throw new LlmError('NOT_CONFIGURED', 'ANTHROPIC_API_KEY is not configured', {
        transient: false,
      });
    }
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.client = new Anthropic({
      apiKey: options.apiKey,
      ...(options.baseURL ? { baseURL: options.baseURL } : {}),
      maxRetries: 0,
      timeout: this.timeoutMs,
    });
  }

  estimateCostUsd(usage: LlmUsage, model: string, servedModel?: string | null): number {
    return estimateCostUsd(usage, model, servedModel);
  }

  async extract(req: ExtractionRequest): Promise<ExtractionResult> {
    const startMs = Date.now();

    const tool: Anthropic.Tool & { strict?: boolean } = {
      name: req.toolName,
      description: 'Record extracted document fields with verbatim evidence quotes.',
      input_schema: req.schema as Anthropic.Tool.InputSchema,
      ...(supportsStrictTools(req.model) ? { strict: true } : {}),
      cache_control: { type: 'ephemeral' },
    };

    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: req.user }];
    if (req.repair) {
      const prevToolUse = extractPreviousToolUse(req.repair.previousRaw, req.toolName);
      messages.push(
        { role: 'assistant', content: [prevToolUse] },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: prevToolUse.id,
              is_error: true,
              content: formatRepairFeedback(req.repair.errors),
            },
          ],
        },
      );
    }

    try {
      // Must use `.asResponse()` (never `.withResponse()`) so the verbatim raw body can be read (spec §5.3).
      const httpRes = await this.client.messages
        .create(
          {
            model: req.model,
            max_tokens: req.maxOutputTokens,
            system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
            tools: [tool],
            tool_choice: { type: 'tool', name: req.toolName },
            messages,
          },
          {
            signal: req.signal,
            timeout: this.timeoutMs,
          },
        )
        .asResponse();

      const rawText = await httpRes.text();
      const providerRequestId = httpRes.headers.get('request-id');
      const latencyMs = Date.now() - startMs;

      return parseAnthropicRawResponse(
        rawText,
        providerRequestId,
        req.model,
        req.toolName,
        latencyMs,
      );
    } catch (err) {
      throw mapAnthropicError(err);
    }
  }
}
