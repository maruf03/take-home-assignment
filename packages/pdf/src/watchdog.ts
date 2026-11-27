import { readFile } from 'node:fs/promises';

export interface WatchdogWorkerRef {
  readonly threadId: number;
}

export interface RssWatchdogOptions {
  pollIntervalMs?: number;
  maxRssBytes?: number;
  getWorkers: () => readonly WatchdogWorkerRef[];
  onBeforeKill: (pid: number, rssBytes: number) => void;
}

export const DEFAULT_WATCHDOG_POLL_MS = 250;
export const DEFAULT_MAX_RSS_BYTES = 768 * 1024 * 1024; // 768 MB (spec §5.1)

/**
 * Reads VmRSS from `/proc/<pid>/status` on Linux and returns bytes, or null if unavailable.
 */
export async function readProcessRssBytes(pid: number): Promise<number | null> {
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  try {
    const status = await readFile(`/proc/${pid}/status`, 'utf8');
    const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
    if (!match?.[1]) {
      return null;
    }
    return Number(match[1]) * 1024;
  } catch {
    return null;
  }
}

/**
 * Polls child-process RSS every `pollIntervalMs` (250ms default) and SIGKILLs any child
 * exceeding `maxRssBytes` (768 MB default), recording the kill reason via `onBeforeKill` first.
 */
export class RssWatchdog {
  private readonly pollIntervalMs: number;
  private readonly maxRssBytes: number;
  private readonly getWorkers: () => readonly WatchdogWorkerRef[];
  private readonly onBeforeKill: (pid: number, rssBytes: number) => void;
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  private readonly killedPids = new Set<number>();

  constructor(options: RssWatchdogOptions) {
    this.pollIntervalMs = Math.max(
      10,
      Math.trunc(options.pollIntervalMs ?? DEFAULT_WATCHDOG_POLL_MS),
    );
    this.maxRssBytes = Math.max(
      1024 * 1024,
      Math.trunc(options.maxRssBytes ?? DEFAULT_MAX_RSS_BYTES),
    );
    this.getWorkers = options.getWorkers;
    this.onBeforeKill = options.onBeforeKill;
  }

  start(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      void this.tick();
    }, this.pollIntervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.killedPids.clear();
  }

  async tick(): Promise<void> {
    if (this.polling) {
      return;
    }
    this.polling = true;
    try {
      const workers = this.getWorkers();
      const activePids = new Set<number>();
      for (const worker of workers) {
        const pid = worker.threadId;
        if (pid > 0) {
          activePids.add(pid);
        }
      }
      // Prune stale PIDs no longer present in the pool.
      for (const oldPid of this.killedPids) {
        if (!activePids.has(oldPid)) {
          this.killedPids.delete(oldPid);
        }
      }

      for (const pid of activePids) {
        if (this.killedPids.has(pid)) {
          continue;
        }
        const rss = await readProcessRssBytes(pid);
        if (rss !== null && rss > this.maxRssBytes) {
          this.killedPids.add(pid);
          this.onBeforeKill(pid, rss);
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            // Child already exited between poll and SIGKILL.
          }
        }
      }
    } finally {
      this.polling = false;
    }
  }
}
