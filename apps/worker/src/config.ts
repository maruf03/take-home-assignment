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

const DEV_DATABASE_URL = 'postgresql://app:dev-app@127.0.0.1:5432/lomi';
const DEV_REDIS_URL = 'redis://:dev-redis@127.0.0.1:6379';
const DEV_S3_ENDPOINT = 'http://127.0.0.1:8333';
const DEV_S3_ACCESS_KEY = 'dev-s3-key';
const DEV_S3_SECRET_KEY = 'dev-s3-secret';

const optionalNonEmptyString = z.preprocess(
  (v) =>
    typeof v === 'string' && v.trim() === '' ? undefined : typeof v === 'string' ? v.trim() : v,
  z.string().min(1).optional(),
);

const optionalPositiveInt = z.preprocess(
  (v) =>
    v === undefined || v === null || (typeof v === 'string' && v.trim() === '') ? undefined : v,
  z.coerce.number().int().positive().optional(),
);

export const workerConfigSchema = z
  .object({
    APP_ENV: appEnvSchema,
    DATABASE_URL: z.string().trim().min(1),
    REDIS_URL: z.string().trim().min(1),
    S3_ENDPOINT: optionalNonEmptyString,
    S3_REGION: z.string().trim().min(1).default('us-east-1'),
    S3_BUCKET: z.string().trim().min(1).default('documents'),
    S3_ACCESS_KEY: optionalNonEmptyString,
    S3_SECRET_KEY: optionalNonEmptyString,
    LLM_PROVIDER: llmProviderSchema.default('gemini'),
    LLM_MODEL: z.string().trim().min(1).default('gemini-3.5-flash'),
    GEMINI_API_KEY: z.string().default(''),
    GEMINI_BASE_URL: optionalNonEmptyString,
    ANTHROPIC_API_KEY: z.string().default(''),
    ANTHROPIC_BASE_URL: optionalNonEmptyString,
    LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
    LLM_LIMIT_MAX: optionalPositiveInt,
    LLM_LIMIT_DURATION_MS: optionalPositiveInt,
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(2),
    WORKER_ID: z
      .string()
      .trim()
      .min(1)
      .default(() => `${os.hostname()}-${process.pid}`),
    LEASE_SECONDS: z.coerce.number().int().min(1).max(300).default(30),
    HEARTBEAT_INTERVAL_MS: z.coerce.number().int().min(100).max(60_000).default(10_000),
    CHUNK_CHAR_LIMIT: z.coerce.number().int().min(1000).default(400_000),
    CASSETTES_DIR: optionalNonEmptyString,
    FAKE_IPC_ENDPOINT: optionalNonEmptyString,
  })
  .superRefine((cfg, ctx) => {
    if (cfg.HEARTBEAT_INTERVAL_MS >= cfg.LEASE_SECONDS * 1000) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['HEARTBEAT_INTERVAL_MS'],
        message: 'HEARTBEAT_INTERVAL_MS must be strictly less than LEASE_SECONDS * 1000',
      });
    }
  });

export type WorkerConfig = Readonly<z.output<typeof workerConfigSchema>>;

export function loadWorkerConfig(
  env: Record<string, string | undefined> = process.env,
): WorkerConfig {
  const preEnv = appEnvSchema.safeParse(env['APP_ENV']);
  const isProd = preEnv.success && preEnv.data === 'production';

  const effectiveEnv: Record<string, string | undefined> = { ...env };
  // Support canonical S3_ACCESS_KEY / S3_SECRET_KEY (.env.example, @app/db) as well as AWS-style fallback
  if (!effectiveEnv['S3_ACCESS_KEY'] && effectiveEnv['S3_ACCESS_KEY_ID']) {
    effectiveEnv['S3_ACCESS_KEY'] = effectiveEnv['S3_ACCESS_KEY_ID'];
  }
  if (!effectiveEnv['S3_SECRET_KEY'] && effectiveEnv['S3_SECRET_ACCESS_KEY']) {
    effectiveEnv['S3_SECRET_KEY'] = effectiveEnv['S3_SECRET_ACCESS_KEY'];
  }

  // Apply non-production dev defaults only when not using AWS_SHARED_CREDENTIALS_FILE / explicit values.
  if (!isProd) {
    if (effectiveEnv['DATABASE_URL'] === undefined) {
      effectiveEnv['DATABASE_URL'] = DEV_DATABASE_URL;
    }
    if (effectiveEnv['REDIS_URL'] === undefined) {
      effectiveEnv['REDIS_URL'] = DEV_REDIS_URL;
    }
    if (effectiveEnv['S3_ENDPOINT'] === undefined) {
      effectiveEnv['S3_ENDPOINT'] = DEV_S3_ENDPOINT;
    }
    const usesSharedCreds = Boolean(effectiveEnv['AWS_SHARED_CREDENTIALS_FILE']?.trim());
    if (!usesSharedCreds) {
      if (effectiveEnv['S3_ACCESS_KEY'] === undefined) {
        effectiveEnv['S3_ACCESS_KEY'] = DEV_S3_ACCESS_KEY;
      }
      if (effectiveEnv['S3_SECRET_KEY'] === undefined) {
        effectiveEnv['S3_SECRET_KEY'] = DEV_S3_SECRET_KEY;
      }
    }
  }

  return defineServerConfig(workerConfigSchema, { env: effectiveEnv });
}

export function resolveWorkerLimiter(config: WorkerConfig): LimiterConfig {
  return resolveLimiterConfig(config.LLM_PROVIDER as LlmProviderName, {
    max: config.LLM_LIMIT_MAX,
    duration: config.LLM_LIMIT_DURATION_MS,
  });
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
