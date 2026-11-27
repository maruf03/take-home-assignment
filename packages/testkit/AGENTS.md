# packages/testkit (`@app/testkit`)

Dev/test-only builders (`aDocument`, `aValue`, `aReview`), `eventually()`, and concurrency/chaos test helpers.

## Rules
- **Test-only package.** Production code in `apps/*/src/**` is forbidden from importing `@app/testkit` (enforced by ESLint).
- Keep helpers deterministic and fast; no network calls to external services.
- Use `nodenext` ESM with `.js` relative imports.
