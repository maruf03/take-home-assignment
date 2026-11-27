# Runbook: restore a deleted document

1. Find it with `GET /documents?deleted=only` (Trash tab).
2. `POST /documents/:id/restore`. The response is 200 with the document, and is a no-op if the document is already live.
3. Any version that was in flight when deleted (`failed DOCUMENT_DELETED`) is reset to `queued`
   (attempts 0, errors cleared) and enqueued, so it extracts again.
4. Reviews, values and history are intact, because nothing below the document is ever deleted.

The S3 objects are never removed by a soft delete. Hard purge is not implemented (see README, cuts).
