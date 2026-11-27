import { DATE_ORDERS, FIELD_TYPES } from '@app/contracts/status';
import {
  DOCUMENT_TYPE_KEY_REGEX_SOURCE,
  FIELD_KEY_REGEX_SOURCE,
  HEX64_REGEX_SOURCE,
  ISO_CURRENCY_REGEX_SOURCE,
} from '@app/contracts/values';
import { sql } from 'drizzle-orm';
import {
  check,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { inList, sqlRegex } from '../sql/value-shape.js';

export const documentTypes = pgTable(
  'document_types',
  {
    key: text('key').primaryKey(),
    displayName: text('display_name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  () => [
    check('document_types_key_chk', sqlRegex('key', DOCUMENT_TYPE_KEY_REGEX_SOURCE)),
    check('document_types_display_name_chk', sql`char_length(btrim(display_name)) >= 1`),
  ],
);

export const extractionTemplates = pgTable(
  'extraction_templates',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    documentType: text('document_type')
      .notNull()
      .references(() => documentTypes.key, { onDelete: 'restrict' }),
    version: integer('version').notNull(),
    contentSha256: text('content_sha256').notNull(),
    instructions: text('instructions'),
    defaultCurrency: text('default_currency').notNull().default('USD'),
    dateOrder: text('date_order').notNull().default('MDY'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('extraction_templates_doc_type_version_uq').on(t.documentType, t.version),
    unique('extraction_templates_doc_type_sha_uq').on(t.documentType, t.contentSha256),
    check('extraction_templates_version_chk', sql`version >= 1`),
    check('extraction_templates_sha_chk', sqlRegex('content_sha256', HEX64_REGEX_SOURCE)),
    check(
      'extraction_templates_default_currency_chk',
      sqlRegex('default_currency', ISO_CURRENCY_REGEX_SOURCE),
    ),
    check('extraction_templates_date_order_chk', sql`date_order IN (${inList(DATE_ORDERS)})`),
  ],
);

export const templateFields = pgTable(
  'template_fields',
  {
    templateId: uuid('template_id')
      .notNull()
      .references(() => extractionTemplates.id, { onDelete: 'restrict' }),
    fieldKey: text('field_key').notNull(),
    fieldType: text('field_type').notNull(),
    position: integer('position').notNull(),
    label: text('label').notNull(),
    description: text('description'),
  },
  (t) => [
    primaryKey({ name: 'template_fields_pk', columns: [t.templateId, t.fieldKey] }),
    unique('template_fields_template_position_uq').on(t.templateId, t.position),
    check('template_fields_field_key_chk', sqlRegex('field_key', FIELD_KEY_REGEX_SOURCE)),
    check('template_fields_field_type_chk', sql`field_type IN (${inList(FIELD_TYPES)})`),
    check('template_fields_position_chk', sql`position BETWEEN 1 AND 100`),
    check('template_fields_label_chk', sql`char_length(btrim(label)) >= 1`),
  ],
);
