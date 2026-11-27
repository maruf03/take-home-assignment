import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { TextRanges } from '@app/contracts/dto';
import { describe, expect, it } from 'vitest';
import {
  extractMoneyTokens,
  extractNumberTokens,
  extractPercentTokens,
  mergeChunkResults,
  parseToolOutput,
  validateExtraction,
  type ExtractionTemplateSpec,
} from '../src/index.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const GOLDEN_TEXT_DIR = path.join(REPO_ROOT, 'fixtures-golden', 'text');
const GOLDEN_LLM_DIR = path.join(REPO_ROOT, 'fixtures-golden', 'llm-outputs');

const EMPTY_RANGES: TextRanges = { hidden: [], lowVisibility: [] };

const LEASE_TEMPLATE: ExtractionTemplateSpec = {
  documentType: 'lease',
  defaultCurrency: 'USD',
  dateOrder: 'MDY',
  fields: [
    { fieldKey: 'tenant_name', fieldType: 'string', position: 1, label: 'Tenant name' },
    { fieldKey: 'monthly_rent', fieldType: 'money', position: 2, label: 'Monthly rent' },
    { fieldKey: 'security_deposit', fieldType: 'money', position: 3, label: 'Security deposit' },
    { fieldKey: 'lease_start', fieldType: 'date', position: 4, label: 'Lease start' },
    { fieldKey: 'term_months', fieldType: 'number', position: 5, label: 'Term (months)' },
  ],
};

const MARKET_TEMPLATE: ExtractionTemplateSpec = {
  documentType: 'market_report',
  defaultCurrency: 'USD',
  dateOrder: 'MDY',
  fields: [
    { fieldKey: 'report_quarter', fieldType: 'string', position: 1, label: 'Report quarter' },
    { fieldKey: 'market_area', fieldType: 'string', position: 2, label: 'Market area' },
    { fieldKey: 'vacancy_rate', fieldType: 'percent', position: 3, label: 'Vacancy rate' },
    { fieldKey: 'average_rent_1br', fieldType: 'money', position: 4, label: 'Average 1BR rent' },
    {
      fieldKey: 'year_over_year_rent_growth',
      fieldType: 'percent',
      position: 5,
      label: 'YoY rent growth',
    },
    {
      fieldKey: 'median_household_income',
      fieldType: 'money',
      position: 6,
      label: 'Median household income',
    },
  ],
};

describe('[R6] evidence.tokenizers: money, percent, number, and date rules (§5.5)', () => {
  it('parses percent values 4.2%, 4.9%, 3.8%, 5% and rejects bare numbers', () => {
    expect(
      extractPercentTokens('declined to 4.2%, down from 4.9%, YoY 3.8%, below 5%').map(
        (t) => t.value,
      ),
    ).toEqual(['4.2', '4.9', '3.8', '5']);
    expect(extractPercentTokens('bare number 4.2 without sign')).toEqual([]);
    expect(
      extractPercentTokens('increase of 3.5 percent and 2 per cent').map((t) => t.value),
    ).toEqual(['3.5', '2']);
  });

  it('enforces strict money tokenizer rules (rejects dates/quantities/SD-400/unsupported/conflicting currencies; handles parens)', () => {
    expect(extractMoneyTokens('Issue Date: 2025-09-14 qty 4 model SD-400')).toEqual([]);
    expect(extractMoneyTokens('$5,230.29 CAD')).toEqual([]);
    expect(extractMoneyTokens('CAD $5,230.29')).toEqual([]);
    expect(extractMoneyTokens('EUR 10 USD')).toEqual([]);

    expect(extractMoneyTokens('PAY $5,230.29 DUE NET 30').map((t) => t.value)).toEqual([
      { amount: '5230.29', currency: 'USD' },
    ]);
    expect(extractMoneyTokens('USD 5,230.29').map((t) => t.value)).toEqual([
      { amount: '5230.29', currency: 'USD' },
    ]);
    expect(
      extractMoneyTokens('(1,234.00) USD and (1,234.00 USD) and ($1,234.00)').map((t) => t.value),
    ).toEqual([
      { amount: '-1234', currency: 'USD' },
      { amount: '-1234', currency: 'USD' },
      { amount: '-1234', currency: 'USD' },
    ]);
    expect(extractMoneyTokens('(up to $2,540)').map((t) => t.value)).toEqual([
      { amount: '2540', currency: 'USD' },
    ]);
    expect(extractMoneyTokens('Sales Tax (8.625%): $415.29').map((t) => t.value)).toEqual([
      { amount: '415.29', currency: 'USD' },
    ]);
  });

  it('handles twenty-four (24) as single token without TOKEN_AMBIGUOUS and rejects mismatched spelled/digit pairs', () => {
    const tokens = extractNumberTokens(
      '2. TERM. The initial term of this Lease shall be twenty-four (24)',
    );
    expect(tokens.map((t) => t.value)).toEqual(['24']);

    const mismatched = extractNumberTokens('The term shall be twenty-four (12) months');
    expect(mismatched).toEqual([]);
  });
});

describe('[R6] evidence.validate: lease & market fixtures, gap codes, flags, and chunk merge', () => {
  it('validates lease fixture cleanly (twenty-four (24) -> 24 no TOKEN_AMBIGUOUS; March 1, 2025 -> 2025-03-01)', async () => {
    const text = await readFile(path.join(GOLDEN_TEXT_DIR, 'lease-excerpt-001.txt'), 'utf8');
    const raw = JSON.parse(
      await readFile(path.join(GOLDEN_LLM_DIR, 'lease-excerpt-001.full.json'), 'utf8'),
    );
    const parsed = parseToolOutput(raw, LEASE_TEMPLATE);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const results = validateExtraction(LEASE_TEMPLATE, text, EMPTY_RANGES, parsed.data);
    const byKey = new Map(results.map((r) => [r.fieldKey, r]));

    expect(byKey.get('term_months')).toMatchObject({
      kind: 'value',
      value: '24',
      flags: [],
    });
    expect(byKey.get('lease_start')).toMatchObject({
      kind: 'value',
      value: '2025-03-01',
    });
    expect(byKey.get('monthly_rent')).toMatchObject({
      kind: 'value',
      value: { amount: '2350', currency: 'USD' },
    });
    expect(byKey.get('tenant_name')).toMatchObject({
      kind: 'value',
      value: 'Dana Okafor',
    });
  });

  it('validates market report fixture with gap for absent median_household_income', async () => {
    const text = await readFile(
      path.join(GOLDEN_TEXT_DIR, 'market-report-excerpt-001.txt'),
      'utf8',
    );
    const raw = JSON.parse(
      await readFile(path.join(GOLDEN_LLM_DIR, 'market-report-excerpt-001.full.json'), 'utf8'),
    );
    const parsed = parseToolOutput(raw, MARKET_TEMPLATE);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const results = validateExtraction(MARKET_TEMPLATE, text, EMPTY_RANGES, parsed.data);
    const byKey = new Map(results.map((r) => [r.fieldKey, r]));

    expect(byKey.get('vacancy_rate')).toMatchObject({ kind: 'value', value: '4.2' });
    expect(byKey.get('average_rent_1br')).toMatchObject({
      kind: 'value',
      value: { amount: '1985', currency: 'USD' },
    });
    expect(byKey.get('year_over_year_rent_growth')).toMatchObject({ kind: 'value', value: '3.8' });
    expect(byKey.get('median_household_income')).toMatchObject({
      kind: 'gap',
      gapCode: 'NOT_FOUND',
    });
  });

  it('produces every gap code and value flag cleanly (hidden, quote_folded, weak line, conflicting lines, low visibility, ambiguous, line mismatch)', () => {
    const tpl: ExtractionTemplateSpec = {
      documentType: 'invoice',
      defaultCurrency: 'USD',
      dateOrder: 'MDY',
      fields: [
        { fieldKey: 'f_omitted', fieldType: 'string', position: 1, label: 'Omitted' },
        { fieldKey: 'f_not_found', fieldType: 'string', position: 2, label: 'Not found' },
        { fieldKey: 'f_no_quote', fieldType: 'string', position: 3, label: 'No quote' },
        { fieldKey: 'f_unparseable', fieldType: 'money', position: 4, label: 'Unparseable' },
        { fieldKey: 'f_hidden', fieldType: 'money', position: 5, label: 'Hidden' },
        { fieldKey: 'f_unsupported', fieldType: 'money', position: 6, label: 'Unsupported' },
        { fieldKey: 'f_folded', fieldType: 'string', position: 7, label: 'Folded' },
        { fieldKey: 'f_weak_scalar', fieldType: 'money', position: 8, label: 'Weak scalar' },
        { fieldKey: 'f_string_exempt', fieldType: 'string', position: 9, label: 'String exempt' },
        { fieldKey: 'f_conflict', fieldType: 'money', position: 10, label: 'Conflict' },
        { fieldKey: 'f_ambig_date', fieldType: 'date', position: 11, label: 'Ambig date' },
      ],
    };

    const lines = [
      'Secret Total: $999.00', // hidden
      'Vendor: "Meridian LLC"', // curly quotes in LLM output -> quote_folded
      '$500.00', // weak scalar line
      'ACME CORP', // string-only line -> NOT weak!
      'Total Due: $100.00', // conflicting line 1
      'Total Due: $200.00', // conflicting line 2
      'Signed Date: 03/04/2025', // ambiguous MDY date + low visibility
    ];
    const text = lines.join('\n');
    const hiddenEnd = lines[0]!.length;
    const lastLineStart = text.lastIndexOf(lines[6]!);
    const ranges: TextRanges = {
      hidden: [[0, hiddenEnd, 'OFF_PAGE']],
      lowVisibility: [[lastLineStart, text.length]],
    };

    const results = validateExtraction(tpl, text, ranges, {
      fields: {
        // f_omitted intentionally omitted
        f_not_found: {
          found: false,
          value: null,
          rawValue: null,
          quote: null,
          line: null,
          notFoundReason: 'Absent.',
        },
        f_no_quote: {
          found: true,
          value: 'abc',
          rawValue: 'abc',
          quote: 'not present in document',
          line: 1,
          notFoundReason: null,
        },
        f_unparseable: {
          found: true,
          value: { amount: 'not-a-number', currency: 'USD' },
          rawValue: 'not-a-number',
          quote: 'Total Due: $100.00',
          line: 5,
          notFoundReason: null,
        },
        f_hidden: {
          found: true,
          value: { amount: '999', currency: 'USD' },
          rawValue: '$999.00',
          quote: 'Secret Total: $999.00',
          line: 1,
          notFoundReason: null,
        },
        f_unsupported: {
          found: true,
          value: { amount: '777', currency: 'USD' },
          rawValue: '$777.00',
          quote: 'Total Due: $100.00',
          line: 5,
          notFoundReason: null,
        },
        f_folded: {
          found: true,
          value: 'Meridian LLC',
          rawValue: 'Meridian LLC',
          quote: 'L002| Vendor: \u201cMeridian LLC\u201d',
          line: 2,
          notFoundReason: null,
        },
        f_weak_scalar: {
          found: true,
          value: { amount: '500', currency: 'USD' },
          rawValue: '$500.00',
          quote: '$500.00',
          line: 3,
          notFoundReason: null,
        },
        f_string_exempt: {
          found: true,
          value: 'ACME CORP',
          rawValue: 'ACME CORP',
          quote: 'ACME CORP',
          line: 4,
          notFoundReason: null,
        },
        f_conflict: {
          found: true,
          value: { amount: '100', currency: 'USD' },
          rawValue: '$100.00',
          quote: 'Total Due: $100.00',
          line: 1, // wrong cited line -> LINE_HINT_MISMATCH
          notFoundReason: null,
        },
        f_ambig_date: {
          found: true,
          value: '03/04/2025',
          rawValue: '03/04/2025',
          quote: 'Signed Date: 03/04/2025',
          line: 7,
          notFoundReason: null,
        },
      },
      documentFlags: { suspiciousInstructions: false, spans: [] },
    });

    const byKey = new Map(results.map((r) => [r.fieldKey, r]));
    expect(byKey.get('f_omitted')).toMatchObject({ kind: 'gap', gapCode: 'MODEL_OMITTED' });
    expect(byKey.get('f_not_found')).toMatchObject({ kind: 'gap', gapCode: 'NOT_FOUND' });
    expect(byKey.get('f_no_quote')).toMatchObject({ kind: 'gap', gapCode: 'EVIDENCE_NOT_IN_TEXT' });
    expect(byKey.get('f_unparseable')).toMatchObject({ kind: 'gap', gapCode: 'UNPARSEABLE_VALUE' });
    expect(byKey.get('f_hidden')).toMatchObject({ kind: 'gap', gapCode: 'EVIDENCE_HIDDEN' });
    expect(byKey.get('f_unsupported')).toMatchObject({
      kind: 'gap',
      gapCode: 'VALUE_NOT_SUPPORTED',
    });

    expect(byKey.get('f_folded')).toMatchObject({
      kind: 'value',
      matchMode: 'quote_folded',
    });
    expect(byKey.get('f_folded')!.flags).toContain('QUOTE_FOLDED');

    expect(byKey.get('f_weak_scalar')!.flags).toContain('WEAK_EVIDENCE_LINE');
    expect(byKey.get('f_string_exempt')!.flags).not.toContain('WEAK_EVIDENCE_LINE');

    expect(byKey.get('f_conflict')!.flags).toContain('CONFLICTING_LINES');
    expect(byKey.get('f_conflict')!.flags).toContain('LINE_HINT_MISMATCH');

    expect(byKey.get('f_ambig_date')).toMatchObject({ kind: 'value', value: '2025-03-04' });
    expect(byKey.get('f_ambig_date')!.flags).toContain('AMBIGUOUS_DATE');
    expect(byKey.get('f_ambig_date')!.flags).toContain('LOW_VISIBILITY');
  });

  it('merges chunk results: earliest offset wins on agreement, CONFLICTING_EVIDENCE on disagreement, priority order on gaps', () => {
    const tpl: ExtractionTemplateSpec = {
      documentType: 'invoice',
      defaultCurrency: 'USD',
      dateOrder: 'MDY',
      fields: [
        { fieldKey: 'agree', fieldType: 'money', position: 1, label: 'Agree' },
        { fieldKey: 'disagree', fieldType: 'money', position: 2, label: 'Disagree' },
        { fieldKey: 'all_gaps', fieldType: 'money', position: 3, label: 'Gaps' },
      ],
    };

    const text = 'Total: $100.00\nOther: $200.00\nTotal: $100.00';
    const chunk0 = validateExtraction(
      tpl,
      text,
      EMPTY_RANGES,
      {
        fields: {
          agree: {
            found: true,
            value: { amount: '100', currency: 'USD' },
            rawValue: '$100.00',
            quote: 'Total: $100.00',
            line: 3,
            notFoundReason: null,
          },
          disagree: {
            found: true,
            value: { amount: '100', currency: 'USD' },
            rawValue: '$100.00',
            quote: 'Total: $100.00',
            line: 1,
            notFoundReason: null,
          },
          all_gaps: {
            found: false,
            value: null,
            rawValue: null,
            quote: null,
            line: null,
            notFoundReason: 'missing',
          },
        },
        documentFlags: { suspiciousInstructions: false, spans: [] },
      },
      { chunkIndex: 0 },
    );
    const chunk1 = validateExtraction(
      tpl,
      text,
      EMPTY_RANGES,
      {
        fields: {
          agree: {
            found: true,
            value: { amount: '100', currency: 'USD' },
            rawValue: '$100.00',
            quote: 'Total: $100.00',
            line: 1,
            notFoundReason: null,
          },
          disagree: {
            found: true,
            value: { amount: '200', currency: 'USD' },
            rawValue: '$200.00',
            quote: 'Other: $200.00',
            line: 2,
            notFoundReason: null,
          },
          all_gaps: {
            found: true,
            value: { amount: '999', currency: 'USD' },
            rawValue: '$999.00',
            quote: 'Total: $100.00',
            line: 1,
            notFoundReason: null,
          },
        },
        documentFlags: { suspiciousInstructions: false, spans: [] },
      },
      { chunkIndex: 1 },
    );

    const merged = mergeChunkResults(tpl, [chunk0, chunk1]);
    const byKey = new Map(merged.map((r) => [r.fieldKey, r]));

    expect(byKey.get('agree')).toMatchObject({ kind: 'value', evidenceStart: 0, chunkIndex: 1 });
    expect(byKey.get('disagree')).toMatchObject({ kind: 'gap', gapCode: 'CONFLICTING_EVIDENCE' });
    expect(byKey.get('all_gaps')).toMatchObject({ kind: 'gap', gapCode: 'VALUE_NOT_SUPPORTED' });
  });
});
