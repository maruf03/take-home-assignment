# packages/db (`@app/db`)

Drizzle schema, generated migrations, SQL grants, repositories, seed CLI, and DB testing utilities.

## Rules
- Never import `@nestjs/*`.
- Migrations are **generated only** (`drizzle-kit generate`). Never hand-edit SQL in `drizzle/` and never use `drizzle-kit push`.
- No triggers or SQL functions. Statuses are `text` + `CHECK`. No Drizzle `.desc()` indexes.
- Postgres `now()` is the only clock for leases, sweeps, and `updated_at`. Never use `$onUpdate` or JS timestamps in SQL predicates.
- Enforce lock order: `documents → document_versions → extraction_runs → llm_calls → extracted_values → reviews`.
- Fence every worker write with `WHERE active_run_id = $me`.
- Keep `"files": ["dist", "drizzle", "assets"]` so migrations, `grants.sql`, and seed hints survive `turbo prune` and `pnpm deploy`.
