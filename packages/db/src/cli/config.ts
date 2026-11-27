import {
  defineServerConfig,
  type AppEnv,
  type DefineServerConfigOptions,
} from '@app/config/server-config';
import { z } from 'zod';

const DEV_MIGRATOR_URL = 'postgresql://migrator:dev-migrator@127.0.0.1:5432/lomi';
const DEV_S3_ENDPOINT = 'http://127.0.0.1:8333';
const DEV_S3_ACCESS_KEY = 'dev-s3-key';
const DEV_S3_SECRET_KEY = 'dev-s3-secret';

const strictAppEnvSchema = z.preprocess(
  (v) => (v === undefined ? 'development' : typeof v === 'string' ? v.trim() : v),
  z.enum(['development', 'test', 'production']),
);

const requiredNonEmptyString = z.string().trim().min(1);
const optionalNonEmptyString = z.preprocess(
  (v) =>
    typeof v === 'string' && v.trim() === '' ? undefined : typeof v === 'string' ? v.trim() : v,
  z.string().min(1).optional(),
);

export interface MigrateCliConfig {
  appEnv: AppEnv;
  migratorUrl: string;
  fixturesDir?: string;
  s3?: {
    endpoint?: string;
    region: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
  };
}

export function parseMigrateCliConfig(
  rawEnv: Record<string, string | undefined>,
  migrateOnly: boolean,
  options: Omit<DefineServerConfigOptions, 'env'> = {},
): MigrateCliConfig {
  const preEnv = strictAppEnvSchema.safeParse(rawEnv['APP_ENV']);
  const isProd = preEnv.success && preEnv.data === 'production';

  const effectiveEnv: Record<string, string | undefined> = {
    ...rawEnv,
  };
  if (!isProd) {
    if (effectiveEnv['DATABASE_MIGRATOR_URL'] === undefined) {
      effectiveEnv['DATABASE_MIGRATOR_URL'] = DEV_MIGRATOR_URL;
    }
    if (!migrateOnly) {
      if (effectiveEnv['S3_ENDPOINT'] === undefined) {
        effectiveEnv['S3_ENDPOINT'] = DEV_S3_ENDPOINT;
      }
      if (effectiveEnv['S3_ACCESS_KEY'] === undefined) {
        effectiveEnv['S3_ACCESS_KEY'] = DEV_S3_ACCESS_KEY;
      }
      if (effectiveEnv['S3_SECRET_KEY'] === undefined) {
        effectiveEnv['S3_SECRET_KEY'] = DEV_S3_SECRET_KEY;
      }
    }
  }

  if (migrateOnly) {
    const schema = z.object({
      APP_ENV: strictAppEnvSchema,
      DATABASE_MIGRATOR_URL: requiredNonEmptyString,
    });
    const parsed = defineServerConfig(schema, { ...options, env: effectiveEnv });
    return {
      appEnv: parsed.APP_ENV,
      migratorUrl: parsed.DATABASE_MIGRATOR_URL,
    };
  }

  const schema = z.object({
    APP_ENV: strictAppEnvSchema,
    DATABASE_MIGRATOR_URL: requiredNonEmptyString,
    S3_ENDPOINT: optionalNonEmptyString,
    S3_REGION: z.preprocess(
      (v) => (v === undefined ? 'us-east-1' : typeof v === 'string' ? v.trim() : v),
      requiredNonEmptyString,
    ),
    S3_BUCKET: z.preprocess(
      (v) => (v === undefined ? 'documents' : typeof v === 'string' ? v.trim() : v),
      requiredNonEmptyString,
    ),
    S3_ACCESS_KEY: requiredNonEmptyString,
    S3_SECRET_KEY: requiredNonEmptyString,
    FIXTURES_DIR: optionalNonEmptyString,
  });

  const parsed = defineServerConfig(schema, { ...options, env: effectiveEnv });
  return {
    appEnv: parsed.APP_ENV,
    migratorUrl: parsed.DATABASE_MIGRATOR_URL,
    fixturesDir: parsed.FIXTURES_DIR,
    s3: {
      endpoint: parsed.S3_ENDPOINT,
      region: parsed.S3_REGION,
      bucket: parsed.S3_BUCKET,
      accessKeyId: parsed.S3_ACCESS_KEY,
      secretAccessKey: parsed.S3_SECRET_KEY,
    },
  };
}
