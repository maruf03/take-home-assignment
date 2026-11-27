import path from 'node:path';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');

async function lintSnippet(code: string, relFilePath: string) {
  const eslint = new ESLint({
    cwd: repoRoot,
    overrideConfigFile: path.join(repoRoot, 'eslint.config.js'),
  });
  const [result] = await eslint.lintText(code, {
    filePath: path.join(repoRoot, relFilePath),
  });
  return result?.messages ?? [];
}

describe('ESLint import boundaries (spec §10.1)', () => {
  it('blocks apps/web from importing @app/config/server-config and node built-ins', async () => {
    const messages = await lintSnippet(
      `import { defineServerConfig } from '@app/config/server-config';\nimport fs from 'node:fs';\nexport const x = [defineServerConfig, fs];\n`,
      'apps/web/src/bad.ts',
    );
    const restricted = messages.filter((m) => m.ruleId === 'no-restricted-imports');
    expect(restricted).toHaveLength(2);
  });

  it('allows apps/web to import @app/contracts', async () => {
    const messages = await lintSnippet(
      `import type { Something } from '@app/contracts';\nexport type T = Something;\n`,
      'apps/web/src/ok.ts',
    );
    const restricted = messages.filter((m) => m.ruleId === 'no-restricted-imports');
    expect(restricted).toHaveLength(0);
  });

  it('blocks packages/core from importing Node IO, Drizzle, Nest, or non-contracts packages', async () => {
    const messages = await lintSnippet(
      [
        `import fs from 'node:fs';`,
        `import { sql } from 'drizzle-orm';`,
        `import { Injectable } from '@nestjs/common';`,
        `import { x } from '@app/db';`,
        `export const bad = [fs, sql, Injectable, x];`,
      ].join('\n'),
      'packages/core/src/bad.ts',
    );
    const restricted = messages.filter((m) => m.ruleId === 'no-restricted-imports');
    expect(restricted).toHaveLength(4);
  });

  it('blocks db, storage, pdf, and llm from importing @nestjs/*', async () => {
    for (const pkg of ['db', 'storage', 'pdf', 'llm']) {
      const messages = await lintSnippet(
        `import { Injectable } from '@nestjs/common';\nexport const x = Injectable;\n`,
        `packages/${pkg}/src/bad.ts`,
      );
      const restricted = messages.filter((m) => m.ruleId === 'no-restricted-imports');
      expect(restricted, `expected @nestjs/* ban in packages/${pkg}`).toHaveLength(1);
    }
  });

  it('blocks apps/api/src and apps/worker/src from importing test helpers or raw db schema', async () => {
    for (const app of ['api', 'worker']) {
      const messages = await lintSnippet(
        [
          `import { a } from '@app/testkit';`,
          `import { b } from '@app/db/testing';`,
          `import { c } from '@app/db/schema/documents';`,
          `export const bad = [a, b, c];`,
        ].join('\n'),
        `apps/${app}/src/bad.ts`,
      );
      const restricted = messages.filter((m) => m.ruleId === 'no-restricted-imports');
      expect(restricted, `expected test/schema ban in apps/${app}/src`).toHaveLength(3);
    }
  });
});
