CREATE TABLE "document_versions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"document_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"template_id" uuid NOT NULL,
	"origin" text DEFAULT 'upload' NOT NULL,
	"source_version_id" uuid,
	"status" text DEFAULT 'queued' NOT NULL,
	"storage_key" text NOT NULL,
	"file_sha256" text NOT NULL,
	"file_size_bytes" integer NOT NULL,
	"original_filename" text NOT NULL,
	"parsed_text" text,
	"parsed_text_sha256" text,
	"parser" text,
	"page_offsets" integer[],
	"text_ranges" jsonb,
	"warnings" text[] DEFAULT '{}'::text[] NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"run_seq" integer DEFAULT 0 NOT NULL,
	"active_run_id" uuid,
	"lease_until" timestamp with time zone,
	"worker_id" text,
	"enqueued_at" timestamp with time zone,
	"last_error_code" text,
	"last_error_message" text,
	"extracted_at" timestamp with time zone,
	"created_request_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_versions_doc_id_id_uq" UNIQUE("document_id","id"),
	CONSTRAINT "document_versions_doc_id_number_uq" UNIQUE("document_id","version_number"),
	CONSTRAINT "document_versions_version_number_chk" CHECK (version_number >= 1),
	CONSTRAINT "document_versions_origin_chk" CHECK (origin IN ('upload', 'reextract')),
	CONSTRAINT "document_versions_source_version_chk" CHECK ((origin = 'reextract') = (source_version_id IS NOT NULL)),
	CONSTRAINT "document_versions_status_chk" CHECK (status IN ('queued', 'extracting', 'extracted', 'failed')),
	CONSTRAINT "document_versions_file_sha_chk" CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "document_versions_file_size_chk" CHECK (file_size_bytes BETWEEN 1 AND 10485760),
	CONSTRAINT "document_versions_original_filename_chk" CHECK (octet_length(original_filename) BETWEEN 1 AND 255),
	CONSTRAINT "document_versions_parsed_text_pair_chk" CHECK ((parsed_text IS NULL) = (parsed_text_sha256 IS NULL)),
	CONSTRAINT "document_versions_parsed_text_sha_chk" CHECK (parsed_text_sha256 IS NULL OR parsed_text_sha256 ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "document_versions_text_ranges_chk" CHECK (text_ranges IS NULL OR jsonb_typeof(text_ranges) = 'object'),
	CONSTRAINT "document_versions_warnings_chk" CHECK (warnings <@ ARRAY['SUSPICIOUS_INSTRUCTIONS', 'MULTI_COLUMN', 'ROTATED_TEXT', 'HIDDEN_TEXT_PRESENT', 'CHUNKED']::text[]),
	CONSTRAINT "document_versions_attempts_chk" CHECK (attempts >= 0),
	CONSTRAINT "document_versions_run_seq_chk" CHECK (run_seq >= 0),
	CONSTRAINT "document_versions_extracting_lease_chk" CHECK ((status = 'extracting') = (active_run_id IS NOT NULL AND lease_until IS NOT NULL AND worker_id IS NOT NULL)),
	CONSTRAINT "document_versions_failed_error_chk" CHECK ((status = 'failed') = (last_error_code IS NOT NULL)),
	CONSTRAINT "document_versions_last_error_code_chk" CHECK (last_error_code IS NULL OR last_error_code IN ('PARSE_ENCRYPTED', 'PARSE_MALFORMED', 'PARSE_TIMEOUT', 'PARSE_LIMIT_EXCEEDED', 'PARSE_NO_TEXT', 'PARSE_CRASHED', 'STORAGE_UNAVAILABLE', 'INTEGRITY_MISMATCH', 'LLM_NOT_CONFIGURED', 'LLM_AUTH', 'LLM_BAD_REQUEST', 'LLM_SCHEMA_INVALID', 'LLM_TRUNCATED', 'LLM_REFUSED', 'LLM_RATE_CAPPED', 'LLM_CALL_CAP', 'MAX_ATTEMPTS', 'DOCUMENT_DELETED')),
	CONSTRAINT "document_versions_extracted_at_chk" CHECK ((status = 'extracted') = (extracted_at IS NOT NULL)),
	CONSTRAINT "document_versions_extracted_text_chk" CHECK (status <> 'extracted' OR parsed_text IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"external_id" text,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"latest_version_number" integer DEFAULT 0 NOT NULL,
	"reviewable_version_id" uuid,
	"pending_count" integer DEFAULT 0 NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_reason" text,
	"deleted_request_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "documents_external_id_uq" UNIQUE("external_id"),
	CONSTRAINT "documents_title_len_chk" CHECK (char_length(title) BETWEEN 1 AND 200),
	CONSTRAINT "documents_latest_version_number_chk" CHECK (latest_version_number >= 0),
	CONSTRAINT "documents_pending_count_chk" CHECK (pending_count >= 0),
	CONSTRAINT "documents_deleted_reason_chk" CHECK (deleted_reason IS NULL OR (deleted_at IS NOT NULL AND char_length(deleted_reason) <= 500)),
	CONSTRAINT "documents_deleted_request_id_chk" CHECK (deleted_request_id IS NULL OR deleted_at IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "extraction_runs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"version_id" uuid NOT NULL,
	"run_number" integer NOT NULL,
	"status" text NOT NULL,
	"trigger" text NOT NULL,
	"correlation_id" text,
	"worker_id" text NOT NULL,
	"chunked" boolean DEFAULT false NOT NULL,
	"llm_call_count" integer DEFAULT 0 NOT NULL,
	"reused_call_count" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"error_code" text,
	"error_message" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "extraction_runs_id_version_id_uq" UNIQUE("id","version_id"),
	CONSTRAINT "extraction_runs_version_run_number_uq" UNIQUE("version_id","run_number"),
	CONSTRAINT "extraction_runs_run_number_chk" CHECK (run_number >= 1),
	CONSTRAINT "extraction_runs_status_chk" CHECK (status IN ('running', 'succeeded', 'failed', 'abandoned')),
	CONSTRAINT "extraction_runs_running_finished_chk" CHECK ((status = 'running') = (finished_at IS NULL)),
	CONSTRAINT "extraction_runs_trigger_chk" CHECK (trigger IN ('upload', 'sweep', 'retry', 'redelivery', 'reextract', 'restore')),
	CONSTRAINT "extraction_runs_llm_call_count_chk" CHECK (llm_call_count >= 0),
	CONSTRAINT "extraction_runs_reused_call_count_chk" CHECK (reused_call_count >= 0),
	CONSTRAINT "extraction_runs_cost_usd_chk" CHECK (cost_usd >= 0)
);
--> statement-breakpoint
CREATE TABLE "llm_calls" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"run_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"kind" text NOT NULL,
	"chunk_index" integer,
	"request_sha256" text NOT NULL,
	"reused_from_call_id" uuid,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"served_model" text,
	"prompt_version" text NOT NULL,
	"request" jsonb NOT NULL,
	"provider_request_id" text,
	"raw_response" jsonb,
	"stop_reason" text,
	"schema_valid" boolean,
	"input_tokens" integer,
	"output_tokens" integer,
	"usage" jsonb,
	"cost_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"latency_ms" integer,
	"error_code" text,
	"error_message" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "llm_calls_run_seq_uq" UNIQUE("run_id","seq"),
	CONSTRAINT "llm_calls_seq_chk" CHECK (seq >= 1),
	CONSTRAINT "llm_calls_kind_chk" CHECK (kind IN ('extract', 'repair', 'chunk')),
	CONSTRAINT "llm_calls_chunk_index_chk" CHECK ((kind = 'chunk') = (chunk_index IS NOT NULL) AND (chunk_index IS NULL OR chunk_index >= 0)),
	CONSTRAINT "llm_calls_request_sha_chk" CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "llm_calls_cost_usd_chk" CHECK (cost_usd >= 0)
);
--> statement-breakpoint
CREATE TABLE "document_types" (
	"key" text PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_types_key_chk" CHECK (key ~ '^[a-z][a-z0-9_]{1,40}$'),
	CONSTRAINT "document_types_display_name_chk" CHECK (char_length(btrim(display_name)) >= 1)
);
--> statement-breakpoint
CREATE TABLE "extraction_templates" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"document_type" text NOT NULL,
	"version" integer NOT NULL,
	"content_sha256" text NOT NULL,
	"instructions" text,
	"default_currency" text DEFAULT 'USD' NOT NULL,
	"date_order" text DEFAULT 'MDY' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "extraction_templates_doc_type_version_uq" UNIQUE("document_type","version"),
	CONSTRAINT "extraction_templates_doc_type_sha_uq" UNIQUE("document_type","content_sha256"),
	CONSTRAINT "extraction_templates_version_chk" CHECK (version >= 1),
	CONSTRAINT "extraction_templates_sha_chk" CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "extraction_templates_default_currency_chk" CHECK (default_currency ~ '^[A-Z]{3}$'),
	CONSTRAINT "extraction_templates_date_order_chk" CHECK (date_order IN ('MDY', 'DMY', 'YMD'))
);
--> statement-breakpoint
CREATE TABLE "template_fields" (
	"template_id" uuid NOT NULL,
	"field_key" text NOT NULL,
	"field_type" text NOT NULL,
	"position" integer NOT NULL,
	"label" text NOT NULL,
	"description" text,
	CONSTRAINT "template_fields_pk" PRIMARY KEY("template_id","field_key"),
	CONSTRAINT "template_fields_template_position_uq" UNIQUE("template_id","position"),
	CONSTRAINT "template_fields_field_key_chk" CHECK (field_key ~ '^[a-z][a-z0-9_]{0,62}$'),
	CONSTRAINT "template_fields_field_type_chk" CHECK (field_type IN ('string', 'date', 'money', 'number', 'percent')),
	CONSTRAINT "template_fields_position_chk" CHECK (position BETWEEN 1 AND 100),
	CONSTRAINT "template_fields_label_chk" CHECK (char_length(btrim(label)) >= 1)
);
--> statement-breakpoint
CREATE TABLE "extracted_values" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"version_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"field_key" text NOT NULL,
	"field_type" text NOT NULL,
	"kind" text NOT NULL,
	"value" jsonb,
	"raw_value" text,
	"evidence" text,
	"attempted_quote" text,
	"canonical_evidence" text,
	"evidence_start" integer,
	"evidence_end" integer,
	"evidence_match_count" integer,
	"cited_line" integer,
	"match_mode" text,
	"chunk_index" integer,
	"gap_code" text,
	"gap_reason" text,
	"flags" text[] DEFAULT '{}'::text[] NOT NULL,
	"baseline_value_id" uuid,
	"change_kind" text NOT NULL,
	"change_reason" text,
	"current_review_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "extracted_values_id_field_type_uq" UNIQUE("id","field_type"),
	CONSTRAINT "extracted_values_version_field_key_uq" UNIQUE("version_id","field_key"),
	CONSTRAINT "extracted_values_field_key_chk" CHECK (field_key ~ '^[a-z][a-z0-9_]{0,62}$'),
	CONSTRAINT "extracted_values_field_type_chk" CHECK (field_type IN ('string', 'date', 'money', 'number', 'percent')),
	CONSTRAINT "extracted_values_kind_chk" CHECK (kind IN ('value', 'gap')),
	CONSTRAINT "extracted_values_attempted_quote_chk" CHECK (kind = 'gap' OR attempted_quote IS NULL),
	CONSTRAINT "extracted_values_match_mode_chk" CHECK (match_mode IS NULL OR match_mode IN ('strict', 'quote_folded')),
	CONSTRAINT "extracted_values_gap_code_chk" CHECK (gap_code IS NULL OR gap_code IN ('NOT_FOUND', 'MODEL_OMITTED', 'EVIDENCE_NOT_IN_TEXT', 'VALUE_NOT_SUPPORTED', 'UNPARSEABLE_VALUE', 'EVIDENCE_HIDDEN', 'CONFLICTING_EVIDENCE')),
	CONSTRAINT "extracted_values_flags_chk" CHECK (flags <@ ARRAY['LOW_VISIBILITY', 'AMBIGUOUS_OCCURRENCE', 'TOKEN_AMBIGUOUS', 'AMBIGUOUS_DATE', 'QUOTE_FOLDED', 'WEAK_EVIDENCE_LINE', 'CONFLICTING_LINES', 'LINE_HINT_MISMATCH']::text[]),
	CONSTRAINT "extracted_values_change_kind_chk" CHECK (change_kind IN ('new', 'same', 'changed')),
	CONSTRAINT "extracted_values_baseline_chk" CHECK ((change_kind = 'new') = (baseline_value_id IS NULL)),
	CONSTRAINT "extracted_values_change_reason_chk" CHECK ((change_kind = 'changed') = (change_reason IS NOT NULL) AND (change_reason IS NULL OR change_reason IN ('VALUE_CHANGED', 'EVIDENCE_CHANGED', 'GAP_INVOLVED', 'WEAK_EVIDENCE_LINE', 'PARSER_CHANGED', 'POSSIBLE_AMENDMENT', 'CONFLICTING_EVIDENCE', 'EVIDENCE_HIDDEN', 'TYPE_CHANGED'))),
	CONSTRAINT "extracted_values_gap_and_value_shape_chk" CHECK ((
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
          AND (
    (field_type = 'string'
      AND jsonb_typeof(value) = 'string'
      AND char_length(value #>> '{}') BETWEEN 1 AND 2000
      AND char_length(btrim(value #>> '{}')) >= 1)
    OR (field_type = 'date'
      AND jsonb_typeof(value) = 'string'
      AND (value #>> '{}') ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$')
    OR (field_type = 'money'
      AND jsonb_typeof(value) = 'object'
      AND jsonb_typeof(value -> 'amount') = 'string'
      AND jsonb_typeof(value -> 'currency') = 'string'
      AND (value - 'amount' - 'currency') = '{}'::jsonb
      AND (value ->> 'amount') ~ '^-?(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$'
      AND (value ->> 'currency') ~ '^[A-Z]{3}$')
    OR (field_type IN ('number', 'percent')
      AND jsonb_typeof(value) = 'string'
      AND (value #>> '{}') ~ '^-?(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$')
  ))
      ))
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"value_id" uuid NOT NULL,
	"field_type" text NOT NULL,
	"decision" text NOT NULL,
	"corrected_value" jsonb,
	"note" text,
	"origin" text NOT NULL,
	"carried_from_review_id" uuid,
	"request_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reviews_value_id_id_uq" UNIQUE("value_id","id"),
	CONSTRAINT "reviews_field_type_chk" CHECK (field_type IN ('string', 'date', 'money', 'number', 'percent')),
	CONSTRAINT "reviews_decision_chk" CHECK (decision IN ('approve', 'correct', 'revert')),
	CONSTRAINT "reviews_corrected_value_chk" CHECK ((decision = 'correct') = (corrected_value IS NOT NULL) AND (corrected_value IS NULL OR (
    (field_type = 'string'
      AND jsonb_typeof(corrected_value) = 'string'
      AND char_length(corrected_value #>> '{}') BETWEEN 1 AND 2000
      AND char_length(btrim(corrected_value #>> '{}')) >= 1)
    OR (field_type = 'date'
      AND jsonb_typeof(corrected_value) = 'string'
      AND (corrected_value #>> '{}') ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$')
    OR (field_type = 'money'
      AND jsonb_typeof(corrected_value) = 'object'
      AND jsonb_typeof(corrected_value -> 'amount') = 'string'
      AND jsonb_typeof(corrected_value -> 'currency') = 'string'
      AND (corrected_value - 'amount' - 'currency') = '{}'::jsonb
      AND (corrected_value ->> 'amount') ~ '^-?(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$'
      AND (corrected_value ->> 'currency') ~ '^[A-Z]{3}$')
    OR (field_type IN ('number', 'percent')
      AND jsonb_typeof(corrected_value) = 'string'
      AND (corrected_value #>> '{}') ~ '^-?(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$')
  ))),
	CONSTRAINT "reviews_note_len_chk" CHECK (note IS NULL OR char_length(note) <= 1000),
	CONSTRAINT "reviews_origin_chk" CHECK (origin IN ('human', 'carried')),
	CONSTRAINT "reviews_carried_from_chk" CHECK ((origin = 'carried') = (carried_from_review_id IS NOT NULL)),
	CONSTRAINT "reviews_carried_not_revert_chk" CHECK (origin <> 'carried' OR decision <> 'revert')
);
--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_template_id_extraction_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."extraction_templates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_source_version_fk" FOREIGN KEY ("source_version_id") REFERENCES "public"."document_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_active_run_fk" FOREIGN KEY ("active_run_id") REFERENCES "public"."extraction_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_type_document_types_key_fk" FOREIGN KEY ("type") REFERENCES "public"."document_types"("key") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_reviewable_version_fk" FOREIGN KEY ("id","reviewable_version_id") REFERENCES "public"."document_versions"("document_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extraction_runs" ADD CONSTRAINT "extraction_runs_version_id_document_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."document_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_calls" ADD CONSTRAINT "llm_calls_run_version_fk" FOREIGN KEY ("run_id","version_id") REFERENCES "public"."extraction_runs"("id","version_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_calls" ADD CONSTRAINT "llm_calls_reused_from_fk" FOREIGN KEY ("reused_from_call_id") REFERENCES "public"."llm_calls"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extraction_templates" ADD CONSTRAINT "extraction_templates_document_type_document_types_key_fk" FOREIGN KEY ("document_type") REFERENCES "public"."document_types"("key") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_fields" ADD CONSTRAINT "template_fields_template_id_extraction_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."extraction_templates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extracted_values" ADD CONSTRAINT "extracted_values_version_id_document_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."document_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extracted_values" ADD CONSTRAINT "extracted_values_run_id_extraction_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."extraction_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extracted_values" ADD CONSTRAINT "extracted_values_baseline_value_fk" FOREIGN KEY ("baseline_value_id") REFERENCES "public"."extracted_values"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extracted_values" ADD CONSTRAINT "extracted_values_current_review_fk" FOREIGN KEY ("id","current_review_id") REFERENCES "public"."reviews"("value_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_value_field_type_fk" FOREIGN KEY ("value_id","field_type") REFERENCES "public"."extracted_values"("id","field_type") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_carried_from_fk" FOREIGN KEY ("carried_from_review_id") REFERENCES "public"."reviews"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_versions_inflight_idx" ON "document_versions" USING btree ("status","lease_until") WHERE status IN ('queued', 'extracting');--> statement-breakpoint
CREATE INDEX "document_versions_template_id_idx" ON "document_versions" USING btree ("template_id");--> statement-breakpoint
CREATE INDEX "documents_alive_id_idx" ON "documents" USING btree ("id") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "documents_alive_type_id_idx" ON "documents" USING btree ("type","id") WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX "documents_alive_pending_id_idx" ON "documents" USING btree ("id") WHERE deleted_at IS NULL AND pending_count > 0;--> statement-breakpoint
CREATE INDEX "documents_alive_type_pending_id_idx" ON "documents" USING btree ("type","id") WHERE deleted_at IS NULL AND pending_count > 0;--> statement-breakpoint
CREATE INDEX "documents_deleted_at_id_idx" ON "documents" USING btree ("deleted_at","id") WHERE deleted_at IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "extraction_runs_one_running_per_version_idx" ON "extraction_runs" USING btree ("version_id") WHERE status = 'running';--> statement-breakpoint
CREATE INDEX "llm_calls_reuse_lookup_idx" ON "llm_calls" USING btree ("version_id","request_sha256") WHERE schema_valid = true;--> statement-breakpoint
CREATE INDEX "llm_calls_billed_count_idx" ON "llm_calls" USING btree ("version_id") WHERE reused_from_call_id IS NULL;--> statement-breakpoint
CREATE INDEX "extracted_values_run_id_idx" ON "extracted_values" USING btree ("run_id");