import type { DateOrder, FieldType } from '@app/contracts/status';
import {
  canonicalDecimal,
  equalValues,
  parseTypedValue,
  type MoneyValue,
  type TypedValue,
} from '@app/contracts/values';
import { matchNormalize } from '../text/normalize.js';

export interface ExtractedToken {
  readonly raw: string;
  readonly start: number;
  readonly end: number;
  readonly value: TypedValue;
  readonly ambiguousDate?: boolean;
}

const SUPPORTED_MONEY_CURRENCIES: ReadonlySet<string> = new Set(['USD', 'EUR', 'GBP']);
const CURRENCY_SYMBOL_TO_ISO: Readonly<Record<string, string>> = {
  $: 'USD',
  '€': 'EUR',
  '£': 'GBP',
};

// Verified money tokenizer regex from spec §5.5 (bounded, zero nested quantifiers).
const MONEY_TOKEN_REGEX =
  /(?<![\w.])(?<neg>-)?(?<open>\()?(?:(?<pre>USD|EUR|GBP|CAD|AUD|NZD|HKD|SGD|MXN|JPY|CHF|CNY|INR)\s?)?(?<sym>[$€£])?\s?(?<num>\d{1,3}(?:,\d{3})+|\d+)(?:\.(?<frac>\d+))?(?:\s?(?<post>USD|EUR|GBP|CAD|AUD|NZD|HKD|SGD|MXN|JPY|CHF|CNY|INR)\b)?(?:(?<close>\))(?:\s?(?<post2>USD|EUR|GBP|CAD|AUD|NZD|HKD|SGD|MXN|JPY|CHF|CNY|INR)\b)?)?/g;

const PERCENT_TOKEN_REGEX =
  /(?<![\w.])(?<num>-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)\s*(?:%|(?:percent|per cent)\b)/gi;

const DATE_ISO_REGEX = /(?<!\d)\d{4}-\d{2}-\d{2}(?!\d)/g;
const DATE_YMD_SLASH_REGEX = /(?<!\d)\d{4}\/\d{1,2}\/\d{1,2}(?!\d)/g;
const DATE_MONTH_FIRST_REGEX =
  /\b(?:January|Jan|February|Feb|March|Mar|April|Apr|May|June|Jun|July|Jul|August|Aug|September|Sep|Sept|October|Oct|November|Nov|December|Dec)\.?\s+\d{1,2},?\s+\d{4}\b/gi;
const DATE_DAY_FIRST_REGEX =
  /\b\d{1,2}\s+(?:January|Jan|February|Feb|March|Mar|April|Apr|May|June|Jun|July|Jul|August|Aug|September|Sep|Sept|October|Oct|November|Nov|December|Dec)\.?,?\s+\d{4}\b/gi;
const DATE_NUMERIC_REGEX = /(?<!\d)(\d{1,2})([/-])(\d{1,2})\2(\d{4})(?!\d)/g;

const LIST_ORDINAL_PREFIX_REGEX = /^(\s*\d+[.)]\s)/;

const SMALL_NUMBER_WORDS: Readonly<Record<string, number>> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
};

const TENS_WORDS: Readonly<Record<string, number>> = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};

const NUMBER_WORD_LIST = [
  ...Object.keys(SMALL_NUMBER_WORDS),
  ...Object.keys(TENS_WORDS),
  'hundred',
  'thousand',
].join('|');

const SPELLED_NUMBER_REGEX = new RegExp(
  `\\b(?:${NUMBER_WORD_LIST})(?:(?:[\\s-]+(?:and[\\s-]+)?)(?:${NUMBER_WORD_LIST}))*\\b(?:\\s*\\(\\s*(\\d{1,3}(?:,\\d{3})*|\\d+)\\s*\\))?`,
  'gi',
);

const PLAIN_NUMBER_REGEX =
  /(?<![\w.$€£/-])(?<num>-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)(?![\w%/-])/g;

export function extractMoneyTokens(span: string): ExtractedToken[] {
  const tokens: ExtractedToken[] = [];
  MONEY_TOKEN_REGEX.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = MONEY_TOKEN_REGEX.exec(span)) !== null) {
    const groups = match.groups;
    if (!groups) {
      continue;
    }

    const neg = groups['neg'];
    const open = groups['open'];
    const pre = groups['pre'];
    const sym = groups['sym'];
    const num = groups['num'];
    const frac = groups['frac'];
    const post = groups['post'];
    const close = groups['close'];
    const post2 = groups['post2'];

    if (!num) {
      continue;
    }

    // Rule 1: at least one currency marker is required.
    const markers: string[] = [];
    if (pre) markers.push(pre);
    if (sym && CURRENCY_SYMBOL_TO_ISO[sym]) markers.push(CURRENCY_SYMBOL_TO_ISO[sym]!);
    if (post) markers.push(post);
    if (post2) markers.push(post2);

    if (markers.length === 0) {
      continue;
    }

    // Rule 2: reject unsupported ISO currencies (CAD, AUD, etc.).
    if (markers.some((m) => !SUPPORTED_MONEY_CURRENCIES.has(m))) {
      continue;
    }

    // Rule 3: all currency markers must agree.
    const currency = markers[0]!;
    if (markers.some((m) => m !== currency)) {
      continue;
    }

    // Rule 4: negative means leading `-` OR paired `(` … `)`.
    // Unmatched `)` is ignored (e.g. `(up to $2,540)` -> +2540).
    const isParenNegative = Boolean(open && close);
    if (neg && isParenNegative) {
      continue;
    }

    const rawDecimal =
      frac !== undefined ? `${num.replaceAll(',', '')}.${frac}` : num.replaceAll(',', '');
    let amount: string;
    try {
      amount = canonicalDecimal(rawDecimal);
    } catch {
      continue;
    }

    const isNegative = Boolean(neg) || isParenNegative;
    const signedAmount = isNegative && amount !== '0' ? `-${amount}` : amount;

    // Exclude an unmatched trailing `)` from the token span when open wasn't matched.
    let end = match.index + match[0].length;
    let raw = match[0];
    if (!open && close && !post2 && raw.endsWith(')')) {
      raw = raw.slice(0, -1);
      end -= 1;
    }

    const value: MoneyValue = { amount: signedAmount, currency };
    tokens.push({
      raw,
      start: match.index,
      end,
      value,
    });
  }

  return tokens;
}

export function extractPercentTokens(span: string): ExtractedToken[] {
  const tokens: ExtractedToken[] = [];
  PERCENT_TOKEN_REGEX.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = PERCENT_TOKEN_REGEX.exec(span)) !== null) {
    const rawNum = match.groups?.['num'];
    if (!rawNum) {
      continue;
    }
    try {
      const value = canonicalDecimal(rawNum.replaceAll(',', ''));
      tokens.push({
        raw: match[0],
        start: match.index,
        end: match.index + match[0].length,
        value,
      });
    } catch {
      // ignore unparseable
    }
  }

  return tokens;
}

export function extractDateTokens(span: string, dateOrder: DateOrder): ExtractedToken[] {
  const candidates: ExtractedToken[] = [];

  const collect = (regex: RegExp, checkAmbiguous = false): void => {
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(span)) !== null) {
      const raw = match[0];
      const parsed = parseTypedValue('date', raw, { dateOrder });
      if (!parsed.ok) {
        continue;
      }
      let ambiguousDate = false;
      if (checkAmbiguous && match[1] && match[3]) {
        const a = Number(match[1]);
        const b = Number(match[3]);
        if (a <= 12 && b <= 12 && a !== b) {
          ambiguousDate = true;
        }
      }
      candidates.push({
        raw,
        start: match.index,
        end: match.index + raw.length,
        value: parsed.value,
        ambiguousDate,
      });
    }
  };

  collect(DATE_ISO_REGEX);
  collect(DATE_YMD_SLASH_REGEX);
  collect(DATE_MONTH_FIRST_REGEX);
  collect(DATE_DAY_FIRST_REGEX);
  collect(DATE_NUMERIC_REGEX, true);

  // Sort by start ascending, longest match first, and drop overlapping shorter matches.
  candidates.sort((a, b) => a.start - b.start || b.end - a.end);
  const nonOverlapping: ExtractedToken[] = [];
  for (const token of candidates) {
    const prev = nonOverlapping[nonOverlapping.length - 1];
    if (prev && token.start < prev.end) {
      continue;
    }
    nonOverlapping.push(token);
  }
  return nonOverlapping;
}

/**
 * Parses English spelled-out non-negative integers 0..999,999 (spec §5.5).
 */
export function parseSpelledNumber(phrase: string): number | null {
  const words = phrase
    .toLowerCase()
    .split(/[\s-]+/u)
    .filter((w) => w.length > 0 && w !== 'and');

  if (words.length === 0) {
    return null;
  }

  let total = 0;
  let current = 0;
  let sawAny = false;

  for (const word of words) {
    if (word in SMALL_NUMBER_WORDS) {
      current += SMALL_NUMBER_WORDS[word]!;
      sawAny = true;
    } else if (word in TENS_WORDS) {
      current += TENS_WORDS[word]!;
      sawAny = true;
    } else if (word === 'hundred') {
      if (current === 0) {
        current = 1;
      }
      current *= 100;
      sawAny = true;
    } else if (word === 'thousand') {
      if (current === 0) {
        current = 1;
      }
      total += current * 1000;
      current = 0;
      sawAny = true;
    } else {
      return null;
    }
  }

  if (!sawAny) {
    return null;
  }
  const result = total + current;
  return result >= 0 && result <= 999_999 ? result : null;
}

function spansOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

export function extractNumberTokens(span: string): ExtractedToken[] {
  const tokens: ExtractedToken[] = [];
  const excludedSpans: Array<[number, number]> = [];

  // 1. Exclude list ordinal prefix at start of span (e.g. `2. TERM.`) or right after `\n`.
  const leadingOrd = LIST_ORDINAL_PREFIX_REGEX.exec(span);
  if (leadingOrd) {
    excludedSpans.push([0, leadingOrd[0].length]);
  }
  const newlineOrdRegex = /\n(\s*\d+[.)]\s)/g;
  let ordMatch: RegExpExecArray | null;
  while ((ordMatch = newlineOrdRegex.exec(span)) !== null) {
    excludedSpans.push([ordMatch.index + 1, ordMatch.index + ordMatch[0].length]);
  }

  // 2. Exclude money, percent, and date spans so digits inside `$5,230.29`, `4.2%`, or `2025-09-14`
  //    aren't misread as standalone numbers.
  for (const tok of extractMoneyTokens(span)) {
    excludedSpans.push([tok.start, tok.end]);
  }
  for (const tok of extractPercentTokens(span)) {
    excludedSpans.push([tok.start, tok.end]);
  }
  for (const tok of extractDateTokens(span, 'MDY')) {
    excludedSpans.push([tok.start, tok.end]);
  }

  // 3. Parse spelled-out numbers (and paired `twenty-four (24)` forms).
  SPELLED_NUMBER_REGEX.lastIndex = 0;
  let spelledMatch: RegExpExecArray | null;
  while ((spelledMatch = SPELLED_NUMBER_REGEX.exec(span)) !== null) {
    const start = spelledMatch.index;
    const end = start + spelledMatch[0].length;
    if (excludedSpans.some(([es, ee]) => spansOverlap(start, end, es, ee))) {
      continue;
    }

    const full = spelledMatch[0];
    const parenDigits = spelledMatch[1];
    const wordPart = parenDigits !== undefined ? full.slice(0, full.indexOf('(')).trim() : full;
    const parsedWord = parseSpelledNumber(wordPart);
    if (parsedWord === null) {
      continue;
    }

    // Always exclude this span from plain-number extraction so `(24)` or mismatched `(12)` is handled here.
    excludedSpans.push([start, end]);

    if (parenDigits !== undefined) {
      const numericParen = Number(parenDigits.replaceAll(',', ''));
      if (numericParen !== parsedWord) {
        // Spec §5.5: forms like "twenty-four (12)" disagree -> check fails (emit no token).
        continue;
      }
    }

    tokens.push({
      raw: full,
      start,
      end,
      value: String(parsedWord),
    });
  }

  // 4. Parse standalone numeric tokens not covered by excluded spans.
  PLAIN_NUMBER_REGEX.lastIndex = 0;
  let numMatch: RegExpExecArray | null;
  while ((numMatch = PLAIN_NUMBER_REGEX.exec(span)) !== null) {
    const rawNum = numMatch.groups?.['num'];
    if (!rawNum) {
      continue;
    }
    const start = numMatch.index;
    const end = start + numMatch[0].length;
    if (excludedSpans.some(([es, ee]) => spansOverlap(start, end, es, ee))) {
      continue;
    }
    try {
      const value = canonicalDecimal(rawNum.replaceAll(',', ''));
      tokens.push({
        raw: numMatch[0],
        start,
        end,
        value,
      });
    } catch {
      // ignore
    }
  }

  tokens.sort((a, b) => a.start - b.start);
  return tokens;
}

export function extractTypedTokens(
  fieldType: FieldType,
  span: string,
  dateOrder: DateOrder,
): ExtractedToken[] {
  switch (fieldType) {
    case 'money':
      return extractMoneyTokens(span);
    case 'date':
      return extractDateTokens(span, dateOrder);
    case 'number':
      return extractNumberTokens(span);
    case 'percent':
      return extractPercentTokens(span);
    case 'string':
      return [];
  }
}

export function supportedByString(value: string, quote: string): boolean {
  const normVal = matchNormalize(value).toLowerCase();
  if (normVal.length === 0) {
    return false;
  }
  return matchNormalize(quote).toLowerCase().includes(normVal);
}

/**
 * Counts distinct canonical values among extracted tokens.
 */
export function countDistinctTokenValues(
  fieldType: FieldType,
  tokens: readonly ExtractedToken[],
): number {
  const distinct: TypedValue[] = [];
  for (const tok of tokens) {
    if (!distinct.some((existing) => equalValues(fieldType, existing, tok.value))) {
      distinct.push(tok.value);
    }
  }
  return distinct.length;
}

export interface LineAnchorInfo {
  readonly isWeak: boolean;
  readonly labelAnchor: string;
  readonly letterCount: number;
}

/**
 * Removes typed tokens of `fieldType` from a canonical line to determine:
 * - `isWeak`: for scalar types only, true when no letter remains (`WEAK_EVIDENCE_LINE`).
 *   `string` fields are NEVER weak (spec §5.5).
 * - `labelAnchor`: normalized remaining text (`L`) used by `CONFLICTING_LINES` and `POSSIBLE_AMENDMENT`.
 */
export function analyzeLineAnchor(
  fieldType: FieldType,
  canonicalLine: string,
  dateOrder: DateOrder,
): LineAnchorInfo {
  if (fieldType === 'string') {
    return { isWeak: false, labelAnchor: '', letterCount: 0 };
  }

  const tokens = extractTypedTokens(fieldType, canonicalLine, dateOrder);
  let remaining = '';
  let cursor = 0;
  for (const tok of tokens) {
    if (tok.start > cursor) {
      remaining += canonicalLine.slice(cursor, tok.start);
    }
    cursor = Math.max(cursor, tok.end);
  }
  if (cursor < canonicalLine.length) {
    remaining += canonicalLine.slice(cursor);
  }

  const labelAnchor = matchNormalize(remaining);
  const letters = labelAnchor.match(/\p{L}/gu);
  const letterCount = letters ? letters.length : 0;

  return {
    isWeak: letterCount === 0,
    labelAnchor,
    letterCount,
  };
}
