import {
  CHANGE_KINDS,
  CHANGE_REASONS,
  EXTRACTED_VALUE_KINDS,
  FIELD_TYPES,
  GAP_CODES,
  MATCH_MODES,
  REVIEW_DECISIONS,
  REVIEW_ORIGINS,
  VALUE_FLAGS,
} from '@app/contracts/status';
import { FIELD_KEY_REGEX_SOURCE } from '@app/contracts/values';
import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  type PgTableExtraConfigValue,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { inList, sqlRegex, sqlTextArray, valueShapeSql } from '../sql/value-shape.js';
import { documentVersions, extractionRuns } from './documents.js';

export const extractedValues = pgTable(
  'extracted_values',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    versionId: uuid('version_id')
      .notNull()
      .references(() => documentVersions.id, { onDelete: 'restrict' }),
    runId: uuid('run_id')
      .notNull()
      .references(() => extractionRuns.id, { onDelete: 'restrict' }),
    fieldKey: text('field_key').notNull(),
    fieldType: text('field_type').notNull(),
    kind: text('kind').notNull(),
    value: jsonb('value'),
    rawValue: text('raw_value'),
    evidence: text('evidence'),
    attemptedQuote: text('attempted_quote'),
    canonicalEvidence: text('canonical_evidence'),
    evidenceStart: integer('evidence_start'),
    evidenceEnd: integer('evidence_end'),
    evidenceMatchCount: integer('evidence_match_count'),
    citedLine: integer('cited_line'),
    matchMode: text('match_mode'),
    chunkIndex: integer('chunk_index'),
    gapCode: text('gap_code'),
    gapReason: text('gap_reason'),
    flags: text('flags')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    baselineValueId: uuid('baseline_value_id'),
    changeKind: text('change_kind').notNull(),
    changeReason: text('change_reason'),
    currentReviewId: uuid('current_review_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t): PgTableExtraConfigValue[] => [
    unique('extracted_values_id_field_type_uq').on(t.id, t.fieldType),
    unique('extracted_values_version_field_key_uq').on(t.versionId, t.fieldKey),
    foreignKey({
      name: 'extracted_values_baseline_value_fk',
      columns: [t.baselineValueId],
      foreignColumns: [t.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'extracted_values_current_review_fk',
      columns: [t.id, t.currentReviewId],
      foreignColumns: [reviews.valueId, reviews.id],
    }).onDelete('restrict'),
    index('extracted_values_run_id_idx').on(t.runId),
    check('extracted_values_field_key_chk', sqlRegex('field_key', FIELD_KEY_REGEX_SOURCE)),
    check('extracted_values_field_type_chk', sql`field_type IN (${inList(FIELD_TYPES)})`),
    check('extracted_values_kind_chk', sql`kind IN (${inList(EXTRACTED_VALUE_KINDS)})`),
    check('extracted_values_attempted_quote_chk', sql`kind = 'gap' OR attempted_quote IS NULL`),
    check(
      'extracted_values_match_mode_chk',
      sql`match_mode IS NULL OR match_mode IN (${inList(MATCH_MODES)})`,
    ),
    check(
      'extracted_values_gap_code_chk',
      sql`gap_code IS NULL OR gap_code IN (${inList(GAP_CODES)})`,
    ),
    check('extracted_values_flags_chk', sql`flags <@ ${sqlTextArray(VALUE_FLAGS)}`),
    check('extracted_values_change_kind_chk', sql`change_kind IN (${inList(CHANGE_KINDS)})`),
    check(
      'extracted_values_baseline_chk',
      sql`(change_kind = 'new') = (baseline_value_id IS NULL)`,
    ),
    check(
      'extracted_values_change_reason_chk',
      sql`(change_kind = 'changed') = (change_reason IS NOT NULL) AND (change_reason IS NULL OR change_reason IN (${inList(CHANGE_REASONS)}))`,
    ),
    check(
      'extracted_values_gap_and_value_shape_chk',
      sql`(
        (kind = 'gap'
          AND value IS NULL
          AND evidence IS NULL
          AND canonical_evidence IS NULL
          AND gap_code IS NOT NULL
          AND gap_reason IS NOT NULL)
        OR
        (kind = 'value'
          AND gap_code IS NULL
          AND gap_reason IS NULL
          AND evidence IS NOT NULL
          AND canonical_evidence IS NOT NULL
          AND ${valueShapeSql('field_type', 'value')})
      )`,
    ),
  ],
);

export const reviews = pgTable(
  'reviews',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    valueId: uuid('value_id').notNull(),
    fieldType: text('field_type').notNull(),
    decision: text('decision').notNull(),
    correctedValue: jsonb('corrected_value'),
    note: text('note'),
    origin: text('origin').notNull(),
    carriedFromReviewId: uuid('carried_from_review_id'),
    requestId: text('request_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t): PgTableExtraConfigValue[] => [
    unique('reviews_value_id_id_uq').on(t.valueId, t.id),
    foreignKey({
      name: 'reviews_value_field_type_fk',
      columns: [t.valueId, t.fieldType],
      foreignColumns: [extractedValues.id, extractedValues.fieldType],
    }).onDelete('restrict'),
    foreignKey({
      name: 'reviews_carried_from_fk',
      columns: [t.carriedFromReviewId],
      foreignColumns: [t.id],
    }).onDelete('restrict'),
    check('reviews_field_type_chk', sql`field_type IN (${inList(FIELD_TYPES)})`),
    check('reviews_decision_chk', sql`decision IN (${inList(REVIEW_DECISIONS)})`),
    check(
      'reviews_corrected_value_chk',
      sql`(decision = 'correct') = (corrected_value IS NOT NULL) AND (corrected_value IS NULL OR ${valueShapeSql('field_type', 'corrected_value')})`,
    ),
    check('reviews_note_len_chk', sql`note IS NULL OR char_length(note) <= 1000`),
    check('reviews_origin_chk', sql`origin IN (${inList(REVIEW_ORIGINS)})`),
    check(
      'reviews_carried_from_chk',
      sql`(origin = 'carried') = (carried_from_review_id IS NOT NULL)`,
    ),
    check('reviews_carried_not_revert_chk', sql`origin <> 'carried' OR decision <> 'revert'`),
  ],
);
