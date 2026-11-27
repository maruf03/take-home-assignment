import js from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier';
import importX from 'eslint-plugin-import-x';
import tseslint from 'typescript-eslint';

const CORE_FORBIDDEN_PACKAGES = [
  '@app/config',
  '@app/config/*',
  '@app/db',
  '@app/db/*',
  '@app/storage',
  '@app/storage/*',
  '@app/pdf',
  '@app/pdf/*',
  '@app/llm',
  '@app/llm/*',
  '@app/testkit',
  '@app/testkit/*',
  '@nestjs/*',
  'drizzle-orm',
  'drizzle-orm/*',
  'pg',
  'ioredis',
  'bullmq',
  '@aws-sdk/*',
  '@google/genai',
  '@anthropic-ai/sdk',
  'unpdf',
  'pdfjs-dist',
  'pdfjs-dist/*',
  'tinypool',
  'node:*',
  'fs',
  'path',
  'crypto',
  'child_process',
  'http',
  'https',
  'net',
  'os',
  'process',
  'stream',
  'url',
  'worker_threads',
];

const WEB_FORBIDDEN_PACKAGES = [
  '@app/config',
  '@app/config/*',
  '@app/core',
  '@app/core/*',
  '@app/db',
  '@app/db/*',
  '@app/storage',
  '@app/storage/*',
  '@app/pdf',
  '@app/pdf/*',
  '@app/llm',
  '@app/llm/*',
  '@app/testkit',
  '@app/testkit/*',
  'node:*',
];

export function createEslintConfig() {
  return tseslint.config(
    {
      ignores: [
        '**/dist/**',
        '**/build/**',
        '**/out/**',
        '**/coverage/**',
        '**/node_modules/**',
        '**/.turbo/**',
        'fixtures/**',
        'fixtures-golden/**',
        '.worktrees/**',
        '.superpowers/**',
      ],
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
      plugins: {
        'import-x': importX,
      },
      settings: {
        'import-x/resolver': {
          typescript: {
            alwaysTryTypes: true,
          },
          node: true,
        },
      },
      rules: {
        'import-x/no-cycle': 'error',
        '@typescript-eslint/no-unused-vars': [
          'error',
          { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
        ],
      },
    },
    // Boundary 1: apps/web imports only @app/contracts among workspace packages and never Node-only server config.
    {
      files: ['apps/web/**/*.{ts,tsx,js,jsx,mjs}'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            patterns: [
              {
                group: WEB_FORBIDDEN_PACKAGES,
                message:
                  'apps/web may only import @app/contracts from workspace packages and cannot import Node-only modules (spec §10.1).',
              },
            ],
          },
        ],
      },
    },
    // Boundary 2: packages/core is pure — imports only @app/contracts; no IO, Nest, Drizzle, or SDKs.
    {
      files: ['packages/core/src/**/*.{ts,js,mjs}'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            patterns: [
              {
                group: CORE_FORBIDDEN_PACKAGES,
                message:
                  'packages/core must remain pure and import only @app/contracts (spec §10.1).',
              },
            ],
          },
        ],
      },
    },
    // Boundary 3: packages/contracts is shared with web — never Node-only or server packages.
    {
      files: ['packages/contracts/src/**/*.{ts,js,mjs}'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            patterns: [
              {
                group: ['@app/*', '@nestjs/*', 'node:*'],
                message:
                  'packages/contracts is browser-safe and cannot import other workspace packages, Nest, or Node built-ins (spec §10.1).',
              },
            ],
          },
        ],
      },
    },
    // Boundary 4: db, storage, pdf and llm never import Nest.
    {
      files: ['packages/{db,storage,pdf,llm}/**/*.{ts,js,mjs}'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            patterns: [
              {
                group: ['@nestjs/*'],
                message:
                  'Infrastructure packages (db, storage, pdf, llm) must never import Nest (spec §10.1).',
              },
            ],
          },
        ],
      },
    },
    // Boundary 5: production code in apps/* never imports @app/db/testing, @app/testkit, or raw @app/db/schema.
    {
      files: ['apps/{api,worker}/src/**/*.{ts,js,mjs}'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            patterns: [
              {
                group: ['@app/db/testing', '@app/db/testing/*', '@app/testkit', '@app/testkit/*'],
                message:
                  'Production app code must never import test helpers (@app/db/testing or @app/testkit) (spec §10.1).',
              },
              {
                group: ['@app/db/schema', '@app/db/schema/*', '*/packages/db/src/schema*'],
                message:
                  'Raw schema/documents queries are allowed only inside packages/db (spec §10.1).',
              },
            ],
          },
        ],
      },
    },
    eslintConfigPrettier,
  );
}

export default createEslintConfig();
