import { describe, expect, it } from 'vitest';
import commitlintConfig from '../../../commitlint.config.js';

const noAiAttribution = commitlintConfig.plugins[0]!.rules['no-ai-attribution']!;

describe('commitlint config', () => {
  it('accepts a clean conventional commit message', () => {
    const [ok] = noAiAttribution({
      raw: 'chore(infra): scaffold monorepo, config, and infra compose',
    });
    expect(ok).toBe(true);
  });

  it('rejects AI attribution trailers and markers', () => {
    const samples = [
      'feat(core): add parser\n\nCo-Authored-By: Claude <noreply@anthropic.com>',
      'feat(core): add parser\n\nGenerated with Claude Code',
      'feat(core): add parser 🤖',
      'feat(core): add parser\n\nCo-Authored-By: GitHub Copilot <copilot@github.com>',
    ];
    for (const raw of samples) {
      const [ok] = noAiAttribution({ raw });
      expect(ok, `expected rejection for: ${raw}`).toBe(false);
    }
  });

  it('includes the git-workflow scope list and allows empty scopes', () => {
    expect(commitlintConfig.rules['scope-empty']).toEqual([0]);
    const [, , scopes] = commitlintConfig.rules['scope-enum'] as [number, string, string[]];
    expect(scopes).toEqual(
      expect.arrayContaining([
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
      ]),
    );
  });
});
