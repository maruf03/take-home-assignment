import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  buildNormIndex,
  classifyChange,
  lineIndex,
  lineNumberAtOffset,
  maskHiddenText,
  matchNormalize,
  normSpanToOrigSpan,
  validateExtraction,
  type BaselineFieldSnapshot,
  type ExtractionTemplateSpec,
} from '../src/index.js';

const EMPTY_RANGES = { hidden: [], lowVisibility: [] };

const SIMPLE_TEMPLATE: ExtractionTemplateSpec = {
  documentType: 'invoice',
  defaultCurrency: 'USD',
  dateOrder: 'MDY',
  fields: [{ fieldKey: 'total_amount', fieldType: 'money', position: 1, label: 'Total amount' }],
};

describe('fast-check properties (§5.2, §5.5, §5.6)', () => {
  it('M is idempotent: M(M(s)) === M(s)', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        expect(matchNormalize(matchNormalize(s))).toBe(matchNormalize(s));
      }),
    );
  });

  it('buildNormIndex offset map round-trips any normalized non-empty token span back to original text (including astral Unicode)', () => {
    const wordArb = fc.oneof(
      fc.stringMatching(/^[A-Za-z0-9$.,:-]{1,12}$/),
      fc.constantFrom('💰$100', '📄Doc', 'café', '½-inch'),
    );
    fc.assert(
      fc.property(
        fc.array(wordArb, { minLength: 1, maxLength: 10 }),
        fc.array(fc.constantFrom(' ', '  ', '\t', '\n', ' \n '), { minLength: 10, maxLength: 10 }),
        (words, seps) => {
          let text = seps[0]!;
          for (let i = 0; i < words.length; i++) {
            text += words[i]! + (seps[i + 1] ?? ' ');
          }

          const idx = buildNormIndex(text);
          expect(idx.norm).toBe(matchNormalize(text));
          expect(idx.toOrig.length).toBe(idx.norm.length);

          // Test roundtrip on every single word and on the full normalized string
          let pos = 0;
          for (const word of words) {
            const ns = idx.norm.indexOf(word, pos);
            expect(ns).toBeGreaterThanOrEqual(0);
            const ne = ns + word.length;
            const orig = normSpanToOrigSpan(idx, ns, ne);
            expect(matchNormalize(text.slice(orig.start, orig.end))).toBe(word);
            pos = ne;
          }

          const fullOrig = normSpanToOrigSpan(idx, 0, idx.norm.length);
          expect(matchNormalize(text.slice(fullOrig.start, fullOrig.end))).toBe(idx.norm);
        },
      ),
    );
  });

  it('lineIndex and maskHiddenText preserve exact UTF-16 lengths, line counts, and page breaks', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.array(fc.stringMatching(/^[A-Za-z0-9 ]{0,20}$/), { minLength: 1, maxLength: 5 }),
          { minLength: 1, maxLength: 4 },
        ),
        (pages) => {
          const text = pages.map((p) => p.join('\n')).join('\f');
          const lines = lineIndex(text);
          const expectedLineCount = pages.reduce((sum, p) => sum + p.length, 0);
          expect(lines).toHaveLength(expectedLineCount);

          for (let i = 0; i < lines.length; i++) {
            const l = lines[i]!;
            expect(l.lineNumber).toBe(i + 1);
            expect(text.slice(l.start, l.end)).toBe(l.text);
            expect(lineNumberAtOffset(lines, l.start)).toBe(l.lineNumber);
          }

          const mid = Math.floor(text.length / 2);
          const masked = maskHiddenText(text, {
            hidden: [[0, mid, 'OFF_PAGE']],
            lowVisibility: [],
          });
          expect(masked.length).toBe(text.length);
          expect(lineIndex(masked).length).toBe(lines.length);
        },
      ),
    );
  });

  it('whitespace-perturbed quotes still match and resolve to exact original offsets', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 9999 }),
        fc.constantFrom(' ', '  ', '   ', '\t'),
        fc.constantFrom(' ', '   ', '  '),
        (dollars, ws1, ws2) => {
          const text = `Header Line\nTotal Due: $${dollars}.00\nFooter Line`;
          const perturbedQuote = `${ws1}Total${ws2}Due:${ws1}$${dollars}.00${ws2}`;

          const res = validateExtraction(SIMPLE_TEMPLATE, text, EMPTY_RANGES, {
            fields: {
              total_amount: {
                found: true,
                value: { amount: String(dollars), currency: 'USD' },
                rawValue: `$${dollars}.00`,
                quote: perturbedQuote,
                line: 2,
                notFoundReason: null,
              },
            },
            documentFlags: { suspiciousInstructions: false, spans: [] },
          })[0]!;

          expect(res.kind).toBe('value');
          expect(res.value).toEqual({ amount: String(dollars), currency: 'USD' });
          expect(text.slice(res.evidenceStart!, res.evidenceEnd!)).toBe(
            `Total Due: $${dollars}.00`,
          );
        },
      ),
    );
  });

  it('[R7] shift-invariance and permutation-invariance: shifting or reordering unrelated lines keeps changeKind=same; editing evidence line makes it changed', () => {
    const unrelatedLineArb = fc.stringMatching(/^Note [A-Za-z0-9]{1,12}$/);

    fc.assert(
      fc.property(
        fc.integer({ min: 10, max: 9999 }),
        fc.array(unrelatedLineArb, { minLength: 0, maxLength: 5 }),
        fc.array(unrelatedLineArb, { minLength: 0, maxLength: 5 }),
        (dollars, prefixLines, suffixLines) => {
          const targetLine = `Total Due: $${dollars}.00`;
          const baseText = ['Header: Doc', targetLine, 'Footer: End'].join('\n');
          const shiftedText = [
            ...prefixLines,
            'Footer: End',
            targetLine,
            'Header: Doc',
            ...suffixLines,
          ].join('\n');

          const baseVal = validateExtraction(SIMPLE_TEMPLATE, baseText, EMPTY_RANGES, {
            fields: {
              total_amount: {
                found: true,
                value: { amount: String(dollars), currency: 'USD' },
                rawValue: `$${dollars}.00`,
                quote: targetLine,
                line: 2,
                notFoundReason: null,
              },
            },
            documentFlags: { suspiciousInstructions: false, spans: [] },
          })[0]!;

          const nextVal = validateExtraction(SIMPLE_TEMPLATE, shiftedText, EMPTY_RANGES, {
            fields: {
              total_amount: {
                found: true,
                value: { amount: String(dollars), currency: 'USD' },
                rawValue: `$${dollars}.00`,
                quote: targetLine,
                line: prefixLines.length + 2,
                notFoundReason: null,
              },
            },
            documentFlags: { suspiciousInstructions: false, spans: [] },
          })[0]!;

          const baseSnap: BaselineFieldSnapshot = {
            id: 'b1',
            fieldKey: 'total_amount',
            fieldType: 'money',
            kind: baseVal.kind,
            value: baseVal.value,
            canonicalEvidence: baseVal.canonicalEvidence,
            flags: baseVal.flags,
          };

          // Shift + permutation of unrelated lines -> same
          expect(
            classifyChange(baseSnap, nextVal, {
              baselineParser: 'p1',
              nextParser: 'p1',
              baselineText: baseText,
              nextText: shiftedText,
              nextRanges: EMPTY_RANGES,
              dateOrder: 'MDY',
            }),
          ).toEqual({ changeKind: 'same', changeReason: null });

          // Editing the evidence line itself -> changed (pending)
          const editedLine = `Total Payable: $${dollars}.00`;
          const editedText = ['Header: Doc', editedLine, 'Footer: End'].join('\n');
          const editedVal = validateExtraction(SIMPLE_TEMPLATE, editedText, EMPTY_RANGES, {
            fields: {
              total_amount: {
                found: true,
                value: { amount: String(dollars), currency: 'USD' },
                rawValue: `$${dollars}.00`,
                quote: editedLine,
                line: 2,
                notFoundReason: null,
              },
            },
            documentFlags: { suspiciousInstructions: false, spans: [] },
          })[0]!;

          expect(
            classifyChange(baseSnap, editedVal, {
              baselineParser: 'p1',
              nextParser: 'p1',
              baselineText: baseText,
              nextText: editedText,
              nextRanges: EMPTY_RANGES,
              dateOrder: 'MDY',
            }).changeKind,
          ).toBe('changed');
        },
      ),
    );
  });
});
