# Keyset pagination on uuidv7 ids; no offsets, no totals

Every list pages on a single immutable unique key (`uuidv7` `id` on `/documents` and `/reviews`; `versionNumber`, `runNumber`, `seq`, `position`, and `key` on nested/type lists), and primary keys are PG 18 `uuidv7()`. A `(created_at, id)` cursor passed through a JS `Date` loses Postgres's microseconds and skips or duplicates rows. Indexes are ascending and scanned backward; Drizzle `.desc()` emits `NULLS LAST`, which the planner ignored. Totals are never returned except a capped `/documents/facets` count, because exact counts at scale are an O(n) DoS lever.

**Considered options:** offset (O(n), drifts on insert); `(created_at, id)` tuples; signed cursors (no auth, and keys go only into parameterized SQL).
