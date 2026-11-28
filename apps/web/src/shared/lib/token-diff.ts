export type DiffTokenKind = 'same' | 'removed' | 'added';

export interface DiffToken {
  readonly kind: DiffTokenKind;
  readonly text: string;
}

const MAX_LCS_TOKENS = 400;

function tokenize(text: string): string[] {
  if (text.length === 0) return [];
  return text.match(/\S+|\s+/g) ?? [];
}

function coalesce(tokens: DiffToken[]): DiffToken[] {
  const out: DiffToken[] = [];
  for (const tok of tokens) {
    if (tok.text.length === 0) continue;
    const prev = out[out.length - 1];
    if (prev && prev.kind === tok.kind) {
      out[out.length - 1] = { kind: prev.kind, text: prev.text + tok.text };
    } else {
      out.push(tok);
    }
  }
  return out;
}

/**
 * Pure word-and-whitespace-preserving token diff between two canonical evidence lines.
 * Falls back cleanly to a whole-line replace when lines exceed the quadratic LCS guard.
 */
export function diffTokens(previous: string, current: string): DiffToken[] {
  if (previous === current) {
    return previous.length > 0 ? [{ kind: 'same', text: previous }] : [];
  }
  if (previous.length === 0) {
    return [{ kind: 'added', text: current }];
  }
  if (current.length === 0) {
    return [{ kind: 'removed', text: previous }];
  }

  const a = tokenize(previous);
  const b = tokenize(current);

  if (a.length > MAX_LCS_TOKENS || b.length > MAX_LCS_TOKENS) {
    return [
      { kind: 'removed', text: previous },
      { kind: 'added', text: current },
    ];
  }

  const m = a.length;
  const n = b.length;
  // Flat (m+1) x (n+1) LCS length table
  const dp = new Int32Array((m + 1) * (n + 1));
  const idx = (i: number, j: number) => i * (n + 1) + j;

  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      if (a[i] === b[j]) {
        dp[idx(i, j)] = dp[idx(i + 1, j + 1)]! + 1;
      } else {
        const down = dp[idx(i + 1, j)]!;
        const right = dp[idx(i, j + 1)]!;
        dp[idx(i, j)] = down >= right ? down : right;
      }
    }
  }

  const raw: DiffToken[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      raw.push({ kind: 'same', text: a[i]! });
      i += 1;
      j += 1;
    } else if (dp[idx(i + 1, j)]! >= dp[idx(i, j + 1)]!) {
      raw.push({ kind: 'removed', text: a[i]! });
      i += 1;
    } else {
      raw.push({ kind: 'added', text: b[j]! });
      j += 1;
    }
  }
  while (i < m) {
    raw.push({ kind: 'removed', text: a[i]! });
    i += 1;
  }
  while (j < n) {
    raw.push({ kind: 'added', text: b[j]! });
    j += 1;
  }

  return coalesce(raw);
}
