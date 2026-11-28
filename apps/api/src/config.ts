import { appEnvSchema, defineServerConfig } from '@app/config/server-config';
import { z } from 'zod';

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

const booleanString = z.preprocess((v) => {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const lower = v.trim().toLowerCase();
    if (lower === 'true' || lower === '1') return true;
    if (lower === 'false' || lower === '0' || lower === '') return false;
  }
  return v;
}, z.boolean());

const logLevelSchema = z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']);

/**
 * The API never receives LLM provider keys (apps/api/AGENTS.md): they are deliberately absent
 * from this schema, so they can never appear in the parsed config.
 */
export const apiConfigSchema = z.object({
  APP_ENV: appEnvSchema,
  DATABASE_URL: z.string().trim().min(1),
  REDIS_URL: z.string().trim().min(1),
  S3_ENDPOINT: optionalNonEmptyString,
  S3_REGION: z.string().trim().min(1).default('us-east-1'),
  S3_BUCKET: z.string().trim().min(1).default('documents'),
  S3_ACCESS_KEY: optionalNonEmptyString,
  S3_SECRET_KEY: optionalNonEmptyString,
  API_PORT: z.coerce.number().int().min(0).max(65_535).default(3000),
  MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
  TRUST_PROXY_CIDR: z.string().trim().min(1).default('172.30.0.0/24'),
  DEBUG_ENDPOINTS: booleanString.default(false),
  THROTTLE_UPLOAD_LIMIT: z.coerce.number().int().min(1).default(10),
  THROTTLE_REVIEW_LIMIT: z.coerce.number().int().min(1).default(120),
  THROTTLE_READ_LIMIT: z.coerce.number().int().min(1).default(600),
  LOG_LEVEL: logLevelSchema.default('info'),
});

export type ApiConfig = Readonly<z.output<typeof apiConfigSchema>>;

export function loadApiConfig(env: Record<string, string | undefined> = process.env): ApiConfig {
  const isProd = env['APP_ENV'] === 'production';
  const effective: Record<string, string | undefined> = {
    APP_ENV: env['APP_ENV'],
    DATABASE_URL: env['DATABASE_URL'],
    REDIS_URL: env['REDIS_URL'],
    S3_ENDPOINT: env['S3_ENDPOINT'],
    S3_REGION: env['S3_REGION'],
    S3_BUCKET: env['S3_BUCKET'],
    S3_ACCESS_KEY: env['S3_ACCESS_KEY'] ?? env['S3_ACCESS_KEY_ID'],
    S3_SECRET_KEY: env['S3_SECRET_KEY'] ?? env['S3_SECRET_ACCESS_KEY'],
    API_PORT: env['API_PORT'],
    MAX_ATTEMPTS: env['MAX_ATTEMPTS'],
    TRUST_PROXY_CIDR: env['TRUST_PROXY_CIDR'],
    DEBUG_ENDPOINTS: env['DEBUG_ENDPOINTS'],
    THROTTLE_UPLOAD_LIMIT: env['THROTTLE_UPLOAD_LIMIT'],
    THROTTLE_REVIEW_LIMIT: env['THROTTLE_REVIEW_LIMIT'],
    THROTTLE_READ_LIMIT: env['THROTTLE_READ_LIMIT'],
    LOG_LEVEL: env['LOG_LEVEL'] ?? (env['APP_ENV'] === 'test' ? 'silent' : undefined),
  };
  if (!isProd) {
    effective['DATABASE_URL'] ??= DEV_DATABASE_URL;
    effective['REDIS_URL'] ??= DEV_REDIS_URL;
    effective['S3_ENDPOINT'] ??= DEV_S3_ENDPOINT;
    if (!env['AWS_SHARED_CREDENTIALS_FILE']?.trim()) {
      effective['S3_ACCESS_KEY'] ??= DEV_S3_ACCESS_KEY;
      effective['S3_SECRET_KEY'] ??= DEV_S3_SECRET_KEY;
    }
  }
  return defineServerConfig(apiConfigSchema, { env: effective });
}
