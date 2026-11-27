# apps/worker (`@app/worker`)

NestJS BullMQ worker (ESM, SWC builder, `moduleResolution: bundler`, entry `dist/src/main.js`), sweep service, child-process parse pool, and `:3001` health/metrics HTTP server.

## Rules
- Only the worker receives LLM keys (`GEMINI_API_KEY` / `ANTHROPIC_API_KEY`). Never log prompts, parsed text, or keys.
- Fence every worker DB write with `WHERE active_run_id = $me` and use Postgres `now()` for all leases and sweeps.
- Keep `ExtractionPipeline` a plain constructor-injected class; keep BullMQ processor thin.
- Never import `@app/db/testing`, `@app/testkit`, or raw `@app/db/schema` in `src/`.
- BullMQ limiter `max` must always be a positive integer (default `{max: 1, duration: 12000}` for Gemini free tier; `{max: 100, duration: 1000}` for `fake`/`fake-ipc`/`cassette`).
