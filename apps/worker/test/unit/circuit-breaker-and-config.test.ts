import { describe, expect, it } from 'vitest';
import { LlmCircuitBreaker } from '../../src/circuit-breaker.js';
import { loadWorkerConfig, resolveWorkerLimiter } from '../../src/config.js';
import {
  extractionBackoffStrategy,
  TransientJobRetryError,
} from '../../src/extraction.processor.js';

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

  it('supports canonical S3_ACCESS_KEY/S3_SECRET_KEY, empty-string optional env normalization, fast test lease bounds, keyless dev boot, and [I8] test-provider gate', () => {
    const devCfg = loadWorkerConfig({
      APP_ENV: 'development',
      DATABASE_URL: 'postgresql://app:custom-pw@127.0.0.1:5432/lomi',
      REDIS_URL: 'redis://:custom-redis@127.0.0.1:6379',
      S3_ENDPOINT: 'http://127.0.0.1:8333',
      S3_ACCESS_KEY: 'custom-key',
      S3_SECRET_KEY: 'custom-secret',
      LLM_PROVIDER: 'gemini',
      GEMINI_API_KEY: '',
      LLM_LIMIT_MAX: '',
      LLM_LIMIT_DURATION_MS: '',
    });
    expect(devCfg.LLM_PROVIDER).toBe('gemini');
    expect(devCfg.GEMINI_API_KEY).toBe('');
    expect(devCfg.LLM_LIMIT_MAX).toBeUndefined();
    expect(devCfg.LLM_LIMIT_DURATION_MS).toBeUndefined();
    expect(resolveWorkerLimiter(devCfg)).toEqual({ max: 1, duration: 12_000 });

    // Fast test timings (LEASE_SECONDS=2, HEARTBEAT_INTERVAL_MS=300) and empty LLM_LIMIT_* keep fake defaults
    const testCfg = loadWorkerConfig({
      APP_ENV: 'test',
      LLM_PROVIDER: 'fake',
      LEASE_SECONDS: '2',
      HEARTBEAT_INTERVAL_MS: '300',
      LLM_LIMIT_MAX: '',
    });
    expect(testCfg.LEASE_SECONDS).toBe(2);
    expect(testCfg.HEARTBEAT_INTERVAL_MS).toBe(300);
    expect(resolveWorkerLimiter(testCfg)).toEqual({ max: 100, duration: 1_000 });

    // HEARTBEAT_INTERVAL_MS >= LEASE_SECONDS * 1000 is rejected
    expect(() =>
      loadWorkerConfig({
        APP_ENV: 'test',
        LEASE_SECONDS: '2',
        HEARTBEAT_INTERVAL_MS: '2000',
      }),
    ).toThrow(/HEARTBEAT_INTERVAL_MS/);

    // [I8] Test providers refused outside APP_ENV=test
    expect(() =>
      loadWorkerConfig({
        APP_ENV: 'development',
        DATABASE_URL: 'postgresql://app:custom-pw@127.0.0.1:5432/lomi',
        REDIS_URL: 'redis://:custom-redis@127.0.0.1:6379',
        S3_ACCESS_KEY: 'custom-key',
        S3_SECRET_KEY: 'custom-secret',
        LLM_PROVIDER: 'cassette',
      }),
    ).toThrow(/APP_ENV=test/);

    // Custom BullMQ backoff honors TransientJobRetryError.backoffMs
    expect(
      extractionBackoffStrategy(
        1,
        'custom',
        new TransientJobRetryError('OVERLOADED', 'busy', 12_345),
      ),
    ).toBe(12_345);
    expect(extractionBackoffStrategy(2, 'custom', new Error('other'))).toBe(10_000);
  });
});
