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
  it('blocks apps/web/src from importing @app/config/server-config, bare or prefixed Node built-ins, and relative escapes', async () => {
    const messages = await lintSnippet(
      [
        `import { defineServerConfig } from '@app/config/server-config';`,
        `import fs from 'node:fs';`,
        `import path from 'path';`,
        `import { x } from '../../../packages/config/src/server-config.js';`,
        `export const bad = [defineServerConfig, fs, path, x];`,
      ].join('\n'),
      'apps/web/src/bad.ts',
    );
    const restricted = messages.filter((m) => m.ruleId === 'no-restricted-imports');
    expect(restricted).toHaveLength(4);
  });

  it('allows apps/web config files (e.g. vite.config.ts) to import Node built-ins', async () => {
    const messages = await lintSnippet(
      `import path from 'node:path';\nexport default { root: path.resolve('.') };\n`,
      'apps/web/vite.config.ts',
    );
    const restricted = messages.filter((m) => m.ruleId === 'no-restricted-imports');
    expect(restricted).toHaveLength(0);
  });

  it('allows apps/web to import @app/contracts', async () => {
    const messages = await lintSnippet(
      `import type { Something } from '@app/contracts';\nexport type T = Something;\n`,
      'apps/web/src/ok.ts',
    );
    const restricted = messages.filter((m) => m.ruleId === 'no-restricted-imports');
    expect(restricted).toHaveLength(0);
  });

  it('blocks packages/core from importing Node IO (bare or prefixed), Drizzle, Nest, non-contracts packages, or relative escapes', async () => {
    const messages = await lintSnippet(
      [
        `import fs from 'node:fs';`,
        `import { EventEmitter } from 'events';`,
        `import { sql } from 'drizzle-orm';`,
        `import { Injectable } from '@nestjs/common';`,
        `import { x } from '@app/db';`,
        `import { y } from '@app/api';`,
        `import { z } from '../../db/src/index.js';`,
        `export const bad = [fs, EventEmitter, sql, Injectable, x, y, z];`,
      ].join('\n'),
      'packages/core/src/bad.ts',
    );
    const restricted = messages.filter((m) => m.ruleId === 'no-restricted-imports');
    expect(restricted).toHaveLength(7);
  });

  it('blocks packages/contracts from importing bare Node built-ins, workspace packages, or relative escapes', async () => {
    const messages = await lintSnippet(
      [
        `import crypto from 'crypto';`,
        `import { a } from '@app/core';`,
        `import { b } from '../../core/src/index.js';`,
        `export const bad = [crypto, a, b];`,
      ].join('\n'),
      'packages/contracts/src/bad.ts',
    );
    const restricted = messages.filter((m) => m.ruleId === 'no-restricted-imports');
    expect(restricted).toHaveLength(3);
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

  it('blocks apps/api/src and apps/worker/src from importing test helpers or raw db schema (package or relative)', async () => {
    for (const app of ['api', 'worker']) {
      const messages = await lintSnippet(
        [
          `import { a } from '@app/testkit';`,
          `import { b } from '@app/db/testing';`,
          `import { c } from '@app/db/schema/documents';`,
          `import { d } from '../../../packages/db/src/schema/documents.js';`,
          `import { documents } from '@app/db';`,
          `export const bad = [a, b, c, d, documents];`,
        ].join('\n'),
        `apps/${app}/src/bad.ts`,
      );
      const restricted = messages.filter((m) => m.ruleId === 'no-restricted-imports');
      expect(restricted, `expected test/schema ban in apps/${app}/src`).toHaveLength(5);
    }
  });
});
