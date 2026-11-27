import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  ConfigError,
  DEV_DEFAULT_SECRETS,
  appEnvSchema,
  defineServerConfig,
  resetDevDefaultWarningForTests,
} from '../src/server-config.js';

const testSchema = z.object({
  APP_ENV: appEnvSchema,
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  LLM_PROVIDER: z.enum(['gemini', 'anthropic', 'fake', 'fake-ipc', 'cassette']).default('gemini'),
  GEMINI_API_KEY: z.string().default(''),
  ANTHROPIC_API_KEY: z.string().default(''),
});

const safeProdEnv = {
  APP_ENV: 'production',
  DATABASE_URL: 'postgresql://app:prod-9f8a7c6b5e4d@pg.internal:5432/lomi',
  REDIS_URL: 'redis://:prod-r3d1s-s3cr3t@redis.internal:6379',
  S3_ACCESS_KEY: 'AKIAEXAMPLEPRODKEY',
  S3_SECRET_KEY: 'prod-s3-secret-value-817263',
  LLM_PROVIDER: 'gemini',
  GEMINI_API_KEY: 'AIza-real-prod-key',
  ANTHROPIC_API_KEY: '',
};

describe('[I8] server config', () => {
  it('[I8] server config refuses dev-default secrets under APP_ENV=production', () => {
    expect(() =>
      defineServerConfig(testSchema, {
        env: {
          ...safeProdEnv,
          S3_SECRET_KEY: 'dev-s3-secret',
        },
      }),
    ).toThrow(ConfigError);

    expect(() =>
      defineServerConfig(testSchema, {
        env: {
          ...safeProdEnv,
          DATABASE_URL: 'postgresql://app:dev-app@postgres:5432/lomi',
        },
      }),
    ).toThrow(/DATABASE_URL/);

    expect(() =>
      defineServerConfig(testSchema, {
        env: {
          ...safeProdEnv,
          REDIS_URL: 'redis://:dev-redis@redis:6379',
        },
      }),
    ).toThrow(/REDIS_URL/);
  });

  it('[I8] error message never leaks the offending secret value', () => {
    let caught: unknown;
    try {
      defineServerConfig(testSchema, {
        env: {
          ...safeProdEnv,
          S3_SECRET_KEY: 'dev-s3-secret',
        },
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ConfigError);
    expect((caught as Error).message).toContain('S3_SECRET_KEY');
    expect((caught as Error).message).not.toContain('dev-s3-secret');
  });

  it('[I8] accepts non-default secrets under APP_ENV=production and freezes result', () => {
    const cfg = defineServerConfig(testSchema, { env: safeProdEnv });
    expect(cfg.APP_ENV).toBe('production');
    expect(cfg.S3_ACCESS_KEY).toBe('AKIAEXAMPLEPRODKEY');
    expect(Object.isFrozen(cfg)).toBe(true);
  });

  it('[I8] warns once for dev-default secrets when APP_ENV is not production', () => {
    const onWarn = vi.fn();
    const devEnv = {
      ...safeProdEnv,
      APP_ENV: 'development',
      REDIS_URL: 'redis://:dev-redis@redis:6379',
      S3_SECRET_KEY: 'dev-s3-secret',
    };

    const cfg = defineServerConfig(testSchema, { env: devEnv, onWarn });
    expect(cfg.APP_ENV).toBe('development');
    expect(onWarn).toHaveBeenCalledTimes(1);
    const warning = onWarn.mock.calls[0]?.[0] as string;
    expect(warning).toContain('REDIS_URL');
    expect(warning).toContain('S3_SECRET_KEY');
    expect(warning).not.toContain('dev-redis');
    expect(warning).not.toContain('dev-s3-secret');
  });

  it('[I8] refuses fake and cassette LLM providers outside APP_ENV=test', () => {
    for (const provider of ['fake', 'fake-ipc', 'cassette'] as const) {
      expect(() =>
        defineServerConfig(testSchema, {
          env: {
            ...safeProdEnv,
            APP_ENV: 'development',
            LLM_PROVIDER: provider,
          },
        }),
      ).toThrow(ConfigError);

      expect(() =>
        defineServerConfig(testSchema, {
          env: {
            ...safeProdEnv,
            APP_ENV: 'production',
            LLM_PROVIDER: provider,
          },
        }),
      ).toThrow(ConfigError);

      const allowed = defineServerConfig(testSchema, {
        env: {
          ...safeProdEnv,
          APP_ENV: 'test',
          LLM_PROVIDER: provider,
        },
      });
      expect(allowed.LLM_PROVIDER).toBe(provider);
    }
  });

  it('[I8] refuses invalid config values with ConfigError', () => {
    expect(() =>
      defineServerConfig(testSchema, {
        env: {
          ...safeProdEnv,
          DATABASE_URL: '',
        },
      }),
    ).toThrow(ConfigError);
  });

  it('[I8] exports the documented dev-default secret denylist', () => {
    expect(DEV_DEFAULT_SECRETS).toEqual(
      expect.arrayContaining([
        'dev-postgres',
        'dev-migrator',
        'dev-app',
        'dev-redis',
        'dev-s3-key',
        'dev-s3-secret',
      ]),
    );
  });

  it('[I8] default logger warns only once across repeated calls in non-production', () => {
    resetDevDefaultWarningForTests();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const devEnv = {
        ...safeProdEnv,
        APP_ENV: 'development',
        S3_SECRET_KEY: 'dev-s3-secret',
      };
      defineServerConfig(testSchema, { env: devEnv });
      defineServerConfig(testSchema, { env: devEnv });
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
      resetDevDefaultWarningForTests();
    }
  });
});
