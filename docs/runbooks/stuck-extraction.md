# Runbook: a version looks stuck in `queued` or `extracting`

**Symptom:** the UI shows a version as Queued or Extracting for more than about a minute.

**Expected self-healing:** the worker sweep runs every 10s. Expired leases (30s) go back to `queued`, and
`queued` rows with `enqueued_at IS NULL` or older than 10s are re-enqueued. Recovery should take at most about 40s.

**Diagnose**
1. Worker alive? `docker compose exec worker node -e "fetch('http://127.0.0.1:3001/health/live').then(r=>r.text()).then(console.log)"` (port via `WORKER_HTTP_PORT`; `curl` is not in the slim image) should return 200.
   The response reports the age of the last sweep tick.
2. Row state:
   `SELECT status, attempts, run_seq, lease_until, worker_id, enqueued_at, last_error_code FROM document_versions WHERE id = '<uuid>';`
3. Redis job: `docker compose exec redis redis-cli keys 'bull:extraction:*<uuid>*'` (or `-a "${REDIS_PASSWORD:-dev-redis}"`).

**Fix**
- Worker down → `docker compose up -d worker`. On boot it releases its own leases and sweeps.
- `extracting` with `lease_until` in the past and nothing moving → the sweep isn't running. Check worker logs
  for `sweep` errors. Restarting the worker is safe, because writes are fenced.
- `queued` with a future `enqueued_at` → a transient backoff (LLM 429/5xx). Wait, or check `llm-outage.md`.
- `attempts ≥ 5` → it will be marked `failed MAX_ATTEMPTS` and needs a manual Retry once the cause is fixed.

Never edit `active_run_id` by hand. A fenced worker might still be finishing.
