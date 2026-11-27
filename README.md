# Document Review: extract, verify, carry over

PDFs go in. An LLM extracts typed values, each with the exact passage it came from. A human
reviews every value against that passage before it's trusted. When a revised PDF arrives, only
the values whose evidence changed go back for review.

> **Status (2026-11-27):** design complete and adversarially reviewed. Implementation of the
> **Core tier** is in progress. This README is the engineering write-up the brief asks for, and it
> is completed as each Core task lands. The brief itself is in [`BRIEF.md`](BRIEF.md).

## Run it

```sh
docker compose up --build        # no .env needed
open http://127.0.0.1:8080       # web UI   ·  API http://127.0.0.1:3000  ·  API docs /docs
```

To run real extraction, set `GEMINI_API_KEY` in `.env` (a free Gemini key works). Gemini is the default; `LLM_PROVIDER=anthropic` with `ANTHROPIC_API_KEY` switches to Claude. The key is passed to the worker only.
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
| LLM | Provider interface: Gemini by default (free key), Anthropic Sonnet 5.5 adapter. Both use the same sentinel schema, with the raw response stored before validation | [0008](docs/adr/0008-strict-tool-schema-with-sentinels.md) |
| PDF safety | pdfjs in a child-process pool with a heap cap, an RSS watchdog and timeouts | [0007](docs/adr/0007-parse-in-child-process-pool.md) |
| UI | Vite + React, TanStack Query polling with ETag only while work is in flight | spec §14 |

The full design, including the schema, the API contract, the failure matrix and the test plan, is
the [design spec](docs/superpowers/specs/2026-11-27-document-review-design.md). The decision trail
(five rounds of design debate plus an adversarial review) is in [docs/history/](docs/history/).

## Sections the brief asks for

The section titles below are fixed. Their bodies are being filled in as the Core tier lands.

- **How the monorepo is laid out and why**:
  - `apps/api` (NestJS HTTP API, ESM/SWC, never receives LLM keys), `apps/worker` (NestJS BullMQ processor, sweep, parse pool, receives LLM keys only here), and `apps/web` (Vite + React SPA behind unprivileged nginx).
  - `packages/contracts` (browser-safe zod DTOs, typed-value helpers, problem codes, and UI copy shared by web and server) and `packages/core` (100% pure extraction logic: text cleanup/indexing, verbatim evidence validation, carry-over rule A′, prompt/schema builders; imports only `@app/contracts`).
  - `packages/{db,storage,pdf,llm}` (plain ESM infrastructure packages that never import Nest: Drizzle schema/migrations/grants/repos, S3 `BlobStore`, child-process PDF parser pool, and `LlmProvider` adapters).
  - `packages/config` (shared tsconfig presets, ESLint flat config enforcing §10.1 import boundaries and `import-x/no-cycle`, and Node-only `defineServerConfig()` with the production dev-default secret denylist) and `packages/testkit` (dev/test-only builders, forbidden in `apps/*/src/**`).
  - Managed with pnpm 12 (`allowBuilds`, strict engines on Node 24) and Turborepo (`envMode: strict`) so boundaries are enforced by both dependency graph and lint rules, while Docker images prune cleanly per app. See spec §10 and [ADR-0009](docs/adr/0009-esm-everywhere-nest-swc-bundler.md).
- **Schema and why**:
  - **9 Core tables** in Postgres 18 with `uuid DEFAULT uuidv7()` primary keys, `ON DELETE RESTRICT` foreign keys, SQL-clock `now()` timestamps, and `text` + `CHECK` statuses (zero triggers, zero SQL functions, generated-only Drizzle migrations; `idempotency_keys` is deferred to Extended E1b):
    - *Templates:* `document_types` → `extraction_templates` (immutable, hashed by `content_sha256`) → `template_fields` (bounded `position` 1–100).
    - *Document lifecycle & coordination:* `documents` (with `reviewable_version_id` composite FK `(id, reviewable_version_id) → document_versions(document_id, id)`, `pending_count` index key, and unused soft-delete columns kept so Extended E1a adds no migration) → `document_versions` (frozen `parsed_text`, `attempts` retry budget, monotonic `run_seq`, lease columns) → `extraction_runs` (fencing token `id`, `UNIQUE(version_id, run_number)`, partial unique index enforcing at most one `running` run per version) → `llm_calls` (C2 checkpoints with `provider_request_id`, `served_model`, reuse lookup index, and billed-call count index).
    - *Values & append-only reviews:* `extracted_values` (`UNIQUE(version_id, field_key)`, `attempted_quote` allowed on gap rows only, `VALUE_SHAPE` jsonb CHECK rejecting floats/non-canonical decimals/extra money keys/gaps with values) ↔ `reviews` (composite FK `(value_id, field_type)` ensuring corrections match field type, `carried_from_review_id` self-FK for carry-over chains, and `origin = 'carried'` never a `revert`).
  - **Keyset indexes without Sort:** every list index is ascending (never Drizzle `.desc()`), scanned backward by Postgres 18 for `ORDER BY id DESC` with zero Sort nodes.
  - **DB-enforced invariants:** `packages/db/assets/grants.sql` restricts the runtime `app` role to `SELECT, INSERT` on `reviews`, column-level `UPDATE` on `llm_calls` and `extracted_values(current_review_id)`, no `DELETE` anywhere, and no access to the `drizzle` schema. See spec §4, [ADR-0004](docs/adr/0004-jsonb-values-with-shape-checks-generated-migrations.md), [ADR-0005](docs/adr/0005-db-privileges-enforce-append-only-and-no-delete.md), and [ADR-0010](docs/adr/0010-keyset-pagination-on-uuidv7.md).
- **How extraction is coordinated**: the Postgres/Redis/S3 line, plus what happens when each one fails. See [architecture](docs/explanation/architecture.md) and the [runbooks](docs/runbooks/).
- **Open decisions and what I chose**: see the [ADRs](docs/adr/) and spec §1.
- **What I cut, and what's next**: the Extended tier (spec §15.2) is the candidate cut list. Each item that isn't built gets listed here with its reason.
- **At 10,000 documents**: spec §12. The short version comes with the final Core task.

## Repository guide
[AGENTS.md](AGENTS.md) (for agents and contributors) · [GLOSSARY.md](GLOSSARY.md) · [docs/INDEX.md](docs/INDEX.md) · [BRIEF.md](BRIEF.md)
