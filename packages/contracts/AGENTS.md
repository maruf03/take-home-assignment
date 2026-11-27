# packages/contracts (`@app/contracts`)

Shared zod schemas, DTOs, typed-value helpers, problem codes, and UI copy shared by API, worker, core, and web.

## Rules
- Must remain **browser-safe** and pure: no Node built-ins, no Nest, no Drizzle, no other `@app/*` imports.
- Keep `"sideEffects": false` and subpath exports tree-shakeable.
- Use `nodenext` ESM with `.js` relative imports.
- Typed-value helpers (`parseTypedValue`, `canonicalDecimal`, `equalValues`, `formatTypedValue`) live here so web and server share identical parsing and formatting (spec §10.1).
