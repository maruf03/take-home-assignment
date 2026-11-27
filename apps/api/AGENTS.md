# apps/api (`@app/api`)

NestJS HTTP API (ESM, SWC builder, `moduleResolution: bundler`, entry `dist/src/main.js`).

## Rules
- **Never receives LLM API keys** (`GEMINI_API_KEY`, `ANTHROPIC_API_KEY`) in config or environment.
- Never parse PDFs in the API; enqueue work via Postgres state + BullMQ.
- Never import `@app/db/testing`, `@app/testkit`, or raw `@app/db/schema` in `src/`.
- Declare `GET /documents/facets` before `GET /documents/:id` in `DocumentsController`.
- All errors use RFC 9457 `application/problem+json` with `code` and `requestId`.
- Forward-only keyset pagination on uuidv7 `id`; validate cursors.
- Scope `trust proxy` to the fixed compose `edge` subnet (`172.30.0.0/24`).
