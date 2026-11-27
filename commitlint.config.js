const SCOPES = [
  'core',
  'contracts',
  'db',
  'pdf',
  'llm',
  'storage',
  'testkit',
  'config',
  'api',
  'worker',
  'web',
  'e2e',
  'ci',
  'infra',
  'docs',
];

const AI_ATTRIBUTION_PATTERNS = [
  /co-authored-by:\s*[^\n]*(claude|anthropic|copilot|openai|chatgpt|codex|cursor|gemini|antigravity|aider|devin|windsurf|codeium|noreply@anthropic\.com|noreply@openai\.com)/i,
  /generated\s+(with|by)\s+[^\n]*\b(claude|anthropic|copilot|openai|chatgpt|codex|cursor|gemini|antigravity|ai)\b/i,
  /🤖/u,
];

export default {
  extends: ['@commitlint/config-conventional'],
  plugins: [
    {
      rules: {
        'no-ai-attribution': (parsed) => {
          const raw = parsed.raw ?? '';
          const matched = AI_ATTRIBUTION_PATTERNS.some((pattern) => pattern.test(raw));
          return [
            !matched,
            'Commit messages must not contain AI/agent attribution trailers or markers (see docs/how-to/git-workflow.md).',
          ];
        },
      },
    },
  ],
  rules: {
    'scope-enum': [2, 'always', SCOPES],
    'scope-empty': [0],
    'subject-full-stop': [2, 'never', '.'],
    'no-ai-attribution': [2, 'always'],
  },
};
