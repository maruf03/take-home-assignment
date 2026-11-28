# Runbook: Redis was flushed or lost

**Symptom:** `FLUSHALL`, a Redis restart (no persistence by design) or a replaced Redis instance.

**Why nothing is lost:** Postgres holds every version's status, runs, LLM calls, values and reviews.
Redis only holds "work on version X soon". See ADR-0001.

**What happens automatically**
1. Jobs vanish.
2. On the next sweep ticks, `queued` versions (`≤ 10s` if `enqueued_at IS NULL`, `≤ 20s` after `SWEEP_COOLDOWN_SECONDS`) and `extracting` versions with expired leases (`≤ 40s`) are re-added.
3. BullMQ's global limiter and `worker.rateLimit` absorb the burst.
4. In-flight runs whose worker kept running finish normally, because the lease and fence are in Postgres.
   A run that crashed is `abandoned`, and the next run **reuses the stored LLM response** (no second bill).

**Verify**
- `SELECT status, count(*) FROM document_versions GROUP BY 1;` should converge to `extracted`/`failed` only.
- The metric `sweep_requeued_total{reason="queued"}` (or `expired` / `boot`) rises.

**Act** only if versions stay non-terminal after about 1 minute; then see `stuck-extraction.md`.
