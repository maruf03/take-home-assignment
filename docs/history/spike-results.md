# Core Task 0: live verification results (2026-11-27)

These are evidence from real runs. The probes are `scripts/spikes/live-gemini.ts`; the Docker and
SeaweedFS probes ran from scratch directories, and their commands are summarised below.

## Step 1: Gemini (free-tier key, `@google/genai` 3.6.1)

| Check | Result |
|---|---|
| Models for a new free key | `gemini-2.5-flash` → **404** "no longer available to new users". Listed: 3.1-flash-lite, 3.5-flash(-lite), 3.6/3.7/3.8-flash, … |
| Newest flash models | `gemini-3.8-flash` and `gemini-3.7-flash` returned **503 UNAVAILABLE** ("high demand") on every call during the test. |
| Working model | **`gemini-3.5-flash`**. Responses report `modelVersion: "gemini-3.6-flash"`, so the requested id is aliased. Store `modelVersion`, not the requested id. |
| Structured output field | **`responseJsonSchema`** (plain JSON Schema) works, **including `additionalProperties:false`** on every object. `responseSchema` with the same schema was **also accepted**, with no 400. We use `responseJsonSchema`. |
| Constrained JSON | Yes. Every response parsed as JSON, `finishReason: "STOP"`. |
| Thinking | `thinkingConfig: { thinkingBudget: 0 }` is accepted on 3.5-flash, and usage shows **no thought tokens**. `thinkingLevel: 'LOW'` also works. `thinkingLevel: 'MINIMAL'` gives **400** "not supported for this model" (3.8-flash). |
| 5-field invoice | All 5 correct. Quotes are full lines. `vendor_name` quote = `MERIDIAN OFFICE SUPPLIES LLC`. 604 input / ~260–410 output tokens, 3–21 s latency. |
| 6-field market report (schema size) | Accepted. `vacancy_rate` = 4.2 (not 4.9), `average_rent_1br` = 1985 (not the 2BR figure), YoY = 3.8%. **`median_household_income`: `found:false`, sentinels `""`/`-1`, reason "does not mention"**. |
| Repair turn | User turn + model turn (invalid JSON) + user correction turn gives a complete object after repair. ✅ |
| Raw body / request id | `response.sdkHttpResponse.headers` is exposed, but it has **no request-id header**. The body carries **`responseId`**, so `provider_request_id = responseId`. Capture the raw JSON with a `fetch` wrapper (`httpOptions`) or by re-serialising the response. |
| 429 shape (burst of 25) | 8 OK, 17 rejected. `status 429 RESOURCE_EXHAUSTED`. `details[]` contains `QuotaFailure.violations[].quotaId = "GenerateRequestsPerMinutePerProjectPerModel-FreeTier"`, `quotaValue: "5"` (**5 RPM**), and **`RetryInfo.retryDelay: "39s"`**. The message also says "Please retry in 39.97s". |

**Model-output quirks the validator must absorb (no prompt-only fixes):**
- **Currency:** the model sometimes returns `currency: "$"` instead of an ISO code. `parseTypedValue` maps `$`, `€` and `£` to ISO, and the evidence check uses the quote's own marker.
- **Percent:** `value: "4.2%"` includes the sign. `parseTypedValue('percent')` strips a trailing `%` before canonicalising.
- **Quotes:** quotes can carry layout padding (leading spaces). Whitespace normalization (§5.2) already handles this.

## Step 2: Nest ESM image (Node 24, pnpm 12.23.0, turbo 2)
- The `turbo prune api --docker` → `pnpm install --frozen-lockfile` → `turbo run build --filter=api...` → `npm_config_inject_workspace_packages=true pnpm --filter api deploy --prod /out` sequence built successfully.
- The runtime image is `node:24-slim`, **269 MB**.
- It booted with `--read-only --tmpfs /tmp --cap-drop ALL --no-new-privileges`, as uid 1000, on Node **v24.22.3**. `/health` returned `{"status":"ok"}`, `/docs-json` served the Swagger spec, and the ESM-only `unpdf` import and `import.meta.dirname` both worked. The entry point is `dist/src/main.js`.
- Gotcha: `@scarf/scarf` (pulled in by swagger-ui-dist) runs a telemetry postinstall. Set `SCARF_ANALYTICS=false` and keep `@scarf/scarf` **out** of `allowBuilds`.

## Step 3: SeaweedFS (`chrislusf/seaweedfs` latest, weed 4.55)
- `server -dir=/data -s3 -s3.port=8333 -s3.config=/etc/seaweedfs/s3.json` with one identity.
- **Healthcheck:** `wget -q -O /dev/null http://127.0.0.1:8333/healthz` (200). The image is Alpine with `wget`, `curl` and `nc`. `/status` also returns 200, and `/` returns 403.
- `@aws-sdk/client-s3` with `forcePathStyle:true`: CreateBucket, PutObject, HeadObject and GetObject round-trip the invoice PDF **byte-identical** (sha256 match), both with `requestChecksumCalculation/responseChecksumValidation:'WHEN_REQUIRED'` and with the SDK default. A second CreateBucket returns `BucketAlreadyOwnedByYou`, which the bootstrap treats as success. We keep `WHEN_REQUIRED`, which is the safe setting across S3-compatible stores.
