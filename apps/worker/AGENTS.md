# apps/worker (`@app/worker`)

NestJS BullMQ worker (ESM, `@swc/cli`, `moduleResolution: bundler`, entry `dist/src/main.js`), sweep service, child-process parse pool, and HTTP health/metrics server (`WORKER_HTTP_PORT`, default `:3001`).

## Rules
- Only the worker receives LLM keys (`GEMINI_API_KEY` / `ANTHROPIC_API_KEY`). Never log prompts, parsed text, or keys.
- Fence active-run worker DB writes with `WHERE active_run_id = $me` (only `sweepBootRelease` and `sweepExpired` release stale `extracting` rows without `$me`) and use Postgres `now()` for all leases and sweeps.
- Keep `ExtractionPipeline` a plain constructor-injected class; keep BullMQ processor thin.
- Never import `@app/db/testing`, `@app/testkit`, or raw `@app/db/schema` in `src/`.
- BullMQ limiter `max` must always be a positive integer (default `{max: 1, duration: 12000}` for Gemini free tier; `{max: 100, duration: 1000}` for `fake`/`fake-ipc`/`cassette`).
