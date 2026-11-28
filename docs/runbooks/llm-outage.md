# Runbook: LLM provider errors (429 / 529 / 5xx / auth)

| Signal | Meaning | What the system does | What you do |
|---|---|---|---|
| Many `rate_limited_total`, 429 **with** `retry-after` | Provider rate limit | In-run retry if ≤ 20s, else release to `queued` with backoff; `worker.rateLimit` pauses the queue | Usually nothing; tighten `LLM_LIMIT_MAX` / `LLM_LIMIT_DURATION_MS` if it persists |
| 429 **without** `retry-after` (or Gemini `PerDay` quota 429) | Spend or tier cap | Version `failed LLM_RATE_CAPPED` | Raise the cap or wait; then Retry the versions |
| 529 / 5xx bursts | Provider overloaded | Breaker opens after 5 failures for 30s; jobs wait in Redis | Wait; check the provider status page |
| `LLM_AUTH` / `LLM_NOT_CONFIGURED` | Bad or missing key | Version `failed` | Set `GEMINI_API_KEY` (default) or `LLM_PROVIDER=anthropic` + `LLM_MODEL` + `ANTHROPIC_API_KEY` for the **worker only**, restart the worker, Retry |
| `LLM_SCHEMA_INVALID` after a repair | Model returned an unusable shape twice | `failed` | Retry; a manual retry forces a fresh call (no reuse) |
| `LLM_CALL_CAP` | More than `max(6, chunks+3)` billed calls for one version | `failed` | Investigate the run's `llm_calls` (`DEBUG_ENDPOINTS=true` locally), then Retry |

Find documents whose latest version failed: `GET /documents?status=failed`. Each run's calls (prompt and raw response) are readable via `GET …/runs/:runId/calls` when `DEBUG_ENDPOINTS=true`.
