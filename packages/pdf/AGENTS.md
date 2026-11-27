# packages/pdf (`@app/pdf`)

Hostile-PDF parsing via `unpdf` / `pdfjs-dist` inside a `tinypool` child-process pool with heap cap, RSS watchdog, and typed `PARSE_*` errors.

## Rules
- Never import `@nestjs/*`.
- Parse children run with `env: {}`, `isEvalSupported: false`, 512 MB heap cap, 768 MB RSS kill watchdog, and 30 s timeout.
- Always pass a copy of the input buffer to pdfjs (pdfjs detaches the buffer).
- Resolve the child entry via `new URL('./child.js', import.meta.url)` and use `import.meta.dirname` (never `__dirname`).
- Never modify `fixtures/`. Golden text/items/ranges live in `fixtures-golden/`.
