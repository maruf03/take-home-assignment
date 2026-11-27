import { heartbeat, type AppDatabase } from '@app/db';

export interface HeartbeatLoopOptions {
  readonly db: AppDatabase;
  readonly versionId: string;
  readonly runId: string;
  readonly leaseSeconds: number;
  readonly intervalMs: number;
  readonly onError?: (err: unknown) => void;
}

/**
 * Periodically extends `document_versions.lease_until` while a run is active.
 * If Postgres returns 0 rows (`heartbeat() === false`), the worker has lost its fencing token
 * (`active_run_id !== runId`) and the loop immediately aborts `signal` (spec §3, [I1]).
 */
export class HeartbeatLoop {
  private readonly controller = new AbortController();
  private readonly db: AppDatabase;
  private readonly versionId: string;
  private readonly runId: string;
  private readonly leaseSeconds: number;
  private readonly intervalMs: number;
  private readonly onError?: (err: unknown) => void;
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private stopped = false;

  constructor(options: HeartbeatLoopOptions) {
    this.db = options.db;
    this.versionId = options.versionId;
    this.runId = options.runId;
    this.leaseSeconds = options.leaseSeconds;
    this.intervalMs = Math.max(100, Math.trunc(options.intervalMs));
    this.onError = options.onError;
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  start(): void {
    if (this.timer || this.stopped) {
      return;
    }
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    this.timer.unref?.();
  }

  async tick(): Promise<boolean> {
    if (this.stopped || this.inFlight) {
      return !this.controller.signal.aborted;
    }
    this.inFlight = true;
    try {
      const stillOwner = await heartbeat(this.db, this.versionId, this.runId, this.leaseSeconds);
      if (!stillOwner && !this.stopped) {
        this.controller.abort(new Error('Fencing token lost during heartbeat'));
        this.stop();
        return false;
      }
      return stillOwner;
    } catch (err) {
      // Transient DB hiccup on a single heartbeat tick does not immediately claim fence loss;
      // the next tick or the next fenced SQL write will verify ownership.
      this.onError?.(err);
      return true;
    } finally {
      this.inFlight = false;
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
