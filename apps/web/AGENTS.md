# apps/web (`@app/web`)

Vite + React 19 SPA served behind unprivileged nginx.

## Rules
- May import **only `@app/contracts`** from workspace packages. Never import `@app/config/server-config`, `@app/core`, `@app/db`, or Node built-ins (enforced by ESLint).
- Render extracted values, quotes, and review notes as React text nodes only (never `dangerouslySetInnerHTML`, never markdown rendering of untrusted text).
- Validate every API response against `@app/contracts` zod schemas.
- Stop polling once no document version is in flight (`queued` or `extracting`).
- Maintain accessibility (zero serious/critical axe violations across all UI states).
