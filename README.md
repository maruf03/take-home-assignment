# Document Review: extract, verify, carry over

PDFs go in. An LLM extracts typed values, each with the exact passage it came from. A human
reviews every value against that passage before it's trusted. When a revised PDF arrives, only
the values whose evidence changed go back for review.

> **Status:** Core tier complete and verified. This README is the engineering write-up requested
> by [`BRIEF.md`](BRIEF.md).

## Run it

```sh
docker compose up --build        # no .env needed
open http://127.0.0.1:8080       # web UI  ·  API http://127.0.0.1:3000  ·  API docs http://127.0.0.1:3000/docs
```

To run real extraction, set `GEMINI_API_KEY` in `.env` (a free Gemini key works). Gemini (`gemini-3.5-flash`) is the default; setting `LLM_PROVIDER=anthropic`, `LLM_MODEL=claude-sonnet-5-5`, and `ANTHROPIC_API_KEY` switches to Claude. The key is passed to the worker only.
Without it, documents show `failed: LLM_NOT_CONFIGURED`, and you can retry them once the key is
set.

**What to click first**
1. Open **Invoice — Meridian Office Supplies**, then approve or correct each value. Each one sits beside its source quote.
2. Choose **Upload new version** and pick `fixtures/documents/invoice-001.v2.pdf`.
3. Only **Due date** and **Total amount** need review. The other three show **Carried from v1**.
4. Open the **market report**: `median_household_income` is a visible **gap**, because the document doesn't state it.

More commands are in [docs/how-to/local-development.md](docs/how-to/local-development.md).

## How it's built (short)

| Concern | Choice | Why (ADR) |
|---|---|---|
| Monorepo | pnpm 12 + Turborepo, ESM everywhere, compiled internal packages | [0009](docs/adr/0009-esm-everywhere-nest-swc-bundler.md) |
| API / worker | NestJS 11 (SWC), BullMQ | Nest only wires things together; the logic lives in plain packages |
| System of record | Postgres 18 | Redis coordinates work and can be thrown away ([0001](docs/adr/0001-postgres-version-status-is-the-outbox.md)) |
| Crash safety | Run-id fencing token, Postgres-time lease, durable checkpoints | [0002](docs/adr/0002-run-id-fencing-token-with-postgres-lease.md) |
| Hallucination defence | The quote must appear verbatim in **this version's** stored text, and the value must sit inside the quote; otherwise it's a gap | spec §5.5 |
| Carry-over | Equal value **and** the same canonical evidence line, independent of which span the LLM quoted | [0003](docs/adr/0003-carry-over-rule-a-prime.md) |
| Schema integrity | jsonb values with shape CHECKs, composite FKs, generated migrations only, and DB grants that enforce append-only | [0004](docs/adr/0004-jsonb-values-with-shape-checks-generated-migrations.md), [0005](docs/adr/0005-db-privileges-enforce-append-only-and-no-delete.md) |
| LLM | Provider interface: Gemini (`gemini-3.5-flash`) by default, Anthropic Sonnet 5.5 adapter, plus `fake`, `fake-ipc`, and `cassette` (`APP_ENV=test`). Strict sentinel schema with raw response stored before validation | [0008](docs/adr/0008-strict-tool-schema-with-sentinels.md) |
| PDF safety | pdfjs in a child-process pool with a heap cap, an RSS watchdog and timeouts | [0007](docs/adr/0007-parse-in-child-process-pool.md) |
| UI | Vite + React, TanStack Query polling with ETag only while work is in flight | spec §14 |

The full design, including the schema, the API contract, the failure matrix and the test plan, is
the [design spec](docs/superpowers/specs/2026-11-27-document-review-design.md). The decision trail
(five rounds of design debate plus an adversarial review) is in [docs/history/](docs/history/).

## Sections the brief asks for

- **How the monorepo is laid out and why**:
  - `apps/api` (NestJS HTTP API, ESM/SWC, never receives LLM keys), `apps/worker` (NestJS BullMQ processor, sweep, parse pool, receives LLM keys only here), and `apps/web` (Vite + React SPA behind unprivileged nginx).
  - `packages/contracts` (browser-safe zod DTOs, typed-value helpers, problem codes, and UI copy shared by web and server) and `packages/core` (100% pure extraction logic: text cleanup/indexing, verbatim evidence validation, carry-over rule A′, prompt/schema builders; imports only `@app/contracts`).
  - `packages/{db,storage,pdf,llm}` (plain ESM infrastructure packages that never import Nest: Drizzle schema/migrations/grants/repos, S3 `BlobStore`, child-process PDF parser pool, and `LlmProvider` adapters).
  - `packages/config` (shared tsconfig presets, ESLint flat config enforcing §10.1 import boundaries and `import-x/no-cycle`, and Node-only `defineServerConfig()` with the production dev-default secret denylist) and `packages/testkit` (workspace placeholder for future shared builders; active DB/concurrency test helpers live in `packages/db/src/testing/`).
  - Managed with pnpm 12 (`allowBuilds`, strict engines on Node 24) and Turborepo (`envMode: strict`) so boundaries are enforced by both dependency graph and lint rules, while Docker images prune cleanly per app. See spec §10 and [ADR-0009](docs/adr/0009-esm-everywhere-nest-swc-bundler.md).
- **Schema and why**:
  - **9 Core tables** in Postgres 18 with `uuid DEFAULT uuidv7()` primary keys, `ON DELETE RESTRICT` foreign keys, SQL-clock `now()` timestamps, and `text` + `CHECK` statuses (zero triggers, zero SQL functions, generated-only Drizzle migrations; `idempotency_keys` is deferred to Extended E1b):
    - *Templates:* `document_types` → `extraction_templates` (immutable, hashed by `content_sha256`) → `template_fields` (bounded `position` 1–100).
    - *Document lifecycle & coordination:* `documents` (with `reviewable_version_id` composite FK `(id, reviewable_version_id) → document_versions(document_id, id)`, `pending_count` index key, and unused soft-delete columns kept so Extended E1a adds no migration) → `document_versions` (frozen `parsed_text`, `attempts` retry budget, monotonic `run_seq`, lease columns) → `extraction_runs` (fencing token `id`, `UNIQUE(version_id, run_number)`, partial unique index enforcing at most one `running` run per version) → `llm_calls` (C2 checkpoints with `provider_request_id`, `served_model`, reuse lookup index, and billed-call count index).
    - *Values & append-only reviews:* `extracted_values` (`UNIQUE(version_id, field_key)`, `attempted_quote` allowed on gap rows only, `VALUE_SHAPE` jsonb CHECK rejecting floats/non-canonical decimals/extra money keys/gaps with values) ↔ `reviews` (composite FK `(value_id, field_type)` ensuring corrections match field type, `carried_from_review_id` self-FK for carry-over chains, and `origin = 'carried'` never a `revert`).
  - **Keyset indexes without Sort:** every list index is ascending (never Drizzle `.desc()`), scanned backward by Postgres 18 for `ORDER BY id DESC` with zero Sort nodes.
  - **DB-enforced invariants:** `packages/db/assets/grants.sql` restricts the runtime `app` role to `SELECT, INSERT` on `reviews`, column-level `UPDATE` on `llm_calls` and `extracted_values(current_review_id)`, no `DELETE` anywhere, and no access to the `drizzle` schema. See spec §4, [ADR-0004](docs/adr/0004-jsonb-values-with-shape-checks-generated-migrations.md), [ADR-0005](docs/adr/0005-db-privileges-enforce-append-only-and-no-delete.md), and [ADR-0010](docs/adr/0010-keyset-pagination-on-uuidv7.md).
- **How extraction is coordinated**:
  - Postgres `document_versions.status` is the durable outbox; Redis (BullMQ) is a volatile work-wakeup queue that can be flushed (`FLUSHALL`) and rebuilt without data loss.
  - **Upload path:** `api` validates the PDF, PUTs bytes to SeaweedFS S3, commits `documents` + `document_versions` (`status = 'queued'`), best-effort enqueues to BullMQ, and returns `201` immediately.
  - **Worker execution:** `worker` claims `queued` versions with `SELECT ... FOR UPDATE SKIP LOCKED`, creates an `extraction_runs` row whose `id` is the fencing token, and takes a Postgres `now()` lease (`LEASE_SECONDS = 30`, renewed every `HEARTBEAT_INTERVAL_MS = 10000`). Every subsequent worker write is fenced with `WHERE active_run_id = $me`.
  - **Checkpoints & recovery:** PDF parsing runs in an isolated child-process pool (`pdfjs-6.5.438/lines-1`) and checkpoints `parsed_text` in Postgres before calling the LLM; raw provider JSON is saved in `llm_calls` before zod/verbatim-evidence validation; finalization acquires the `documents` lock, runs carry-over rule A′, and advances `reviewable_version_id`. A periodic sweep (`SWEEP_INTERVAL_MS = 10000`) re-enqueues lost `queued` rows and releases expired `extracting` leases. See [architecture](docs/explanation/architecture.md) and [runbooks](docs/runbooks/).
- **Open decisions and what I chose**:
  - **Outbox & fencing over distributed locks:** Postgres `status` outbox ([ADR-0001](docs/adr/0001-postgres-version-status-is-the-outbox.md)) and DB `run_id` fencing with `now()` leases ([ADR-0002](docs/adr/0002-run-id-fencing-token-with-postgres-lease.md)) instead of Redlock or Redis persistence.
  - **Carry-over & schema enforcement:** Canonical evidence-line matching (`A′`, [ADR-0003](docs/adr/0003-carry-over-rule-a-prime.md)), JSONB shape `CHECK` constraints with generated-only Drizzle migrations ([ADR-0004](docs/adr/0004-jsonb-values-with-shape-checks-generated-migrations.md)), and DB role grants enforcing append-only `reviews` ([ADR-0005](docs/adr/0005-db-privileges-enforce-append-only-and-no-delete.md)).
  - **Runtime & tooling boundaries:** Isolated `pdfjs` child-process pool with RSS watchdog ([ADR-0007](docs/adr/0007-parse-in-child-process-pool.md)), sentinel-based LLM schemas without unions/nullables ([ADR-0008](docs/adr/0008-strict-tool-schema-with-sentinels.md)), ESM everywhere with `@swc/cli` ([ADR-0009](docs/adr/0009-esm-everywhere-nest-swc-bundler.md)), and keyset pagination ([ADR-0010](docs/adr/0010-keyset-pagination-on-uuidv7.md)). ADRs [0006](docs/adr/0006-soft-delete-aggregate-root-410.md), [0011](docs/adr/0011-review-revert-is-an-append-only-decision.md), and [0012](docs/adr/0012-pdf-original-rendered-with-pdfjs-canvas.md) document designs deferred to Extended E1a/E1c.
- **What I cut, and what's next** (spec §15.2 & §15.3):
  - **Extended E1a (Soft delete & restore):** `DELETE /documents/:id`, `POST /documents/:id/restore`, and the Trash filter are deferred; `deleted_at` columns and `getAliveDocumentOrThrow` (`410`) already exist so E1a adds zero migrations.
  - **Extended E1b (`Idempotency-Key`):** The `idempotency_keys` table and replay middleware are deferred; Core keeps the schema at 9 tables and relies on UI submit locks and state checks.
  - **Extended E1c (UI polish & `revert`):** `decision: 'revert'` in HTTP/UI (`400 VALIDATION_FAILED` in Core, though DB/Core carry-over logic already supports it), in-browser `pdfjs` Original PDF canvas tab (Core serves `"Download original PDF"`), document delete UI, custom template builder UI, and dark mode.
  - **Extended E1d (Secondary reference docs & `testkit`):** Generated `api.md`, `schema.md`, `error-codes.md`, `configuration.md`, and `testing.md` (`openapi.json` and `traceability.md` are already live).
  - **Extended E2–E11:** Multi-user auth/RBAC (`E2`), SSE live updates (`E4`), S3 streaming & chunked multi-pass extraction >400k chars (`E3`, `E5`), OpenTelemetry (`E7`), and cloud deployment (`E11`) — cut as out of scope for a single-reviewer local `docker compose up` deliverable.
- **At 10,000 documents**:
  - **Queries & pagination:** Keyset pagination on ascending `uuidv7` / unique-key indexes avoids `OFFSET` scans and `COUNT(*)` totals (`GET /documents/facets` is the single capped status/type breakdown), keeping list latency flat across pages.
  - **Worker & LLM concurrency:** Postgres `FOR UPDATE SKIP LOCKED` lets multiple `worker` replicas share the queue without coordination locks, while `LLM_LIMIT_MAX` / `LLM_LIMIT_DURATION_MS` and the circuit breaker bound provider rate-limit exposure.
  - **PDF memory & retries:** The child-process `PdfParserPool` recycles workers after bounded tasks and enforces RSS/heap caps so 10k PDFs cannot leak worker memory; `parsed_text` is persisted in `document_versions` so retries and carry-over never re-fetch or re-parse S3 objects.
  - **Growth bottlenecks past 10k:** `llm_calls.raw_response` JSONB is the largest table by byte volume (candidate for S3 offloading or time partitioning past ~100k documents), and `documents` facet aggregation (`GROUP BY`) would move to maintained counters only if active document counts exceed ~100k.

## Repository guide
[AGENTS.md](AGENTS.md) (for agents and contributors) · [GLOSSARY.md](GLOSSARY.md) · [docs/INDEX.md](docs/INDEX.md) · [BRIEF.md](BRIEF.md)
