import { LlmError, type LlmErrorCode } from './errors.js';
import { estimateCostUsd } from './pricing.js';
import type {
  ExtractionRequest,
  ExtractionResult,
  LlmCapabilities,
  LlmProvider,
  LlmUsage,
} from './provider.js';

export interface FakeIpcLlmProviderOptions {
  readonly endpoint: string;
}

interface FakeIpcResponsePayload {
  type: 'result' | 'error';
  result?: ExtractionResult;
  error?: {
    code: LlmErrorCode;
    message: string;
    transient: boolean;
    retryAfterMs?: number;
    status?: number;
  };
}

/**
 * Cross-process HTTP IPC fake LLM provider for integration/chaos tests (APP_ENV=test only).
 * Posts the extraction request to a local test harness HTTP controller that can latch, fault-inject,
 * or return scripted responses across separate API/worker processes.
 */
export class FakeIpcLlmProvider implements LlmProvider {
  readonly name = 'fake-ipc';
  readonly capabilities: LlmCapabilities = Object.freeze({
    constrainedSchema: true,
    promptCaching: false,
    maxInputTokens: 1_000_000,
    maxOutputTokens: 65_536,
  });

  private readonly endpoint: string;

  constructor(options: FakeIpcLlmProviderOptions) {
    if (!options.endpoint || options.endpoint.trim().length === 0) {
      throw new LlmError('BAD_REQUEST', 'FakeIpcLlmProvider requires a non-empty endpoint URL', {
        transient: false,
      });
    }
    this.endpoint = options.endpoint;
  }

  estimateCostUsd(usage: LlmUsage, model: string, servedModel?: string | null): number {
    return estimateCostUsd(usage, model, servedModel);
  }

  async extract(req: ExtractionRequest): Promise<ExtractionResult> {
    if (req.signal?.aborted) {
      throw new LlmError('ABORTED', 'Fake IPC LLM request aborted', { transient: false });
    }

    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          system: req.system,
          user: req.user,
          schema: req.schema,
          toolName: req.toolName,
          model: req.model,
          maxOutputTokens: req.maxOutputTokens,
          cacheKey: req.cacheKey,
          repair: req.repair,
        }),
        signal: req.signal,
      });
    } catch (err) {
      if (req.signal?.aborted) {
        throw new LlmError('ABORTED', 'Fake IPC LLM request aborted', {
          transient: false,
          cause: err,
        });
      }
      throw new LlmError(
        'NETWORK',
        err instanceof Error ? err.message : 'Fake IPC request failed',
        { transient: true, cause: err },
      );
    }

    if (!response.ok) {
      throw new LlmError('SERVER', `Fake IPC server returned HTTP ${response.status}`, {
        transient: response.status >= 500,
        status: response.status,
      });
    }

    let payload: FakeIpcResponsePayload;
    try {
      payload = (await response.json()) as FakeIpcResponsePayload;
    } catch (err) {
      if (req.signal?.aborted) {
        throw new LlmError('ABORTED', 'Fake IPC LLM request aborted', {
          transient: false,
          cause: err,
        });
      }
      throw new LlmError(
        'NETWORK',
        err instanceof Error ? err.message : 'Failed to parse fake-ipc response body',
        { transient: true, cause: err },
      );
    }
    if (payload.type === 'error' && payload.error) {
      throw new LlmError(payload.error.code, payload.error.message, {
        transient: payload.error.transient,
        retryAfterMs: payload.error.retryAfterMs,
        status: payload.error.status,
      });
    }
    if (payload.type === 'result' && payload.result) {
      return payload.result;
    }
    throw new LlmError('SERVER', 'Malformed response from fake-ipc controller', {
      transient: false,
    });
  }
}
