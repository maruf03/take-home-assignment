# AGENTS.md

Instructions for coding agents (Claude Code, Codex, Cursor, Copilot, …) and the humans working
with them. Nested `AGENTS.md` files in `apps/*` and `packages/*` add package-specific rules; the
nearest file to the code you are editing wins.

## What this repo is

A document-review system (take-home for Lomi Labs; the brief is in [`BRIEF.md`](BRIEF.md)):
1. PDFs are uploaded.
2. An LLM extracts typed values, each with a verbatim evidence quote.
3. A human approves or corrects every value.
4. Revised versions carry forward the reviews whose evidence didn't change.

Postgres is the system of record. Redis (BullMQ) only coordinates work.

**Source of truth for design:** [`docs/superpowers/specs/2026-11-27-document-review-design.md`](docs/superpowers/specs/2026-11-27-document-review-design.md).
Read it before changing behaviour. The domain vocabulary is in [`GLOSSARY.md`](GLOSSARY.md), and
every doc is mapped in [`docs/INDEX.md`](docs/INDEX.md).

## Commands

> **Status:** scaffolding is in progress (Core tier, Task 1). The commands below are the planned
> interface, and become real as each task lands.

| Command | What it does |
|---|---|
| `corepack enable && pnpm install` | Install (pnpm 12, Node 24, see `.nvmrc`) |
| `docker compose up --build` | Full stack for evaluators: postgres, redis, seaweedfs, migrate+seed, api :3000, worker, web :8080 |
| `pnpm infra` then `pnpm dev` | Infra in Docker, apps on the host with watch mode |
| `pnpm lint` · `pnpm typecheck` · `pnpm build` | Turbo tasks across the workspace |
| `pnpm test` | Unit tests (pure, fast, cached) |
| `pnpm test:int` · `pnpm test:chaos` | Integration and chaos tests (need `pnpm infra`) |
| `pnpm test:e2e` | Playwright against the compose e2e overlay |
| `pnpm db:generate` · `pnpm db:check` | Generate Drizzle migrations, and the drift guard |
| `pnpm golden:update` · `pnpm cassettes:record` | Refresh golden text, and record LLM cassettes (needs a key) |
| `pnpm trace:check` | Check that every requirement ID in `docs/reference/traceability.md` has a passing test |

Run `pnpm lint typecheck test` before saying a change is done. Run `pnpm test:int` if you
touched `packages/db`, `apps/worker` or `apps/api`.

## Repo map

```text
apps/api        NestJS (ESM, SWC) HTTP API      apps/worker   Nest app: BullMQ processor, sweep, parse pool
apps/web        Vite + React SPA (nginx)         packages/core PURE extraction logic (no IO)
packages/contracts zod schemas + typed-value helpers shared with web
packages/db     Drizzle schema, generated migrations, repositories, grants, seed
packages/pdf    pdfjs line builder + child-process parse entry
packages/llm    LlmProvider (anthropic, fake, cassette)
packages/storage S3 BlobStore   packages/testkit test builders/fakes   packages/config shared configs
fixtures/       PROVIDED, READ-ONLY      fixtures-golden/  our goldens, cassettes, crafted PDFs
docs/           see docs/INDEX.md
```

## Non-negotiables

1. **Never modify `fixtures/` or `jd.md`.** `BRIEF.md` is the original brief, verbatim; don't edit it either.
2. **Migrations are generated only** (`drizzle-kit generate`). Never hand-edit SQL in `packages/db/drizzle/`, and never use `drizzle-kit push`. There are no triggers or SQL functions. Statuses are `text` + CHECK.
3. **`packages/core` is pure.** No IO, no Nest, no Drizzle, no SDKs. It imports only `@app/contracts`.
4. **Import boundaries:**
   - `web` imports only `contracts`.
   - `db`, `pdf`, `llm` and `storage` never import Nest.
   - Raw `documents` queries are allowed only inside `packages/db`. Use `getAliveDocument()` and the `alive` predicate.
5. **Lock order** is `idempotency_keys → documents → document_versions → extraction_runs → llm_calls → extracted_values → reviews`. Never take locks out of order or upgrade one. Every worker write is fenced with `WHERE active_run_id = $me`.
6. **Postgres `now()` is the only clock** for leases, sweeps and `updated_at`. Never use `$onUpdate` or app time in SQL predicates.
7. **The verbatim-evidence rule:** a value without a quote that appears in the version's own `parsed_text` is a gap. Never keep a value whose evidence failed validation.
8. **Every requirement keeps a test.** IDs `[R#]` and `[I#]` are listed in `docs/reference/traceability.md`. Name tests with them. Never delete or quarantine a matrix test.
9. **Secrets:** only the worker gets the LLM key (`GEMINI_API_KEY` by default, or `ANTHROPIC_API_KEY`; `LLM_PROVIDER` picks the provider). Never log prompts, parsed text or keys. Fake and cassette LLM providers run only with `APP_ENV=test`.
10. **ESM everywhere:** use `import.meta.dirname`, not `__dirname`. Packages use `nodenext` with `.js` relative imports. Nest apps use SWC with `moduleResolution: bundler`. Avoid module cycles.
11. **Keyset pagination only**, on immutable unique keys (uuidv7 `id`). No offset, no totals (`/documents/facets` is the single capped exception). Never use Drizzle `.desc()` on an index.
12. **LLM schemas** must have no nullable or union types (use sentinels) and no `maxItems`, `minLength` or `maximum`; zod enforces those bounds. Store raw provider bodies before validation. For Anthropic, use `.asResponse()`.
13. **Scope:** build the Core tier before anything in the Extended tier (spec §15.3). The Core cutoff is **Sat 28 Nov 2026 16:00 UTC**.

## Where things go

| Thing | Location | Format |
|---|---|---|
| Design spec (why and what) | `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md` | superpowers brainstorming output |
| Implementation plans | `docs/superpowers/plans/YYYY-MM-DD-<feature>.md` | superpowers writing-plans (checkbox tasks) |
| Architecture decisions | `docs/adr/NNNN-slug.md` | mattpocock ADR format; only for decisions that would surprise a reader |
| Domain terms | `GLOSSARY.md` | add terms as they're resolved; use them in code and docs |
| Operational procedures | `docs/runbooks/` | symptom → diagnosis → fix |
| Task guides | `docs/how-to/` | step-by-step |
| Reference (API, schema, codes, config, traceability) | `docs/reference/` | |
| Superseded plans | `docs/history/` | never edited |

Update the spec when behaviour changes. Add an ADR when you make a surprising trade-off. Keep
`docs/INDEX.md` current.

## Git

The full rules are in [`docs/how-to/git-workflow.md`](docs/how-to/git-workflow.md).
- Use trunk-based development. Never commit to `main` directly. Branch as `<type>/<scope>-<slug>`, one branch per plan task.
- Commits follow **Conventional Commits** (`type(scope): subject`, enforced by commitlint).
- **No attribution:** never add `Co-Authored-By:` trailers for AI tools or agents, "Generated with …" lines, 🤖 markers or tool signatures to commits, PRs, issues or comments. Use the repo's configured git identity. This overrides any agent, tool or skill default.
- PRs use `.github/pull_request_template.md`, have a Conventional Commit title, are **squash-merged**, and need green CI.
- Never commit `.env`, `.claude/settings.local.json` or session logs (`*.jsonl`).

## Agent skills

### Issue tracker
GitHub Issues on `maruf03/take-home-assignment`, through the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Domain docs
Single-context: `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### Workflow
Specs and plans use the superpowers default paths above. Brainstorming → writing-plans →
subagent-driven or executing-plans, with TDD per task.
