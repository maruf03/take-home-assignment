import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  CANONICAL_DECIMAL_REGEX,
  canonicalDecimal,
  equalValues,
  formatTypedValue,
  isValidIsoDate,
  parseTypedValue,
  type MoneyValue,
  type TypedValue,
} from '../src/values.js';

describe('canonicalDecimal', () => {
  it('canonicalizes trailing zeros, leading zeros, and negative zero', () => {
    expect(canonicalDecimal('5230.10')).toBe('5230.1');
    expect(canonicalDecimal('5230.00')).toBe('5230');
    expect(canonicalDecimal('00042.500')).toBe('42.5');
    expect(canonicalDecimal('-0.00')).toBe('0');
    expect(canonicalDecimal('-0')).toBe('0');
    expect(canonicalDecimal('+12.30')).toBe('12.3');
    expect(canonicalDecimal('.50')).toBe('0.5');
    expect(canonicalDecimal('-.050')).toBe('-0.05');
    expect(canonicalDecimal('0')).toBe('0');
    expect(canonicalDecimal('123456789012345678901234.50000010')).toBe(
      '123456789012345678901234.5000001',
    );
  });

  it('rejects non-decimal inputs and scientific notation', () => {
    for (const bad of ['', '   ', '.', '-', '+', '1e5', '12.3.4', 'abc', '1,000', '$5.00']) {
      expect(() => canonicalDecimal(bad), `expected throw for "${bad}"`).toThrow();
    }
  });

  it('is idempotent and matches CANONICAL_DECIMAL_REGEX (fast-check)', () => {
    const decimalStringArb = fc
      .tuple(
        fc.constantFrom('', '-', '+'),
        fc.stringMatching(/^[0-9]{1,12}$/),
        fc.option(fc.stringMatching(/^[0-9]{1,8}$/), { nil: undefined }),
      )
      .map(([sign, intPart, fracPart]) =>
        fracPart !== undefined ? `${sign}${intPart}.${fracPart}` : `${sign}${intPart}`,
      );

    fc.assert(
      fc.property(decimalStringArb, (raw) => {
        const c1 = canonicalDecimal(raw);
        expect(CANONICAL_DECIMAL_REGEX.test(c1)).toBe(true);
        expect(canonicalDecimal(c1)).toBe(c1);
      }),
    );
  });
});

describe('parseTypedValue', () => {
  it('rejects JSON-number money amounts, number values, and percent values', () => {
    expect(parseTypedValue('money', { amount: 5230.29, currency: 'USD' }).ok).toBe(false);
    expect(parseTypedValue('money', 5230.29).ok).toBe(false);
    expect(parseTypedValue('number', 24).ok).toBe(false);
    expect(parseTypedValue('percent', 4.2).ok).toBe(false);
  });

  it('rejects invalid calendar dates like 2025-13-01 and 2025-02-29', () => {
    expect(isValidIsoDate('2025-13-01')).toBe(false);
    expect(isValidIsoDate('2025-02-29')).toBe(false);
    expect(isValidIsoDate('2025-04-31')).toBe(false);
    expect(isValidIsoDate('2024-02-29')).toBe(true);

    expect(parseTypedValue('date', '2025-13-01').ok).toBe(false);
    expect(parseTypedValue('date', '2025-02-29').ok).toBe(false);
    expect(parseTypedValue('date', '03/01/25').ok).toBe(false);
    expect(parseTypedValue('date', '2025-03-01')).toEqual({ ok: true, value: '2025-03-01' });
    expect(parseTypedValue('date', '2024-02-29')).toEqual({ ok: true, value: '2024-02-29' });
    expect(parseTypedValue('date', 'March 1, 2025')).toEqual({ ok: true, value: '2025-03-01' });
  });

  it('normalizes money values including Gemini quirks (§15.5) and rejects conflicts', () => {
    expect(parseTypedValue('money', { amount: '$1,985.00', currency: '$' })).toEqual({
      ok: true,
      value: { amount: '1985', currency: 'USD' },
    });
    expect(
      parseTypedValue('money', { amount: '5,230.10', currency: '' }, { defaultCurrency: 'EUR' }),
    ).toEqual({
      ok: true,
      value: { amount: '5230.1', currency: 'EUR' },
    });
    expect(parseTypedValue('money', { amount: '(1,234.00)', currency: 'USD' })).toEqual({
      ok: true,
      value: { amount: '-1234', currency: 'USD' },
    });
    expect(parseTypedValue('money', '$5,230.29')).toEqual({
      ok: true,
      value: { amount: '5230.29', currency: 'USD' },
    });
    expect(parseTypedValue('money', '(1,234.00) USD')).toEqual({
      ok: true,
      value: { amount: '-1234', currency: 'USD' },
    });
    expect(parseTypedValue('money', { amount: '$100', currency: 'CAD' }).ok).toBe(false);
    expect(parseTypedValue('money', { amount: '100', currency: 'USD', extra: true }).ok).toBe(
      false,
    );
    expect(parseTypedValue('money', { amount: '100', currency: 'US' }).ok).toBe(false);
  });

  it('strips trailing % for percent and rejects invalid percent/number strings', () => {
    expect(parseTypedValue('percent', '4.2%')).toEqual({ ok: true, value: '4.2' });
    expect(parseTypedValue('percent', '5.00%')).toEqual({ ok: true, value: '5' });
    expect(parseTypedValue('percent', '3.8')).toEqual({ ok: true, value: '3.8' });
    expect(parseTypedValue('percent', '4.2%%').ok).toBe(false);
    expect(parseTypedValue('number', '1,234.50')).toEqual({ ok: true, value: '1234.5' });
    expect(parseTypedValue('number', '4.2%').ok).toBe(false);
    expect(parseTypedValue('number', '1,23,4').ok).toBe(false);
  });

  it('trims strings and enforces length 1..2000', () => {
    expect(parseTypedValue('string', '  MERIDIAN OFFICE SUPPLIES LLC  ')).toEqual({
      ok: true,
      value: 'MERIDIAN OFFICE SUPPLIES LLC',
    });
    expect(parseTypedValue('string', '   ').ok).toBe(false);
    expect(parseTypedValue('string', 'a'.repeat(2001)).ok).toBe(false);
  });
});

describe('equalValues (fast-check equivalence relation)', () => {
  const moneyArb: fc.Arbitrary<MoneyValue> = fc.record({
    amount: fc.constantFrom(
      '0',
      '0.00',
      '-0.0',
      '10',
      '10.0',
      '5230.10',
      '5230.1',
      '-1234.00',
      '-1234',
    ),
    currency: fc.constantFrom('USD', 'usd', 'EUR', 'GBP'),
  });

  const numArb = fc.constantFrom('0', '0.00', '-0', '4.2', '4.20', '24', '0024.0', '-5.50', '-5.5');
  const strArb = fc.constantFrom(
    'Meridian LLC',
    '  MERIDIAN   llc ',
    'meridian llc',
    'Apex Corp',
    'apex corp',
  );
  const dateArb = fc.constantFrom('2025-03-01', ' 2025-03-01 ', '2025-11-13');

  const cases = [
    { fieldType: 'money' as const, arb: fc.option(moneyArb, { nil: null }) },
    { fieldType: 'number' as const, arb: fc.option(numArb, { nil: null }) },
    { fieldType: 'percent' as const, arb: fc.option(numArb, { nil: null }) },
    { fieldType: 'string' as const, arb: fc.option(strArb, { nil: null }) },
    { fieldType: 'date' as const, arb: fc.option(dateArb, { nil: null }) },
  ];

  for (const { fieldType, arb } of cases) {
    it(`is reflexive, symmetric, and transitive for ${fieldType}`, () => {
      fc.assert(
        fc.property(
          arb,
          arb,
          arb,
          (a: TypedValue | null, b: TypedValue | null, c: TypedValue | null) => {
            // Reflexive
            expect(equalValues(fieldType, a, a)).toBe(true);
            // Symmetric
            expect(equalValues(fieldType, a, b)).toBe(equalValues(fieldType, b, a));
            // Transitive
            if (equalValues(fieldType, a, b) && equalValues(fieldType, b, c)) {
              expect(equalValues(fieldType, a, c)).toBe(true);
            }
          },
        ),
      );
    });
  }
});

describe('formatTypedValue', () => {
  it('formats each typed value cleanly for UI display', () => {
    expect(formatTypedValue('money', { amount: '5230.1', currency: 'USD' })).toBe('$5,230.10');
    expect(formatTypedValue('money', { amount: '-1234', currency: 'USD' })).toBe('-$1,234.00');
    expect(formatTypedValue('money', { amount: '99.5', currency: 'EUR' })).toBe('€99.50');
    expect(formatTypedValue('money', { amount: '500', currency: 'CAD' })).toBe('500.00 CAD');
    expect(formatTypedValue('percent', '4.2')).toBe('4.2%');
    expect(formatTypedValue('number', '1234.5')).toBe('1,234.5');
    expect(formatTypedValue('date', '2025-03-01')).toBe('2025-03-01');
    expect(formatTypedValue('string', 'Meridian')).toBe('Meridian');
    expect(formatTypedValue('string', null)).toBe('—');
  });
});
