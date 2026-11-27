import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');

describe('workspace config invariants', () => {
  it('@app/config keeps ESLint toolchain out of production dependencies and exports only internal files', () => {
    const pkgPath = path.join(repoRoot, 'packages/config/package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
      dependencies?: Record<string, string>;
      exports?: Record<string, string | Record<string, string>>;
    };

    const prodDeps = Object.keys(pkg.dependencies ?? {});
    const eslintDeps = prodDeps.filter(
      (dep) => dep.includes('eslint') || dep === 'typescript-eslint',
    );
    expect(eslintDeps).toEqual([]);

    for (const [exportKey, target] of Object.entries(pkg.exports ?? {})) {
      const paths = typeof target === 'string' ? [target] : Object.values(target);
      for (const rel of paths) {
        expect(rel, `export ${exportKey} must not escape packages/config`).not.toContain('..');
        if (!rel.startsWith('./dist/')) {
          expect(
            existsSync(path.join(repoRoot, 'packages/config', rel)),
            `export ${exportKey} target ${rel} must exist`,
          ).toBe(true);
        }
      }
    }
  });

  it('turbo.json enables pruneIncludesGlobalFiles and passes required test env and inputs', () => {
    const turbo = JSON.parse(readFileSync(path.join(repoRoot, 'turbo.json'), 'utf8')) as {
      futureFlags?: { pruneIncludesGlobalFiles?: boolean };
      tasks: Record<string, { inputs?: string[]; passThroughEnv?: string[] }>;
    };

    expect(turbo.futureFlags?.pruneIncludesGlobalFiles).toBe(true);
    expect(turbo.tasks['test']?.inputs).toEqual(
      expect.arrayContaining([
        '$TURBO_ROOT$/eslint.config.js',
        '$TURBO_ROOT$/commitlint.config.js',
      ]),
    );
    for (const taskName of ['test:int', 'test:chaos']) {
      expect(turbo.tasks[taskName]?.passThroughEnv).toEqual(
        expect.arrayContaining([
          'APP_ENV',
          'DATABASE_MIGRATOR_URL',
          'DATABASE_ADMIN_URL',
          'POSTGRES_USER',
          'POSTGRES_PASSWORD',
          'LLM_PROVIDER',
          'LLM_MODEL',
        ]),
      );
    }
  });

  it('compose.yaml postgres and redis healthchecks guard against cold-start races', () => {
    const compose = readFileSync(path.join(repoRoot, 'compose.yaml'), 'utf8');
    expect(compose).toMatch(/pg_isready\s+-h\s+127\.0\.0\.1/);
    expect(compose).toMatch(/redis-cli\s+ping\s*\|\s*grep\s+-qx\s+PONG/);
  });
});
