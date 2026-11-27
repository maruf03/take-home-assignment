# Soft delete only documents; deleting revokes fences; 410 Gone

Only `documents` carry `deleted_at`. Versions, values, reviews and runs are immutable history, hidden through their parent document. The delete tx fails in-flight versions with `DOCUMENT_DELETED` and clears their `active_run_id`, so late worker writes are rejected. Every route under a deleted document returns 410 rather than 404, so the UI can offer restore. `external_id` stays fully unique so the seed never resurrects a deleted fixture.

**Considered options:** `deleted_at` on every table (fan-out writes, races with the worker); archive tables; hard delete plus an audit log.
