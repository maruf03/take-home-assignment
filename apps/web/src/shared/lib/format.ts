import type { ValueFlag } from '@app/contracts/status';
import { getUiCopy, type UiCopyKey } from '@app/contracts/ui-copy';

/** Spec §14.2: LINE_HINT_MISMATCH appears in debug views only, never in reviewer rows. */
export const VISIBLE_REVIEWER_FLAGS: ReadonlySet<ValueFlag> = new Set([
  'LOW_VISIBILITY',
  'AMBIGUOUS_OCCURRENCE',
  'TOKEN_AMBIGUOUS',
  'AMBIGUOUS_DATE',
  'QUOTE_FOLDED',
  'WEAK_EVIDENCE_LINE',
  'CONFLICTING_LINES',
]);

export function formatFacetCount(count: number, capped: boolean): string {
  return capped ? '99+' : String(count);
}

export function formatCopy(key: UiCopyKey, vars: Record<string, string | number> = {}): string {
  let text = getUiCopy(key);
  for (const [name, value] of Object.entries(vars)) {
    text = text.replaceAll(`{${name}}`, String(value));
  }
  return text;
}

export function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}
