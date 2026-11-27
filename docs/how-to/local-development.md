# Local development

> These commands become real in Core plan Task 1. Until then, this page is the target interface.

## Prerequisites
- Node 24 (`.nvmrc`). unpdf requires Node ≥ 24.
- pnpm 12, via `corepack enable`.
- Docker with Compose v2.
- Optional: `GEMINI_API_KEY` (the free tier works; Gemini is the default provider) or `ANTHROPIC_API_KEY` with `LLM_PROVIDER=anthropic`. Without a key, extraction fails visibly with `LLM_NOT_CONFIGURED` and can be retried once a key is set.

## Run everything (evaluator path)
```sh
docker compose up --build
# web  http://127.0.0.1:8080   api http://127.0.0.1:3000   docs http://127.0.0.1:3000/docs
```
No `.env` is needed: dev defaults apply. To enable extraction, put `GEMINI_API_KEY=…` in `.env`.

## Develop with hot reload
```sh
pnpm install
pnpm infra        # postgres, redis, seaweedfs, migrate+seed in Docker, ports on 127.0.0.1
pnpm dev          # api (nest --watch), worker, web (vite, proxies /api → 127.0.0.1:3000)
```

## Everyday commands
| Command | Purpose |
|---|---|
| `pnpm lint typecheck test` | Before every commit |
| `pnpm test:int` / `pnpm test:chaos` | Integration and chaos tests (need `pnpm infra`) |
| `pnpm test:e2e` | Playwright against `compose.e2e.yaml` (cassette LLM) |
| `pnpm db:generate` | After editing `packages/db/src/schema.ts`. Commit the generated SQL; never edit it. |
| `pnpm db:check` | Fails if the schema and migrations drift |
| `pnpm db:reset` | **Destructive:** wipes the local DB and S3 volumes, then re-seeds |
| `pnpm golden:update` | Refresh parser golden text; review the diff before committing |
| `pnpm cassettes:record` | Record real LLM responses (needs a key) |
| `pnpm chaos` | Kill the worker, `FLUSHALL`, restart, and assert recovery against the running stack |

## Finding a seeded document
Seeded documents get uuid ids. To look one up by its manifest slug:
`curl '127.0.0.1:3000/documents?externalId=doc-invoice-001'`.

## Try the core flow
1. Open the invoice, then approve or correct every value.
2. Upload `fixtures/documents/invoice-001.v2.pdf` as a new version.
3. Only **Due date** and **Total amount** should need review. The other three are "Carried from v1".
