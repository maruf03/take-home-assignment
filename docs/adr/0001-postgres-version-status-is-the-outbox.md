# Postgres version status is the outbox; no outbox table

Redis must be disposable (the brief runs `FLUSHALL`), so the durable job intent is the `document_versions` row with `status='queued'`, committed with the upload. A worker sweep re-enqueues anything Redis lost. We rejected a separate outbox table plus dispatcher: its "delivered" flag becomes false after a flush, so a sweep is needed anyway, and keeping both would mean two sources of truth.

**Considered options:** an outbox table plus dispatcher; Redis AOF persistence (still not a system of record); pg-boss (violates the Redis-backed queue requirement).
