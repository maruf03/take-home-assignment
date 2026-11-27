import { VERSION_ERROR_CODES } from '@app/contracts/problems';
import {
  LLM_CALL_KINDS,
  RUN_STATUSES,
  RUN_TRIGGERS,
  VERSION_ORIGINS,
  VERSION_STATUSES,
  VERSION_WARNINGS,
} from '@app/contracts/status';
import { HEX64_REGEX_SOURCE } from '@app/contracts/values';
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  type PgTableExtraConfigValue,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { inList, sqlRegex, sqlTextArray } from '../sql/value-shape.js';
import { documentTypes, extractionTemplates } from './templates.js';

export const documents = pgTable(
  'documents',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    externalId: text('external_id'),
    type: text('type')
      .notNull()
      .references(() => documentTypes.key, { onDelete: 'restrict' }),
    title: text('title').notNull(),
    latestVersionNumber: integer('latest_version_number').notNull().default(0),
    reviewableVersionId: uuid('reviewable_version_id'),
    pendingCount: integer('pending_count').notNull().default(0),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedReason: text('deleted_reason'),
    deletedRequestId: text('deleted_request_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t): PgTableExtraConfigValue[] => [
    unique('documents_external_id_uq').on(t.externalId),
    foreignKey({
      name: 'documents_reviewable_version_fk',
      columns: [t.id, t.reviewableVersionId],
      foreignColumns: [documentVersions.documentId, documentVersions.id],
    }).onDelete('restrict'),
    index('documents_alive_id_idx')
      .on(t.id)
      .where(sql`deleted_at IS NULL`),
    index('documents_alive_type_id_idx')
      .on(t.type, t.id)
      .where(sql`deleted_at IS NULL`),
    index('documents_alive_pending_id_idx')
      .on(t.id)
      .where(sql`deleted_at IS NULL AND pending_count > 0`),
    index('documents_alive_type_pending_id_idx')
      .on(t.type, t.id)
      .where(sql`deleted_at IS NULL AND pending_count > 0`),
    index('documents_deleted_at_id_idx')
      .on(t.deletedAt, t.id)
      .where(sql`deleted_at IS NOT NULL`),
    check('documents_title_len_chk', sql`char_length(title) BETWEEN 1 AND 200`),
    check('documents_latest_version_number_chk', sql`latest_version_number >= 0`),
    check('documents_pending_count_chk', sql`pending_count >= 0`),
    check(
      'documents_deleted_reason_chk',
      sql`deleted_reason IS NULL OR (deleted_at IS NOT NULL AND char_length(deleted_reason) <= 500)`,
    ),
    check(
      'documents_deleted_request_id_chk',
      sql`deleted_request_id IS NULL OR deleted_at IS NOT NULL`,
    ),
  ],
);

export const documentVersions = pgTable(
  'document_versions',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    documentId: uuid('document_id')
      .notNull()
      .references((): AnyPgColumn => documents.id, { onDelete: 'restrict' }),
    versionNumber: integer('version_number').notNull(),
    templateId: uuid('template_id')
      .notNull()
      .references(() => extractionTemplates.id, { onDelete: 'restrict' }),
    origin: text('origin').notNull().default('upload'),
    sourceVersionId: uuid('source_version_id'),
    status: text('status').notNull().default('queued'),
    storageKey: text('storage_key').notNull(),
    fileSha256: text('file_sha256').notNull(),
    fileSizeBytes: integer('file_size_bytes').notNull(),
    originalFilename: text('original_filename').notNull(),
    parsedText: text('parsed_text'),
    parsedTextSha256: text('parsed_text_sha256'),
    parser: text('parser'),
    pageOffsets: integer('page_offsets').array(),
    textRanges: jsonb('text_ranges'),
    warnings: text('warnings')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    attempts: integer('attempts').notNull().default(0),
    runSeq: integer('run_seq').notNull().default(0),
    activeRunId: uuid('active_run_id'),
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
    workerId: text('worker_id'),
    enqueuedAt: timestamp('enqueued_at', { withTimezone: true }),
    lastErrorCode: text('last_error_code'),
    lastErrorMessage: text('last_error_message'),
    extractedAt: timestamp('extracted_at', { withTimezone: true }),
    createdRequestId: text('created_request_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t): PgTableExtraConfigValue[] => [
    unique('document_versions_doc_id_id_uq').on(t.documentId, t.id),
    unique('document_versions_doc_id_number_uq').on(t.documentId, t.versionNumber),
    foreignKey({
      name: 'document_versions_source_version_fk',
      columns: [t.sourceVersionId],
      foreignColumns: [t.id],
    }).onDelete('restrict'),
    foreignKey({
      name: 'document_versions_active_run_fk',
      columns: [t.activeRunId],
      foreignColumns: [extractionRuns.id],
    }).onDelete('restrict'),
    index('document_versions_inflight_idx')
      .on(t.status, t.leaseUntil)
      .where(sql`status IN ('queued', 'extracting')`),
    index('document_versions_template_id_idx').on(t.templateId),
    check('document_versions_version_number_chk', sql`version_number >= 1`),
    check('document_versions_origin_chk', sql`origin IN (${inList(VERSION_ORIGINS)})`),
    check(
      'document_versions_source_version_chk',
      sql`(origin = 'reextract') = (source_version_id IS NOT NULL)`,
    ),
    check('document_versions_status_chk', sql`status IN (${inList(VERSION_STATUSES)})`),
    check('document_versions_file_sha_chk', sqlRegex('file_sha256', HEX64_REGEX_SOURCE)),
    check('document_versions_file_size_chk', sql`file_size_bytes BETWEEN 1 AND 10485760`),
    check(
      'document_versions_original_filename_chk',
      sql`octet_length(original_filename) BETWEEN 1 AND 255`,
    ),
    check(
      'document_versions_parsed_text_pair_chk',
      sql`(parsed_text IS NULL) = (parsed_text_sha256 IS NULL)`,
    ),
    check(
      'document_versions_parsed_text_sha_chk',
      sql`parsed_text_sha256 IS NULL OR ${sqlRegex('parsed_text_sha256', HEX64_REGEX_SOURCE)}`,
    ),
    check(
      'document_versions_text_ranges_chk',
      sql`text_ranges IS NULL OR jsonb_typeof(text_ranges) = 'object'`,
    ),
    check('document_versions_warnings_chk', sql`warnings <@ ${sqlTextArray(VERSION_WARNINGS)}`),
    check('document_versions_attempts_chk', sql`attempts >= 0`),
    check('document_versions_run_seq_chk', sql`run_seq >= 0`),
    check(
      'document_versions_extracting_lease_chk',
      sql`(status = 'extracting') = (active_run_id IS NOT NULL AND lease_until IS NOT NULL AND worker_id IS NOT NULL)`,
    ),
    check(
      'document_versions_failed_error_chk',
      sql`(status = 'failed') = (last_error_code IS NOT NULL)`,
    ),
    check(
      'document_versions_last_error_code_chk',
      sql`last_error_code IS NULL OR last_error_code IN (${inList(VERSION_ERROR_CODES)})`,
    ),
    check(
      'document_versions_extracted_at_chk',
      sql`(status = 'extracted') = (extracted_at IS NOT NULL)`,
    ),
    check(
      'document_versions_extracted_text_chk',
      sql`status <> 'extracted' OR parsed_text IS NOT NULL`,
    ),
  ],
);

export const extractionRuns = pgTable(
  'extraction_runs',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    versionId: uuid('version_id')
      .notNull()
      .references((): AnyPgColumn => documentVersions.id, { onDelete: 'restrict' }),
    runNumber: integer('run_number').notNull(),
    status: text('status').notNull(),
    trigger: text('trigger').notNull(),
    correlationId: text('correlation_id'),
    workerId: text('worker_id').notNull(),
    chunked: boolean('chunked').notNull().default(false),
    llmCallCount: integer('llm_call_count').notNull().default(0),
    reusedCallCount: integer('reused_call_count').notNull().default(0),
    costUsd: numeric('cost_usd', { precision: 12, scale: 6 }).notNull().default('0'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t): PgTableExtraConfigValue[] => [
    unique('extraction_runs_id_version_id_uq').on(t.id, t.versionId),
    unique('extraction_runs_version_run_number_uq').on(t.versionId, t.runNumber),
    uniqueIndex('extraction_runs_one_running_per_version_idx')
      .on(t.versionId)
      .where(sql`status = 'running'`),
    check('extraction_runs_run_number_chk', sql`run_number >= 1`),
    check('extraction_runs_status_chk', sql`status IN (${inList(RUN_STATUSES)})`),
    check(
      'extraction_runs_running_finished_chk',
      sql`(status = 'running') = (finished_at IS NULL)`,
    ),
    check('extraction_runs_trigger_chk', sql`trigger IN (${inList(RUN_TRIGGERS)})`),
    check('extraction_runs_llm_call_count_chk', sql`llm_call_count >= 0`),
    check('extraction_runs_reused_call_count_chk', sql`reused_call_count >= 0`),
    check('extraction_runs_cost_usd_chk', sql`cost_usd >= 0`),
  ],
);

export const llmCalls = pgTable(
  'llm_calls',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    runId: uuid('run_id').notNull(),
    versionId: uuid('version_id').notNull(),
    seq: integer('seq').notNull(),
    kind: text('kind').notNull(),
    chunkIndex: integer('chunk_index'),
    requestSha256: text('request_sha256').notNull(),
    reusedFromCallId: uuid('reused_from_call_id'),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    servedModel: text('served_model'),
    promptVersion: text('prompt_version').notNull(),
    request: jsonb('request').notNull(),
    providerRequestId: text('provider_request_id'),
    rawResponse: jsonb('raw_response'),
    stopReason: text('stop_reason'),
    schemaValid: boolean('schema_valid'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    usage: jsonb('usage'),
    costUsd: numeric('cost_usd', { precision: 12, scale: 6 }).notNull().default('0'),
    latencyMs: integer('latency_ms'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    unique('llm_calls_run_seq_uq').on(t.runId, t.seq),
    foreignKey({
      name: 'llm_calls_run_version_fk',
      columns: [t.runId, t.versionId],
      foreignColumns: [extractionRuns.id, extractionRuns.versionId],
    }).onDelete('restrict'),
    foreignKey({
      name: 'llm_calls_reused_from_fk',
      columns: [t.reusedFromCallId],
      foreignColumns: [t.id],
    }).onDelete('restrict'),
    index('llm_calls_reuse_lookup_idx')
      .on(t.versionId, t.requestSha256)
      .where(sql`schema_valid = true`),
    index('llm_calls_billed_count_idx')
      .on(t.versionId)
      .where(sql`reused_from_call_id IS NULL`),
    check('llm_calls_seq_chk', sql`seq >= 1`),
    check('llm_calls_kind_chk', sql`kind IN (${inList(LLM_CALL_KINDS)})`),
    check(
      'llm_calls_chunk_index_chk',
      sql`(kind = 'chunk') = (chunk_index IS NOT NULL) AND (chunk_index IS NULL OR chunk_index >= 0)`,
    ),
    check('llm_calls_request_sha_chk', sqlRegex('request_sha256', HEX64_REGEX_SOURCE)),
    check('llm_calls_cost_usd_chk', sql`cost_usd >= 0`),
  ],
);
