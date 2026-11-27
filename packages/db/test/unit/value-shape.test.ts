import { describe, expect, it } from 'vitest';
import {
  inList,
  sqlQuote,
  sqlRegex,
  sqlTextArray,
  valueShapeSql,
} from '../../src/sql/value-shape.js';

describe('SQL value-shape helpers', () => {
  it('quotes SQL literals and escapes single quotes', () => {
    expect(sqlQuote('hello')).toBe("'hello'");
    expect(sqlQuote("it's")).toBe("'it''s'");
  });

  it('rejects empty inList and builds valid SQL fragments', () => {
    expect(() => inList([])).toThrow();
    expect(inList(['a', 'b'])).toBeDefined();
    expect(sqlTextArray(['A', 'B'])).toBeDefined();
    expect(sqlRegex('col', '^[a-z]+$')).toBeDefined();
    expect(valueShapeSql('field_type', 'value')).toBeDefined();
  });
});
