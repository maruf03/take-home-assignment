import { describe, expect, it } from 'vitest';
import { diffTokens } from '../../src/shared/lib/token-diff.js';

describe('diffTokens pure helper', () => {
  it('produces token-level same, removed, and added segments preserving whitespace', () => {
    const tokens = diffTokens('Total Amount Due: $5,230.29', 'Total Amount Due: $5,999.99');

    expect(tokens.some((t) => t.kind === 'same' && t.text.includes('Total'))).toBe(true);
    expect(tokens.some((t) => t.kind === 'removed' && t.text === '$5,230.29')).toBe(true);
    expect(tokens.some((t) => t.kind === 'added' && t.text === '$5,999.99')).toBe(true);
    expect(
      tokens
        .filter((t) => t.kind !== 'added')
        .map((t) => t.text)
        .join(''),
    ).toBe('Total Amount Due: $5,230.29');
    expect(
      tokens
        .filter((t) => t.kind !== 'removed')
        .map((t) => t.text)
        .join(''),
    ).toBe('Total Amount Due: $5,999.99');
  });

  it('handles identical and empty strings without losing characters', () => {
    expect(diffTokens('Net 30', 'Net 30')).toEqual([{ kind: 'same', text: 'Net 30' }]);
    expect(diffTokens('', 'Added line')).toEqual([{ kind: 'added', text: 'Added line' }]);
    expect(diffTokens('Old line', '')).toEqual([{ kind: 'removed', text: 'Old line' }]);
  });
});
