import {
  CANONICAL_DECIMAL_REGEX_SOURCE,
  ISO_CURRENCY_REGEX_SOURCE,
  ISO_DATE_REGEX_SOURCE,
} from '@app/contracts/values';
import { sql, type SQL } from 'drizzle-orm';

export function sqlQuote(literal: string): string {
  return `'${literal.replaceAll("'", "''")}'`;
}

export function inList(values: readonly string[]): SQL {
  if (values.length === 0) {
    throw new Error('inList requires at least one value');
  }
  return sql.raw(values.map(sqlQuote).join(', '));
}

export function sqlTextArray(values: readonly string[]): SQL {
  return sql.raw(`ARRAY[${values.map(sqlQuote).join(', ')}]::text[]`);
}

export function sqlRegex(col: string, patternSource: string): SQL {
  return sql.raw(`${col} ~ ${sqlQuote(patternSource)}`);
}

/**
 * Generates the SQL CHECK expression enforcing spec §4.10 VALUE_SHAPE(field_type, value)
 * on canonical jsonb values (extracted_values.value and reviews.corrected_value).
 */
export function valueShapeSql(fieldTypeCol: string, valueCol: string): SQL {
  const dec = sqlQuote(CANONICAL_DECIMAL_REGEX_SOURCE);
  const isoDate = sqlQuote(ISO_DATE_REGEX_SOURCE);
  const isoCurrency = sqlQuote(ISO_CURRENCY_REGEX_SOURCE);

  return sql.raw(`(
    (${fieldTypeCol} = 'string'
      AND jsonb_typeof(${valueCol}) = 'string'
      AND char_length(${valueCol} #>> '{}') BETWEEN 1 AND 2000
      AND char_length(btrim(${valueCol} #>> '{}')) >= 1)
    OR (${fieldTypeCol} = 'date'
      AND jsonb_typeof(${valueCol}) = 'string'
      AND (${valueCol} #>> '{}') ~ ${isoDate})
    OR (${fieldTypeCol} = 'money'
      AND jsonb_typeof(${valueCol}) = 'object'
      AND jsonb_typeof(${valueCol} -> 'amount') = 'string'
      AND jsonb_typeof(${valueCol} -> 'currency') = 'string'
      AND (${valueCol} - 'amount' - 'currency') = '{}'::jsonb
      AND (${valueCol} ->> 'amount') ~ ${dec}
      AND (${valueCol} ->> 'currency') ~ ${isoCurrency})
    OR (${fieldTypeCol} IN ('number', 'percent')
      AND jsonb_typeof(${valueCol}) = 'string'
      AND (${valueCol} #>> '{}') ~ ${dec})
  )`);
}
