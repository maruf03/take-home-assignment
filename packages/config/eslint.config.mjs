import { builtinModules } from 'node:module';
import js from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier';
import importX from 'eslint-plugin-import-x';
import tseslint from 'typescript-eslint';

const BARE_NODE_BUILTINS = builtinModules
  .filter((name) => !name.startsWith('node:'))
  .flatMap((name) => [name, `${name}/*`]);

const NODE_BUILTIN_PATTERNS = ['node:*', ...BARE_NODE_BUILTINS];

const CORE_FORBIDDEN_WORKSPACE_DIRS = ['config', 'db', 'storage', 'pdf', 'llm', 'testkit'];
const WEB_FORBIDDEN_WORKSPACE_DIRS = ['config', 'core', 'db', 'storage', 'pdf', 'llm', 'testkit'];

const CORE_FORBIDDEN_PACKAGES = [
  '@app/*',
  '!@app/contracts',
  '!@app/contracts/*',
  ...CORE_FORBIDDEN_WORKSPACE_DIRS.flatMap((dir) => [`**/packages/${dir}/**`, `../../${dir}/**`]),
  '**/apps/**',
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
  ...NODE_BUILTIN_PATTERNS,
];

const WEB_FORBIDDEN_PACKAGES = [
  '@app/*',
  '!@app/contracts',
  '!@app/contracts/*',
  ...WEB_FORBIDDEN_WORKSPACE_DIRS.flatMap((dir) => [`**/packages/${dir}/**`, `../../${dir}/**`]),
  '**/apps/api/**',
  '**/apps/worker/**',
  ...NODE_BUILTIN_PATTERNS,
];

const CONTRACTS_FORBIDDEN_PACKAGES = [
  '@app/*',
  ...WEB_FORBIDDEN_WORKSPACE_DIRS.flatMap((dir) => [`**/packages/${dir}/**`, `../../${dir}/**`]),
  '**/apps/**',
  '@nestjs/*',
  ...NODE_BUILTIN_PATTERNS,
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
    // Boundary 1: apps/web/src imports only @app/contracts among workspace packages and never Node-only modules.
    // Root Vite/Vitest config files (apps/web/*.config.ts) run in Node and are intentionally outside this glob.
    {
      files: ['apps/web/src/**/*.{ts,tsx,js,jsx,mjs}'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            patterns: [
              {
                group: WEB_FORBIDDEN_PACKAGES,
                message:
                  'apps/web/src may only import @app/contracts from workspace packages and cannot import Node-only modules (spec §10.1).',
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
                group: CONTRACTS_FORBIDDEN_PACKAGES,
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
                group: [
                  '@app/db/testing',
                  '@app/db/testing/*',
                  '@app/testkit',
                  '@app/testkit/*',
                  '**/packages/testkit/**',
                  '**/packages/db/src/testing/**',
                ],
                message:
                  'Production app code must never import test helpers (@app/db/testing or @app/testkit) (spec §10.1).',
              },
              {
                group: [
                  '@app/db/schema',
                  '@app/db/schema/*',
                  '**/packages/db/src/schema*',
                  '**/packages/db/src/schema/**',
                ],
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
