import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { registerGracefulShutdown } from './shutdown.js';
import { WorkerModule } from './worker.module.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    bufferLogs: false,
  });
  app.enableShutdownHooks();
  registerGracefulShutdown(app);
}

void bootstrap().catch((err: unknown) => {
  console.error('Worker bootstrap failed:', err);
  process.exit(1);
});
