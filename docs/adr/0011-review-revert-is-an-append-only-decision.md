# Undo is a `revert` review, not a deletion

> **Core status:** Supported in the DB schema, `packages/db`, and `packages/core` carry-over logic; the HTTP API (`createReviewRequestSchema`, returns `400 VALIDATION_FAILED`) and Web UI undo flow are deferred to **Extended E1c**.

Undo appends a review with `decision='revert'`, which returns the value to pending and adds +1 to `pending_count`. It requires `expectedCurrentReviewId`, so a stale undo gets 409. History stays append-only, which DB privileges enforce. A reverted baseline never carries over. Without auth, "only your own action" is a UI convention backed by the optimistic-lock check, not a server guarantee.
