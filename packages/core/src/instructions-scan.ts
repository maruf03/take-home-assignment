export interface InstructionScanResult {
  readonly suspicious: boolean;
  readonly matches: string[];
}

const MAX_MATCHES = 5;

const SUSPICIOUS_PATTERNS: readonly RegExp[] = [
  /\bignore\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|above|earlier)\s+instructions?\b/gi,
  /\bdisregard\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|above|earlier)\s+instructions?\b/gi,
  /\bsystem\s+prompt\b/gi,
  /\byou\s+are\s+(?:now|no\s+longer)\b/gi,
  /<\|?\s*(?:system|assistant|user)\s*\|?>/gi,
  /^\s*(?:system|assistant)\s*:/gim,
  /<\/?document(?:-[a-z0-9]{4,}|[\s>])/gi,
];

/**
 * Deterministic prompt-injection scanner (spec §5.7).
 * Produces badge warnings only; never gates or mutates extracted values.
 */
export function scanInstructions(text: string): InstructionScanResult {
  const matches: string[] = [];

  for (const pattern of SUSPICIOUS_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const snippet = match[0].trim();
      if (snippet.length > 0 && !matches.includes(snippet)) {
        matches.push(snippet);
        if (matches.length >= MAX_MATCHES) {
          return { suspicious: true, matches };
        }
      }
    }
  }

  return {
    suspicious: matches.length > 0,
    matches,
  };
}
