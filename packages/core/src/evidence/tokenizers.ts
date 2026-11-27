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

const ISO_CODES_ALT = 'USD|EUR|GBP|CAD|AUD|NZD|HKD|SGD|MXN|JPY|CHF|CNY|INR';

// Hardened money tokenizer based on spec §5.5:
// - Allows bounded horizontal whitespace around markers ([ \t]{0,4})
// - Allows negative sign before or after currency marker (-$10, $-10, USD -10)
// - Captures surrounding unsupported currencies and enforces trailing boundaries in code
const MONEY_TOKEN_REGEX = new RegExp(
  `(?<![\\w.])(?<neg1>-)?(?<open>\\()?(?:(?<pre>${ISO_CODES_ALT})[ \\t]{0,4})?(?<neg2>-)?(?<sym>[$€£])?[ \\t]{0,4}(?<neg3>-)?(?<num>\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.(?<frac>\\d+))?(?:[ \\t]{0,4}(?<post>${ISO_CODES_ALT})\\b)?(?:(?<close>\\))(?:[ \\t]{0,4}(?<post2>${ISO_CODES_ALT})\\b)?)?`,
  'g',
);

const LEADING_ISO_PREFIX_REGEX = new RegExp(`\\b(${ISO_CODES_ALT})[ \\t]*[-+(]?[ \\t]*$`);

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

const UNITS_WORDS: Readonly<Record<string, number>> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
};

const TEENS_WORDS: Readonly<Record<string, number>> = {
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

const ALL_NUMBER_WORDS: ReadonlySet<string> = new Set([
  'zero',
  ...Object.keys(UNITS_WORDS),
  ...Object.keys(TEENS_WORDS),
  ...Object.keys(TENS_WORDS),
  'hundred',
  'thousand',
]);

const WORD_TOKEN_REGEX = /[A-Za-z]+/g;
const PAREN_NUMBER_SUFFIX_REGEX = /^\s*\(\s*(\d{1,3}(?:,\d{3})*|\d+)\s*\)/;

const PLAIN_NUMBER_REGEX =
  /(?<![\w.$€£/-])(?<num>-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)(?![\w%/-])/g;

function spansOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
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

export function extractMoneyTokens(span: string): ExtractedToken[] {
  const tokens: ExtractedToken[] = [];
  const dateSpans: Array<[number, number]> = extractDateTokens(span, 'MDY').map((d) => [
    d.start,
    d.end,
  ]);
  MONEY_TOKEN_REGEX.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = MONEY_TOKEN_REGEX.exec(span)) !== null) {
    const groups = match.groups;
    if (!groups) {
      continue;
    }

    const neg1 = groups['neg1'];
    const open = groups['open'];
    const pre = groups['pre'];
    const neg2 = groups['neg2'];
    const sym = groups['sym'];
    const neg3 = groups['neg3'];
    const num = groups['num'];
    const frac = groups['frac'];
    const post = groups['post'];
    const close = groups['close'];
    const post2 = groups['post2'];

    if (!num) {
      continue;
    }

    // Exclude any digits belonging to a date (e.g. `2025-09-14 USD` must never yield `14 USD`).
    const matchStart = match.index;
    const matchEndFull = match.index + match[0].length;
    if (dateSpans.some(([ds, de]) => spansOverlap(matchStart, matchEndFull, ds, de))) {
      continue;
    }

    // Rule 1: collect all currency markers, including any immediately preceding ISO code
    // that separated from `$` via `-`, `(`, or whitespace (e.g. `CAD -$1,234.00`, `CAD ($1,234.00)`).
    const markers: string[] = [];
    const lookbehind = span.slice(Math.max(0, matchStart - 12), matchStart);
    const prefixIso = LEADING_ISO_PREFIX_REGEX.exec(lookbehind);
    if (prefixIso?.[1]) {
      markers.push(prefixIso[1]);
    }
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

    // Rule 4: negative means a single `-` OR paired `(` … `)`. Reject conflicting signs.
    const isParenNegative = Boolean(open && close);
    const minusCount = (neg1 ? 1 : 0) + (neg2 ? 1 : 0) + (neg3 ? 1 : 0);
    if (minusCount > 1 || (minusCount > 0 && isParenNegative)) {
      continue;
    }

    // Exclude an unmatched trailing `)` from the token span when open wasn't matched.
    let end = matchEndFull;
    let raw = match[0];
    if (!open && close && !post2 && raw.endsWith(')')) {
      raw = raw.slice(0, -1);
      end -= 1;
    }

    // Rule 5: enforce trailing boundary so `$1.5M`, `$100k`, `$100%`, `$1,2345` are rejected.
    const nextChar = span[end];
    if (nextChar !== undefined) {
      if (/[A-Za-z0-9%]/.test(nextChar)) {
        continue;
      }
      if ((nextChar === '.' || nextChar === ',') && span[end + 1] && /\d/.test(span[end + 1]!)) {
        continue;
      }
    }

    const rawDecimal =
      frac !== undefined ? `${num.replaceAll(',', '')}.${frac}` : num.replaceAll(',', '');
    let amount: string;
    try {
      amount = canonicalDecimal(rawDecimal);
    } catch {
      continue;
    }

    const isNegative = minusCount === 1 || isParenNegative;
    const signedAmount = isNegative && amount !== '0' ? `-${amount}` : amount;

    const value: MoneyValue = { amount: signedAmount, currency };
    tokens.push({
      raw,
      start: matchStart,
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

interface WordSpan {
  readonly word: string;
  readonly start: number;
  readonly end: number;
}

/**
 * Parses a strictly valid English `<1000` number group (1..999) starting at `words[idx]`.
 * Grammar:
 *   under1000 := (UNIT "hundred" (["and"] under100)?) | under100
 *   under100  := TEEN | (TENS UNIT?) | UNIT
 */
function parseUnderThousandGroup(
  words: readonly WordSpan[],
  startIdx: number,
  canJoin: (prevEnd: number, nextStart: number) => boolean,
): { value: number; nextIdx: number } | null {
  let idx = startIdx;
  const w0 = words[idx]?.word;
  if (!w0) {
    return null;
  }

  let total = 0;
  let consumed = false;

  // Optional `UNIT hundred`
  if (
    w0 in UNITS_WORDS &&
    idx + 1 < words.length &&
    words[idx + 1]!.word === 'hundred' &&
    canJoin(words[idx]!.end, words[idx + 1]!.start)
  ) {
    total += UNITS_WORDS[w0]! * 100;
    idx += 2;
    consumed = true;

    // Optional `and` ONLY after `hundred` if followed by a valid <100 number
    if (
      idx < words.length &&
      words[idx]!.word === 'and' &&
      canJoin(words[idx - 1]!.end, words[idx]!.start) &&
      idx + 1 < words.length &&
      canJoin(words[idx]!.end, words[idx + 1]!.start)
    ) {
      const afterAnd = words[idx + 1]!.word;
      if (afterAnd in UNITS_WORDS || afterAnd in TEENS_WORDS || afterAnd in TENS_WORDS) {
        idx += 1;
      } else {
        return { value: total, nextIdx: idx };
      }
    }
  }

  // Optional <100 tail (if continuing after hundred, verify separator)
  if (idx < words.length && (!consumed || canJoin(words[idx - 1]!.end, words[idx]!.start))) {
    const w = words[idx]!.word;
    if (w in TEENS_WORDS) {
      total += TEENS_WORDS[w]!;
      idx += 1;
      consumed = true;
    } else if (w in TENS_WORDS) {
      total += TENS_WORDS[w]!;
      idx += 1;
      consumed = true;
      if (
        idx < words.length &&
        words[idx]!.word in UNITS_WORDS &&
        canJoin(words[idx - 1]!.end, words[idx]!.start)
      ) {
        total += UNITS_WORDS[words[idx]!.word]!;
        idx += 1;
      }
    } else if (w in UNITS_WORDS) {
      total += UNITS_WORDS[w]!;
      idx += 1;
      consumed = true;
    }
  }

  return consumed ? { value: total, nextIdx: idx } : null;
}

/**
 * Parses a strictly valid English spelled-out number 0..999,999 starting at `words[startIdx]`.
 * Grammar:
 *   number := "zero" | (under1000 "thousand" (["and"] under1000)?) | under1000
 */
function parseSpelledFromWords(
  words: readonly WordSpan[],
  startIdx: number,
  canJoin: (prevEnd: number, nextStart: number) => boolean,
): { value: number; nextIdx: number } | null {
  const first = words[startIdx];
  if (!first) {
    return null;
  }
  if (first.word === 'zero') {
    return { value: 0, nextIdx: startIdx + 1 };
  }

  const head = parseUnderThousandGroup(words, startIdx, canJoin);
  if (!head) {
    return null;
  }

  let idx = head.nextIdx;
  if (
    idx < words.length &&
    words[idx]!.word === 'thousand' &&
    canJoin(words[idx - 1]!.end, words[idx]!.start)
  ) {
    let total = head.value * 1000;
    idx += 1;

    let tailStart = idx;
    if (
      tailStart < words.length &&
      words[tailStart]!.word === 'and' &&
      canJoin(words[tailStart - 1]!.end, words[tailStart]!.start)
    ) {
      tailStart += 1;
    }

    if (tailStart < words.length && canJoin(words[tailStart - 1]!.end, words[tailStart]!.start)) {
      const tail = parseUnderThousandGroup(words, tailStart, canJoin);
      if (tail) {
        total += tail.value;
        idx = tail.nextIdx;
      }
    }

    return total <= 999_999 ? { value: total, nextIdx: idx } : null;
  }

  return head;
}

/**
 * Parses a standalone English spelled-out integer 0..999,999 via strict grammar (spec §5.5).
 * Rejects invalid combinations like `"one and two"`, `"twenty thirty"`, `"one hundred hundred"`.
 */
export function parseSpelledNumber(phrase: string): number | null {
  const words: WordSpan[] = [];
  WORD_TOKEN_REGEX.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WORD_TOKEN_REGEX.exec(phrase)) !== null) {
    words.push({
      word: m[0].toLowerCase(),
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  if (words.length === 0) {
    return null;
  }

  const canJoin = (prevEnd: number, nextStart: number): boolean =>
    /^[\s-]+$/u.test(phrase.slice(prevEnd, nextStart));

  const parsed = parseSpelledFromWords(words, 0, canJoin);
  if (!parsed || parsed.nextIdx !== words.length) {
    return null;
  }
  return parsed.value;
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

  // 3. Parse spelled-out numbers with strict grammar (stopping cleanly on non-grammar boundaries
  //    so `"one and two"` yields `1` and `2` separately instead of `3`, and handling `"twenty-four (24)"`).
  const words: WordSpan[] = [];
  WORD_TOKEN_REGEX.lastIndex = 0;
  let wm: RegExpExecArray | null;
  while ((wm = WORD_TOKEN_REGEX.exec(span)) !== null) {
    words.push({
      word: wm[0].toLowerCase(),
      start: wm.index,
      end: wm.index + wm[0].length,
    });
  }

  const canJoinWords = (prevEnd: number, nextStart: number): boolean =>
    /^[\s-]+$/u.test(span.slice(prevEnd, nextStart));

  let wi = 0;
  while (wi < words.length) {
    const w = words[wi]!;
    if (!ALL_NUMBER_WORDS.has(w.word)) {
      wi += 1;
      continue;
    }

    const parsed = parseSpelledFromWords(words, wi, canJoinWords);
    if (!parsed) {
      wi += 1;
      continue;
    }

    const start = w.start;
    let end = words[parsed.nextIdx - 1]!.end;
    wi = parsed.nextIdx;

    if (excludedSpans.some(([es, ee]) => spansOverlap(start, end, es, ee))) {
      continue;
    }

    // Check for optional repeating parenthesized digits: `twenty-four (24)`.
    const suffixMatch = PAREN_NUMBER_SUFFIX_REGEX.exec(span.slice(end));
    if (suffixMatch?.[1]) {
      const parenEnd = end + suffixMatch[0].length;
      const numericParen = Number(suffixMatch[1].replaceAll(',', ''));
      excludedSpans.push([start, parenEnd]);
      if (numericParen !== parsed.value) {
        // Disagreement (e.g. `twenty-four (12)`) -> reject both!
        continue;
      }
      end = parenEnd;
    } else {
      excludedSpans.push([start, end]);
    }

    tokens.push({
      raw: span.slice(start, end),
      start,
      end,
      value: String(parsed.value),
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
