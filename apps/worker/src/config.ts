import os from 'node:os';
import { appEnvSchema, defineServerConfig } from '@app/config/server-config';
import {
  createProvider,
  LlmError,
  resolveLimiterConfig,
  type LimiterConfig,
  type LlmProvider,
  type LlmProviderName,
} from '@app/llm';
import { z } from 'zod';

const llmProviderSchema = z.enum(['gemini', 'anthropic', 'fake', 'fake-ipc', 'cassette']);

export const workerConfigSchema = z.object({
  APP_ENV: appEnvSchema,
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().default('documents'),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  LLM_PROVIDER: llmProviderSchema.default('gemini'),
  LLM_MODEL: z.string().min(1).default('gemini-3.5-flash'),
  GEMINI_API_KEY: z.string().default(''),
  GEMINI_BASE_URL: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().default(''),
  ANTHROPIC_BASE_URL: z.string().optional(),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  LLM_LIMIT_MAX: z.coerce.number().optional(),
  LLM_LIMIT_DURATION_MS: z.coerce.number().optional(),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(2),
  WORKER_ID: z
    .string()
    .min(1)
    .default(() => `${os.hostname()}-${process.pid}`),
  LEASE_SECONDS: z.coerce.number().int().min(5).max(300).default(30),
  HEARTBEAT_INTERVAL_MS: z.coerce.number().int().min(500).max(60_000).default(10_000),
  CHUNK_CHAR_LIMIT: z.coerce.number().int().min(1000).default(400_000),
  CASSETTES_DIR: z.string().optional(),
  FAKE_IPC_ENDPOINT: z.string().optional(),
});

export type WorkerConfig = Readonly<z.output<typeof workerConfigSchema>>;

export function loadWorkerConfig(
  env: Record<string, string | undefined> = process.env,
): WorkerConfig {
  return defineServerConfig(workerConfigSchema, { env });
}

export function resolveWorkerLimiter(config: WorkerConfig): LimiterConfig {
  return resolveLimiterConfig(config.LLM_PROVIDER as LlmProviderName, {
    max: config.LLM_LIMIT_MAX,
    duration: config.LLM_LIMIT_DURATION_MS,
  });
}

/**
 * Resolves BullMQ WorkerOptions (`concurrency` and integer `limiter`) at module decoration time
 * so `@Processor(EXTRACTION_QUEUE, ...)` wires real BullMQ rate limiting and concurrency.
 */
export function resolveProcessorWorkerOptions(
  env: Record<string, string | undefined> = process.env,
): { concurrency: number; limiter: LimiterConfig } {
  const rawProvider = env['LLM_PROVIDER']?.trim().toLowerCase() ?? 'gemini';
  const provider: LlmProviderName = llmProviderSchema.safeParse(rawProvider).success
    ? (rawProvider as LlmProviderName)
    : 'gemini';

  const parsedMax = env['LLM_LIMIT_MAX'] ? Number(env['LLM_LIMIT_MAX']) : undefined;
  const parsedDuration = env['LLM_LIMIT_DURATION_MS']
    ? Number(env['LLM_LIMIT_DURATION_MS'])
    : undefined;
  const limiter = resolveLimiterConfig(provider, {
    max: parsedMax !== undefined && Number.isFinite(parsedMax) ? parsedMax : undefined,
    duration:
      parsedDuration !== undefined && Number.isFinite(parsedDuration) ? parsedDuration : undefined,
  });

  const parsedConcurrency = env['WORKER_CONCURRENCY'] ? Number(env['WORKER_CONCURRENCY']) : 2;
  const concurrency =
    Number.isFinite(parsedConcurrency) && parsedConcurrency >= 1
      ? Math.min(32, Math.trunc(parsedConcurrency))
      : 2;

  return { concurrency, limiter };
}

/**
 * Resolves the configured LLM provider.
 *
 * Security invariants:
 * - Refuses `fake`, `fake-ipc`, and `cassette` outside `APP_ENV=test` immediately at boot ([I8]).
 * - If a live provider key (`GEMINI_API_KEY` / `ANTHROPIC_API_KEY`) is empty, returns a lazy
 *   provider resolver that throws `LlmError('NOT_CONFIGURED')` at run time so keyless containers
 *   boot cleanly and mark versions `failed (LLM_NOT_CONFIGURED)` (spec §10.5, [R5]).
 */
export function buildWorkerLlmProviderResolver(config: WorkerConfig): () => LlmProvider {
  try {
    const provider = createProvider({
      appEnv: config.APP_ENV,
      provider: config.LLM_PROVIDER,
      geminiApiKey: config.GEMINI_API_KEY,
      geminiBaseUrl: config.GEMINI_BASE_URL,
      anthropicApiKey: config.ANTHROPIC_API_KEY,
      anthropicBaseUrl: config.ANTHROPIC_BASE_URL,
      timeoutMs: config.LLM_TIMEOUT_MS,
      cassettesDir: config.CASSETTES_DIR,
      fakeIpcEndpoint: config.FAKE_IPC_ENDPOINT,
    });
    return () => provider;
  } catch (err) {
    if (err instanceof LlmError && err.code === 'NOT_CONFIGURED') {
      const captured = err;
      return () => {
        throw captured;
      };
    }
    throw err;
  }
}
