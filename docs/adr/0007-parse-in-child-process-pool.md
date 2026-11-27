# Parse PDFs in a tinypool child-process pool with an RSS watchdog

pdfjs runs in child processes (tinypool `runtime: 'child_process'`, `serialization: 'advanced'`, empty env, heap cap). The parent polls each child's RSS and SIGKILLs runaway children, because WASM and Buffer memory sit outside the V8 heap limit. A per-task abort ends in SIGKILL. A spike verified all of it, including the pool recovering in about 200 ms. This is an availability boundary, not a confidentiality boundary: a child runs as the same user. The production upgrade path is a Lambda or a separate parse service behind the same `PdfParser` interface.

**Considered options:** worker_threads (no OS boundary; off-heap memory isn't capped); parsing in the API (attacker-controlled CPU on the request path).
