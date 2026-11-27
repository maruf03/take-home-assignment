import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { WorkerConfig } from './config.js';
import { registerGracefulShutdown } from './shutdown.js';
import { WORKER_CONFIG } from './tokens.js';
import { WorkerModule } from './worker.module.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(WorkerModule, {
    bufferLogs: false,
  });
  const config = app.get<WorkerConfig>(WORKER_CONFIG);
  await app.listen(config.WORKER_HTTP_PORT, '0.0.0.0');
  registerGracefulShutdown(app);
}

void bootstrap().catch((err: unknown) => {
  console.error('Worker bootstrap failed:', err);
  process.exit(1);
});
