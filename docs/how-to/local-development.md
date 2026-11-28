# Local development

## Prerequisites
- Node 24 (`.nvmrc`).
- pnpm 12, via `corepack enable`.
- Docker with Compose v2.
- Optional: `GEMINI_API_KEY` (the free tier works; `gemini-3.5-flash` is the default) or `ANTHROPIC_API_KEY` with `LLM_PROVIDER=anthropic` and `LLM_MODEL=claude-sonnet-5-5`. Without a key, extraction fails visibly with `LLM_NOT_CONFIGURED` and can be retried once a key is set.

## Run everything (evaluator path)
```sh
docker compose up --build
# web  http://127.0.0.1:8080   api http://127.0.0.1:3000   docs http://127.0.0.1:3000/docs
```
No `.env` is needed: dev defaults apply. To enable extraction, put `GEMINI_API_KEY=…` in `.env`.

## Develop with hot reload
```sh
pnpm install
docker compose -f compose.yaml -f compose.dev.yaml up -d --wait postgres redis s3 migrate
pnpm dev          # api (nest --watch), worker, web (vite, proxies /api → 127.0.0.1:3000)
```
(`pnpm infra` brings up the full `compose.yaml` + `compose.dev.yaml` stack including `api`, `worker`, and `web`, which binds `:3000` and `:8080`.)

## Everyday commands
| Command | Purpose |
|---|---|
| `pnpm lint && pnpm typecheck && pnpm test` | Before every commit |
| `pnpm test:int` | Integration, concurrency, and security tests (needs Postgres, Redis, SeaweedFS running) |
| `pnpm chaos` | Starts `postgres`, `redis`, `s3`, `redis-chaos` (`compose.test.yaml`) and runs `test:chaos` (`apps/worker/test/chaos`) |
| `pnpm test:e2e` | Playwright against an already-running `docker compose -f compose.yaml -f compose.e2e.yaml up -d --wait` stack on `:8080` |
| `pnpm db:generate` | After editing `packages/db/src/schema/*.ts`. Commit the generated SQL; never edit it. |
| `pnpm db:check` | Fails if the schema and migrations drift |
| `pnpm db:reset` | **Destructive:** wipes the local DB and S3 volumes, then re-seeds |
| `pnpm golden:update` | Refresh parser golden text; review the diff before committing |
| `pnpm cassettes:record` | Record real LLM responses (needs a key) |

## Finding a seeded document
Seeded documents get uuid ids. To look one up by its manifest slug:
`curl '127.0.0.1:3000/documents?externalId=doc-invoice-001'`.

## Try the core flow
1. Open the invoice, then approve or correct every value.
2. Upload `fixtures/documents/invoice-001.v2.pdf` as a new version.
3. Only **Due date** and **Total amount** should need review. The other three are "Carried from v1".
