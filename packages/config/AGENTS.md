# packages/config (`@app/config`)

Shared workspace tooling configs (`tsconfig.*.json`, `eslint.config.mjs`) and `server-config.ts`.

## Rules
- `src/server-config.ts` is **Node-only**. `apps/web` is forbidden from importing `@app/config` or `@app/config/server-config` (enforced by ESLint `no-restricted-imports`).
- Never log or embed raw secret values in `ConfigError` messages or dev-default warnings.
- Keep `DEV_DEFAULT_SECRETS` synchronized with every dev default in `.env.example` and `compose.yaml`.
- Keep ESLint boundary rules aligned with spec §10.1.
