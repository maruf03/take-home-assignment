import { describe, expect, it } from 'vitest';
import { LlmCircuitBreaker } from '../../src/circuit-breaker.js';
import { loadWorkerConfig } from '../../src/config.js';

describe('LlmCircuitBreaker and worker config', () => {
  it('opens after 5 consecutive transient failures for 30s and resets on success', () => {
    let now = 1_000;
    const breaker = new LlmCircuitBreaker({
      failureThreshold: 5,
      openDurationMs: 30_000,
      now: () => now,
    });

    for (let i = 1; i <= 4; i++) {
      const res = breaker.recordTransientFailure();
      expect(res.opened).toBe(false);
      expect(breaker.getRemainingOpenMs()).toBe(0);
    }

    const fifth = breaker.recordTransientFailure();
    expect(fifth.opened).toBe(true);
    expect(fifth.openDurationMs).toBe(30_000);
    expect(breaker.getRemainingOpenMs()).toBe(30_000);

    now += 10_000;
    expect(breaker.getRemainingOpenMs()).toBe(20_000);

    now += 25_000;
    expect(breaker.getRemainingOpenMs()).toBe(0);

    breaker.recordTransientFailure();
    breaker.recordSuccess();
    expect(breaker.consecutiveFailures).toBe(0);
    expect(breaker.getRemainingOpenMs()).toBe(0);
  });

  it('allows keyless boot in development (for LLM_NOT_CONFIGURED) while refusing test providers outside APP_ENV=test', () => {
    const devCfg = loadWorkerConfig({
      APP_ENV: 'development',
      DATABASE_URL: 'postgresql://app:custom-pw@127.0.0.1:5432/lomi',
      REDIS_URL: 'redis://:custom-redis@127.0.0.1:6379',
      S3_ENDPOINT: 'http://127.0.0.1:8333',
      S3_ACCESS_KEY_ID: 'custom-key',
      S3_SECRET_ACCESS_KEY: 'custom-secret',
      LLM_PROVIDER: 'gemini',
      GEMINI_API_KEY: '',
    });
    expect(devCfg.LLM_PROVIDER).toBe('gemini');
    expect(devCfg.GEMINI_API_KEY).toBe('');

    expect(() =>
      loadWorkerConfig({
        APP_ENV: 'development',
        DATABASE_URL: 'postgresql://app:custom-pw@127.0.0.1:5432/lomi',
        REDIS_URL: 'redis://:custom-redis@127.0.0.1:6379',
        S3_ACCESS_KEY_ID: 'custom-key',
        S3_SECRET_ACCESS_KEY: 'custom-secret',
        LLM_PROVIDER: 'cassette',
      }),
    ).toThrow(/APP_ENV=test/);
  });
});
