-- Idempotent least-privilege grants for the `app` role (run as `migrator` after migrations).
-- Core subset: `idempotency_keys` and its grant arrive in Extended E1b (spec §8, §15.3).

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC, app;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, app;
REVOKE ALL ON SCHEMA drizzle FROM PUBLIC, app;
REVOKE ALL ON ALL TABLES IN SCHEMA drizzle FROM PUBLIC, app;

GRANT USAGE ON SCHEMA public TO app;

-- Read-only template metadata (managed by migrator/seed only)
GRANT SELECT ON TABLE
  public.document_types,
  public.extraction_templates,
  public.template_fields
TO app;

-- Mutable coordination/lifecycle tables (no DELETE — soft delete only)
GRANT SELECT, INSERT, UPDATE ON TABLE
  public.documents,
  public.document_versions,
  public.extraction_runs
TO app;

-- Checkpointed LLM calls: INSERT before network call, column-scoped UPDATE for response/usage only
GRANT SELECT, INSERT ON TABLE public.llm_calls TO app;
GRANT UPDATE (
  raw_response,
  provider_request_id,
  served_model,
  stop_reason,
  schema_valid,
  input_tokens,
  output_tokens,
  usage,
  cost_usd,
  latency_ms,
  error_code,
  error_message,
  finished_at
) ON TABLE public.llm_calls TO app;

-- Extracted values: immutable once finalized except pointer to latest review
GRANT SELECT, INSERT ON TABLE public.extracted_values TO app;
GRANT UPDATE (current_review_id) ON TABLE public.extracted_values TO app;

-- Append-only review audit log (no UPDATE, no DELETE)
GRANT SELECT, INSERT ON TABLE public.reviews TO app;
