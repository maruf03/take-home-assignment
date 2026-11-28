# ESM everywhere, Nest built with SWC and bundler resolution

Every package and app is native ESM (`Node ≥ 24`), using `pdfjs-dist` directly for PDF parsing. Shared packages use `nodenext`. The Nest apps compile with `@swc/cli` (`swc src -d dist/src --strip-leading-paths`) and `moduleResolution: bundler` with explicit Swagger decorators (`metadata.ts` is not generated), avoiding `nodenext` Swagger CLI plugin `require(…, {with})` issues while keeping DI, Vitest (`unplugin-swc`), and `pnpm deploy` working cleanly.

**Considered options:** CJS Nest plus `await import()` for ESM packages (dual formats); dual CJS/ESM builds via tshy.
