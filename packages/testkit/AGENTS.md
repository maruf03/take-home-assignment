# packages/testkit (`@app/testkit`)

Workspace placeholder for future shared test builders (`src/index.ts` is currently `export {};`; `test/trace-check.test.ts` covers the traceability script). Active DB/concurrency/chaos test helpers (`withTemplateDb()`, `expireLease()`, `acquireRowLockBarrier()`, `eventually()`) live in `@app/db/testing` (`packages/db/src/testing/`).

## Rules
- **Test-only package.** Production code in `apps/*/src/**` is forbidden from importing `@app/testkit` (enforced by ESLint).
- Keep helpers deterministic and fast; no network calls to external services.
- Use `nodenext` ESM with `.js` relative imports.
