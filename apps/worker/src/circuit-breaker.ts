export interface LlmCircuitBreakerOptions {
  readonly failureThreshold?: number;
  readonly openDurationMs?: number;
  readonly now?: () => number;
}

export interface CircuitFailureResult {
  readonly opened: boolean;
  readonly openDurationMs: number;
  readonly consecutiveFailures: number;
}

/**
 * In-process circuit breaker for transient LLM failures (spec §5.3):
 * opens after 5 consecutive transient failures for 30s, applied through BullMQ `worker.rateLimit`.
 */
export class LlmCircuitBreaker {
  private readonly failureThreshold: number;
  private readonly openDurationMs: number;
  private readonly now: () => number;
  private _consecutiveFailures = 0;
  private openUntilMs = 0;

  constructor(options: LlmCircuitBreakerOptions = {}) {
    this.failureThreshold = Math.max(1, Math.trunc(options.failureThreshold ?? 5));
    this.openDurationMs = Math.max(1, Math.trunc(options.openDurationMs ?? 30_000));
    this.now = options.now ?? (() => Date.now());
  }

  get consecutiveFailures(): number {
    return this._consecutiveFailures;
  }

  recordSuccess(): void {
    this._consecutiveFailures = 0;
    this.openUntilMs = 0;
  }

  recordTransientFailure(): CircuitFailureResult {
    this._consecutiveFailures += 1;
    if (this._consecutiveFailures >= this.failureThreshold) {
      this.openUntilMs = this.now() + this.openDurationMs;
      this._consecutiveFailures = 0;
      return {
        opened: true,
        openDurationMs: this.openDurationMs,
        consecutiveFailures: this.failureThreshold,
      };
    }
    return {
      opened: false,
      openDurationMs: 0,
      consecutiveFailures: this._consecutiveFailures,
    };
  }

  getRemainingOpenMs(): number {
    return Math.max(0, this.openUntilMs - this.now());
  }
}
