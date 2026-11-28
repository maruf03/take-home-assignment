import { describe, expect, it } from 'vitest';
import { buildDocumentLines } from '../../src/shared/lib/text-segments.js';

describe('text-segments pure builder', () => {
  it('splits lines on \\n and \\f and builds non-overlapping segments for active mark, other occurrences, hidden, and low-visibility ranges', () => {
    const text = 'Alpha $100\nBeta $100 fine\fHidden secret';
    const alphaMoneyStart = text.indexOf('$100');
    const betaMoneyStart = text.indexOf('$100', alphaMoneyStart + 1);
    const fineStart = text.indexOf('fine');
    const hiddenStart = text.indexOf('Hidden secret');

    const lines = buildDocumentLines(text, {
      activeRange: { start: alphaMoneyStart, end: alphaMoneyStart + 4 },
      otherOccurrences: [{ start: betaMoneyStart, end: betaMoneyStart + 4 }],
      textRanges: {
        hidden: [[hiddenStart, hiddenStart + 'Hidden secret'.length, 'OFF_PAGE']],
        lowVisibility: [[fineStart, fineStart + 4]],
      },
    });

    expect(lines).toHaveLength(3);
    expect(lines[0]!.lineNumber).toBe(1);
    expect(lines[0]!.pageNumber).toBe(1);
    expect(lines[0]!.segments.find((s) => s.active)?.text).toBe('$100');

    expect(lines[1]!.lineNumber).toBe(2);
    expect(lines[1]!.segments.find((s) => s.otherOccurrence)?.text).toBe('$100');
    expect(lines[1]!.segments.find((s) => s.lowVisibility)?.text).toBe('fine');

    expect(lines[2]!.lineNumber).toBe(3);
    expect(lines[2]!.pageNumber).toBe(2);
    expect(lines[2]!.segments.find((s) => s.hiddenReason === 'OFF_PAGE')?.text).toBe(
      'Hidden secret',
    );
  });

  it('preserves overlapping flags (active + lowVisibility, hidden + lowVisibility) and multi-line evidence', () => {
    const text = 'Line one start\nLine two end\nHidden faint tail';
    const start = text.indexOf('start');
    const end = text.indexOf('end') + 3;
    const hiddenStart = text.indexOf('Hidden faint tail');
    const faintStart = text.indexOf('faint');

    const lines = buildDocumentLines(text, {
      activeRange: { start, end },
      otherOccurrences: [],
      textRanges: {
        hidden: [[hiddenStart, hiddenStart + 'Hidden faint tail'.length, 'WHITE_ON_WHITE']],
        lowVisibility: [
          [start, end],
          [faintStart, faintStart + 'faint'.length],
        ],
      },
    });

    expect(lines).toHaveLength(3);
    expect(lines[0]!.segments.find((s) => s.text === 'start')).toMatchObject({
      active: true,
      lowVisibility: true,
    });
    expect(lines[1]!.segments.find((s) => s.text === 'Line two end')).toMatchObject({
      active: true,
      lowVisibility: true,
    });
    const hiddenSegs = lines[2]!.segments.filter((s) => s.hiddenReason === 'WHITE_ON_WHITE');
    expect(hiddenSegs).toHaveLength(3);
    expect(hiddenSegs[1]).toMatchObject({
      text: 'faint',
      hiddenReason: 'WHITE_ON_WHITE',
      lowVisibility: true,
    });
  });
});
