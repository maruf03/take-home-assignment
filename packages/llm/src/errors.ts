export const LLM_ERROR_CODES = [
  'RATE_LIMITED',
  'RATE_CAPPED',
  'OVERLOADED',
  'SERVER',
  'TIMEOUT',
  'NETWORK',
  'AUTH',
  'BAD_REQUEST',
  'MODEL_NOT_FOUND',
  'NOT_CONFIGURED',
  'ABORTED',
] as const;

export type LlmErrorCode = (typeof LLM_ERROR_CODES)[number];

export interface LlmErrorOptions {
  transient: boolean;
  retryAfterMs?: number;
  status?: number;
  raw?: unknown;
  cause?: unknown;
}

export class LlmError extends Error {
  readonly code: LlmErrorCode;
  readonly transient: boolean;
  readonly retryAfterMs?: number;
  readonly status?: number;
  readonly raw?: unknown;

  constructor(code: LlmErrorCode, message: string, options: LlmErrorOptions) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'LlmError';
    this.code = code;
    this.transient = options.transient;
    this.retryAfterMs = options.retryAfterMs;
    this.status = options.status;
    this.raw = options.raw;
  }
}

/**
 * Parses Retry-After / retry-after-ms / Google RetryInfo.retryDelay (`"39s"`, `"39.97s"`, `"1500ms"`,
 * integer seconds, or HTTP-date) into non-negative milliseconds.
 */
export function parseRetryDelayMs(raw: string | null | undefined): number | undefined {
  if (!raw) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  const msMatch = /^(\d+(?:\.\d+)?)ms$/i.exec(trimmed);
  if (msMatch?.[1]) {
    const val = Number(msMatch[1]);
    return Number.isFinite(val) && val >= 0 ? Math.ceil(val) : undefined;
  }

  const secMatch = /^(\d+(?:\.\d+)?)s$/i.exec(trimmed);
  if (secMatch?.[1]) {
    const val = Number(secMatch[1]);
    return Number.isFinite(val) && val >= 0 ? Math.ceil(val * 1000) : undefined;
  }

  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const val = Number(trimmed);
    return Number.isFinite(val) && val >= 0 ? Math.ceil(val * 1000) : undefined;
  }

  const dateMs = Date.parse(trimmed);
  if (Number.isFinite(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }

  return undefined;
}
