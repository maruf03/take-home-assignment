# Render the original PDF with pdf.js to canvas, not an iframe

> **Core status:** Deferred to **Extended E1c**. Core provides `"Download original PDF"` (`GET .../file` with `Content-Disposition: attachment` and CSP `sandbox`) rather than an in-browser `Original` canvas tab.

Browser PDF viewers don't render inside a sandboxed iframe or under CSP `sandbox`, and helmet's `frame-ancestors 'none'` blocks framing anyway. The Original tab therefore fetches the bytes and renders them with `pdfjs-dist`. Parsing runs in pdf.js's own Web Worker (`workerSrc` bundled locally, `isEvalSupported:false`). Pages render one at a time to a canvas on the main thread, with the text and annotation layers off, and standard fonts are bundled. The file endpoint stays `attachment` with CSP `sandbox` for direct navigation.

**Considered options:** a sandboxed iframe (doesn't render); a new tab only (loses the side-by-side provenance check).
