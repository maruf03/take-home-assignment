import { ConfigError } from '@app/config/server-config';
import { describe, expect, it } from 'vitest';
import { parseMigrateCliConfig } from '../../src/cli/config.js';
import {
  decodeCursor,
  encodeCursor,
  fingerprintFilters,
  isValidPositiveIntKey,
  keyset,
} from '../../src/repos/keyset.js';
import { documents } from '../../src/schema/documents.js';

describe('migrate-and-seed CLI config validation', () => {
  it('rejects dev-default secrets and empty credentials under APP_ENV=production without leaking secret values', () => {
    const devMigratorUrl = 'postgresql://migrator:dev-migrator@db.internal:5432/lomi';
    expect(() =>
      parseMigrateCliConfig(
        {
          APP_ENV: 'production',
          DATABASE_MIGRATOR_URL: devMigratorUrl,
        },
        true,
      ),
    ).toThrow(ConfigError);

    let thrownMessage = '';
    try {
      parseMigrateCliConfig(
        {
          APP_ENV: 'production',
          DATABASE_MIGRATOR_URL: 'postgresql://migrator:real-secret-999@db.internal:5432/lomi',
          S3_ACCESS_KEY: 'dev-s3-key',
          S3_SECRET_KEY: 'real-s3-secret-888',
        },
        false,
      );
    } catch (err) {
      thrownMessage = err instanceof Error ? err.message : String(err);
    }
    expect(thrownMessage).toContain('S3_ACCESS_KEY');
    expect(thrownMessage).not.toContain('dev-s3-key');
    expect(thrownMessage).not.toContain('real-s3-secret-888');
    expect(thrownMessage).not.toContain('real-secret-999');

    // Empty / whitespace credentials rejected in production
    expect(() =>
      parseMigrateCliConfig(
        {
          APP_ENV: 'production',
          DATABASE_MIGRATOR_URL: '   ',
        },
        true,
      ),
    ).toThrow(ConfigError);

    expect(() =>
      parseMigrateCliConfig(
        {
          APP_ENV: 'production',
          DATABASE_MIGRATOR_URL: 'postgresql://migrator:real-secret-999@db.internal:5432/lomi',
          S3_ACCESS_KEY: '   ',
          S3_SECRET_KEY: 'real-s3-secret-888',
        },
        false,
      ),
    ).toThrow(ConfigError);

    // Invalid APP_ENV rejected
    expect(() =>
      parseMigrateCliConfig(
        {
          APP_ENV: 'prod',
          DATABASE_MIGRATOR_URL: 'postgresql://migrator:real-secret-999@db.internal:5432/lomi',
        },
        true,
      ),
    ).toThrow(ConfigError);
  });

  it('accepts valid production credentials and leaves S3_ENDPOINT optional for native AWS S3', () => {
    const cfg = parseMigrateCliConfig(
      {
        APP_ENV: 'production',
        DATABASE_MIGRATOR_URL: 'postgresql://migrator:strong-prod-pw@db.internal:5432/lomi',
        S3_BUCKET: 'prod-docs',
        S3_REGION: 'us-west-2',
        S3_ACCESS_KEY: 'AKIAEXAMPLEPRODKEY',
        S3_SECRET_KEY: 'strong-prod-s3-secret',
      },
      false,
    );
    expect(cfg.appEnv).toBe('production');
    expect(cfg.s3?.endpoint).toBeUndefined();
    expect(cfg.s3?.bucket).toBe('prod-docs');
  });

  it('applies local dev defaults under APP_ENV=development', () => {
    const cfg = parseMigrateCliConfig({ APP_ENV: 'development' }, false, { onWarn: () => {} });
    expect(cfg.appEnv).toBe('development');
    expect(cfg.migratorUrl).toContain('127.0.0.1:5432/lomi');
    expect(cfg.s3?.endpoint).toBe('http://127.0.0.1:8333');
  });
});

describe('keyset fingerprint and integer bounds', () => {
  it('keeps filter fingerprints bounded (<= 32 chars) and collision-free for long or delimiter-bearing values', () => {
    const longFp = fingerprintFilters({
      externalId: 'x'.repeat(128),
      type: 'market_report',
      needsReview: true,
      status: 'extracted',
    });
    expect(longFp.length).toBeGreaterThan(0);
    expect(longFp.length).toBeLessThanOrEqual(32);

    const encoded = encodeCursor({
      v: 1,
      k: '01950000-0000-7000-8000-000000000001',
      d: 'next',
      f: longFp,
    });
    expect(decodeCursor(encoded, longFp).f).toBe(longFp);

    // No delimiter collision between externalId="a&type=invoice" and { externalId: "a", type: "invoice" }
    const fp1 = fingerprintFilters({ externalId: 'a&type=invoice' });
    const fp2 = fingerprintFilters({ externalId: 'a', type: 'invoice' });
    expect(fp1).not.toBe(fp2);
  });

  it('enforces PostgreSQL int4 upper bound on positive integer keys and rejects invalid limits', () => {
    expect(isValidPositiveIntKey('1')).toBe(true);
    expect(isValidPositiveIntKey('2147483647')).toBe(true);
    expect(isValidPositiveIntKey('0')).toBe(false);
    expect(isValidPositiveIntKey('-1')).toBe(false);
    expect(isValidPositiveIntKey('2147483648')).toBe(false);
    expect(isValidPositiveIntKey('9'.repeat(30))).toBe(false);

    expect(() => keyset({ key: documents.id, limit: 0 })).toThrow(/Limit must be an integer/);
    expect(() => keyset({ key: documents.id, limit: 101 })).toThrow(/Limit must be an integer/);
    expect(() => keyset({ key: documents.id, limit: 1.5 })).toThrow(/Limit must be an integer/);
  });
});
