# packages/core (`@app/core`)

Pure extraction domain logic: text cleanup/indexing, verbatim evidence validation, carry-over rule A′, prompt/schema builders, and suspicious-instruction scanning.

## Rules
- **100% pure.** No IO, no Node built-ins, no Nest, no Drizzle, no LLM/S3/PDF SDKs.
- May import **only `@app/contracts`** from workspace packages.
- Verbatim-evidence rule: never retain a value whose quote does not appear verbatim in the version's own `parsed_text`.
- Tool schemas must use sentinels (no nullable unions, no `maxItems`/`minLength`/`maximum`, `additionalProperties: false` on every object).
- Use `nodenext` ESM with `.js` relative imports.
