import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { TextRanges } from '@app/contracts/dto';
import { describe, expect, it } from 'vitest';
import {
  classifyChange,
  decideCarry,
  parseToolOutput,
  validateExtraction,
  type BaselineFieldSnapshot,
  type ExtractionTemplateSpec,
  type ValidatedFieldResult,
} from '../src/index.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const GOLDEN_TEXT_DIR = path.join(REPO_ROOT, 'fixtures-golden', 'text');
const GOLDEN_LLM_DIR = path.join(REPO_ROOT, 'fixtures-golden', 'llm-outputs');

const EMPTY_RANGES: TextRanges = { hidden: [], lowVisibility: [] };

const INVOICE_TEMPLATE: ExtractionTemplateSpec = {
  documentType: 'invoice',
  defaultCurrency: 'USD',
  dateOrder: 'MDY',
  fields: [
    { fieldKey: 'invoice_number', fieldType: 'string', position: 1, label: 'Invoice number' },
    { fieldKey: 'issue_date', fieldType: 'date', position: 2, label: 'Issue date' },
    { fieldKey: 'due_date', fieldType: 'date', position: 3, label: 'Due date' },
    { fieldKey: 'vendor_name', fieldType: 'string', position: 4, label: 'Vendor name' },
    { fieldKey: 'total_amount', fieldType: 'money', position: 5, label: 'Total amount' },
  ],
};

function toBaseline(r: ValidatedFieldResult): BaselineFieldSnapshot {
  return {
    id: `base-${r.fieldKey}`,
    fieldKey: r.fieldKey,
    fieldType: r.fieldType,
    kind: r.kind,
    value: r.value,
    canonicalEvidence: r.canonicalEvidence,
    flags: r.flags,
  };
}

describe('[R7] carryover.invoice-v2.exact-set across all quote-span variants', () => {
  const variants = ['full', 'bare-date', 'label-less', 'layout'] as const;

  for (const variant of variants) {
    it(`[R7] carryover.invoice-v2.exact-set (${variant}): exactly {due_date, total_amount} changed, vendor_name & others carry`, async () => {
      const [v1Text, v2Text, v1Raw, v2Raw] = await Promise.all([
        readFile(path.join(GOLDEN_TEXT_DIR, 'invoice-001.txt'), 'utf8'),
        readFile(path.join(GOLDEN_TEXT_DIR, 'invoice-001.v2.txt'), 'utf8'),
        readFile(path.join(GOLDEN_LLM_DIR, 'invoice-001.full.json'), 'utf8').then((s) =>
          JSON.parse(s),
        ),
        readFile(path.join(GOLDEN_LLM_DIR, `invoice-001.v2.${variant}.json`), 'utf8').then((s) =>
          JSON.parse(s),
        ),
      ]);

      const parsed1 = parseToolOutput(v1Raw, INVOICE_TEMPLATE);
      const parsed2 = parseToolOutput(v2Raw, INVOICE_TEMPLATE);
      expect(parsed1.ok).toBe(true);
      expect(parsed2.ok).toBe(true);
      if (!parsed1.ok || !parsed2.ok) return;

      const v1Results = validateExtraction(INVOICE_TEMPLATE, v1Text, EMPTY_RANGES, parsed1.data);
      const v2Results = validateExtraction(INVOICE_TEMPLATE, v2Text, EMPTY_RANGES, parsed2.data);
      const v1ByKey = new Map(v1Results.map((r) => [r.fieldKey, toBaseline(r)]));

      const changedKeys: string[] = [];
      const carriedKeys: string[] = [];

      for (const next of v2Results) {
        const base = v1ByKey.get(next.fieldKey) ?? null;
        const cls = classifyChange(base, next, {
          baselineParser: 'pdfjs-6.5.438/lines-1',
          nextParser: 'pdfjs-6.5.438/lines-1',
          baselineText: v1Text,
          nextText: v2Text,
          nextRanges: EMPTY_RANGES,
          dateOrder: 'MDY',
        });

        if (cls.changeKind === 'changed') {
          changedKeys.push(next.fieldKey);
          expect(cls.changeReason).toBe('VALUE_CHANGED');
        }

        const carried = decideCarry(cls, { id: `rev-${next.fieldKey}`, decision: 'approve' });
        if (carried !== null) {
          carriedKeys.push(next.fieldKey);
        }
      }

      expect(changedKeys.sort()).toEqual(['due_date', 'total_amount']);
      expect(carriedKeys.sort()).toEqual(['invoice_number', 'issue_date', 'vendor_name']);
    });
  }

  it('keeps an unreviewed changed field as changed (never same)', async () => {
    const [v1Text, v2Text, v1Raw, v2Raw] = await Promise.all([
      readFile(path.join(GOLDEN_TEXT_DIR, 'invoice-001.txt'), 'utf8'),
      readFile(path.join(GOLDEN_TEXT_DIR, 'invoice-001.v2.txt'), 'utf8'),
      readFile(path.join(GOLDEN_LLM_DIR, 'invoice-001.full.json'), 'utf8').then((s) =>
        JSON.parse(s),
      ),
      readFile(path.join(GOLDEN_LLM_DIR, 'invoice-001.v2.full.json'), 'utf8').then((s) =>
        JSON.parse(s),
      ),
    ]);

    const p1 = parseToolOutput(v1Raw, INVOICE_TEMPLATE);
    const p2 = parseToolOutput(v2Raw, INVOICE_TEMPLATE);
    if (!p1.ok || !p2.ok) throw new Error('unexpected');

    const v1Total = validateExtraction(INVOICE_TEMPLATE, v1Text, EMPTY_RANGES, p1.data).find(
      (r) => r.fieldKey === 'total_amount',
    )!;
    const v2Total = validateExtraction(INVOICE_TEMPLATE, v2Text, EMPTY_RANGES, p2.data).find(
      (r) => r.fieldKey === 'total_amount',
    )!;

    const cls = classifyChange(toBaseline(v1Total), v2Total, {
      baselineParser: 'pdfjs-6.5.438/lines-1',
      nextParser: 'pdfjs-6.5.438/lines-1',
      baselineText: v1Text,
      nextText: v2Text,
      nextRanges: EMPTY_RANGES,
      dateOrder: 'MDY',
    });
    expect(cls).toEqual({ changeKind: 'changed', changeReason: 'VALUE_CHANGED' });
    expect(decideCarry(cls, null)).toBeNull();
  });
});

describe('[I6] Rule A prime edge cases and decideCarry', () => {
  const moneyTpl: ExtractionTemplateSpec = {
    documentType: 'invoice',
    defaultCurrency: 'USD',
    dateOrder: 'MDY',
    fields: [{ fieldKey: 'total_amount', fieldType: 'money', position: 1, label: 'Total' }],
  };

  function validateSingle(
    text: string,
    quote: string,
    amount = '100',
    ranges: TextRanges = EMPTY_RANGES,
  ): ValidatedFieldResult {
    return validateExtraction(moneyTpl, text, ranges, {
      fields: {
        total_amount: {
          found: true,
          value: { amount, currency: 'USD' },
          rawValue: `$${amount}`,
          quote,
          line: 1,
          notFoundReason: null,
        },
      },
      documentFlags: { suspiciousInstructions: false, spans: [] },
    })[0]!;
  }

  it('covers every changeReason: TYPE_CHANGED, GAP_INVOLVED, PARSER_CHANGED, EVIDENCE_HIDDEN, WEAK_EVIDENCE_LINE, CONFLICTING_EVIDENCE, POSSIBLE_AMENDMENT, EVIDENCE_CHANGED, new', () => {
    const baseText = 'Total Due: $100.00';
    const baseVal = validateSingle(baseText, 'Total Due: $100.00');
    const baseSnap = toBaseline(baseVal);

    // new (no baseline)
    expect(
      classifyChange(null, baseVal, {
        baselineParser: 'p1',
        nextParser: 'p1',
        baselineText: baseText,
        nextText: baseText,
        nextRanges: EMPTY_RANGES,
        dateOrder: 'MDY',
      }),
    ).toEqual({ changeKind: 'new', changeReason: null });

    // TYPE_CHANGED
    expect(
      classifyChange({ ...baseSnap, fieldType: 'string', value: '$100.00' }, baseVal, {
        baselineParser: 'p1',
        nextParser: 'p1',
        baselineText: baseText,
        nextText: baseText,
        nextRanges: EMPTY_RANGES,
        dateOrder: 'MDY',
      }),
    ).toEqual({ changeKind: 'changed', changeReason: 'TYPE_CHANGED' });

    // GAP_INVOLVED (value -> gap AND gap -> gap)
    const gapVal = validateExtraction(moneyTpl, baseText, EMPTY_RANGES, {
      fields: {
        total_amount: {
          found: false,
          value: null,
          rawValue: null,
          quote: null,
          line: null,
          notFoundReason: 'missing',
        },
      },
      documentFlags: { suspiciousInstructions: false, spans: [] },
    })[0]!;
    expect(
      classifyChange(baseSnap, gapVal, {
        baselineParser: 'p1',
        nextParser: 'p1',
        baselineText: baseText,
        nextText: baseText,
        nextRanges: EMPTY_RANGES,
        dateOrder: 'MDY',
      }),
    ).toEqual({ changeKind: 'changed', changeReason: 'GAP_INVOLVED' });
    expect(
      classifyChange(toBaseline(gapVal), gapVal, {
        baselineParser: 'p1',
        nextParser: 'p1',
        baselineText: baseText,
        nextText: baseText,
        nextRanges: EMPTY_RANGES,
        dateOrder: 'MDY',
      }),
    ).toEqual({ changeKind: 'changed', changeReason: 'GAP_INVOLVED' });

    // PARSER_CHANGED
    expect(
      classifyChange(baseSnap, baseVal, {
        baselineParser: 'pdfjs-6.5.438/lines-1',
        nextParser: 'pdfjs-6.6.0/lines-2',
        baselineText: baseText,
        nextText: baseText,
        nextRanges: EMPTY_RANGES,
        dateOrder: 'MDY',
      }),
    ).toEqual({ changeKind: 'changed', changeReason: 'PARSER_CHANGED' });

    // EVIDENCE_HIDDEN (baseline canonical line is now hidden in nextText while another visible line exists)
    const hiddenNextText = 'Total Due: $100.00\nGrand Total: $100.00';
    const hiddenRanges: TextRanges = {
      hidden: [[0, 'Total Due: $100.00'.length, 'OFF_PAGE']],
      lowVisibility: [],
    };
    const nextVisibleVal = validateSingle(
      hiddenNextText,
      'Grand Total: $100.00',
      '100',
      hiddenRanges,
    );
    expect(
      classifyChange(baseSnap, nextVisibleVal, {
        baselineParser: 'p1',
        nextParser: 'p1',
        baselineText: baseText,
        nextText: hiddenNextText,
        nextRanges: hiddenRanges,
        dateOrder: 'MDY',
      }),
    ).toEqual({ changeKind: 'changed', changeReason: 'EVIDENCE_HIDDEN' });

    // WEAK_EVIDENCE_LINE
    const weakText = '$100.00';
    const weakVal = validateSingle(weakText, '$100.00');
    expect(
      classifyChange(toBaseline(weakVal), weakVal, {
        baselineParser: 'p1',
        nextParser: 'p1',
        baselineText: weakText,
        nextText: weakText,
        nextRanges: EMPTY_RANGES,
        dateOrder: 'MDY',
      }),
    ).toEqual({ changeKind: 'changed', changeReason: 'WEAK_EVIDENCE_LINE' });

    // CONFLICTING_EVIDENCE (next value has CONFLICTING_LINES)
    const conflictText = 'Total Due: $100.00\nTotal Due: $250.00';
    const conflictVal = validateSingle(conflictText, 'Total Due: $100.00');
    expect(
      classifyChange(baseSnap, conflictVal, {
        baselineParser: 'p1',
        nextParser: 'p1',
        baselineText: baseText,
        nextText: conflictText,
        nextRanges: EMPTY_RANGES,
        dateOrder: 'MDY',
      }),
    ).toEqual({ changeKind: 'changed', changeReason: 'CONFLICTING_EVIDENCE' });

    // POSSIBLE_AMENDMENT (added line contains baseline label anchor with a different value, without starting identically)
    const amendText = 'Total Due: $100.00\nAddendum: Revised Total Due: $250.00';
    const amendVal = validateSingle(amendText, 'Total Due: $100.00');
    expect(
      classifyChange(baseSnap, amendVal, {
        baselineParser: 'p1',
        nextParser: 'p1',
        baselineText: baseText,
        nextText: amendText,
        nextRanges: EMPTY_RANGES,
        dateOrder: 'MDY',
      }),
    ).toEqual({ changeKind: 'changed', changeReason: 'POSSIBLE_AMENDMENT' });

    // EVIDENCE_CHANGED (formatting-only change $5,230.29 -> $5230.29)
    const fmtBase = validateSingle('Total Due: $5,230.29', 'Total Due: $5,230.29', '5230.29');
    const fmtNext = validateSingle('Total Due: $5230.29', 'Total Due: $5230.29', '5230.29');
    expect(
      classifyChange(toBaseline(fmtBase), fmtNext, {
        baselineParser: 'p1',
        nextParser: 'p1',
        baselineText: 'Total Due: $5,230.29',
        nextText: 'Total Due: $5230.29',
        nextRanges: EMPTY_RANGES,
        dateOrder: 'MDY',
      }),
    ).toEqual({ changeKind: 'changed', changeReason: 'EVIDENCE_CHANGED' });
  });

  it('[I6] core.carryover.revert-baseline-not-carried: decideCarry carries approve/correct on same, never revert', () => {
    const same = { changeKind: 'same' as const, changeReason: null };
    const changed = { changeKind: 'changed' as const, changeReason: 'VALUE_CHANGED' as const };

    expect(decideCarry(same, { id: 'rev-1', decision: 'approve' })).toBe('rev-1');
    expect(decideCarry(same, { id: 'rev-2', decision: 'correct' })).toBe('rev-2');
    expect(decideCarry(same, { id: 'rev-3', decision: 'revert' })).toBeNull();
    expect(decideCarry(same, null)).toBeNull();
    expect(decideCarry(changed, { id: 'rev-1', decision: 'approve' })).toBeNull();
  });

  it('[I6] handles mid-line POSSIBLE_AMENDMENT, multi-line EVIDENCE_HIDDEN, transitive v1->v2->v3 chains, and carried corrections', () => {
    // 1. Mid-line token POSSIBLE_AMENDMENT: "The initial term shall be twenty-four (24) months"
    const numTpl: ExtractionTemplateSpec = {
      documentType: 'lease',
      defaultCurrency: 'USD',
      dateOrder: 'MDY',
      fields: [{ fieldKey: 'term_months', fieldType: 'number', position: 1, label: 'Term' }],
    };
    const v1Lease = 'The initial term shall be twenty-four (24) months';
    const v2Lease =
      'The initial term shall be twenty-four (24) months\nAmendment: The initial term shall be thirty-six (36) months';
    const baseTerm = validateExtraction(numTpl, v1Lease, EMPTY_RANGES, {
      fields: {
        term_months: {
          found: true,
          value: '24',
          rawValue: '24',
          quote: v1Lease,
          line: 1,
          notFoundReason: null,
        },
      },
      documentFlags: { suspiciousInstructions: false, spans: [] },
    })[0]!;
    const nextTerm = validateExtraction(numTpl, v2Lease, EMPTY_RANGES, {
      fields: {
        term_months: {
          found: true,
          value: '24',
          rawValue: '24',
          quote: v1Lease,
          line: 1,
          notFoundReason: null,
        },
      },
      documentFlags: { suspiciousInstructions: false, spans: [] },
    })[0]!;
    expect(
      classifyChange(toBaseline(baseTerm), nextTerm, {
        baselineParser: 'p1',
        nextParser: 'p1',
        baselineText: v1Lease,
        nextText: v2Lease,
        nextRanges: EMPTY_RANGES,
        dateOrder: 'MDY',
      }),
    ).toEqual({ changeKind: 'changed', changeReason: 'POSSIBLE_AMENDMENT' });

    // 2. Multi-line baseline canonicalEvidence hidden in v2 -> EVIDENCE_HIDDEN (priority 5, not EVIDENCE_CHANGED)
    const v1Split = 'Amount payable under\nSection 4: $100.00';
    const v2Split = 'Amount payable under\nSection 4: $100.00\nGrand Total: $100.00';
    const v2Ranges: TextRanges = {
      hidden: [[0, v1Split.length, 'OFF_PAGE']],
      lowVisibility: [],
    };
    const splitBase = validateSingle(v1Split, v1Split, '100');
    const splitNext = validateSingle(v2Split, 'Grand Total: $100.00', '100', v2Ranges);
    expect(
      classifyChange(toBaseline(splitBase), splitNext, {
        baselineParser: 'p1',
        nextParser: 'p1',
        baselineText: v1Split,
        nextText: v2Split,
        nextRanges: v2Ranges,
        dateOrder: 'MDY',
      }),
    ).toEqual({ changeKind: 'changed', changeReason: 'EVIDENCE_HIDDEN' });

    // 3. Transitive v1 -> v2 -> v3 chain with carried correction (comparing original extracted values)
    const docText = 'Total Due: $100.00';
    const v1Val = validateSingle(docText, docText, '100');
    const v2Val = validateSingle(docText, docText, '100');
    const v3Val = validateSingle(docText, docText, '100');

    const cls12 = classifyChange(toBaseline(v1Val), v2Val, {
      baselineParser: 'p1',
      nextParser: 'p1',
      baselineText: docText,
      nextText: docText,
      nextRanges: EMPTY_RANGES,
      dateOrder: 'MDY',
    });
    const carriedToV2 = decideCarry(cls12, { id: 'rev-v1-correct', decision: 'correct' });
    expect(carriedToV2).toBe('rev-v1-correct');

    const cls23 = classifyChange(toBaseline(v2Val), v3Val, {
      baselineParser: 'p1',
      nextParser: 'p1',
      baselineText: docText,
      nextText: docText,
      nextRanges: EMPTY_RANGES,
      dateOrder: 'MDY',
    });
    const carriedToV3 = decideCarry(cls23, { id: 'rev-v2-carried-correct', decision: 'correct' });
    expect(carriedToV3).toBe('rev-v2-carried-correct');
  });
});
