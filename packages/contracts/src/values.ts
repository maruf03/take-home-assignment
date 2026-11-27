import { z } from 'zod';
import type { DateOrder, FieldType } from './status.js';

// Raw regex sources exported so @app/db can embed them directly in SQL CHECKs via sql.raw().
export const CANONICAL_DECIMAL_REGEX_SOURCE = String.raw`^-?(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$`;
export const ISO_DATE_REGEX_SOURCE = String.raw`^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$`;
export const ISO_CURRENCY_REGEX_SOURCE = String.raw`^[A-Z]{3}$`;
export const DOCUMENT_TYPE_KEY_REGEX_SOURCE = String.raw`^[a-z][a-z0-9_]{1,40}$`;
export const FIELD_KEY_REGEX_SOURCE = String.raw`^[a-z][a-z0-9_]{0,62}$`;
export const HEX64_REGEX_SOURCE = String.raw`^[0-9a-f]{64}$`;

export const CANONICAL_DECIMAL_REGEX = new RegExp(CANONICAL_DECIMAL_REGEX_SOURCE);
export const ISO_DATE_REGEX = new RegExp(ISO_DATE_REGEX_SOURCE);
export const ISO_CURRENCY_REGEX = new RegExp(ISO_CURRENCY_REGEX_SOURCE);

export const MAX_STRING_VALUE_LENGTH = 2000;

export interface MoneyValue {
  amount: string;
  currency: string;
}

export type TypedValue = string | MoneyValue;

export interface TemplateValueContext {
  defaultCurrency?: string;
  dateOrder?: DateOrder;
}

export type ParseTypedValueResult = { ok: true; value: TypedValue } | { ok: false; error: string };

const CURRENCY_SYMBOL_TO_ISO: Readonly<Record<string, string>> = {
  $: 'USD',
  '€': 'EUR',
  '£': 'GBP',
};

const ISO_TO_CURRENCY_SYMBOL: Readonly<Record<string, string>> = {
  USD: '$',
  EUR: '€',
  GBP: '£',
};

const MONTH_NAME_TO_NUM: Readonly<Record<string, number>> = {
  january: 1,
  jan: 1,
  february: 2,
  feb: 2,
  march: 3,
  mar: 3,
  april: 4,
  apr: 4,
  may: 5,
  june: 6,
  jun: 6,
  july: 7,
  jul: 7,
  august: 8,
  aug: 8,
  september: 9,
  sep: 9,
  sept: 9,
  october: 10,
  oct: 10,
  november: 11,
  nov: 11,
  december: 12,
  dec: 12,
};

export function isValidIsoDate(value: string): boolean {
  if (!ISO_DATE_REGEX.test(value)) {
    return false;
  }
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (year < 1) {
    return false;
  }
  const dt = new Date(0);
  dt.setUTCFullYear(year, month - 1, day);
  dt.setUTCHours(0, 0, 0, 0);
  return dt.getUTCFullYear() === year && dt.getUTCMonth() === month - 1 && dt.getUTCDate() === day;
}

export const canonicalDecimalSchema = z
  .string()
  .regex(CANONICAL_DECIMAL_REGEX, 'Must be a canonical decimal string');

export const isoCurrencySchema = z
  .string()
  .regex(ISO_CURRENCY_REGEX, 'Must be a 3-letter uppercase ISO currency code');

export const stringValueSchema = z.string().min(1).max(MAX_STRING_VALUE_LENGTH);

export const dateValueSchema = z
  .string()
  .refine(isValidIsoDate, 'Must be a valid ISO-8601 calendar date (YYYY-MM-DD)');

export const moneyValueSchema = z
  .object({
    amount: canonicalDecimalSchema,
    currency: isoCurrencySchema,
  })
  .strict();

export const numberValueSchema = canonicalDecimalSchema;
export const percentValueSchema = canonicalDecimalSchema;

export const typedValueSchema: z.ZodType<TypedValue> = z.union([
  stringValueSchema,
  moneyValueSchema,
]);

export function canonicalTypedValueSchemaFor(fieldType: FieldType): z.ZodType<TypedValue> {
  switch (fieldType) {
    case 'string':
      return stringValueSchema;
    case 'date':
      return dateValueSchema;
    case 'money':
      return moneyValueSchema;
    case 'number':
      return numberValueSchema;
    case 'percent':
      return percentValueSchema;
  }
}

export function canonicalDecimal(input: string): string {
  if (typeof input !== 'string') {
    throw new TypeError('Decimal input must be a string');
  }
  const trimmed = input.trim();
  const match = /^([+-])?(?:([0-9]+)(?:\.([0-9]*))?|\.([0-9]+))$/.exec(trimmed);
  if (!match) {
    throw new Error(`Invalid decimal string: "${input}"`);
  }

  const sign = match[1] === '-' ? '-' : '';
  const rawInt = match[2] ?? '0';
  const rawFrac = match[3] ?? match[4] ?? '';

  const intPart = rawInt.replace(/^0+/, '') || '0';
  const fracPart = rawFrac.replace(/0+$/, '');

  if (intPart === '0' && fracPart === '') {
    return '0';
  }
  return fracPart.length > 0 ? `${sign}${intPart}.${fracPart}` : `${sign}${intPart}`;
}

function parseGroupedDecimal(raw: string): string | null {
  const trimmed = raw.trim();
  const match = /^([+-])?(?:([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\.([0-9]*))?|\.([0-9]+))$/.exec(
    trimmed,
  );
  if (!match) {
    return null;
  }
  const sign = match[1] ?? '';
  const intDigits = (match[2] ?? '0').replaceAll(',', '');
  const fracDigits = match[3] ?? match[4];
  const combined =
    fracDigits !== undefined ? `${sign}${intDigits}.${fracDigits}` : `${sign}${intDigits}`;
  try {
    return canonicalDecimal(combined);
  } catch {
    return null;
  }
}

function mapCurrencyToken(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const fromSym = CURRENCY_SYMBOL_TO_ISO[trimmed];
  if (fromSym) {
    return fromSym;
  }
  if (/^[A-Za-z]{3}$/.test(trimmed)) {
    return trimmed.toUpperCase();
  }
  return null;
}

function parseMoneyString(raw: string, fallbackCurrency?: string): ParseTypedValueResult {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: 'Money value cannot be empty' };
  }

  let body = trimmed;
  let negative = false;
  let leadingCurrency: string | null = null;
  let trailingCurrency: string | null = null;

  // Handle trailing ISO code outside parentheses: "(1,234.00) USD"
  const outerTrailing = /^(\([^()]+\))\s+([A-Za-z]{3})$/.exec(body);
  if (outerTrailing?.[1] && outerTrailing[2]) {
    body = outerTrailing[1];
    trailingCurrency = outerTrailing[2].toUpperCase();
  }

  // Handle accounting parentheses: "(1,234.00)", "($1,234.00)", "(1,234.00 USD)"
  if (body.startsWith('(') && body.endsWith(')')) {
    negative = true;
    body = body.slice(1, -1).trim();
  }

  // Optional leading ISO code: "USD $5,230.29" or "USD 5,230.29"
  const leadIso = /^([A-Za-z]{3})\s+(.+)$/.exec(body);
  if (leadIso?.[1] && leadIso[2]) {
    leadingCurrency = leadIso[1].toUpperCase();
    body = leadIso[2].trim();
  }

  // Optional leading sign before symbol: "-$1,234.00" or "+$100"
  if (body.startsWith('-')) {
    if (negative) {
      return { ok: false, error: 'Conflicting negative signs in money value' };
    }
    negative = true;
    body = body.slice(1).trim();
  } else if (body.startsWith('+')) {
    if (negative) {
      return { ok: false, error: 'Conflicting signs in money value' };
    }
    body = body.slice(1).trim();
  }

  // Optional leading symbol: "$5,230.29", "€100", "£50"
  const firstChar = body[0];
  if (firstChar && CURRENCY_SYMBOL_TO_ISO[firstChar]) {
    const symIso = CURRENCY_SYMBOL_TO_ISO[firstChar]!;
    if (leadingCurrency && leadingCurrency !== symIso) {
      return { ok: false, error: 'Conflicting currency markers in money value' };
    }
    leadingCurrency = symIso;
    body = body.slice(1).trim();
  }

  // Optional sign after symbol: "$-1,234.00"
  if (body.startsWith('-')) {
    if (negative) {
      return { ok: false, error: 'Conflicting negative signs in money value' };
    }
    negative = true;
    body = body.slice(1).trim();
  } else if (body.startsWith('+')) {
    if (negative) {
      return { ok: false, error: 'Conflicting signs in money value' };
    }
    body = body.slice(1).trim();
  }

  // Optional trailing ISO code inside: "5,230.29 USD"
  const trailIso = /^(.+?)\s+([A-Za-z]{3})$/.exec(body);
  if (trailIso?.[1] && trailIso[2]) {
    const iso = trailIso[2].toUpperCase();
    if (trailingCurrency && trailingCurrency !== iso) {
      return { ok: false, error: 'Conflicting currency markers in money value' };
    }
    trailingCurrency = iso;
    body = trailIso[1].trim();
  }

  if (leadingCurrency && trailingCurrency && leadingCurrency !== trailingCurrency) {
    return { ok: false, error: 'Conflicting currency markers in money value' };
  }

  const parsedNum = parseGroupedDecimal(body);
  if (parsedNum === null) {
    return { ok: false, error: `Invalid money amount: "${raw}"` };
  }
  const signedAmount =
    negative && parsedNum !== '0'
      ? parsedNum.startsWith('-')
        ? parsedNum
        : `-${parsedNum}`
      : parsedNum;

  const currency = leadingCurrency ?? trailingCurrency ?? fallbackCurrency ?? 'USD';
  if (!ISO_CURRENCY_REGEX.test(currency)) {
    return { ok: false, error: `Invalid ISO currency code: "${currency}"` };
  }

  return { ok: true, value: { amount: signedAmount, currency } };
}

function parseMoneyInput(input: unknown, tpl?: TemplateValueContext): ParseTypedValueResult {
  const defaultCurrency = (tpl?.defaultCurrency ?? 'USD').trim().toUpperCase();
  if (!ISO_CURRENCY_REGEX.test(defaultCurrency)) {
    return { ok: false, error: `Invalid template defaultCurrency: "${defaultCurrency}"` };
  }

  if (typeof input === 'string') {
    return parseMoneyString(input, defaultCurrency);
  }

  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, error: 'Money value must be a string or { amount, currency } object' };
  }

  const record = input as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== 'amount' && key !== 'currency') {
      return { ok: false, error: `Unexpected property "${key}" on money value` };
    }
  }

  const rawAmount = record['amount'];
  const rawCurrency = record['currency'];
  if (typeof rawAmount !== 'string') {
    return {
      ok: false,
      error: 'Money amount must be a decimal string (JSON numbers are rejected)',
    };
  }
  if (rawCurrency !== undefined && typeof rawCurrency !== 'string') {
    return { ok: false, error: 'Money currency must be a string' };
  }

  let explicitCurrency: string | null = null;
  if (rawCurrency !== undefined && rawCurrency.trim().length > 0) {
    explicitCurrency = mapCurrencyToken(rawCurrency);
    if (!explicitCurrency) {
      return { ok: false, error: `Invalid currency: "${rawCurrency}"` };
    }
  }

  // Parse amount string; check if amount itself carried a currency marker.
  const amountOnly = parseMoneyString(rawAmount, '__NONE__');
  if (!amountOnly.ok) {
    // Retry with explicit/default currency if failure was due to sentinel currency validation.
    const withDefault = parseMoneyString(rawAmount, explicitCurrency ?? defaultCurrency);
    if (!withDefault.ok) {
      return withDefault;
    }
    return withDefault;
  }

  const embeddedCurrency = (amountOnly.value as MoneyValue).currency;
  if (explicitCurrency && embeddedCurrency !== explicitCurrency) {
    return { ok: false, error: 'Currency in amount conflicts with currency field' };
  }

  return {
    ok: true,
    value: {
      amount: (amountOnly.value as MoneyValue).amount,
      currency: explicitCurrency ?? embeddedCurrency,
    },
  };
}

function formatIsoDateParts(year: number, month: number, day: number): string | null {
  const iso = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return isValidIsoDate(iso) ? iso : null;
}

function parseDateInput(input: unknown, tpl?: TemplateValueContext): ParseTypedValueResult {
  if (typeof input !== 'string') {
    return { ok: false, error: 'Date value must be a string' };
  }
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: 'Date value cannot be empty' };
  }

  // ISO YYYY-MM-DD
  if (/^[0-9]{4}-[0-9]{1,2}-[0-9]{1,2}$/.test(trimmed)) {
    const [, mStr, dStr] = trimmed.split('-');
    if (mStr!.length === 2 && dStr!.length === 2 && isValidIsoDate(trimmed)) {
      return { ok: true, value: trimmed };
    }
    return { ok: false, error: `Invalid ISO calendar date: "${trimmed}"` };
  }

  // Month D, YYYY or Mon. D, YYYY
  const monthFirst = /^([A-Za-z]+)\.?\s+([0-9]{1,2}),?\s+([0-9]{4})$/.exec(trimmed);
  if (monthFirst?.[1] && monthFirst[2] && monthFirst[3]) {
    const month = MONTH_NAME_TO_NUM[monthFirst[1].toLowerCase()];
    const day = Number(monthFirst[2]);
    const year = Number(monthFirst[3]);
    if (month !== undefined) {
      const iso = formatIsoDateParts(year, month, day);
      if (iso) return { ok: true, value: iso };
    }
    return { ok: false, error: `Invalid calendar date: "${trimmed}"` };
  }

  // D Month YYYY or D Mon YYYY
  const dayFirst = /^([0-9]{1,2})\s+([A-Za-z]+)\.?,?\s+([0-9]{4})$/.exec(trimmed);
  if (dayFirst?.[1] && dayFirst[2] && dayFirst[3]) {
    const day = Number(dayFirst[1]);
    const month = MONTH_NAME_TO_NUM[dayFirst[2].toLowerCase()];
    const year = Number(dayFirst[3]);
    if (month !== undefined) {
      const iso = formatIsoDateParts(year, month, day);
      if (iso) return { ok: true, value: iso };
    }
    return { ok: false, error: `Invalid calendar date: "${trimmed}"` };
  }

  // Numeric YYYY/MM/DD
  const ymdSlash = /^([0-9]{4})\/([0-9]{1,2})\/([0-9]{1,2})$/.exec(trimmed);
  if (ymdSlash?.[1] && ymdSlash[2] && ymdSlash[3]) {
    const iso = formatIsoDateParts(Number(ymdSlash[1]), Number(ymdSlash[2]), Number(ymdSlash[3]));
    return iso
      ? { ok: true, value: iso }
      : { ok: false, error: `Invalid calendar date: "${trimmed}"` };
  }

  // Numeric NN/NN/YYYY or NN-NN-YYYY (4-digit year required)
  const numeric = /^([0-9]{1,2})([/-])([0-9]{1,2})\2([0-9]{4})$/.exec(trimmed);
  if (numeric?.[1] && numeric[3] && numeric[4]) {
    const a = Number(numeric[1]);
    const b = Number(numeric[3]);
    const year = Number(numeric[4]);
    const dateOrder = tpl?.dateOrder ?? 'MDY';

    let month: number;
    let day: number;
    if (a > 12 && b <= 12) {
      day = a;
      month = b;
    } else if (b > 12 && a <= 12) {
      month = a;
      day = b;
    } else if (dateOrder === 'DMY') {
      day = a;
      month = b;
    } else {
      month = a;
      day = b;
    }

    const iso = formatIsoDateParts(year, month, day);
    return iso
      ? { ok: true, value: iso }
      : { ok: false, error: `Invalid calendar date: "${trimmed}"` };
  }

  return { ok: false, error: `Unrecognized date format: "${trimmed}"` };
}

function parseNumberInput(input: unknown): ParseTypedValueResult {
  if (typeof input !== 'string') {
    return {
      ok: false,
      error: 'Number value must be a decimal string (JSON numbers are rejected)',
    };
  }
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: 'Number value cannot be empty' };
  }
  let body = trimmed;
  let negative = false;
  if (body.startsWith('(') && body.endsWith(')')) {
    negative = true;
    body = body.slice(1, -1).trim();
    if (body.startsWith('-') || body.startsWith('+')) {
      return { ok: false, error: 'Conflicting signs in number value' };
    }
  }
  const parsed = parseGroupedDecimal(body);
  if (parsed === null) {
    return { ok: false, error: `Invalid number value: "${input}"` };
  }
  const value = negative && parsed !== '0' ? `-${parsed}` : parsed;
  return { ok: true, value };
}

function parsePercentInput(input: unknown): ParseTypedValueResult {
  if (typeof input !== 'string') {
    return {
      ok: false,
      error: 'Percent value must be a decimal string (JSON numbers are rejected)',
    };
  }
  let trimmed = input.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: 'Percent value cannot be empty' };
  }
  if (trimmed.endsWith('%')) {
    trimmed = trimmed.slice(0, -1).trim();
  }
  if (trimmed.endsWith('%')) {
    return { ok: false, error: `Invalid percent value: "${input}"` };
  }
  const parsed = parseGroupedDecimal(trimmed);
  if (parsed === null) {
    return { ok: false, error: `Invalid percent value: "${input}"` };
  }
  return { ok: true, value: parsed };
}

function parseStringInput(input: unknown): ParseTypedValueResult {
  if (typeof input !== 'string') {
    return { ok: false, error: 'String value must be a string' };
  }
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: 'String value cannot be empty' };
  }
  if (trimmed.length > MAX_STRING_VALUE_LENGTH) {
    return {
      ok: false,
      error: `String value exceeds maximum length of ${MAX_STRING_VALUE_LENGTH} characters`,
    };
  }
  return { ok: true, value: trimmed };
}

export function parseTypedValue(
  fieldType: FieldType,
  input: unknown,
  tpl?: TemplateValueContext,
): ParseTypedValueResult {
  switch (fieldType) {
    case 'string':
      return parseStringInput(input);
    case 'date':
      return parseDateInput(input, tpl);
    case 'money':
      return parseMoneyInput(input, tpl);
    case 'number':
      return parseNumberInput(input);
    case 'percent':
      return parsePercentInput(input);
  }
}

function isMoneyValue(value: TypedValue): value is MoneyValue {
  return typeof value === 'object' && value !== null;
}

function normalizeDecimalKey(raw: string): string {
  try {
    return canonicalDecimal(raw);
  } catch {
    return raw.trim();
  }
}

function normalizeStringKey(raw: string): string {
  return raw.trim().replace(/\s+/gu, ' ').toLowerCase();
}

export function equalValues(
  fieldType: FieldType,
  a: TypedValue | null,
  b: TypedValue | null,
): boolean {
  if (a === null || b === null) {
    return a === b;
  }

  switch (fieldType) {
    case 'money': {
      if (!isMoneyValue(a) || !isMoneyValue(b)) {
        return false;
      }
      return (
        a.currency.trim().toUpperCase() === b.currency.trim().toUpperCase() &&
        normalizeDecimalKey(a.amount) === normalizeDecimalKey(b.amount)
      );
    }
    case 'number':
    case 'percent': {
      if (typeof a !== 'string' || typeof b !== 'string') {
        return false;
      }
      return normalizeDecimalKey(a) === normalizeDecimalKey(b);
    }
    case 'date': {
      if (typeof a !== 'string' || typeof b !== 'string') {
        return false;
      }
      return a.trim() === b.trim();
    }
    case 'string': {
      if (typeof a !== 'string' || typeof b !== 'string') {
        return false;
      }
      return normalizeStringKey(a) === normalizeStringKey(b);
    }
  }
}

function addThousandSeparators(intPart: string): string {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function formatDecimalForDisplay(raw: string, minFractionDigits = 0): string {
  let canonical: string;
  try {
    canonical = canonicalDecimal(raw);
  } catch {
    return raw;
  }
  const negative = canonical.startsWith('-');
  const unsigned = negative ? canonical.slice(1) : canonical;
  const [intPart = '0', fracPart = ''] = unsigned.split('.');
  const formattedInt = addThousandSeparators(intPart);
  const paddedFrac =
    fracPart.length < minFractionDigits ? fracPart.padEnd(minFractionDigits, '0') : fracPart;
  const sign = negative ? '-' : '';
  return paddedFrac.length > 0 ? `${sign}${formattedInt}.${paddedFrac}` : `${sign}${formattedInt}`;
}

export function formatTypedValue(fieldType: FieldType, value: TypedValue | null): string {
  if (value === null) {
    return '—';
  }

  switch (fieldType) {
    case 'string':
    case 'date':
      return typeof value === 'string' ? value : `${value.amount} ${value.currency}`;
    case 'number':
      return typeof value === 'string' ? formatDecimalForDisplay(value, 0) : value.amount;
    case 'percent':
      return typeof value === 'string'
        ? `${formatDecimalForDisplay(value, 0)}%`
        : `${value.amount}%`;
    case 'money': {
      if (!isMoneyValue(value)) {
        return value;
      }
      const currency = value.currency.trim().toUpperCase();
      const formatted = formatDecimalForDisplay(value.amount, 2);
      const symbol = ISO_TO_CURRENCY_SYMBOL[currency];
      if (symbol) {
        if (formatted.startsWith('-')) {
          return `-${symbol}${formatted.slice(1)}`;
        }
        return `${symbol}${formatted}`;
      }
      return `${formatted} ${currency}`;
    }
  }
}
