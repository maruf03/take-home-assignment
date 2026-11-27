import { existsSync } from 'node:fs';
import { Tinypool } from 'tinypool';
import { classifyChildError, PdfParseError } from './errors.js';
import { resolvePdfParseLimits, type PdfParseLimits, type PdfParseResult } from './line-builder.js';
import { DEFAULT_MAX_RSS_BYTES, DEFAULT_WATCHDOG_POLL_MS, RssWatchdog } from './watchdog.js';

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

/**
 * Isolated child-process PDF parsing pool backed by Tinypool + RSS watchdog (spec §5.1).
 * - `runtime: 'child_process'` with `serialization: 'advanced'`, `env: {}`, `--max-old-space-size=512`
 * - Per-task timeout via AbortController (30s default)
 * - RSS watchdog polling `/proc/<pid>/status` VmRSS (250ms default, 768 MB cap)
 * - Worker recycling every 50 parses
 */
export class PdfParserPool implements PdfParser {
  private readonly pool: Tinypool;
  private readonly watchdog: RssWatchdog;
  private readonly recycleAfterParses: number;
  private completedSinceRecycle = 0;
  private activeTasks = 0;
  private recycling: Promise<void> | null = null;
  private closed = false;
  private watchdogKillCount = 0;

  constructor(options: PdfParserPoolOptions = {}) {
    const maxThreads = Math.max(1, Math.trunc(options.maxThreads ?? DEFAULT_POOL_SIZE));
    const minThreads = Math.min(maxThreads, Math.max(1, Math.trunc(options.minThreads ?? 1)));
    const maxOldSpaceSizeMb = Math.max(
      128,
      Math.trunc(options.maxOldSpaceSizeMb ?? DEFAULT_MAX_OLD_SPACE_MB),
    );
    this.recycleAfterParses = Math.max(
      1,
      Math.trunc(options.recycleAfterParses ?? DEFAULT_RECYCLE_AFTER_PARSES),
    );

    this.pool = new Tinypool({
      filename: options.childFilename ?? resolveChildWorkerUrl(),
      runtime: 'child_process',
      minThreads,
      maxThreads,
      isolateWorkers: false,
      execArgv: [`--max-old-space-size=${maxOldSpaceSizeMb}`],
      env: {},
      serialization: 'advanced',
    });

    this.watchdog = new RssWatchdog({
      pollIntervalMs: options.watchdogPollMs ?? DEFAULT_WATCHDOG_POLL_MS,
      maxRssBytes: options.maxRssBytes ?? DEFAULT_MAX_RSS_BYTES,
      getWorkers: () => this.pool.threads,
      onBeforeKill: (pid, rssBytes) => {
        this.watchdogKillCount += 1;
        options.onWatchdogKill?.(pid, rssBytes);
      },
    });
    this.watchdog.start();
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

    if (this.recycling) {
      await this.recycling;
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

    const killsBefore = this.watchdogKillCount;
    this.activeTasks += 1;

    try {
      const result = (await this.pool.run(
        { bytes, limits: resolvedLimits },
        { signal: combinedSignal },
      )) as PdfParseResult;

      this.completedSinceRecycle += 1;
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
      if (this.watchdogKillCount > killsBefore) {
        throw classifyChildError(err, 'PARSE_LIMIT_EXCEEDED');
      }
      throw classifyChildError(err);
    } finally {
      clearTimeout(timer);
      this.activeTasks -= 1;
      if (
        !this.closed &&
        this.activeTasks === 0 &&
        this.completedSinceRecycle >= this.recycleAfterParses &&
        !this.recycling
      ) {
        this.completedSinceRecycle = 0;
        this.recycling = this.pool
          .recycleWorkers()
          .catch(() => undefined)
          .finally(() => {
            this.recycling = null;
          });
      }
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.watchdog.stop();
    if (this.recycling) {
      await this.recycling;
    }
    await this.pool.destroy();
  }
}
