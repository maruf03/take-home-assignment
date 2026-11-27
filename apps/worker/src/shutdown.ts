import type { INestApplicationContext } from '@nestjs/common';

export interface ShutdownOptions {
  readonly gracePeriodMs?: number;
  readonly onLog?: (message: string) => void;
}

/**
 * Registers SIGTERM and SIGINT handlers to close the NestJS worker context cleanly
 * (draining BullMQ jobs, stopping parse child workers, and closing DB/S3 pools).
 */
export function registerGracefulShutdown(
  app: INestApplicationContext,
  options: ShutdownOptions = {},
): () => void {
  const gracePeriodMs = Math.max(1_000, Math.trunc(options.gracePeriodMs ?? 25_000));
  const log = options.onLog ?? ((msg: string) => console.log(msg));
  let shuttingDown = false;

  const handleSignal = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    log(`Received ${signal}; shutting down worker gracefully...`);

    const hardTimer = setTimeout(() => {
      log(`Graceful shutdown timed out after ${gracePeriodMs}ms; forcing exit.`);
      process.exit(1);
    }, gracePeriodMs);
    hardTimer.unref?.();

    void app
      .close()
      .then(() => {
        clearTimeout(hardTimer);
        log('Worker shutdown complete.');
        process.exit(0);
      })
      .catch((err: unknown) => {
        clearTimeout(hardTimer);
        console.error('Error during worker shutdown:', err);
        process.exit(1);
      });
  };

  process.on('SIGTERM', handleSignal);
  process.on('SIGINT', handleSignal);

  return () => {
    process.off('SIGTERM', handleSignal);
    process.off('SIGINT', handleSignal);
  };
}
