import { existsSync } from 'node:fs';
import { Tinypool } from 'tinypool';
import { classifyChildError, PdfParseError } from './errors.js';
import { resolvePdfParseLimits, type PdfParseLimits, type PdfParseResult } from './line-builder.js';
import {
  DEFAULT_MAX_RSS_BYTES,
  DEFAULT_WATCHDOG_POLL_MS,
  RssWatchdog,
  type WatchdogWorkerRef,
} from './watchdog.js';

export interface PdfParser {
  parse(
    bytes: Uint8Array,
    limits?: Partial<PdfParseLimits>,
    signal?: AbortSignal,
  ): Promise<PdfParseResult>;
  close(): Promise<void>;
}

export interface PdfParserPoolOptions {
  minThreads?: number;
  maxThreads?: number;
  maxOldSpaceSizeMb?: number;
  maxRssBytes?: number;
  watchdogPollMs?: number;
  recycleAfterParses?: number;
  childFilename?: string;
  onWatchdogKill?: (pid: number, rssBytes: number) => void;
}

const DEFAULT_POOL_SIZE = 2;
const DEFAULT_MAX_OLD_SPACE_MB = 512;
const DEFAULT_RECYCLE_AFTER_PARSES = 50;

function resolveChildWorkerUrl(): string {
  const siblingJs = new URL('./child.js', import.meta.url);
  if (existsSync(siblingJs)) {
    return siblingJs.href;
  }
  const distJs = new URL('../dist/child.js', import.meta.url);
  if (existsSync(distJs)) {
    return distJs.href;
  }
  return siblingJs.href;
}

function isUnexpectedWorkerExitError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  return /worker exited unexpectedly|terminated/i.test(err.message);
}

interface WorkerSlot {
  readonly pool: Tinypool;
  busy: boolean;
  watchdogKilled: boolean;
  parsesSinceRecycle: number;
}

interface SlotWaiter {
  resolve: (slot: WorkerSlot) => void;
  reject: (err: unknown) => void;
  cleanup: () => void;
}

/**
 * Isolated child-process PDF parsing pool backed by per-slot Tinypool workers + RSS watchdog (spec §5.1).
 * - Each slot runs 1 dedicated `child_process` worker (`serialization: 'advanced'`, `env: {}`,
 *   `--max-old-space-size=512`), eliminating cross-task watchdog kill misattribution and recycling starvation.
 * - Per-task timeout via AbortController (30s default), composable with caller AbortSignal.
 * - RSS watchdog polls `/proc/<pid>/status` VmRSS (250ms default, 768 MB cap) and tags the exact killed slot.
 * - Each slot recycles its child process every 50 parses cleanly between tasks.
 */
export class PdfParserPool implements PdfParser {
  private readonly slots: WorkerSlot[];
  private readonly waiters: SlotWaiter[] = [];
  private readonly watchdog: RssWatchdog;
  private readonly recycleAfterParses: number;
  private closed = false;
  private closingPromise: Promise<void> | null = null;

  constructor(options: PdfParserPoolOptions = {}) {
    const slotCount = Math.max(1, Math.trunc(options.maxThreads ?? DEFAULT_POOL_SIZE));
    const maxOldSpaceSizeMb = Math.max(
      128,
      Math.trunc(options.maxOldSpaceSizeMb ?? DEFAULT_MAX_OLD_SPACE_MB),
    );
    this.recycleAfterParses = Math.max(
      1,
      Math.trunc(options.recycleAfterParses ?? DEFAULT_RECYCLE_AFTER_PARSES),
    );
    const filename = options.childFilename ?? resolveChildWorkerUrl();

    this.slots = Array.from({ length: slotCount }, () => ({
      pool: new Tinypool({
        filename,
        runtime: 'child_process',
        minThreads: 1,
        maxThreads: 1,
        isolateWorkers: false,
        execArgv: [`--max-old-space-size=${maxOldSpaceSizeMb}`],
        env: {},
        serialization: 'advanced',
      }),
      busy: false,
      watchdogKilled: false,
      parsesSinceRecycle: 0,
    }));

    this.watchdog = new RssWatchdog({
      pollIntervalMs: options.watchdogPollMs ?? DEFAULT_WATCHDOG_POLL_MS,
      maxRssBytes: options.maxRssBytes ?? DEFAULT_MAX_RSS_BYTES,
      getWorkers: (): readonly WatchdogWorkerRef[] =>
        this.slots.flatMap((slot) => slot.pool.threads),
      onBeforeKill: (pid, rssBytes) => {
        for (const slot of this.slots) {
          if (slot.pool.threads.some((t) => t.threadId === pid)) {
            slot.watchdogKilled = true;
            break;
          }
        }
        options.onWatchdogKill?.(pid, rssBytes);
      },
    });
    this.watchdog.start();
  }

  /**
   * Returns active child-process PIDs currently managed by the pool (useful for observability & tests).
   */
  getWorkerPids(): number[] {
    return this.slots
      .flatMap((slot) => slot.pool.threads)
      .map((t) => t.threadId)
      .filter((pid) => pid > 0);
  }

  private acquireSlot(signal: AbortSignal): Promise<WorkerSlot> {
    if (this.closed) {
      return Promise.reject(new PdfParseError('PARSE_CRASHED', 'PdfParserPool has been closed'));
    }
    if (signal.aborted) {
      return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    }

    const idle = this.slots.find((s) => !s.busy);
    if (idle) {
      idle.busy = true;
      return Promise.resolve(idle);
    }

    return new Promise<WorkerSlot>((resolve, reject) => {
      const onAbort = (): void => {
        const idx = this.waiters.indexOf(waiter);
        if (idx !== -1) {
          this.waiters.splice(idx, 1);
        }
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      };
      const waiter: SlotWaiter = {
        resolve: (slot) => {
          signal.removeEventListener('abort', onAbort);
          resolve(slot);
        },
        reject: (err) => {
          signal.removeEventListener('abort', onAbort);
          reject(err);
        },
        cleanup: () => {
          signal.removeEventListener('abort', onAbort);
        },
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  private releaseSlot(slot: WorkerSlot): void {
    if (this.closed) {
      slot.busy = false;
      return;
    }
    const next = this.waiters.shift();
    if (next) {
      next.resolve(slot);
      return;
    }
    slot.busy = false;
  }

  async parse(
    bytes: Uint8Array,
    limits?: Partial<PdfParseLimits>,
    signal?: AbortSignal,
  ): Promise<PdfParseResult> {
    if (this.closed) {
      throw new PdfParseError('PARSE_CRASHED', 'PdfParserPool has been closed');
    }
    if (signal?.aborted) {
      throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    }

    const resolvedLimits = resolvePdfParseLimits(limits);
    const timeoutController = new AbortController();
    const timer = setTimeout(() => {
      timeoutController.abort(
        new PdfParseError(
          'PARSE_TIMEOUT',
          `PDF parsing exceeded timeout of ${resolvedLimits.timeoutMs}ms`,
          { timeoutMs: resolvedLimits.timeoutMs },
        ),
      );
    }, resolvedLimits.timeoutMs);
    timer.unref();

    const combinedSignal = signal
      ? AbortSignal.any([timeoutController.signal, signal])
      : timeoutController.signal;

    let slot: WorkerSlot;
    try {
      slot = await this.acquireSlot(combinedSignal);
    } catch (err) {
      clearTimeout(timer);
      if (timeoutController.signal.aborted) {
        throw new PdfParseError(
          'PARSE_TIMEOUT',
          `PDF parsing exceeded timeout of ${resolvedLimits.timeoutMs}ms`,
          { timeoutMs: resolvedLimits.timeoutMs },
        );
      }
      if (signal?.aborted) {
        throw signal.reason ?? err;
      }
      throw classifyChildError(err);
    }

    // Re-check lifecycle & cancellation right after acquiring a slot.
    if (this.closed) {
      clearTimeout(timer);
      this.releaseSlot(slot);
      throw new PdfParseError('PARSE_CRASHED', 'PdfParserPool has been closed');
    }
    if (timeoutController.signal.aborted) {
      clearTimeout(timer);
      this.releaseSlot(slot);
      throw new PdfParseError(
        'PARSE_TIMEOUT',
        `PDF parsing exceeded timeout of ${resolvedLimits.timeoutMs}ms`,
        { timeoutMs: resolvedLimits.timeoutMs },
      );
    }
    if (signal?.aborted) {
      clearTimeout(timer);
      this.releaseSlot(slot);
      throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    }

    slot.watchdogKilled = false;

    try {
      const result = (await slot.pool.run(
        { bytes, limits: resolvedLimits },
        { signal: combinedSignal },
      )) as PdfParseResult;

      slot.parsesSinceRecycle += 1;
      return result;
    } catch (err) {
      if (timeoutController.signal.aborted) {
        throw new PdfParseError(
          'PARSE_TIMEOUT',
          `PDF parsing exceeded timeout of ${resolvedLimits.timeoutMs}ms`,
          { timeoutMs: resolvedLimits.timeoutMs },
        );
      }
      if (signal?.aborted) {
        throw signal.reason ?? err;
      }
      if (slot.watchdogKilled && isUnexpectedWorkerExitError(err)) {
        throw classifyChildError(err, 'PARSE_LIMIT_EXCEEDED');
      }
      throw classifyChildError(err);
    } finally {
      clearTimeout(timer);
      slot.watchdogKilled = false;
      if (!this.closed && slot.parsesSinceRecycle >= this.recycleAfterParses) {
        slot.parsesSinceRecycle = 0;
        await slot.pool.recycleWorkers().catch(() => undefined);
      }
      this.releaseSlot(slot);
    }
  }

  async close(): Promise<void> {
    if (this.closingPromise) {
      return this.closingPromise;
    }
    this.closed = true;
    this.watchdog.stop();

    const closeError = new PdfParseError('PARSE_CRASHED', 'PdfParserPool has been closed');
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      waiter.cleanup();
      waiter.reject(closeError);
    }

    this.closingPromise = Promise.all(this.slots.map((slot) => slot.pool.destroy())).then(
      () => undefined,
    );
    return this.closingPromise;
  }
}
